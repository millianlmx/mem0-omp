// Feature lecture-canaux (OS agentique 4/6, sous-feature « Lecture des canaux par API ») : le
// serveur lit Gmail (historique incrémental), l'Agenda (jeton de synchronisation) et Slack
// (DM, mentions, canaux suivis, auteurs) par `Channels.request`, garde les contenus en base sans
// doublon, reprend après une coupure, respecte les limites de débit et purge après
// `workstation.retentionDays`. Google et Slack sont des doublures derrière l'option `fetch`.
// Données fictives seulement (exemple.fr).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { ALLOWLIST } from "../../omp-harness/canaux/allowlist.ts";
import type { ChannelFetch } from "../../omp-harness/canaux/channels.ts";
import { ChannelRefused } from "../../omp-harness/canaux/errors.ts";
import { GMAIL_RESYNC_MAX } from "../../omp-harness/canaux/lecture-google.ts";
import type { ReadOutcome } from "../../omp-harness/canaux/lecture.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import type { SlackConversationRow } from "../../omp-harness/db.ts";
import { ROOT, tmpdir } from "../support/repo.ts";
import { covers, swiftFields } from "../support/swift-contract.ts";

const ADMIN = "a".repeat(64);
const GOOGLE_ACCESS = "ya29.access-lecture";
const SLACK_ACCESS = "xoxe.xoxp-access-lecture";
const GMAIL = "gmail.googleapis.com/gmail/v1/users/me";
const HISTORY = `GET ${GMAIL}/history`;
const MESSAGES = `GET ${GMAIL}/messages`;
const MESSAGE = `GET ${GMAIL}/messages/`;
const PROFILE = `GET ${GMAIL}/profile`;
const EVENTS = "GET www.googleapis.com/calendar/v3/calendars/primary/events";
const SLACK = "GET slack.com/api/";

// -- la doublure de Google et de Slack -----------------------------------------------------------

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "reject";
type Handler = (url: URL) => Reply;
type Seen = { key: string; url: URL; authorization: string };

class Provider {
  readonly calls: Seen[] = [];
  readonly #handlers = new Map<string, Handler>();
  readonly #once = new Map<string, Reply[]>();

  /** Le comportement de `key` (« MÉTHODE hôte/chemin », ou préfixe finissant par `/`). */
  on(key: string, handler: Handler): void {
    this.#handlers.set(key, handler);
  }

  /** Des réponses données avant le comportement de `key`, une par appel. */
  once(key: string, ...replies: Reply[]): void {
    this.#once.set(key, [...(this.#once.get(key) ?? []), ...replies]);
  }

  count(key: string): number {
    return this.calls.filter((call) => call.key === key).length;
  }

  readonly fetch: ChannelFetch = async (url, init) => {
    const parsed = new URL(url);
    const key = `${init.method} ${parsed.host}${parsed.pathname}`;
    this.calls.push({ key, url: parsed, authorization: init.headers.Authorization ?? "" });
    const queued = this.#once.get(key)?.shift();
    const handler =
      this.#handlers.get(key) ??
      [...this.#handlers].find(([prefix]) => prefix.endsWith("/") && key.startsWith(prefix))?.[1];
    const reply = queued ?? handler?.(parsed) ?? { status: 404, body: { error: "inconnu" } };
    if (reply === "reject") throw new Error("coupure simulée");
    const headers = reply.headers ?? {};
    return {
      status: reply.status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => (reply.body === undefined ? "" : JSON.stringify(reply.body)),
    };
  };
}

const ok = (body: unknown): Reply => ({ status: 200, body });

/** Un message Gmail doublé au format `full`. */
function gmailMessage(id: string, extra: { subject?: string; from?: string; at?: number; labels?: string[] } = {}) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: extra.labels ?? ["INBOX", "UNREAD"],
    snippet: "extrait",
    internalDate: String(extra.at ?? 1_800_000_000_000),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: extra.from ?? "Alice Martin <alice@exemple.fr>" },
        { name: "To", value: "moi@exemple.fr" },
        { name: "Subject", value: extra.subject ?? `Sujet ${id}` },
        { name: "List-Unsubscribe", value: "<mailto:stop@exemple.fr>" },
        { name: "Message-ID", value: `<${id}@exemple.fr>` },
        { name: "X-Ignore", value: "non gardé" },
      ],
      parts: [
        { mimeType: "text/html", body: { data: Buffer.from("<p>html</p>").toString("base64url") } },
        { mimeType: "text/plain", body: { data: Buffer.from(`Corps de ${id}`).toString("base64url") } },
      ],
    },
  };
}

/** `users.messages.get` doublé : tout identifiant connu rend son message. */
function serveMessages(provider: Provider, known: Map<string, ReturnType<typeof gmailMessage>>): void {
  provider.on(MESSAGE, (url) => {
    const id = url.pathname.split("/").at(-1) ?? "";
    const message = known.get(id);
    return message ? ok(message) : { status: 404, body: { error: { code: 404 } } };
  });
}

