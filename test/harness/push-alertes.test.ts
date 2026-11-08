// Feature push-alertes : les alertes push des appareils iOS (APNs `push-type: alert`).
// Un appareil s'enregistre au nom de son client (`POST /v1/push/devices`) et reçoit ce
// que ce client voit : runs de ses dépôts, alertes du serveur s'il voit tout, envois du
// poste s'il est l'approbateur ; la catégorie dit le geste permis ; la charge ne porte
// que des identifiants ; un jeton mort est oublié ; une alerte ne part qu'une fois.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { ApnsConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import { API_FEATURES, createHandler } from "../../omp-harness/http.ts";
import type { ApnsReply, ApnsTransport } from "../../omp-harness/push.ts";
import { ApnsClient } from "../../omp-harness/push.ts";
import { ALERT_CATEGORIES, ALERT_DEDUP_MS, ALERT_KINDS, AlertPusher } from "../../omp-harness/push-alerts.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);
const PEM = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const APNS: ApnsConfig = {
  keyFile: "/cle.p8",
  keyId: "KEY123",
  teamId: "TEAM456",
  topic: "com.omp.console.ios",
  sandbox: false,
};

type Sent = Parameters<ApnsTransport>[0] & { json: { aps: Record<string, unknown>; omp: Record<string, unknown> } };

/** Un serveur HTTP sur le monde, et de quoi l'interroger au nom d'un client. */
async function serve(world: FakeWorld, clients: ClientRegistry) {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    call: async (method: string, route: string, token: string, body?: unknown) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      return { status: response.status, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await world.orchestrator.stop();
    },
  };
}

/** Une base, un registre de clients, et le pousseur d'alertes branché sur un APNs doublé. */
function bench(options: { apns?: ApnsConfig | null } = {}) {
  let now = 1_700_000_000_000;
  const dir = tmpdir("push-alertes-");
  const store = new Store(path.join(dir, "h.sqlite"), () => now);
  const clients = new ClientRegistry(path.join(dir, "clients.json"), ADMIN);
  const sent: Sent[] = [];
  const replies = new Map<string, ApnsReply>();
  const config = options.apns === undefined ? APNS : options.apns;
  const transport: ApnsTransport = async (request) => {
    sent.push({ ...request, json: JSON.parse(request.body) as Sent["json"] });
    return replies.get(request.path.slice("/3/device/".length)) ?? { status: 200, reason: null };
  };
  const apns = new ApnsClient({ config: () => config, transport, readKey: () => PEM, now: () => now });
  const pusher = new AlertPusher({ store, apns, config: () => config, now: () => now });
  pusher.useClients(clients);
  pusher.subscribe();
  store.createRun({ id: "r1", repo: "demo", slug: "a", title: "Panier", request: "a", branch: "harness/a" });
  store.createRun({ id: "r2", repo: "autre", slug: "b", title: "Facture", request: "b", branch: "harness/b" });
  const device = (name: string) => name.repeat(32);
  return {
    store,
    clients,
    sent,
    replies,
    pusher,
    device,
    advance: (ms: number) => {
      now += ms;
    },
    /** Les envois de la dernière vague, par jeton d'appareil (deux caractères). */
    take: async () => {
      await pusher.idle();
      const wave = new Map(sent.map((request) => [request.path.slice("/3/device/".length, -62), request]));
      assert.equal(wave.size, sent.length, "un appareil ne reçoit qu'un envoi par alerte");
      sent.length = 0;
      return wave;
    },
  };
}

