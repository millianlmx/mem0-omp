// Feature « Obscura conteneurisé sur le VPS », agent corpo : l'exécuteur `vps` du poste (il loue
// la file comme une extension et l'exécute par CDP dans `obscura-poste`), ses gardes (les mêmes
// que l'extension : hôtes permis, garde d'envoi et empreinte, arrêt d'urgence, pause), le mirroir
// de la session du Chrome source, la connexion interactive et l'état des comptes. Tout tourne
// contre un VRAI `obscura serve` v0.2.6 (bash scripts/obscura.sh --prepare) ; les pages « slack »
// et « gmail » sont servies sous leurs noms par un proxy témoin (`--proxy`), jamais par le réseau.
// Les valeurs de cookies sont des sentinelles ; aucun hôte, jeton ni donnée réels.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { agentScript, bundleFiles } from "../../omp-harness/browser/agent-bundle.ts";
import type { Lookup } from "../../omp-harness/browser/guard.ts";
import { parseMirrorCookies } from "../../omp-harness/browser/vps-policy.ts";
import { validateConfig, browserFromEnv, defaultConfig } from "../../omp-harness/config.ts";
import type { WorkstationAction } from "../../omp-harness/db.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { notificationFor } from "../../omp-harness/notify.ts";
import type { WorkstationStatus } from "../../omp-harness/workstation.ts";
import { CookieMirror } from "../../omp-chrome/src/lib/cookie-mirror.ts";
import type { MirrorState } from "../../omp-chrome/src/lib/cookie-mirror.ts";
import { classifyOutbound, sendFingerprint } from "../../omp-chrome/src/lib/outbound.ts";
import type { OutboundContext } from "../../omp-chrome/src/lib/outbound.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { obscuraBin, pageServer, startObscura } from "../support/obscura.ts";
import type { PageServer, RunningObscura, Route } from "../support/obscura.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

/** Une adresse publique pour tout nom : le pré-contrôle DNS du harness ne sort jamais du test. */
const PUBLIC_LOOKUP: Lookup = async () => [{ address: "93.184.216.34" }];
const SENTINEL = "sentinelle-cookie-7f3a9c";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const page = (title: string, body: string): Route => ({
  body: `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
});
const SEND = `onclick="fetch('/send',{method:'POST',body:'x'})"`;
/** Le compositeur d'une messagerie : un éditeur riche et un bouton Envoyer dans un même dialogue. */
const composer = (text: string, hints = "") =>
  `<div role="dialog">${hints}<div role="textbox" contenteditable="true" aria-multiline="true" aria-label="Message">${text}</div><button aria-label="Envoyer" ${SEND}>Envoyer</button></div>`;

const SLACK_URL = "http://app.slack.com/client/T1/C1";
const GMAIL_URL = "http://mail.google.com/mail/u/0/";

const ROUTES: Record<string, Route> = {
  "http://app.slack.com/hello": page("Bonjour Slack", "<p>page Slack de test</p>"),
  [SLACK_URL]: page("Canal général", composer("bonjour")),
  [GMAIL_URL]: page("Brouillon", composer("Salut Bob", '<span email="Bob@Example.test">Bob</span>')),
  "http://app.slack.com/client": page("Accueil Slack", "<p>connecté</p>"),
  "http://app.slack.com/signin": page("Connexion Slack", "<p>connectez-vous</p>"),
  "http://evil.test/": page("Hors liste", "<p>hors liste</p>"),
  "http://accounts.google.com/signin": page(
    "Connexion Google",
    `<button id="go" style="position:absolute;left:10px;top:10px;width:300px;height:100px" onclick="location.href='http://idp.corp.test/sso'">Continuer</button>
     <input id="q" style="position:absolute;left:10px;top:200px;width:300px;height:40px" oninput="fetch('/typed?v='+encodeURIComponent(this.value))"><script>document.getElementById('q').focus()</script>`,
  ),
  "http://accounts.google.com/vers-idp": { status: 302, headers: { location: "http://idp.corp.test/sso" }, body: "" },
  "http://accounts.google.com/vers-ailleurs": { status: 302, headers: { location: "http://evil.test/" }, body: "" },
  "http://idp.corp.test/sso": page("IdP de l'entreprise", "<p>identifiant</p>"),
  "/send": "ok",
  "/typed": "ok",
};

type Reply<T> = { status: number; json: T };
type Rig = {
  world: FakeWorld;
  pages: PageServer;
  obscura: RunningObscura;
  url: string;
  approver: string;
  ordinary: string;
  /** Tout ce que l'API a rendu (pour chercher des valeurs qui n'y ont pas leur place). */
  responses: string[];
  /** Les lignes du journal structuré du service. */
  logs: string[];
  call: <T = Record<string, unknown>>(
    token: string,
    method: string,
    route: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Reply<T>>;
  stop: () => Promise<void>;
};

type RigOptions = {
  allowedHosts?: string[];
  probe?: Partial<Record<"slack.com" | "google.com", string>>;
};

/** Un harness complet dont le navigateur du poste est un vrai Obscura derrière un proxy témoin. */
async function rig(t: { skip(message: string): void }, options: RigOptions = {}): Promise<Rig | null> {
  const bin = obscuraBin(t);
  if (bin === null) return null;
  const pages = await pageServer(ROUTES);
  const obscura = await startObscura(bin, { proxy: pages.url });
  const logs: string[] = [];
  const world = fakeWorld(
    {},
    {
      patch: (config) => {
        config.workstation.vps = { url: obscura.url, token: obscura.token };
        config.workstation.allowedHosts = options.allowedHosts ?? [];
      },
      vps: {
        lookup: PUBLIC_LOOKUP,
        pollSec: 1,
        retryMs: 200,
        probeUrls: options.probe ?? {},
        probeEveryMs: 3_600_000,
      },
      harnessLog: (line, fields) => logs.push(`${line} ${JSON.stringify(fields ?? {})}`),
    },
  );
  const clients = new ClientRegistry(path.join(tmpdir("obscura-poste-"), "clients.json"));
  const approver = clients.add("app-approbateur", "admin", "*", true).token;
  const ordinary = clients.add("extension", "operator", "*", false).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const responses: string[] = [];
  const made: Rig = {
    world,
    pages,
    obscura,
    url,
    approver,
    ordinary,
    responses,
    logs,
    call: async <T>(
      token: string,
      method: string,
      route: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
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
      responses.push(text);
      return { status: response.status, json: (text ? JSON.parse(text) : null) as T };
    },
    stop: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await world.orchestrator.stop();
      await obscura.stop();
      await pages.stop();
    },
  };
  world.orchestrator.vps.start();
  await online(made);
  return made;
}

const workstation = (r: Rig) => r.world.orchestrator.workstation;

async function online(r: Rig): Promise<void> {
  await waitFor(
    () => workstation(r).online(Date.now(), "vps"),
    () => "le navigateur vps n'est pas en ligne",
    15_000,
  );
}

async function deposit(r: Rig, body: Record<string, unknown>, expected = 201): Promise<WorkstationAction> {
  const reply = await r.call<{ action: WorkstationAction }>(r.approver, "POST", "/v1/workstation/actions", {
    browserId: "vps",
    rationale: "test",
    ...body,
  });
  assert.equal(reply.status, expected, JSON.stringify(reply.json));
  return reply.json.action;
}

async function settled(
  r: Rig,
  seq: number,
  states: string[] = ["done", "failed", "awaiting_approval"],
): Promise<WorkstationAction> {
  await waitFor(
    () => states.includes(workstation(r).getAction(seq).state),
    () => `action #${seq} : ${JSON.stringify(workstation(r).getAction(seq))}`,
    25_000,
  );
  return workstation(r).getAction(seq);
}