const added = (ids: string[], historyId: string, nextPageToken?: string) =>
  ok({
    history: ids.map((id, i) => ({ id: String(i), messagesAdded: [{ message: { id, threadId: `t-${id}` } }] })),
    historyId,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  });

// -- un harness dont les trois canaux sont connectés ---------------------------------------------

const worlds: FakeWorld[] = [];

function world(patch?: (config: FakeWorld["config"]) => void): { world: FakeWorld; provider: Provider } {
  const provider = new Provider();
  const w = fakeWorld({}, { fetch: provider.fetch, ...(patch === undefined ? {} : { patch }) });
  worlds.push(w);
  const expiresAt = Date.now() + 86_400_000;
  fs.mkdirSync(path.dirname(w.config.channelsFile), { recursive: true });
  fs.writeFileSync(
    w.config.channelsFile,
    JSON.stringify({
      version: 1,
      google: {
        clientId: "1234-abcdef.apps.googleusercontent.com",
        clientSecret: "secret-fictif",
        tokens: { access: GOOGLE_ACCESS, refresh: "1//refresh", expiresAt, scopes: [] },
      },
      slack: {
        clientId: "1234567.7654321",
        tokens: { access: SLACK_ACCESS, refresh: "xoxe-refresh", expiresAt, scopes: ["channels:history"] },
      },
    }),
    { mode: 0o600 },
  );
  const connected = { state: "connected", account: null, lastReadAt: null, error: null };
  w.store.setSetting("workstation.channels", { gmail: connected, calendar: connected, slack: connected }, null);
  return { world: w, provider };
}

test.after(async () => {
  for (const w of worlds) await w.orchestrator.stop();
});

const reader = (w: FakeWorld) => w.orchestrator.channelReader;
const outcome = (outcomes: ReadOutcome[], channel: string) => outcomes.find((o) => o.channel === channel);

// -- AC-1 : Gmail incrémental -------------------------------------------------------------------

test("lecture-canaux/AC-1 : 3 nouveaux messages Gmail lus deux fois de suite sont gardés une seule fois et le curseur d'historique avance", async () => {
  const { world: w, provider } = world();
  w.store.setChannelCursor("gmail", { historyId: "100" }, Date.now());
  const known = new Map(["m1", "m2", "m3"].map((id) => [id, gmailMessage(id)]));
  serveMessages(provider, known);
  provider.on(HISTORY, (url) =>
    url.searchParams.get("startHistoryId") === "100" ? added(["m1", "m2", "m3"], "105") : ok({ historyId: "105" }),
  );

  const first = await reader(w).pass();
  assert.deepEqual(outcome(first, "gmail"), { channel: "gmail", status: "read", added: 3, removed: 0 });
  const second = await reader(w).pass();
  assert.deepEqual(outcome(second, "gmail"), { channel: "gmail", status: "read", added: 0, removed: 0 });

  const messages = w.store.listChannelMessages({ channel: "gmail" });
  assert.deepEqual(
    messages.map((m) => m.id),
    ["gmail:m1", "gmail:m2", "gmail:m3"],
  );
  assert.equal(provider.count(`${MESSAGE.slice(0, -1)}/m1`), 1, "un message gardé n'est pas relu");
  const historyCalls = provider.calls
    .filter((c) => c.key === HISTORY)
    .map((c) => c.url.searchParams.get("startHistoryId"));
  assert.deepEqual(historyCalls, ["100", "105"], "le curseur avance");
  assert.deepEqual(w.store.getChannelCursor("gmail"), { historyId: "105" });

  // Les en-têtes utiles au tri, le fil, la date et le corps texte sont gardés ; le reste non.
  const [m1] = messages;
  assert.equal(m1?.threadId, "t-m1");
  assert.equal(m1?.at, 1_800_000_000_000);
  assert.equal(m1?.subject, "Sujet m1");
  assert.equal(m1?.author, "Alice Martin <alice@exemple.fr>");
  assert.equal(m1?.text, "Corps de m1");
  assert.deepEqual(Object.keys(m1?.headers ?? {}).sort(), ["From", "List-Unsubscribe", "Message-ID", "Subject", "To"]);
  assert.deepEqual(m1?.labels, ["INBOX", "UNREAD"]);
  // Les nouveautés depuis un `seq` : la veille relit à partir du dernier vu.
  assert.deepEqual(
    w.store.listChannelMessages({ afterSeq: m1?.seq ?? 0 }).map((m) => m.id),
    ["gmail:m2", "gmail:m3"],
  );
  // Chaque appel Gmail a porté le jeton Google ; aucun contenu dans le journal ni les événements.
  const google = provider.calls.filter((c) => c.url.host !== "slack.com");
  assert.ok(google.length > 0 && google.every((c) => c.authorization === `Bearer ${GOOGLE_ACCESS}`));
  const logged = JSON.stringify(w.log()) + JSON.stringify(w.store.eventsOfType("workstation_channel_read"));
  for (const secret of ["Sujet m1", "alice@exemple.fr", "Corps de m1"]) assert.equal(logged.includes(secret), false);
  assert.deepEqual(
    w.store.eventsOfType("workstation_channel_read").map((e) => [e.payload, e.repo]),
    [[{ channel: "gmail", added: 3, removed: 0 }, null]],
  );
});

