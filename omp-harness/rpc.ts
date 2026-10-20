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
};

export type HostToolResult = { text: string; isError?: boolean; details?: unknown };

export type HostToolHandler = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<HostToolResult>;

export type HostToolDefinition = {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  loadMode?: "essential" | "discoverable";
};

export type PromptError = { message: string; provider?: string; model?: string; httpStatus?: number; retryable?: boolean };

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
    this.exited = new Promise(resolve => {
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
    if (type === "extension_ui_request" && id !== null && typeof frame.method === "string" && BLOCKING_UI.has(frame.method)) {
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
      result = { text: `échec de l'outil ${name} : ${err instanceof Error ? err.message : String(err)}`, isError: true };
    } finally {
      this.#toolCalls.delete(id);
    }
    if (this.#dead) return;
    this.#write({
      type: "host_tool_result",
      id,
      result: { content: [{ type: "text", text: result.text }], ...(result.details !== undefined ? { details: result.details } : {}) },
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
      this.#prompts.set(id, { resolve: value => resolve(value as PromptResult), reject });
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
    if (data !== null && typeof data === "object" && typeof (data as { text?: unknown }).text === "string") return (data as { text: string }).text;
    return "";
  }

  /** Arrêt : stdin fermé, puis SIGTERM, puis SIGKILL si le runner traîne. */
  async stop(graceMs = 5000): Promise<void> {
    if (!this.#dead) {
      try {
        this.#proc.stdin?.end();
      } catch {
        /* déjà fermé */
      }
      this.#proc.kill("SIGTERM");
      const timer = setTimeout(() => this.#proc.kill("SIGKILL"), graceMs);
      await this.exited;
      clearTimeout(timer);
    }
  }
}


/** Un rate limit dans l'erreur d'un prompt : 429, ou un message de quota. */
export function isRateLimit(error: PromptError | null): boolean {
  if (!error) return false;
  if (error.httpStatus === 429) return true;
  return /\b(rate[ -]?limit|too many requests|quota|overloaded|usage limit)\b/i.test(error.message);
}
