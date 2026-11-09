// Feature poste-canaux (OS agentique 4/6, part « connexion des canaux ») : le harness se
// connecte par OAuth à un compte Google (Gmail, Agenda) et à un espace Slack, garde les jetons
// dans un fichier 0600 hors base, les renouvelle, dit l'état de chaque canal, et n'appelle
// que des points d'API en liste blanche (aucun envoi). Google et Slack sont des doublures
// derrière l'option `fetch` : aucun réseau.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { snapshot } from "../../omp-harness/backup.ts";
import { ALLOWLIST } from "../../omp-harness/canaux/allowlist.ts";
import type { ChannelFetch, ChannelId } from "../../omp-harness/canaux/channels.ts";
import { Channels } from "../../omp-harness/canaux/channels.ts";
import {
  ChannelApiError,
  ChannelNetworkError,
  ChannelRateLimited,
  ChannelRefused,
  ChannelUnavailable,
} from "../../omp-harness/canaux/errors.ts";
import { defaultConfig, loadConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import { HarnessError } from "../../omp-harness/errors.ts";
import { apiRoutes, createHandler } from "../../omp-harness/http.ts";
import type { Route } from "../../omp-harness/http.ts";
import { loginArgv, loginEnv } from "../../omp-harness/oauth.ts";
import { runnerArgv, runnerEnv } from "../../omp-harness/runner.ts";
import { fakeWorld, testConfig, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ADMIN = "a".repeat(64);
const TABS = { "X-OMP-Agent-Tabs": "1,2,3" };
const GOOGLE = "https://www.googleapis.com/auth/";
const GMAIL_READ = `${GOOGLE}gmail.readonly`;
const GMAIL_COMPOSE = `${GOOGLE}gmail.compose`;
const CALENDAR_READ = `${GOOGLE}calendar.readonly`;
const ALL_GOOGLE = [GMAIL_READ, GMAIL_COMPOSE, CALENDAR_READ];
const PROFILE = { method: "GET", url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" } as const;
const CALENDAR = { method: "GET", url: "https://www.googleapis.com/calendar/v3/calendars/primary" } as const;
const AUTH_TEST = { method: "GET", url: "https://slack.com/api/auth.test" } as const;
const GOOGLE_TOKEN = "POST oauth2.googleapis.com/token";
const SLACK_TOKEN = "POST slack.com/api/oauth.v2.access";
const GOOGLE_CLIENT = {
  installed: { client_id: "1234-abcdef.apps.googleusercontent.com", client_secret: "client-secret-value-0001" },
};
const SLACK_CLIENT = "1234567.7654321";
const SLACK_SCOPES = (
  JSON.parse(fs.readFileSync(path.join(ROOT, "omp-harness/deploy/slack-app-manifest.json"), "utf8")) as {
    oauth_config: { scopes: { user: string[] } };
  }
).oauth_config.scopes.user;
const BLOCKED = "bloqué par l'administrateur de l'entreprise : la veille ne lit pas ce canal, le poste continue par le navigateur";

// -- la doublure de Google et de Slack -----------------------------------------------------------

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "reject";
type Seen = { method: string; key: string; url: string; headers: Record<string, string>; body: string };

class Provider {
  readonly calls: Seen[] = [];
  readonly #queues = new Map<string, Reply[]>();
  /** Les scopes que Google accorde à l'échange. */
  googleScopes = ALL_GOOGLE;
  /** Le corps que Slack rend à l'échange ; `null` : celui d'un jeton utilisateur valide. */
  slackGrant: Record<string, unknown> | null = null;
  #renewed = 0;

  /** Les réponses de `key` (« MÉTHODE hôte/chemin ») avant le comportement par défaut. */
  queue(key: string, ...replies: Reply[]): void {
    this.#queues.set(key, [...(this.#queues.get(key) ?? []), ...replies]);
  }

  count(key: string): number {
    return this.calls.filter((call) => call.key === key).length;
  }

  readonly fetch: ChannelFetch = async (url, init) => {
    const parsed = new URL(url);
    const key = `${init.method} ${parsed.host}${parsed.pathname}`;
    this.calls.push({ method: init.method, key, url, headers: init.headers, body: init.body ?? "" });
    const form = new URLSearchParams(init.body ?? "");
    const queued = this.#queues.get(key)?.shift();
    const reply = queued ?? this.#default(key, form);
    if (reply === "reject") throw new Error("coupure simulée");
    const headers = reply.headers ?? {};
    return {
      status: reply.status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => (reply.body === undefined ? "" : JSON.stringify(reply.body)),
    };
  };

  #default(key: string, form: URLSearchParams): Reply {
    switch (key) {
      case GOOGLE_TOKEN:
        if (form.get("grant_type") === "refresh_token")
          return { status: 200, body: { access_token: `ya29.renewed-${++this.#renewed}`, expires_in: 3600 } };
        return {
          status: 200,
          body: {
            access_token: "ya29.first-access",
            refresh_token: "1//first-refresh",
            expires_in: 3600,
            scope: this.googleScopes.join(" "),
            token_type: "Bearer",
          },
        };
      case SLACK_TOKEN:
        if (form.get("grant_type") === "refresh_token")
          return {
            status: 200,
            body: {
              ok: true,
              access_token: `xoxe.xoxp-renewed-${++this.#renewed}`,
              token_type: "user",
              expires_in: 43200,
              refresh_token: `xoxe-refresh-${this.#renewed}`,
            },
          };
        return {
          status: 200,
          body: this.slackGrant ?? {
            ok: true,
            authed_user: {
              id: "U1",
              scope: SLACK_SCOPES.join(","),
              access_token: "xoxe.xoxp-first-access",
              token_type: "user",
              expires_in: 43200,
              refresh_token: "xoxe-first-refresh",
            },
            team: { id: "T1", name: "Equipe" },
          },
        };
      case "GET gmail.googleapis.com/gmail/v1/users/me/profile":
        return { status: 200, body: { emailAddress: "moi@example.org", historyId: "1" } };
      case "GET www.googleapis.com/calendar/v3/calendars/primary":
        return { status: 200, body: { id: "moi@example.org", summary: "moi@example.org" } };
      case "GET slack.com/api/auth.test":
        return { status: 200, body: { ok: true, user: "moi", team: "Equipe" } };
      default:
        return { status: 404, body: { error: "inconnu" } };
    }
  }
}

// -- un environnement léger (Channels seul, horloge injectée) -----------------------------------

type Env = {
  provider: Provider;
  channels: Channels;
  store: Store;
  file: string;
  clock: { now: number };
  events: { type: string; payload: Record<string, unknown> }[];
  logs: string[];
};

const stores: Store[] = [];

function env(): Env {
  const dir = tmpdir("poste-canaux-");
  const config = defaultConfig(dir);
  const store = new Store(path.join(dir, "harness.sqlite"));
  stores.push(store);
  const provider = new Provider();
  const clock = { now: 1_800_000_000_000 };
  const events: Env["events"] = [];
  const logs: string[] = [];
  const channels = new Channels({
    config,
    store,
    event: (type, runId, payload, repo) => {
      events.push({ type, payload: payload ?? {} });
      store.appendEvent(type, runId, payload ?? {}, repo ?? null);
    },
    log: (line) => void logs.push(line),
    fetch: provider.fetch,
    now: () => clock.now,
  });
  return { provider, channels, store, file: config.channelsFile, clock, events, logs };
}

test.after(() => {
  for (const store of stores) store.close();
});

const stateOf = (channels: Channels, id: ChannelId) => channels.view(true).channels.find((c) => c.id === id)!;
type TokensRow = { access: string; refresh: string; expiresAt: number; scopes: string[] };
type FileRow = {
  google: { clientId: string; clientSecret: string; tokens: TokensRow };
  slack: { clientId: string; tokens: TokensRow };
};
/** Les corps JSON rendus par l'API, tels que les tests les lisent. */
type LoginRow = {
  id: string;
  connection: string;
  state: string;
  url: string | null;
  startedAt: number;
  expiresAt: number;
  error: string | null;
};
type ChannelRow = { id: string; state: string; account: string | null; lastReadAt: number | null; error: string | null };
type ConnectionRow = { id: string; clientId: string | null; clientConfigured: boolean; login: LoginRow | null };
type Body = {
  error: string;
  login: LoginRow;
  channels: ChannelRow[];
  connection: ConnectionRow;
  connections: ConnectionRow[];
  request: { id: string };
};
const fileOf = (e: Env) => JSON.parse(fs.readFileSync(e.file, "utf8")) as FileRow;
const stateParam = (url: string | null) => new URL(url as string).searchParams.get("state") as string;
const back = (state: string, extra = "code=c") => `http://127.0.0.1/omp-canaux?${extra}&state=${state}`;

async function connectGoogle(e: Env, channels?: ChannelId[]): Promise<void> {
  e.channels.setClient("google", { json: GOOGLE_CLIENT }, "test");
  const { login } = e.channels.startLogin("google", channels ? { channels } : {});
  await e.channels.answer("google", { value: back(stateParam(login.url)) });
}

async function connectSlack(e: Env): Promise<void> {
  e.channels.setClient("slack", { clientId: SLACK_CLIENT }, "test");
  const { login } = e.channels.startLogin("slack", {});
  await e.channels.answer("slack", { value: `http://localhost/omp-canaux?code=c&state=${stateParam(login.url)}` });
}

const rejectsWith = (promise: Promise<unknown>, status: number, message: RegExp) =>
  assert.rejects(promise, (err) => err instanceof HarnessError && err.status === status && message.test(err.message));

// -- le serveur HTTP -------------------------------------------------------------------------------

type Api = {
  approver: string;
  admin: string;
  viewer: string;
  narrow: string;
  call: <T = Body>(
    method: string,
    route: string,
    body?: unknown,
    token?: string,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; json: T; text: string }>;
  close: () => Promise<void>;
  routes: Route[];
};

async function serve(world: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("poste-canaux-"), "clients.json"), ADMIN);
  const approver = clients.add("app-approbateur", "admin", "*", true).token;
  const admin = clients.add("mac", "admin", "*").token;
  const viewer = clients.add("ipad", "viewer", "*").token;
  const narrow = clients.add("mac-demo", "operator", ["demo"]).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    approver,
    admin,
    viewer,
    narrow,
    routes: apiRoutes(world.orchestrator, clients),
    call: async (method, route, body, token = approver, headers = {}) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null, text };
    },
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

