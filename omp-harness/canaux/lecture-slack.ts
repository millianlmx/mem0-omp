// La lecture de Slack par `Channels.request`, avec le jeton UTILISATEUR (aucun bot) : les DM
// (`conversations.list` types im et mpim, puis `conversations.history`), les canaux suivis
// (`conversations.history` et `conversations.replies` des fils qui ont bougé), les mentions de
// l'utilisateur partout, canaux non suivis compris (`search.messages`), et l'identité des
// auteurs (`users.info`, adresse comprise).
//
// Sans doublon : un message est gardé une fois (`slack:<conversation>:<ts>`). Reprise après
// coupure : le curseur d'une conversation (le `ts` le plus récent) et celui de la recherche
// n'avancent qu'une fois leur lecture finie ; une lecture coupée relit depuis l'ancien curseur.
import { isRecord } from "../config.ts";
import type { MessageOrigin } from "../db.ts";
import type { ReadContext, ReadCounts } from "./lecture-google.ts";
import { ChannelApiError } from "./errors.ts";

const API = "https://slack.com/api";
const DAY_MS = 86_400_000;
const MAX_PAGES = 10;
const SEARCH_PAGES = 5;
const AUTHORS_PER_PASS = 50;
/** Les sous-types de message gardés (sans sous-type : un message ordinaire) ; le reste (arrivées, sujets…) est sauté. */
const KEPT_SUBTYPES = ["bot_message", "thread_broadcast", "file_share", "me_message"];

type Kind = "im" | "mpim" | "channel" | "group";
/** Une conversation de l'espace telle que `conversations.list` la rend. */
export type ListedConversation = { id: string; name: string; kind: Kind; archived: boolean };

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const tsOf = (value: unknown): string | null => (typeof value === "string" && /^\d+\.\d+$/.test(value) ? value : null);

function kindOf(conversation: Record<string, unknown>): Kind {
  if (conversation.is_im === true) return "im";
  if (conversation.is_mpim === true) return "mpim";
  return conversation.is_private === true || conversation.is_group === true ? "group" : "channel";
}

function nextCursor(reply: Record<string, unknown>): string | null {
  const cursor = record(reply.response_metadata).next_cursor;
  return typeof cursor === "string" && cursor !== "" ? cursor : null;
}

export async function readSlack(ctx: ReadContext): Promise<ReadCounts> {
  const counts: ReadCounts = { added: 0, removed: 0 };
  const self = await selfId(ctx);
  for (const dm of await listConversations(ctx, "im,mpim"))
    counts.added += await readConversation(ctx, self, dm.id, dm.kind, "dm");
  for (const followed of ctx.store.listSlackConversations())
    if (followed.followed && !followed.archived)
      counts.added += await readConversation(
        ctx,
        self,
        followed.id,
        followed.kind === "private" ? "group" : "channel",
        "followed",
      );
  counts.added += await readMentions(ctx, self);
  await readAuthors(ctx);
  return counts;
}

/** L'identifiant Slack de l'utilisateur (`auth.test`), lu une fois. */
async function selfId(ctx: ReadContext): Promise<string> {
  const known = ctx.store.getChannelCursor<{ userId: string }>("slack.self");
  if (known !== null) return known.userId;
  const reply = record(await ctx.request("slack", { method: "GET", url: `${API}/auth.test` }));
  const userId = typeof reply.user_id === "string" ? reply.user_id : "";
  if (userId !== "") ctx.store.setChannelCursor("slack.self", { userId }, ctx.now());
  return userId;
}

/** Les conversations de l'espace d'un ou plusieurs types (`im,mpim`, `public_channel,private_channel`). */
export async function listConversations(ctx: ReadContext, types: string): Promise<ListedConversation[]> {
  const out: ListedConversation[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES * 2; page++) {
    const reply = record(
      await ctx.request("slack", {
        method: "GET",
        url: `${API}/conversations.list`,
        query: { types, limit: "200", exclude_archived: "true", ...(cursor === null ? {} : { cursor }) },
      }),
    );
    for (const raw of list(reply.channels)) {
      const conversation = record(raw);
      if (typeof conversation.id !== "string") continue;
      out.push({
        id: conversation.id,
        name: typeof conversation.name === "string" ? conversation.name : conversation.id,
        kind: kindOf(conversation),
        archived: conversation.is_archived === true,
      });
    }
    cursor = nextCursor(reply);
    if (cursor === null) break;
  }
  return out;
}

/**
 * Les messages d'une conversation depuis son curseur, et les réponses des fils qui ont bougé.
 * Une conversation quittée, archivée ou introuvable (erreur propre à la ressource) est sautée.
 */
