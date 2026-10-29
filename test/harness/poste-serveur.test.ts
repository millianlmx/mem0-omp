// Feature poste-serveur : le relais du poste de travail dans omp-harness — accès du seul
// propriétaire, observation validée et purgée, file d'actions de l'extension (long-poll,
// bail, résultats), garde d'envoi (approbation humaine, jamais à l'échéance), autonomie,
// statistiques du profil, meetings, l'image d'une capture jamais écrite en base, et le
// jeton approbateur : seul l'appareil approbateur (créé en ligne de commande) tranche.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { Store } from "../../omp-harness/db.ts";
import type { Meeting, Segment, StoredObservation, WorkstationAction } from "../../omp-harness/db.ts";
import { APPROVER_ONLY, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { clientCommand } from "../../omp-harness/main.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import { profileStats } from "../../omp-harness/workstation.ts";
import type { ProfileStats, WorkstationStatus } from "../../omp-harness/workstation.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);
const HOUR = 3_600_000;

type Reply<T> = { status: number; json: T };

/**
 * L'API du monde servie par node:http : un viewer de tous les dépôts, un opérateur limité à `demo`,
 * et l'approbateur du poste (le jeton par défaut des appels : il tranche et règle le poste).
 */
type Api = {
  clients: ClientRegistry;
  viewer: string;
  narrow: string;
  approver: string;
  call: <T = Record<string, unknown>>(
    method: string,
    route: string,
    body?: unknown,
    token?: string,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ) => Promise<Reply<T>>;
  close: () => Promise<void>;
};

async function serve(world: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("poste-serveur-"), "clients.json"), ADMIN);
  const viewer = clients.add("ipad", "viewer", "*").token;
  const narrow = clients.add("mac-demo", "operator", ["demo"]).token;
  const approver = clients.add("app-approbateur", "admin", "*", true).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    clients,
    viewer,
    narrow,
    approver,
    call: async <T>(
      method: string,
      route: string,
      body?: unknown,
      token = approver,
      signal?: AbortSignal,
      headers: Record<string, string> = {},
    ) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
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
}

/**
 * Une vraie attente : le long-poll se juge contre l'horloge du serveur (il doit se
 * garer avant le dépôt qui le réveille, et voir partir son client), ce qu'aucune
 * horloge simulée ne traverse — node:http et fetch tournent pour de vrai.
 */
async function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

async function setup(patch?: (config: FakeWorld["config"]) => void): Promise<{ world: FakeWorld; api: Api }> {
  const world = fakeWorld({}, patch ? { patch } : {});
  const api = await serve(world);
  return { world, api };
}

async function teardown(world: FakeWorld, api: Api): Promise<void> {
  await api.close();
  await world.orchestrator.stop();
}

async function online(api: Api): Promise<void> {
  assert.equal((await api.call("GET", "/v1/workstation/next?wait=0")).status, 204);
}