async function openTab(r: Rig, url: string): Promise<number> {
  const done = await settled(r, (await deposit(r, { kind: "open", params: { url } })).seq);
  assert.equal(done.state, "done", JSON.stringify(done));
  const data = done.result?.data as { tabId: number };
  return data.tabId;
}

/** Les refs du dernier snapshot de l'onglet, par rôle et libellé. */
async function refs(r: Rig, tabId: number): Promise<Record<string, string>> {
  const done = await settled(r, (await deposit(r, { kind: "snapshot", params: { tabId } })).seq);
  assert.equal(done.state, "done", JSON.stringify(done));
  const data = done.result?.data as { elements: { ref: string; role: string; label: string }[] };
  const elements = data.elements;
  return Object.fromEntries(elements.map((element) => [`${element.role}:${element.label}`, element.ref]));
}

/** Le long-poll d'une extension : l'action louée, ou `null` (204). */
async function extensionPoll(r: Rig, headers: Record<string, string>): Promise<WorkstationAction | null> {
  const reply = await r.call<{ action: WorkstationAction }>(
    r.ordinary,
    "GET",
    "/v1/workstation/next?wait=0",
    undefined,
    headers,
  );
  return reply.status === 200 ? reply.json.action : null;
}

const EXT = { "X-OMP-Browser": "b-ext", "X-OMP-Browser-Label": "Chrome", "X-OMP-Agent-Tabs": "1" };

test("obscura-poste/AC-16 : le poste montre `vps` en ligne quand `obscura-poste` répond ; injoignable, il passe hors ligne et refuse une action comme une extension hors ligne", async (t) => {
  const r = await rig(t);
  if (r === null) return;
  try {
    const status = (await r.call<WorkstationStatus>(r.approver, "GET", "/v1/workstation")).json;
    const vps = status.browsers.find((browser) => browser.id === "vps");
    assert.ok(vps, "vps figure dans les navigateurs du poste");
    assert.equal(vps.online, true);
    assert.equal(vps.label, "VPS (Obscura)");
    // Le navigateur du serveur n'est jamais le défaut d'une extension sans identifiant.
    assert.notEqual(status.defaultBrowser, "vps");

    await r.obscura.stop();
    await waitFor(
      () => !workstation(r).online(Date.now(), "vps"),
      () => "vps reste en ligne",
      10_000,
    );
    const refused = await r.call(r.approver, "POST", "/v1/workstation/actions", {
      kind: "tabs",
      params: {},
      rationale: "test",
      browserId: "vps",
    });
    assert.deepEqual([refused.status, refused.json], [409, { error: "l'extension du poste est hors ligne" }]);
    const after = (await r.call<WorkstationStatus>(r.approver, "GET", "/v1/workstation")).json;
    assert.equal(after.browsers.find((browser) => browser.id === "vps")?.online, false);
  } finally {
    await r.stop();
  }

  // Les réglages : l'URL et le jeton du navigateur du poste se valident et se lisent dans l'environnement.
  const config = defaultConfig();
  assert.deepEqual(config.workstation.vps, { url: null, token: null });
  const env = { OBSCURA_POSTE_CDP_URL: "http://obscura-poste:9222", OBSCURA_POSTE_CDP_TOKEN: "a".repeat(64) };
  assert.deepEqual(browserFromEnv(defaultConfig(), env).workstation.vps, {
    url: env.OBSCURA_POSTE_CDP_URL,
    token: env.OBSCURA_POSTE_CDP_TOKEN,
  });
  const broken = defaultConfig();
  broken.workstation.vps = { url: "https://obscura-poste:9222", token: null };
  assert.throws(() => validateConfig(broken), /workstation\.vps\.url : http:\/\/ ou ws:\/\/ attendu/);
  broken.workstation.vps = { url: null, token: "court" };
  assert.throws(() => validateConfig(broken), /workstation\.vps\.token : 32 caractères au moins/);
});

