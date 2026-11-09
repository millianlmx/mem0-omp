// Une connexion CDP à Moli (`/devtools/browser`, que la porte CDP de l'image réécrit vers le
// chemin publié par Moli) : appels bornés, évènements, fermeture garantie. Moli ne détruit rien
// à la fermeture d'une connexion : les pages et les cookies d'un contexte restent tant qu'on ne
// le supprime pas (voir session.ts). Aucun message d'erreur ne contient le jeton.
import { WebSocketError, WebSocketHandshakeError, openWebSocket } from "./websocket.ts";
import type { WebSocketLink } from "./websocket.ts";
import type { Duplex } from "node:stream";

/** Une erreur CDP : `remote` quand le texte vient de Moli ou de la page (contenu non fiable). */
export class CdpError extends Error {
  readonly method: string;
  readonly remote: boolean;
  constructor(method: string, message: string, options: { remote: boolean }) {
    super(message);
    this.name = "CdpError";
    this.method = method;
    this.remote = options.remote;
  }
}

export class CdpTimeoutError extends Error {
  readonly method: string;
  constructor(method: string, ms: number) {
    super(`${method} : pas de réponse en ${ms} ms`);
    this.name = "CdpTimeoutError";
    this.method = method;
  }
}

export class CdpClosedError extends Error {
  constructor() {
    super("connexion au navigateur fermée");
    this.name = "CdpClosedError";
  }
}

/** La connexion n'a pas pu s'ouvrir : un message fixe du harness, sans jeton. */
export class CdpConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpConnectError";
  }
}

export function abortError(): Error {
  const error = new Error("opération annulée");
  error.name = "AbortError";
  return error;
}

export type CdpTarget = {
  url: string;
  token: string | null;
  callTimeoutMs: number;
  connectTimeoutMs?: number;
  signal?: AbortSignal;
  /** Un transport à la place de la connexion TCP (la QA de /review : `docker exec`), voir `WebSocketOptions.connect`. */
  connect?: () => Duplex;
};

export type CdpHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

type Pending = {
  method: string;
  resolve: (result: never) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** `http://h:p` ou `ws://h:p` → `ws://h:p/devtools/browser`. */
function browserSocketUrl(raw: string): URL {
  const url = new URL(raw);
  url.protocol = "ws:";
  url.pathname = "/devtools/browser";
  url.search = "";
  return url;
}

function connectFailure(error: unknown): CdpConnectError {
  if (error instanceof WebSocketHandshakeError) {
    if (error.status === 401) return new CdpConnectError("jeton CDP refusé par le navigateur (401)");
    if (error.status === 403) return new CdpConnectError("connexion refusée par le navigateur (403)");
    return new CdpConnectError(`navigateur : ouverture refusée (${error.status})`);
  }
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  const detail = typeof code === "string" ? code : error instanceof WebSocketError ? error.message : "erreur réseau";
  return new CdpConnectError(`navigateur injoignable (${detail})`);
}

export class CdpConnection {
  closed = false;
  readonly #link: WebSocketLink;
  readonly #callTimeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  readonly #handlers = new Map<string, Set<CdpHandler>>();
  readonly #closers: (() => void)[] = [];
  #reason: Error = new CdpClosedError();
  #nextId = 1;
  #unlisten: (() => void) | null = null;

  /** Appelé par `connect` seulement (le lien est déjà ouvert). */
  constructor(link: WebSocketLink, callTimeoutMs: number, signal: AbortSignal | undefined) {
    this.#link = link;
    this.#callTimeoutMs = callTimeoutMs;
    link.onMessage((text) => this.#receive(text));
    link.onClose(() => this.#end(new CdpClosedError()));
    if (signal) {
      const onAbort = (): void => {
        this.#end(abortError());
        link.close();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#unlisten = () => signal.removeEventListener("abort", onAbort);
    }
  }

  static async connect(target: CdpTarget): Promise<CdpConnection> {
    if (target.signal?.aborted) throw abortError();
    let link: WebSocketLink;
    try {
      link = await openWebSocket(browserSocketUrl(target.url), {
        headers: target.token ? { Authorization: `Bearer ${target.token}` } : {},
        timeoutMs: target.connectTimeoutMs ?? 5000,
        ...(target.connect ? { connect: target.connect } : {}),
      });
    } catch (error) {
      throw connectFailure(error);
    }
    if (target.signal?.aborted) {
      link.close();
      throw abortError();
    }
    return new CdpConnection(link, target.callTimeoutMs, target.signal);
  }

  /** Un appel CDP. Sans réponse à temps : `CdpTimeoutError` ET connexion fermée (état inconnu). */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: { sessionId?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(this.#reason);
    const id = this.#nextId++;
    const ms = options.timeoutMs ?? this.#callTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpTimeoutError(method, ms));
        this.close();
      }, ms);
      this.#pending.set(id, { method, resolve: resolve as (result: never) => void, reject, timer });
      try {
        this.#link.send(
          JSON.stringify({ id, method, params, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }),
        );
      } catch {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new CdpClosedError());
      }
    });
  }

  /** S'abonne à un évènement CDP ; rend la fonction de désabonnement. */
  on(method: string, handler: CdpHandler): () => void {
    const set = this.#handlers.get(method) ?? new Set<CdpHandler>();
    set.add(handler);
    this.#handlers.set(method, set);
    return () => set.delete(handler);
  }

  onClose(callback: () => void): void {
    if (this.closed) callback();
    else this.#closers.push(callback);
  }

  close(): void {
    this.#end(new CdpClosedError());
    this.#link.close();
  }

  #receive(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      const failure = message.error as { message?: unknown } | undefined;
      if (failure)
        pending.reject(
          new CdpError(pending.method, typeof failure.message === "string" ? failure.message : "erreur", {
            remote: true,
          }),
        );
      else pending.resolve((message.result ?? {}) as never);
      return;
    }
    if (typeof message.method !== "string") return;
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    for (const handler of this.#handlers.get(message.method) ?? [])
      handler((message.params ?? {}) as Record<string, unknown>, sessionId);
  }

  /** Une fois : les appels en attente échouent avec `reason`, les abonnés de `onClose` sont prévenus. */
  #end(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.#reason = reason;
    this.#unlisten?.();
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.#pending.delete(id);
    }
    for (const callback of this.#closers.splice(0)) callback();
  }
}
