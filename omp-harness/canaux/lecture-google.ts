// La lecture de Gmail et de l'Agenda par `Channels.request` (liste blanche, jeton renouvelé).
//
// Gmail : historique incrémental (`users.history.list` depuis le dernier `historyId`, puis
// `users.messages.get` des messages ajoutés). Le curseur n'avance qu'une page entièrement
// gardée : une lecture coupée au milieu d'une page reprend cette page, et un message déjà
// gardé n'est pas relu (aucun doublon). Un historique expiré (404) déclenche une
// resynchronisation BORNÉE (`GMAIL_RESYNC_MAX` messages des `firstReadDays` derniers jours),
// qui est aussi la première lecture. L'Agenda : `events.list` du calendrier principal par
// `nextSyncToken` ; un 410 vide les événements gardés et relit la fenêtre à venir.
import { isRecord } from "../config.ts";
import type { Store } from "../db.ts";
import type { CalendarAttendee, ChannelEventInput } from "../db.ts";
import type { ChannelId, ChannelRequest } from "./channels.ts";
import { ChannelApiError } from "./errors.ts";

export type ReadContext = {
  request: (channel: ChannelId, req: ChannelRequest) => Promise<unknown>;
  store: Store;
  now: () => number;
  /** La fenêtre de la première lecture (et d'une resynchronisation), en jours. */
  firstReadDays: number;
};
export type ReadCounts = { added: number; removed: number };

const DAY_MS = 86_400_000;
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
/** Une resynchronisation ne relit pas plus de messages que cela. */
export const GMAIL_RESYNC_MAX = 200;
/** L'horizon de la première lecture de l'Agenda (ms). */
const CALENDAR_HORIZON_MS = 60 * DAY_MS;
const TEXT_MAX = 20_000;
const MAX_PAGES = 50;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
/** Les en-têtes gardés : ceux dont le tri de la veille a besoin. */
export const GMAIL_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "List-Id",
  "List-Unsubscribe",
  "Auto-Submitted",
  "Precedence",
  "Message-ID",
  "In-Reply-To",
  "References",
] as const;

type GmailCursor = {
  historyId?: string;
  pageToken?: string;
  /** En cours de resynchronisation : `historyId` relevé AVANT la liste, d'où l'historique repartira. */
  resync?: { historyId: string | null; pageToken?: string; listed: number };
};

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

// -- Gmail -----------------------------------------------------------------------------------

export async function readGmail(ctx: ReadContext): Promise<ReadCounts> {
  const cursor = ctx.store.getChannelCursor<GmailCursor>("gmail") ?? { resync: { historyId: null, listed: 0 } };
  if (cursor.resync !== undefined || cursor.historyId === undefined) return resync(ctx, cursor.resync);
  const counts: ReadCounts = { added: 0, removed: 0 };
  let pageToken = cursor.pageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    let reply: Record<string, unknown>;
    try {
      reply = record(
        await ctx.request("gmail", {
          method: "GET",
          url: `${GMAIL}/history`,
          query: {
            startHistoryId: cursor.historyId,
            historyTypes: "messageAdded",
            maxResults: "100",
            ...(pageToken === undefined ? {} : { pageToken }),
          },
        }),
      );
    } catch (err) {
      // L'historique a expiré : resynchronisation bornée, sans doublon (les messages gardés restent).
      if (err instanceof ChannelApiError && err.status === 404) {
        ctx.store.setChannelCursor("gmail", { resync: { historyId: null, listed: 0 } }, ctx.now());
        return resync(ctx, undefined);
      }
      throw err;
    }
    const ids = new Set<string>();
    for (const entry of list(reply.history))
      for (const added of list(record(entry).messagesAdded)) {
        const message = record(record(added).message);
        if (typeof message.id === "string" && !list(message.labelIds).includes("DRAFT")) ids.add(message.id);
      }
    for (const id of ids) counts.added += await fetchMessage(ctx, id, "history");
    const next = text(reply.nextPageToken);
    if (next !== null) {
      pageToken = next;
      ctx.store.setChannelCursor("gmail", { historyId: cursor.historyId, pageToken: next }, ctx.now());
      continue;
    }
    const historyId = typeof reply.historyId === "string" ? reply.historyId : cursor.historyId;
    ctx.store.setChannelCursor("gmail", { historyId }, ctx.now());
    break;
  }
  return counts;
}