/** Dépose une action, la fait louer par l'extension et rend son numéro. */
async function leased(
  api: Api,
  kind = "click",
  params: Record<string, unknown> = { tabId: 1, ref: "e1" },
): Promise<number> {
  const created = await api.call<{ action: WorkstationAction }>("POST", "/v1/workstation/actions", {
    kind,
    params,
    rationale: "répondre au client",
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const next = await api.call<{ action: WorkstationAction }>("GET", "/v1/workstation/next?wait=1");
  assert.equal(next.status, 200);
  assert.equal(next.json.action.seq, created.json.action.seq);
  return created.json.action.seq;
}

const visit = (at: number, url: string, durationMs: number) => ({ kind: "visit", at, url, title: "Page", durationMs });

test("poste-serveur/AC-1 : seul un client qui voit tous les dépôts touche au poste ; un viewer lit sans écrire", async () => {
  const { world, api } = await setup();
  try {
    const routes = apiRoutes(world.orchestrator, api.clients).filter((route) =>
      route.path.startsWith("/v1/workstation"),
    );
    assert.ok(routes.length >= 17, "la table du contrat est servie");
    for (const route of routes) {
      const sample = route.path.replace("{n}", "1").replace("{id}", "m1");
      const body = route.method === "GET" ? undefined : { paused: false };
      const refused = await api.call<{ error: string }>(route.method, sample, body, api.narrow);
      assert.equal(refused.status, 403, `${route.method} ${sample}`);
      assert.equal(refused.json.error, "le poste est réservé au propriétaire", `${route.method} ${sample}`);
      const viewer = await api.call<{ error: string }>(route.method, sample, body, api.viewer);
      if (route.role === "viewer") assert.notEqual(viewer.status, 403, `${route.method} ${sample} se lit en viewer`);
      else assert.equal(viewer.status, 403, `${route.method} ${sample} exige operator`);
    }
    // Les événements du poste n'ont pas de dépôt : un client restreint ne les reçoit pas.
    await api.call("PUT", "/v1/workstation/settings", { paused: false });
    const [settings] = world.store.eventsOfType("workstation_settings");
    assert.equal(settings?.repo, null);
    assert.deepEqual(world.store.eventsOfType("workstation_settings", ["demo"]), []);
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-2 : un lot d'observations est validé, réduit (query, fragment, libellés), masqué, et refusé en pause", async () => {
  const { world, api } = await setup();
  try {
    const now = Date.now();
    const wrongKind = await api.call<{ error: string }>("POST", "/v1/workstation/observations", {
      tz: 0,
      events: [{ kind: "scroll", at: now, url: "https://a.fr/", title: "" }],
    });
    assert.equal(wrongKind.status, 400);
    assert.match(wrongKind.json.error, /events\[0\]\.kind/);
    const tooMany = await api.call("POST", "/v1/workstation/observations", {
      tz: 0,
      events: Array.from({ length: 501 }, (_, index) => visit(now + index, "https://a.fr/", 1000)),
    });
    assert.equal(tooMany.status, 400);
    const full = await api.call<{ stored: number }>("POST", "/v1/workstation/observations", {
      tz: 0,
      events: Array.from({ length: 500 }, (_, index) => visit(now - 600_000 + index, "https://a.fr/", 1)),
    });
    assert.deepEqual([full.status, full.json.stored], [200, 500]);
    const stored = await api.call<{ stored: number }>("POST", "/v1/workstation/observations", {
      tz: -60,
      events: [
        {
          kind: "visit",
          at: now,
          url: "https://mail.exemple.fr/boite/42?q=secret#message-7",
          title: "Boîte — token=abcdef1234567890",
          durationMs: 5000,
        },
        {
          kind: "interaction",
          at: now + 1,
          url: "https://crm.exemple.fr/clients?id=9",
          title: "CRM",
          action: "click",
          target: { role: "button", label: "x".repeat(300) },
        },
      ],
    });
    assert.deepEqual([stored.status, stored.json.stored], [200, 2]);
    const read = await api.call<{ observations: (StoredObservation & { id: number })[] }>(
      "GET",
      `/v1/workstation/observations?since=${now}&limit=10`,
      undefined,
      api.viewer,
    );
    const [first, second] = read.json.observations;
    assert.equal(first?.url, "https://mail.exemple.fr/boite/42", "ni query ni fragment");
    assert.ok(first && !first.title.includes("abcdef1234567890"), "le secret du titre est masqué");
    assert.equal(typeof first?.id, "number");
    assert.ok(second?.kind === "interaction");
    assert.equal(second.url, "https://crm.exemple.fr/clients");
    assert.ok(second.target.label.length <= 120, "libellé tronqué à 120 caractères");
    // En pause, l'observation est refusée.
    await api.call("PUT", "/v1/workstation/settings", { paused: true });
    const paused = await api.call<{ error: string }>("POST", "/v1/workstation/observations", {
      tz: 0,
      events: [visit(now, "https://a.fr/", 1000)],
    });
    assert.deepEqual([paused.status, paused.json.error], [409, "le poste est en pause"]);
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-3 : le long-poll rend 204 après l'attente, un dépôt le réveille aussitôt, un client parti ne loue rien", async () => {
  const { world, api } = await setup();
  try {
    const started = Date.now();
    const empty = await api.call("GET", "/v1/workstation/next?wait=1");
    assert.equal(empty.status, 204);
    assert.ok(Date.now() - started >= 900, "le serveur a attendu");
    // Un long-poll en cours ne bloque pas les autres requêtes, et un dépôt le réveille.
    const polling = api.call<{ action: WorkstationAction }>("GET", "/v1/workstation/next?wait=20");
    await pause(100);
    const status = await api.call<WorkstationStatus>("GET", "/v1/workstation");
    assert.equal(status.json.online, true, "un long-poll en cours vaut présence");
    const posted = Date.now();
    const created = await api.call<{ action: WorkstationAction }>("POST", "/v1/workstation/actions", {
      kind: "tabs",
      params: {},
      rationale: "voir les onglets",
    });
    const woken = await polling;
    assert.ok(Date.now() - posted < 2000, "réveillé sans attendre la fin du long-poll");
    assert.equal(woken.status, 200);
    assert.deepEqual([woken.json.action.seq, woken.json.action.state], [created.json.action.seq, "running"]);
    // Un client qui part avant la réponse ne loue rien.
    const controller = new AbortController();
    const gone = api.call("GET", "/v1/workstation/next?wait=20", undefined, ADMIN, controller.signal).catch(() => null);
    await pause(100);
    controller.abort();
    await gone;
    await pause(100);
    const later = await api.call<{ action: WorkstationAction }>("POST", "/v1/workstation/actions", {
      kind: "tabs",
      params: {},
      rationale: "encore",
    });
    await pause(100);
    assert.equal(world.store.getWorkstationAction(later.json.action.seq)?.state, "queued");
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-4 : un bail sans résultat passe failed à l'échéance, et un résultat tardif est refusé", async () => {
  const { world, api } = await setup();
  try {
    await online(api);
    const seq = await leased(api, "tabs", {});
    world.orchestrator.workstation.maintain(Date.now() + 30_000);
    assert.equal(world.store.getWorkstationAction(seq)?.state, "running", "le bail tient avant actionTimeoutSec");
    world.orchestrator.workstation.maintain(Date.now() + 61_000);
    const failed = world.store.getWorkstationAction(seq);
    assert.deepEqual([failed?.state, failed?.error], ["failed", "l'extension n'a pas rendu le résultat"]);
    const late = await api.call("POST", `/v1/workstation/actions/${seq}/result`, { outcome: "done" });
    assert.equal(late.status, 409);
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-5 : needs_approval — à soi seulement repart approuvé ; autrui, inconnu ou mêlé attend l'humain, qui approuve", async () => {
  const { world, api } = await setup();
  try {
    await api.call("PUT", "/v1/workstation/settings", { selfIdentities: ["moi@exemple.fr", "Jean Dupont"] });
    await online(api);
    const result = (seq: number, recipients: string[]) =>
      api.call<{ action: WorkstationAction }>("POST", `/v1/workstation/actions/${seq}/result`, {
        outcome: "needs_approval",
        approval: { summary: "Envoyer un message", recipients, preview: "Bonjour" },
      });
    // À soi (casse et espaces ignorés) : repart en file, approuvé par « soi ».
    const self = await leased(api);
    const selfAnswer = await result(self, ["  MOI@exemple.fr ", "jeandupont"]);
    assert.deepEqual(
      [selfAnswer.json.action.state, selfAnswer.json.action.approved, selfAnswer.json.action.approval?.decidedBy],
      ["queued", true, "soi"],
    );
    const again = await api.call<{ action: WorkstationAction }>("GET", "/v1/workstation/next?wait=1");
    assert.deepEqual([again.json.action.seq, again.json.action.approved], [self, true]);
    await api.call("POST", `/v1/workstation/actions/${self}/result`, { outcome: "done" });
    // Autrui, destinataires inconnus, ou un mélange : l'humain doit trancher.
    for (const recipients of [["paul@client.fr"], [], ["moi@exemple.fr", "paul@client.fr"]]) {
      const seq = await leased(api);
      const answer = await result(seq, recipients);
      assert.deepEqual(
        [answer.json.action.state, answer.json.action.approved],
        ["awaiting_approval", false],
        JSON.stringify(recipients),
      );
    }
    const approvals = world.store.eventsOfType("workstation_approval");
    assert.equal(approvals.length, 3, "un événement workstation_approval par attente");
    assert.deepEqual(approvals[0]?.payload.recipients, ["paul@client.fr"]);
    assert.equal((await api.call<WorkstationStatus>("GET", "/v1/workstation")).json.pending, 3);
    // L'humain approuve : l'action repart, et le prochain long-poll la livre approuvée.
    const [waiting] = world.store.listWorkstationActions({ states: ["awaiting_approval"], limit: 1 });
    assert.ok(waiting);
    const approved = await api.call<{ action: WorkstationAction }>(
      "POST",
      `/v1/workstation/actions/${waiting.seq}/approve`,
      undefined,
      api.approver,
      undefined,
      { "If-Match": `"${waiting.updatedAt}"` },
    );
    assert.deepEqual(
      [approved.json.action.state, approved.json.action.approved, approved.json.action.approval?.decidedBy],
      ["queued", true, "app-approbateur"],
    );
    const delivered = await api.call<{ action: WorkstationAction }>("GET", "/v1/workstation/next?wait=1");
    assert.deepEqual([delivered.json.action.seq, delivered.json.action.approved], [waiting.seq, true]);
    // Le brouillon approuvé revient tel quel : l'extension le compare à celui qu'elle recalcule.
    assert.deepEqual(
      [delivered.json.action.approval?.recipients, delivered.json.action.approval?.preview],
      [["moi@exemple.fr", "paul@client.fr"], "Bonjour"],
    );
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-6 : refus, échéance de l'approbation (expired, jamais done) et geste sur une action qui n'attend pas → 409", async () => {
  const { world, api } = await setup();
  try {
    await online(api);
    const needs = (seq: number) =>
      api.call("POST", `/v1/workstation/actions/${seq}/result`, {
        outcome: "needs_approval",
        approval: { summary: "Répondre à Paul", recipients: ["paul@client.fr"], preview: "Oui" },
      });
    const refusedSeq = await leased(api);
    await needs(refusedSeq);
    const refused = await api.call<{ action: WorkstationAction }>(
      "POST",
      `/v1/workstation/actions/${refusedSeq}/refuse`,
      { reason: "pas maintenant" },
    );
    assert.deepEqual(
      [refused.json.action.state, refused.json.action.approval?.reason, refused.json.action.approved],
      ["refused", "pas maintenant", false],
    );
    assert.equal((await api.call("POST", `/v1/workstation/actions/${refusedSeq}/approve`)).status, 409);
    const expiring = await leased(api);
    await needs(expiring);
    world.orchestrator.workstation.maintain(Date.now() + 23 * HOUR);
    assert.equal(world.store.getWorkstationAction(expiring)?.state, "awaiting_approval");
    world.orchestrator.workstation.maintain(Date.now() + 25 * HOUR);
    const expired = world.store.getWorkstationAction(expiring);
    assert.deepEqual([expired?.state, expired?.approved], ["expired", false]);
    assert.equal((await api.call("POST", `/v1/workstation/actions/${expiring}/approve`)).status, 409);
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0")).status, 204, "rien ne repart");
    // Une action en cours ou en file n'attend aucune approbation.
    const running = await leased(api, "tabs", {});
    assert.equal((await api.call("POST", `/v1/workstation/actions/${running}/approve`)).status, 409);
    assert.equal((await api.call("POST", `/v1/workstation/actions/${running}/refuse`, {})).status, 409);
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-7 : propose retient l'action de l'agent, l'extension hors ligne refuse le dépôt, une décision est done sans jamais partir", async () => {
  const { world, api } = await setup();
  try {
    const { workstation } = world.orchestrator;
    const offline = await api.call<{ error: string }>("POST", "/v1/workstation/actions", {
      kind: "tabs",
      params: {},
      rationale: "voir",
    });
    assert.deepEqual([offline.status, offline.json.error], [409, "l'extension du poste est hors ligne"]);
    const decision = await api.call<{ action: WorkstationAction }>("POST", "/v1/workstation/actions", {
      kind: "decision",
      params: { summary: "ne pas relancer Paul" },
      rationale: "il a répondu hier",
    });
    assert.equal(decision.status, 201);
    assert.deepEqual([decision.json.action.state, decision.json.action.origin], ["done", "session"]);
    await online(api);
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0")).status, 204, "une décision n'est jamais louée");
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "propose" });
    const proposed = workstation.createAction(
      { kind: "open", params: { url: "https://crm.exemple.fr/" }, rationale: "ouvrir le CRM pour la relance" },
      "agent",
      "agent",
    );
    assert.deepEqual(
      [proposed.state, proposed.origin, proposed.approval?.summary, proposed.rationale],
      ["awaiting_approval", "agent", "Ouvrir https://crm.exemple.fr/", "ouvrir le CRM pour la relance"],
    );
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0")).status, 204, "rien ne part sans l'humain");
    // La même action déposée par une session part tout de suite.
    const session = await api.call<{ action: WorkstationAction }>("POST", "/v1/workstation/actions", {
      kind: "open",
      params: { url: "https://crm.exemple.fr/" },
      rationale: "ouvrir le CRM",
    });
    assert.equal(session.json.action.state, "queued");
    // Validation : rationale vide, kind inconnu, paramètre invalide ou inconnu.
    for (const body of [
      { kind: "tabs", params: {}, rationale: "  " },
      { kind: "delete", params: {}, rationale: "x" },
      { kind: "wait", params: { ms: 20_000 }, rationale: "x" },
      { kind: "click", params: { tabId: 1, ref: "e1", force: true }, rationale: "x" },
    ])
      assert.equal((await api.call("POST", "/v1/workstation/actions", body)).status, 400, JSON.stringify(body));
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-8 : l'autonomie auto passe d'observe à act au seuil ; les réglages survivent à la réouverture de la base", async () => {
  const { world, api } = await setup();
  try {
    const set = await api.call<WorkstationStatus>("PUT", "/v1/workstation/settings", {
      thresholdHours: 0.001,
      selfIdentities: ["moi@exemple.fr"],
    });
    assert.deepEqual(set.json.autonomy, { setting: "auto", effective: "observe" });
    const now = Date.now();
    await api.call("POST", "/v1/workstation/observations", { tz: 0, events: [visit(now, "https://a.fr/", 3000)] });
    let status = await api.call<WorkstationStatus>("GET", "/v1/workstation");
    assert.deepEqual([status.json.observedSeconds, status.json.autonomy.effective], [3, "observe"]);
    await api.call("POST", "/v1/workstation/observations", {
      tz: 0,
      events: [visit(now + 4000, "https://a.fr/", 1000)],
    });
    status = await api.call<WorkstationStatus>("GET", "/v1/workstation");
    assert.deepEqual([status.json.observedSeconds, status.json.autonomy.effective], [4, "act"]);
    assert.equal(world.store.eventsOfType("workstation_settings").length, 1);
  } finally {
    await teardown(world, api);
  }
  // Un redémarrage : une nouvelle base sur le même fichier, un nouvel orchestrateur.
  world.store.close();
  const store = new Store(path.join(world.config.dataDir, "harness.sqlite"));
  const restarted = new Orchestrator({ ...world.deps, store });
  try {
    const status = restarted.workstation.status();
    assert.deepEqual(
      [status.thresholdHours, status.selfIdentities, status.observedSeconds, status.autonomy.effective],
      [0.001, ["moi@exemple.fr"], 4, "act"],
    );
  } finally {
    await restarted.stop();
    store.close();
  }
});

test("poste-serveur/AC-9 : ProfileStats — sites par temps, heures LOCALES selon tz, enchaînements dès 3 occurrences", () => {
  const at = Date.parse("2026-10-29T08:50:00Z");
  let id = 0;
  const observation = (url: string, start: number, durationMs: number, tz = 0): StoredObservation => ({
    id: ++id,
    tz,
    kind: "visit",
    at: start,
    url,
    title: "",
    durationMs,
  });
  // 20 min à cheval sur 10 h et 11 h, heure de Paris (UTC+2 : getTimezoneOffset = -120).
  const stats: ProfileStats = profileStats(
    [
      observation("https://mail.fr/a", at, 20 * 60_000, -120),
      observation("https://doc.fr/b", at + HOUR, 5 * 60_000, -120),
    ],
    { ms: 25 * 60_000, since: at },
  );
  assert.deepEqual(
    stats.topSites.map((site) => [site.host, site.seconds, site.share]),
    [
      ["mail.fr", 1200, 0.8],
      ["doc.fr", 300, 0.2],
    ],
  );
  assert.equal(stats.activeHours.length, 24);
  assert.deepEqual([stats.activeHours[10], stats.activeHours[11], stats.activeHours[8]], [600, 600 + 300, 0]);
  assert.deepEqual([stats.observedSeconds, stats.since], [1500, at]);
  // Un enchaînement vu deux fois n'est pas récurrent ; trois fois, il l'est (ids → :id).
  const round = (start: number, issue: number) => [
    observation(`https://github.com/org/app/issues/${issue}`, start, 60_000),
    observation("https://github.com/org/app/pulls", start + 120_000, 60_000),
  ];
  const twice = profileStats([...round(at, 1), ...round(at + 2 * HOUR, 2)], { ms: 0, since: null });
  assert.deepEqual(twice.sequences, []);
  const thrice = profileStats([...round(at, 1), ...round(at + 2 * HOUR, 22), ...round(at + 4 * HOUR, 333)], {
    ms: 0,
    since: null,
  });
  assert.deepEqual(thrice.sequences, [
    { steps: ["github.com/org/app/issues/:id", "github.com/org/app/pulls"], count: 3 },
  ]);
});

test("poste-serveur/AC-10 : la capture d'écran rejoint l'appelant qui attend, jamais la base", async () => {
  const { world, api } = await setup();
  try {
    await online(api);
    const image = "/9j/4AAQSkZJRgABAQAAAQABAAD".repeat(20);
    const created = await api.call<{ action: WorkstationAction }>("POST", "/v1/workstation/actions", {
      kind: "screenshot",
      params: { tabId: 3 },
      rationale: "voir la page",
    });
    const seq = created.json.action.seq;
    const waiting = api.call<{ action: WorkstationAction; image?: string }>(
      "GET",
      `/v1/workstation/actions/${seq}?wait=20`,
      undefined,
      api.viewer,
    );
    await api.call("GET", "/v1/workstation/next?wait=1");
    await api.call("POST", `/v1/workstation/actions/${seq}/result`, {
      outcome: "done",
      result: { text: "capture" },
      image: `data:image/jpeg;base64,${image}`,
    });
    const view = await waiting;
    assert.deepEqual([view.json.action.state, view.json.image], ["done", image]);
    const rows = world.store.db.prepare("SELECT * FROM workstation_actions").all();
    assert.ok(!JSON.stringify(rows).includes(image.slice(0, 40)), "l'image n'est pas écrite en base");
    const listed = await api.call("GET", "/v1/workstation/actions?state=done");
    assert.ok(!JSON.stringify(listed.json).includes(image.slice(0, 40)));
    assert.equal(world.store.getWorkstationAction(seq)?.result?.text, "capture");
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-11 : un meeting reçoit ses segments masqués tant qu'il vit, plus après sa fin ni en pause", async () => {
  const { world, api } = await setup();
  try {
    const now = Date.now();
    const created = await api.call<{ meeting: Meeting }>("POST", "/v1/workstation/meetings", {
      title: "Point client",
      url: "https://meet.exemple.fr/abc-defg?authuser=0",
      startedAt: now,
    });
    assert.equal(created.status, 201);
    const id = created.json.meeting.id;
    assert.deepEqual(
      [created.json.meeting.state, created.json.meeting.url],
      ["live", "https://meet.exemple.fr/abc-defg"],
    );
    const stored = await api.call<{ stored: number }>("POST", `/v1/workstation/meetings/${id}/segments`, {
      segments: [
        { at: now + 1000, speaker: "autres", text: "Il nous faut l'export CSV, password=hunter2hunter2" },
        { at: now + 2000, speaker: "moi", text: "   " },
      ],
    });
    assert.deepEqual([stored.status, stored.json.stored], [200, 1]);
    const tooMany = await api.call("POST", `/v1/workstation/meetings/${id}/segments`, {
      segments: Array.from({ length: 201 }, () => ({ at: now, speaker: "moi", text: "x" })),
    });
    assert.equal(tooMany.status, 400);
    const view = await api.call<{ meeting: Meeting; transcript: Segment[] }>("GET", `/v1/workstation/meetings/${id}`);
    assert.equal(view.json.meeting.segments, 1);
    assert.ok(!view.json.transcript[0]?.text.includes("hunter2hunter2"), "le secret du transcript est masqué");
    await api.call("PUT", "/v1/workstation/settings", { paused: true });
    const paused = await api.call("POST", `/v1/workstation/meetings/${id}/segments`, {
      segments: [{ at: now + 3000, speaker: "moi", text: "suite" }],
    });
    assert.equal(paused.status, 409);
    await api.call("PUT", "/v1/workstation/settings", { paused: false });
    const ended = await api.call<{ meeting: Meeting }>("POST", `/v1/workstation/meetings/${id}/end`);
    assert.deepEqual([ended.status, ended.json.meeting.state], [200, "ended"]);
    const late = await api.call("POST", `/v1/workstation/meetings/${id}/segments`, {
      segments: [{ at: now + 4000, speaker: "moi", text: "trop tard" }],
    });
    assert.equal(late.status, 409);
    assert.equal((await api.call("POST", `/v1/workstation/meetings/${id}/end`)).status, 409);
    assert.equal((await api.call("GET", "/v1/workstation/meetings/inconnu")).status, 404);
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-12 : la rétention purge observations et segments anciens sans retirer le temps observé cumulé", async () => {
  const { world, api } = await setup((config) => {
    config.workstation.retentionDays = 30;
  });
  try {
    const now = Date.now();
    const old = now - 31 * 24 * HOUR;
    await api.call("POST", "/v1/workstation/observations", {
      tz: 0,
      events: [visit(old, "https://ancien.fr/", 60_000), visit(now, "https://recent.fr/", 60_000)],
    });
    const meeting = await api.call<{ meeting: Meeting }>("POST", "/v1/workstation/meetings", {
      title: "Ancien",
      url: "https://meet.exemple.fr/x",
      startedAt: old,
    });
    await api.call("POST", `/v1/workstation/meetings/${meeting.json.meeting.id}/segments`, {
      segments: [{ at: old, speaker: "autres", text: "vieux" }],
    });
    world.orchestrator.workstation.maintain(now);
    const left = await api.call<{ observations: StoredObservation[] }>("GET", "/v1/workstation/observations");
    assert.deepEqual(
      left.json.observations.map((entry) => entry.url),
      ["https://recent.fr/"],
    );
    assert.deepEqual(world.store.listWorkstationSegments(meeting.json.meeting.id), []);
    assert.equal(world.orchestrator.workstation.status().observedSeconds, 120, "le cumul survit à la purge");
  } finally {
    await teardown(world, api);
  }
});

const FINGERPRINT = "0123abcd".repeat(8);

/** Le geste humain sur une action, avec ou sans If-Match (par l'approbateur, sauf `token`). */
function gesture(api: Api, seq: number, verb: "approve" | "refuse", ifMatch?: string, token = api.approver) {
  return api.call<{ action: WorkstationAction; error: string }>(
    "POST",
    `/v1/workstation/actions/${seq}/${verb}`,
    verb === "refuse" ? {} : undefined,
    token,
    undefined,
    ifMatch === undefined ? {} : { "If-Match": ifMatch },
  );
}

/** Une action louée qui revient `needs_approval` avec cette empreinte, vers ces destinataires. */
async function needsApproval(api: Api, recipients: string[], fingerprint?: string): Promise<WorkstationAction> {
  const seq = await leased(api);
  const answer = await api.call<{ action: WorkstationAction }>("POST", `/v1/workstation/actions/${seq}/result`, {
    outcome: "needs_approval",
    approval: { summary: "Répondre à Paul", recipients, preview: "Oui", ...(fingerprint ? { fingerprint } : {}) },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return answer.json.action;
}

test("poste-serveur/AC-13 : l'empreinte d'envoi est gardée telle quelle et revient dans GET /next après approbation ; invalide → 400", async () => {
  const { world, api } = await setup();
  try {
    await online(api);
    const waiting = await needsApproval(api, ["paul@client.fr"], FINGERPRINT);
    assert.equal(waiting.approval?.fingerprint, FINGERPRINT);
    const listed = await api.call<{ actions: WorkstationAction[] }>("GET", "/v1/workstation/actions");
    assert.equal(listed.json.actions.find((entry) => entry.seq === waiting.seq)?.approval?.fingerprint, FINGERPRINT);
    assert.equal((await gesture(api, waiting.seq, "approve", `"${waiting.updatedAt}"`)).status, 200);
    const delivered = await api.call<{ action: WorkstationAction }>("GET", "/v1/workstation/next?wait=1");
    assert.deepEqual(
      [delivered.json.action.seq, delivered.json.action.approved, delivered.json.action.approval?.fingerprint],
      [waiting.seq, true, FINGERPRINT],
    );
    // Sans empreinte fournie : la clé est là, nulle — rien ne pourra partir.
    await api.call("POST", `/v1/workstation/actions/${waiting.seq}/result`, { outcome: "done" });
    const bare = await needsApproval(api, ["paul@client.fr"]);
    assert.ok(bare.approval && "fingerprint" in bare.approval);
    assert.equal(bare.approval?.fingerprint, null);
    for (const fingerprint of ["abc", "z".repeat(64), 42]) {
      const seq = await leased(api, "tabs", {});
      const bad = await api.call("POST", `/v1/workstation/actions/${seq}/result`, {
        outcome: "needs_approval",
        approval: { summary: "Envoyer", recipients: [], preview: "", fingerprint },
      });
      assert.equal(bad.status, 400, String(fingerprint));
      await api.call("POST", `/v1/workstation/actions/${seq}/result`, { outcome: "done" });
    }
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-14 : un envoi à soi seulement repart approuvé par « soi » avec son empreinte", async () => {
  const { world, api } = await setup();
  try {
    await api.call("PUT", "/v1/workstation/settings", { selfIdentities: ["moi@exemple.fr"] });
    await online(api);
    const self = await needsApproval(api, ["moi@exemple.fr"], FINGERPRINT);
    assert.deepEqual([self.state, self.approved, self.approval?.decidedBy], ["queued", true, "soi"]);
    const delivered = await api.call<{ action: WorkstationAction }>("GET", "/v1/workstation/next?wait=1");
    assert.deepEqual([delivered.json.action.seq, delivered.json.action.approval?.fingerprint], [self.seq, FINGERPRINT]);
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-15 : en mode proposer, l'approbation décrit le geste, sans empreinte ni destinataires", async () => {
  const { world, api } = await setup();
  try {
    await online(api);
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "propose" });
    const { workstation } = world.orchestrator;
    const typed = workstation.createAction(
      { kind: "type", params: { tabId: 7, ref: "e3", text: "Bonjour Paul", submit: true }, rationale: "relancer Paul" },
      "agent",
      "agent",
    );
    assert.deepEqual(typed.approval && { ...typed.approval }, {
      summary: "Saisir « Bonjour Paul » dans e3 (l'onglet 7) puis valider",
      recipients: [],
      preview: "Bonjour Paul",
      fingerprint: null,
      decidedBy: null,
      decidedAt: null,
      reason: null,
    });
    assert.equal(typed.rationale, "relancer Paul");
    const click = workstation.createAction(
      { kind: "click", params: { tabId: 123, ref: "e2" }, rationale: "ouvrir le fil" },
      "agent",
      "agent",
    );
    assert.deepEqual(
      [click.approval?.summary, click.approval?.preview, click.approval?.fingerprint],
      ["Cliquer sur e2 dans l'onglet 123", "", null],
    );
    // Approuvée, elle part sans empreinte : l'extension ne laissera passer aucun envoi sur cette foi.
    assert.equal((await gesture(api, click.seq, "approve", `"${click.updatedAt}"`)).status, 200);
    const delivered = await api.call<{ action: WorkstationAction }>("GET", "/v1/workstation/next?wait=1");
    assert.deepEqual([delivered.json.action.seq, delivered.json.action.approval?.fingerprint], [click.seq, null]);
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-16 : approve exige If-Match — absent 428, périmé 412, à jour 200 ; refuse : If-Match facultatif, 412 s'il est périmé", async () => {
  const { world, api } = await setup();
  try {
    await online(api);
    const waiting = await needsApproval(api, ["paul@client.fr"], FINGERPRINT);
    const missing = await gesture(api, waiting.seq, "approve");
    assert.deepEqual([missing.status, missing.json.error], [428, "If-Match requis : l'updatedAt de l'envoi affiché"]);
    const stale = await gesture(api, waiting.seq, "approve", `"${waiting.updatedAt - 1}"`);
    assert.deepEqual([stale.status, stale.json.error], [412, "l'envoi a changé depuis son affichage : relisez-le"]);
    assert.equal(world.store.getWorkstationAction(waiting.seq)?.state, "awaiting_approval", "rien n'est approuvé");
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0")).status, 204);
    const fresh = await gesture(api, waiting.seq, "approve", `"${waiting.updatedAt}"`);
    assert.deepEqual([fresh.status, fresh.json.action.state, fresh.json.action.approved], [200, "queued", true]);
    assert.ok(fresh.json.action.updatedAt > waiting.updatedAt, "la révision avance");
    // Refus : sans If-Match accepté, périmé refusé.
    await api.call("GET", "/v1/workstation/next?wait=1");
    await api.call("POST", `/v1/workstation/actions/${waiting.seq}/result`, { outcome: "done" });
    const other = await needsApproval(api, ["paul@client.fr"], FINGERPRINT);
    assert.equal((await gesture(api, other.seq, "refuse", `"${other.updatedAt + 5}"`)).status, 412);
    assert.equal(world.store.getWorkstationAction(other.seq)?.state, "awaiting_approval");
    const refused = await gesture(api, other.seq, "refuse");
    assert.deepEqual([refused.status, refused.json.action.state], [200, "refused"]);
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-17 : deux approbations simultanées de la même révision — une seule gagne, l'action part une fois", async () => {
  const { world, api } = await setup();
  try {
    await online(api);
    const waiting = await needsApproval(api, ["paul@client.fr"], FINGERPRINT);
    const both = await Promise.all([
      gesture(api, waiting.seq, "approve", `"${waiting.updatedAt}"`),
      gesture(api, waiting.seq, "approve", `"${waiting.updatedAt}"`),
    ]);
    assert.deepEqual(both.map((reply) => reply.status).sort(), [200, 409]);
    const delivered = await api.call<{ action: WorkstationAction }>("GET", "/v1/workstation/next?wait=0");
    assert.equal(delivered.json.action.seq, waiting.seq);
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0")).status, 204, "livrée une seule fois");
    // Le CAS du store : deux écritures sur la même révision, même si l'état attendu tient encore — une seule gagne.
    await api.call("POST", `/v1/workstation/actions/${waiting.seq}/result`, { outcome: "done" });
    const other = await needsApproval(api, ["paul@client.fr"], FINGERPRINT);
    const patch = { approved: true } as const;
    const first = world.store.updateWorkstationActionIf(other.seq, ["awaiting_approval"], patch, other.updatedAt);
    const second = world.store.updateWorkstationActionIf(other.seq, ["awaiting_approval"], patch, other.updatedAt);
    assert.ok(first);
    assert.equal(second, null);
    assert.ok(first.updatedAt > other.updatedAt, "chaque écriture avance la révision, même dans la même milliseconde");
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-18 : la rétention vide les résultats des actions anciennes et garde la ligne du journal", async () => {
  const { world, api } = await setup((config) => {
    config.workstation.retentionDays = 30;
  });
  try {
    await online(api);
    const seq = await leased(api, "tabs", {});
    await api.call("POST", `/v1/workstation/actions/${seq}/result`, {
      outcome: "done",
      result: { text: "1 · Boîte · https://mail/" },
    });
    const { workstation } = world.orchestrator;
    workstation.maintain(Date.now() + 29 * 24 * HOUR);
    assert.deepEqual(world.store.getWorkstationAction(seq)?.result, { text: "1 · Boîte · https://mail/" });
    workstation.maintain(Date.now() + 31 * 24 * HOUR);
    const kept = world.store.getWorkstationAction(seq);
    assert.deepEqual([kept?.state, kept?.rationale, kept?.result], ["done", "répondre au client", null]);
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-19 : un meeting live sans segment ni mise à jour depuis 30 min passe ended, son digest à suivre", async () => {
  const { world, api } = await setup();
  try {
    const open = (title: string) =>
      api.call<{ meeting: Meeting }>("POST", "/v1/workstation/meetings", {
        title,
        url: "https://meet.exemple.fr/x",
        startedAt: Date.now(),
      });
    const orphan = (await open("Perdu")).json.meeting.id;
    const { workstation } = world.orchestrator;
    workstation.maintain(Date.now() + 29 * 60_000);
    assert.equal(world.store.getWorkstationMeeting(orphan)?.state, "live");
    const later = Date.now() + 31 * 60_000;
    workstation.maintain(later);
    const ended = world.store.getWorkstationMeeting(orphan);
    assert.deepEqual([ended?.state, ended?.endedAt], ["ended", later]);
    assert.ok(
      world.store
        .eventsOfType("workstation_meeting")
        .some((event) => event.payload.id === orphan && event.payload.state === "ended"),
    );
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-20 : clients.json garde le drapeau approver ; le jeton historique et un ancien fichier n'en ont pas ; --add-client --approver crée un admin approbateur", () => {
  const file = path.join(tmpdir("poste-approbateur-"), "clients.json");
  const registry = new ClientRegistry(file, ADMIN);
  const added = clientCommand(["--add-client", "console", "--approver"], registry);
  assert.equal(added.status, 0, added.stderr);
  const token = added.stdout.trim();
  assert.match(token, /^[0-9a-f]{64}$/, "le jeton seul sur stdout");
  assert.match(added.stderr, /client console \(admin, dépôts : tous, approbateur du poste\)/);
  // Un autre process (le service) relit le fichier : le drapeau y est.
  const service = new ClientRegistry(file, ADMIN);
  const found = service.authenticate(token);
  assert.deepEqual([found?.name, found?.role, found?.repos, found?.approver], ["console", "admin", "*", true]);
  assert.equal(service.authenticate(ADMIN)?.approver, false, "le jeton historique n'approuve jamais");
  const plain = service.add("mac", "admin", "*");
  assert.equal(new ClientRegistry(file).authenticate(plain.token)?.approver, false);
  const listed = clientCommand(["--list-clients"], service).stdout;
  assert.match(listed, /^console\tadmin\t\*\tapprobateur$/m);
  assert.match(listed, /^mac\tadmin\t\*$/m);
  // Un approbateur est admin sur tous les dépôts, rien d'autre.
  for (const extra of [
    ["--role", "operator"],
    ["--repos", "demo"],
  ]) {
    const refused = clientCommand(["--add-client", "borne", "--approver", ...extra], service);
    assert.deepEqual([refused.status, refused.stdout], [1, ""], extra.join(" "));
    assert.match(refused.stderr, /un approbateur est admin sur tous les dépôts/);
  }
  assert.throws(() => service.add("borne", "operator", "*", true), /admin sur tous les dépôts/);
  // Un fichier d'avant les approbateurs (ou au drapeau illisible) : personne n'approuve.
  const legacy = path.join(tmpdir("poste-approbateur-ancien-"), "clients.json");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  fs.writeFileSync(
    legacy,
    JSON.stringify({
      clients: [
        { name: "vieux", role: "admin", repos: "*", createdAt: 1, tokenSha256: sha("vieux") },
        { name: "louche", role: "admin", repos: "*", createdAt: 1, tokenSha256: sha("louche"), approver: "oui" },
      ],
    }),
  );
  const old = new ClientRegistry(legacy);
  assert.deepEqual(
    ["vieux", "louche"].map((name) => old.authenticate(name)?.approver),
    [false, false],
  );
});

test("poste-serveur/AC-21 : POST /v1/clients refuse tout champ approver ; GET /v1/clients montre le drapeau", async () => {
  const { world, api } = await setup();
  try {
    for (const approver of [true, false]) {
      const refused = await api.call<{ error: string }>(
        "POST",
        "/v1/clients",
        { name: "intrus", role: "admin", approver },
        ADMIN,
      );
      assert.equal(refused.status, 400, JSON.stringify(refused.json));
      assert.match(refused.json.error, /^approver : .*ligne de commande.*harness\.sh approver/);
    }
    const listed = await api.call<{ clients: { name: string; approver: boolean }[] }>(
      "GET",
      "/v1/clients",
      undefined,
      ADMIN,
    );
    assert.deepEqual(
      listed.json.clients.map((client) => [client.name, client.approver]),
      [
        ["admin", false],
        ["ipad", false],
        ["mac-demo", false],
        ["app-approbateur", true],
      ],
      "rien n'a été créé, et le drapeau se lit",
    );
  } finally {
    await teardown(world, api);
  }
});

test("poste-serveur/AC-22 : approuver, refuser ou régler le poste exige l'approbateur — un admin ordinaire reçoit 403, l'approbateur suit les règles If-Match", async () => {
  const { world, api } = await setup();
  try {
    const plainAdmin = api.clients.add("mac", "admin", "*").token;
    await online(api);
    const first = await needsApproval(api, ["paul@client.fr"], FINGERPRINT);
    const second = await needsApproval(api, ["paul@client.fr"], FINGERPRINT);
    for (const token of [ADMIN, plainAdmin]) {
      const replies = [
        await gesture(api, first.seq, "approve", `"${first.updatedAt}"`, token),
        await gesture(api, first.seq, "refuse", undefined, token),
        await api.call<{ error: string }>("PUT", "/v1/workstation/settings", { paused: true }, token),
      ];
      for (const reply of replies) assert.deepEqual([reply.status, reply.json.error], [403, APPROVER_ONLY]);
    }
    assert.deepEqual(
      [first.seq, second.seq].map((seq) => world.store.getWorkstationAction(seq)?.state),
      ["awaiting_approval", "awaiting_approval"],
      "rien n'a été tranché",
    );
    assert.equal((await api.call<WorkstationStatus>("GET", "/v1/workstation")).json.paused, false);
    // L'approbateur : les règles de la Révision 2 tiennent toujours.
    assert.equal((await gesture(api, first.seq, "approve")).status, 428);
    assert.equal((await gesture(api, first.seq, "approve", `"${first.updatedAt - 1}"`)).status, 412);
    const refused = await gesture(api, second.seq, "refuse");
    assert.deepEqual([refused.status, refused.json.action.state], [200, "refused"]);
    const approved = await gesture(api, first.seq, "approve", `"${first.updatedAt}"`);
    assert.deepEqual(
      [approved.status, approved.json.action.state, approved.json.action.approval?.decidedBy],
      [200, "queued", "app-approbateur"],
    );
    const settings = await api.call<WorkstationStatus>("PUT", "/v1/workstation/settings", { paused: true });
    assert.deepEqual([settings.status, settings.json.paused], [200, true]);
  } finally {
    await teardown(world, api);
  }
});