async function setup(scenario: Record<string, unknown> = {}): Promise<{ world: FakeWorld; api: Api; provider: Provider }> {
  const provider = new Provider();
  const world = fakeWorld(scenario, { fetch: provider.fetch });
  return { world, api: await serve(world), provider };
}

async function teardown(world: FakeWorld, api: Api): Promise<void> {
  await api.close();
  await world.orchestrator.stop();
}

const CHANNELS = "/v1/workstation/channels";

async function login(api: Api, id: "google" | "slack", body?: unknown) {
  const reply = await api.call(`POST`, `${CHANNELS}/${id}/login`, body);
  return {
    reply,
    url: reply.status === 201 ? new URL(reply.json.login.url as string) : null,
    state: reply.json?.login?.url ? stateParam(reply.json.login.url) : "",
  };
}

const view = async (api: Api, token = api.approver) => (await api.call("GET", CHANNELS, undefined, token)).json;
const channelOf = (body: { channels: ChannelRow[] }, id: string) => body.channels.find((c) => c.id === id)!;

// =================================================================================================

test("poste-canaux/AC-1 : l'approbateur saisit les clients, ouvre l'URL (PKCE + state), recolle l'URL de retour : canaux connectés, jetons en 0600 hors base, événements, environnement et réponses", async () => {
  const { world, api, provider } = await setup();
  try {
    // Un serveur sans client : tout est « non connecté », le GET est au propriétaire, jamais aux clients restreints.
    const first = await view(api);
    assert.deepEqual(
      first.channels.map((c: { id: string; state: string }) => [c.id, c.state]),
      [["gmail", "disconnected"], ["calendar", "disconnected"], ["slack", "disconnected"]],
    );
    assert.deepEqual(first.connections, [
      { id: "google", clientId: null, clientConfigured: false, login: null },
      { id: "slack", clientId: null, clientConfigured: false, login: null },
    ]);
    assert.equal((await api.call("GET", CHANNELS, undefined, api.viewer)).status, 200);
    assert.equal((await api.call("GET", CHANNELS, undefined, api.narrow)).status, 403);

    // Saisie des identifiants : l'approbateur seul ; sans client, pas de connexion.
    const noClient = await api.call("POST", `${CHANNELS}/google/login`, {});
    assert.deepEqual([noClient.status, noClient.json.error], [409, "configurez d'abord le client de google dans l'écran Canaux"]);
    const refused = await api.call("PUT", `${CHANNELS}/google/client`, { json: GOOGLE_CLIENT }, api.admin);
    assert.equal(refused.status, 403);
    assert.equal((await api.call("PUT", `${CHANNELS}/google/client`, { json: GOOGLE_CLIENT }, api.viewer)).status, 403);
    assert.equal((await api.call("PUT", `${CHANNELS}/google/client`, { json: GOOGLE_CLIENT }, api.narrow)).status, 403);
    assert.equal(fs.existsSync(world.config.channelsFile), false, "rien n'est écrit par un refus");
    const saved = await api.call("PUT", `${CHANNELS}/google/client`, { json: GOOGLE_CLIENT });
    assert.deepEqual(saved.json, {
      connection: { id: "google", clientId: GOOGLE_CLIENT.installed.client_id, clientConfigured: true, login: null },
    });
    assert.equal(
      (await api.call("PUT", `${CHANNELS}/slack/client`, { clientId: SLACK_CLIENT })).json.connection.clientId,
      SLACK_CLIENT,
    );
    assert.equal((await api.call("PUT", `${CHANNELS}/inconnu/client`, { clientId: "x" })).status, 404);
    assert.equal((await api.call("PUT", `${CHANNELS}/slack/client`, { clientId: SLACK_CLIENT, clientSecret: "s" })).status, 400);
    assert.equal((await api.call("PUT", `${CHANNELS}/google/client`, { json: { web: { client_id: "x" } } })).status, 400);

    // L'URL d'autorisation de Google : PKCE, state, scopes de lecture + brouillons, retour loopback.
    const google = await login(api, "google");
    assert.equal(google.reply.status, 201);
    const params = google.url!.searchParams;
    assert.equal(`${google.url!.origin}${google.url!.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(params.get("client_id"), GOOGLE_CLIENT.installed.client_id);
    assert.equal(params.get("redirect_uri"), "http://127.0.0.1/omp-canaux");
    assert.equal(params.get("response_type"), "code");
    assert.equal(params.get("scope"), ALL_GOOGLE.join(" "));
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.match(params.get("state") as string, /^[0-9a-f]{32}$/);
    assert.equal(params.get("access_type"), "offline");
    assert.equal(params.get("prompt"), "consent");
    assert.equal(params.has("include_granted_scopes"), false, "une demande complète n'est pas incrémentale");
    assert.deepEqual(Object.keys(google.reply.json.login).sort(), ["connection", "error", "expiresAt", "id", "startedAt", "state", "url"]);

    // Le GET rend l'URL à l'approbateur seul.
    assert.equal((await view(api)).connections[0]!.login!.url, google.reply.json.login.url);
    assert.equal((await view(api, api.viewer)).connections[0]!.login!.url, null);
    assert.equal((await view(api, api.viewer)).connections[0]!.login!.state, "waiting");

    // Un state étranger : 400, aucun appel au point de jeton.
    const foreign = await api.call("POST", `${CHANNELS}/google/login/answer`, { value: back("0".repeat(32)) });
    assert.equal(foreign.status, 400);
    assert.match(foreign.json.error, /state étranger/);
    assert.equal(provider.count(GOOGLE_TOKEN), 0);

    // Le retour : l'échange porte le vérificateur dont l'URL portait le défi.
    const done = await api.call("POST", `${CHANNELS}/google/login/answer`, { value: back(google.state) });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.login.state, "done");
    assert.equal(done.json.login.url, null);
    const exchange = new URLSearchParams(provider.calls.find((call) => call.key === GOOGLE_TOKEN)!.body);
    assert.equal(createHash("sha256").update(exchange.get("code_verifier") as string).digest("base64url"), params.get("code_challenge"));
    assert.deepEqual(
      [exchange.get("grant_type"), exchange.get("code"), exchange.get("redirect_uri"), exchange.get("client_secret")],
      ["authorization_code", "c", "http://127.0.0.1/omp-canaux", GOOGLE_CLIENT.installed.client_secret],
    );
    for (const id of ["gmail", "calendar"]) {
      const channel = channelOf(await view(api), id);
      assert.deepEqual([channel.state, channel.account, channel.error], ["connected", "moi@example.org", null]);
      assert.equal(typeof channel.lastReadAt, "number");
    }
    assert.equal(
      provider.calls.every((call) => call.key === GOOGLE_TOKEN || call.headers.Authorization === "Bearer ya29.first-access"),
      true,
      "chaque lecture porte le jeton d'accès",
    );

    // Slack : l'URL, puis le retour.
    const slack = await login(api, "slack");
    const sp = slack.url!.searchParams;
    assert.equal(`${slack.url!.origin}${slack.url!.pathname}`, "https://slack.com/oauth/v2/authorize");
    assert.deepEqual(
      [sp.get("client_id"), sp.get("user_scope"), sp.get("redirect_uri"), sp.has("scope"), sp.get("code_challenge_method")],
      [SLACK_CLIENT, SLACK_SCOPES.join(","), "http://localhost/omp-canaux", false, "S256"],
    );
    const slackDone = await api.call("POST", `${CHANNELS}/slack/login/answer`, { value: `http://localhost/omp-canaux?code=s&state=${slack.state}` });
    assert.equal(slackDone.status, 200, JSON.stringify(slackDone.json));
    const slackExchange = new URLSearchParams(provider.calls.find((call) => call.key === SLACK_TOKEN)!.body);
    assert.equal(slackExchange.has("client_secret"), false, "Slack en PKCE : aucun secret client");
    assert.equal(createHash("sha256").update(slackExchange.get("code_verifier") as string).digest("base64url"), sp.get("code_challenge"));
    const slackChannel = channelOf(await view(api), "slack");
    assert.deepEqual([slackChannel.state, slackChannel.account], ["connected", "moi @ Equipe"]);

    // Le fichier : 0600, jetons et secret dedans ; nulle part ailleurs.
    assert.equal(fs.statSync(world.config.channelsFile).mode & 0o777, 0o600);
    const file = JSON.parse(fs.readFileSync(world.config.channelsFile, "utf8"));
    assert.equal(file.google.clientSecret, GOOGLE_CLIENT.installed.client_secret);
    assert.equal(file.google.tokens.access, "ya29.first-access");
    assert.equal(file.slack.tokens.refresh, "xoxe-first-refresh");
    assert.deepEqual(file.google.tokens.scopes, ALL_GOOGLE);
    const secrets = [
      GOOGLE_CLIENT.installed.client_secret,
      "ya29.first-access",
      "1//first-refresh",
      "xoxe.xoxp-first-access",
      "xoxe-first-refresh",
      exchange.get("code_verifier") as string,
      slackExchange.get("code_verifier") as string,
      google.state,
      slack.state,
    ];
    const clean = (where: string, bytes: string | Buffer) => {
      const text = typeof bytes === "string" ? bytes : bytes.toString("latin1");
      for (const secret of secrets) assert.equal(text.includes(secret), false, `${where} ne contient pas ${secret.slice(0, 8)}…`);
    };
    const dbFile = path.join(world.config.dataDir, "harness.sqlite");
    clean("harness.sqlite", fs.readFileSync(dbFile));
    if (fs.existsSync(`${dbFile}-wal`)) clean("harness.sqlite-wal", fs.readFileSync(`${dbFile}-wal`));
    clean("une sauvegarde", fs.readFileSync(snapshot(world.store.db, tmpdir("poste-canaux-snap-"), "periodique")));
    clean("process.env", JSON.stringify(process.env));
    const events = world.store.db.prepare("SELECT type, payload FROM events").all();
    clean("les événements", JSON.stringify(events));
    assert.equal(events.some((event) => event.type === "workstation_channel"), true, "un événement par changement d'état");
    const gets = api.routes.filter((route) => route.method === "GET" && !route.path.includes("{"));
    assert.ok(gets.length > 10);
    for (const route of gets) {
      if (route.path === "/v1/workstation/next") continue;
      clean(`GET ${route.path}`, (await api.call("GET", route.path)).text);
    }

    // Une connexion n'a pas de route de rappel.
    assert.equal(api.routes.some((route) => /callback|oauth2callback/i.test(route.path) && route.path.includes("workstation")), false);
    assert.equal(api.routes.filter((route) => route.path.startsWith(CHANNELS)).length, 4);
  } finally {
    await teardown(world, api);
  }

  // Une connexion expirée (horloge injectée, +10 min) : 400, relancer.
  const e = env();
  e.channels.setClient("google", { json: GOOGLE_CLIENT }, "test");
  const { login: started } = e.channels.startLogin("google", {});
  e.clock.now += 10 * 60 * 1000;
  await rejectsWith(e.channels.answer("google", { value: back(stateParam(started.url)) }), 400, /connexion expirée/);
  assert.equal(e.provider.count(GOOGLE_TOKEN), 0);
  assert.equal(e.channels.view(true).connections[0]?.login?.state, "failed");
  await rejectsWith(e.channels.answer("google", { value: "c" }), 409, /aucune connexion en cours pour google/);
});

test("poste-canaux/AC-2 : un scope hors liste, un jeton de bot ou un scope manquant refuse la connexion sans garder de jeton ; une connexion Google partielle garde le canal couvert", async () => {
  const noTokens = (e: Env, connection: "google" | "slack") => assert.equal(fileOf(e)[connection].tokens, undefined);

  // Google accorde en plus un scope d'écriture.
  let e = env();
  e.provider.googleScopes = [...ALL_GOOGLE, `${GOOGLE}gmail.modify`];
  e.channels.setClient("google", { json: GOOGLE_CLIENT }, "t");
  let started = e.channels.startLogin("google", {});
  await rejectsWith(e.channels.answer("google", { value: back(stateParam(started.login.url)) }), 409, /scope en trop : .*gmail\.modify/);
  noTokens(e, "google");
  assert.equal(stateOf(e.channels, "gmail").state, "error");
  assert.match(stateOf(e.channels, "gmail").error as string, /gmail\.modify/);

  // Slack rend un jeton de bot à la racine.
  e = env();
  e.provider.slackGrant = { ok: true, access_token: "xoxb-bot", token_type: "bot", bot_user_id: "B1", authed_user: { id: "U1" } };
  e.channels.setClient("slack", { clientId: SLACK_CLIENT }, "t");
  started = e.channels.startLogin("slack", {});
  await rejectsWith(e.channels.answer("slack", { value: `http://localhost/omp-canaux?code=c&state=${stateParam(started.login.url)}` }), 409, /jeton de bot refusé/);
  noTokens(e, "slack");

  // Slack avec un scope d'écriture en plus.
  e = env();
  e.provider.slackGrant = {
    ok: true,
    authed_user: { id: "U1", scope: [...SLACK_SCOPES, "chat:write"].join(","), access_token: "xoxe.xoxp-1", token_type: "user", expires_in: 43200, refresh_token: "xoxe-1" },
  };
  e.channels.setClient("slack", { clientId: SLACK_CLIENT }, "t");
  started = e.channels.startLogin("slack", {});
  await rejectsWith(e.channels.answer("slack", { value: `http://localhost/omp-canaux?code=c&state=${stateParam(started.login.url)}` }), 409, /scope en trop : chat:write/);
  noTokens(e, "slack");

  // Slack sans rotation des jetons.
  e = env();
  e.provider.slackGrant = {
    ok: true,
    authed_user: { id: "U1", scope: SLACK_SCOPES.join(","), access_token: "xoxp-1", token_type: "user" },
  };
  e.channels.setClient("slack", { clientId: SLACK_CLIENT }, "t");
  started = e.channels.startLogin("slack", {});
  await rejectsWith(e.channels.answer("slack", { value: `http://localhost/omp-canaux?code=c&state=${stateParam(started.login.url)}` }), 409, /rotation des jetons absente/);
  noTokens(e, "slack");

  // Google n'accorde que l'Agenda : l'Agenda est connecté (sondé), Gmail ne l'est pas et n'est jamais lu.
  e = env();
  e.provider.googleScopes = [CALENDAR_READ];
  e.channels.setClient("google", { json: GOOGLE_CLIENT }, "t");
  started = e.channels.startLogin("google", {});
  const partial = await e.channels.answer("google", { value: back(stateParam(started.login.url)) });
  assert.equal(partial.login.state, "done");
  assert.equal(stateOf(e.channels, "calendar").state, "connected");
  assert.equal(stateOf(e.channels, "gmail").state, "disconnected");
  assert.match(stateOf(e.channels, "gmail").error as string, /^scope non accordé : .*gmail\.readonly/);
  assert.equal(e.provider.count("GET gmail.googleapis.com/gmail/v1/users/me/profile"), 0, "Gmail n'est pas sondé");
  const before = e.provider.calls.length;
  await assert.rejects(e.channels.request("gmail", PROFILE), (err) => err instanceof ChannelUnavailable && err.state === "disconnected");
  assert.equal(e.provider.calls.length, before, "aucun appel réseau");

  // Gmail en lecture sans brouillons ni Agenda : aucun canal demandé n'est couvert.
  e = env();
  e.provider.googleScopes = [GMAIL_READ];
  e.channels.setClient("google", { json: GOOGLE_CLIENT }, "t");
  started = e.channels.startLogin("google", {});
  await rejectsWith(e.channels.answer("google", { value: back(stateParam(started.login.url)) }), 409, /scope manquant : .*gmail\.compose/);
  noTokens(e, "google");

  // Pas de jeton de rafraîchissement : refusé.
  e = env();
  e.provider.queue(GOOGLE_TOKEN, { status: 200, body: { access_token: "ya29.x", expires_in: 3600, scope: ALL_GOOGLE.join(" ") } });
  e.channels.setClient("google", { json: GOOGLE_CLIENT }, "t");
  started = e.channels.startLogin("google", {});
  await rejectsWith(e.channels.answer("google", { value: back(stateParam(started.login.url)) }), 409, /aucun jeton de rafraîchissement rendu/);
  noTokens(e, "google");
});

test("poste-canaux/AC-3 : le manifeste Slack ne déclare aucun bot, que des scopes de lecture, PKCE, rotation, retour localhost et aucun identifiant", () => {
  const file = path.join(ROOT, "omp-harness/deploy/slack-app-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(manifest.display_information.name, "OMP Poste");
  assert.equal(manifest.features?.bot_user, undefined);
  assert.equal(manifest.oauth_config.scopes.bot, undefined);
  assert.deepEqual(manifest.oauth_config.scopes.user, [
    "channels:history",
    "groups:history",
    "im:history",
    "mpim:history",
    "channels:read",
    "groups:read",
    "im:read",
    "mpim:read",
    "users:read",
    "users:read.email",
    "search:read",
  ]);
  assert.deepEqual(manifest.oauth_config.redirect_urls, ["http://localhost/omp-canaux"]);
  assert.equal(manifest.oauth_config.pkce_enabled, true);
  assert.equal(manifest.settings.token_rotation_enabled, true);
  assert.equal(manifest.settings.org_deploy_enabled, false);
  assert.equal(manifest.settings.socket_mode_enabled, false);
  const values: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") values.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(manifest);
  for (const value of values) {
    assert.equal(/^\d+\.\d+$/.test(value), false, `${value} ressemble à un identifiant de client`);
    assert.equal(/xox|^[0-9a-f]{32,}$/i.test(value), false, `${value} ressemble à un secret`);
    if (/^[a-z]+:\/\//.test(value)) assert.match(value, /^http:\/\/localhost(\/|$)/);
  }
});

test("poste-canaux/AC-4 : un blocage par l'administrateur se dit par canal (page recollée, refus d'échange ou déclaration), connexion partielle comprise, et le poste continue", async () => {
  const { world, api, provider } = await setup({ "poste-demande": [[{ tool: "workstation_request_report", args: { report: "rien à faire" } }]] });
  const answer = (id: "google" | "slack", body: unknown) => api.call("POST", `${CHANNELS}/${id}/login/answer`, body);
  try {
    await api.call("PUT", `${CHANNELS}/google/client`, { json: GOOGLE_CLIENT });
    await api.call("PUT", `${CHANNELS}/slack/client`, { clientId: SLACK_CLIENT });

    // Google : la page d'erreur recollée ; un texte sans code de blocage ni forme de code est refusé.
    await login(api, "google");
    let reply = await answer("google", { value: "Accès bloqué : erreur d'autorisation" });
    assert.deepEqual([reply.status, reply.json.error], [400, "texte non reconnu : recollez l'URL de retour ou déclarez le blocage"]);
    assert.equal((await view(api)).connections[0]!.login!.state, "waiting");
    assert.equal(channelOf(await view(api), "gmail").state, "disconnected");
    reply = await answer("google", { value: "Error 400: access_not_configured" });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json.channels.map((c: { state: string }) => c.state), ["blocked", "blocked", "disconnected"]);
    assert.equal(provider.count(GOOGLE_TOKEN), 0, "aucun appel au point de jeton");
    await login(api, "google");
    reply = await answer("google", { value: "Erreur 400 : admin_policy_enforced" });
    assert.deepEqual([reply.status, reply.json.login.state], [200, "failed"]);
    for (const id of ["gmail", "calendar"]) {
      assert.deepEqual([channelOf(reply.json, id).state, channelOf(reply.json, id).error], ["blocked", BLOCKED]);
    }
    assert.equal(provider.count(GOOGLE_TOKEN), 0);

    // Slack : un refus ordinaire n'est pas un blocage ; la politique de l'espace, ou la déclaration humaine, en est un.
    let slack = await login(api, "slack");
    reply = await answer("slack", { value: `http://localhost/omp-canaux?error=invalid_scope&state=${slack.state}` });
    assert.deepEqual([reply.status, reply.json.error], [409, "refus du fournisseur : invalid_scope"]);
    assert.deepEqual([channelOf(await view(api), "slack").state, channelOf(await view(api), "slack").error], ["error", "refus du fournisseur : invalid_scope"]);
    slack = await login(api, "slack");
    reply = await answer("slack", { value: `http://localhost/omp-canaux?error=unapproved_scope&state=${slack.state}` });
    assert.equal(reply.status, 200);
    assert.equal(channelOf(await view(api), "slack").state, "blocked");
    await login(api, "slack");
    reply = await answer("slack", { blocked: true });
    assert.equal(reply.status, 200);
    const all = await view(api);
    for (const id of ["gmail", "calendar", "slack"]) {
      assert.equal(channelOf(all, id).state, "blocked");
      assert.notEqual(channelOf(all, id).error, "");
    }
    assert.equal(provider.count(SLACK_TOKEN), 0);

    // Le poste continue : une demande au poste aboutit.
    await world.orchestrator.start();
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0", undefined, undefined, TABS)).status, 204);
    const request = await api.call("POST", "/v1/workstation/requests", { instruction: "Ouvre la page des factures" });
    assert.equal(request.status, 201);
    await waitFor(
      () => world.store.getWorkstationRequest(request.json.request.id)?.state === "done",
      () => JSON.stringify(world.store.getWorkstationRequest(request.json.request.id)),
    );

    // Connexion Google limitée à l'Agenda : Gmail reste bloqué, l'Agenda se connecte seul.
    provider.googleScopes = [CALENDAR_READ];
    const only = await login(api, "google", { channels: ["calendar"] });
    assert.equal(only.reply.status, 201);
    assert.equal(only.url!.searchParams.get("scope"), CALENDAR_READ);
    assert.equal(only.url!.searchParams.get("include_granted_scopes"), "true");
    reply = await answer("google", { value: back(only.state) });
    assert.equal(reply.status, 200, JSON.stringify(reply.json));
    assert.equal(channelOf(reply.json, "calendar").state, "connected");
    assert.deepEqual([channelOf(reply.json, "gmail").state, channelOf(reply.json, "gmail").error], ["blocked", BLOCKED]);
    assert.equal(provider.count("GET gmail.googleapis.com/gmail/v1/users/me/profile"), 0);
    const calls = provider.calls.length;
    await assert.rejects(world.orchestrator.channels.request("gmail", PROFILE), (err) => err instanceof ChannelUnavailable && err.state === "blocked");
    assert.equal(provider.calls.length, calls, "un canal bloqué ne se lit pas");
  } finally {
    await teardown(world, api);
  }

  // Sur un serveur neuf : déclarer bloqué un seul canal, puis le connecter ; un blocage recollé ne vise que les canaux demandés.
  const fresh = await setup();
  const call = fresh.api.call;
  const post = (id: "google" | "slack", sub: string, body?: unknown) => call("POST", `${CHANNELS}/${id}/${sub}`, body);
  try {
    await call("PUT", `${CHANNELS}/google/client`, { json: GOOGLE_CLIENT });
    await login(fresh.api, "google");
    let reply = await post("google", "login/answer", { blocked: true, channels: ["gmail"] });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json.channels.map((c: { state: string; error: string | null }) => [c.state, c.error === null]), [["blocked", false], ["disconnected", true], ["disconnected", true]]);
    assert.equal(reply.json.login.state, "failed");

    const gmail = await login(fresh.api, "google", { channels: ["gmail"] });
    assert.equal(gmail.url!.searchParams.get("scope"), `${GMAIL_READ} ${GMAIL_COMPOSE}`);
    reply = await post("google", "login/answer", { value: back(gmail.state) });
    assert.equal(reply.status, 200, JSON.stringify(reply.json));
    assert.deepEqual(reply.json.channels.map((c: { state: string }) => c.state), ["connected", "connected", "disconnected"]);

    const calendar = await login(fresh.api, "google", { channels: ["calendar"] });
    reply = await post("google", "login/answer", { value: `Error 400: admin_policy_enforced ${calendar.state}` });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json.channels.map((c: { state: string }) => c.state), ["connected", "blocked", "disconnected"]);

    // Les corps refusés.
    for (const body of [{ channels: [] }, { channels: ["slack"] }, { channels: ["gmail", "gmail"] }, { inconnu: 1 }])
      assert.equal((await post("google", "login", body)).status, 400, JSON.stringify(body));
    await login(fresh.api, "google", { channels: ["calendar"] });
    assert.equal((await post("google", "login/answer", { value: "c", channels: ["calendar"] })).status, 400);
    const states = (await call("GET", CHANNELS)).json.channels;
    assert.equal((await post("google", "login/answer", { blocked: true, channels: ["gmail"] })).status, 400);
    assert.deepEqual((await call("GET", CHANNELS)).json.channels, states, "rien ne change");
    assert.equal((await call("GET", CHANNELS)).json.connections[0]!.login!.state, "waiting");
    assert.equal((await post("google", "login/answer", { value: "c", blocked: true })).status, 400);
    assert.equal((await post("google", "login/answer", { value: "c", inconnu: 1 })).status, 400);
    assert.equal((await post("google", "login/answer", { channels: ["calendar"] })).status, 400);

    // `{channels: ["slack"]}` sur Slack : la demande par défaut.
    await call("PUT", `${CHANNELS}/slack/client`, { clientId: SLACK_CLIENT });
    const plain = await login(fresh.api, "slack");
    const named = await login(fresh.api, "slack", { channels: ["slack"] });
    assert.equal(named.reply.status, 201);
    for (const key of ["client_id", "user_scope", "redirect_uri", "code_challenge_method"])
      assert.equal(named.url!.searchParams.get(key), plain.url!.searchParams.get(key), key);
  } finally {
    await teardown(fresh.world, fresh.api);
  }

  // Agenda seul sur un serveur où Gmail n'est pas bloqué : l'Agenda se connecte et se sonde, Gmail reste « non demandé ».
  const only = await setup();
  try {
    await only.api.call("PUT", `${CHANNELS}/google/client`, { json: GOOGLE_CLIENT });
    only.provider.googleScopes = [CALENDAR_READ];
    const started = await login(only.api, "google", { channels: ["calendar"] });
    assert.equal(started.reply.status, 201);
    const done = await only.api.call("POST", `${CHANNELS}/google/login/answer`, { value: back(started.state) });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    const [gmailView, calendarView] = [channelOf(done.json, "gmail"), channelOf(done.json, "calendar")];
    assert.equal(calendarView.state, "connected");
    assert.notEqual(calendarView.account, null, "l'Agenda est sondé");
    assert.equal(gmailView.state, "disconnected");
    assert.match(gmailView.error ?? "", /^non demandé à la dernière connexion Google/);
    assert.equal(only.provider.count("GET gmail.googleapis.com/gmail/v1/users/me/profile"), 0);
  } finally {
    await teardown(only.world, only.api);
  }
});

