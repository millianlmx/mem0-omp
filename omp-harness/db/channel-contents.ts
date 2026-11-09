// Les contenus lus des canaux corpo (canaux/lecture.ts) : messages Gmail et Slack, événements de
// l'Agenda, curseurs de lecture, conversations Slack (suivies ou non) et auteurs Slack.
//
// C'est le stockage que lisent les couches d'au-dessus (graphe des personnes, veille) : tout y
// est du texte NON FIABLE venu de l'extérieur, à passer par `untrusted()`
// (workstation-guards.ts) avant d'être montré à un agent, et qui ne va jamais dans un log, une
// issue ni la mémoire d'un dépôt. Un message n'est gardé qu'une fois (identifiant de source) ;
// son `seq` croît à chaque message nouveau : « les nouveautés depuis » = `seq > dernier vu`.
// Un événement de l'Agenda est mis à jour sur place (déplacé : nouvelle heure ; annulé : retiré).
import { IntakeStore } from "./intakes.ts";
import { json, num, str, strOrNull } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

export type ContentChannel = "gmail" | "slack";
/** D'où vient un message : historique ou resynchronisation Gmail, DM, canal suivi ou recherche Slack. */
export type MessageOrigin = "history" | "resync" | "dm" | "followed" | "search";

export type ChannelMessageInput = {
  /** `gmail:<id du message>` ou `slack:<id de la conversation>:<ts>`. */
  id: string;
  channel: ContentChannel;
  sourceId: string;
  /** Gmail : `threadId` ; Slack : `thread_ts` (le `ts` du message parent), `null` hors fil. */
  threadId: string | null;
  /** Slack : la conversation (`C…`, `D…`, `G…`) ; Gmail : `null`. */
  conversation: string | null;
  /** Slack : `im`, `mpim`, `channel` ou `group` ; Gmail : `null`. */
  conversationKind: string | null;
  origin: MessageOrigin;
  /** Gmail : l'en-tête `From` tel quel ; Slack : l'identifiant de l'auteur (`U…`). */
  author: string | null;
  /** La date du message (ms). */
  at: number;
  /** Gmail : `Subject` ; Slack : `null`. */
  subject: string | null;
  /** Gmail : le corps texte (tronqué) ou l'extrait ; Slack : le texte. */
  text: string;
  /** Gmail : les en-têtes utiles au tri (From, To, Cc, Subject, List-Id, List-Unsubscribe, Auto-Submitted, Precedence, Message-ID, In-Reply-To, References). */
  headers: Record<string, string>;
  /** Gmail : les libellés (`INBOX`, `SENT`, `UNREAD`…) ; Slack : vide. */
  labels: string[];
  /** Slack : le texte cite l'utilisateur (`<@U…>`). */
  mentionsMe: boolean;
  /** Slack : message d'un bot (`bot_id`, `bot_message`). */
  bot: boolean;
  readAt: number;
};

export type ChannelMessageRow = ChannelMessageInput & {
  seq: number;
  /** Slack : l'identité de l'auteur (users.info), si elle est connue. */
  authorName: string | null;
  authorEmail: string | null;
};

export type CalendarAttendee = {
  email: string | null;
  name: string | null;
  response: string | null;
  self: boolean;
  organizer: boolean;
};

export type ChannelEventInput = {
  id: string;
  summary: string | null;
  startAt: number;
  endAt: number;
  allDay: boolean;
  organizer: string | null;
  attendees: CalendarAttendee[];
  /** `hangoutLink`, ou le point d'entrée vidéo de `conferenceData`. */
  meetUrl: string | null;
  recurringEventId: string | null;
  /** `updated` de l'événement chez Google (ms). */
  updatedAt: number;
  readAt: number;
};
export type ChannelEventRow = ChannelEventInput;

export type SlackConversationRow = {
  id: string;
  name: string;
  kind: "public" | "private";
  archived: boolean;
  followed: boolean;
};

export type SlackUserRow = {
  id: string;
  name: string | null;
  realName: string | null;
  email: string | null;
  bot: boolean;
};

function messageOf(row: Row): ChannelMessageRow {
  return {
    seq: num(row, "seq"),
    id: str(row, "id"),
    channel: str(row, "channel") as ContentChannel,
    sourceId: str(row, "source_id"),
    threadId: strOrNull(row, "thread_id"),
    conversation: strOrNull(row, "conversation"),
    conversationKind: strOrNull(row, "conversation_kind"),
    origin: str(row, "origin") as MessageOrigin,
    author: strOrNull(row, "author"),
    at: num(row, "at"),
    subject: strOrNull(row, "subject"),
    text: str(row, "text"),
    headers: json(row, "headers", {}),
    labels: json(row, "labels", []),
    mentionsMe: num(row, "mentions_me") === 1,
    bot: num(row, "bot") === 1,
    readAt: num(row, "read_at"),
    authorName: strOrNull(row, "author_name"),
    authorEmail: strOrNull(row, "author_email"),
  };
}