async function readConversation(
  ctx: ReadContext,
  self: string,
  id: string,
  kind: Kind,
  origin: MessageOrigin,
): Promise<number> {
  const key = `slack.conv:${id}`;
  const oldest =
    ctx.store.getChannelCursor<{ oldest: string }>(key)?.oldest ??
    ((ctx.now() - ctx.firstReadDays * DAY_MS) / 1000).toFixed(6);
  let latest = oldest;
  let added = 0;
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const reply = record(
        await ctx.request("slack", {
          method: "GET",
          url: `${API}/conversations.history`,
          query: { channel: id, oldest, limit: "200", ...(cursor === null ? {} : { cursor }) },
        }),
      );
      for (const raw of list(reply.messages)) {
        const message = record(raw);
        const ts = tsOf(message.ts);
        if (ts === null) continue;
        if (Number(ts) > Number(latest)) latest = ts;
        added += keep(ctx, self, message, id, kind, origin, tsOf(message.thread_ts));
        const lastReply = tsOf(message.latest_reply);
        if (Number(message.reply_count) > 0 && lastReply !== null && Number(lastReply) > Number(oldest))
          added += await readReplies(ctx, self, id, kind, origin, ts, oldest);
      }
      cursor = nextCursor(reply);
      if (cursor === null) break;
    }
  } catch (err) {
    if (err instanceof ChannelApiError) return added;
    throw err;
  }
  ctx.store.setChannelCursor(key, { oldest: latest }, ctx.now());
  return added;
}

async function readReplies(
  ctx: ReadContext,
  self: string,
  id: string,
  kind: Kind,
  origin: MessageOrigin,
  thread: string,
  oldest: string,
): Promise<number> {
  let added = 0;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const reply = record(
      await ctx.request("slack", {
        method: "GET",
        url: `${API}/conversations.replies`,
        query: { channel: id, ts: thread, oldest, limit: "200", ...(cursor === null ? {} : { cursor }) },
      }),
    );
    for (const raw of list(reply.messages)) added += keep(ctx, self, record(raw), id, kind, origin, thread);
    cursor = nextCursor(reply);
    if (cursor === null) break;
  }
  return added;
}

/** Les mentions de l'utilisateur depuis la dernière recherche, de la plus récente à la plus ancienne. */
async function readMentions(ctx: ReadContext, self: string): Promise<number> {
  if (self === "") return 0;
  const since =
    ctx.store.getChannelCursor<{ latest: string }>("slack.search")?.latest ??
    ((ctx.now() - ctx.firstReadDays * DAY_MS) / 1000).toFixed(6);
  let latest = since;
  let added = 0;
  search: for (let page = 1; page <= SEARCH_PAGES; page++) {
    const reply = record(
      await ctx.request("slack", {
        method: "GET",
        url: `${API}/search.messages`,
        query: { query: `<@${self}>`, sort: "timestamp", sort_dir: "desc", count: "100", page: String(page) },
      }),
    );
    const messages = record(reply.messages);
    for (const raw of list(messages.matches)) {
      const match = record(raw);
      const ts = tsOf(match.ts);
      const channel = record(match.channel);
      if (ts === null || typeof channel.id !== "string") continue;
      if (Number(ts) <= Number(since)) break search;
      if (Number(ts) > Number(latest)) latest = ts;
      let thread: string | null = null;
      try {
        thread = tsOf(new URL(String(match.permalink)).searchParams.get("thread_ts"));
      } catch {
        thread = null;
      }
      added += keep(ctx, self, match, channel.id, kindOf(channel), "search", thread);
    }
    if (page >= Number(record(messages.paging).pages ?? 1)) break;
  }
  ctx.store.setChannelCursor("slack.search", { latest }, ctx.now());
  return added;
}

/** Garde un message (1 s'il est nouveau) ; arrivées, départs, sujets et autres sous-types sont sautés. */
function keep(
  ctx: ReadContext,
  self: string,
  message: Record<string, unknown>,
  conversation: string,
  kind: Kind,
  origin: MessageOrigin,
  thread: string | null,
): number {
  const ts = tsOf(message.ts);
  const subtype = message.subtype;
  if (ts === null || (typeof subtype === "string" && !KEPT_SUBTYPES.includes(subtype))) return 0;
  const body = typeof message.text === "string" ? message.text : "";
  const added = ctx.store.addChannelMessage({
    id: `slack:${conversation}:${ts}`,
    channel: "slack",
    sourceId: ts,
    threadId: thread,
    conversation,
    conversationKind: kind,
    origin,
    author: typeof message.user === "string" ? message.user : null,
    at: Math.round(Number(ts) * 1000),
    subject: null,
    text: body,
    headers: {},
    labels: [],
    mentionsMe: self !== "" && body.includes(`<@${self}>`),
    bot: typeof message.bot_id === "string" || subtype === "bot_message",
    readAt: ctx.now(),
  });
  return added ? 1 : 0;
}

/** L'identité (nom, adresse) des auteurs de messages gardés qui ne sont pas encore connus. */
async function readAuthors(ctx: ReadContext): Promise<void> {
  for (const id of ctx.store.missingSlackAuthors(AUTHORS_PER_PASS)) {
    let user: Record<string, unknown>;
    try {
      user = record(
        record(await ctx.request("slack", { method: "GET", url: `${API}/users.info`, query: { user: id } })).user,
      );
    } catch (err) {
      if (!(err instanceof ChannelApiError)) throw err;
      // Introuvable : gardé sans identité, pour ne pas le redemander à chaque lecture.
      user = {};
    }
    const profile = record(user.profile);
    const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
    ctx.store.putSlackUser(
      {
        id,
        name: str(user.name),
        realName: str(user.real_name) ?? str(profile.real_name),
        email: str(profile.email),
        bot: user.is_bot === true,
      },
      ctx.now(),
    );
  }
}
