// La porte CDP de l'image Moli de la pile (services `moli`, `moli-poste`, navigateur de QA).
// Moli n'authentifie pas son CDP : la porte écoute à sa place, exige `Authorization: Bearer
// <jeton>` sur CHAQUE requête (HTTP comme ouverture WebSocket), puis relaie vers Moli sur la
// boucle locale du conteneur. Elle réécrit ce que Moli refuserait d'un client distant :
// - l'en-tête Host (Moli répond 403 à tout Host qui n'est pas la boucle locale) ;
// - le chemin `/devtools/browser` sans identifiant (celui du harness) vers celui que publie
//   `/json/version`.
// Le jeton ne part jamais vers Moli ni dans un message. Lancée en script, la porte démarre
// aussi Moli (`MOLI_BIN serve … <arguments>`) et s'arrête avec lui.
//
// Autonome : seulement `node:*`, exécutée par `node --experimental-strip-types`.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

export const MIN_TOKEN_LENGTH = 32;
const BROWSER_PATH = "/devtools/browser";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;

export type GateOptions = {
  token: string;
  /** Moli, sur la boucle locale. */
  upstream: { host: string; port: number };
  host: string;
  /** 0 : un port libre (rendu par `port`). */
  port: number;
};

export type Gate = { port: number; close: () => Promise<void> };

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** `Bearer <jeton>` exact, comparé en temps constant (les empreintes ont la même longueur). */
export function authorized(header: string | undefined, token: string): boolean {
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}

/** Les en-têtes de la requête relayée : sans Authorization, Host réécrit vers Moli. */
function forwardedHeaders(raw: string[], upstreamHost: string): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] as string;
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "host") continue;
    out.push([name, raw[i + 1] as string]);
  }
  out.push(["Host", upstreamHost]);
  return out;
}

/** Le chemin du navigateur publié par Moli (`/devtools/browser/<id>`). */
function browserPath(upstream: GateOptions["upstream"]): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: upstream.host,
        port: upstream.port,
        path: "/json/version",
        headers: { Host: `${upstream.host}:${upstream.port}` },
        timeout: 5000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { webSocketDebuggerUrl?: unknown };
            if (typeof body.webSocketDebuggerUrl !== "string") throw new Error("webSocketDebuggerUrl absent");
            const path = new URL(body.webSocketDebuggerUrl).pathname;
            if (!path.startsWith(`${BROWSER_PATH}/`)) throw new Error("chemin du navigateur inattendu");
            resolve(path);
          } catch (error) {
            reject(error);
          }
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("/json/version sans réponse")));
    request.on("error", reject);
  });
}

const refuse = (socket: Duplex, status: string): void => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

export function startGate(options: GateOptions): Promise<Gate> {
  if (options.token.length < MIN_TOKEN_LENGTH)
    return Promise.reject(new Error(`jeton CDP trop court (${MIN_TOKEN_LENGTH} caractères au moins)`));
  const upstreamHost = `${options.upstream.host}:${options.upstream.port}`;
  let cachedPath: Promise<string> | null = null;
  const resolvePath = (path: string): Promise<string> => {
    if (path !== BROWSER_PATH) return Promise.resolve(path);
    cachedPath ??= browserPath(options.upstream).catch((error: unknown) => {
      cachedPath = null;
      throw error;
    });
    return cachedPath;
  };
  const sockets = new Set<net.Socket>();

  const server = http.createServer((request, response) => {
    if (!authorized(request.headers.authorization, options.token)) {
      response.writeHead(401, { "Content-Length": "0" }).end();
      return;
    }
    const upstream = http.request(
      {
        host: options.upstream.host,
        port: options.upstream.port,
        method: request.method,
        path: request.url,
        headers: forwardedHeaders(request.rawHeaders, upstreamHost).flat(),
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.rawHeaders);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "Content-Length": "0" });
      response.end();
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    if (!authorized(request.headers.authorization, options.token)) {
      refuse(client, "401 Unauthorized");
      return;
    }
    client.on("error", () => client.destroy());
    const url = new URL(request.url ?? "/", "http://gate");
    resolvePath(url.pathname).then(
      (path) => {
        if (client.destroyed) return;
        const upstream = net.connect(options.upstream.port, options.upstream.host);
        sockets.add(upstream);
        upstream.on("close", () => {
          sockets.delete(upstream);
          client.destroy();
        });
        upstream.on("error", () => upstream.destroy());
        client.on("close", () => upstream.destroy());
        upstream.on("connect", () => {
          const lines = [`${request.method} ${path}${url.search} HTTP/1.1`];
          for (const [name, value] of forwardedHeaders(request.rawHeaders, upstreamHost))
            lines.push(`${name}: ${value}`);
          upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
      },
      () => refuse(client, "502 Bad Gateway"),
    );
  });

  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Moli répond sur `/json/version` (sinon : échec après `READY_TIMEOUT_MS`). */
export async function waitForMoli(upstream: GateOptions["upstream"], alive: () => boolean): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (!alive()) throw new Error("Moli s'est arrêté au démarrage");
    try {
      await browserPath(upstream);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("Moli ne répond pas sur /json/version");
      await new Promise((done) => setTimeout(done, READY_POLL_MS));
    }
  }
}

/** L'entrée de l'image : Moli sur la boucle locale (port 9223), la porte sur 0.0.0.0:9222. */
async function main(args: string[]): Promise<void> {
  const token = process.env.MOLI_CDP_TOKEN ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    process.stderr.write(`✗ jeton CDP absent ou trop court (${MIN_TOKEN_LENGTH} caractères au moins)\n`);
    process.exit(1);
  }
  const upstream = { host: "127.0.0.1", port: Number(process.env.MOLI_UPSTREAM_PORT ?? 9223) };
  const env = { ...process.env };
  delete env.MOLI_CDP_TOKEN;
  const moli = spawn(
    process.env.MOLI_BIN ?? "/moli",
    ["serve", "--host", upstream.host, "--port", String(upstream.port), ...args],
    { stdio: ["ignore", "inherit", "inherit"], env },
  );
  let alive = true;
  moli.on("exit", (code, signal) => {
    alive = false;
    process.stderr.write(`✗ Moli s'est arrêté (${signal ?? code})\n`);
    process.exit(code ?? 1);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      moli.kill(signal);
    });
  await waitForMoli(upstream, () => alive);
  await startGate({ token, upstream, host: "0.0.0.0", port: Number(process.env.MOLI_GATE_PORT ?? 9222) });
  process.stderr.write("· porte CDP prête sur 0.0.0.0:9222\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const separator = process.argv.indexOf("--");
  main(separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1)).catch((error: unknown) => {
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
