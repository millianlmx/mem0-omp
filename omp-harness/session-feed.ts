// Le direct d'une session de runner : ce que l'agent écrit, pense et fait, lu dans les
// trames RPC d'omp et réduit en ENTRÉES compactes que les apps affichent en temps réel.
//
// Une entrée est un paragraphe de l'agent (`text`), son raisonnement (`thinking`), un
// appel d'outil (`tool`, de son lancement à son résultat) ou un signal de la session
// (`notice` : contexte compacté, réessai du fournisseur). Elle est poussée en
// événement ÉPHÉMÈRE `session` (jamais écrit au journal) et REMPLACE celle de même
// `seq` chez le client : un paragraphe qui s'allonge est renvoyé entier, au plus une
// fois par SESSION_THROTTLE_MS, puis une dernière fois à la fin du message — une trame
// perdue ne laisse donc jamais un texte tronqué.
//
// Chaque entrée est aussi écrite dans la base (`session_entries`) : une app qui ouvre
// le direct en cours de route lit d'abord ses dernières entrées
// (`GET /v1/runs/{id}/session`, ou `/v1/audits/{id}/session`), puis suit le flux ; une
// session finie se rejoue page par page (`?before=<seq>`), et la numérotation reprend
// après un redémarrage. Le propriétaire du direct est un run (son id) ou un audit
// (`audit:<id>`). Les SESSION_RUNS derniers propriétaires gardent en mémoire leur état
// en cours (paragraphe qui s'écrit, outils lancés, dernière trame).
//
// Tout texte est borné et passe par `redact` : une commande ou une sortie d'outil
// peut contenir une clé, et le direct est lisible par tout client du dépôt.

export type SessionEntryKind = "text" | "thinking" | "tool" | "notice";

export type SessionEntryStatus = "running" | "ok" | "error";

export type SessionEntry = {
  /** Croissant par run : l'identité de l'entrée chez le client (une même `seq` remplace). */
  seq: number;
  at: number;
  /** L'étape du run quand l'entrée est née (`specs`, `impl`, `review`, `fix`…). */
  step: string | null;
  kind: SessionEntryKind;
  /** Le texte de l'agent ; pour un outil, son intention ou ses arguments ; pour un signal, son code. */
  text: string;
  tool: string | null;
  status: SessionEntryStatus | null;
  /** La fin du résultat d'un outil terminé. */
  detail: string | null;
};

/** Les entrées gardées par run. */
export const SESSION_KEEP = 200;
/** Les runs dont le tampon est gardé (les plus récents). */
export const SESSION_RUNS = 32;
/** La longueur maximale du texte d'une entrée (la FIN est gardée : c'est ce qui s'écrit). */
export const SESSION_TEXT_MAX = 4000;
/** La longueur maximale de la fin d'un résultat d'outil. */
export const SESSION_DETAIL_MAX = 600;
/** L'intervalle minimal entre deux envois d'un même paragraphe qui s'allonge. */
export const SESSION_THROTTLE_MS = 500;
/** La durée pendant laquelle les secrets connus sont gardés avant d'être relus. */
const SECRETS_TTL_MS = 30_000;

const MASK = "••••";

/** Les formes de secrets reconnues sans les connaître : clés de fournisseurs, jetons GitHub, Slack, AWS, Bearer. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[\w-]{8,}/g,
  /\bsk-(?:or-|proj-)?[\w-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\bxox[abpr]-[\w-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(Bearer\s+)[\w.~+/-]{16,}=*/gi,
  /\b([\w-]*(?:api[_-]?key|token|secret|password|passwd)["']?\s*[=:]\s*["']?)[^\s"',;]{6,}/gi,
];

/**
 * Masque les secrets d'un texte : les valeurs connues (`known`, au moins 8 caractères)
 * et les formes reconnues. Une affectation garde son nom : `API_KEY=••••`.
 */
export function redact(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const value of known) if (value.length >= 8) out = out.split(value).join(MASK);
  for (const pattern of SECRET_PATTERNS)
    out = out.replace(pattern, (_match, prefix?: unknown) => `${typeof prefix === "string" ? prefix : ""}${MASK}`);
  return out;
}

/** La fin d'un texte, bornée à `max` caractères (précédée de `…` si coupée). */
function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
}

/** Le début d'un texte sur une ligne, borné à `max` caractères. */
function head(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

type Frame = Record<string, unknown>;

const record = (value: unknown): Frame | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Frame) : null;