function eventOf(row: Row): ChannelEventRow {
  return {
    id: str(row, "id"),
    summary: strOrNull(row, "summary"),
    startAt: num(row, "start_at"),
    endAt: num(row, "end_at"),
    allDay: num(row, "all_day") === 1,
    organizer: strOrNull(row, "organizer"),
    attendees: json(row, "attendees", []),
    meetUrl: strOrNull(row, "meet_url"),
    recurringEventId: strOrNull(row, "recurring_event_id"),
    updatedAt: num(row, "updated_at"),
    readAt: num(row, "read_at"),
  };
}

function conversationOf(row: Row): SlackConversationRow {
  return {
    id: str(row, "id"),
    name: str(row, "name"),
    kind: str(row, "kind") as SlackConversationRow["kind"],
    archived: num(row, "archived") === 1,
    followed: num(row, "followed") === 1,
  };
}

const MESSAGE_SELECT = `SELECT m.*, COALESCE(u.real_name, u.name) AS author_name, u.email AS author_email
  FROM channel_messages m LEFT JOIN slack_users u ON m.channel = 'slack' AND u.id = m.author`;

export class ChannelContentStore extends IntakeStore {
  // -- messages (Gmail, Slack) ------------------------------------------------------------------

  /** Garde un message s'il est nouveau ; `false` s'il l'était déjà (rien ne change). */
  addChannelMessage(m: ChannelMessageInput): boolean {
    const result = this.execute(
      `INSERT INTO channel_messages (id, channel, source_id, thread_id, conversation, conversation_kind, origin,
         author, at, subject, text, headers, labels, mentions_me, bot, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      m.id,
      m.channel,
      m.sourceId,
      m.threadId,
      m.conversation,
      m.conversationKind,
      m.origin,
      m.author,
      m.at,
      m.subject,
      m.text,
      JSON.stringify(m.headers),
      JSON.stringify(m.labels),
      m.mentionsMe ? 1 : 0,
      m.bot ? 1 : 0,
      m.readAt,
    );
    return Number(result.changes) > 0;
  }

  hasChannelMessage(id: string): boolean {
    return this.selectOne("SELECT 1 FROM channel_messages WHERE id = ?", id) !== undefined;
  }

  getChannelMessage(id: string): ChannelMessageRow | null {
    const row = this.selectOne(`${MESSAGE_SELECT} WHERE m.id = ?`, id);
    return row ? messageOf(row) : null;
  }

  /** Les messages gardés, du plus ancien `seq` au plus récent ; `afterSeq` : les nouveautés seules. */
  listChannelMessages(
    filter: {
      channel?: ContentChannel;
      afterSeq?: number;
      threadId?: string;
      conversation?: string;
      limit?: number;
    } = {},
  ): ChannelMessageRow[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.channel !== undefined) {
      where.push("m.channel = ?");
      params.push(filter.channel);
    }
    if (filter.afterSeq !== undefined) {
      where.push("m.seq > ?");
      params.push(filter.afterSeq);
    }
    if (filter.threadId !== undefined) {
      where.push("m.thread_id = ?");
      params.push(filter.threadId);
    }
    if (filter.conversation !== undefined) {
      where.push("m.conversation = ?");
      params.push(filter.conversation);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    return this.selectAll(`${MESSAGE_SELECT}${clause} ORDER BY m.seq LIMIT ?`, ...params, filter.limit ?? 1000).map(
      messageOf,
    );
  }

  // -- événements de l'Agenda --------------------------------------------------------------------

  /** Crée ou remplace un événement (déplacé : nouvelle heure) ; `true` s'il est nouveau ou a changé. */
  putChannelEvent(e: ChannelEventInput): boolean {
    const before = this.selectOne("SELECT updated_at, start_at, end_at FROM channel_events WHERE id = ?", e.id);
    if (before && num(before, "updated_at") === e.updatedAt && num(before, "start_at") === e.startAt) return false;
    this.execute(
      `INSERT INTO channel_events (id, summary, start_at, end_at, all_day, organizer, attendees, meet_url,
         recurring_event_id, updated_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET summary = excluded.summary, start_at = excluded.start_at,
         end_at = excluded.end_at, all_day = excluded.all_day, organizer = excluded.organizer,
         attendees = excluded.attendees, meet_url = excluded.meet_url,
         recurring_event_id = excluded.recurring_event_id, updated_at = excluded.updated_at, read_at = excluded.read_at`,
      e.id,
      e.summary,
      e.startAt,
      e.endAt,
      e.allDay ? 1 : 0,
      e.organizer,
      JSON.stringify(e.attendees),
      e.meetUrl,
      e.recurringEventId,
      e.updatedAt,
      e.readAt,
    );
    return true;
  }

  /** Retire un événement annulé ; `true` s'il était gardé. */
  removeChannelEvent(id: string): boolean {
    return Number(this.execute("DELETE FROM channel_events WHERE id = ?", id).changes) > 0;
  }

  /** Vide les événements (resynchronisation complète de l'Agenda) ; rend le nombre retiré. */
  clearChannelEvents(): number {
    return Number(this.execute("DELETE FROM channel_events").changes);
  }

  /** Les événements qui finissent après `from` et commencent avant `to`, par heure de début. */
  listChannelEvents(range: { from?: number; to?: number } = {}): ChannelEventRow[] {
    return this.selectAll(
      "SELECT * FROM channel_events WHERE end_at > ? AND start_at < ? ORDER BY start_at, id",
      range.from ?? 0,
      range.to ?? Number.MAX_SAFE_INTEGER,
    ).map(eventOf);
  }

  // -- curseurs ----------------------------------------------------------------------------------

  getChannelCursor<T>(key: string): T | null {
    const row = this.selectOne("SELECT value FROM channel_cursors WHERE key = ?", key);
    return row ? json<T | null>(row, "value", null) : null;
  }

  setChannelCursor(key: string, value: unknown, at: number): void {
    this.execute(
      `INSERT INTO channel_cursors (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      at,
    );
  }

  deleteChannelCursor(key: string): void {
    this.execute("DELETE FROM channel_cursors WHERE key = ?", key);
  }

  // -- conversations et auteurs Slack -----------------------------------------------------------

  /** Les conversations de l'espace, telles que listées : le choix « suivi » de chacune reste. */
  putSlackConversations(list: Omit<SlackConversationRow, "followed">[], at: number): void {
    this.transaction(() => {
      for (const c of list)
        this.execute(
          `INSERT INTO slack_conversations (id, name, kind, archived, followed, updated_at) VALUES (?, ?, ?, ?, 0, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
             archived = excluded.archived, updated_at = excluded.updated_at`,
          c.id,
          c.name,
          c.kind,
          c.archived ? 1 : 0,
          at,
        );
    });
  }

  listSlackConversations(): SlackConversationRow[] {
    return this.selectAll("SELECT * FROM slack_conversations ORDER BY name, id").map(conversationOf);
  }

  /** Coche ou décoche un canal suivi ; `null` si la conversation n'est pas connue. */
  setSlackConversationFollowed(id: string, followed: boolean): SlackConversationRow | null {
    this.execute("UPDATE slack_conversations SET followed = ? WHERE id = ?", followed ? 1 : 0, id);
    const row = this.selectOne("SELECT * FROM slack_conversations WHERE id = ?", id);
    return row ? conversationOf(row) : null;
  }

  putSlackUser(user: SlackUserRow, at: number): void {
    this.execute(
      `INSERT INTO slack_users (id, name, real_name, email, bot, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, real_name = excluded.real_name,
         email = excluded.email, bot = excluded.bot, updated_at = excluded.updated_at`,
      user.id,
      user.name,
      user.realName,
      user.email,
      user.bot ? 1 : 0,
      at,
    );
  }

  getSlackUser(id: string): SlackUserRow | null {
    const row = this.selectOne("SELECT * FROM slack_users WHERE id = ?", id);
    if (!row) return null;
    return {
      id: str(row, "id"),
      name: strOrNull(row, "name"),
      realName: strOrNull(row, "real_name"),
      email: strOrNull(row, "email"),
      bot: num(row, "bot") === 1,
    };
  }

  /** Les auteurs Slack de messages gardés dont l'identité n'est pas encore lue. */
  missingSlackAuthors(limit: number): string[] {
    return this.selectAll(
      `SELECT DISTINCT author FROM channel_messages WHERE channel = 'slack' AND author IS NOT NULL
         AND author NOT IN (SELECT id FROM slack_users) ORDER BY author LIMIT ?`,
      limit,
    ).map((row) => str(row, "author"));
  }

  // -- rétention ---------------------------------------------------------------------------------

  /**
   * Efface les contenus plus vieux que `before` (ms) : messages par leur date, événements finis
   * avant, auteurs Slack lus avant. Les curseurs et les conversations (le choix « suivi ») restent.
   */
  pruneChannelContents(before: number): number {
    return this.transaction(
      () =>
        Number(this.execute("DELETE FROM channel_messages WHERE at < ?", before).changes) +
        Number(this.execute("DELETE FROM channel_events WHERE end_at < ?", before).changes) +
        Number(this.execute("DELETE FROM slack_users WHERE updated_at < ?", before).changes),
    );
  }
}
