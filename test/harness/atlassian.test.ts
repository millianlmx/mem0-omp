// Feature atlassian (socle serveur) : le connecteur Atlassian du harness — configuration, consentement
// OAuth 2.1 (DCR, PKCE S256, retour public ou collé), jetons 0600, client MCP Streamable HTTP
// (rafraîchissement unique, JSON ou SSE, session), outils des agents et garde des écritures Jira,
// commentaires proposés puis approuvés, plan du jour, routes réservées, événements et alertes.
// Aucun réseau : la doublure d'Atlassian (test/support/atlassian-double.ts). Données fictives.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { AtlassianAuth } from "../../omp-harness/atlassian/oauth.ts";
import { ATLASSIAN_SCOPES } from "../../omp-harness/atlassian/oauth.ts";
import { replyOf } from "../../omp-harness/atlassian/mcp.ts";
import { listsIssue } from "../../omp-harness/atlassian/tools.ts";
import {
  ATLASSIAN_READ_TOOLS,
  ATLASSIAN_WRITE_TOOLS,
  CORPO_SCOPE,
  isAtlassianTool,
} from "../../omp-harness/atlassian/desk.ts";
import type { AtlassianDesk } from "../../omp-harness/atlassian/desk.ts";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import {
  LOOPBACK_REDIRECT,
  defaultConfig,
  loadConfig,
  repoDefaults,
  validateConfig,
} from "../../omp-harness/config.ts";
import type { AtlassianWrite } from "../../omp-harness/db.ts";
import { EVENT_TYPES } from "../../omp-harness/events.ts";
import { API_FEATURES, createHandler } from "../../omp-harness/http.ts";
import { alertFor } from "../../omp-harness/push-alerts.ts";
import { UNTRUSTED_BEGIN, UNTRUSTED_END } from "../../omp-harness/workstation-guards.ts";
import {
  FAKE_ACCESS_TOKEN,
  FAKE_ACCOUNT,
  FAKE_CLOUD_ID,
  FAKE_CODE,
  FAKE_MCP_URL,
  FAKE_SITE,
  connectAtlassian,
  fakeAtlassian,
} from "../support/atlassian-double.ts";
import type { AtlassianDouble } from "../support/atlassian-double.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

type Setup = { fake: AtlassianDouble; world: FakeWorld; desk: AtlassianDesk };

function setup(options: { patch?: (config: HarnessConfig) => void; sse?: boolean } = {}): Setup {
  const fake = fakeAtlassian({ sse: options.sse });
  const world = fakeWorld({}, { atlassian: fake.fetch, ...(options.patch ? { patch: options.patch } : {}) });
  return { fake, world, desk: world.orchestrator.atlassian };
}

type Reply = { status: number; json: Record<string, unknown>; text: string; headers: Headers };
type Api = {
  tokens: { approver: string; operator: string; pilot: string; viewer: string; narrow: string };
  call: (token: string | null, method: string, route: string, body?: unknown) => Promise<Reply>;
  close: () => Promise<void>;
};

