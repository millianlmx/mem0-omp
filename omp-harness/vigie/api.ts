// Le client HTTP de la vigie vers le harness : son jeton de client pilote, l'API REST,
// les outils MCP (`POST /v1/mcp`) et le flux `GET /v1/events`, repris par `Last-Event-ID`.
// La vigie n'a ni la base, ni le socket du moteur, ni le jeton GitHub : tout passe ici.
import type { EventRow } from "../db.ts";
import { record, textOf } from "./json.ts";

/** Le harness ne répond pas (réseau, conteneur arrêté) : la vigie garde ses signaux pour plus tard. */
export class HarnessUnreachable extends Error {}

/** Une réponse d'erreur du harness (4xx, 5xx) ou d'un outil MCP (`isError`). */
export class HarnessCallError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type FetchFn = typeof fetch;

const CALL_TIMEOUT_MS = 30_000;

export class HarnessApi {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: FetchFn;
  #seq = 0;

  constructor(base: string, token: string, fetchFn: FetchFn = fetch) {
    this.#base = base.replace(/\/+$/, "");
    this.#token = token;
    this.#fetch = fetchFn;
  }

  async #send(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.#fetch(`${this.#base}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new HarnessUnreachable(
        `harness injoignable (${method} ${route}) : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Un appel REST : le corps JSON d'une réponse 2xx, sinon `HarnessCallError`. */
  async json(method: "GET" | "POST" | "PUT", route: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await this.#send(method, route, body);
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text === "" ? {} : record(JSON.parse(text));
    } catch {
      parsed = { error: text.slice(0, 300) };
    }
    if (!response.ok) throw new HarnessCallError(response.status, textOf(parsed.error) || `HTTP ${response.status}`);
    return parsed;
  }

  /** `GET /v1/health`, sans jeton : le code (200 ou 503) et le corps. */
  async health(): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await this.#send("GET", "/v1/health");
    const body = record(await response.json().catch(() => ({})));
    return { status: response.status, body };
  }

  /** Un outil MCP : son résultat structuré, ou `HarnessCallError` si l'outil rend une erreur. */
  async tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await this.json("POST", "/v1/mcp", {
      jsonrpc: "2.0",
      id: ++this.#seq,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (reply.error !== undefined)
      throw new HarnessCallError(400, `${name} : ${textOf(record(reply.error).message) || "erreur JSON-RPC"}`);
    const result = record(reply.result);
    if (result.isError === true) {
      const content = Array.isArray(result.content) ? record(result.content[0]) : {};
      throw new HarnessCallError(409, `${name} : ${textOf(content.text) || "refusé"}`);
    }
    return record(result.structuredContent);
  }

  /**
   * Le flux des événements journalisés après `cursor` (rejoué, puis en direct), jusqu'à ce
   * que `signal` s'arrête ou que le serveur ferme : la vigie se reconnecte au dernier `id`.
   */
  async *events(cursor: number, signal: AbortSignal): AsyncGenerator<EventRow> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}/v1/events`, {
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Last-Event-ID": String(cursor),
          Accept: "text/event-stream",
        },
        signal,
      });
    } catch (err) {
      throw new HarnessUnreachable(`flux injoignable : ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok || !response.body)
      throw new HarnessCallError(response.status, `flux refusé (HTTP ${response.status})`);
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (data === "") continue;
          let event: Record<string, unknown>;
          try {
            event = record(JSON.parse(data));
          } catch {
            continue;
          }
          if (typeof event.id !== "number" || typeof event.type !== "string") continue;
          yield {
            id: event.id,
            at: typeof event.at === "number" ? event.at : Date.now(),
            runId: typeof event.runId === "string" ? event.runId : null,
            repo: typeof event.repo === "string" ? event.repo : null,
            type: event.type,
            payload: record(event.payload),
          };
        }
      }
    } finally {
      reader.releaseLock();
      await response.body.cancel().catch(() => {});
    }
  }
}