/** Relit au plus `GMAIL_RESYNC_MAX` messages récents ; l'historique repart du `historyId` relevé avant. */
async function resync(ctx: ReadContext, state: GmailCursor["resync"]): Promise<ReadCounts> {
  const counts: ReadCounts = { added: 0, removed: 0 };
  let current = state ?? { historyId: null, listed: 0 };
  if (current.historyId === null) {
    const profile = record(await ctx.request("gmail", { method: "GET", url: `${GMAIL}/profile` }));
    const historyId = profile.historyId;
    current = {
      historyId: typeof historyId === "string" || typeof historyId === "number" ? String(historyId) : "",
      listed: 0,
    };
    ctx.store.setChannelCursor("gmail", { resync: current }, ctx.now());
  }
  while (current.listed < GMAIL_RESYNC_MAX) {
    const reply = record(
      await ctx.request("gmail", {
        method: "GET",
        url: `${GMAIL}/messages`,
        query: {
          q: `newer_than:${ctx.firstReadDays}d`,
          maxResults: String(Math.min(100, GMAIL_RESYNC_MAX - current.listed)),
          ...(current.pageToken === undefined ? {} : { pageToken: current.pageToken }),
        },
      }),
    );
    const messages = list(reply.messages);
    for (const message of messages) {
      const id = record(message).id;
      if (typeof id === "string") counts.added += await fetchMessage(ctx, id, "resync");
    }
    const next = text(reply.nextPageToken);
    current = {
      historyId: current.historyId,
      listed: current.listed + messages.length,
      ...(next ? { pageToken: next } : {}),
    };
    if (next === null || messages.length === 0) break;
    ctx.store.setChannelCursor("gmail", { resync: current }, ctx.now());
  }
  if (current.historyId) ctx.store.setChannelCursor("gmail", { historyId: current.historyId }, ctx.now());
  else ctx.store.deleteChannelCursor("gmail");
  return counts;
}

/** Lit et garde un message s'il ne l'est pas déjà ; 1 s'il est nouveau. Un message effacé entre-temps est sauté. */
async function fetchMessage(ctx: ReadContext, id: string, origin: "history" | "resync"): Promise<number> {
  if (!ID.test(id) || ctx.store.hasChannelMessage(`gmail:${id}`)) return 0;
  let reply: Record<string, unknown>;
  try {
    reply = record(
      await ctx.request("gmail", { method: "GET", url: `${GMAIL}/messages/${id}`, query: { format: "full" } }),
    );
  } catch (err) {
    if (err instanceof ChannelApiError && err.status === 404) return 0;
    throw err;
  }
  const labels = list(reply.labelIds).filter((label): label is string => typeof label === "string");
  if (labels.includes("DRAFT")) return 0;
  const payload = record(reply.payload);
  const headers: Record<string, string> = {};
  for (const header of list(payload.headers)) {
    const { name, value } = record(header);
    if (typeof name !== "string" || typeof value !== "string") continue;
    const kept = GMAIL_HEADERS.find((h) => h.toLowerCase() === name.toLowerCase());
    if (kept !== undefined && headers[kept] === undefined) headers[kept] = value;
  }
  const at = Number(reply.internalDate);
  const added = ctx.store.addChannelMessage({
    id: `gmail:${id}`,
    channel: "gmail",
    sourceId: id,
    threadId: text(reply.threadId),
    conversation: null,
    conversationKind: null,
    origin,
    author: headers.From ?? null,
    at: Number.isFinite(at) && at > 0 ? at : ctx.now(),
    subject: headers.Subject ?? null,
    text: (plainText(payload) ?? text(reply.snippet) ?? "").slice(0, TEXT_MAX),
    headers,
    labels,
    mentionsMe: false,
    bot: false,
    readAt: ctx.now(),
  });
  return added ? 1 : 0;
}

/** Le premier corps `text/plain` du message (parties imbriquées comprises). */
function plainText(part: Record<string, unknown>): string | null {
  const body = record(part.body);
  if (part.mimeType === "text/plain" && typeof body.data === "string")
    return Buffer.from(body.data, "base64url").toString("utf8");
  for (const child of list(part.parts)) {
    const found = plainText(record(child));
    if (found !== null) return found;
  }
  return null;
}