test("obscura-poste/AC-17 : une action `navigate` déposée pour `vps` charge la page sous un hôte autorisé dans `obscura-poste` et passe `done` ; le long-poll d'une extension ne la rend jamais", async (t) => {
  const r = await rig(t, { allowedHosts: ["app.slack.com"] });
  if (r === null) return;
  try {
    assert.equal(await extensionPoll(r, EXT), null);
    const tabId = await openTab(r, "http://app.slack.com/client");
    const action = await deposit(r, { kind: "navigate", params: { tabId, url: "http://app.slack.com/hello" } });
    assert.equal(await extensionPoll(r, EXT), null, "l'extension ne prend pas l'action du navigateur vps");
    const done = await settled(r, action.seq);
    assert.equal(done.state, "done", JSON.stringify(done));
    assert.match(done.result?.text ?? "", /Bonjour Slack/);
    assert.ok(r.pages.requests().some((request) => request.host === "app.slack.com" && request.path === "/hello"));
    // Le contenu rendu à l'agent par un snapshot de la page chargée.
    const snapshot = await settled(r, (await deposit(r, { kind: "snapshot", params: { tabId } })).seq);
    assert.match(JSON.stringify(snapshot.result?.data), /page Slack de test/);
    assert.equal(await extensionPoll(r, EXT), null);
  } finally {
    await r.stop();
  }
});

test("obscura-poste/AC-18 : un geste qu'Obscura ne sait pas faire (téléchargement) passe `failed` avec une raison qui nomme la limite", async (t) => {
  const r = await rig(t);
  if (r === null) return;
  try {
    const tabId = await openTab(r, "http://app.slack.com/hello");
    const action = await deposit(r, { kind: "download", params: { tabId, url: "http://app.slack.com/fichier.txt" } });
    const done = await settled(r, action.seq);
    assert.equal(done.state, "failed", JSON.stringify(done));
    assert.match(done.error ?? "", /Obscura ne gère pas les téléchargements/);
    assert.match(done.error ?? "", /limite du moteur/);
    assert.equal(done.result, null, "aucun succès n'est rendu");
  } finally {
    await r.stop();
  }
});

/** Ce que l'extension rendrait sur la page du compositeur : sa logique (`classifyOutbound`, `sendFingerprint`) sur le même cas. */
function expectedOutbound(host: string, pathname: string, title: string, text: string, hints: string[]) {
  const context: OutboundContext = {
    host,
    path: pathname,
    title,
    gesture: "click",
    target: {
      tag: "button",
      role: "button",
      type: "",
      label: "Envoyer",
      inComposer: true,
      editable: false,
      formHasFreeText: false,
      formIsSearch: false,
      submitsForm: false,
    },
    composerText: text,
    recipientHints: hints,
  };
  const verdict = classifyOutbound(context);
  return {
    verdict,
    fingerprint: sendFingerprint({
      origin: `http://${host}`,
      path: pathname,
      title,
      recipients: verdict.recipients,
      text,
    }),
  };
}

test("obscura-poste/AC-19 : un clic sur Envoyer (Slack, Gmail) ou une saisie avec envoi est retenu `awaiting_approval` avec le résumé, les destinataires, l'aperçu et l'empreinte de l'extension ; rien ne part", async (t) => {
  const r = await rig(t);
  if (r === null) return;
  try {
    // Slack : un clic sur Envoyer.
    const slackTab = await openTab(r, SLACK_URL);
    const slackRefs = await refs(r, slackTab);
    const slack = await settled(
      r,
      (await deposit(r, { kind: "click", params: { tabId: slackTab, ref: slackRefs["button:Envoyer"] } })).seq,
    );
    assert.equal(slack.state, "awaiting_approval", JSON.stringify(slack));
    const wantSlack = expectedOutbound("app.slack.com", "/client/T1/C1", "Canal général", "bonjour", []);
    assert.match(slack.approval?.summary ?? "", /sur Slack/);
    assert.deepEqual(
      [slack.approval?.summary, slack.approval?.recipients, slack.approval?.preview, slack.approval?.fingerprint],
      [wantSlack.verdict.summary, wantSlack.verdict.recipients, wantSlack.verdict.preview, wantSlack.fingerprint],
    );

    // Gmail : les destinataires sont lus sur la page.
    const gmailTab = await openTab(r, GMAIL_URL);
    const gmailRefs = await refs(r, gmailTab);
    const gmail = await settled(
      r,
      (await deposit(r, { kind: "click", params: { tabId: gmailTab, ref: gmailRefs["button:Envoyer"] } })).seq,
    );
    assert.equal(gmail.state, "awaiting_approval", JSON.stringify(gmail));
    const wantGmail = expectedOutbound("mail.google.com", "/mail/u/0/", "Brouillon", "Salut Bob", ["Bob@Example.test"]);
    assert.match(gmail.approval?.summary ?? "", /sur Gmail/);
    assert.deepEqual(gmail.approval?.recipients, ["bob@example.test"]);
    assert.deepEqual(
      [gmail.approval?.summary, gmail.approval?.recipients, gmail.approval?.preview, gmail.approval?.fingerprint],
      [wantGmail.verdict.summary, wantGmail.verdict.recipients, wantGmail.verdict.preview, wantGmail.fingerprint],
    );

    // Une saisie suivie d'un envoi : retenue de même, le texte saisi est l'aperçu.
    const box = slackRefs["textbox:Message"] ?? "";
    const typed = await settled(
      r,
      (await deposit(r, { kind: "type", params: { tabId: slackTab, ref: box, text: "salut tous", submit: true } })).seq,
    );
    assert.equal(typed.state, "awaiting_approval", JSON.stringify(typed));
    assert.match(typed.approval?.preview ?? "", /salut tous/);
    assert.ok(!r.pages.requests().some((request) => request.path === "/send"), "aucun envoi n'est parti");
  } finally {
    await r.stop();
  }
});

