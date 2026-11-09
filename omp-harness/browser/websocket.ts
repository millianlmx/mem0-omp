// Un client WebSocket minimal (RFC 6455) sur `node:http`, sans dépendance : le harness n'en
// a besoin que pour parler CDP à Moli, à travers la porte CDP de l'image (moli-gate.ts : jeton,
// Host réécrit vers la boucle locale de Moli, `/devtools/browser` nu réécrit vers le chemin que
// Moli publie). En-têtes maîtrisés (jamais `Origin` : Moli refuse en 403 toute origine
// étrangère), trames texte seulement.
import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_MESSAGE = 64 * 1024 * 1024;
const CLOSE_GRACE_MS = 1000;

export class WebSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSocketError";
  }
}

/** Le serveur a répondu autre chose qu'un upgrade (401, 403…) : son statut, le début de son corps. */
export class WebSocketHandshakeError extends WebSocketError {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`ouverture refusée (${status})`);
    this.name = "WebSocketHandshakeError";
    this.status = status;
    this.body = body;
  }
}

export type WebSocketOptions = {
  headers: Record<string, string>;
  timeoutMs: number;
  maxMessageBytes?: number;
  /** Le flux sur lequel part la requête d'ouverture, au lieu d'une connexion TCP vers `target` (qui ne sert alors qu'à l'en-tête Host). */
  connect?: () => Duplex;
};

export interface WebSocketLink {
  readonly closed: boolean;
  send(text: string): void;
  onMessage(callback: (text: string) => void): void;
  /** Appelé UNE fois, `null` pour une fermeture propre. */
  onClose(callback: (error: Error | null) => void): void;
  close(): void;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const head = length < 126 ? 2 : length < 65_536 ? 4 : 10;
  const out = Buffer.allocUnsafe(head + 4 + length);
  out[0] = 0x80 | opcode;
  if (length < 126) out[1] = 0x80 | length;
  else if (length < 65_536) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(length, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  mask.copy(out, head);
  for (let i = 0; i < length; i++) out[head + 4 + i] = (payload[i] as number) ^ (mask[i % 4] as number);
  return out;
}

function closeFrame(code: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return frame(0x8, payload);
}

class Link implements WebSocketLink {
  closed = false;
  readonly #socket: Duplex;
  readonly #max: number;
  #chunks: Buffer[] = [];
  #size = 0;
  #want = 2;
  #parts: Buffer[] = [];
  #partsSize = 0;
  #inMessage = false;
  #finished = false;
  #messages: ((text: string) => void)[] = [];
  #closers: ((error: Error | null) => void)[] = [];
  #error: Error | null = null;
  #cleanClose = false;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(socket: Duplex, head: Buffer, max: number) {
    this.#socket = socket;
    this.#max = max;
    // Un flux de process (`docker exec`) n'est pas un net.Socket : seul celui-ci a `setNoDelay`.
    (socket as Partial<Socket>).setNoDelay?.(true);
    socket.on("data", (chunk: Buffer) => this.#feed(chunk));
    socket.on("error", (error) => {
      this.#error ??= error;
      this.closed = true;
      socket.destroy();
    });
    socket.on("close", () => {
      this.closed = true;
      this.#finish(this.#error ?? (this.#cleanClose ? null : new WebSocketError("connexion coupée")));
    });
    if (head.length > 0) this.#feed(head);
  }

  send(text: string): void {
    if (this.closed) throw new WebSocketError("connexion fermée");
    this.#socket.write(frame(0x1, Buffer.from(text, "utf8")));
  }

  onMessage(callback: (text: string) => void): void {
    this.#messages.push(callback);
  }

  onClose(callback: (error: Error | null) => void): void {
    if (this.#finished) callback(this.#error);
    else this.#closers.push(callback);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#cleanClose = true;
    this.#shutdown(closeFrame(1000));
  }

  /** Dernière trame (close) puis fin : la socket est détruite au plus tard une seconde après. */
  #shutdown(last: Buffer): void {
    const socket = this.#socket;
    if (!socket.destroyed) {
      socket.end(last);
      setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
    }
  }

  #finish(error: Error | null): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#error = error;
    for (const callback of this.#closers.splice(0)) callback(error);
  }

  #protocol(code: number, message: string): void {
    this.closed = true;
    this.#error ??= new WebSocketError(message);
    this.#chunks = [];
    this.#size = 0;
    this.#shutdown(closeFrame(code));
  }