// -- AC-2 : coupure au milieu d'une page, historique expiré -------------------------------------

test("lecture-canaux/AC-2 : une lecture Gmail coupée au milieu d'une page reprend sans perte ni doublon ; un historique expiré (404) déclenche une resynchronisation bornée sans doublon", async () => {
  const { world: w, provider } = world();
  w.store.setChannelCursor("gmail", { historyId: "200" }, Date.now());
  const known = new Map(["m1", "m2", "m3", "m4", "m5"].map((id) => [id, gmailMessage(id)]));
  serveMessages(provider, known);
  provider.on(HISTORY, (url) => {
    if (url.searchParams.get("startHistoryId") !== "200") return { status: 404, body: { error: { code: 404 } } };
    return url.searchParams.get("pageToken") === "p2" ? added(["m4"], "210") : added(["m1", "m2", "m3"], "210", "p2");
  });
  provider.once(`${MESSAGE.slice(0, -1)}/m2`, "reject");

  const cut = await reader(w).pass();
  assert.deepEqual(outcome(cut, "gmail"), { channel: "gmail", status: "failed", code: "network" });
  assert.deepEqual(w.store.getChannelCursor("gmail"), { historyId: "200" }, "le curseur n'a pas passé la page coupée");
  const resumed = await reader(w).pass();
  assert.deepEqual(outcome(resumed, "gmail"), { channel: "gmail", status: "read", added: 3, removed: 0 });
  assert.deepEqual(
    w.store.listChannelMessages({ channel: "gmail" }).map((m) => m.sourceId),
    ["m1", "m2", "m3", "m4"],
  );
  assert.equal(provider.count(`${MESSAGE.slice(0, -1)}/m1`), 1, "m1, gardé avant la coupure, n'est pas relu");
  assert.deepEqual(w.store.getChannelCursor("gmail"), { historyId: "210" });

  // L'historique expire : 404, resynchronisation bornée depuis la liste des messages récents.
  provider.on(PROFILE, () => ok({ emailAddress: "moi@exemple.fr", historyId: "300" }));
  provider.on(MESSAGES, () => ok({ messages: [{ id: "m5" }, { id: "m4" }, { id: "m3" }] }));
  const resynced = await reader(w).pass();
  assert.deepEqual(outcome(resynced, "gmail"), { channel: "gmail", status: "read", added: 1, removed: 0 });
  assert.deepEqual(
    w.store.listChannelMessages({ channel: "gmail" }).map((m) => [m.sourceId, m.origin]),
    [
      ["m1", "history"],
      ["m2", "history"],
      ["m3", "history"],
      ["m4", "history"],
      ["m5", "resync"],
    ],
  );
  assert.deepEqual(
    w.store.getChannelCursor("gmail"),
    { historyId: "300" },
    "l'historique repart du profil relevé avant",
  );
  const listed = provider.calls.find((c) => c.key === MESSAGES)?.url.searchParams;
  assert.match(listed?.get("q") ?? "", /^newer_than:\d+d$/);

  // Bornée : une boîte sans fin ne relit pas plus de GMAIL_RESYNC_MAX messages.
  let page = 0;
  provider.on(MESSAGES, (url) => {
    page++;
    const size = Number(url.searchParams.get("maxResults"));
    return ok({
      messages: Array.from({ length: size }, (_, i) => ({ id: `n${page}x${i}` })),
      nextPageToken: `p${page}`,
    });
  });
  provider.on(MESSAGE, (url) => ok(gmailMessage(url.pathname.split("/").at(-1) ?? "")));
  w.store.setChannelCursor("gmail", { historyId: "999" }, Date.now());
  const before = provider.count(MESSAGES);
  const bounded = await reader(w).pass();
  assert.deepEqual(outcome(bounded, "gmail"), {
    channel: "gmail",
    status: "read",
    added: GMAIL_RESYNC_MAX,
    removed: 0,
  });
  assert.equal(provider.count(MESSAGES) - before, Math.ceil(GMAIL_RESYNC_MAX / 100));
});

// -- AC-3 : Agenda incrémental ------------------------------------------------------------------