test("obscura-poste/AC-20 : un envoi approuvé part si l'empreinte recalculée est identique ; la page changée, rien ne part et l'action repasse `awaiting_approval`", async (t) => {
  const r = await rig(t);
  if (r === null) return;
  const approve = async (action: WorkstationAction) =>
    r.call(r.approver, "POST", `/v1/workstation/actions/${action.seq}/approve`, undefined, {
      "If-Match": `"${action.updatedAt}"`,
    });
  try {
    const tab = await openTab(r, SLACK_URL);
    const buttons = await refs(r, tab);
    const send = { kind: "click", params: { tabId: tab, ref: buttons["button:Envoyer"] } };

    // La page inchangée : approuvé, l'envoi part.
    const held = await settled(r, (await deposit(r, send)).seq);
    assert.equal(held.state, "awaiting_approval");
    assert.equal((await approve(held)).status, 200);
    const sent = await settled(r, held.seq, ["done", "failed"]);
    assert.equal(sent.state, "done", JSON.stringify(sent));
    await waitFor(
      () => r.pages.requests().some((request) => request.path === "/send"),
      () => "l'envoi approuvé n'est pas parti",
    );

    // La page change entre l'approbation et le rejeu : l'empreinte diffère, rien ne part de plus.
    const before = r.pages.requests().filter((request) => request.path === "/send").length;
    const second = await settled(r, (await deposit(r, send)).seq);
    assert.equal(second.state, "awaiting_approval");
    const edit = await settled(
      r,
      (
        await deposit(r, {
          kind: "type",
          params: { tabId: tab, ref: buttons["textbox:Message"], text: "tout autre texte" },
        })
      ).seq,
    );
    assert.equal(edit.state, "done", JSON.stringify(edit));
    assert.equal((await approve(second)).status, 200);
    const replayed = await settled(r, second.seq, ["awaiting_approval", "done", "failed"]);
    await sleep(500);
    assert.equal(workstation(r).getAction(second.seq).state, "awaiting_approval", JSON.stringify(replayed));
    assert.notEqual(workstation(r).getAction(second.seq).approval?.fingerprint, second.approval?.fingerprint);
    assert.equal(r.pages.requests().filter((request) => request.path === "/send").length, before, "rien n'est parti");
  } finally {
    await r.stop();
  }
});

test("obscura-poste/AC-21 : un hôte hors de la liste attend l'humain comme pour l'extension, et le proxy ne voit aucune requête vers lui", async (t) => {
  const r = await rig(t, { allowedHosts: ["app.slack.com"] });
  if (r === null) return;
  try {
    const open = await deposit(r, { kind: "open", params: { url: "http://evil.test/" } });
    assert.equal(open.state, "awaiting_approval");
    assert.match(open.approval?.summary ?? "", /evil\.test hors de la liste des hôtes permis/);
    const tab = await openTab(r, "http://app.slack.com/hello");
    const navigate = await deposit(r, { kind: "navigate", params: { tabId: tab, url: "http://evil.test/" } });
    assert.equal(navigate.state, "awaiting_approval");
    await sleep(800);
    assert.equal(workstation(r).getAction(open.seq).state, "awaiting_approval", "l'exécuteur ne la prend pas");
    assert.ok(
      !r.pages.requests().some((request) => request.host === "evil.test"),
      "aucune requête vers l'hôte hors liste",
    );
  } finally {
    await r.stop();
  }
});