  #feed(chunk: Buffer): void {
    if (this.closed && this.#cleanClose) return;
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    if (this.#size >= this.#want) this.#pump();
  }

  #pump(): void {
    while (!this.closed && this.#size >= this.#want) {
      const buf = this.#chunks.length === 1 ? (this.#chunks[0] as Buffer) : Buffer.concat(this.#chunks);
      this.#chunks = [buf];
      if (buf.length < 2) return;
      const first = buf[0] as number;
      const second = buf[1] as number;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) {
          this.#want = 4;
          return;
        }
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) {
          this.#want = 10;
          return;
        }
        const wide = buf.readBigUInt64BE(2);
        if (wide > BigInt(this.#max)) {
          this.#protocol(1009, "message trop gros");
          return;
        }
        length = Number(wide);
        offset = 10;
      }
      const opcode = first & 0x0f;
      const fin = (first & 0x80) !== 0;
      const control = opcode >= 8;
      if ((second & 0x80) !== 0 || (first & 0x70) !== 0 || (control && (!fin || length > 125))) {
        this.#protocol(1002, "protocole");
        return;
      }
      if (length > this.#max || this.#partsSize + length > this.#max) {
        this.#protocol(1009, "message trop gros");
        return;
      }
      if (buf.length < offset + length) {
        this.#want = offset + length;
        return;
      }
      const payload = buf.subarray(offset, offset + length);
      const rest = buf.subarray(offset + length);
      this.#chunks = rest.length > 0 ? [rest] : [];
      this.#size = rest.length;
      this.#want = 2;
      this.#frame(opcode, fin, payload);
    }
  }

  #frame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 9) {
      this.#socket.write(frame(0xa, payload));
      return;
    }
    if (opcode === 10) return;
    if (opcode === 8) {
      this.closed = true;
      this.#cleanClose = true;
      this.#shutdown(frame(0x8, payload.subarray(0, 2)));
      return;
    }
    // Texte (1) ou continuation (0) ; le binaire (2) et les opcodes inconnus sont refusés.
    if (!(opcode === 0 ? this.#inMessage : opcode === 1 && !this.#inMessage)) {
      this.#protocol(1002, "protocole");
      return;
    }
    this.#parts.push(payload);
    this.#partsSize += payload.length;
    this.#inMessage = !fin;
    if (!fin) return;
    const whole = this.#parts.length === 1 ? (this.#parts[0] as Buffer) : Buffer.concat(this.#parts);
    this.#parts = [];
    this.#partsSize = 0;
    let text: string;
    try {
      text = this.#decoder.decode(whole);
    } catch {
      this.#protocol(1007, "protocole");
      return;
    }
    for (const callback of this.#messages) callback(text);
  }
}

/** Ouvre la connexion : rejette avec le `code` Node d'une erreur réseau, ou avec une `WebSocketError`. */
export function openWebSocket(target: URL, options: WebSocketOptions): Promise<WebSocketLink> {
  // Les sources sont typées en lib ES2023 : pas de Promise.withResolvers (comme proc.ts).
  let resolve!: (link: WebSocketLink) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<WebSocketLink>((ok, ko) => {
    resolve = ok;
    reject = ko;
  });
  const key = randomBytes(16).toString("base64");
  const port = target.port || "80";
  const request = http.request({
    host: target.hostname.replace(/^\[|\]$/g, ""),
    port: Number(port),
    path: `${target.pathname}${target.search}`,
    method: "GET",
    // Un transport fourni (la QA de /review passe par `docker exec`) remplace la connexion TCP ; http n'appelle
    // `createConnection` qu'en l'absence d'agent, d'où `agent: false` seulement dans l'autre cas.
    ...(options.connect ? { createConnection: () => options.connect?.() as Duplex } : { agent: false }),
    headers: {
      Host: `${target.hostname}:${port}`,
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
      ...options.headers,
    },
  });
  // Une promesse ne se règle qu'une fois : le premier événement gagne.
  const timer = setTimeout(() => {
    reject(new WebSocketError("ouverture : délai dépassé"));
    request.destroy();
  }, options.timeoutMs);
  const settled = (): void => clearTimeout(timer);
  promise.then(settled, settled);
  request.on("upgrade", (response, socket, head) => {
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    if (response.statusCode !== 101 || response.headers["sec-websocket-accept"] !== accept) {
      reject(new WebSocketError("réponse d'ouverture invalide"));
      socket.destroy();
      return;
    }
    resolve(new Link(socket as Duplex, head, options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE));
  });
  request.on("response", (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (piece: string) => {
      if (body.length < 200) body += piece;
      if (body.length >= 200) response.destroy();
    });
    const done = (): void => reject(new WebSocketHandshakeError(response.statusCode ?? 0, body.slice(0, 200)));
    response.on("end", done);
    response.on("close", done);
  });
  request.on("error", reject);
  request.end();
  return promise;
}
