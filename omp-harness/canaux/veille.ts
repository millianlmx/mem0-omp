// La veille proactive du poste : ce que le job `poste-veille` (workstation-agent.ts) propose à
// l'utilisateur, tiré des contenus que la lecture des canaux a gardés (db/channel-contents.ts)
// et du graphe des personnes (canaux/personnes.ts). Elle ne produit QUE ce qui demande
// l'utilisateur, dans la file « À traiter » (db/watch-items.ts) :
// - une RÉPONSE PROPOSÉE à un message d'un collègue, selon son niveau de délégation : `jamais`
//   aucune ; `brouillon` sur tout sujet ; `réponse` marquée « prête » sur un sujet listé de la
//   personne, brouillon ordinaire hors liste. Un mail reçoit un brouillon Gmail par API dans son
//   fil (`POST users/me/drafts`, entrée exacte de la liste blanche) ; un message Slack un
//   brouillon interne (le texte de l'élément) : rien n'est écrit dans Slack ;
// - une RELANCE d'un fil Gmail dont le dernier message est de l'utilisateur à autrui, sans
//   réponse depuis `followUpDays` jours ouvrés, une seule par silence ;
// - la PRÉPARATION d'une réunion à participants, au premier passage où « début − 15 min » est
//   atteint et avant le début, une fois par événement : participants et graphe, fils récents
//   avec eux, transcripts des meetings du poste tenus au MÊME lien (au plus 3), jamais par titre ;
// - le BRIEF DU MATIN, au premier passage du jour dans les heures ouvrées s'il y a à dire.
//
// Le passage (`due`) : toutes les `workstation.watch.intervalMinutes` minutes, aux heures
// ouvrées (`days`, `start`–`end`, heure murale de `schedules.timezone`), quelle que soit
// l'autonomie ; jamais en pause (arrêt d'urgence compris) ni poste coupé. Dans les 15 minutes
// avant l'ouverture, un passage ne prépare que les réunions des 15 premières minutes de la plage.
// Le TRI est fait ici, sans modèle : sans rien de dû, aucun runner n'est lancé et rien n'est
// produit. Un canal non connecté, à reconnecter ou bloqué est ignoré ; un canal en erreur reste lu.
//
// Gardes tenues par le serveur, jamais par le prompt : chaque outil ne vise qu'une référence de
// CE passage, le niveau de délégation est relu à l'écriture, aucun outil n'envoie ni n'approuve.
// Tout contenu de canal passe par `untrusted()` ; rien de ce qui est lu ne va dans un log, un
// événement (`workstation_watch` ne porte que `{id, kind, state, ready}`), une erreur levée ni
// la mémoire d'un dépôt.
//
// Contrat pour « Validation et envoi des réponses proposées » : `list`/`get` rendent la vue
// (`WatchItemView`) ; un élément `reply`/`followup` Gmail porte `draft.id` (le brouillon à
// mettre à jour ou supprimer), un élément Slack `draft.kind: "internal"` ; `context.to` porte
// les destinataires du brouillon ; `store.updateWatchItem` change l'état sous révision.
import type { HarnessConfig, WeekDay } from "../config.ts";
import { WEEK_DAYS, minutesOf } from "../config.ts";
import { wallClock } from "../cron.ts";
import type { ChannelEventRow, ChannelMessageRow, PersonRow, Store, WatchItemRow, WatchKind } from "../db.ts";
import { emailKey, slackKey } from "../db.ts";
import { HarnessError } from "../errors.ts";
import type { EventType } from "../events.ts";
import { newId } from "../ids.ts";
import type { HostToolResult } from "../rpc.ts";
import type { Workstation } from "../workstation.ts";
import { untrusted } from "../workstation-guards.ts";
import type { ChannelId, Channels } from "./channels.ts";
import { isBulk, parseAddresses } from "./personnes.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Les passages qui préparent les réunions : de « début − 15 min » au début. */
export const PREP_LEAD_MS = 15 * MINUTE;
/** Les fils récents avec les participants d'une réunion : sur 30 jours, 5 au plus. */
const THREADS_WINDOW_MS = 30 * DAY;
const THREADS_SHOWN = 5;
const TRANSCRIPTS_SHOWN = 3;
const MESSAGE_TEXT_MAX = 4000;
const SNIPPET_MAX = 300;
const TRANSCRIPT_MAX = 3000;
/** Le texte proposé (réponse, relance, préparation, brief). */
export const WATCH_TEXT_MAX = 20_000;
const BATCH = 200;
const OFFERED_MAX = 500;
const DRAFT_RETRIES = 20;
const GMAIL_DRAFTS = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
/** Les curseurs de la veille, dans `channel_cursors`. */
const CURSOR = {
  messages: "watch.messages",
  lastPass: "watch.lastPass",
  briefDay: "watch.briefDay",
  offered: "watch.offered",
} as const;
/** Les états d'un canal que la veille lit (les autres, `Channels.request` les refuse). */
const READABLE = new Set(["connected", "error"]);