test("lecture-canaux/AC-3 : un événement à 3 participants puis son déplacement, lus deux fois, sont gardés une fois à la nouvelle heure avec les 3 participants ; annulé, il est retiré ; 410 resynchronise", async () => {
  const { world: w, provider } = world();
  const attendees = [
    { email: "moi@exemple.fr", self: true, responseStatus: "accepted" },
    { email: "alice@exemple.fr", displayName: "Alice", organizer: true, responseStatus: "accepted" },
    { email: "bob@exemple.fr", displayName: "Bob", responseStatus: "needsAction" },
  ];
  const event = (start: string, end: string, updated: string) => ({
    id: "ev1",
    status: "confirmed",
    summary: "Point projet",
    start: { dateTime: start },
    end: { dateTime: end },
    updated,
    attendees,
    organizer: { email: "alice@exemple.fr" },
    recurringEventId: "serie1",
    conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.exemple.fr/abc" }] },
  });
  provider.on(EVENTS, (url) => {
    const sync = url.searchParams.get("syncToken");
    if (sync === null)
      return ok({
        items: [event("2030-01-10T10:00:00Z", "2030-01-10T11:00:00Z", "2030-01-01T00:00:00Z")],
        nextSyncToken: "s1",
      });
    if (sync === "s1")
      return ok({
        items: [event("2030-01-10T14:00:00Z", "2030-01-10T15:00:00Z", "2030-01-02T00:00:00Z")],
        nextSyncToken: "s2",
      });
    if (sync === "s2") return ok({ items: [{ id: "ev1", status: "cancelled" }], nextSyncToken: "s3" });
    return { status: 410, body: { error: { code: 410 } } };
  });

  await reader(w).pass();
  const moved = await reader(w).pass();
  assert.deepEqual(outcome(moved, "calendar"), { channel: "calendar", status: "read", added: 1, removed: 0 });
  const events = w.store.listChannelEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.startAt, Date.parse("2030-01-10T14:00:00Z"));
  assert.deepEqual(
    events[0]?.attendees.map((a) => a.email),
    ["moi@exemple.fr", "alice@exemple.fr", "bob@exemple.fr"],
  );
  assert.equal(events[0]?.meetUrl, "https://meet.exemple.fr/abc");
  assert.equal(events[0]?.recurringEventId, "serie1");
  const first = provider.calls.find((c) => c.key === EVENTS)?.url.searchParams;
  assert.equal(first?.get("singleEvents"), "true");
  assert.ok(first?.get("timeMin"), "la première lecture part de maintenant (à venir)");

  const cancelled = await reader(w).pass();
  assert.deepEqual(outcome(cancelled, "calendar"), { channel: "calendar", status: "read", added: 0, removed: 1 });
  assert.equal(w.store.listChannelEvents().length, 0);

  // Jeton de synchronisation expiré (410) : la fenêtre à venir est relue en entier.
  w.store.putChannelEvent({
    id: "vieux",
    summary: null,
    startAt: 1,
    endAt: 2,
    allDay: false,
    organizer: null,
    attendees: [],
    meetUrl: null,
    recurringEventId: null,
    updatedAt: 1,
    readAt: 1,
  });
  const resynced = await reader(w).pass();
  assert.deepEqual(outcome(resynced, "calendar"), { channel: "calendar", status: "read", added: 1, removed: 1 });
  assert.deepEqual(
    w.store.listChannelEvents().map((e) => e.id),
    ["ev1"],
  );
  assert.deepEqual(w.store.getChannelCursor("calendar"), { syncToken: "s1" });
});

// -- AC-4 : Slack -------------------------------------------------------------------------------

/** Un espace Slack doublé : un DM, un canal suivi (2 messages), une mention dans un canal non suivi. */
function slackWorkspace(provider: Provider): void {
  const history: Record<string, { ts: string; user: string; text: string; subtype?: string }[]> = {
    D1: [{ ts: "1800000100.000100", user: "U2", text: "Salut, tu as vu le devis ?" }],
    C1: [
      { ts: "1800000200.000100", user: "U3", text: "Premier message du canal suivi" },
      { ts: "1800000300.000100", user: "U3", text: "Second message du canal suivi" },
      { ts: "1800000250.000100", user: "U3", text: "a rejoint", subtype: "channel_join" },
    ],
    C2: [{ ts: "1800000400.000100", user: "U5", text: "Canal non suivi" }],
  };
  provider.on(`${SLACK}auth.test`, () => ok({ ok: true, user_id: "U0", user: "moi", team: "Equipe" }));
  provider.on(`${SLACK}conversations.list`, (url) =>
    url.searchParams.get("types") === "im,mpim"
      ? ok({ ok: true, channels: [{ id: "D1", is_im: true, user: "U2" }] })
      : ok({
          ok: true,
          channels: [
            { id: "C1", name: "projet-alpha", is_private: false },
            { id: "C2", name: "general", is_private: false },
            { id: "G1", name: "equipe-privee", is_private: true },
          ],
        }),
  );
  provider.on(`${SLACK}conversations.history`, (url) => {
    const oldest = Number(url.searchParams.get("oldest") ?? "0");
    const messages = (history[url.searchParams.get("channel") ?? ""] ?? []).filter((m) => Number(m.ts) > oldest);
    return ok({ ok: true, messages: [...messages].reverse(), has_more: false });
  });
  provider.on(`${SLACK}search.messages`, () =>
    ok({
      ok: true,
      messages: {
        matches: [
          {
            ts: "1800000500.000100",
            user: "U4",
            text: "<@U0> peux-tu relire ?",
            channel: { id: "C9", name: "autre-canal" },
            permalink: "https://equipe.slack.exemple.fr/archives/C9/p1800000500000100",
          },
        ],
        paging: { pages: 1, page: 1 },
      },
    }),
  );
  provider.on(`${SLACK}users.info`, (url) => {
    const id = url.searchParams.get("user") ?? "";
    return ok({
      ok: true,
      user: {
        id,
        name: `user-${id}`,
        real_name: `Personne ${id}`,
        profile: { email: `${id.toLowerCase()}@exemple.fr` },
      },
    });
  });
}

