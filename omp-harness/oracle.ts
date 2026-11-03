// L'oracle : mem0-rs, scope PROJET. Briefs clients, comptes rendus de besoins,
// schémas d'archi et surtout les décisions tranchées par l'humain, avec leur raison.
//
// Lu par /req, /specs et /project ; écrit par le knowledge-updater (fin de run) et
// par chaque correction humaine. Un oracle injoignable DÉGRADE le harness (rappel
// vide, écriture perdue, journalisée et comptée) sans jamais le bloquer. Un oracle
// LENT n'est pas injoignable : une écriture y est retentée, une lecture abandonne vite.

export type Memory = { id: string; text: string; score: number | null; tags: string[]; createdAt: string | null };

export type OracleConfig = { url: string; token: string | null };

/** Les écritures perdues depuis le démarrage du service : combien, la dernière et sa raison. */
export type LostWrites = { count: number; lastAt: string | null; lastError: string | null };

/** Ce que l'oracle lit d'une réponse de `fetch`. */
export type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponse>;

/**
 * Le dossier de consolidation d'une portée (`GET /memory/dream/dossier` de mem0-rs) :
 * ce que la session de rêve lit. Les champs non lus par le harness restent opaques.
 */
export type DreamDossier = {
  horizon_us: number;
  since: string | null;
  due: boolean;
  new_facts: { id: string; memory: string; updated_at: string }[];
  [key: string]: unknown;
};

/** Ce que mem0-rs a écrit d'une consolidation (`POST /memory/dream/consolidation`). */
export type ConsolidationReport = {
  dream: string;
  observations_added: number;
  observations_refined: number;
  observations_removed: number;
  causes: number;
  models: number;
  horizon_us: number;
};