// -- Agenda ----------------------------------------------------------------------------------

type CalendarCursor = { syncToken?: string; window?: { timeMin: string; timeMax: string }; pageToken?: string };

export async function readCalendar(ctx: ReadContext): Promise<ReadCounts> {
  const counts: ReadCounts = { added: 0, removed: 0 };
  const fresh = (): CalendarCursor => {
    const now = ctx.now();
    return {
      window: { timeMin: new Date(now).toISOString(), timeMax: new Date(now + CALENDAR_HORIZON_MS).toISOString() },
    };
  };
  let cursor = ctx.store.getChannelCursor<CalendarCursor>("calendar") ?? {};
  if (cursor.syncToken === undefined && cursor.window === undefined) cursor = fresh();
  let resynced = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    let reply: Record<string, unknown>;
    try {
      reply = record(
        await ctx.request("calendar", {
          method: "GET",
          url: EVENTS,
          query: {
            singleEvents: "true",
            maxResults: "250",
            ...(cursor.syncToken !== undefined ? { syncToken: cursor.syncToken } : (cursor.window ?? {})),
            ...(cursor.pageToken === undefined ? {} : { pageToken: cursor.pageToken }),
          },
        }),
      );
    } catch (err) {
      // Jeton de synchronisation expiré : resynchronisation complète (une fois par lecture).
      if (err instanceof ChannelApiError && err.status === 410 && !resynced) {
        resynced = true;
        counts.removed += ctx.store.clearChannelEvents();
        cursor = fresh();
        ctx.store.setChannelCursor("calendar", cursor, ctx.now());
        continue;
      }
      throw err;
    }
    for (const item of list(reply.items)) {
      const event = record(item);
      if (typeof event.id !== "string") continue;
      if (event.status === "cancelled") {
        if (ctx.store.removeChannelEvent(event.id)) counts.removed++;
        continue;
      }
      const parsed = eventOf(event, ctx.now());
      if (parsed !== null && ctx.store.putChannelEvent(parsed)) counts.added++;
    }
    const next = text(reply.nextPageToken);
    if (next !== null) {
      cursor = { ...cursor, pageToken: next };
      ctx.store.setChannelCursor("calendar", cursor, ctx.now());
      continue;
    }
    const syncToken = text(reply.nextSyncToken);
    ctx.store.setChannelCursor("calendar", syncToken === null ? {} : { syncToken }, ctx.now());
    break;
  }
  return counts;
}

function timeOf(value: unknown): { at: number; allDay: boolean } | null {
  const when = record(value);
  if (typeof when.dateTime === "string") {
    const at = Date.parse(when.dateTime);
    return Number.isFinite(at) ? { at, allDay: false } : null;
  }
  if (typeof when.date === "string") {
    const at = Date.parse(when.date);
    return Number.isFinite(at) ? { at, allDay: true } : null;
  }
  return null;
}

function eventOf(event: Record<string, unknown>, now: number): ChannelEventInput | null {
  const start = timeOf(event.start);
  const end = timeOf(event.end) ?? start;
  if (start === null || end === null) return null;
  const attendees: CalendarAttendee[] = list(event.attendees).map((raw) => {
    const a = record(raw);
    return {
      email: text(a.email),
      name: text(a.displayName),
      response: text(a.responseStatus),
      self: a.self === true,
      organizer: a.organizer === true,
    };
  });
  const organizer = record(event.organizer);
  const video = list(record(event.conferenceData).entryPoints)
    .map(record)
    .find((entry) => entry.entryPointType === "video");
  const updated = typeof event.updated === "string" ? Date.parse(event.updated) : Number.NaN;
  return {
    id: event.id as string,
    summary: text(event.summary),
    startAt: start.at,
    endAt: end.at,
    allDay: start.allDay,
    organizer: text(organizer.email) ?? text(organizer.displayName),
    attendees,
    meetUrl: text(event.hangoutLink) ?? text(video?.uri),
    recurringEventId: text(event.recurringEventId),
    updatedAt: Number.isFinite(updated) ? updated : now,
    readAt: now,
  };
}
