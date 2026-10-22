// L'oracle : mem0-rs, scope PROJET. Briefs clients, comptes rendus de besoins,
// schémas d'archi et surtout les décisions tranchées par l'humain, avec leur raison.
//
// Lu par /req, /specs et /project ; écrit par le knowledge-updater (fin de run) et
// par chaque correction humaine. Un oracle injoignable DÉGRADE le harness (rappel
// vide, écriture perdue et journalisée) sans jamais le bloquer.

export type Memory = { id: string; text: string; score: number | null; tags: string[]; createdAt: string | null };

export type OracleConfig = { url: string; token: string | null };

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface Oracle {
  recall(scope: string, query: string, limit?: number): Promise<Memory[]>;
  /** Les décisions tranchées par l'humain (souvenirs `harness,decision`) qui répondent à `question`. */
  recallDecisions(scope: string, question: string, limit?: number): Promise<Memory[]>;
  retain(scope: string, text: string, tags?: string[]): Promise<boolean>;
  /** Le service répond-il (`GET /health`, `ok: true`) ? */
  health(): Promise<boolean>;
}

/** Les étiquettes d'une ligne mem0 : `tags` (chaîne « a,b » ou liste), sinon `metadata.tags`. */
function tagsOf(record: Record<string, unknown>): string[] {
  const metadata = record.metadata;
  const raw =
    record.tags ??
    (metadata !== null && typeof metadata === "object" && "tags" in metadata ? metadata.tags : undefined);
  if (typeof raw === "string")
    return raw
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((tag): tag is string => typeof tag === "string");
  return [];
}

/** Le souvenir répond-il à une décision : étiqueté `harness` ET `decision` ? */
export function isDecisionMemory(memory: Memory): boolean {
  return memory.tags.includes("harness") && memory.tags.includes("decision");
}

/** Les lignes d'une réponse de recherche mem0 (liste nue ou `{ results }`). */
export function memoriesOf(body: unknown): Memory[] {
  const rows = Array.isArray(body)
    ? body
    : body !== null && typeof body === "object" && Array.isArray((body as { results?: unknown }).results)
      ? (body as { results: unknown[] }).results
      : [];
  const out: Memory[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const text =
      typeof record.memory === "string" ? record.memory : typeof record.text === "string" ? record.text : null;
    if (text === null) continue;
    out.push({
      id: String(record.id ?? ""),
      text,
      score: typeof record.score === "number" ? record.score : null,
      tags: tagsOf(record),
      createdAt: typeof record.created_at === "string" ? record.created_at : null,
    });
  }
  return out;
}

export class HttpOracle implements Oracle {
  readonly #config: OracleConfig;
  readonly #fetch: FetchLike;
  readonly #log: (line: string) => void;
  readonly #timeoutMs: number;

  constructor(
    config: OracleConfig,
    options: { fetch?: FetchLike; log?: (line: string) => void; timeoutMs?: number } = {},
  ) {
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
        headers: {
          "Content-Type": "application/json",
          ...(this.#config.token ? { "X-Mem0-Token": this.#config.token } : {}),
        },
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
      return memoriesOf(
        await this.#post("/memory/search", { query, agent_id: scope, limit, threshold: null, filters: null }),
      );
    } catch (err) {
      this.#log(`oracle injoignable (rappel) : ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * mem0-rs ne filtre `tags` que par égalité stricte de la chaîne entière (« a,b »),
   * et l'ordre des étiquettes n'est pas garanti : le filtre se fait ici, sur une
   * fenêtre plus large que `limit`.
   */
  async recallDecisions(scope: string, question: string, limit = 5): Promise<Memory[]> {
    const memories = await this.recall(scope, question, limit * 4);
    return memories.filter(isDecisionMemory).slice(0, limit);
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
  recallDecisions: async () => [],
  retain: async () => false,
  health: async () => false,
};

/**
 * Ce que l'oracle garde de req.md : les besoins `B-n` seulement, en ≤ 500 caractères.
 * Le reste (questions, options écartées, détails) vit déjà dans les artefacts du run.
 */
export function briefOfReq(reqMd: string): string {
  const lines = reqMd
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(?:[-*]\s+)?/, "")
        .replace(/\*\*/g, "")
        .trim(),
    )
    .filter((line) => /^B-\d+\b/.test(line));
  let out = "";
  for (const line of lines) {
    const next = out === "" ? line : `${out}\n${line}`;
    if (next.length > 500) {
      if (out === "") out = `${line.slice(0, 499)}…`;
      break;
    }
    out = next;
  }
  return out;
}

/** Les souvenirs rendus pour un prompt : un par ligne, numérotés, avec l'étiquette principale et la date courte. */
export function renderMemories(memories: Memory[]): string {
  if (memories.length === 0) return "(l'oracle n'a rien rendu)";
  return memories
    .map((memory, index) => {
      const marks: string[] = [];
      const tag = memory.tags.find((candidate) => candidate !== "harness") ?? memory.tags[0];
      if (tag !== undefined) marks.push(tag);
      const date = memory.createdAt === null ? null : /^(\d{4}-\d{2}-\d{2})/.exec(memory.createdAt);
      if (date) marks.push(date[1]);
      const prefix = marks.length > 0 ? `[${marks.join(", ")}] ` : "";
      return `${index + 1}. ${prefix}${memory.text.replace(/\s+/g, " ").trim()}`;
    })
    .join("\n");
}

/**
 * Le souvenir d'une décision tranchée ou renversée par l'humain — la raison d'abord.
 * La catégorie reste en clair (`[catégorie : schema]`) : les étapes la relisent pour
 * reconnaître une question déjà tranchée du même genre.
 */
export function humanDecisionMemory(input: {
  feature: string;
  question: string;
  chosen: string;
  reason: string;
  category?: string | null;
  options?: string[] | null;
  context?: string | null;
  reversedFrom?: string | null;
}): string {
  const verb = input.reversedFrom
    ? `renversée (le runner avait choisi « ${input.reversedFrom} »)`
    : "tranchée par l'humain";
  const category = input.category ? ` [catégorie : ${input.category}]` : "";
  const options = input.options && input.options.length > 0 ? ` Options : ${input.options.join(" | ")}.` : "";
  const context = input.context?.trim() ? ` Contexte : ${input.context.trim()}` : "";
  const reason = input.reason.trim() === "" ? "sans raison donnée" : input.reason.trim();
  return `Décision ${verb}${category} — feature « ${input.feature} » : ${input.question} → « ${input.chosen} ».${options}${context} Raison : ${reason}`;
}