test("lecture-canaux/AC-4 : un DM, une mention dans un canal non suivi et 2 messages d'un canal suivi, lus deux fois avec une coupure, sont gardés une fois avec leur auteur ; chaque appel porte le jeton utilisateur", async () => {
  const { world: w, provider } = world();
  slackWorkspace(provider);
  w.store.putSlackConversations([{ id: "C1", name: "projet-alpha", kind: "public", archived: false }], Date.now());
  w.store.setSlackConversationFollowed("C1", true);
  provider.once(`${SLACK}conversations.history`, ok({ ok: true, messages: [] }), "reject");

  const cut = await reader(w).pass();
  assert.deepEqual(outcome(cut, "slack"), { channel: "slack", status: "failed", code: "network" });
  const resumed = await reader(w).pass();
  assert.deepEqual(outcome(resumed, "slack"), { channel: "slack", status: "read", added: 4, removed: 0 });
  const again = await reader(w).pass();
  assert.deepEqual(outcome(again, "slack"), { channel: "slack", status: "read", added: 0, removed: 0 });

  const messages = w.store.listChannelMessages({ channel: "slack" });
  assert.deepEqual(messages.map((m) => [m.conversation, m.origin, m.author, m.authorName, m.authorEmail]).sort(), [
    ["C1", "followed", "U3", "Personne U3", "u3@exemple.fr"],
    ["C1", "followed", "U3", "Personne U3", "u3@exemple.fr"],
    ["C9", "search", "U4", "Personne U4", "u4@exemple.fr"],
    ["D1", "dm", "U2", "Personne U2", "u2@exemple.fr"],
  ]);
  assert.equal(messages.find((m) => m.conversation === "C9")?.mentionsMe, true);
  assert.equal(messages.find((m) => m.conversation === "D1")?.conversationKind, "im");
  // Le canal non suivi n'est lu que par la recherche des mentions.
  assert.equal(
    provider.calls.some((c) => c.key === `${SLACK}conversations.history` && c.url.searchParams.get("channel") === "C2"),
    false,
  );
  const slackCalls = provider.calls.filter((c) => c.url.host === "slack.com");
  assert.ok(slackCalls.length > 0);
  assert.ok(
    slackCalls.every((c) => c.authorization === `Bearer ${SLACK_ACCESS}`),
    "le jeton utilisateur, à chaque appel",
  );
  const logged = JSON.stringify(w.log());
  for (const secret of ["devis", "u2@exemple.fr", "Personne U3"]) assert.equal(logged.includes(secret), false);
});

// -- AC-5 : canaux suivis depuis omp-console ----------------------------------------------------

type Body = { error?: string; conversations?: SlackConversationRow[]; conversation?: SlackConversationRow };
type Api = {
  call: (method: string, route: string, body?: unknown, token?: string) => Promise<{ status: number; json: Body }>;
  approver: string;
  admin: string;
  viewer: string;
  narrow: string;
  close: () => Promise<void>;
};

