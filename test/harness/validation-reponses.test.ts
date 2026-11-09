// La validation et l'envoi des réponses proposées par la veille du poste (canaux/reponses.ts) :
// écarter (brouillon Gmail supprimé), modifier puis valider (brouillon mis à jour avant le dépôt),
// valider d'un geste (notification), et l'envoi par le seul navigateur piloté sous l'empreinte des
// destinataires et du texte complet figée à la validation. Google est une doublure derrière
// l'option `fetch` ; l'extension est simulée par l'API. Données fictives seulement (exemple.fr).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { replyFingerprint as extensionFingerprint } from "../../omp-chrome/src/lib/outbound.ts";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { ChannelFetch } from "../../omp-harness/canaux/channels.ts";
import { REPLY_APPROVER, REPLY_NOT_SENT, replyFingerprint } from "../../omp-harness/canaux/reponses.ts";
import type { WatchItemView } from "../../omp-harness/canaux/veille.ts";
import type { WatchItemRow, WorkstationAction, WorkstationRequest } from "../../omp-harness/db.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { UNTRUSTED_BEGIN } from "../../omp-harness/workstation-guards.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);
const DAY = 86_400_000;
const TABS = { "X-OMP-Agent-Tabs": "1,2,3" };
const PAGE_PRINT = "f".repeat(64);
const COLLEAGUE = "alice@exemple.fr";
const CONVERSATION = "C0EXEMPLE";
const DRAFT_URL = "gmail.googleapis.com/gmail/v1/users/me/drafts/draft-1";
const TO_HANDLE = "/v1/workstation/watch?state=open,validated,failed";
const SEND = { kind: "click", params: { tabId: 1, ref: "e1" }, rationale: "envoyer la réponse validée" };
const ACT = (args: Record<string, unknown>) => ({ tool: "workstation_act", args });
const REPORT = (report: string) => ({ tool: "workstation_request_report", args: { report } });

/** La doublure de Google : brouillons créés, mis à jour et supprimés ; chaque appel est noté. */
class Google {
  readonly calls: { key: string; body: unknown }[] = [];
  readonly fetch: ChannelFetch = async (url, init) => {
    const parsed = new URL(url);
    const key = `${init.method} ${parsed.host}${parsed.pathname}`;
    this.calls.push({ key, body: init.body === undefined ? null : JSON.parse(init.body) });
    const status = init.method === "DELETE" ? 204 : 200;
    const body = init.method === "DELETE" ? "" : JSON.stringify({ id: "draft-1" });
    return { status, headers: { get: () => null }, text: async () => body };
  };
  keys(): string[] {
    return this.calls.map((c) => c.key);
  }
}

type Api = {
  approver: string;
  admin: string;
  narrow: string;
  call: <T = Record<string, unknown>>(
    method: string,
    route: string,
    body?: unknown,
    token?: string,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; json: T }>;
  close: () => Promise<void>;
};

type World = { w: FakeWorld; google: Google; api: Api };