export type WatchMode = "full" | "prep";

/** Un message retenu par le tri : il demande l'utilisateur et sa personne n'est pas au niveau `jamais`. */
type Retained = { message: ChannelMessageRow; person: PersonRow };
type FollowUp = { message: ChannelMessageRow; to: string[] };
type Prep = { event: ChannelEventRow; body: string; context: Record<string, unknown> };

/** Un passage dû : ce que le runner reçoit, et ce que ses outils ont le droit de viser. */
export type WatchPlan = {
  mode: WatchMode;
  day: string;
  /** Le `seq` du dernier message trié (curseur avancé à la fin du passage). */
  lastSeq: number;
  messages: Retained[];
  followUps: FollowUp[];
  preps: Prep[];
  /** Le brief demandé à ce passage (le texte de la section), `null` sinon. */
  brief: string | null;
  /** Le premier passage plein du jour : le brief du jour est tranché à sa fin. */
  firstOfDay: boolean;
};

/** Un élément de « À traiter » tel que l'API le rend (au propriétaire seul). */
export type WatchItemView = {
  id: string;
  kind: WatchKind;
  state: string;
  ready: boolean;
  channel: WatchItemRow["channel"];
  messageId: string | null;
  eventId: string | null;
  personId: string | null;
  topic: string | null;
  subject: string | null;
  text: string;
  context: Record<string, unknown>;
  /** Le brouillon : Gmail (créé par API, `id` null tant qu'il ne l'est pas) ou interne (Slack). */
  draft: { kind: "gmail"; id: string | null; error: string | null } | { kind: "internal" } | null;
  rev: number;
  createdAt: number;
  updatedAt: number;
};

export type WatchDeps = {
  config: HarnessConfig;
  store: Store;
  workstation: Workstation;
  channels: Channels;
  event: (type: EventType, runId: string | null, payload?: Record<string, unknown>, repo?: string | null) => void;
};