test("poste-canaux/AC-5 : un jeton révoqué passe les canaux à reconnecter sans boucle ; limites, coupures et erreurs d'une ressource laissent l'état en place ; un canal en erreur reste lu", async () => {
  // Jeton de rafraîchissement révoqué : à reconnecter, date de dernière lecture gardée, plus aucun appel.
  let e = env();
  await connectGoogle(e);
  const read = stateOf(e.channels, "gmail").lastReadAt;
  assert.equal(typeof read, "number");
  e.clock.now += 2 * 3600 * 1000;
  e.provider.queue(GOOGLE_TOKEN, { status: 400, body: { error: "invalid_grant" } });
  await assert.rejects(e.channels.request("gmail", PROFILE), (err) => err instanceof ChannelUnavailable && err.state === "reconnect");
  for (const id of ["gmail", "calendar"] as const) {
    assert.deepEqual([stateOf(e.channels, id).state, stateOf(e.channels, id).lastReadAt], ["reconnect", read]);
    assert.match(stateOf(e.channels, id).error as string, /invalid_grant/);
  }
  const calls = e.provider.calls.length;
  for (let index = 0; index < 3; index++) await assert.rejects(e.channels.request("calendar", CALENDAR));
  assert.equal(e.provider.calls.length, calls, "aucune nouvelle tentative");
  assert.equal(e.logs.some((line) => /invalid_grant/.test(line) && line.startsWith("poste : canal gmail à reconnecter")), true);
  for (const line of e.logs) assert.doesNotMatch(line, /moi@example|ya29|1\/\//, "un log ne porte que le canal, l'état et un code");

  // Une connexion fraîche : la limite de débit n'est pas une panne.
  e = env();
  await connectGoogle(e);
  const key = "GET www.googleapis.com/calendar/v3/calendars/primary";
  e.provider.queue(key, { status: 429, headers: { "retry-after": "7" }, body: {} });
  await assert.rejects(e.channels.request("calendar", CALENDAR), (err) => err instanceof ChannelRateLimited && err.retryAfterMs === 7000);
  e.provider.queue(key, { status: 403, body: { error: { errors: [{ reason: "rateLimitExceeded" }] } } });
  await assert.rejects(e.channels.request("calendar", CALENDAR), (err) => err instanceof ChannelRateLimited && err.retryAfterMs === 60000);
  assert.deepEqual([stateOf(e.channels, "calendar").state, stateOf(e.channels, "calendar").error], ["connected", null]);
  e.provider.queue(key, { status: 403, body: { error: { errors: [{ reason: "accessNotConfigured" }] } } });
  await assert.rejects(e.channels.request("calendar", CALENDAR), (err) => err instanceof ChannelApiError && err.status === 403);
  assert.equal(stateOf(e.channels, "calendar").state, "error");
  assert.equal(stateOf(e.channels, "calendar").error, "GET /calendar/v3/calendars/primary : 403");
  // Un canal en erreur reste lu : la lecture suivante le repasse connecté.
  assert.deepEqual(await e.channels.request("calendar", CALENDAR), { id: "moi@example.org", summary: "moi@example.org" });
  assert.deepEqual([stateOf(e.channels, "calendar").state, stateOf(e.channels, "calendar").error], ["connected", null]);

  // Coupures : l'état, l'erreur et la date de lecture ne bougent pas.
  const profile = "GET gmail.googleapis.com/gmail/v1/users/me/profile";
  const gmail = stateOf(e.channels, "gmail");
  e.provider.queue(profile, "reject");
  await assert.rejects(e.channels.request("gmail", PROFILE), (err) => err instanceof ChannelNetworkError && err.code === "network");
  assert.deepEqual(stateOf(e.channels, "gmail"), gmail);
  e.provider.queue(profile, { status: 503, body: {} });
  await assert.rejects(e.channels.request("gmail", PROFILE), (err) => err instanceof ChannelNetworkError && err.code === "server");
  assert.deepEqual(stateOf(e.channels, "gmail"), gmail);
  assert.equal(((await e.channels.request("gmail", PROFILE)) as { emailAddress: string }).emailAddress, "moi@example.org");
  e.provider.queue(profile, { status: 200, body: undefined });
  await assert.rejects(e.channels.request("gmail", PROFILE), (err) => err instanceof ChannelNetworkError && err.code === "invalid_json");

  // Un renouvellement qui rejette : coupure, puis UN renouvellement qui aboutit.
  e.clock.now += 2 * 3600 * 1000;
  e.provider.queue(GOOGLE_TOKEN, "reject");
  const tokens = fs.readFileSync(e.file, "utf8");
  await assert.rejects(e.channels.request("gmail", PROFILE), (err) => err instanceof ChannelNetworkError);
  assert.equal(fs.readFileSync(e.file, "utf8"), tokens, "jetons inchangés");
  e.provider.queue(GOOGLE_TOKEN, { status: 503, body: {} });
  await assert.rejects(e.channels.request("gmail", PROFILE), (err) => err instanceof ChannelNetworkError && err.code === "server");
  assert.equal(fs.readFileSync(e.file, "utf8"), tokens, "jetons inchangés après un 503");
  const renewals = () => e.provider.calls.filter((c) => c.key === GOOGLE_TOKEN && c.body.includes("refresh_token")).length;
  const before = renewals();
  await e.channels.request("gmail", PROFILE);
  assert.equal(renewals(), before + 1);
  assert.equal(fileOf(e).google.tokens.access.startsWith("ya29.renewed"), true);

  // Un client OAuth supprimé ou dont le secret a changé : à reconnecter, sans nouvel appel.
  e.clock.now += 2 * 3600 * 1000;
  e.provider.queue(GOOGLE_TOKEN, { status: 401, body: { error: "invalid_client" } });
  await assert.rejects(e.channels.request("gmail", PROFILE), (err) => err instanceof ChannelUnavailable && err.state === "reconnect");
  assert.deepEqual(["gmail", "calendar"].map((id) => stateOf(e.channels, id as ChannelId).state), ["reconnect", "reconnect"]);
  const after = e.provider.calls.length;
  await assert.rejects(e.channels.request("gmail", PROFILE));
  assert.equal(e.provider.calls.length, after);

  // Pannes passagères et erreurs d'une ressource (Slack).
  e = env();
  await connectSlack(e);
  e.provider.queue("GET slack.com/api/auth.test", { status: 200, body: { ok: false, error: "channel_not_found" } });
  await assert.rejects(e.channels.request("slack", AUTH_TEST), (err) => err instanceof ChannelApiError && err.code === "channel_not_found");
  assert.deepEqual([stateOf(e.channels, "slack").state, stateOf(e.channels, "slack").error], ["connected", null]);
  e.provider.queue("GET slack.com/api/auth.test", { status: 200, body: { ok: false, error: "missing_scope" } });
  await assert.rejects(e.channels.request("slack", AUTH_TEST), (err) => err instanceof ChannelApiError && err.code === "missing_scope");
  assert.equal(stateOf(e.channels, "slack").state, "error");
  await e.channels.request("slack", AUTH_TEST);
  assert.equal(stateOf(e.channels, "slack").state, "connected");
  e.clock.now += 13 * 3600 * 1000;
  e.provider.queue(SLACK_TOKEN, { status: 200, body: { ok: false, error: "token_revoked" } });
  await assert.rejects(e.channels.request("slack", AUTH_TEST), (err) => err instanceof ChannelUnavailable);
  assert.equal(stateOf(e.channels, "slack").state, "reconnect");
  const slackCalls = e.provider.calls.length;
  for (let index = 0; index < 3; index++) await assert.rejects(e.channels.request("slack", AUTH_TEST));
  assert.equal(e.provider.calls.length, slackCalls);
});

test("poste-canaux/AC-8 : un jeton échu (date, 401 ou token_expired) est renouvelé une seule fois, le nouveau couple est réécrit en 0600 et la lecture aboutit", async () => {
  const cases: { channel: ChannelId; request: typeof PROFILE | typeof CALENDAR | typeof AUTH_TEST; key: string; expired: Reply }[] = [
    { channel: "gmail", request: PROFILE, key: "GET gmail.googleapis.com/gmail/v1/users/me/profile", expired: { status: 401, body: { error: { code: 401 } } } },
    { channel: "calendar", request: CALENDAR, key: "GET www.googleapis.com/calendar/v3/calendars/primary", expired: { status: 401, body: {} } },
    { channel: "slack", request: AUTH_TEST, key: "GET slack.com/api/auth.test", expired: { status: 200, body: { ok: false, error: "token_expired" } } },
  ];
  for (const { channel, request, key, expired } of cases) {
    const slack = channel === "slack";
    const tokenKey = slack ? SLACK_TOKEN : GOOGLE_TOKEN;
    const renewals = (e: Env) => e.provider.calls.filter((c) => c.key === tokenKey && c.body.includes("grant_type=refresh_token")).length;
    const make = async () => {
      const e = env();
      await (slack ? connectSlack(e) : connectGoogle(e));
      return e;
    };
    const tokensOf = (e: Env) => fileOf(e)[slack ? "slack" : "google"].tokens;

    // La date : un seul renouvellement, deux lectures simultanées comprises.
    let e = await make();
    const first = tokensOf(e);
    e.clock.now = first.expiresAt - 30_000;
    const results = await Promise.all([e.channels.request(channel, request), e.channels.request(channel, request)]);
    assert.equal(renewals(e), 1, `${channel} : un seul renouvellement pour deux lectures`);
    assert.equal(results.every((result) => result !== null), true);
    const second = tokensOf(e);
    assert.notEqual(second.access, first.access);
    assert.equal(second.expiresAt > e.clock.now, true);
    if (slack) assert.notEqual(second.refresh, first.refresh, "Slack : le nouveau jeton de rafraîchissement est gardé");
    else assert.equal(second.refresh, first.refresh);
    assert.equal(fs.statSync(e.file).mode & 0o777, 0o600);
    const used = e.provider.calls.filter((c) => c.key === key).at(-1)!;
    assert.equal(used.headers.Authorization, `Bearer ${second.access}`);
    assert.equal(stateOf(e.channels, channel).state, "connected");
    await e.channels.request(channel, request);
    assert.equal(renewals(e), 1, "jeton valide : aucun renouvellement de plus");

    // La réponse du fournisseur : un renouvellement, un seul nouvel essai.
    e = await make();
    e.provider.queue(key, expired);
    assert.notEqual(await e.channels.request(channel, request), null);
    assert.equal(renewals(e), 1);
    assert.equal(e.provider.calls.filter((c) => c.key === key).length, 3, "sonde, appel refusé, nouvel essai");

    // Refusé deux fois de suite : pas de boucle.
    e = await make();
    e.provider.queue(key, expired, expired);
    await assert.rejects(e.channels.request(channel, request), (err) => err instanceof ChannelApiError);
    assert.equal(renewals(e), 1);
  }
});

test("poste-canaux/AC-12 : aucune source n'appelle un envoi Gmail ou Slack ; le client des canaux refuse tout point hors liste blanche, hors canal ou d'écriture, sans appel réseau", async () => {
  // -- les sources -------------------------------------------------------------------------------
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, maxBuffer: 1 << 26 })
    .toString("utf8")
    .split("\0")
    .filter((file) => file !== "" && !file.startsWith("test/") && !file.endsWith(".md") && fs.existsSync(path.join(ROOT, file)));
  assert.ok(files.length > 100, "les fichiers suivis sont parcourus");
  const banned = [
    "messages/send", "messages.send", "drafts/send", "drafts.send", "/upload/gmail", "/batch/gmail",
    "chat.postMessage", "chat.postEphemeral", "chat.scheduleMessage", "chat.update", "chat.delete", "chat.meMessage",
    "files.upload", "files.getUploadURLExternal", "files.completeUploadExternal", "reactions.add", "users.profile.set",
  ];
  const hosts = ["gmail.googleapis.com", "www.googleapis.com/calendar", "oauth2.googleapis.com", "slack.com/api"];
  const secretFile = /channelsFile|channels\.json/;
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(ROOT, file));
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const word of banned) assert.equal(text.includes(word), false, `${file} nomme ${word}`);
    if (!file.startsWith("omp-harness/canaux/"))
      for (const host of hosts) assert.equal(text.includes(host), false, `${file} nomme ${host} hors de omp-harness/canaux/`);
    if (!file.startsWith("omp-harness/canaux/") && file !== "omp-harness/config.ts")
      assert.equal(secretFile.test(text), false, `${file} nomme le fichier des canaux`);
  }

  // -- les modules et les noms ---------------------------------------------------------------------
  const dir = path.join(ROOT, "omp-harness/canaux");
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    // Les modules sont ceux que le dossier contient : le spécificateur se choisit à l'exécution.
    const exported = Object.keys(await import(path.join(dir, name)));
    for (const key of exported) assert.doesNotMatch(key, /token|secret/i, `${name} exporte ${key}`);
  }
  const e = env();
  await connectGoogle(e);
  await connectSlack(e);
  const names = new Set<string>();
  for (let proto = e.channels; proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto))
    for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
  for (const name of names) assert.doesNotMatch(name, /token|secret/i, `Channels expose ${name}`);
  const dump = JSON.stringify(e.channels);
  for (const secret of ["ya29.first-access", "1//first-refresh", "xoxe.xoxp-first-access", GOOGLE_CLIENT.installed.client_secret])
    assert.equal(dump.includes(secret), false);

  // -- la liste blanche ---------------------------------------------------------------------------
  const writes = ALLOWLIST.filter((entry) => entry.method !== "GET").map((entry) => `${entry.method} ${entry.host}${entry.path}`);
  assert.deepEqual(writes.sort(), [
    "DELETE gmail.googleapis.com/gmail/v1/users/me/drafts/{id}",
    "POST gmail.googleapis.com/gmail/v1/users/me/drafts",
    "POST oauth2.googleapis.com/token",
    "POST slack.com/api/oauth.v2.access",
    "PUT gmail.googleapis.com/gmail/v1/users/me/drafts/{id}",
  ]);
  for (const entry of ALLOWLIST) {
    if (entry.host === "slack.com" && entry.path !== "/api/oauth.v2.access")
      assert.match(entry.path.slice(entry.path.lastIndexOf(".") + 1), /^(test|list|info|history|replies|members|messages|conversations|lookupByEmail)$/);
    const expected =
      entry.path === "/token" || entry.path === "/api/oauth.v2.access" ? null
      : entry.host === "gmail.googleapis.com" ? "gmail"
      : entry.host === "www.googleapis.com" && entry.path.startsWith("/calendar/v3/") ? "calendar"
      : entry.host === "slack.com" && entry.path.startsWith("/api/") ? "slack"
      : "?";
    assert.equal(entry.channel, expected, `${entry.host}${entry.path}`);
  }

  // -- les refus, sans appel réseau ----------------------------------------------------------------
  const gmail = "https://gmail.googleapis.com";
  const drafts = `${gmail}/gmail/v1/users/me/dra` + "fts";
  const refused: [ChannelId, "GET" | "POST" | "PUT" | "DELETE", string][] = [
    ["gmail", "POST", `${drafts}/se` + "nd"],
    ["gmail", "POST", `${gmail}/gmail/v1/users/me/mess` + "ages/send"],
    ["gmail", "POST", `${gmail}/batch/gmail/v1`],
    ["calendar", "POST", "https://www.googleapis.com/batch/calendar/v3"],
    ["slack", "POST", "https://slack.com/api/chat." + "postMessage"],
    ["gmail", "POST", `${drafts}/abc/se` + "nd"],
    ["gmail", "GET", `${drafts}/abc`],
    ["gmail", "DELETE", `${gmail}/gmail/v1/users/me/profile`],
    ["gmail", "GET", "https://evil.exemple.fr/gmail/v1/users/me/profile"],
    ["gmail", "GET", "https://gmail.googleapis.com:443/gmail/v1/users/me/profile"],
    ["gmail", "GET", "http://gmail.googleapis.com/gmail/v1/users/me/profile"],
    ["gmail", "GET", "https://user@gmail.googleapis.com/gmail/v1/users/me/profile"],
    ["gmail", "GET", `${drafts}/a%2Fb`],
    ["gmail", "PUT", `${drafts}/../profile`],
    ["gmail", "PUT", `${drafts}//x`],
    ["gmail", "POST", `${gmail}/upload/gmail/v1/users/me/drafts`],
  ];
  const calls = e.provider.calls.length;
  for (const [channel, method, url] of refused)
    await assert.rejects(e.channels.request(channel, { method, url }), (err) => err instanceof ChannelRefused, `${method} ${url}`);
  assert.equal(e.provider.calls.length, calls, "aucun appel réseau");

  // Un point d'écriture permis (brouillons) atteint le fournisseur : la liste blanche ne l'a pas refusé.
  await assert.rejects(
    e.channels.request("gmail", { method: "POST", url: drafts, json: { message: {} } }),
    (err) => err instanceof ChannelApiError && err.status === 404,
  );
  assert.equal(e.provider.calls.length, calls + 1);

  // -- un canal ne se lit pas au nom d'un autre ------------------------------------------------------
  e.channels.startLogin("google", {});
  await e.channels.answer("google", { blocked: true, channels: ["gmail"] });
  assert.equal(stateOf(e.channels, "gmail").state, "blocked");
  assert.equal(stateOf(e.channels, "calendar").state, "connected");
  const cross = e.provider.calls.length;
  const mismatches: [ChannelId, "GET" | "POST", string][] = [
    ["calendar", "GET", PROFILE.url],
    ["calendar", "POST", drafts],
    ["slack", "GET", CALENDAR.url],
    ["gmail", "GET", AUTH_TEST.url],
    ["gmail", "POST", "https://oauth2.googleapis.com/token"],
    ["slack", "POST", "https://slack.com/api/oauth.v2.access"],
  ];
  for (const [channel, method, url] of mismatches)
    await assert.rejects(e.channels.request(channel, { method, url }), (err) => err instanceof ChannelRefused && /autre canal/.test(err.message), `${channel} ${url}`);
  assert.equal(e.provider.calls.length, cross, "aucun jeton ne part vers un autre point");
  await assert.rejects(e.channels.request("gmail", PROFILE), (err) => err instanceof ChannelUnavailable && err.state === "blocked");
  assert.equal(e.provider.calls.length, cross);
});