async function serve(world: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("atlassian-"), "clients.json"), "a".repeat(64));
  const tokens = {
    approver: clients.add("app-approbateur", "admin", "*", true).token,
    operator: clients.add("mac", "operator", "*").token,
    pilot: clients.add("vigie", "operator", "*", false, true).token,
    viewer: clients.add("ipad", "viewer", "*").token,
    narrow: clients.add("mac-demo", "operator", ["demo"]).token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients, log: () => {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    tokens,
    call: async (token, method, route, body) => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: {
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        json = {};
      }
      return { status: response.status, json, text, headers: response.headers };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const POSTE = { by: "poste:poste-service", writes: true };
const signal = (): AbortSignal => new AbortController().signal;

/** Lance le consentement par l'API et rend l'adresse d'autorisation lue. */
async function begin(api: Api): Promise<URL> {
  const reply = await api.call(api.tokens.approver, "POST", "/v1/atlassian/connect", {});
  assert.equal(reply.status, 200, reply.text);
  return new URL(String(reply.json.authorizeUrl));
}

function writesOf(world: FakeWorld): AtlassianWrite[] {
  return world.store.listAtlassianWrites({ limit: 100 });
}

// -- AC-1 : configuration --------------------------------------------------------------------------

test("atlassian/AC-1 : le bloc atlassian a ses défauts, son fichier de jetons à côté du jeton d'API, et refuse les valeurs invalides", () => {
  const base = tmpdir("atlassian-config-");
  const config = defaultConfig(base);
  assert.deepEqual(config.atlassian, {
    enabled: true,
    mcpUrl: "https://mcp.atlassian.com/v2/mcp",
    redirectUri: null,
    tokenFile: path.join(base, "atlassian.json"),
    planHour: 8,
    planWeekdaysOnly: true,
    knowledgeEveryHours: 24,
  });
  const file = path.join(base, "config.json");
  fs.writeFileSync(file, JSON.stringify({ tokenFile: path.join(base, "etat", "token"), atlassian: { planHour: 7 } }));
  const loaded = loadConfig(file);
  assert.equal(loaded.atlassian.tokenFile, path.join(base, "etat", "atlassian.json"));
  assert.equal(loaded.atlassian.planHour, 7);
  assert.equal(loaded.atlassian.knowledgeEveryHours, 24, "fusion profonde : les autres défauts restent");
  const refused = (patch: (config: HarnessConfig) => void, message: RegExp) => {
    const candidate = defaultConfig(base);
    patch(candidate);
    assert.throws(() => validateConfig(candidate), message);
  };
  refused((c) => (c.atlassian.mcpUrl = "http://mcp.atlassian.com/v2/mcp"), /atlassian\.mcpUrl/);
  refused(
    (c) => (c.atlassian.redirectUri = "http://homelab.example:7443/v1/atlassian/callback"),
    /atlassian\.redirectUri/,
  );
  refused((c) => (c.atlassian.planHour = 24), /atlassian\.planHour/);
  refused((c) => (c.atlassian.knowledgeEveryHours = 0), /atlassian\.knowledgeEveryHours/);
  refused((c) => (c.atlassian.tokenFile = "atlassian.json"), /atlassian\.tokenFile/);
  refused(
    (c) =>
      (c.repos = [{ ...repoDefaults({ name: "demo", path: "/tmp/demo" }), atlassian: "oui" as unknown as boolean }]),
    /repos\.demo\.atlassian/,
  );
  const fine = defaultConfig(base);
  fine.atlassian.redirectUri = "https://homelab.example.ts.net:7443/v1/atlassian/callback";
  fine.atlassian.planHour = null;
  fine.atlassian.knowledgeEveryHours = null;
  fine.repos = [{ ...repoDefaults({ name: "demo", path: "/tmp/demo" }), atlassian: true }];
  assert.doesNotThrow(() => validateConfig(fine));
});

// -- AC-2 à AC-5 : consentement et jetons ---------------------------------------------------------

test("atlassian/AC-2 : le branchement rend une adresse d'autorisation complète (client DCR sans secret, PKCE S256, state, portées, ressource) et le client est réutilisé", async () => {
  const { fake, world } = setup();
  const api = await serve(world);
  try {
    const url = await begin(api);
    const params = url.searchParams;
    assert.equal(`${url.origin}${url.pathname}`, "https://auth.atlassian.com/authorize");
    assert.equal(params.get("response_type"), "code");
    assert.equal(params.get("client_id"), "client-1");
    assert.equal(params.get("redirect_uri"), LOOPBACK_REDIRECT);
    assert.match(params.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.match(params.get("state") ?? "", /^[A-Za-z0-9_-]{40,}$/);
    assert.deepEqual(params.get("scope")?.split(" "), [...ATLASSIAN_SCOPES]);
    assert.equal(params.get("resource"), FAKE_MCP_URL);
    assert.equal(params.get("prompt"), "consent");
    const registration = fake.requests.find((request) => request.url.endsWith("/dcr/register"));
    assert.deepEqual(JSON.parse(registration?.body ?? "{}"), {
      client_name: "omp-harness",
      redirect_uris: [LOOPBACK_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const status = await api.call(api.tokens.operator, "GET", "/v1/atlassian");
    assert.equal(status.status, 200);
    const atlassian = status.json.atlassian as Record<string, unknown>;
    assert.equal(atlassian.connected, false);
    assert.equal(atlassian.pasteBack, true);
    assert.equal(atlassian.redirectUri, LOOPBACK_REDIRECT);
    assert.equal((atlassian.pending as { authorizeUrl: string }).authorizeUrl, url.toString());
    // Un second branchement remplace le premier, sans réenregistrer le client.
    const again = await begin(api);
    assert.equal(fake.registrations, 1);
    assert.notEqual(again.searchParams.get("state"), params.get("state"));
    assert.notEqual(again.searchParams.get("code_challenge"), params.get("code_challenge"));
  } finally {
    await api.close();
  }
});

test("atlassian/AC-3 : le retour public par GET branche le site et le compte, une seule fois, sans jamais citer ses paramètres", async () => {
  const { fake, world, desk } = setup({
    patch: (config) => {
      config.atlassian.redirectUri = "https://homelab.example.ts.net:7443/v1/atlassian/callback";
    },
  });
  const api = await serve(world);
  try {
    const url = await begin(api);
    assert.equal(desk.status().pasteBack, false, "redirection tailnet : rien à coller");
    const state = url.searchParams.get("state") ?? "";
    const route = `/v1/atlassian/callback?code=${FAKE_CODE}&state=${encodeURIComponent(state)}`;
    const ok = await api.call(null, "GET", route);
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.text, /Atlassian est branché, tu peux fermer cet onglet\./);
    assert.equal(ok.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(ok.headers.get("content-security-policy"), "default-src 'none'");
    assert.ok(!ok.text.includes(FAKE_CODE) && !ok.text.includes(state), "aucun paramètre réfléchi");
    // L'échange : code, verifier dont l'empreinte est le challenge, adresse de retour, client.
    const form = fake.tokenForms[0] ?? {};
    assert.equal(form.grant_type, "authorization_code");
    assert.equal(form.code, FAKE_CODE);
    assert.equal(form.client_id, "client-1");
    assert.equal(form.redirect_uri, "https://homelab.example.ts.net:7443/v1/atlassian/callback");
    assert.equal(
      createHash("sha256")
        .update(form.code_verifier ?? "")
        .digest("base64url"),
      url.searchParams.get("code_challenge"),
    );
    const status = desk.status();
    assert.equal(status.connected, true);
    assert.deepEqual(status.site, { cloudId: FAKE_CLOUD_ID, url: FAKE_SITE });
    assert.equal(status.accountId, FAKE_ACCOUNT);
    assert.equal(status.connectedBy, "app-approbateur");
    assert.equal(status.pending, null);
    // Usage unique : le même lien rejoué, un state inconnu ou forgé sont refusés, sans écho.
    const replay = await api.call(null, "GET", route);
    assert.equal(replay.status, 400);
    assert.match(replay.text, /Lien de connexion invalide ou expiré\./);
    const forged = await api.call(
      null,
      "GET",
      `/v1/atlassian/callback?code=${FAKE_CODE}&state=%3Cscript%3Ex%3C%2Fscript%3E`,
    );
    assert.equal(forged.status, 400);
    assert.ok(!forged.text.includes("<script>") && !forged.text.includes(FAKE_CODE));
    assert.equal(fake.tokenForms.length, 1, "un seul échange");
  } finally {
    await api.close();
  }
});

test("atlassian/AC-4 : le retour collé par POST branche ; lien inconnu, expiré ou déjà servi → 400 ; échange refusé → 502", async () => {
  const { world, desk } = setup();
  const api = await serve(world);
  try {
    const refusedFirst = await begin(api);
    const wrong = new URL(LOOPBACK_REDIRECT);
    wrong.searchParams.set("code", "code-faux");
    wrong.searchParams.set("state", refusedFirst.searchParams.get("state") ?? "");
    const bad = await api.call(api.tokens.approver, "POST", "/v1/atlassian/callback", { url: wrong.toString() });
    assert.equal(bad.status, 502, bad.text);
    assert.equal(desk.connected(), false);
    assert.match(String(desk.status().lastError), /échange du code/);
    const url = await begin(api);
    const back = new URL(LOOPBACK_REDIRECT);
    back.searchParams.set("code", FAKE_CODE);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    const ok = await api.call(api.tokens.approver, "POST", "/v1/atlassian/callback", { url: back.toString() });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((ok.json.atlassian as { connected: boolean }).connected, true);
    assert.equal(desk.status().lastError, null);
    const replay = await api.call(api.tokens.approver, "POST", "/v1/atlassian/callback", { url: back.toString() });
    assert.deepEqual([replay.status, replay.json], [400, { error: "Lien de connexion invalide ou expiré." }]);
    const junk = await api.call(api.tokens.approver, "POST", "/v1/atlassian/callback", { url: "pas une adresse" });
    assert.equal(junk.status, 400);
  } finally {
    await api.close();
  }
  // L'expiration (dix minutes), prouvée sur l'horloge du consentement.
  const fake = fakeAtlassian();
  const config = defaultConfig(tmpdir("atlassian-auth-")).atlassian;
  let now = 1_000_000;
  const auth = new AtlassianAuth({ fetch: fake.fetch, config: () => config, now: () => now, onRevoked: () => {} });
  const pending = await auth.begin("app-approbateur");
  assert.equal(pending.expiresAt, now + 10 * 60 * 1000);
  now += 10 * 60 * 1000;
  assert.equal(auth.take(pending.state), null, "expiré");
  const fresh = await auth.begin("app-approbateur");
  assert.equal(auth.take("autre"), null, "un state inconnu ne retire pas le consentement");
  assert.equal(auth.take(fresh.state)?.state, fresh.state);
  assert.equal(auth.take(fresh.state), null, "usage unique");
});

test("atlassian/AC-5 : les jetons sont rangés en 0600 et jamais rendus par GET /v1/atlassian ni le journal ; DELETE les supprime", async () => {
  const { world, desk } = setup();
  const api = await serve(world);
  try {
    const url = await begin(api);
    const back = `${LOOPBACK_REDIRECT}?code=${FAKE_CODE}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`;
    assert.equal((await api.call(api.tokens.approver, "POST", "/v1/atlassian/callback", { url: back })).status, 200);
    const file = world.config.atlassian.tokenFile;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(typeof stored.accessToken, "string");
    assert.equal(typeof stored.refreshToken, "string");
    const status = await api.call(api.tokens.approver, "GET", "/v1/atlassian");
    for (const secret of [stored.accessToken, stored.refreshToken]) {
      assert.ok(!status.text.includes(String(secret)), "aucun jeton dans la réponse");
      const journal = JSON.stringify(world.store.eventsOfType("atlassian"));
      assert.ok(!journal.includes(String(secret)), "aucun jeton au journal");
    }
    assert.ok(!JSON.stringify(world.store.getSetting("atlassian.knowledge")).includes(String(stored.accessToken)));
    const gone = await api.call(api.tokens.approver, "DELETE", "/v1/atlassian");
    assert.equal(gone.status, 200);
    assert.equal((gone.json.atlassian as { connected: boolean }).connected, false);
    assert.equal(fs.existsSync(file), false);
    assert.equal(desk.connected(), false);
  } finally {
    await api.close();
  }
});

// -- AC-6, AC-7 : client MCP --------------------------------------------------------------------------

test("atlassian/AC-6 : un 401 rafraîchit le jeton puis retente ; deux appels concurrents ne font qu'un rafraîchissement ; un refus du refresh débranche", async () => {
  const { fake, world, desk } = setup();
  connectAtlassian(world);
  assert.equal(desk.connected(), true);
  assert.equal((await desk.runTool("jira_search", { jql: "project = PROJ" }, POSTE, signal())).isError, undefined);
  fake.expire();
  fake.refreshDelayMs = 30;
  const [first, second] = await Promise.all([
    desk.runTool("jira_search", { jql: "project = PROJ" }, POSTE, signal()),
    desk.runTool("jira_issue", { key: "PROJ-1" }, POSTE, signal()),
  ]);
  assert.equal(first.isError, undefined, first.text);
  assert.equal(second.isError, undefined, second.text);
  assert.equal(fake.refreshes, 1, "un seul rafraîchissement");
  const stored = JSON.parse(fs.readFileSync(world.config.atlassian.tokenFile, "utf8")) as Record<string, unknown>;
  assert.equal(stored.accessToken, fake.access, "le nouveau jeton d'accès est rangé");
  assert.equal(stored.refreshToken, fake.refresh, "le refresh token tourné remplace l'ancien");
  assert.notEqual(stored.accessToken, FAKE_ACCESS_TOKEN);
  assert.equal(fs.statSync(world.config.atlassian.tokenFile).mode & 0o777, 0o600);
  // Refresh token révoqué : les jetons sont oubliés, l'agent lit « non connecté », l'app reçoit l'événement.
  fake.expire();
  fake.revoked = true;
  const refused = await desk.runTool("jira_search", { jql: "project = PROJ" }, POSTE, signal());
  assert.equal(refused.isError, true);
  assert.match(refused.text, /n'est pas connecté/);
  assert.equal(desk.connected(), false);
  assert.match(String(desk.status().lastError), /jeton refusé/);
  assert.deepEqual(
    world.store.eventsOfType("atlassian").map((event) => event.payload),
    [{ connected: false }],
  );
});

test("atlassian/AC-7 : le client MCP lit les réponses JSON et SSE, renvoie sa session et en rouvre une perdue", async () => {
  assert.deepEqual(replyOf('{"jsonrpc":"2.0","id":3,"result":{}}', 3), { jsonrpc: "2.0", id: 3, result: {} });
  const sse = [
    "event: message",
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    "",
    "event: message",
    'data: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"ok"}]}}',
    "",
    "",
  ].join("\n");
  assert.deepEqual(replyOf(sse, 7), { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "ok" }] } });
  assert.equal(replyOf("event: ping\n\n", 1), null);
  for (const mode of [false, true]) {
    const { fake, world, desk } = setup({ sse: mode });
    connectAtlassian(world);
    const issue = await desk.runTool("jira_issue", { key: "proj-2" }, POSTE, signal());
    assert.equal(issue.isError, undefined, issue.text);
    assert.match(issue.text, /PROJ-2 — Revue du schéma/);
    const mcp = fake.requests.filter((request) => request.url === FAKE_MCP_URL);
    const bodies = mcp.map((request) => JSON.parse(request.body) as { method: string });
    assert.deepEqual(
      bodies.map((body) => body.method),
      ["initialize", "notifications/initialized", "tools/call"],
    );
    assert.equal(mcp[0]?.headers["MCP-Protocol-Version"], "2025-06-18");
    assert.equal(mcp[0]?.headers.Accept, "application/json, text/event-stream");
    assert.equal(mcp[0]?.headers["Mcp-Session-Id"], undefined);
    assert.equal(mcp[2]?.headers["Mcp-Session-Id"], "sess-1");
    assert.deepEqual(fake.calls.at(-1), {
      tool: "getJiraIssue",
      args: { cloudId: FAKE_CLOUD_ID, issueIdOrKey: "PROJ-2" },
    });
    fake.dropSessions();
    const again = await desk.runTool("jira_issue", { key: "PROJ-1" }, POSTE, signal());
    assert.equal(again.isError, undefined, again.text);
    assert.equal(fake.initializes, 2, "session perdue : une nouvelle, puis la tentative");
  }
});

// -- AC-8 à AC-12 : outils des agents, garde des écritures -------------------------------------------

test("atlassian/AC-8 : jira_transition est refusée hors des tickets de l'utilisateur, appliquée et journalisée sur les siens", async () => {
  const { fake, world, desk } = setup();
  connectAtlassian(world);
  const other = await desk.runTool(
    "jira_transition",
    { key: "PROJ-3", transition: "En cours", why: "je m'y mets" },
    POSTE,
    signal(),
  );
  assert.deepEqual(other, { text: "ticket non assigné à l'utilisateur : transition refusée", isError: true });
  assert.equal(
    fake.calls.some((call) => call.tool === "transitionJiraIssue"),
    false,
  );
  assert.equal(writesOf(world).length, 0);
  const mine = await desk.runTool(
    "jira_transition",
    { key: "PROJ-1", transition: "En cours", why: "commencé" },
    POSTE,
    signal(),
  );
  assert.equal(mine.isError, undefined, mine.text);
  const guard = fake.calls.find(
    (call) => call.tool === "searchJiraIssuesUsingJql" && String(call.args.jql).includes("PROJ-1"),
  );
  assert.equal(guard?.args.jql, 'key = "PROJ-1" AND assignee = currentUser()');
  assert.deepEqual(fake.calls.at(-1), {
    tool: "transitionJiraIssue",
    args: { cloudId: FAKE_CLOUD_ID, issueIdOrKey: "PROJ-1", transitionName: "En cours" },
  });
  assert.equal(fake.issues[0]?.status, "En cours");
  const [sent] = writesOf(world);
  assert.deepEqual(
    [sent?.kind, sent?.issueKey, sent?.body, sent?.why, sent?.state, sent?.by],
    ["transition", "PROJ-1", "En cours", "commencé", "sent", "poste:poste-service"],
  );
  fake.failTools.set("transitionJiraIssue", "Transition « Fini » introuvable");
  const failed = await desk.runTool(
    "jira_transition",
    { key: "PROJ-2", transition: "Fini", why: "fini" },
    POSTE,
    signal(),
  );
  assert.equal(failed.isError, true);
  assert.equal(writesOf(world)[0]?.state, "failed");
  assert.match(String(writesOf(world)[0]?.error), /introuvable/);
  // La preuve « à moi » lit une réponse JSON ou markdown, jamais l'écho de la requête.
  const jql = 'key = "PROJ-9" AND assignee = currentUser()';
  assert.equal(listsIssue(`Aucun ticket pour ${jql}`, "PROJ-9", jql), false);
  assert.equal(listsIssue("| PROJ-9 | Titre |", "PROJ-9", jql), true);
  assert.equal(listsIssue('{"issues":[],"jql":"key = PROJ-9"}', "PROJ-9", jql), false);
  assert.equal(listsIssue("| PROJ-90 | Titre |", "PROJ-9", jql), false);
});

test("atlassian/AC-9 : un commentaire proposé attend l'approbateur, puis part avec le texte édité ; rejoué → 409", async () => {
  const { fake, world } = setup();
  connectAtlassian(world);
  const api = await serve(world);
  try {
    const desk = world.orchestrator.atlassian;
    const proposed = await desk.runTool(
      "jira_comment_propose",
      { key: "PROJ-1", body: "Le correctif est en revue.", why: "tenir l'équipe au courant" },
      POSTE,
      signal(),
    );
    assert.match(proposed.text, /^commentaire proposé #aw\w+, en attente de l'approbation de l'humain$/);
    assert.equal(
      fake.calls.some((call) => call.tool === "addOrEditJiraIssueComment"),
      false,
      "rien n'est écrit",
    );
    const twice = await desk.runTool(
      "jira_comment_propose",
      { key: "PROJ-1", body: "Le correctif est en revue.", why: "encore" },
      POSTE,
      signal(),
    );
    assert.equal(twice.text, proposed.text, "dédoublonné");
    const listed = await api.call(api.tokens.operator, "GET", "/v1/atlassian/writes");
    const writes = listed.json.writes as AtlassianWrite[];
    assert.equal(writes.length, 1);
    const id = writes[0]?.id ?? "";
    assert.equal(desk.status().proposed, 1);
    const event = world.store.eventsOfType("atlassian_write").at(-1);
    assert.ok(event);
    const alert = alertFor(event, world.store);
    assert.deepEqual(
      [alert?.kind, alert?.title, alert?.body, alert?.audience, alert?.key],
      [
        "atlassian_comment",
        "Commentaire Jira à valider",
        "PROJ-1 : Le correctif est en revue.",
        "approver",
        `atlassian_comment:${id}`,
      ],
    );
    const approved = await api.call(api.tokens.approver, "POST", `/v1/atlassian/writes/${id}/approve`, {
      body: "Le correctif est en revue, livraison jeudi.",
    });
    assert.equal(approved.status, 200, approved.text);
    const write = approved.json.write as AtlassianWrite;
    assert.deepEqual(
      [write.state, write.body, write.decidedBy],
      ["sent", "Le correctif est en revue, livraison jeudi.", "app-approbateur"],
    );
    assert.deepEqual(fake.calls.at(-1), {
      tool: "addOrEditJiraIssueComment",
      args: {
        cloudId: FAKE_CLOUD_ID,
        issueIdOrKey: "PROJ-1",
        commentBody: "Le correctif est en revue, livraison jeudi.",
      },
    });
    assert.deepEqual(fake.issues[0]?.comments, ["Le correctif est en revue, livraison jeudi."]);
    assert.equal(alertFor(world.store.eventsOfType("atlassian_write").at(-1) as never, world.store), null);
    const again = await api.call(api.tokens.approver, "POST", `/v1/atlassian/writes/${id}/approve`, {});
    assert.equal(again.status, 409);
    const sentList = await api.call(api.tokens.approver, "GET", "/v1/atlassian/writes?state=sent&limit=5");
    assert.deepEqual(
      (sentList.json.writes as AtlassianWrite[]).map((row) => row.id),
      [id],
    );
    const badState = await api.call(api.tokens.approver, "GET", "/v1/atlassian/writes?state=perdu");
    assert.equal(badState.status, 400);
  } finally {
    await api.close();
  }
});

test("atlassian/AC-10 : écarter un commentaire proposé n'envoie rien ; un second geste → 409", async () => {
  const { fake, world } = setup();
  connectAtlassian(world);
  const api = await serve(world);
  try {
    await world.orchestrator.atlassian.runTool(
      "jira_comment_propose",
      { key: "PROJ-2", body: "Je reprends ce ticket.", why: "prévenir" },
      POSTE,
      signal(),
    );
    const id = writesOf(world)[0]?.id ?? "";
    const dismissed = await api.call(api.tokens.approver, "POST", `/v1/atlassian/writes/${id}/dismiss`, {});
    assert.equal(dismissed.status, 200, dismissed.text);
    assert.deepEqual(
      [(dismissed.json.write as AtlassianWrite).state, (dismissed.json.write as AtlassianWrite).decidedBy],
      ["dismissed", "app-approbateur"],
    );
    assert.equal(
      fake.calls.some((call) => call.tool === "addOrEditJiraIssueComment"),
      false,
    );
    assert.equal((await api.call(api.tokens.approver, "POST", `/v1/atlassian/writes/${id}/dismiss`, {})).status, 409);
    assert.equal((await api.call(api.tokens.approver, "POST", `/v1/atlassian/writes/${id}/approve`, {})).status, 409);
    assert.equal(
      (await api.call(api.tokens.approver, "POST", "/v1/atlassian/writes/aw-inconnu/dismiss", {})).status,
      404,
    );
  } finally {
    await api.close();
  }
});

test("atlassian/AC-11 : Atlassian refuse le commentaire → 502, l'écriture passe failed avec la raison", async () => {
  const { fake, world } = setup();
  connectAtlassian(world);
  const api = await serve(world);
  try {
    await world.orchestrator.atlassian.runTool(
      "jira_comment_propose",
      { key: "PROJ-1", body: "Texte.", why: "raison" },
      POSTE,
      signal(),
    );
    const id = writesOf(world)[0]?.id ?? "";
    fake.failTools.set("addOrEditJiraIssueComment", "MCP error -32602: commentBody invalide");
    const refused = await api.call(api.tokens.approver, "POST", `/v1/atlassian/writes/${id}/approve`, {});
    assert.equal(refused.status, 502);
    assert.match(String(refused.json.error), /commentBody invalide/);
    const row = world.store.getAtlassianWrite(id);
    assert.deepEqual([row?.state, row?.error], ["failed", "MCP error -32602: commentBody invalide"]);
    assert.deepEqual(world.store.eventsOfType("atlassian_write").at(-1)?.payload, {
      id,
      state: "failed",
      kind: "comment",
    });
    const empty = await api.call(api.tokens.approver, "POST", `/v1/atlassian/writes/${id}/approve`, { body: "" });
    assert.equal(empty.status, 409, "plus proposé");
  } finally {
    await api.close();
  }
});

test("atlassian/AC-12 : écritures réservées aux jobs du poste, non connecté explicite, lectures bornées et non fiables, corpo_recall sans connexion", async () => {
  const { fake, world, desk } = setup();
  assert.equal(isAtlassianTool("jira_search"), true);
  assert.equal(isAtlassianTool("workstation_act"), false);
  assert.deepEqual(
    ATLASSIAN_READ_TOOLS.map((tool) => tool.name),
    ["atlassian_search", "jira_search", "jira_issue", "confluence_search", "confluence_page", "corpo_recall"],
  );
  assert.deepEqual(
    ATLASSIAN_WRITE_TOOLS.map((tool) => tool.name),
    ["jira_transition", "jira_comment_propose"],
  );
  const run = { by: "run:r1", writes: false };
  const notConnected = await desk.runTool("jira_search", { jql: "project = PROJ" }, run, signal());
  assert.deepEqual(notConnected, {
    text: "Atlassian n'est pas connecté : l'approbateur le branche depuis l'app (Poste › Atlassian)",
    isError: true,
  });
  world.oracle.memories = [
    { id: "m1", text: "Les mises en production ont lieu le mardi.", tags: ["corpo"], score: 1, createdAt: null },
  ];
  const recall = await desk.runTool("corpo_recall", { query: "mise en production" }, run, signal());
  assert.equal(recall.isError, undefined);
  assert.match(recall.text, /mardi/);
  assert.equal(CORPO_SCOPE, "corpo");
  connectAtlassian(world);
  for (const name of ["jira_transition", "jira_comment_propose"]) {
    const refused = await desk.runTool(name, { key: "PROJ-1", transition: "x", body: "x", why: "x" }, run, signal());
    assert.deepEqual(refused, { text: "écriture Jira réservée aux jobs du poste", isError: true });
  }
  assert.equal(fake.calls.length, 0, "aucun appel à Atlassian");
  fake.issues[0] = { ...(fake.issues[0] as (typeof fake.issues)[number]), summary: "x".repeat(20_000) };
  const long = await desk.runTool("jira_issue", { key: "PROJ-1" }, run, signal());
  assert.ok(long.text.startsWith(UNTRUSTED_BEGIN) && long.text.endsWith(UNTRUSTED_END));
  assert.match(long.text, /\n\(tronqué\)\n/);
  assert.ok(long.text.length < 12_400);
  const search = await desk.runTool("atlassian_search", { query: "paiement", limit: 3 }, run, signal());
  assert.equal(search.isError, undefined);
  assert.deepEqual(fake.calls.at(-1)?.args, { cloudId: FAKE_CLOUD_ID, query: "paiement", limit: 10 });
  const jql = await desk.runTool("jira_search", { jql: "assignee = currentUser()" }, run, signal());
  assert.equal(jql.isError, undefined);
  assert.deepEqual(fake.calls.at(-1)?.args.maxResults, 20);
  const foreign = await desk.runTool("confluence_page", { url: "https://ailleurs.example/wiki/1" }, run, signal());
  assert.equal(foreign.isError, true);
  const page = await desk.runTool("confluence_page", { url: `${FAKE_SITE}/wiki/spaces/X/pages/42` }, run, signal());
  assert.equal(page.isError, undefined, page.text);
  assert.deepEqual(fake.calls.at(-1)?.args, {
    cloudId: FAKE_CLOUD_ID,
    content_url: `${FAKE_SITE}/wiki/spaces/X/pages/42`,
    content_format: "markdown",
  });
  const badKey = await desk.runTool("jira_issue", { key: "pas une clé" }, run, signal());
  assert.equal(badKey.isError, true);
  assert.deepEqual(await desk.runTool("inconnu", {}, run, signal()), {
    text: "outil inconnu : inconnu",
    isError: true,
  });
});

// -- AC-13 : plan du jour ---------------------------------------------------------------------------

test("atlassian/AC-13 : savePlan valide et normalise le plan (dépôt non déclaré, adresse non http, bornes), l'annonce et le garde hors des issues publiques", async () => {
  const { world, desk } = setup();
  const api = await serve(world);
  try {
    assert.equal((await api.call(api.tokens.operator, "GET", "/v1/atlassian/plan")).json.plan, null);
    const plan = desk.savePlan(
      {
        trigger: "auto",
        summary: "Trois priorités : paiement, revue du schéma, réunion d'équipe.",
        items: [
          {
            title: "Livrer le module de paiement",
            why: "échéance vendredi",
            next: "lancer le run",
            source: "jira",
            key: "proj-1",
            url: "https://exemple.atlassian.net/browse/PROJ-1",
            repo: "demo",
            request: "Implémenter le module de paiement",
          },
          {
            title: "Préparer la réunion",
            source: "agenda",
            key: "pas une clé",
            url: "javascript:alert(1)",
            repo: "inconnu",
            request: "ne doit pas rester",
          },
        ],
      },
      "poste:poste-plan",
    );
    assert.deepEqual(plan.items, [
      {
        title: "Livrer le module de paiement",
        why: "échéance vendredi",
        next: "lancer le run",
        source: "jira",
        key: "PROJ-1",
        url: "https://exemple.atlassian.net/browse/PROJ-1",
        repo: "demo",
        request: "Implémenter le module de paiement",
      },
      {
        title: "Préparer la réunion",
        why: "",
        next: "",
        source: "agenda",
        key: null,
        url: null,
        repo: null,
        request: null,
      },
    ]);
    assert.deepEqual([plan.trigger, plan.by], ["auto", "poste:poste-plan"]);
    assert.equal(desk.latestPlan()?.id, plan.id);
    assert.equal(desk.lastPlanAt(), plan.createdAt);
    assert.equal(desk.status().plan.lastAt, plan.createdAt);
    const read = await api.call(api.tokens.operator, "GET", "/v1/atlassian/plan");
    assert.equal((read.json.plan as { id: string }).id, plan.id);
    const event = world.store.eventsOfType("atlassian_plan").at(-1);
    assert.deepEqual([event?.payload, event?.repo], [{ id: plan.id }, null]);
    const alert = event ? alertFor(event, world.store) : null;
    assert.deepEqual(
      [alert?.kind, alert?.title, alert?.audience, alert?.key],
      ["plan", "Plan du jour prêt", "owner", `plan:${plan.id}`],
    );
    assert.match(String(alert?.body), /^Trois priorités/);
    const texts = world.store.workstationTexts(0);
    assert.ok(texts.includes("Livrer le module de paiement") && texts.includes(plan.summary));
    assert.ok(!texts.includes("demo"), "le nom du dépôt n'est pas un texte de la boîte");
    const invalid = (input: { summary: unknown; items: unknown }, message: RegExp) =>
      assert.throws(
        () => desk.savePlan({ ...input, trigger: "manual" }, "poste:poste-plan"),
        (error: unknown) => {
          assert.equal((error as { status?: number }).status, 400);
          assert.match((error as Error).message, message);
          return true;
        },
      );
    invalid({ summary: "", items: [] }, /summary/);
    invalid({ summary: "x".repeat(4001), items: [] }, /summary/);
    invalid({ summary: "ok", items: "rien" }, /items/);
    invalid({ summary: "ok", items: Array.from({ length: 31 }, () => ({ title: "t" })) }, /items/);
    invalid({ summary: "ok", items: [{ title: "" }] }, /items\[0\]\.title/);
    invalid({ summary: "ok", items: [{ title: "x".repeat(201) }] }, /items\[0\]\.title/);
    invalid({ summary: "ok", items: [{ title: "t", why: "x".repeat(501) }] }, /items\[0\]\.why/);
    invalid({ summary: "ok", items: [{ title: "t", source: "slack" }] }, /items\[0\]\.source/);
    assert.equal(desk.latestPlan()?.id, plan.id, "un plan refusé n'est pas rangé");
  } finally {
    await api.close();
  }
});

// -- AC-14, AC-15 : routes ------------------------------------------------------------------------

test("atlassian/AC-14 : les routes sont au propriétaire (pilote, restreint : 403) et leurs gestes à l'approbateur (403 sinon) ; plan et savoir demandés une fois", async () => {
  const { world, desk } = setup();
  const api = await serve(world);
  try {
    for (const token of [api.tokens.pilot, api.tokens.narrow]) {
      assert.equal((await api.call(token, "GET", "/v1/atlassian")).status, 403);
      assert.equal((await api.call(token, "GET", "/v1/atlassian/writes")).status, 403);
      assert.equal((await api.call(token, "GET", "/v1/atlassian/plan")).status, 403);
    }
    assert.equal((await api.call(api.tokens.viewer, "GET", "/v1/atlassian")).status, 200);
    assert.equal((await api.call(api.tokens.viewer, "POST", "/v1/atlassian/connect", {})).status, 403);
    const gestures: [string, string][] = [
      ["POST", "/v1/atlassian/connect"],
      ["POST", "/v1/atlassian/callback"],
      ["DELETE", "/v1/atlassian"],
      ["POST", "/v1/atlassian/writes/aw1/approve"],
      ["POST", "/v1/atlassian/writes/aw1/dismiss"],
      ["POST", "/v1/atlassian/plan"],
      ["POST", "/v1/atlassian/knowledge"],
    ];
    for (const [method, route] of gestures) {
      const reply = await api.call(api.tokens.operator, method, route, {});
      assert.equal(reply.status, 403, `${method} ${route}`);
      assert.match(String(reply.json.error), /approbateur/);
      assert.equal((await api.call(api.tokens.pilot, method, route, {})).status, 403);
    }
    assert.equal((await api.call(api.tokens.approver, "POST", "/v1/atlassian/plan", {})).status, 409, "non connecté");
    assert.equal((await api.call(api.tokens.approver, "POST", "/v1/atlassian/knowledge", {})).status, 409);
    connectAtlassian(world);
    assert.deepEqual(
      await api.call(api.tokens.approver, "POST", "/v1/atlassian/plan", {}).then((r) => [r.status, r.json]),
      [202, { queued: true }],
    );
    assert.equal((await api.call(api.tokens.approver, "POST", "/v1/atlassian/knowledge", {})).status, 202);
    assert.deepEqual([desk.takePlanRequest(), desk.takePlanRequest()], [true, false]);
    assert.deepEqual([desk.takeKnowledgeRequest(), desk.takeKnowledgeRequest()], [true, false]);
    assert.equal(desk.lastKnowledgeAt(), null);
    desk.recordKnowledge({ summary: "  12 souvenirs : conventions de revue, glossaire.  ", at: 1_700_000_000_000 });
    assert.equal(desk.lastKnowledgeAt(), 1_700_000_000_000);
    assert.deepEqual(desk.status().knowledge, {
      everyHours: 24,
      lastAt: 1_700_000_000_000,
      lastSummary: "12 souvenirs : conventions de revue, glossaire.",
    });
    assert.ok(API_FEATURES.includes("atlassian"));
  } finally {
    await api.close();
  }
});

test("atlassian/AC-15 : atlassian.enabled false — routes en 404, retour public non servi, outils refusés", async () => {
  const { world, desk } = setup({ patch: (config) => (config.atlassian.enabled = false) });
  connectAtlassian(world);
  const api = await serve(world);
  try {
    for (const [method, route] of [
      ["GET", "/v1/atlassian"],
      ["POST", "/v1/atlassian/connect"],
      ["GET", "/v1/atlassian/writes"],
      ["GET", "/v1/atlassian/plan"],
      ["POST", "/v1/atlassian/plan"],
    ] as const) {
      const reply = await api.call(api.tokens.approver, method, route, method === "GET" ? undefined : {});
      assert.deepEqual([reply.status, reply.json], [404, { error: "Atlassian désactivé (atlassian.enabled)" }], route);
    }
    assert.equal((await api.call(null, "GET", `/v1/atlassian/callback?code=${FAKE_CODE}&state=x`)).status, 401);
    const tool = await desk.runTool("jira_search", { jql: "project = PROJ" }, POSTE, signal());
    assert.deepEqual(tool, { text: "Atlassian est désactivé sur ce serveur (atlassian.enabled)", isError: true });
    assert.equal(desk.status().enabled, false);
  } finally {
    await api.close();
  }
});

// -- AC-16 : événements ------------------------------------------------------------------------------

test("atlassian/AC-16 : branchement, écritures et plans émettent atlassian, atlassian_write et atlassian_plan, sans dépôt", async () => {
  for (const type of ["atlassian", "atlassian_write", "atlassian_plan"])
    assert.ok(EVENT_TYPES.some((known) => known === type));
  const { world } = setup();
  const api = await serve(world);
  try {
    const url = await begin(api);
    const back = `${LOOPBACK_REDIRECT}?code=${FAKE_CODE}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`;
    assert.equal((await api.call(api.tokens.approver, "POST", "/v1/atlassian/callback", { url: back })).status, 200);
    const desk = world.orchestrator.atlassian;
    await desk.runTool("jira_comment_propose", { key: "PROJ-1", body: "Un.", why: "a" }, POSTE, signal());
    await desk.runTool("jira_comment_propose", { key: "PROJ-1", body: "Deux.", why: "b" }, POSTE, signal());
    await desk.runTool("jira_transition", { key: "PROJ-2", transition: "En revue", why: "c" }, POSTE, signal());
    const [second, first] = world.store.listAtlassianWrites({ state: "proposed" });
    assert.equal(
      (await api.call(api.tokens.approver, "POST", `/v1/atlassian/writes/${first?.id}/approve`, {})).status,
      200,
    );
    assert.equal(
      (await api.call(api.tokens.approver, "POST", `/v1/atlassian/writes/${second?.id}/dismiss`, {})).status,
      200,
    );
    const plan = desk.savePlan({ summary: "Journée calme.", items: [], trigger: "manual" }, "poste:poste-plan");
    assert.equal((await api.call(api.tokens.approver, "DELETE", "/v1/atlassian")).status, 200);
    const of = (type: string) => world.store.eventsOfType(type);
    assert.deepEqual(
      of("atlassian").map((event) => event.payload),
      [{ connected: true }, { connected: false }],
    );
    assert.deepEqual(
      of("atlassian_write").map((event) => [event.payload.state, event.payload.kind]),
      [
        ["proposed", "comment"],
        ["proposed", "comment"],
        ["sent", "transition"],
        ["sent", "comment"],
        ["dismissed", "comment"],
      ],
    );
    assert.deepEqual(
      of("atlassian_plan").map((event) => event.payload),
      [{ id: plan.id }],
    );
    for (const type of ["atlassian", "atlassian_write", "atlassian_plan"])
      for (const event of of(type)) assert.deepEqual([event.repo, event.runId], [null, null]);
  } finally {
    await api.close();
  }
});