export function watchItemView(row: WatchItemRow): WatchItemView {
  const draft: WatchItemView["draft"] =
    row.kind !== "reply" && row.kind !== "followup"
      ? null
      : row.channel === "gmail"
        ? { kind: "gmail", id: row.draftId, error: row.draftError }
        : { kind: "internal" };
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    ready: row.ready,
    channel: row.channel,
    messageId: row.messageId,
    eventId: row.eventId,
    personId: row.personId,
    topic: row.topic,
    subject: row.subject,
    text: row.text,
    context: row.context,
    draft,
    rev: row.rev,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Un lien de visioconférence réduit à l'origine et au chemin (hôte sans casse), comme `Meeting.url`. */
export function meetingKey(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/** L'heure murale du fuseau : le jour (`AAAA-MM-JJ`), le jour de la semaine et la minute. */
function wallOf(instant: number, timeZone: string): { wall: number; day: string; weekday: WeekDay; minute: number } {
  const wall = wallClock(instant, timeZone);
  const date = new Date(wall);
  return {
    wall,
    day: date.toISOString().slice(0, 10),
    weekday: WEEK_DAYS[date.getUTCDay()] as WeekDay,
    minute: date.getUTCHours() * 60 + date.getUTCMinutes(),
  };
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const headerSafe = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

/** Un en-tête MIME : tel quel en ASCII, sinon encodé (RFC 2047). */
function mimeHeader(text: string): string {
  const flat = headerSafe(text);
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

/** Le message brut (RFC 2822, base64url) d'un brouillon de réponse dans le fil d'origine. */
export function draftRaw(input: {
  to: readonly string[];
  subject: string | null;
  messageId: string | null;
  references: string | null;
  text: string;
}): string {
  const subject = input.subject ?? "";
  const lines = [
    `To: ${headerSafe(input.to.join(", "))}`,
    `Subject: ${mimeHeader(/^re\s*:/i.test(subject) ? subject : `Re: ${subject}`)}`,
  ];
  if (input.messageId !== null) {
    lines.push(`In-Reply-To: ${headerSafe(input.messageId)}`);
    lines.push(`References: ${headerSafe([input.references ?? "", input.messageId].join(" "))}`);
  }
  lines.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "");
  const body = (
    Buffer.from(input.text, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
  return Buffer.from(`${lines.join("\r\n")}\r\n${body}\r\n`, "utf8").toString("base64url");
}

export class Watch {
  readonly #deps: WatchDeps;

  constructor(deps: WatchDeps) {
    this.#deps = deps;
  }

  // -- lecture (API) --------------------------------------------------------------------------

  list(states: readonly string[], limit: number): { items: WatchItemView[] } {
    return { items: this.#deps.store.listWatchItems({ states, limit }).map(watchItemView) };
  }

  get(id: string): { item: WatchItemView } {
    const row = this.#deps.store.getWatchItem(id);
    if (row === null) throw new HarnessError(404, `élément de veille inconnu : ${id}`);
    return { item: watchItemView(row) };
  }

  // -- le passage -----------------------------------------------------------------------------

  /** Le mode de passage à `now` : heures ouvrées, 15 minutes avant l'ouverture, ou aucun. */
  modeAt(now: number): { mode: WatchMode; day: string; openAt: number } | null {
    const { watch } = this.#deps.config.workstation;
    const at = wallOf(now, this.#deps.config.schedules.timezone);
    if (!watch.days.includes(at.weekday)) return null;
    const start = minutesOf(watch.start) as number;
    const end = minutesOf(watch.end) as number;
    const openAt = now + (Math.floor(at.wall / DAY) * DAY + start * MINUTE - at.wall);
    if (at.minute >= start && at.minute < end) return { mode: "full", day: at.day, openAt };
    if (at.minute >= start - PREP_LEAD_MS / MINUTE && at.minute < start) return { mode: "prep", day: at.day, openAt };
    return null;
  }

  /**
   * Le passage de `now`, s'il est dû et qu'il y a quelque chose à proposer ; sinon `null` (un
   * passage sans rien de dû avance ses curseurs ici même, sans runner). Le brouillon Gmail d'un
   * élément qui n'a pas pu être créé est retenté à chaque passage.
   */
  async due(now: number): Promise<WatchPlan | null> {
    const { store, workstation, config } = this.#deps;
    if (!workstation.enabled || workstation.settings().paused) return null;
    const last = store.getChannelCursor<number>(CURSOR.lastPass) ?? 0;
    if (now - last < config.workstation.watch.intervalMinutes * MINUTE) return null;
    const when = this.modeAt(now);
    if (when === null) return null;
    store.setChannelCursor(CURSOR.lastPass, now, now);
    const readable = this.#readable();
    if (readable.has("gmail")) await this.retryDrafts(now);
    const offered = new Set(store.getChannelCursor<string[]>(CURSOR.offered) ?? []);
    const self = this.#self();
    const preps = readable.has("calendar") ? this.#preps(now, when, self, offered) : [];
    const lastSeen = store.getChannelCursor<number>(CURSOR.messages) ?? 0;
    const plan: WatchPlan = {
      mode: when.mode,
      day: when.day,
      lastSeq: lastSeen,
      messages: [],
      followUps: [],
      preps,
      brief: null,
      firstOfDay: false,
    };
    if (when.mode === "full") {
      for (const message of store.listChannelMessages({ afterSeq: lastSeen, limit: BATCH })) {
        plan.lastSeq = message.seq;
        if (!readable.has(message.channel)) continue;
        const person = this.#retain(message, self);
        if (person !== null) plan.messages.push({ message, person });
      }
      if (readable.has("gmail")) plan.followUps = this.#followUps(now, self, offered);
      plan.firstOfDay = store.getChannelCursor<string>(CURSOR.briefDay) !== when.day;
      if (plan.firstOfDay) plan.brief = this.#brief(now, when.day, plan, readable.has("calendar"), self);
    }
    if (plan.messages.length + plan.followUps.length + plan.preps.length === 0 && plan.brief === null) {
      this.finish(plan);
      return null;
    }
    return plan;
  }

  /** Le passage a tourné jusqu'au bout (ou n'avait rien à faire) : ses curseurs avancent. */
  finish(plan: WatchPlan): void {
    const { store } = this.#deps;
    const at = Date.now();
    if (plan.mode === "full") store.setChannelCursor(CURSOR.messages, plan.lastSeq, at);
    if (plan.firstOfDay) store.setChannelCursor(CURSOR.briefDay, plan.day, at);
    const keys = [
      ...plan.followUps.map((f) => `followup:${f.message.id}`),
      ...plan.preps.map((p) => `prep:${p.event.id}`),
    ];
    if (keys.length > 0) {
      const offered = [...(store.getChannelCursor<string[]>(CURSOR.offered) ?? []), ...keys];
      store.setChannelCursor(CURSOR.offered, offered.slice(-OFFERED_MAX), at);
    }
  }

  /** Les sections du prompt : chaque contenu de canal entre délimiteurs de contenu non fiable. */
  promptOf(plan: WatchPlan): {
    messages: string | null;
    followUps: string | null;
    preps: string | null;
    brief: string | null;
  } {
    const messages = plan.messages.map(({ message, person }) => {
      const level =
        person.delegation === "réponse"
          ? `niveau réponse, sujets listés : ${person.topics.length > 0 ? person.topics.map((t) => `« ${t} »`).join(", ") : "aucun"}`
          : "niveau brouillon";
      return `### ref ${message.id} (${message.channel}, ${level})\n${untrusted(
        message.channel === "gmail" ? "mail reçu" : "message Slack reçu",
        this.#messageText(message, person),
      )}`;
    });
    const followUps = plan.followUps.map(
      ({ message }) =>
        `### ref ${message.id} (mail de l'utilisateur sans réponse)\n${untrusted("mail envoyé", this.#messageText(message, null))}`,
    );
    const preps = plan.preps.map((prep) => `### ref ${prep.event.id}\n${prep.body}`);
    const join = (parts: string[]): string | null => (parts.length > 0 ? parts.join("\n\n") : null);
    return { messages: join(messages), followUps: join(followUps), preps: join(preps), brief: plan.brief };
  }

  // -- les outils du passage --------------------------------------------------------------------

  /** Un outil de `poste-veille` : chacun ne vise qu'une référence de CE passage. */
  async tool(plan: WatchPlan, name: string, args: Record<string, unknown>): Promise<HostToolResult> {
    try {
      switch (name) {
        case "workstation_watch_reply":
          return await this.#reply(plan, args);
        case "workstation_watch_followup":
          return await this.#followUp(plan, args);
        case "workstation_watch_prep":
          return this.#prep(plan, args);
        case "workstation_watch_brief":
          return this.#briefTool(plan, args);
        default:
          return { text: `outil inconnu : ${name}`, isError: true };
      }
    } catch (err) {
      return { text: err instanceof HarnessError ? err.message : "erreur interne", isError: true };
    }
  }

  async #reply(plan: WatchPlan, args: Record<string, unknown>): Promise<HostToolResult> {
    const ref = refOf(args.messageId, "messageId");
    const text = textOf(args.text);
    const retained = plan.messages.find((r) => r.message.id === ref);
    if (!retained)
      return { text: "messageId : référence hors de la section « Messages » de ce passage", isError: true };
    // Le niveau est relu à l'écriture : l'humain a pu le changer pendant le passage.
    const person = this.#deps.store.getPerson(retained.person.id);
    if (person === null || person.delegation === "jamais")
      return { text: "cette personne est au niveau `jamais` : aucune réponse proposée", isError: true };
    const asked = typeof args.topic === "string" ? args.topic.trim().toLowerCase() : "";
    const topic =
      person.delegation === "réponse" && asked !== ""
        ? (person.topics.find((t) => t.trim().toLowerCase() === asked) ?? null)
        : null;
    const { message } = retained;
    const to = message.channel === "gmail" ? parseAddresses(message.headers.From).map((a) => a.email) : [];
    const item = this.#insert({
      key: `reply:${message.id}`,
      kind: "reply",
      ready: topic !== null,
      channel: message.channel,
      messageId: message.id,
      eventId: null,
      personId: person.id,
      topic,
      subject: message.subject,
      text,
      context: { to, threadId: message.threadId, conversation: message.conversation },
    });
    if (item === null) return { text: "une réponse est déjà proposée pour ce message." };
    if (item.channel === "gmail") await this.#draft(item, Date.now());
    return {
      text: `réponse proposée${item.ready ? " (prête)" : ""} : elle attend la validation de l'utilisateur. Rien n'est parti.`,
    };
  }

  async #followUp(plan: WatchPlan, args: Record<string, unknown>): Promise<HostToolResult> {
    const ref = refOf(args.messageId, "messageId");
    const text = textOf(args.text);
    const due = plan.followUps.find((f) => f.message.id === ref);
    if (!due)
      return { text: "messageId : référence hors de la section « Relances dues » de ce passage", isError: true };
    const item = this.#insert({
      key: `followup:${due.message.id}`,
      kind: "followup",
      ready: false,
      channel: "gmail",
      messageId: due.message.id,
      eventId: null,
      personId: null,
      topic: null,
      subject: due.message.subject,
      text,
      context: { to: due.to, threadId: due.message.threadId },
    });
    if (item === null) return { text: "une relance est déjà proposée pour ce fil." };
    await this.#draft(item, Date.now());
    return { text: "relance proposée : elle attend la validation de l'utilisateur. Rien n'est parti." };
  }

  #prep(plan: WatchPlan, args: Record<string, unknown>): HostToolResult {
    const ref = refOf(args.eventId, "eventId");
    const text = textOf(args.text);
    const prep = plan.preps.find((p) => p.event.id === ref);
    if (!prep) return { text: "eventId : référence hors de la section « Réunions à préparer »", isError: true };
    const item = this.#insert({
      key: `prep:${prep.event.id}`,
      kind: "prep",
      ready: false,
      channel: "calendar",
      messageId: null,
      eventId: prep.event.id,
      personId: null,
      topic: null,
      subject: prep.event.summary,
      text,
      context: { ...prep.context, startAt: prep.event.startAt, meetUrl: prep.event.meetUrl },
    });
    return { text: item === null ? "cette réunion est déjà préparée." : "préparation enregistrée." };
  }

  #briefTool(plan: WatchPlan, args: Record<string, unknown>): HostToolResult {
    if (plan.brief === null) return { text: "aucun brief n'est demandé à ce passage", isError: true };
    const text = textOf(args.text);
    const item = this.#insert({
      key: `brief:${plan.day}`,
      kind: "brief",
      ready: false,
      channel: null,
      messageId: null,
      eventId: null,
      personId: null,
      topic: null,
      subject: null,
      text,
      context: { day: plan.day },
    });
    return { text: item === null ? "le brief du jour est déjà rendu." : "brief enregistré." };
  }

  #insert(input: Omit<Parameters<Store["insertWatchItem"]>[0], "id" | "at">): WatchItemRow | null {
    const item = this.#deps.store.insertWatchItem({ ...input, id: newId("wv"), at: Date.now() });
    if (item !== null) this.#emit(item);
    return item;
  }

  #emit(item: WatchItemRow): void {
    this.#deps.event(
      "workstation_watch",
      null,
      { id: item.id, kind: item.kind, state: item.state, ready: item.ready },
      null,
    );
  }

  // -- brouillons Gmail -------------------------------------------------------------------------

  /** Retente les brouillons Gmail que la création n'a pas pu faire (limite de débit, coupure). */
  async retryDrafts(now: number): Promise<void> {
    for (const item of this.#deps.store.watchItemsWithoutDraft(DRAFT_RETRIES)) await this.#draft(item, now);
  }

  /** Crée le brouillon Gmail d'un élément dans le fil d'origine ; l'échec n'écrit qu'un code. */
  async #draft(item: WatchItemRow, now: number): Promise<void> {
    const { store, channels } = this.#deps;
    const message = item.messageId === null ? null : store.getChannelMessage(item.messageId);
    if (message === null) {
      store.setWatchDraft(item.id, { draftId: null, draftError: "message_purged" }, now);
      return;
    }
    const to = Array.isArray(item.context.to) ? item.context.to.filter((t): t is string => typeof t === "string") : [];
    let draftId: string | null = null;
    let draftError: string | null = null;
    try {
      const reply = await channels.request("gmail", {
        method: "POST",
        url: GMAIL_DRAFTS,
        json: {
          message: {
            raw: draftRaw({
              to,
              subject: message.subject,
              messageId: message.headers["Message-ID"] ?? null,
              references: message.headers.References ?? null,
              text: item.text,
            }),
            ...(message.threadId !== null ? { threadId: message.threadId } : {}),
          },
        },
      });
      const id = reply !== null && typeof reply === "object" && "id" in reply ? reply.id : undefined;
      if (typeof id === "string" && id !== "") draftId = id;
      else draftError = "draft_without_id";
    } catch (err) {
      draftError = err instanceof Error ? err.name : "unknown";
    }
    const updated = store.setWatchDraft(item.id, { draftId, draftError }, now);
    if (updated !== null && draftId !== null) this.#emit(updated);
  }

  // -- le tri (sans modèle) -------------------------------------------------------------------

  /** Les canaux que la veille lit : connectés ou en erreur (un canal en erreur reste lu). */
  #readable(): Set<ChannelId> {
    return new Set(
      this.#deps.channels
        .view(false)
        .channels.filter((c) => READABLE.has(c.state))
        .map((c) => c.id),
    );
  }

  /** Les identités de l'utilisateur : réglage du poste, comptes des canaux, identifiant Slack. */
  #self(): { emails: Set<string>; slack: string | null } {
    const { store, workstation, channels } = this.#deps;
    const emails = new Set(
      [
        ...workstation.settings().selfIdentities,
        ...channels
          .view(false)
          .channels.map((c) => c.account)
          .filter((a): a is string => a !== null),
      ].map((s) => s.trim().toLowerCase()),
    );
    return { emails, slack: store.getChannelCursor<{ userId: string }>("slack.self")?.userId ?? null };
  }

  #fromSelf(message: ChannelMessageRow, self: { emails: Set<string>; slack: string | null }): boolean {
    if (message.channel === "slack") return message.author !== null && message.author === self.slack;
    if (message.labels.includes("SENT")) return true;
    return parseAddresses(message.headers.From).some((a) => self.emails.has(a.email));
  }

  /**
   * La personne d'un message qui demande l'utilisateur, ou `null` : message de l'utilisateur,
   * personne inconnue ou au niveau `jamais`, mail où il n'est pas en To, message automatique,
   * bot Slack, canal suivi sans mention, message auquel il a déjà répondu dans le fil, ou déjà
   * proposé.
   */
  #retain(message: ChannelMessageRow, self: { emails: Set<string>; slack: string | null }): PersonRow | null {
    const { store } = this.#deps;
    if (this.#fromSelf(message, self)) return null;
    let personId: string | null = null;
    if (message.channel === "gmail") {
      if (isBulk(message.headers)) return null;
      if (!parseAddresses(message.headers.To).some((a) => self.emails.has(a.email))) return null;
      const from = parseAddresses(message.headers.From)[0];
      if (from) personId = store.personIdOfKey(emailKey(from.email));
    } else {
      if (message.bot || message.author === null) return null;
      const direct = message.conversationKind === "im" || message.conversationKind === "mpim";
      if (!direct && !message.mentionsMe) return null;
      personId =
        store.personIdOfKey(slackKey(message.author)) ??
        (message.authorEmail ? store.personIdOfKey(emailKey(message.authorEmail)) : null);
    }
    const person = personId === null ? null : store.getPerson(personId);
    if (person === null || person.delegation === "jamais") return null;
    if (store.hasWatchItem(`reply:${message.id}`)) return null;
    const thread =
      message.threadId !== null
        ? store.listChannelMessages({ channel: message.channel, threadId: message.threadId })
        : message.conversation !== null
          ? store.listChannelMessages({ channel: "slack", conversation: message.conversation })
          : [];
    if (thread.some((m) => m.id !== message.id && m.at > message.at && this.#fromSelf(m, self))) return null;
    return person;
  }

  /** Les fils Gmail dont le dernier message est de l'utilisateur à autrui, silencieux depuis le délai. */
  #followUps(now: number, self: { emails: Set<string>; slack: string | null }, offered: Set<string>): FollowUp[] {
    const { store, config } = this.#deps;
    const { followUpDays, days } = config.workstation.watch;
    const out: FollowUp[] = [];
    const horizon = now - config.workstation.retentionDays * DAY;
    for (const id of store.lastGmailMessagesOfThreads(horizon, now - followUpDays * DAY)) {
      const key = `followup:${id}`;
      if (offered.has(key) || store.hasWatchItem(key)) continue;
      const message = store.getChannelMessage(id);
      if (message === null || !this.#fromSelf(message, self)) continue;
      const to = [...parseAddresses(message.headers.To), ...parseAddresses(message.headers.Cc)]
        .map((a) => a.email)
        .filter((email) => !self.emails.has(email));
      if (to.length === 0) continue;
      if (this.#workingDaysBetween(message.at, now, days) < followUpDays) continue;
      out.push({ message, to: [...new Set(to)] });
    }
    return out;
  }

  /** Les jours ouvrés entiers écoulés entre deux instants (jours de `days`, après celui de `from`). */
  #workingDaysBetween(from: number, to: number, days: readonly WeekDay[]): number {
    const tz = this.#deps.config.schedules.timezone;
    const first = Math.floor(wallClock(from, tz) / DAY) * DAY;
    const last = Math.floor(wallClock(to, tz) / DAY) * DAY;
    let count = 0;
    for (let day = first + DAY; day <= last; day += DAY)
      if (days.includes(WEEK_DAYS[new Date(day).getUTCDay()] as WeekDay)) count++;
    return count;
  }

  /** Les autres participants d'un événement (ni l'utilisateur, ni une salle). */
  #participants(event: ChannelEventRow, self: { emails: Set<string> }): { email: string; name: string | null }[] {
    return event.attendees
      .filter(
        (a): a is typeof a & { email: string } =>
          !a.self &&
          a.email !== null &&
          !a.email.endsWith(".calendar.google.com") &&
          !self.emails.has(a.email.trim().toLowerCase()),
      )
      .map((a) => ({ email: a.email.trim().toLowerCase(), name: a.name }));
  }

  /**
   * Les réunions à préparer à ce passage : à participants, dont « début − 15 min » est atteint et
   * le début pas encore, jamais préparées ni déjà proposées. Avant l'ouverture, seules celles des
   * 15 premières minutes de la plage.
   */
  #preps(
    now: number,
    when: { mode: WatchMode; openAt: number },
    self: { emails: Set<string> },
    offered: Set<string>,
  ): Prep[] {
    const { store } = this.#deps;
    const out: Prep[] = [];
    for (const event of store.listChannelEvents({ from: now, to: now + PREP_LEAD_MS + 1 })) {
      if (event.allDay || event.startAt <= now || event.startAt - PREP_LEAD_MS > now) continue;
      if (when.mode === "prep" && (event.startAt < when.openAt || event.startAt >= when.openAt + PREP_LEAD_MS))
        continue;
      const key = `prep:${event.id}`;
      if (offered.has(key) || store.hasWatchItem(key)) continue;
      const participants = this.#participants(event, self);
      if (participants.length === 0) continue;
      out.push(this.#prepOf(event, participants, now));
    }
    return out;
  }

  #prepOf(event: ChannelEventRow, participants: { email: string; name: string | null }[], now: number): Prep {
    const { store } = this.#deps;
    const people = participants.map((p) => {
      const id = store.personIdOfKey(emailKey(p.email));
      return { ...p, person: id === null ? null : store.getPerson(id) };
    });
    const emails = new Set(participants.map((p) => p.email));
    const slackIds = new Set(people.flatMap((p) => p.person?.slackIds ?? []));
    const threads = store
      .listChannelMessages({ limit: 5000 })
      .filter((m) => m.at >= now - THREADS_WINDOW_MS)
      .filter((m) =>
        m.channel === "gmail"
          ? [m.headers.From, m.headers.To, m.headers.Cc].some((h) => parseAddresses(h).some((a) => emails.has(a.email)))
          : (m.author !== null && slackIds.has(m.author)) ||
            (m.authorEmail !== null && emails.has(m.authorEmail.toLowerCase())),
      )
      .sort((a, b) => b.at - a.at)
      .slice(0, THREADS_SHOWN);
    const link = meetingKey(event.meetUrl);
    const meetings =
      link === null
        ? []
        : store
            .listWorkstationMeetings({ states: ["ended", "digested", "failed"], limit: 500 })
            .filter((m) => meetingKey(m.url) === link)
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, TRANSCRIPTS_SHOWN);
    const lines = [
      `Réunion : ${event.summary ?? "(sans titre)"} — ${new Date(event.startAt).toISOString()}`,
      "Participants :",
      ...people.map(({ email, name, person }) => {
        const facts = person
          ? [
              person.role && `rôle ${person.role}`,
              person.team && `équipe ${person.team}`,
              person.projects.length > 0 && `projets ${person.projects.join(", ")}`,
              person.tone && `ton ${person.tone}`,
            ].filter(Boolean)
          : [];
        return `- ${person?.name ?? name ?? email} <${email}>${facts.length > 0 ? ` : ${facts.join(" ; ")}` : " : inconnu du graphe"}`;
      }),
      "Fils récents avec eux :",
      ...(threads.length > 0
        ? threads.map(
            (m) =>
              `- ${new Date(m.at).toISOString().slice(0, 10)} ${m.subject ?? m.channel} : ${clip(oneLine(m.text), SNIPPET_MAX)}`,
          )
        : ["- aucun"]),
      "Transcripts des meetings passés au même lien :",
      ...(meetings.length > 0
        ? meetings.map(
            (m) => `- ${new Date(m.startedAt).toISOString().slice(0, 10)} ${m.title} : ${this.#transcriptOf(m)}`,
          )
        : ["- aucun transcript passé"]),
    ];
    return {
      event,
      body: untrusted("réunion de l'Agenda, participants, fils et transcripts", lines.join("\n")),
      context: {
        participants: people.map(({ email, name, person }) => ({
          email,
          name: person?.name ?? name,
          personId: person?.id ?? null,
        })),
        threads: threads.map((m) => m.id),
        meetings: meetings.map((m) => m.id),
      },
    };
  }

  #transcriptOf(meeting: { id: string; summary: string | null }): string {
    if (meeting.summary !== null && meeting.summary.trim() !== "")
      return clip(oneLine(meeting.summary), TRANSCRIPT_MAX);
    const text = this.#deps.store
      .listWorkstationSegments(meeting.id)
      .map((s) => `${s.speaker} : ${s.text}`)
      .join(" / ");
    return text === "" ? "(transcript vide)" : clip(text, TRANSCRIPT_MAX);
  }

  /** La section du brief, s'il y a quelque chose à dire ce jour : nouveautés, relances, réunions. */
  #brief(now: number, day: string, plan: WatchPlan, calendar: boolean, self: { emails: Set<string> }): string | null {
    const tz = this.#deps.config.schedules.timezone;
    const endOfDay = now + (Math.floor(wallClock(now, tz) / DAY) * DAY + DAY - wallClock(now, tz));
    const meetings = calendar
      ? this.#deps.store
          .listChannelEvents({ from: now, to: endOfDay })
          .filter((e) => !e.allDay && this.#participants(e, self).length > 0)
      : [];
    const open = this.#deps.store.listWatchItems({ states: ["open"], limit: 100 }).length;
    if (plan.messages.length + plan.followUps.length + meetings.length === 0) return null;
    const lines = [
      `Rends le brief du ${day} par \`workstation_watch_brief\` : ce qui attend l'utilisateur aujourd'hui.`,
      `- ${plan.messages.length} message(s) retenu(s) à ce passage, ${plan.followUps.length} relance(s) due(s), ${open} élément(s) déjà dans « À traiter ».`,
    ];
    if (meetings.length > 0)
      lines.push(
        untrusted(
          "réunions du jour (Agenda)",
          meetings
            .map((e) => `- ${new Date(e.startAt).toISOString().slice(11, 16)} UTC ${e.summary ?? "(sans titre)"}`)
            .join("\n"),
        ),
      );
    return lines.join("\n");
  }

  #messageText(message: ChannelMessageRow, person: PersonRow | null): string {
    const head =
      message.channel === "gmail"
        ? [
            `De : ${message.headers.From ?? ""}`,
            `À : ${message.headers.To ?? ""}`,
            message.headers.Cc ? `Cc : ${message.headers.Cc}` : "",
            `Objet : ${message.subject ?? ""}`,
          ]
        : [`De : ${message.authorName ?? message.author ?? ""}`, `Conversation : ${message.conversationKind ?? ""}`];
    const who = person
      ? [
          `Personne : ${person.name ?? "(sans nom)"}${person.role ? `, ${person.role}` : ""}${person.tone ? ` — ton : ${person.tone}` : ""}`,
        ]
      : [];
    return [...head, ...who, `Date : ${new Date(message.at).toISOString()}`, "", clip(message.text, MESSAGE_TEXT_MAX)]
      .filter((line, i, all) => line !== "" || i === all.length - 2)
      .join("\n");
  }
}

function refOf(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new HarnessError(400, `${key} : référence attendue`);
  return value.trim();
}

function textOf(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new HarnessError(400, "text : texte non vide attendu");
  if (value.length > WATCH_TEXT_MAX) throw new HarnessError(400, `text : ${WATCH_TEXT_MAX} caractères au plus`);
  return value.trim();
}