/** Le texte et le raisonnement d'un message d'assistant, lus dans son contenu ; `null` s'il n'en a pas de lisible. */
function partsOf(message: unknown): { text: string; thinking: string } | null {
  const content = record(message)?.content;
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return null;
  let text = "";
  let thinking = "";
  for (const part of content) {
    const block = record(part);
    if (block?.type === "text" && typeof block.text === "string") text += block.text;
    if (block?.type === "thinking" && typeof block.thinking === "string") thinking += block.thinking;
  }
  return { text, thinking };
}

const isAssistant = (frame: Frame): boolean => {
  const role = record(frame.message)?.role;
  return role === undefined || role === "assistant";
};

/** Les arguments d'un outil en une ligne : le champ parlant s'il y en a un, sinon le JSON. */
function argsLine(args: unknown): string {
  const object = record(args);
  if (!object) return "";
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "name"]) {
    const value = object[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const json = JSON.stringify(object);
  return json === "{}" ? "" : json;
}

/** Le texte d'un résultat d'outil (`{ content: [{ type: "text", text }] }`, ou une chaîne). */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  const content = record(result)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = record(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

type Paragraph = { entry: SessionEntry; sentAt: number; sent: string };

type Feed = {
  seq: number;
  entries: SessionEntry[];
  /** Le message d'assistant en cours : son paragraphe et son raisonnement. */
  text: Paragraph | null;
  thinking: Paragraph | null;
  /** Les outils lancés et pas encore terminés, par `toolCallId`. */
  tools: Map<string, SessionEntry>;
  /** La dernière trame utile du runner (la veille des sessions muettes). */
  lastAt: number;
};

/** La consommation d'un message d'assistant, telle qu'omp la joint à `message_end`. */
export type SessionUsage = {
  provider: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** En dollars, `0` quand le fournisseur ne dit rien du prix. */
  cost: number;
};

/** Où le direct se garde au-delà de la mémoire du service : la base (sessions rejouables). */
export type SessionStore = {
  putSessionEntry(owner: string, entry: SessionEntry): void;
  /** Les `limit` entrées qui précèdent `before` (toutes si `null`), de la plus ancienne à la plus récente. */
  sessionEntries(owner: string, before: number | null, limit: number): SessionEntry[];
  lastSessionSeq(owner: string): number;
};

export type SessionFeedOptions = {
  /** Pousse une entrée nouvelle ou modifiée (l'événement éphémère `session`) au nom de son propriétaire. */
  publish: (owner: string, entry: SessionEntry) => void;
  now?: () => number;
  /** Les valeurs secrètes connues du service (clés des fournisseurs), masquées partout. */
  secrets?: () => readonly string[];
  store?: SessionStore;
  /** La consommation de chaque message d'assistant terminé. */
  onUsage?: (owner: string, step: string | null, usage: SessionUsage) => void;
};

/** Le propriétaire du direct d'un audit (celui d'un run est son id). */
export function auditOwner(auditId: string): string {
  return `audit:${auditId}`;
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** La consommation d'un message (`usage` de pi : input, output, cacheRead, cacheWrite, cost.total) ; `null` sans `usage`. */
export function usageOf(message: unknown): SessionUsage | null {
  const object = record(message);
  const usage = record(object?.usage);
  if (!object || !usage) return null;
  const cost = record(usage.cost);
  return {
    provider: typeof object.provider === "string" ? object.provider : null,
    model: typeof object.model === "string" ? object.model : null,
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
    cost: count(cost?.total ?? usage.cost),
  };
}

export class SessionFeeds {
  readonly #feeds = new Map<string, Feed>();
  readonly #publish: SessionFeedOptions["publish"];
  readonly #now: () => number;
  readonly #secrets: () => readonly string[];
  readonly #store: SessionStore | null;
  readonly #onUsage: SessionFeedOptions["onUsage"];
  #known: { at: number; values: readonly string[] } | null = null;

  constructor(options: SessionFeedOptions) {
    this.#publish = options.publish;
    this.#now = options.now ?? Date.now;
    this.#secrets = options.secrets ?? (() => []);
    this.#store = options.store ?? null;
    this.#onUsage = options.onUsage;
  }

  /** Les dernières entrées d'un propriétaire, de la plus ancienne à la plus récente. */
  snapshot(owner: string): SessionEntry[] {
    return this.page(owner).entries;
  }

  /**
   * Une page du direct : les `limit` entrées qui précèdent `before` (les dernières si
   * `null`), lues dans la base quand elle est là — une session finie se rejoue —, et
   * `more` s'il en reste de plus anciennes. Un paragraphe en cours d'écriture y est
   * dans sa version la plus fraîche.
   */
  page(owner: string, before: number | null = null, limit = SESSION_KEEP): { entries: SessionEntry[]; more: boolean } {
    const bounded = Math.max(1, Math.min(limit, 1000));
    const fresh = new Map((this.#feeds.get(owner)?.entries ?? []).map((entry) => [entry.seq, entry]));
    let entries: SessionEntry[];
    if (this.#store) {
      entries = this.#store.sessionEntries(owner, before, bounded + 1);
    } else {
      entries = [...fresh.values()].filter((entry) => before === null || entry.seq < before).slice(-(bounded + 1));
    }
    const more = entries.length > bounded;
    if (more) entries = entries.slice(1);
    return { entries: entries.map((entry) => ({ ...(fresh.get(entry.seq) ?? entry) })), more };
  }

  /** La dernière trame utile d'un propriétaire et l'outil en cours, s'il en a un ; `null` s'il n'a rien dit. */
  activity(owner: string): { at: number; tool: string | null } | null {
    const feed = this.#feeds.get(owner);
    if (!feed) return null;
    const running = [...feed.tools.values()].at(-1);
    return { at: feed.lastAt, tool: running ? (running.tool ?? "") : null };
  }

  /** Une trame RPC du runner de `owner`, à l'étape `step` ; les trames sans intérêt pour le direct sont ignorées. */
  frame(owner: string, step: string | null, frame: Frame): void {
    const type = frame.type;
    if (type === "message_start" && isAssistant(frame)) {
      const feed = this.#feed(owner);
      feed.lastAt = this.#now();
      feed.text = null;
      feed.thinking = null;
      return;
    }
    if (type === "message_update" && isAssistant(frame)) {
      this.#update(owner, step, frame, false);
      return;
    }
    if (type === "message_end" && isAssistant(frame)) {
      this.#update(owner, step, frame, true);
      const feed = this.#feed(owner);
      // Un message de fin sans contenu lisible : les deltas retenus par l'intervalle partent quand même.
      this.#settle(owner, feed);
      feed.text = null;
      feed.thinking = null;
      const usage = usageOf(frame.message);
      if (usage && this.#onUsage) {
        try {
          this.#onUsage(owner, step, usage);
        } catch {
          /* un relevé qui échoue n'arrête pas le direct */
        }
      }
      return;
    }
    if (type === "tool_execution_start") {
      const feed = this.#feed(owner);
      this.#settle(owner, feed);
      const intent = typeof frame.intent === "string" && frame.intent.trim() !== "" ? frame.intent : null;
      const entry = this.#add(owner, step, "tool", {
        text: head(this.#clean(intent ?? argsLine(frame.args)), 240),
        tool: typeof frame.toolName === "string" ? frame.toolName : null,
        status: "running",
      });
      const id = typeof frame.toolCallId === "string" ? frame.toolCallId : null;
      if (id !== null) feed.tools.set(id, entry);
      return;
    }
    if (type === "tool_execution_end") {
      const feed = this.#feeds.get(owner);
      const id = typeof frame.toolCallId === "string" ? frame.toolCallId : null;
      const entry = id !== null ? feed?.tools.get(id) : undefined;
      if (!feed || !entry || id === null) return;
      feed.lastAt = this.#now();
      feed.tools.delete(id);
      entry.status = frame.isError === true ? "error" : "ok";
      const detail = this.#clean(tail(resultText(frame.result), SESSION_DETAIL_MAX + 256)).trim();
      entry.detail = detail === "" ? null : tail(detail, SESSION_DETAIL_MAX);
      this.#emit(owner, entry);
      return;
    }
    if (type === "auto_compaction_start") {
      this.#add(owner, step, "notice", { text: "compaction" });
      return;
    }
    if (type === "auto_retry_start") this.#add(owner, step, "notice", { text: "retry" });
  }

  /** Le message d'assistant qui s'écrit : son texte (et son raisonnement) depuis le contenu, sinon les deltas. */
  #update(owner: string, step: string | null, frame: Frame, final: boolean): void {
    const feed = this.#feed(owner);
    feed.lastAt = this.#now();
    const parts = partsOf(frame.message);
    const event = record(frame.assistantMessageEvent);
    const delta = typeof event?.delta === "string" ? event.delta : "";
    const text = parts?.text ?? (event?.type === "text_delta" ? (feed.text?.entry.text ?? "") + delta : null);
    const thinking =
      parts?.thinking ?? (event?.type === "thinking_delta" ? (feed.thinking?.entry.text ?? "") + delta : null);
    if (thinking !== null && thinking.trim() !== "")
      feed.thinking = this.#write(owner, step, feed.thinking, "thinking", thinking, final);
    if (text !== null && text.trim() !== "") feed.text = this.#write(owner, step, feed.text, "text", text, final);
  }

  /** Écrit le texte d'un paragraphe (créé au premier mot) et le pousse si l'envoi est dû. */
  #write(
    owner: string,
    step: string | null,
    paragraph: Paragraph | null,
    kind: "text" | "thinking",
    raw: string,
    force: boolean,
  ): Paragraph {
    // Le masque passe sur la fin seulement, avec une marge : un secret à cheval sur la coupe tombe hors du texte gardé.
    const text = tail(this.#clean(tail(raw, SESSION_TEXT_MAX + 256)), SESSION_TEXT_MAX);
    if (!paragraph) {
      const entry = this.#add(owner, step, kind, { text });
      return { entry, sentAt: this.#now(), sent: text };
    }
    paragraph.entry.text = text;
    const now = this.#now();
    if (text !== paragraph.sent && (force || now - paragraph.sentAt >= SESSION_THROTTLE_MS)) {
      paragraph.sentAt = now;
      paragraph.sent = text;
      this.#emit(owner, paragraph.entry);
    }
    return paragraph;
  }

  /** Pousse la dernière version des paragraphes en cours avant qu'une autre entrée ne les suive. */
  #settle(owner: string, feed: Feed): void {
    for (const paragraph of [feed.thinking, feed.text]) {
      if (paragraph && paragraph.entry.text !== paragraph.sent) {
        paragraph.sent = paragraph.entry.text;
        paragraph.sentAt = this.#now();
        this.#emit(owner, paragraph.entry);
      }
    }
  }

  #add(
    owner: string,
    step: string | null,
    kind: SessionEntryKind,
    fields: { text: string; tool?: string | null; status?: SessionEntryStatus | null },
  ): SessionEntry {
    const feed = this.#feed(owner);
    feed.lastAt = this.#now();
    const entry: SessionEntry = {
      seq: ++feed.seq,
      at: this.#now(),
      step,
      kind,
      text: fields.text,
      tool: fields.tool ?? null,
      status: fields.status ?? null,
      detail: null,
    };
    feed.entries.push(entry);
    if (feed.entries.length > SESSION_KEEP) feed.entries.splice(0, feed.entries.length - SESSION_KEEP);
    this.#emit(owner, entry);
    return entry;
  }

  /** Une entrée nouvelle ou modifiée : écrite dans la base (si elle est là), puis poussée. */
  #emit(owner: string, entry: SessionEntry): void {
    if (this.#store) {
      try {
        this.#store.putSessionEntry(owner, entry);
      } catch {
        /* une base occupée ne prive pas le direct de l'entrée */
      }
    }
    this.#publish(owner, { ...entry });
  }

  /** Le tampon d'un propriétaire, créé au besoin (sa `seq` reprend celle de la base) ; le plus ancien part au-delà de SESSION_RUNS. */
  #feed(owner: string): Feed {
    let feed = this.#feeds.get(owner);
    if (feed) return feed;
    let seq = 0;
    try {
      seq = this.#store?.lastSessionSeq(owner) ?? 0;
    } catch {
      seq = 0;
    }
    feed = { seq, entries: [], text: null, thinking: null, tools: new Map(), lastAt: this.#now() };
    this.#feeds.set(owner, feed);
    while (this.#feeds.size > SESSION_RUNS) {
      const oldest = this.#feeds.keys().next().value;
      if (oldest === undefined) break;
      this.#feeds.delete(oldest);
    }
    return feed;
  }

  #clean(text: string): string {
    const now = this.#now();
    if (!this.#known || now - this.#known.at >= SECRETS_TTL_MS) {
      let values: readonly string[] = [];
      try {
        values = this.#secrets();
      } catch {
        /* des clés illisibles : les formes reconnues restent masquées */
      }
      this.#known = { at: now, values };
    }
    return redact(text, this.#known.values);
  }
}
