// Le canal d'un runner : `omp --mode rpc`, commandes JSON sur stdin, réponses et
// événements JSONL sur stdout (protocole v1 d'OMP, aucun découpage en morceaux).
//
// Les outils du harness (run_tests, decision, review_verdict, oracle…) sont des
// OUTILS HÔTES : OMP émet `host_tool_call`, le service exécute et répond par
// `host_tool_result`. Le runner n'a donc ni clé du service, ni accès à la base :
// le service reste l'unique point d'entrée et l'unique écrivain.
import type { Readable, Writable } from "node:stream";

/** Le process d'un runner, tel que `child_process.spawn` le rend. */
export type RunnerProcess = {
  pid?: number;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  once: (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
  /** Un `kill` refusé (runner lancé par sudo : EPERM) arrive ici, jamais en exception non gérée. */
  on: (event: "error", listener: (error: Error) => void) => unknown;
};

export type HostToolResult = { text: string; isError?: boolean; details?: unknown };

export type HostToolHandler = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<HostToolResult>;

export type HostToolDefinition = {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  loadMode?: "essential" | "discoverable";
};

/** La cause d'une erreur de prompt, lue sur le statut HTTP ou le message : ce qui décide de la bascule et de la relance. */
export type PromptErrorCause = "rate_limit" | "server_error" | "network" | "context" | "other";

export type PromptError = {
  message: string;
  provider?: string;
  model?: string;
  httpStatus?: number;
  retryable?: boolean;
  /** Posée par la session du runner (classifyPromptError) avant de rendre l'erreur à l'étape. */
  cause?: PromptErrorCause;
  /** Le `retry-after` du fournisseur en ms, s'il l'a dit ; sinon `null`. */
  retryAfterMs?: number | null;
  /** Les détails bruts qu'OMP joint à l'erreur (en-têtes, corps) : fouillés pour `retry-after`. */
  details?: unknown;
};

export type PromptResult = { status: "completed" | "aborted" | "error"; error: PromptError | null };

type Frame = Record<string, unknown>;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Les méthodes d'UI qui ATTENDENT une réponse : un runner n'a pas d'humain, on annule. */
const BLOCKING_UI = new Set(["select", "confirm", "input", "editor", "ask"]);

export class RunnerExited extends Error {
  constructor(detail: string) {
    super(`runner arrêté : ${detail}`);
  }
}

export class RpcRunner {
  readonly #proc: RunnerProcess;
  readonly #onHostTool: HostToolHandler;
  readonly #onFrame: (frame: Frame) => void;
  readonly #requests = new Map<string, Pending>();
  readonly #prompts = new Map<string, Pending>();
  readonly #toolCalls = new Map<string, AbortController>();
  readonly #stderr: string[] = [];
  #buffer = "";
  #seq = 0;
  #dead: Error | null = null;
  #ready: Pending | null = null;
  readonly readyPromise: Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(proc: RunnerProcess, handlers: { onHostTool: HostToolHandler; onFrame?: (frame: Frame) => void }) {
    this.#proc = proc;
    this.#onHostTool = handlers.onHostTool;
    this.#onFrame = handlers.onFrame ?? (() => {});
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.#ready = { resolve: () => resolve(), reject };
    });
    // Une promesse jamais attendue ne doit pas tuer le service sur un rejet.
    this.readyPromise.catch(() => {});
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.#feed(chunk));
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      this.#stderr.push(chunk);
      if (this.#stderr.length > 50) this.#stderr.shift();
    });
    proc.stdin?.on("error", () => {
      /* un stdin fermé par un runner mort : la sortie le dit déjà */
    });
    proc.on("error", (error) => {
      this.#stderr.push(`[harness] ${error.message}\n`);
    });
    this.exited = new Promise((resolve) => {
      proc.once("exit", (code, signal) => {
        this.#fail(new RunnerExited(`code ${code ?? "∅"}, signal ${signal ?? "∅"} — ${this.stderrTail().slice(-500)}`));
        resolve({ code, signal });
      });
    });
  }

  get alive(): boolean {
    return this.#dead === null;
  }

  stderrTail(): string {
    return this.#stderr.join("");
  }

  #fail(error: Error): void {
    if (this.#dead) return;
    this.#dead = error;
    this.#ready?.reject(error);
    for (const pending of [...this.#requests.values(), ...this.#prompts.values()]) pending.reject(error);
    this.#requests.clear();
    this.#prompts.clear();
    for (const controller of this.#toolCalls.values()) controller.abort();
    this.#toolCalls.clear();
  }

  #write(frame: Frame): void {
    if (this.#dead) throw this.#dead;
    this.#proc.stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  #feed(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== "") {
        let frame: unknown = null;
        try {
          frame = JSON.parse(line);
        } catch {
          frame = null;
        }
        if (frame !== null && typeof frame === "object" && !Array.isArray(frame)) this.#dispatch(frame as Frame);
      }
      newline = this.#buffer.indexOf("\n");
    }
  }

  #dispatch(frame: Frame): void {
    const type = frame.type;
    const id = typeof frame.id === "string" ? frame.id : null;
    if (type === "ready") {
      this.#ready?.resolve(undefined);
      return;
    }
    if (type === "response" && id !== null) {
      const pending = this.#requests.get(id);
      if (!pending) return;
      // Une réponse `prompt` réussie n'est qu'un accusé : on attend `prompt_result`.
      if (frame.command === "prompt" && frame.success === true) return;
      this.#requests.delete(id);
      if (frame.success === true) pending.resolve(frame.data);
      else {
        const prompt = this.#prompts.get(id);
        this.#prompts.delete(id);
        const error = new Error(`${String(frame.command)} refusé : ${String(frame.error ?? "erreur inconnue")}`);
        pending.reject(error);
        prompt?.reject(error);
      }
      return;
    }
    if (type === "prompt_result" && id !== null) {
      const pending = this.#prompts.get(id);
      this.#prompts.delete(id);
      this.#requests.delete(id);
      const status = frame.status === "aborted" || frame.status === "error" ? frame.status : "completed";
      const error = frame.error !== null && typeof frame.error === "object" ? (frame.error as PromptError) : null;
      pending?.resolve({ status, error } satisfies PromptResult);
      return;
    }
    if (type === "host_tool_call" && id !== null) {
      void this.#hostTool(id, String(frame.toolName ?? ""), (frame.arguments ?? {}) as Record<string, unknown>);
      return;
    }
    if (type === "host_tool_cancel") {
      const target = typeof frame.targetId === "string" ? frame.targetId : "";
      this.#toolCalls.get(target)?.abort();
      return;
    }
    if (
      type === "extension_ui_request" &&
      id !== null &&
      typeof frame.method === "string" &&
      BLOCKING_UI.has(frame.method)
    ) {
      this.#write({ type: "extension_ui_response", id, cancelled: true });
      return;
    }
    this.#onFrame(frame);
  }

  async #hostTool(id: string, name: string, args: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    this.#toolCalls.set(id, controller);
    let result: HostToolResult;
    try {
      result = await this.#onHostTool(name, args, controller.signal);
    } catch (err) {
      result = {
        text: `échec de l'outil ${name} : ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    } finally {
      this.#toolCalls.delete(id);
    }
    if (this.#dead) return;
    this.#write({
      type: "host_tool_result",
      id,
      result: {
        content: [{ type: "text", text: result.text }],
        ...(result.details !== undefined ? { details: result.details } : {}),
      },
      ...(result.isError ? { isError: true } : {}),
    });
  }

  /** Attend la trame `ready`, ou échoue au délai. */
  async ready(timeoutMs = 60_000): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`runner muet : aucune trame ready en ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Une commande, et sa réponse (`data`). */
  request(command: Frame): Promise<unknown> {
    const id = `h${++this.#seq}`;
    return new Promise((resolve, reject) => {
      if (this.#dead) {
        reject(this.#dead);
        return;
      }
      this.#requests.set(id, { resolve, reject });
      this.#write({ ...command, id });
    });
  }

  /** Un prompt complet : résolu au `prompt_result` (fin du travail que le prompt a causé). */
  prompt(message: string): Promise<PromptResult> {
    const id = `h${++this.#seq}`;
    return new Promise((resolve, reject) => {
      if (this.#dead) {
        reject(this.#dead);
        return;
      }
      this.#prompts.set(id, { resolve: (value) => resolve(value as PromptResult), reject });
      this.#requests.set(id, { resolve: () => {}, reject });
      this.#write({ type: "prompt", id, message });
    });
  }

  setHostTools(tools: HostToolDefinition[]): Promise<unknown> {
    return this.request({ type: "set_host_tools", tools });
  }

  setModel(provider: string, modelId: string): Promise<unknown> {
    return this.request({ type: "set_model", provider, modelId });
  }

  async lastAssistantText(): Promise<string> {
    const data = await this.request({ type: "get_last_assistant_text" });
    if (typeof data === "string") return data;
    if (data !== null && typeof data === "object" && typeof (data as { text?: unknown }).text === "string")
      return (data as { text: string }).text;
    return "";
  }

  async #exitWithin(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | null = null;
    const exited = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return exited;
  }

  /**
   * Arrêt BORNÉ : stdin fermé (un runner RPC sort sur EOF), puis SIGTERM, puis
   * `force` (l'arrêt de son unité par le lanceur), puis SIGKILL. Au pire, le runner
   * est déclaré mort après quatre délais : jamais d'attente infinie.
   */
  async stop(graceMs = 5000, force?: () => Promise<void>): Promise<void> {
    if (this.#dead) return;
    const quietly = (fn: () => unknown) => {
      try {
        fn();
      } catch {
        /* déjà fermé, ou signal refusé (EPERM) */
      }
    };
    quietly(() => this.#proc.stdin?.end());
    if (await this.#exitWithin(graceMs)) return;
    quietly(() => this.#proc.kill("SIGTERM"));
    if (await this.#exitWithin(graceMs)) return;
    if (force) await force().catch(() => {});
    if (await this.#exitWithin(graceMs)) return;
    quietly(() => this.#proc.kill("SIGKILL"));
    if (await this.#exitWithin(graceMs)) return;
    this.#fail(new RunnerExited("arrêt forcé : le process ne répond plus"));
  }
}

const RATE_LIMIT = /(\brate[ -]?limit(ed)?\b|\btoo many requests\b|\bquota\b|overloaded|\busage limit\b)/i;
const NETWORK =
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error|stream (closed|ended|disconnected)|terminated)\b/i;
const CONTEXT =
  /\b(context[ _-]?(length|window)|too long|maximum context|prompt is too long|exceeds the (maximum )?(context|token))\b/i;

/** La cause d'une erreur de prompt : 429 et messages de quota, 5xx, pannes réseau, contexte dépassé, le reste. */
export function classifyPromptError(error: PromptError | null): PromptErrorCause {
  if (!error) return "other";
  const status = error.httpStatus ?? null;
  // 529 : « overloaded » chez Anthropic — un refroidissement, pas une panne.
  if (status === 429 || status === 529) return "rate_limit";
  if (CONTEXT.test(error.message)) return "context";
  if (RATE_LIMIT.test(error.message)) return "rate_limit";
  if (status !== null && status >= 500 && status <= 599) return "server_error";
  if (
    /\b5\d\d\b/.test(error.message) &&
    /\b(internal server error|bad gateway|service unavailable|gateway timeout|server error)\b/i.test(error.message)
  )
    return "server_error";
  if (NETWORK.test(error.message)) return "network";
  return "other";
}

/** Un rate limit dans l'erreur d'un prompt : 429, ou un message de quota. */
export function isRateLimit(error: PromptError | null): boolean {
  return classifyPromptError(error) === "rate_limit";
}

/** Une valeur `retry-after` (secondes, ou date HTTP) en ms, ou `null`. */
function retryAfterValue(value: unknown, now: number): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value * 1000);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** Cherche `retry-after` / `retryAfter` dans un objet (en-têtes, corps), sans descendre plus de 4 niveaux. */
function retryAfterIn(value: unknown, now: number, depth = 0): number | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = retryAfterIn(item, now, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  for (const [key, entry] of Object.entries(record)) {
    const name = key.toLowerCase().replace(/[-_]/g, "");
    if (name === "retryafter" || name === "retryafterms") {
      const parsed =
        name === "retryafterms" && typeof entry === "number" ? Math.round(entry) : retryAfterValue(entry, now);
      if (parsed !== null) return parsed;
    }
  }
  for (const entry of Object.values(record)) {
    const found = retryAfterIn(entry, now, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Le délai demandé par le fournisseur, en ms : `retry-after` dans les détails de
 * l'erreur (en-têtes ou corps), `retryAfter` déjà posé, ou « retry after N s » /
 * « try again in N s|min » dans le message. `null` quand rien ne le dit.
 */
export function parseRetryAfter(error: PromptError | null, now = Date.now()): number | null {
  if (!error) return null;
  if (typeof error.retryAfterMs === "number") return error.retryAfterMs;
  const inDetails = retryAfterIn(error.details, now);
  if (inDetails !== null) return inDetails;
  const match = error.message.match(
    /\b(?:retry[ -]?after|try again in|retry in|wait)\s*:?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hours?)?\b/i,
  );
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const factor =
    unit.startsWith("ms") || unit.startsWith("milli")
      ? 1
      : unit.startsWith("m")
        ? 60_000
        : unit.startsWith("h")
          ? 3_600_000
          : 1000;
  return Math.round(amount * factor);
}