export interface Oracle {
  recall(scope: string, query: string, limit?: number): Promise<Memory[]>;
  /** Les décisions tranchées par l'humain (souvenirs `harness,decision`) qui répondent à `question`. */
  recallDecisions(scope: string, question: string, limit?: number): Promise<Memory[]>;
  retain(scope: string, text: string, tags?: string[]): Promise<boolean>;
  /** Le service répond-il (`GET /health`, `ok: true`) ? */
  health(): Promise<boolean>;
  /** Le dossier de rêve de la portée ; `null` : service injoignable ou sans cette route. */
  dreamDossier(scope: string): Promise<DreamDossier | null>;
  /**
   * Rend la consolidation d'une portée ; le service la valide puis l'applique d'un bloc.
   * Rejette avec la raison du refus (corps invalide, id inconnu, service injoignable).
   */
  consolidate(scope: string, consolidation: Record<string, unknown>): Promise<ConsolidationReport>;
  /** Les écritures abandonnées depuis le démarrage (rien de perdu : `count` à 0). */
  lostWrites(): LostWrites;
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

/** Un refus HTTP de mem0-rs, avec son statut : 429 et 5xx se retentent, un autre 4xx non. */
class OracleHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`mem0 ${status}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

/** Le délai d'un essai écoulé : le service est lent, pas injoignable. */
class OracleTimeout extends Error {}

/**
 * Connexion coupée en route : passagère, retentée. Tout autre code (ECONNREFUSED,
 * ENOTFOUND, EAI_AGAIN…) dit que personne n'écoute : retenter n'y changerait rien.
 */
const CUT: Record<string, true> = {
  ECONNRESET: true,
  EPIPE: true,
  ETIMEDOUT: true,
  ECONNABORTED: true,
  UND_ERR_SOCKET: true,
  UND_ERR_CONNECT_TIMEOUT: true,
  UND_ERR_HEADERS_TIMEOUT: true,
  UND_ERR_BODY_TIMEOUT: true,
};

type Failure = { kind: "lent" | "coupé" | "en erreur" | "injoignable"; retry: boolean; message: string };

/** Le cas d'un échec : `fetch` (undici) porte le code système dans `cause.code`. */
function failureOf(err: unknown): Failure {
  const message = err instanceof Error ? err.message : String(err);
  if (
    err instanceof OracleTimeout ||
    (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))
  )
    return { kind: "lent", retry: true, message };
  if (err instanceof OracleHttpError)
    return { kind: "en erreur", retry: err.status === 429 || err.status >= 500, message };
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = cause?.code ?? (err as { code?: unknown } | null)?.code;
  const coded = typeof code === "string" && !message.includes(code) ? `${message} (${code})` : message;
  if (typeof code === "string" && CUT[code] === true) return { kind: "coupé", retry: true, message: coded };
  return { kind: "injoignable", retry: false, message: coded };
}

export type HttpOracleOptions = {
  fetch?: FetchLike;
  log?: (line: string) => void;
  /** Le délai d'une lecture (rappel, santé, dossier) : elles sont sur le chemin des prompts. */
  timeoutMs?: number;
  /** Le délai d'un essai d'écriture : mem0-rs y plonge le texte, son modèle d'embedding peut se recharger. */
  writeTimeoutMs?: number;
  /** Les essais d'une écriture, le premier compris. */
  writeAttempts?: number;
  /** L'attente avant le 2e essai, doublée à chaque essai suivant. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export class HttpOracle implements Oracle {
  readonly #config: OracleConfig;
  readonly #fetch: FetchLike;
  readonly #log: (line: string) => void;
  readonly #timeoutMs: number;
  readonly #writeTimeoutMs: number;
  readonly #writeAttempts: number;
  readonly #backoffMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;
  #lost: LostWrites = { count: 0, lastAt: null, lastError: null };

  constructor(config: OracleConfig, options: HttpOracleOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#log = options.log ?? (() => {});
    this.#timeoutMs = options.timeoutMs ?? 8000;
    this.#writeTimeoutMs = options.writeTimeoutMs ?? 30_000;
    this.#writeAttempts = Math.max(1, options.writeAttempts ?? 4);
    this.#backoffMs = options.backoffMs ?? 2000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => new Date());
  }

  /** Une requête bornée à `timeoutMs` ; un délai écoulé lève `OracleTimeout`, un statut d'échec `OracleHttpError`. */
  async #request(route: string, timeoutMs: number, body?: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.#fetch(`${this.#config.url.replace(/\/$/, "")}${route}`, {
        method: body ? "POST" : "GET",
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(this.#config.token ? { "X-Mem0-Token": this.#config.token } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) throw new OracleHttpError(response.status, await response.text());
      return await response.json();
    } catch (err) {
      if (controller.signal.aborted) throw new OracleTimeout(`pas de réponse en ${timeoutMs / 1000} s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async dreamDossier(scope: string): Promise<DreamDossier | null> {
    try {
      const body = (await this.#request(
        `/memory/dream/dossier?agent_id=${encodeURIComponent(scope)}`,
        this.#timeoutMs,
      )) as DreamDossier;
      return typeof body?.horizon_us === "number" && Array.isArray(body.new_facts) ? body : null;
    } catch (err) {
      const failure = failureOf(err);
      this.#log(`oracle ${failure.kind} (dossier de rêve) : ${failure.message}`);
      return null;
    }
  }

  /** Une écriture d'un bloc : le délai d'une écriture, un seul essai (un refus revient au modèle, qui rappelle). */
  async consolidate(scope: string, consolidation: Record<string, unknown>): Promise<ConsolidationReport> {
    return (await this.#request("/memory/dream/consolidation", this.#writeTimeoutMs, {
      ...consolidation,
      agent_id: scope,
    })) as ConsolidationReport;
  }

  async health(): Promise<boolean> {
    try {
      const body = (await this.#request("/health", this.#timeoutMs)) as { ok?: unknown };
      return body?.ok === true;
    } catch {
      return false;
    }
  }

  async recall(scope: string, query: string, limit = 8): Promise<Memory[]> {
    try {
      return memoriesOf(
        await this.#request("/memory/search", this.#timeoutMs, {
          query,
          agent_id: scope,
          limit,
          threshold: null,
          filters: null,
        }),
      );
    } catch (err) {
      const failure = failureOf(err);
      this.#log(`oracle ${failure.kind} (rappel) : ${failure.message}`);
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

  /**
   * Lent (délai écoulé), coupé en route ou en erreur passagère (429, 5xx) : retentée
   * avec une attente doublée à chaque essai. Injoignable ou refusée (autre 4xx) :
   * perdue tout de suite. Une écriture perdue est journalisée une fois et comptée.
   * Peut durer plusieurs minutes : un chemin de requête HTTP ne l'attend pas.
   */
  async retain(scope: string, text: string, tags: string[] = []): Promise<boolean> {
    const body = { text, agent_id: scope, tags: tags.join(",") || undefined, infer: false };
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#request("/memory/add", this.#writeTimeoutMs, body);
        return true;
      } catch (err) {
        const failure = failureOf(err);
        if (failure.retry && attempt < this.#writeAttempts) {
          const wait = this.#backoffMs * 2 ** (attempt - 1);
          this.#log(
            `oracle ${failure.kind} (écriture, essai ${attempt}/${this.#writeAttempts}) : ${failure.message} — nouvel essai dans ${wait / 1000} s`,
          );
          await this.#sleep(wait);
          continue;
        }
        this.#lost = {
          count: this.#lost.count + 1,
          lastAt: this.#now().toISOString(),
          lastError: `${failure.kind} : ${failure.message}`,
        };
        this.#log(
          `oracle ${failure.kind} (écriture perdue après ${attempt} essai${attempt > 1 ? "s" : ""}) : ${failure.message}`,
        );
        return false;
      }
    }
  }

  lostWrites(): LostWrites {
    return { ...this.#lost };
  }
}

/** L'oracle absent (non configuré) : rappel vide, écriture refusée. */
export const NO_ORACLE: Oracle = {
  recall: async () => [],
  recallDecisions: async () => [],
  retain: async () => false,
  health: async () => false,
  dreamDossier: async () => null,
  consolidate: async () => {
    throw new Error("aucun oracle configuré");
  },
  lostWrites: () => ({ count: 0, lastAt: null, lastError: null }),
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