async function serve(w: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("lecture-canaux-"), "clients.json"), ADMIN);
  const approver = clients.add("app-approbateur", "admin", "*", true).token;
  const admin = clients.add("mac", "admin", "*").token;
  const viewer = clients.add("ipad", "viewer", "*").token;
  const narrow = clients.add("mac-demo", "operator", ["demo"]).token;
  const server = http.createServer(createHandler({ orchestrator: w.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    approver,
    admin,
    viewer,
    narrow,
    call: async (method, route, body, token = approver) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, json: text.startsWith("{") ? JSON.parse(text) : null };
    },
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

const CONVERSATIONS = "/v1/workstation/channels/slack/conversations";

test("lecture-canaux/AC-5 : cocher un canal comme suivi fait entrer ce canal dans la lecture suivante, et pas les autres canaux non suivis (hors mentions et DM)", async () => {
  const { world: w, provider } = world();
  slackWorkspace(provider);
  const api = await serve(w);
  try {
    const listed = await api.call("GET", CONVERSATIONS, undefined, api.viewer);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.conversations, [
      { id: "G1", name: "equipe-privee", kind: "private", archived: false, followed: false },
      { id: "C2", name: "general", kind: "public", archived: false, followed: false },
      { id: "C1", name: "projet-alpha", kind: "public", archived: false, followed: false },
    ]);
    const types = provider.calls
      .filter((c) => c.key === `${SLACK}conversations.list`)
      .map((c) => c.url.searchParams.get("types"));
    assert.deepEqual(types, ["public_channel,private_channel"]);

    // Avant : seuls le DM et la recherche des mentions sont lus.
    await reader(w).pass();
    const read = () =>
      provider.calls
        .filter((c) => c.key === `${SLACK}conversations.history`)
        .map((c) => c.url.searchParams.get("channel"));
    assert.deepEqual(read(), ["D1"]);

    // Les gestes : approbateur seul, propriétaire seul, corps strict, conversation connue.
    assert.equal((await api.call("PUT", `${CONVERSATIONS}/C1`, { followed: true }, api.admin)).status, 403);
    const narrow = await api.call("PUT", `${CONVERSATIONS}/C1`, { followed: true }, api.narrow);
    assert.deepEqual([narrow.status, narrow.json.error], [403, "le poste est réservé au propriétaire"]);
    assert.equal((await api.call("GET", CONVERSATIONS, undefined, api.narrow)).status, 403);
    assert.equal((await api.call("PUT", `${CONVERSATIONS}/C1`, { followed: "oui" })).status, 400);
    assert.equal((await api.call("PUT", `${CONVERSATIONS}/C1`, { followed: true, name: "x" })).status, 400);
    assert.equal((await api.call("PUT", `${CONVERSATIONS}/C404`, { followed: true })).status, 404);

    const followed = await api.call("PUT", `${CONVERSATIONS}/C1`, { followed: true });
    assert.equal(followed.status, 200);
    assert.deepEqual(followed.json.conversation, {
      id: "C1",
      name: "projet-alpha",
      kind: "public",
      archived: false,
      followed: true,
    });
    assert.deepEqual(
      w.store.eventsOfType("workstation_channel_follow").map((e) => [e.payload, e.repo]),
      [[{ id: "C1", followed: true }, null]],
    );

    await reader(w).pass();
    assert.deepEqual(read(), ["D1", "D1", "C1"], "le canal coché entre dans la lecture suivante, pas C2 ni G1");
    const relisted = await api.call("GET", CONVERSATIONS, undefined, api.viewer);
    assert.equal(relisted.json.conversations?.find((c) => c.id === "C1")?.followed, true, "la case reste cochée");

    // Décoché : la lecture suivante ne le lit plus.
    assert.equal((await api.call("PUT", `${CONVERSATIONS}/C1`, { followed: false })).status, 200);
    await reader(w).pass();
    assert.deepEqual(read(), ["D1", "D1", "C1", "D1"]);

    // Slack non connecté : 409, aucune lecture ; poste désactivé : 404.
    const disconnected = { state: "disconnected", account: null, lastReadAt: null, error: null };
    w.store.setSetting("workstation.channels", { slack: disconnected }, null);
    const calls = provider.calls.length;
    assert.equal((await api.call("GET", CONVERSATIONS, undefined, api.viewer)).status, 409);
    assert.equal(provider.calls.length, calls);
    w.config.workstation.enabled = false;
    assert.equal((await api.call("GET", CONVERSATIONS, undefined, api.viewer)).status, 404);
    assert.equal((await api.call("PUT", `${CONVERSATIONS}/C1`, { followed: true })).status, 404);
  } finally {
    await api.close();
  }
});

// -- AC-6 : limites de débit --------------------------------------------------------------------

test("lecture-canaux/AC-6 : une réponse 429 avec Retry-After suspend la lecture de ce canal jusqu'à l'échéance, sans perte ni doublon", async () => {
  const { world: w, provider } = world();
  w.store.setChannelCursor("gmail", { historyId: "100" }, Date.now());
  const known = new Map(["m1", "m2", "m3"].map((id) => [id, gmailMessage(id)]));
  serveMessages(provider, known);
  provider.on(HISTORY, (url) =>
    url.searchParams.get("startHistoryId") === "100" ? added(["m1", "m2", "m3"], "105") : ok({ historyId: "105" }),
  );
  provider.on(EVENTS, () => ok({ items: [], nextSyncToken: "s1" }));
  provider.once(`${MESSAGE.slice(0, -1)}/m2`, { status: 429, headers: { "retry-after": "7" }, body: {} });

  const t0 = 1_900_000_000_000;
  const limited = await reader(w).pass(t0);
  assert.deepEqual(outcome(limited, "gmail"), { channel: "gmail", status: "rate_limited", until: t0 + 7000 });
  assert.equal(outcome(limited, "calendar")?.status, "read", "les autres canaux continuent");

  const gmailCalls = provider.calls.filter((c) => c.url.host === "gmail.googleapis.com").length;
  const waiting = await reader(w).pass(t0 + 6999);
  assert.deepEqual(outcome(waiting, "gmail"), { channel: "gmail", status: "skipped", reason: "suspended" });
  assert.equal(
    provider.calls.filter((c) => c.url.host === "gmail.googleapis.com").length,
    gmailCalls,
    "aucun appel avant l'échéance",
  );
  assert.equal(outcome(waiting, "calendar")?.status, "read");

  const after = await reader(w).pass(t0 + 7000);
  assert.deepEqual(outcome(after, "gmail"), { channel: "gmail", status: "read", added: 2, removed: 0 });
  assert.deepEqual(
    w.store.listChannelMessages({ channel: "gmail" }).map((m) => m.sourceId),
    ["m1", "m2", "m3"],
  );
  // L'état du canal ne bouge pas : une limite de débit n'est pas une panne.
  const gmail = w.orchestrator.channels.view(false).channels.find((c) => c.id === "gmail");
  assert.deepEqual([gmail?.state, gmail?.error], ["connected", null]);
});

