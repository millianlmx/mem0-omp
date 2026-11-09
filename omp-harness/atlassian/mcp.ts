// Le client MCP Streamable HTTP du serveur Atlassian Rovo : une session ouverte à la première
// demande (`initialize`, puis `notifications/initialized`), son `Mcp-Session-Id` renvoyé
// ensuite, la réponse lue en JSON ou en SSE. Un 401 vaut un rafraîchissement du jeton puis
// UNE nouvelle tentative ; une session perdue (404) en rouvre une, puis UNE nouvelle tentative.
import { isRecord } from "../config.ts";
import type { AtlassianFetch, AtlassianResponse } from "./oauth.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Le délai d'un appel d'outil, tentatives comprises. */
export const MCP_TIMEOUT_MS = 60 * 1000;

export type McpToolResult = { text: string; isError: boolean };

/** Une réponse HTTP refusée par le serveur MCP. */
export class McpHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type McpAuth = {
  accessToken(): Promise<string>;
  /** Un nouveau jeton à la place de `stale`, refusé par le serveur. */
  refresh(stale: string): Promise<string>;
};

type JsonRpcMessage = Record<string, unknown>;

/**
 * Le message JSON-RPC d'un corps de réponse : un objet JSON, ou un flux SSE dont on garde le
 * message qui répond à `id` (sinon le dernier `data:`). `null` : rien de lisible.
 */
export function replyOf(text: string, id: number | null): JsonRpcMessage | null {
  const body = text.trim();
  if (body === "") return null;
  if (body.startsWith("{") || body.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (Array.isArray(parsed)) return parsed.filter(isRecord).find((message) => message.id === id) ?? null;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  const messages: JsonRpcMessage[] = [];
  for (const event of body.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isRecord(parsed)) messages.push(parsed);
    } catch {
      // une ligne illisible (ping, commentaire) : ignorée
    }
  }
  return messages.find((message) => id !== null && message.id === id) ?? messages.at(-1) ?? null;
}

/** Le texte et l'état d'erreur d'un résultat `tools/call`, ou de l'erreur JSON-RPC qui le remplace. */
function toolResultOf(message: JsonRpcMessage | null): McpToolResult {
  if (message === null) return { text: "réponse MCP illisible", isError: true };
  if (isRecord(message.error)) {
    const { code, message: reason } = message.error;
    return { text: `MCP error ${String(code)}: ${String(reason)}`, isError: true };
  }
  const result = message.result;
  if (!isRecord(result)) return { text: "réponse MCP sans résultat", isError: true };
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(isRecord)
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter((part) => part !== "")
    .join("\n");
  return { text, isError: result.isError === true };
}

export type McpClientDeps = {
  fetch: AtlassianFetch;
  url: () => string;
  auth: McpAuth;
  timeoutMs?: number;
};

export class McpClient {
  readonly #fetch: AtlassianFetch;
  readonly #url: () => string;
  readonly #auth: McpAuth;
  readonly #timeoutMs: number;
  /** `undefined` : pas de session ouverte ; `null` : le serveur n'en donne pas. */
  #session: string | null | undefined = undefined;
  #opening: Promise<void> | null = null;
  #nextId = 1;

  constructor(deps: McpClientDeps) {
    this.#fetch = deps.fetch;
    this.#url = deps.url;
    this.#auth = deps.auth;
    this.#timeoutMs = deps.timeoutMs ?? MCP_TIMEOUT_MS;
  }

  /** Oublie la session (débranchement, nouveau compte) : la prochaine demande en ouvre une. */
  reset(): void {
    this.#session = undefined;
  }

  /** Un outil du serveur : `{text, isError}`. Lève sur une erreur de transport, de jeton ou un délai dépassé. */
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpToolResult> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const bounded = AbortSignal.any([signal, timeout]);
    let refreshed = false;
    let reopened = false;
    try {
      for (;;) {
        const token = await this.#auth.accessToken();
        try {
          await this.#open(token, bounded);
          const id = this.#nextId++;
          const response = await this.#post(
            { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
            token,
            bounded,
          );
          return toolResultOf(replyOf(await response.text(), id));
        } catch (error) {
          if (!(error instanceof McpHttpError)) throw error;
          if (error.status === 401 && !refreshed) {
            refreshed = true;
            this.#session = undefined;
            await this.#auth.refresh(token);
            continue;
          }
          const lostSession = error.status === 404 || (error.status === 400 && /session/i.test(error.message));
          if (lostSession && !reopened) {
            reopened = true;
            this.#session = undefined;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (timeout.aborted) throw new Error(`Atlassian n'a pas répondu en ${Math.round(this.#timeoutMs / 1000)} s`);
      throw error;
    }
  }

  /** Ouvre la session si besoin ; une seule ouverture en vol, partagée par les appels concurrents. */
  async #open(token: string, signal: AbortSignal): Promise<void> {
    if (this.#session !== undefined) return;
    this.#opening ??= this.#initialize(token, signal).finally(() => {
      this.#opening = null;
    });
    await this.#opening;
  }

  async #initialize(token: string, signal: AbortSignal): Promise<void> {
    const id = this.#nextId++;
    const response = await this.#post(
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "omp-harness", version: "1" },
        },
      },
      token,
      signal,
    );
    const session = response.headers?.get("mcp-session-id") ?? null;
    const reply = replyOf(await response.text(), id);
    if (reply !== null && isRecord(reply.error))
      throw new Error(`initialisation MCP refusée : ${String(reply.error.message)}`);
    this.#session = session;
    await (await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, token, signal)).text();
  }

  async #post(message: JsonRpcMessage, token: string, signal: AbortSignal): Promise<AtlassianResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    };
    if (typeof this.#session === "string") headers["Mcp-Session-Id"] = this.#session;
    const response = await this.#fetch(this.#url(), {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
      throw new McpHttpError(response.status, `serveur MCP : HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
    }
    return response;
  }
}