test("push-alertes/AC-1 : un appareil s'enregistre au nom de son client (lecteur suffit) et n'oublie que les siens ; un admin les oublie tous", async () => {
  const world = fakeWorld({});
  const clients = new ClientRegistry(path.join(tmpdir("push-alertes-api-"), "clients.json"), ADMIN);
  const iphone = clients.add("iphone", "viewer", ["demo"]).token;
  const ipad = clients.add("ipad", "operator", "*").token;
  const api = await serve(world, clients);
  try {
    const token = "ab".repeat(32);
    const first = await api.call("POST", "/v1/push/devices", iphone, {
      token,
      platform: "ios",
      environment: "sandbox",
    });
    assert.deepEqual([first.status, first.json], [201, { registered: true, pushes: false }]);
    const again = await api.call("POST", "/v1/push/devices", iphone, {
      token,
      platform: "ios",
      environment: "production",
    });
    assert.equal(again.status, 200, "un appareil connu n'est pas recréé");
    assert.deepEqual(
      world.store.listPushDevices().map(({ token: t, client, environment }) => [t, client, environment]),
      [[token, "iphone", "production"]],
    );
    for (const body of [
      { token: "pas-hexa", platform: "ios", environment: "sandbox" },
      { token, platform: "android", environment: "sandbox" },
      { token, platform: "ios", environment: "dev" },
    ])
      assert.equal((await api.call("POST", "/v1/push/devices", iphone, body)).status, 400, JSON.stringify(body));
    assert.equal((await api.call("POST", "/v1/push/devices", "x".repeat(64), { token })).status, 401);

    // Le même jeton enregistré par un autre client passe à ce client : un seul jeu de droits par appareil.
    await api.call("POST", "/v1/push/devices", ipad, {
      token: "cd".repeat(32),
      platform: "ios",
      environment: "sandbox",
    });
    const foreign = await api.call("DELETE", `/v1/push/devices/${"cd".repeat(32)}`, iphone);
    assert.deepEqual([foreign.status, foreign.json.removed], [200, false], "l'appareil d'un autre client reste");
    const own = await api.call("DELETE", `/v1/push/devices/${token}`, iphone);
    assert.deepEqual([own.status, own.json.removed], [200, true]);
    const admin = await api.call("DELETE", `/v1/push/devices/${"cd".repeat(32)}`, ADMIN);
    assert.deepEqual([admin.status, admin.json.removed], [200, true]);
    assert.deepEqual(world.store.listPushDevices(), []);
    assert.ok((API_FEATURES as readonly string[]).includes("push-alerts"));
  } finally {
    await api.close();
  }
});