test("poste-canaux/AC-34 : channels.json vit dans le dossier d'état, hors de portée des runners et des connexions, en 0600, et aucun jeton n'atteint un argv ni un environnement", async () => {
  const e = env();
  await connectGoogle(e);
  await connectSlack(e);
  const secrets = ["ya29.first-access", "1//first-refresh", "xoxe.xoxp-first-access", "xoxe-first-refresh", GOOGLE_CLIENT.installed.client_secret];
  assert.equal(fs.statSync(e.file).mode & 0o777, 0o600);

  // (d) Le fichier reste en 0600 après un renouvellement.
  e.clock.now += 2 * 3600 * 1000;
  await e.channels.request("gmail", PROFILE);
  assert.equal(fileOf(e).google.tokens.access.startsWith("ya29.renewed"), true);
  assert.equal(fs.statSync(e.file).mode & 0o777, 0o600);

  // (a) En conteneur : ni le fichier ni son dossier dans un argv de runner ou de connexion.
  const config = testConfig("/srv/repo", (c) => {
    c.runner.isolation = "container";
    c.container.runnerHome = "/srv/runner-home";
  });
  config.channelsFile = e.file;
  const argvs = [
    runnerArgv(config, { unit: "u", cwd: "/w", overlay: "/o", model: null, scope: "demo-scope", repo: "/r" }),
    loginArgv(config, "u"),
  ].map((argv) => [argv.command, ...argv.args]);
  for (const argv of argvs) {
    for (const arg of argv) {
      assert.equal(arg.includes(e.file), false);
      assert.equal(arg.includes(path.dirname(e.file)), false);
      for (const secret of secrets) assert.equal(arg.includes(secret), false);
    }
  }

  // (b) En systemd : le dossier d'état est caché aux runners, dans le lanceur comme dans sa configuration.
  const example = loadConfig(path.join(ROOT, "omp-harness/deploy/config.example.json"));
  const hiddenIn = (file: string): string[] => {
    const line = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n").find((l) => l.startsWith("RUNNER_HIDDEN="));
    return (line as string).replace(/^RUNNER_HIDDEN=/, "").replace(/^"|"$/g, "").split(/\s+/);
  };
  const stateDir = path.dirname(example.channelsFile);
  assert.equal(stateDir, "/var/lib/omp-harness/state");
  for (const file of ["omp-harness/deploy/launcher.conf", "omp-harness/deploy/omp-harness-systemd-run"])
    assert.equal(hiddenIn(file).some((hidden) => stateDir === hidden || stateDir.startsWith(`${hidden}/`)), true, `${file} cache ${stateDir}`);
  assert.equal(path.dirname(defaultConfig("/x").channelsFile), "/x");
  assert.equal(path.dirname(example.tokenFile), stateDir, "à côté du jeton de l'API");

  // (c) Les environnements : ni jeton ni secret.
  for (const environment of [runnerEnv("demo-scope", null, process.env), loginEnv()])
    for (const value of Object.values(environment))
      for (const secret of secrets) assert.equal((value ?? "").includes(secret), false);
});