test("obscura-poste/AC-22 : l'arrêt d'urgence interrompt l'exécution en cours dans un délai borné et annule les actions en attente ; en pause, l'exécuteur ne prend rien", async (t) => {
  const r = await rig(t);
  if (r === null) return;
  try {
    const tab = await openTab(r, "http://app.slack.com/hello");
    const long = await deposit(r, {
      kind: "wait_for",
      params: { tabId: tab, text: "n'arrive jamais", timeoutMs: 10_000 },
    });
    await waitFor(
      () => workstation(r).getAction(long.seq).state === "running",
      () => "l'action n'est pas en cours",
    );
    const started = Date.now();
    assert.equal((await r.call(r.ordinary, "POST", "/v1/workstation/stop")).status, 200);
    const stopped = workstation(r).getAction(long.seq);
    assert.equal(stopped.state, "refused");
    assert.match(stopped.error ?? "", /arrêt d'urgence/);
    // Plus aucun geste : l'exécuteur est libre en moins de 3 s (la tâche de 10 s n'est pas attendue).
    await sleep(1500);
    const requests = r.pages.requests().length;
    await sleep(1500);
    assert.equal(r.pages.requests().length, requests, "aucune requête après l'arrêt");
    assert.equal(workstation(r).getAction(long.seq).state, "refused", "l'issue tardive n'écrase pas l'annulation");
    assert.ok(Date.now() - started < 9000);

    // En pause : une action en file n'est pas prise ; la reprise (approbateur) la libère.
    const waiting = r.world.store.createWorkstationAction({
      origin: "session",
      by: null,
      kind: "tabs",
      params: {},
      rationale: "test",
      state: "queued",
      browserId: "vps",
    });
    await sleep(1200);
    assert.equal(workstation(r).getAction(waiting.seq).state, "queued", "en pause, rien n'est loué");
    assert.equal((await r.call(r.approver, "PUT", "/v1/workstation/settings", { paused: false })).status, 200);
    assert.equal((await settled(r, waiting.seq)).state, "done");
  } finally {
    await r.stop();
  }
});

test("obscura-poste/AC-23 : le navigateur par défaut du poste (`vps` ou une extension) décide qui exécute une action sans `browserId`", async (t) => {
  const r = await rig(t);
  if (r === null) return;
  try {
    await extensionPoll(r, EXT);
    const settings = (body: Record<string, unknown>) => r.call(r.approver, "PUT", "/v1/workstation/settings", body);
    assert.equal((await settings({ defaultBrowser: "vps" })).status, 200);
    const reply = await r.call<{ action: WorkstationAction }>(r.approver, "POST", "/v1/workstation/actions", {
      kind: "tabs",
      params: {},
      rationale: "test",
    });
    assert.equal(reply.json.action.browserId, "vps");
    assert.equal((await settled(r, reply.json.action.seq)).state, "done", "c'est vps qui l'exécute");
    assert.equal(await extensionPoll(r, EXT), null);

    assert.equal((await settings({ defaultBrowser: "b-ext" })).status, 200);
    const other = await r.call<{ action: WorkstationAction }>(r.approver, "POST", "/v1/workstation/actions", {
      kind: "tabs",
      params: {},
      rationale: "test",
    });
    assert.equal(other.json.action.browserId, "b-ext");
    assert.equal((await extensionPoll(r, EXT))?.seq, other.json.action.seq, "l'extension la loue");
    assert.equal(workstation(r).getAction(other.json.action.seq).state, "running");
    // Une extension ne peut pas se faire passer pour le navigateur du serveur.
    const claimed = await r.call(r.ordinary, "GET", "/v1/workstation/next?wait=0", undefined, {
      "X-OMP-Browser": "vps",
    });
    assert.equal(claimed.status, 400);
  } finally {
    await r.stop();
  }
});

/** Un cookie tel que `chrome.cookies` le rend (domaine pointé : cookie de domaine ; sinon host-only), valeur sentinelle. */
const cookie = (domain: string, name = "d", value = SENTINEL) => ({
  name,
  value,
  domain,
  path: "/",
  secure: false,
  httpOnly: true,
  hostOnly: !domain.startsWith("."),
  sameSite: "lax" as const,
  expirationDate: Date.now() / 1000 + 3600.5,
});

const putSettings = (r: Rig, body: Record<string, unknown>, token = r.approver) =>
  r.call(token, "PUT", "/v1/workstation/settings", body);
const mirrorOf = (r: Rig, headers: Record<string, string> = EXT) =>
  r.call<{ mirror: { generation: string } | null }>(
    r.ordinary,
    "GET",
    "/v1/workstation/vps/mirror",
    undefined,
    headers,
  );
const push = (r: Rig, body: Record<string, unknown>, headers: Record<string, string> = EXT) =>
  r.call<{ set: number; removed: number }>(r.ordinary, "POST", "/v1/workstation/vps/cookies", body, headers);

/** L'extension `b-ext` se présente, l'approbateur la choisit comme source : rend la génération du mirroir. */
async function mirrorFrom(r: Rig): Promise<string> {
  await extensionPoll(r, EXT);
  assert.equal((await putSettings(r, { mirrorBrowser: "b-ext" })).status, 200);
  const generation = (await mirrorOf(r)).json.mirror?.generation;
  assert.equal(typeof generation, "string", "la source lit une génération");
  return generation as string;
}

/** Les en-têtes Cookie des requêtes servies pour `host` + `path`, dans l'ordre. */
const cookiesSeen = (r: Rig, host: string, pathname: string) =>
  r.pages
    .requests()
    .filter((request) => request.host === host && request.path === pathname)
    .map((request) => request.cookie);

async function navigate(r: Rig, tabId: number, url: string): Promise<void> {
  const done = await settled(r, (await deposit(r, { kind: "navigate", params: { tabId, url } })).seq);
  assert.equal(done.state, "done", JSON.stringify(done));
}

test("obscura-poste/AC-24 : la session du Chrome source (tous ses domaines, cookies host-only compris) est posée dans `obscura-poste`, ses suppressions y sont reportées, et l'état des comptes est relu après la copie entière", async (t) => {
  const r = await rig(t, { probe: { "slack.com": "http://app.slack.com/client" } });
  if (r === null) return;
  try {
    await extensionPoll(r, EXT);
    assert.equal((await putSettings(r, { mirrorBrowser: "b-ext" })).status, 200);
    // L'extension source, par son propre module : copie entière au premier tour, puis les changements.
    let stored: MirrorState | null = null;
    const mirror = new CookieMirror({
      getAll: async () => [
        cookie(".slack.com", "d"),
        cookie("app.slack.com", "sub", `${SENTINEL}-sub`),
        cookie("evil.test", "autre", `${SENTINEL}-autre`),
      ],
      load: async () => stored,
      save: async (state) => {
        stored = state;
      },
    });
    const target = { url: r.url, token: r.ordinary, browser: { id: "b-ext", label: "Chrome" } };
    await mirror.tick(target);
    assert.notEqual(stored, null, "la génération est rangée après la copie entière");
    await waitFor(
      () =>
        workstation(r)
          .vpsAccounts()
          .find((account) => account.domain === "slack.com")?.state === "connected",
      () => `compte slack non relu : ${JSON.stringify(workstation(r).vpsAccounts())}`,
      20_000,
    );

    // Sans filtre de domaine : la page Slack porte ses deux cookies (domaine et host-only), un hôte quelconque le sien.
    const tab = await openTab(r, "http://app.slack.com/hello");
    const slack = cookiesSeen(r, "app.slack.com", "/hello").at(-1) ?? "";
    assert.ok(slack.includes(`d=${SENTINEL}`) && slack.includes(`sub=${SENTINEL}-sub`), slack);
    await navigate(r, tab, "http://evil.test/");
    assert.ok((cookiesSeen(r, "evil.test", "/").at(-1) ?? "").includes(`autre=${SENTINEL}-autre`));

    // Un cookie disparu de Chrome disparaît d'Obscura.
    mirror.recordChange({ removed: true, cause: "explicit", cookie: cookie(".slack.com", "d") });
    await mirror.flush(target);
    assert.equal(mirror.pending, 0);
    await navigate(r, tab, "http://app.slack.com/hello");
    const after = cookiesSeen(r, "app.slack.com", "/hello").at(-1) ?? "";
    assert.ok(!after.includes(`d=${SENTINEL}`) && after.includes(`sub=${SENTINEL}-sub`), after);

    const status = (await r.call<WorkstationStatus>(r.approver, "GET", "/v1/workstation")).json;
    assert.equal(status.mirrorBrowser, "b-ext");
    assert.equal(typeof status.browsers.find((browser) => browser.id === "vps")?.mirroredAt, "number");
  } finally {
    await r.stop();
  }
});

test("obscura-poste/AC-25 : sans source choisie, depuis une autre extension, avec une génération périmée ou un cookie mal formé, l'envoi est refusé et rien n'est posé ; `vps` ne peut pas être sa propre source", async (t) => {
  const r = await rig(t);
  if (r === null) return;
  const OTHER = { "X-OMP-Browser": "b-autre", "X-OMP-Browser-Label": "Chrome perso" };
  try {
    await extensionPoll(r, EXT);
    assert.deepEqual((await mirrorOf(r)).json, { mirror: null }, "aucune source choisie");
    assert.equal((await push(r, { generation: "x", set: [cookie(".slack.com")] })).status, 403);
    assert.equal((await putSettings(r, { mirrorBrowser: "vps" })).status, 400);
    assert.equal((await putSettings(r, { mirrorBrowser: "inconnu" })).status, 404);

    const generation = await mirrorFrom(r);
    await extensionPoll(r, OTHER);
    assert.deepEqual((await mirrorOf(r, OTHER)).json, { mirror: null }, "une autre extension n'est pas la source");
    assert.equal((await push(r, { generation, set: [cookie(".slack.com")] }, OTHER)).status, 403);
    assert.equal((await push(r, { generation: "perimee", set: [cookie(".slack.com")] })).status, 409);

    // Un cookie mal formé refuse tout l'envoi.
    const valid = cookie(".slack.com");
    for (const broken of [
      { ...valid, domain: "http://slack.com" },
      { ...valid, path: "relatif" },
      { ...valid, name: "" },
      { ...valid, value: 3 },
    ])
      assert.equal((await push(r, { generation, set: [valid, broken] })).status, 400, JSON.stringify(broken));
    const many = Array.from({ length: 1001 }, (_, index) => cookie(".slack.com", `c${index}`));
    assert.equal((await push(r, { generation, set: many })).status, 400, "plus de 1000 cookies");

    // Coupé : plus de génération, plus d'envoi.
    assert.equal((await putSettings(r, { mirrorBrowser: null })).status, 200);
    assert.deepEqual((await mirrorOf(r)).json, { mirror: null });
    assert.equal((await push(r, { generation, set: [valid] })).status, 403);

    // Aucun cookie n'a été posé : la page présente un en-tête Cookie vide.
    await openTab(r, "http://app.slack.com/hello");
    const seen = cookiesSeen(r, "app.slack.com", "/hello");
    assert.ok(seen.length > 0 && seen.every((header) => header === ""), JSON.stringify(seen));
  } finally {
    await r.stop();
  }
});

test("obscura-poste/AC-26 : un client non approbateur (jeton ordinaire de l'extension) ne peut ni choisir la source du mirroir ni ouvrir une connexion : 403", async (t) => {
  const r = await rig(t);
  if (r === null) return;
  try {
    await extensionPoll(r, EXT);
    assert.equal((await putSettings(r, { mirrorBrowser: "b-ext" }, r.ordinary)).status, 403);
    assert.equal(
      (await r.call(r.ordinary, "POST", "/v1/workstation/vps/login", { url: "http://accounts.google.com/signin" }))
        .status,
      403,
    );
    assert.equal((await r.call(r.ordinary, "GET", "/v1/workstation/vps/login/frame")).status, 403);
    assert.equal(
      (await r.call(r.ordinary, "POST", "/v1/workstation/vps/login/input", { type: "key", key: "Enter" })).status,
      403,
    );
    assert.equal((await r.call(r.ordinary, "DELETE", "/v1/workstation/vps/login")).status, 403);
  } finally {
    await r.stop();
  }
});

test("obscura-poste/AC-27 : aucune valeur de cookie dans la base (WAL compris), les journaux, les événements, les réponses d'API ni les appels à la mémoire, après un envoi du mirroir accepté puis un envoi refusé", async (t) => {
  const r = await rig(t, { probe: { "slack.com": "http://app.slack.com/client" } });
  if (r === null) return;
  const refusedValue = `${SENTINEL}-refuse`;
  try {
    const generation = await mirrorFrom(r);
    const ok = await push(r, { generation, full: true, last: true, set: [cookie(".slack.com")] });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const refused = await push(r, {
      generation,
      set: [cookie(".slack.com"), { ...cookie("evil.test", "x", refusedValue), path: "relatif" }],
    });
    assert.equal(refused.status, 400);
    await openTab(r, "http://app.slack.com/hello");
    await r.call(r.approver, "GET", "/v1/workstation");

    const needles = [SENTINEL, refusedValue];
    const found = (haystack: string | Buffer, where: string) => {
      for (const needle of needles) assert.ok(!haystack.includes(needle), `${where} contient une valeur de cookie`);
    };
    for (const entry of fs.readdirSync(r.world.config.dataDir))
      if (entry.startsWith("harness.sqlite"))
        found(fs.readFileSync(path.join(r.world.config.dataDir, entry)), `la base (${entry})`);
    found(r.logs.join("\n"), "les journaux");
    found(r.responses.join("\n"), "les réponses d'API");
    found(JSON.stringify(r.world.store.eventsOfType("workstation_account")), "les événements");
    found(JSON.stringify(r.world.oracle), "les appels à la mémoire");
  } finally {
    await r.stop();
  }
});

test("obscura-poste/AC-36 : un cookie host-only du mirroir part en `url` sans `domain` (Obscura rejette sinon les `__Host-…`), un cookie de domaine garde son domaine pointé et son échéance entière", () => {
  const [hostOnly, domain] = parseMirrorCookies([
    {
      ...cookie("accounts.google.com", "__Host-GAPS"),
      secure: true,
      sameSite: "no_restriction",
      expirationDate: 1_900_000_000.25,
    },
    { ...cookie(".google.com", "SID"), expirationDate: 1_900_000_000.75 },
  ]);
  assert.deepEqual(hostOnly, {
    name: "__Host-GAPS",
    value: SENTINEL,
    path: "/",
    secure: true,
    httpOnly: true,
    url: "https://accounts.google.com/",
    sameSite: "None",
    expires: 1_900_000_000,
  });
  assert.deepEqual(domain, {
    name: "SID",
    value: SENTINEL,
    path: "/",
    secure: false,
    httpOnly: true,
    domain: ".google.com",
    sameSite: "Lax",
    expires: 1_900_000_000,
  });
});

const PNG_BASE64 = "iVBORw0KGgo";

test("obscura-poste/AC-28 : la connexion interactive (approbateur seulement) rend des images de la page, applique clics et frappes, suit un IdP listé dans `allowedHosts`, refuse les autres hôtes et un départ hors slack.com/google.com", async (t) => {
  const r = await rig(t, { allowedHosts: ["idp.corp.test"] });
  if (r === null) return;
  const login = (body: unknown) =>
    r.call<{ login: { host: string; error: string | null } | null }>(
      r.approver,
      "POST",
      "/v1/workstation/vps/login",
      body,
    );
  const frame = () =>
    r.call<{ image: string; mime: string; host: string; width: number; height: number }>(
      r.approver,
      "GET",
      "/v1/workstation/vps/login/frame",
    );
  const input = (body: unknown) =>
    r.call<Record<string, unknown>>(r.approver, "POST", "/v1/workstation/vps/login/input", body);
  const close = () => r.call(r.approver, "DELETE", "/v1/workstation/vps/login");
  try {
    // Un départ hors des domaines de compte est refusé.
    assert.equal((await login({ url: "http://example.com/" })).status, 400);
    assert.equal((await login({ url: "http://slack.com.evil.test/" })).status, 400);

    // Google : des images de la page, une frappe et un clic appliqués dans obscura-poste.
    assert.equal((await login({ url: "http://accounts.google.com/signin" })).status, 201);
    assert.equal(
      (await login({ url: "http://accounts.google.com/signin" })).status,
      409,
      "une seule connexion à la fois",
    );
    const first = await frame();
    assert.equal(first.status, 200, JSON.stringify(first.json).slice(0, 200));
    assert.equal(first.json.mime, "image/png");
    assert.ok(first.json.image.startsWith(PNG_BASE64), "une image PNG");
    assert.equal((await input({ type: "text", text: "bonjour" })).status, 200);
    await waitFor(
      () => r.pages.requests().some((request) => request.path === "/typed?v=bonjour"),
      () => `la frappe n'est pas arrivée dans la page : ${JSON.stringify(r.pages.requests())}`,
      5000,
    );
    assert.equal(
      (await input({ type: "click", x: 50, y: 50 })).status,
      200,
      "clic sur Continuer : l'IdP listé est suivi",
    );
    const next = await frame();
    assert.equal(next.status, 200);
    assert.equal(next.json.host, "idp.corp.test");
    assert.equal((await input({ type: "key", key: "Enter" })).status, 200);
    assert.equal((await input({ type: "click", x: 5000, y: 5 })).status, 400, "geste hors fenêtre");
    assert.equal((await input({ type: "key", key: "F13" })).status, 400, "touche hors liste");
    assert.equal((await close()).status, 200);
    assert.deepEqual((await r.call(r.approver, "GET", "/v1/workstation/vps/login")).json, { login: null });

    // Une redirection vers un IdP listé est suivie ; vers un hôte non listé, la connexion est refusée.
    assert.equal((await login({ url: "http://accounts.google.com/vers-idp" })).status, 201);
    assert.equal((await frame()).json.host, "idp.corp.test");
    await close();
    const away = await login({ url: "http://accounts.google.com/vers-ailleurs" });
    assert.equal(away.status, 409, JSON.stringify(away.json));
    assert.match(JSON.stringify(away.json), /navigation refusée/);
    assert.equal((await frame()).status, 409, "plus aucune image d'un hôte refusé");
    assert.equal((await input({ type: "key", key: "Enter" })).status, 409);
    await close();
  } finally {
    await r.stop();
  }
});

test("obscura-poste/AC-29 : chaque compte porte un état (non connecté, connecté, expiré, bloqué) sans cookie ni jeton ; une session qui devient expirée passe à expiré avec une seule alerte", async (t) => {
  const r = await rig(t, { probe: { "slack.com": "http://app.slack.com/client" } });
  if (r === null) return;
  const accounts = async () =>
    (await r.call<WorkstationStatus>(r.approver, "GET", "/v1/workstation")).json.browsers.find(
      (browser) => browser.id === "vps",
    )?.accounts;
  try {
    assert.deepEqual(
      (await accounts())?.map((account) => [account.domain, account.state]),
      [
        ["slack.com", "disconnected"],
        ["google.com", "disconnected"],
      ],
    );
    workstation(r).setVpsAccount("google.com", "blocked");
    assert.deepEqual(
      (await accounts())?.map((account) => [account.domain, account.state]),
      [
        ["slack.com", "disconnected"],
        ["google.com", "blocked"],
      ],
    );
    // Une copie entière du mirroir dont la page d'accueil s'ouvre : connecté.
    const generation = await mirrorFrom(r);
    const copied = await push(r, { generation, full: true, last: true, set: [cookie(".slack.com")] });
    assert.equal(copied.status, 200, JSON.stringify(copied.json));
    await waitFor(
      () =>
        workstation(r)
          .vpsAccounts()
          .find((account) => account.domain === "slack.com")?.state === "connected",
      () => "slack.com n'est pas passé connecté après la copie",
      20_000,
    );
    assert.ok(!/cookie|token|jeton|valeur/i.test(JSON.stringify(await accounts())), "ni cookie ni jeton dans l'état");

    // La session ne s'ouvre plus : la page de connexion remplace la page attendue — expiré, une seule alerte.
    const tab = await openTab(r, "http://app.slack.com/hello");
    assert.equal(
      (
        await settled(
          r,
          (
            await deposit(r, { kind: "navigate", params: { tabId: tab, url: "http://app.slack.com/signin" } })
          ).seq,
        )
      ).state,
      "done",
    );
    assert.equal((await accounts())?.find((account) => account.domain === "slack.com")?.state, "expired");
    assert.equal(
      (
        await settled(
          r,
          (
            await deposit(r, { kind: "navigate", params: { tabId: tab, url: "http://app.slack.com/signin" } })
          ).seq,
        )
      ).state,
      "done",
    );
    const events = r.world.store.eventsOfType("workstation_account");
    const expired = events.filter((event) => event.payload.state === "expired");
    assert.equal(expired.length, 1, "une seule alerte pour ce passage");
    assert.match(notificationFor(expired[0] as never, null)?.title ?? "", /session expirée/);
    assert.equal(
      notificationFor(events.find((event) => event.payload.state === "connected") as never, null),
      null,
      "les autres passages ne notifient pas",
    );
  } finally {
    await r.stop();
  }
});

/** Les modules relatifs que `file` importe (`import … from "./x.ts"`, types compris), résolus en chemins absolus. */
function relativeImports(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  return [...source.matchAll(/(?:import|export)\s[^"';]*?from\s+"(\.[^"]+)"/g)].map((match) =>
    path.resolve(path.dirname(file), match[1] as string),
  );
}

/** Les modules atteints depuis `entry`, entrée comprise. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dep of relativeImports(file)) visit(dep);
  };
  visit(entry);
  return [...seen];
}

const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("obscura-poste/AC-35 : chaque module de l'exécuteur `vps` et de la garde d'envoi partagée est sous un dossier que Dockerfile.harness copie, et aucun n'est une copie d'un fichier d'omp-chrome", () => {
  const dockerfile = fs.readFileSync(
    path.join(ROOT, "omp-harness", "deploy", "container", "Dockerfile.harness"),
    "utf8",
  );
  // Les dossiers du dépôt que le Dockerfile copie dans l'image (COPY <source> <destination>).
  const copied = [...dockerfile.matchAll(/^COPY\s+(?!--)(\S+)\s+\S+/gm)].map((match) =>
    path.join(ROOT, match[1] as string),
  );
  const under = (file: string) => copied.some((dir) => file === dir || file.startsWith(`${dir}${path.sep}`));

  const entry = path.join(ROOT, "omp-harness", "main.ts");
  const executor = path.join(ROOT, "omp-harness", "browser", "vps.ts");
  const chain = reachable(entry);
  assert.ok(chain.includes(executor), "l'exécuteur `vps` est atteint depuis main.ts");
  // Le côté page de l'extension, évalué dans la page d'Obscura : les mêmes fichiers que le build de l'extension.
  const pageSide = bundleFiles().map((file) => path.join(ROOT, "omp-chrome", "src", file));
  const modules = [...new Set([...chain.filter((file) => file.startsWith(ROOT)), ...pageSide])];
  for (const file of modules)
    assert.ok(under(file), `${path.relative(ROOT, file)} n'est sous aucun dossier copié par Dockerfile.harness`);
  assert.ok(
    chain.some((file) => file.endsWith(path.join("omp-chrome", "src", "lib", "actions.ts"))),
    "validateAction vient d'omp-chrome",
  );
  for (const needed of ["outbound.ts", "composer.ts"])
    assert.ok(
      pageSide.some((file) => file.endsWith(path.join("lib", needed))),
      `${needed} est dans le bundle`,
    );

  // Une seule source : aucun fichier d'omp-harness n'est une copie (même contenu) d'un fichier d'omp-chrome.
  const extension = new Map<string, string>();
  const walk = (dir: string, into: (file: string) => void): void => {
    for (const entryName of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entryName.name);
      if (entryName.isDirectory()) walk(full, into);
      else if (entryName.name.endsWith(".ts")) into(full);
    }
  };
  walk(path.join(ROOT, "omp-chrome", "src"), (file) => extension.set(sha(file), file));
  walk(path.join(ROOT, "omp-harness"), (file) => {
    const twin = extension.get(sha(file));
    assert.equal(
      twin,
      undefined,
      `${path.relative(ROOT, file)} est une copie de ${twin === undefined ? "" : path.relative(ROOT, twin)}`,
    );
  });
  const script = agentScript();
  for (const symbol of ["classifyOutbound", "inspectGesture", "sendFingerprint"])
    assert.ok(script.includes(symbol), `${symbol} figure dans le script injecté`);
});