test("push-alertes/AC-2 : une alerte de run part aux appareils des clients qui voient son dépôt, groupée par run, avec la catégorie du geste permis et la révision du run", async () => {
  const b = bench();
  b.clients.add("lecteur", "viewer", ["demo"]);
  b.clients.add("operateur", "operator", ["demo"]);
  b.clients.add("ailleurs", "operator", ["autre"]);
  b.store.putPushDevice({ token: b.device("01"), client: "lecteur", platform: "ios", environment: "sandbox" });
  b.store.putPushDevice({ token: b.device("02"), client: "operateur", platform: "ios", environment: "production" });
  b.store.putPushDevice({ token: b.device("03"), client: "ailleurs", platform: "ios", environment: "production" });

  b.store.updateRun("r1", { state: "awaiting_human", step: "specs" });
  const rev = b.store.getRun("r1")?.rev;
  b.store.appendEvent("specs_ready", "r1", { reason: "les specs touchent au schéma" });
  const wave = await b.take();
  assert.deepEqual([...wave.keys()].sort(), ["01", "02"], "le client d'un autre dépôt ne reçoit rien");
  const viewer = wave.get("01") as Sent;
  const operator = wave.get("02") as Sent;
  assert.equal(viewer.host, "api.sandbox.push.apple.com", "la passerelle de l'appareil, pas celle de la config");
  assert.equal(operator.host, "api.push.apple.com");
  assert.equal(operator.headers["apns-push-type"], "alert");
  assert.equal(operator.headers["apns-topic"], "com.omp.console.ios");
  assert.match(operator.headers.authorization ?? "", /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(operator.json.aps.category, "omp.validate", "un opérateur valide ou refuse depuis la notification");
  assert.equal(viewer.json.aps.category, "omp.open", "un lecteur ne peut qu'ouvrir");
  assert.equal(operator.json.aps["thread-id"], "r1");
  assert.deepEqual(operator.json.omp, { kind: "specs", runId: "r1", rev });

  // Un verdict, une escalade, un échec, une alerte de veille : chacun sa sorte, ouvrir sauf le verdict.
  const kinds: [string, Record<string, unknown>, string, string][] = [
    ["verdict", { verdict: null, reason: "risque élevé" }, "verdict", "omp.validate"],
    ["escalations", { step: "impl", items: [{ id: 4, question: "Supprimer la table ?" }] }, "escalation", "omp.open"],
    ["run_failed", { step: "impl", reason: "tests rouges" }, "run_failed", "omp.open"],
    ["stalled", { minutes: 20, step: "impl", tool: null }, "stalled", "omp.open"],
    ["budget_exceeded", { cost: 3, budget: 2, threshold: 2, paused: true }, "budget", "omp.open"],
  ];
  for (const [type, payload, kind, category] of kinds) {
    b.store.updateRun("r1", { state: "running" });
    b.store.appendEvent(type, "r1", payload);
    const sent = (await b.take()).get("02") as Sent;
    assert.equal(sent.json.omp.kind, kind, type);
    assert.equal(sent.json.aps.category, category, type);
  }

  // Le run d'un dépôt que seul « ailleurs » voit.
  b.store.appendEvent("run_failed", "r2", { reason: "x" });
  assert.deepEqual([...(await b.take()).keys()], ["03"]);
  // Les événements qui n'attendent personne ne réveillent pas l'iPhone.
  b.store.appendEvent("step_started", "r1", { step: "impl" });
  b.store.appendEvent("merged", "r1", { sha: "abc" });
  assert.equal((await b.take()).size, 0);
  b.store.close();
});

test("push-alertes/AC-3 : un envoi du poste ne part qu'aux appareils de l'approbateur (catégorie approuver, `updatedAt` de l'envoi) ; les alertes du serveur aux seuls clients qui voient tout", async () => {
  const b = bench();
  b.clients.add("app-approbateur", "admin", "*", true);
  b.clients.add("app-iphone", "admin", "*");
  b.clients.add("demo-seul", "operator", ["demo"]);
  b.store.putPushDevice({
    token: b.device("0a"),
    client: "app-approbateur",
    platform: "ios",
    environment: "production",
  });
  b.store.putPushDevice({ token: b.device("0b"), client: "app-iphone", platform: "ios", environment: "production" });
  b.store.putPushDevice({ token: b.device("0c"), client: "demo-seul", platform: "ios", environment: "production" });

  const action = b.store.createWorkstationAction({
    origin: "session",
    by: "omp",
    kind: "type",
    params: { tabId: 1, ref: "e1", text: "Bonjour Paul" },
    rationale: "Répondre à Paul",
    state: "awaiting_approval",
    approval: {
      summary: "Envoyer un message à Paul",
      recipients: ["paul@exemple.fr"],
      preview: "Bonjour Paul",
      fingerprint: "f".repeat(64),
      decidedBy: null,
      decidedAt: null,
      reason: null,
    },
  });
  b.store.appendEvent(
    "workstation_approval",
    null,
    { seq: action.seq, summary: "Envoyer un message à Paul", recipients: ["paul@exemple.fr"] },
    null,
  );
  const wave = await b.take();
  assert.deepEqual([...wave.keys()], ["0a"], "seul l'approbateur reçoit un envoi à approuver");
  const sent = wave.get("0a") as Sent;
  assert.equal(sent.json.aps.category, "omp.approve");
  assert.equal(sent.json.aps["thread-id"], "workstation");
  assert.deepEqual(sent.json.omp, { kind: "approval", rev: action.updatedAt, seq: action.seq });

  // Déjà tranché quand l'événement arrive : plus rien à approuver.
  const refused = b.store.updateWorkstationActionIf(action.seq, ["awaiting_approval"], { state: "refused" });
  assert.ok(refused);
  b.store.appendEvent("workstation_approval", null, { seq: action.seq }, null);
  assert.equal((await b.take()).size, 0);

  for (const [type, payload, kind] of [
    ["vigie_silent", { lastAt: 1, silentSec: 600, client: "vigie" }, "vigie_silent"],
    [
      "backup_failed",
      { base: "harness", where: "remote", file: "/srv/b.sqlite", detail: "rclone: 403" },
      "backup_failed",
    ],
    ["daily_budget_reached", { spent: 51, ceiling: 50, day: "2023-11-14" }, "daily_budget"],
  ] as const) {
    b.store.appendEvent(type, null, payload, null);
    const server = await b.take();
    assert.deepEqual([...server.keys()].sort(), ["0a", "0b"], `${type} : pas au client restreint à un dépôt`);
    assert.equal(server.get("0b")?.json.omp.kind, kind);
    assert.equal(server.get("0b")?.json.aps.category, "omp.open");
    assert.equal(server.get("0b")?.json.aps["thread-id"], "server");
  }
  b.store.close();
});

test("push-alertes/AC-4 : la charge ne porte que des identifiants — ni contenu du poste, ni question, ni raison d'échec, ni détail de sauvegarde", async () => {
  const b = bench();
  b.clients.add("app-approbateur", "admin", "*", true);
  b.store.putPushDevice({
    token: b.device("0a"),
    client: "app-approbateur",
    platform: "ios",
    environment: "production",
  });
  const secrets = [
    "Envoyer un message à Paul",
    "paul@exemple.fr",
    "Bonjour Paul, voici le devis",
    "Supprimer la table clients ?",
    "ECONNREFUSED 10.0.0.3:5432",
    "/srv/backups/h.sqlite",
    "rclone: 403",
  ];
  const action = b.store.createWorkstationAction({
    origin: "agent",
    by: null,
    kind: "type",
    params: { text: secrets[2] },
    rationale: secrets[0] as string,
    state: "awaiting_approval",
    approval: {
      summary: secrets[0] as string,
      recipients: [secrets[1] as string],
      preview: secrets[2] as string,
      fingerprint: null,
      decidedBy: null,
      decidedAt: null,
      reason: null,
    },
  });
  b.store.appendEvent(
    "workstation_approval",
    null,
    { seq: action.seq, summary: secrets[0], recipients: [secrets[1]] },
    null,
  );
  b.store.appendEvent("escalations", "r1", { step: "impl", items: [{ id: 1, question: secrets[3] }] });
  b.store.appendEvent("run_failed", "r1", { step: "impl", reason: secrets[4], cause: secrets[4] });
  b.store.appendEvent("backup_failed", null, { where: "local", file: secrets[5], detail: secrets[6] }, null);
  await b.pusher.idle();
  assert.equal(b.sent.length, 4);
  for (const request of b.sent) {
    for (const secret of secrets) assert.ok(!request.body.includes(secret), `${request.json.omp.kind} : « ${secret} »`);
    assert.deepEqual(
      Object.keys(request.json.omp).filter((key) => !["kind", "runId", "rev", "seq"].includes(key)),
      [],
      "omp : des identifiants seulement",
    );
  }
  b.store.close();
});

test("push-alertes/AC-5 : un jeton refusé par Apple (410, BadDeviceToken, Unregistered) est oublié, un refus passager non ; l'appareil d'un client révoqué aussi", async () => {
  const b = bench();
  b.clients.add("iphone", "operator", "*");
  b.clients.add("ancien", "operator", "*");
  for (const token of ["01", "02", "03", "04"])
    b.store.putPushDevice({ token: b.device(token), client: "iphone", platform: "ios", environment: "production" });
  b.store.putPushDevice({ token: b.device("05"), client: "ancien", platform: "ios", environment: "production" });
  b.replies.set(b.device("01"), { status: 410, reason: "Unregistered" });
  b.replies.set(b.device("02"), { status: 400, reason: "BadDeviceToken" });
  b.replies.set(b.device("03"), { status: 429, reason: "TooManyRequests" });
  b.clients.revoke("ancien");
  b.store.appendEvent("run_failed", "r1", { reason: "x" });
  assert.deepEqual([...(await b.take()).keys()].sort(), ["01", "02", "03", "04"], "rien ne part au client révoqué");
  assert.deepEqual(
    b.store.listPushDevices().map((device) => device.token.slice(0, 2)),
    ["03", "04"],
    "les jetons morts et l'appareil du client révoqué sont oubliés",
  );
  b.store.close();
});

test("push-alertes/AC-6 : une même alerte ne part qu'une fois (rejeu, répétition) et porte sa clé en collapse-id ; un nouvel état, un nouveau silence ou 12 h plus tard repartent", async () => {
  const b = bench();
  b.clients.add("iphone", "operator", "*");
  b.store.putPushDevice({ token: b.device("01"), client: "iphone", platform: "ios", environment: "production" });
  b.store.updateRun("r1", { state: "awaiting_human", step: "specs" });
  b.store.appendEvent("specs_ready", "r1", {});
  b.store.appendEvent("specs_ready", "r1", {});
  const first = await b.take();
  assert.equal(first.size, 1);
  const collapse = first.get("01")?.headers["apns-collapse-id"] ?? "";
  assert.ok(collapse.length > 0 && Buffer.byteLength(collapse) <= 64);
  // Les specs refaites : une nouvelle révision, une nouvelle alerte.
  b.store.updateRun("r1", { state: "running", step: "specs" });
  b.store.updateRun("r1", { state: "awaiting_human", step: "specs" });
  b.store.appendEvent("specs_ready", "r1", {});
  assert.equal((await b.take()).size, 1);

  // L'agent muet : une fois par silence ; reparler (`alert_cleared`) rouvre l'alerte.
  b.store.appendEvent("stalled", "r1", { minutes: 15, step: "impl" });
  b.store.appendEvent("stalled", "r1", { minutes: 16, step: "impl" });
  assert.equal((await b.take()).size, 1);
  b.store.appendEvent("stalled", "r1", { minutes: 17, step: "impl" });
  assert.equal((await b.take()).size, 0);
  b.store.appendEvent("alert_cleared", "r1", { kind: "stalled" });
  b.store.appendEvent("stalled", "r1", { minutes: 15, step: "impl" });
  assert.equal((await b.take()).size, 1);

  // La sauvegarde qui échoue chaque heure : une alerte par 12 h.
  b.store.appendEvent("backup_failed", null, { where: "local" }, null);
  b.advance(60 * 60 * 1000);
  b.store.appendEvent("backup_failed", null, { where: "local" }, null);
  assert.equal((await b.take()).size, 1);
  b.advance(ALERT_DEDUP_MS);
  b.store.appendEvent("backup_failed", null, { where: "local" }, null);
  assert.equal((await b.take()).size, 1);
  b.store.close();
});

test("push-alertes/AC-7 : sans clé APNs ou sans registre de clients, rien ne part (échec fermé)", async () => {
  const off = bench({ apns: null });
  off.clients.add("iphone", "operator", "*");
  off.store.putPushDevice({ token: off.device("01"), client: "iphone", platform: "ios", environment: "production" });
  off.store.appendEvent("run_failed", "r1", { reason: "x" });
  assert.equal((await off.take()).size, 0);
  off.store.close();

  const dir = tmpdir("push-alertes-sans-registre-");
  const store = new Store(path.join(dir, "h.sqlite"));
  const sent: string[] = [];
  const apns = new ApnsClient({
    config: () => APNS,
    transport: async (request) => {
      sent.push(request.path);
      return { status: 200, reason: null };
    },
    readKey: () => PEM,
  });
  const pusher = new AlertPusher({ store, apns, config: () => APNS });
  pusher.subscribe();
  store.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  store.putPushDevice({ token: "01".repeat(32), client: "admin", platform: "ios", environment: "production" });
  store.appendEvent("run_failed", "r1", { reason: "x" });
  await pusher.idle();
  assert.deepEqual(sent, []);
  store.close();
});

test("push-alertes/AC-8 : l'app lit les sortes et les catégories que le serveur pousse, sans en oublier ni en inventer", () => {
  const swift = fs.readFileSync(
    path.join(ROOT, "omp-console", "Sources", "ConsoleClient", "HarnessNotifications.swift"),
    "utf8",
  );
  /** Les valeurs brutes d'un `enum` Swift à `String` : `case a = "x"` ou `case a, b`. */
  const raws = (name: string): string[] => {
    const start = swift.indexOf(`public enum ${name}: String`);
    assert.ok(start >= 0, `enum ${name} introuvable`);
    const body = swift.slice(start, swift.indexOf("\n}\n", start));
    return [...body.matchAll(/^\s+case (.+)$/gm)].flatMap(([, cases]) =>
      (cases as string).split(",").map((entry) => {
        const [name, raw] = entry.split("=").map((part) => part.trim());
        return raw ? raw.replaceAll('"', "") : (name as string);
      }),
    );
  };
  assert.deepEqual(raws("HarnessPushKind").sort(), [...ALERT_KINDS].sort());
  assert.deepEqual(raws("HarnessNotificationCategory").sort(), Object.values(ALERT_CATEGORIES).sort());
});
