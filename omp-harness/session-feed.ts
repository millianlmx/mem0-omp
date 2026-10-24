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
// Les dernières entrées de chaque run restent en mémoire (SESSION_KEEP, pour les
// SESSION_RUNS derniers runs) : une app qui ouvre le direct en cours de route lit
// d'abord ce tampon (`GET /v1/runs/{id}/session`), puis suit le flux. Rien n'est
// écrit sur disque : un redémarrage du service repart d'un tampon vide.
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

type RunFeed = {
  seq: number;
  entries: SessionEntry[];
  /** Le message d'assistant en cours : son paragraphe et son raisonnement. */
  text: Paragraph | null;
  thinking: Paragraph | null;
  /** Les outils lancés et pas encore terminés, par `toolCallId`. */
  tools: Map<string, SessionEntry>;
};

export type SessionFeedOptions = {
  /** Pousse une entrée nouvelle ou modifiée (l'événement éphémère `session`). */
  publish: (runId: string, entry: SessionEntry) => void;
  now?: () => number;
  /** Les valeurs secrètes connues du service (clés des fournisseurs), masquées partout. */
  secrets?: () => readonly string[];
};

export class SessionFeeds {
  readonly #runs = new Map<string, RunFeed>();
  readonly #publish: SessionFeedOptions["publish"];
  readonly #now: () => number;
  readonly #secrets: () => readonly string[];
  #known: { at: number; values: readonly string[] } | null = null;

  constructor(options: SessionFeedOptions) {
    this.#publish = options.publish;
    this.#now = options.now ?? Date.now;
    this.#secrets = options.secrets ?? (() => []);
  }

  /** Les entrées gardées d'un run, de la plus ancienne à la plus récente. */
  snapshot(runId: string): SessionEntry[] {
    return (this.#runs.get(runId)?.entries ?? []).map((entry) => ({ ...entry }));
  }

  /** Une trame RPC du runner de `runId`, à l'étape `step` ; les trames sans intérêt pour le direct sont ignorées. */
  frame(runId: string, step: string | null, frame: Frame): void {
    const type = frame.type;
    if (type === "message_start" && isAssistant(frame)) {
      const feed = this.#feed(runId);
      feed.text = null;
      feed.thinking = null;
      return;
    }
    if (type === "message_update" && isAssistant(frame)) {
      this.#update(runId, step, frame, false);
      return;
    }
    if (type === "message_end" && isAssistant(frame)) {
      this.#update(runId, step, frame, true);
      const feed = this.#feed(runId);
      // Un message de fin sans contenu lisible : les deltas retenus par l'intervalle partent quand même.
      this.#settle(runId, feed);
      feed.text = null;
      feed.thinking = null;
      return;
    }
    if (type === "tool_execution_start") {
      const feed = this.#feed(runId);
      this.#settle(runId, feed);
      const intent = typeof frame.intent === "string" && frame.intent.trim() !== "" ? frame.intent : null;
      const entry = this.#add(runId, step, "tool", {
        text: head(this.#clean(intent ?? argsLine(frame.args)), 240),
        tool: typeof frame.toolName === "string" ? frame.toolName : null,
        status: "running",
      });
      const id = typeof frame.toolCallId === "string" ? frame.toolCallId : null;
      if (id !== null) feed.tools.set(id, entry);
      return;
    }
    if (type === "tool_execution_end") {
      const feed = this.#runs.get(runId);
      const id = typeof frame.toolCallId === "string" ? frame.toolCallId : null;
      const entry = id !== null ? feed?.tools.get(id) : undefined;
      if (!feed || !entry || id === null) return;
      feed.tools.delete(id);
      entry.status = frame.isError === true ? "error" : "ok";
      const detail = this.#clean(tail(resultText(frame.result), SESSION_DETAIL_MAX + 256)).trim();
      entry.detail = detail === "" ? null : tail(detail, SESSION_DETAIL_MAX);
      this.#publish(runId, { ...entry });
      return;
    }
    if (type === "auto_compaction_start") {
      this.#add(runId, step, "notice", { text: "compaction" });
      return;
    }
    if (type === "auto_retry_start") this.#add(runId, step, "notice", { text: "retry" });
  }

  /** Le message d'assistant qui s'écrit : son texte (et son raisonnement) depuis le contenu, sinon les deltas. */
  #update(runId: string, step: string | null, frame: Frame, final: boolean): void {
    const feed = this.#feed(runId);
    const parts = partsOf(frame.message);
    const event = record(frame.assistantMessageEvent);
    const delta = typeof event?.delta === "string" ? event.delta : "";
    const text = parts?.text ?? (event?.type === "text_delta" ? (feed.text?.entry.text ?? "") + delta : null);
    const thinking =
      parts?.thinking ?? (event?.type === "thinking_delta" ? (feed.thinking?.entry.text ?? "") + delta : null);
    if (thinking !== null && thinking.trim() !== "")
      feed.thinking = this.#write(runId, step, feed.thinking, "thinking", thinking, final);
    if (text !== null && text.trim() !== "") feed.text = this.#write(runId, step, feed.text, "text", text, final);
  }

  /** Écrit le texte d'un paragraphe (créé au premier mot) et le pousse si l'envoi est dû. */
  #write(
    runId: string,
    step: string | null,
    paragraph: Paragraph | null,
    kind: "text" | "thinking",
    raw: string,
    force: boolean,
  ): Paragraph {
    // Le masque passe sur la fin seulement, avec une marge : un secret à cheval sur la coupe tombe hors du texte gardé.
    const text = tail(this.#clean(tail(raw, SESSION_TEXT_MAX + 256)), SESSION_TEXT_MAX);
    if (!paragraph) {
      const entry = this.#add(runId, step, kind, { text });
      return { entry, sentAt: this.#now(), sent: text };
    }
    paragraph.entry.text = text;
    const now = this.#now();
    if (text !== paragraph.sent && (force || now - paragraph.sentAt >= SESSION_THROTTLE_MS)) {
      paragraph.sentAt = now;
      paragraph.sent = text;
      this.#publish(runId, { ...paragraph.entry });
    }
    return paragraph;
  }

  /** Pousse la dernière version des paragraphes en cours avant qu'une autre entrée ne les suive. */
  #settle(runId: string, feed: RunFeed): void {
    for (const paragraph of [feed.thinking, feed.text]) {
      if (paragraph && paragraph.entry.text !== paragraph.sent) {
        paragraph.sent = paragraph.entry.text;
        paragraph.sentAt = this.#now();
        this.#publish(runId, { ...paragraph.entry });
      }
    }
  }

  #add(
    runId: string,
    step: string | null,
    kind: SessionEntryKind,
    fields: { text: string; tool?: string | null; status?: SessionEntryStatus | null },
  ): SessionEntry {
    const feed = this.#feed(runId);
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
    this.#publish(runId, { ...entry });
    return entry;
  }

  /** Le tampon d'un run, créé au besoin ; le plus ancien part au-delà de SESSION_RUNS. */
  #feed(runId: string): RunFeed {
    let feed = this.#runs.get(runId);
    if (feed) return feed;
    feed = { seq: 0, entries: [], text: null, thinking: null, tools: new Map() };
    this.#runs.set(runId, feed);
    while (this.#runs.size > SESSION_RUNS) {
      const oldest = this.#runs.keys().next().value;
      if (oldest === undefined) break;
      this.#runs.delete(oldest);
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