async function setup(scenario: Record<string, unknown> = {}): Promise<World> {
  const google = new Google();
  const w = fakeWorld(scenario, { fetch: google.fetch });
  fs.mkdirSync(path.dirname(w.config.channelsFile), { recursive: true });
  const expiresAt = Date.now() + DAY;
  fs.writeFileSync(
    w.config.channelsFile,
    JSON.stringify({
      version: 1,
      google: {
        clientId: "1234-abcdef.apps.googleusercontent.com",
        clientSecret: "secret-fictif",
        tokens: { access: "ya29.access-fictif", refresh: "1//refresh", expiresAt, scopes: [] },
      },
    }),
    { mode: 0o600 },
  );
  const state = { state: "connected", account: null, lastReadAt: null, error: null };
  w.store.setSetting("workstation.channels", { gmail: state, calendar: state, slack: state }, null);
  const clients = new ClientRegistry(path.join(tmpdir("validation-reponses-"), "clients.json"), ADMIN);
  const approver = clients.add("app-approbateur", "admin", "*", true).token;
  const admin = clients.add("mac", "admin", "*").token;
  const narrow = clients.add("mac-demo", "operator", ["demo"]).token;
  const server = http.createServer(createHandler({ orchestrator: w.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api: Api = {
    approver,
    admin,
    narrow,
    call: async <T>(method: string, route: string, body?: unknown, token = approver, headers = {}) => {
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
      return { status: response.status, json: (text ? JSON.parse(text) : null) as T };
    },
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
  return { w, google, api };
}

async function teardown(x: World): Promise<void> {
  await x.api.close();
  await x.w.orchestrator.stop();
}

let seq = 0;
/** Une réponse proposée par la veille : Gmail avec son brouillon `draft-1`, ou Slack (brouillon interne). */
function seed(x: World, channel: "gmail" | "slack", text: string, ready = false): WatchItemRow {
  seq++;
  const item = x.w.store.insertWatchItem({
    id: `wv-${seq}`,
    key: `reply:${channel}:m${seq}`,
    kind: "reply",
    ready,
    channel,
    messageId: `${channel}:m${seq}`,
    eventId: null,
    personId: null,
    topic: ready ? "planning" : null,
    subject: channel === "gmail" ? "Planning" : null,
    text,
    context:
      channel === "gmail"
        ? { to: [COLLEAGUE], threadId: `fil-${seq}` }
        : { to: [], threadId: "1700000000.000100", conversation: CONVERSATION },
    at: Date.now(),
  }) as WatchItemRow;
  return channel === "gmail"
    ? (x.w.store.setWatchDraft(item.id, { draftId: "draft-1", draftError: null }, Date.now()) as WatchItemRow)
    : item;
}

/** L'extension se présente (en ligne) et rapporte les onglets de la fenêtre de l'agent. */
async function online(x: World): Promise<void> {
  assert.equal((await x.api.call("GET", "/v1/workstation/next?wait=0", undefined, undefined, TABS)).status, 204);
}

async function lease(x: World): Promise<WorkstationAction> {
  const next = await x.api.call<{ action: WorkstationAction }>(
    "GET",
    "/v1/workstation/next?wait=25",
    undefined,
    undefined,
    TABS,
  );
  assert.equal(next.status, 200, "une action est louée");
  return next.json.action;
}

/** L'extension rend `needs_approval` avec l'empreinte de ce qu'elle enverrait (ou aucune). */
async function needsApproval(x: World, action: number, replyPrint: string | null): Promise<WorkstationAction> {
  const reply = await x.api.call<{ action: WorkstationAction }>("POST", `/v1/workstation/actions/${action}/result`, {
    outcome: "needs_approval",
    approval: {
      summary: "Envoyer la réponse",
      recipients: [COLLEAGUE],
      preview: "Bonjour",
      fingerprint: PAGE_PRINT,
      ...(replyPrint === null ? {} : { replyFingerprint: replyPrint }),
    },
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  return reply.json.action;
}

async function done(x: World, action: number): Promise<void> {
  const reply = await x.api.call("POST", `/v1/workstation/actions/${action}/result`, { outcome: "done" });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
}

async function validate(
  x: World,
  id: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ item: WatchItemView; request: WorkstationRequest }> {
  const reply = await x.api.call<{ item: WatchItemView; request: WorkstationRequest }>(
    "POST",
    `/v1/workstation/watch/${id}/validate`,
    body,
    undefined,
    headers,
  );
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  return reply.json;
}

const itemOf = (x: World, id: string) => x.w.orchestrator.watch.get(id).item;
const toHandle = async (x: World) =>
  (await x.api.call<{ items: WatchItemView[] }>("GET", TO_HANDLE)).json.items.map((item) => item.id);

/** Le corps d'un brouillon Gmail envoyé à la doublure : `{message: {raw, threadId}}`, vérifié. */
function draftOf(body: unknown): { raw: string; threadId: unknown } {
  assert.ok(body !== null && typeof body === "object" && "message" in body, "corps de brouillon attendu");
  const message = body.message;
  assert.ok(message !== null && typeof message === "object" && "raw" in message && typeof message.raw === "string");
  return { raw: message.raw, threadId: "threadId" in message ? message.threadId : undefined };
}

/** Le texte d'un brouillon Gmail (corps text/plain en base64). */
function draftText(body: unknown): string {
  const raw = Buffer.from(draftOf(body).raw, "base64url").toString("utf8");
  const encoded = raw.split("\r\n\r\n").slice(1).join("").replace(/\r\n/g, "");
  return Buffer.from(encoded, "base64").toString("utf8");
}

// -- l'empreinte : la même des deux côtés ---------------------------------------------------------

test("validation-reponses : l'empreinte du serveur est celle que calcule l'extension (destinataires normalisés, texte complet normalisé)", () => {
  const cases = [
    { recipients: [" Alice@Exemple.fr", "bob@exemple.fr", "alice@exemple.fr"], text: "Bonjour,\r\nOui.  \r\n" },
    { recipients: ["c0exemple"], text: "a\u00a0b\n\n\n\nc" },
    { recipients: [COLLEAGUE], text: `${"x".repeat(5000)}\nfin` },
  ];
  for (const input of cases) {
    const server = replyFingerprint(input);
    assert.match(String(server), /^[0-9a-f]{64}$/);
    assert.equal(server, extensionFingerprint(input));
  }
  assert.equal(
    replyFingerprint({ recipients: ["bob@exemple.fr", "ALICE@exemple.fr"], text: "Oui.\r\n" }),
    replyFingerprint({ recipients: ["alice@exemple.fr", "bob@exemple.fr"], text: "Oui." }),
  );
  const long = "y".repeat(2000);
  assert.notEqual(
    replyFingerprint({ recipients: [COLLEAGUE], text: `${long}A` }),
    replyFingerprint({ recipients: [COLLEAGUE], text: `${long}B` }),
  );
  assert.equal(replyFingerprint({ recipients: [], text: "x" }), null);
  assert.equal(extensionFingerprint({ recipients: [], text: "x" }), null);
});

// -- écarter ---------------------------------------------------------------------------------------

/** Écarter : brouillon Gmail supprimé, l'élément quitte À traiter, jamais reproposé ; Slack : rien chez Slack. */
async function dismissal(x: World): Promise<void> {
  const gmail = seed(x, "gmail", "Merci, je regarde.");
  const slack = seed(x, "slack", "Je regarde demain.");
  assert.deepEqual((await toHandle(x)).sort(), [gmail.id, slack.id].sort());
  // Gestes réservés : client restreint, client non approbateur.
  const narrow = await x.api.call("POST", `/v1/workstation/watch/${gmail.id}/dismiss`, undefined, x.api.narrow);
  assert.deepEqual([narrow.status, narrow.json], [403, { error: "le poste est réservé au propriétaire" }]);
  assert.equal(
    (await x.api.call("POST", `/v1/workstation/watch/${gmail.id}/dismiss`, undefined, x.api.admin)).status,
    403,
  );
  assert.deepEqual(x.google.keys(), [], "aucun appel avant le geste de l'approbateur");

  const dismissed = await x.api.call<{ item: WatchItemView }>("POST", `/v1/workstation/watch/${gmail.id}/dismiss`);
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.json));
  assert.equal(dismissed.json.item.state, "dismissed");
  assert.deepEqual(x.google.keys(), [`DELETE ${DRAFT_URL}`]);
  const slackGone = await x.api.call<{ item: WatchItemView }>("POST", `/v1/workstation/watch/${slack.id}/dismiss`);
  assert.equal(slackGone.json.item.state, "dismissed");
  assert.equal(x.google.calls.length, 1, "un brouillon Slack est interne : aucun appel");
  assert.deepEqual(await toHandle(x), [], "les deux quittent À traiter");
  // Le même message n'est plus reproposé : la clé de l'élément reste prise.
  assert.equal(x.w.store.hasWatchItem(gmail.key), true);
  assert.equal(x.w.store.insertWatchItem({ ...gmail, id: "wv-autre", at: Date.now() }), null);
  const again = await x.api.call("POST", `/v1/workstation/watch/${gmail.id}/dismiss`);
  assert.deepEqual([again.status, again.json], [409, { error: "la réponse est déjà écartée" }]);
  assert.ok(
    x.google.keys().every((key) => !key.includes("/send")),
    "aucun envoi par API",
  );
}

// -- modifier puis valider ------------------------------------------------------------------------

test("validation-reponses/AC-28 : écarter supprime le brouillon Gmail (DELETE drafts/{id}) et l'élément n'est plus reproposé ; modifier puis valider met le brouillon à jour (PUT drafts/{id}) avant le dépôt de l'envoi, et c'est ce texte qui part", async () => {
  const x = await setup({ "poste-demande": [[ACT(SEND), REPORT("Réponse envoyée.")]] });
  try {
    await dismissal(x);
    const item = seed(x, "gmail", "Merci, je regarde.");
    const edited = "Merci Alice,\nmardi 10 h me va.\nBonne journée";
    const stale = await x.api.call("POST", `/v1/workstation/watch/${item.id}/validate`, { text: edited }, undefined, {
      "If-Match": `"${item.rev - 1}"`,
    });
    assert.equal(stale.status, 412, "une révision dépassée ne valide rien");
    const { item: validated, request } = await validate(x, item.id, { text: edited }, { "If-Match": `"${item.rev}"` });
    assert.deepEqual([validated.state, validated.text, validated.requestId], ["validated", edited, request.id]);
    const put = x.google.calls.find((c) => c.key === `PUT ${DRAFT_URL}`);
    assert.ok(put, "le brouillon est mis à jour");
    assert.equal(draftText(put.body), edited);
    assert.equal(draftOf(put.body).threadId, item.context.threadId, "le brouillon reste dans son fil");
    assert.deepEqual(x.w.store.listWorkstationActions({ requestId: request.id }), [], "rien n'est déposé avant");
    assert.doesNotMatch(request.instruction, /alice|Planning|mardi/i, "la consigne ne porte aucune donnée de collègue");

    await online(x);
    await x.w.orchestrator.start();
    const send = await lease(x);
    assert.equal(send.requestId, request.id);
    const prompt = String(x.w.log().find((e) => e.kind === "prompt" && e.step === "poste-demande")?.message);
    assert.ok(
      prompt.includes(edited) && prompt.includes(UNTRUSTED_BEGIN),
      "le texte validé arrive encadré par untrusted()",
    );
    // L'ancien texte ne correspond plus : garde ordinaire ; le texte modifié : il part.
    const requeued = await needsApproval(x, send.seq, extensionFingerprint({ recipients: [COLLEAGUE], text: edited }));
    assert.deepEqual(
      [requeued.state, requeued.approved, requeued.approval?.decidedBy],
      ["queued", true, REPLY_APPROVER],
    );
    assert.equal(requeued.approval?.fingerprint, PAGE_PRINT, "l'extension garde son empreinte de page");
    assert.equal((await lease(x)).seq, send.seq);
    await done(x, send.seq);
    await waitFor(
      () => itemOf(x, item.id).state === "sent",
      () => JSON.stringify(itemOf(x, item.id)),
    );
    assert.deepEqual(await toHandle(x), [], "envoyée, elle quitte À traiter");
    assert.ok(
      x.google.keys().every((key) => !key.includes("/send")),
      "aucun envoi par API",
    );
  } finally {
    await teardown(x);
  }
});

// -- valider d'un geste (notification) ------------------------------------------------------------

test("validation-reponses/AC-29 : une réponse prête validée d'un geste (sans corps), empreinte égale : l'envoi part sans second geste, même en observe", async () => {
  const x = await setup({ "poste-demande": [[ACT(SEND), REPORT("Réponse envoyée.")]] });
  try {
    assert.equal(x.w.orchestrator.workstation.effective(), "observe");
    const text = "Oui, mardi me va.";
    const item = seed(x, "gmail", text, true);
    await online(x);
    const { item: validated } = await validate(x, item.id);
    assert.equal(validated.state, "validated");
    assert.equal(x.google.calls.length, 0, "texte inchangé : le brouillon reste tel quel");
    await x.w.orchestrator.start();
    const send = await lease(x);
    const approvals = x.w.store.eventsOfType("workstation_approval").length;
    const requeued = await needsApproval(x, send.seq, replyFingerprint({ recipients: [COLLEAGUE], text }));
    assert.equal(requeued.state, "queued");
    assert.equal(x.w.store.eventsOfType("workstation_approval").length, approvals, "aucune approbation demandée");
    await lease(x);
    await done(x, send.seq);
    await waitFor(
      () => itemOf(x, item.id).state === "sent",
      () => JSON.stringify(itemOf(x, item.id)),
    );
  } finally {
    await teardown(x);
  }
});

// -- empreinte différente, absente, ou action étrangère ---------------------------------------------

test("validation-reponses/AC-30 : texte différent après 2000 caractères, aucune empreinte, ou action hors de la demande rattachée : garde ordinaire, l'envoi attend l'approbateur ; un non-approbateur ne valide pas", async () => {
  const x = await setup({
    "poste-demande": [
      [ACT(SEND), REPORT("Envoi en attente d'approbation.")],
      [ACT(SEND), REPORT("Envoi en attente d'approbation.")],
    ],
  });
  try {
    const head = "z".repeat(2000);
    const long = seed(x, "gmail", `${head}fin validée`);
    const other = seed(x, "gmail", "Je reviens vers toi.");
    const refused = await x.api.call("POST", `/v1/workstation/watch/${long.id}/validate`, {}, x.api.admin);
    assert.equal(refused.status, 403, "un client non approbateur ne valide pas");
    assert.equal(itemOf(x, long.id).state, "open");

    await online(x);
    const first = await validate(x, long.id);
    await x.w.orchestrator.start();
    const send = await lease(x);
    const held = await needsApproval(
      x,
      send.seq,
      replyFingerprint({ recipients: [COLLEAGUE], text: `${head}autre fin` }),
    );
    assert.deepEqual([held.state, held.approved], ["awaiting_approval", false]);
    // Seul le geste de l'approbateur la fait partir ; la réponse est envoyée à son aboutissement.
    const approved = await x.api.call<{ action: WorkstationAction }>(
      "POST",
      `/v1/workstation/actions/${send.seq}/approve`,
      undefined,
      undefined,
      { "If-Match": `"${held.updatedAt}"` },
    );
    assert.equal(approved.json.action.state, "queued");
    await lease(x);
    await done(x, send.seq);
    await waitFor(
      () => itemOf(x, long.id).state === "sent",
      () => JSON.stringify(itemOf(x, long.id)),
    );
    await waitFor(
      () => x.w.store.getWorkstationRequest(first.request.id)?.state === "done",
      () => "la première demande ne finit pas",
    );

    const second = await validate(x, other.id);
    const otherSend = await lease(x);
    assert.equal(otherSend.requestId, second.request.id);
    const none = await needsApproval(x, otherSend.seq, null);
    assert.equal(none.state, "awaiting_approval", "aucune empreinte : garde ordinaire");

    // Une action d'une session (hors de la demande rattachée) qui rapporte l'empreinte validée.
    const printed = replyFingerprint({ recipients: [COLLEAGUE], text: "Je reviens vers toi." });
    const foreign = x.w.orchestrator.workstation.createAction(
      { kind: "click", params: { tabId: 1, ref: "e7" }, rationale: "un clic de session" },
      "session",
      "session",
    );
    const leased = await lease(x);
    assert.equal(leased.seq, foreign.seq);
    assert.equal((await needsApproval(x, foreign.seq, printed)).state, "awaiting_approval");
    assert.equal(itemOf(x, other.id).state, "validated", "la réponse attend toujours son envoi");
  } finally {
    await teardown(x);
  }
});

// -- Slack : le texte validé complet, saisi par le serveur ------------------------------------------

test("validation-reponses/AC-35 : une réponse Slack validée : le job saisit dans le fil le texte validé complet (plus de 4000 caractères), l'envoi part avec le requestId de la demande, la réponse passe envoyée", async () => {
  const x = await setup({
    "poste-demande": [[{ tool: "workstation_reply_type", args: { tabId: 1, ref: "e5" } }, REPORT("Réponse envoyée.")]],
  });
  try {
    const text = `${"Voici le détail. ".repeat(300)}\nÀ demain.`;
    assert.ok(text.length > 4000);
    const item = seed(x, "slack", text);
    await online(x);
    const { request } = await validate(x, item.id);
    await x.w.orchestrator.start();
    const typed = await lease(x);
    assert.deepEqual(
      [typed.kind, typed.requestId, typed.params.text, typed.params.submit],
      ["type", request.id, text, true],
    );
    const prompt = String(x.w.log().find((e) => e.kind === "prompt" && e.step === "poste-demande")?.message);
    assert.ok(prompt.includes(CONVERSATION), "le prompt nomme la conversation Slack");
    const requeued = await needsApproval(
      x,
      typed.seq,
      extensionFingerprint({ recipients: [CONVERSATION.toLowerCase()], text }),
    );
    assert.equal(requeued.state, "queued");
    await lease(x);
    await done(x, typed.seq);
    await waitFor(
      () => itemOf(x, item.id).state === "sent",
      () => JSON.stringify(itemOf(x, item.id)),
    );
    assert.deepEqual(
      x.google.keys().filter((key) => !key.startsWith("GET ")),
      [],
      "rien n'est écrit par API (seules les lectures des canaux passent)",
    );
  } finally {
    await teardown(x);
  }
});

// -- attente, pause, arrêt d'urgence ---------------------------------------------------------------

test("validation-reponses/AC-36 : extension hors ligne : validation gardée, demande en file avec sa raison ; en pause : 409, la réponse reste proposée ; arrêt d'urgence avant l'envoi : envoi non abouti avec la raison, revalidable, rien de redéposé seul", async () => {
  const x = await setup({ "poste-demande": [[ACT(SEND)], [REPORT("rien")]] });
  try {
    const item = seed(x, "gmail", "Merci, je regarde.");
    const { request } = await validate(x, item.id);
    await x.w.orchestrator.start();
    await waitFor(
      () => itemOf(x, item.id).request?.reason === "l'extension du poste est hors ligne",
      () => JSON.stringify(itemOf(x, item.id)),
    );
    assert.equal(itemOf(x, item.id).state, "validated");
    assert.deepEqual(await toHandle(x), [item.id], "validée en attente d'envoi : toujours dans À traiter");
    assert.equal(x.w.store.listWorkstationActions({ requestId: request.id }).length, 0);

    // L'extension revient : la demande part sans nouveau geste et dépose l'envoi.
    await online(x);
    const send = await lease(x);
    assert.equal(send.requestId, request.id);
    // L'arrêt d'urgence coupe la demande avant l'envoi.
    assert.equal((await x.api.call("POST", "/v1/workstation/stop")).status, 200);
    await waitFor(
      () => itemOf(x, item.id).state === "failed",
      () => JSON.stringify(itemOf(x, item.id)),
    );
    assert.ok((itemOf(x, item.id).sendError ?? "") !== "", "la raison est rendue");
    assert.deepEqual(await toHandle(x), [item.id], "envoi non abouti : toujours dans À traiter");
    assert.deepEqual(
      x.w.store.listWorkstationRequests({ states: ["queued", "running"] }),
      [],
      "rien n'est redéposé seul",
    );

    // En pause : la validation est refusée et la réponse reste où elle est.
    const paused = await x.api.call("POST", `/v1/workstation/watch/${item.id}/validate`, {});
    assert.deepEqual(
      [paused.status, paused.json],
      [409, { error: "le poste est en pause : la réponse reste proposée" }],
    );
    const fresh = seed(x, "gmail", "Je regarde.");
    assert.equal((await x.api.call("POST", `/v1/workstation/watch/${fresh.id}/validate`, {})).status, 409);
    assert.equal(itemOf(x, fresh.id).state, "open");

    // Reprise : la réponse non aboutie se revalide ; la demande close sans envoi la rend non aboutie.
    assert.equal((await x.api.call("PUT", "/v1/workstation/settings", { paused: false })).status, 200);
    await online(x);
    const again = await validate(x, item.id);
    assert.equal(again.item.state, "validated");
    await waitFor(
      () => itemOf(x, item.id).state === "failed" && itemOf(x, item.id).sendError === REPLY_NOT_SENT,
      () => JSON.stringify(itemOf(x, item.id)),
    );
  } finally {
    await teardown(x);
  }
});