// -- AC-7 : purge -------------------------------------------------------------------------------

test("lecture-canaux/AC-7 : les contenus plus vieux que workstation.retentionDays sont effacés par la purge du poste, et la vigie les retire des issues", () => {
  const { world: w } = world((config) => {
    config.workstation.retentionDays = 10;
  });
  const now = Date.now();
  const day = 86_400_000;
  const message = (id: string, at: number) => ({
    id: `gmail:${id}`,
    channel: "gmail" as const,
    sourceId: id,
    threadId: null,
    conversation: null,
    conversationKind: null,
    origin: "history" as const,
    author: "Alice Martin <alice@exemple.fr>",
    at,
    subject: `Sujet confidentiel ${id}`,
    text: `Corps confidentiel ${id}`,
    headers: {},
    labels: [],
    mentionsMe: false,
    bot: false,
    readAt: at,
  });
  w.store.addChannelMessage(message("vieux", now - 11 * day));
  w.store.addChannelMessage(message("recent", now - day));
  const event = (id: string, endAt: number) => ({
    id,
    summary: `Réunion ${id}`,
    startAt: endAt - 3_600_000,
    endAt,
    allDay: false,
    organizer: "alice@exemple.fr",
    attendees: [],
    meetUrl: null,
    recurringEventId: null,
    updatedAt: endAt,
    readAt: endAt,
  });
  w.store.putChannelEvent(event("passe", now - 12 * day));
  w.store.putChannelEvent(event("demain", now + day));
  w.store.putSlackUser(
    { id: "U9", name: "ancien", realName: "Ancien Collègue", email: "ancien@exemple.fr", bot: false },
    now - 20 * day,
  );

  // La vigie retire ces textes de ce qu'elle publie.
  const texts = w.store.workstationTexts(0);
  for (const text of ["Sujet confidentiel recent", "Corps confidentiel recent", "Réunion demain", "ancien@exemple.fr"])
    assert.ok(texts.includes(text), text);

  w.orchestrator.workstation.maintain(now);
  assert.deepEqual(
    w.store.listChannelMessages().map((m) => m.sourceId),
    ["recent"],
  );
  assert.deepEqual(
    w.store.listChannelEvents().map((e) => e.id),
    ["demain"],
  );
  assert.equal(w.store.getSlackUser("U9"), null);
  const logged = JSON.stringify(w.log());
  assert.equal(logged.includes("confidentiel"), false);
});

// -- AC-8 : aucun point d'envoi -----------------------------------------------------------------

test("lecture-canaux/AC-8 : les points de lecture ajoutés sont des GET de leur canal, aucun point d'envoi n'entre dans la liste blanche, et le client les refuse sans appel réseau", async () => {
  const reads = ALLOWLIST.filter((e) => e.method === "GET").map((e) => `${e.channel} ${e.host}${e.path}`);
  for (const expected of [
    "gmail gmail.googleapis.com/gmail/v1/users/me/history",
    "gmail gmail.googleapis.com/gmail/v1/users/me/messages",
    "gmail gmail.googleapis.com/gmail/v1/users/me/messages/{id}",
    "calendar www.googleapis.com/calendar/v3/calendars/primary/events",
    "slack slack.com/api/conversations.list",
    "slack slack.com/api/conversations.history",
    "slack slack.com/api/conversations.replies",
    "slack slack.com/api/search.messages",
    "slack slack.com/api/users.info",
  ])
    assert.ok(reads.includes(expected), expected);
  assert.deepEqual(
    ALLOWLIST.filter((e) => e.method !== "GET")
      .map((e) => `${e.method} ${e.host}${e.path}`)
      .sort(),
    [
      "DELETE gmail.googleapis.com/gmail/v1/users/me/drafts/{id}",
      "POST gmail.googleapis.com/gmail/v1/users/me/drafts",
      "POST oauth2.googleapis.com/token",
      "POST slack.com/api/oauth.v2.access",
      "PUT gmail.googleapis.com/gmail/v1/users/me/drafts/{id}",
    ],
  );

  const { world: w, provider } = world();
  const gmail = "https://gmail.googleapis.com/gmail/v1/users/me";
  const refused: [Parameters<typeof w.orchestrator.channels.request>[0], "GET" | "POST", string][] = [
    ["gmail", "POST", `${gmail}/messages/send`],
    ["gmail", "POST", `${gmail}/messages`],
    ["gmail", "GET", `${gmail}/messages/m1/attachments/a1`],
    ["gmail", "POST", `${gmail}/drafts/send`],
    ["slack", "GET", `https://slack.com/api/chat.${"postMessage"}`],
    ["slack", "POST", "https://slack.com/api/conversations.history"],
    ["calendar", "GET", `${gmail}/history`],
    ["gmail", "GET", "https://www.googleapis.com/calendar/v3/calendars/primary/events"],
    ["gmail", "GET", "https://slack.com/api/search.messages"],
  ];
  for (const [channel, method, url] of refused)
    await assert.rejects(w.orchestrator.channels.request(channel, { method, url }), ChannelRefused, `${method} ${url}`);
  assert.equal(provider.calls.length, 0);
});

