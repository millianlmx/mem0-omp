// L'oracle : mem0-rs, scope PROJET. Briefs clients, comptes rendus de besoins,
// schémas d'archi et surtout les décisions tranchées par l'humain, avec leur raison.
//
// Lu par /req, /specs et /project ; écrit par le knowledge-updater (fin de run) et
// par chaque correction humaine. Un oracle injoignable DÉGRADE le harness (rappel
// vide, écriture perdue et journalisée) sans jamais le bloquer.


export type Memory = { id: string; text: string; score: number | null };

export type OracleConfig = { url: string; token: string | null };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;


export interface Oracle {
  recall(scope: string, query: string, limit?: number): Promise<Memory[]>;
  retain(scope: string, text: string, tags?: string[]): Promise<boolean>;
  /** Le service répond-il (`GET /health`, `ok: true`) ? */
  health(): Promise<boolean>;
}


/** Les lignes d'une réponse de recherche mem0 (liste nue ou `{ results }`). */
export function memoriesOf(body: unknown): Memory[] {
  const rows = Array.isArray(body) ? body : body !== null && typeof body === "object" && Array.isArray((body as { results?: unknown }).results) ? (body as { results: unknown[] }).results : [];
  const out: Memory[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const text = typeof record.memory === "string" ? record.memory : typeof record.text === "string" ? record.text : null;
    if (text === null) continue;
    out.push({ id: String(record.id ?? ""), text, score: typeof record.score === "number" ? record.score : null });
  }
  return out;
}


export class HttpOracle implements Oracle {
  readonly #config: OracleConfig;
  readonly #fetch: FetchLike;
  readonly #log: (line: string) => void;
  readonly #timeoutMs: number;

  constructor(config: OracleConfig, options: { fetch?: FetchLike; log?: (line: string) => void; timeoutMs?: number } = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#log = options.log ?? (() => {});
    this.#timeoutMs = options.timeoutMs ?? 8000;
  }

  async #post(route: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#config.url.replace(/\/$/, "")}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.#config.token ? { "X-Mem0-Token": this.#config.token } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`mem0 ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#config.url.replace(/\/$/, "")}/health`, {
        method: "GET",
        headers: this.#config.token ? { "X-Mem0-Token": this.#config.token } : {},
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { ok?: unknown };
      return body?.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async recall(scope: string, query: string, limit = 8): Promise<Memory[]> {
    try {
      return memoriesOf(await this.#post("/memory/search", { query, agent_id: scope, limit, threshold: null, filters: null }));
    } catch (err) {
      this.#log(`oracle injoignable (rappel) : ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async retain(scope: string, text: string, tags: string[] = []): Promise<boolean> {
    try {
      await this.#post("/memory/add", { text, agent_id: scope, tags: tags.join(",") || undefined, infer: false });
      return true;
    } catch (err) {
      this.#log(`oracle injoignable (écriture perdue) : ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}


/** L'oracle absent (non configuré) : rappel vide, écriture refusée. */
export const NO_ORACLE: Oracle = {
  recall: async () => [],
  retain: async () => false,
  health: async () => false,
};


/** Les souvenirs rendus pour un prompt : un par ligne, numérotés. */
export function renderMemories(memories: Memory[]): string {
  if (memories.length === 0) return "(l'oracle n'a rien rendu)";
  return memories.map((memory, index) => `${index + 1}. ${memory.text.replace(/\s+/g, " ").trim()}`).join("\n");
}


/** Le souvenir d'une décision tranchée ou renversée par l'humain — la raison d'abord. */
export function humanDecisionMemory(input: { feature: string; question: string; chosen: string; reason: string; reversedFrom?: string | null }): string {
  const verb = input.reversedFrom ? `renversée (le runner avait choisi « ${input.reversedFrom} »)` : "tranchée par l'humain";
  return `Décision ${verb} — feature « ${input.feature} » : ${input.question} → « ${input.chosen} ». Raison : ${input.reason}`;
}