// -- AC-5 côté omp-console : la case de l'écran Canaux, Mac et iOS ------------------------------

const CONSOLE = path.join(ROOT, "omp-console", "Sources");
/** Le code Swift sans ses commentaires : un nom cité en commentaire ne câble rien. */
const swift = (...parts: string[]) =>
  fs
    .readFileSync(path.join(CONSOLE, ...parts), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

test("lecture-canaux/AC-9 : l'écran Canaux d'omp-console (Mac et iOS) a la case « suivi » de chaque canal Slack, sur les routes servies et les champs réels du serveur", async () => {
  const model = swift("ConsoleClient", "WorkstationSlackConversations.swift");
  const views = swift("ConsoleUI", "WorkstationSlackFollowViews.swift");
  const screen = swift("ConsoleUI", "WorkstationChannelViews.swift");
  // Les routes appelées par le client sont servies, au rôle attendu.
  assert.ok(model.includes('HarnessCall(method: "GET", path: "/v1/workstation/channels/slack/conversations")'));
  assert.ok(model.includes('method: "PUT",'));
  assert.ok(model.includes('path: "/v1/workstation/channels/slack/conversations/\\(HarnessModel.pathComponent(id))"'));
  const { world: w, provider } = world();
  slackWorkspace(provider);
  const routes = apiRoutes(w.orchestrator, new ClientRegistry(null, "t".repeat(64)));
  const served = (method: string, sample: string) =>
    routes.find((route) => route.method === method && route.pattern.test(sample))?.role;
  assert.equal(served("GET", "/v1/workstation/channels/slack/conversations"), "viewer");
  assert.equal(served("PUT", "/v1/workstation/channels/slack/conversations/C1"), "operator");
  assert.ok(API_FEATURES.includes("workstation-channel-reads"));

  // Chaque champ décodé existe dans le JSON RÉEL du serveur.
  const api = await serve(w);
  try {
    const listed = await api.call("GET", CONVERSATIONS, undefined, api.viewer);
    assert.equal(listed.status, 200);
    const fields = swiftFields(model, "WorkstationSlackConversation");
    for (const conversation of listed.json.conversations ?? [])
      covers(conversation as unknown as Record<string, unknown>, fields, "conversation");
    covers(listed.json as Record<string, unknown>, swiftFields(model, "WorkstationSlackConversationsReply"), "liste");
    const followed = await api.call("PUT", `${CONVERSATIONS}/C1`, { followed: true });
    covers(followed.json as Record<string, unknown>, swiftFields(model, "WorkstationSlackConversationReply"), "geste");
    covers(followed.json.conversation as unknown as Record<string, unknown>, fields, "conversation");
  } finally {
    await api.close();
  }

  // L'écran : la section en fin de page, seulement quand Slack est lisible ; une case par canal,
  // grisée hors de l'appareil approbateur ; le refus revient sous la liste.
  assert.match(
    screen,
    /if channels\.channels\.contains\(where: \{ \$0\.id == "slack" && \(\$0\.state == "connected" \|\| \$0\.state == "error"\) \}\) \{\s*SlackFollowSection\(conversations: channels\.slackConversations, isApprover: channels\.isApprover\)/,
  );
  assert.ok(views.includes("Toggle(isOn: followed(conversation))"));
  assert.ok(views.includes(".disabled(!isApprover || conversations.busy.contains(conversation.id))"));
  assert.ok(views.includes("try await conversations.setFollowed(conversation.id, next)"));
  assert.ok(views.includes("failure == .approverOnly ? ChannelText.approverOnly : failure.message"));
  for (const text of ["SlackFollowText.header", "SlackFollowText.hint", "SlackFollowText.empty"])
    assert.ok(views.includes(text), text);
  assert.match(swift("ConsoleCore", "Design", "WorkstationText.swift"), /public enum SlackFollowText \{/);
  // Le modèle est porté par celui des canaux (Mac et iOS le partagent), relit sur l'événement du serveur.
  const channels = swift("ConsoleClient", "WorkstationChannels.swift");
  assert.match(channels, /lazy var slackConversations = WorkstationSlackConversationsModel\(harness: harness\)/);
  assert.match(channels, /slackConversations\.receive\(names\)/);
  assert.match(channels, /slackConversations\.reset\(\)/);
  assert.ok(model.includes('names.contains("workstation_channel_follow")'));
});
