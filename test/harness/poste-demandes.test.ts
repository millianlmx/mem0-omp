// Feature poste-demandes : l'humain demande au poste de faire quelque chose dans son
// navigateur (une consigne, ou une automatisation tirée de son profil) sans passer par une
// pipeline. La demande attend en file, part dans un job `poste-demande` quand l'extension
// est en ligne, quelle que soit l'autonomie, sous les gardes du poste (fenêtre de l'agent,
// garde d'envoi, gestes réversibles), et finit par un compte rendu. Les numéros des
// critères sont ceux des specs du run « Ask harness to do things » (AC-23 à AC-47) ; les
// critères des apps (AC-26, AC-31 partie app, AC-35, AC-36, AC-48 à AC-50) n'y sont pas.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { WorkstationAction, WorkstationAutomation, WorkstationRequest } from "../../omp-harness/db.ts";
import { APPROVER_ONLY, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { WORKSTATION_REVERSIBLE_ONLY } from "../../omp-harness/prompts.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);
/** L'extension rapporte ces onglets comme ceux de la fenêtre de l'agent : les clics y partent. */
const TABS = { "X-OMP-Agent-Tabs": "1,2,3" };
const CLICK = { kind: "click", params: { tabId: 1, ref: "e1" }, rationale: "ouvrir la facture du mois" };
const LIST_TABS = { kind: "tabs", params: {}, rationale: "voir ce qui est ouvert" };
const REPORT = (report: string) => ({ tool: "workstation_request_report", args: { report } });
const ACT = (args: Record<string, unknown>) => ({ tool: "workstation_act", args });
const TASKS = [
  {
    title: "Relance des devis",
    frequency: "chaque lundi",
    steps: ["ouvrir le CRM", "lister les devis"],
    automatable: true,
  },
  { title: "Paiement des fournisseurs", frequency: "le 5", steps: ["payer"], automatable: false },
];
const PROFILE = {
  summary: "Consultant",
  habits: [],
  tools: [],
  schedule: "9 h – 18 h",
  repetitiveTasks: TASKS,
  clientNeeds: [],
  preferences: [],
};

type Reply<T> = { status: number; json: T };
type Api = {
  approver: string;
  admin: string;
  viewer: string;
  narrow: string;
  call: <T = Record<string, unknown>>(
    method: string,
    route: string,
    body?: unknown,
    token?: string,
    headers?: Record<string, string>,
  ) => Promise<Reply<T>>;
  close: () => Promise<void>;
};

/** L'API du monde : l'approbateur (jeton par défaut), un admin ordinaire, un viewer, un opérateur restreint à `demo`. */
async function serve(world: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("poste-demandes-"), "clients.json"), ADMIN);
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
}

async function setup(
  scenario: Record<string, unknown> = {},
  patch?: (config: FakeWorld["config"]) => void,
): Promise<{ world: FakeWorld; api: Api }> {
  const world = fakeWorld(scenario, patch ? { patch } : {});
  return { world, api: await serve(world) };
}

async function teardown(world: FakeWorld, api: Api): Promise<void> {
  await api.close();
  await world.orchestrator.stop();
}

/** L'extension se présente (en ligne) et rapporte les onglets de la fenêtre de l'agent. */
async function online(api: Api): Promise<void> {
  assert.equal((await api.call("GET", "/v1/workstation/next?wait=0", undefined, undefined, TABS)).status, 204);
}

/** L'extension loue la prochaine action (long-poll). */
async function lease(api: Api, wait = 25): Promise<WorkstationAction> {
  const next = await api.call<{ action: WorkstationAction }>(
    "GET",
    `/v1/workstation/next?wait=${wait}`,
    undefined,
    undefined,
    TABS,
  );
  assert.equal(next.status, 200, "une action est louée");
  return next.json.action;
}

async function done(api: Api, seq: number): Promise<void> {
  const reply = await api.call("POST", `/v1/workstation/actions/${seq}/result`, {
    outcome: "done",
    result: { text: "fait" },
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
}

async function pose(api: Api, instruction = "Ouvre la page des factures"): Promise<WorkstationRequest> {
  const reply = await api.call<{ request: WorkstationRequest }>("POST", "/v1/workstation/requests", { instruction });
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  return reply.json.request;
}

const requestOf = (world: FakeWorld, id: string) => world.store.getWorkstationRequest(id) as WorkstationRequest;

async function until(world: FakeWorld, id: string, state: WorkstationRequest["state"]): Promise<WorkstationRequest> {
  await waitFor(
    () => world.store.getWorkstationRequest(id)?.state === state,
    () => `${JSON.stringify(world.store.getWorkstationRequest(id))} ${JSON.stringify(world.log().slice(-3))}`,
  );
  return requestOf(world, id);
}

const runsCount = async (api: Api) => (await api.call<{ runs: unknown[] }>("GET", "/v1/runs")).json.runs.length;

// -- routes et contrat ------------------------------------------------------------------------

test("poste-demandes/AC-23 : une demande posée par l'approbateur est rendue « en file » avec sa consigne, sans aucun run", async () => {
  const { world, api } = await setup();
  try {
    await online(api);
    const before = await runsCount(api);
    const request = await pose(api, "Ouvre la page des factures");
    assert.equal(request.state, "queued");
    assert.equal(request.instruction, "Ouvre la page des factures");
    assert.deepEqual(Object.keys(request).sort(), [
      "automationId",
      "browserId",
      "by",
      "createdAt",
      "endedAt",
      "id",
      "instruction",
      "reason",
      "report",
      "startedAt",
      "state",
      "updatedAt",
    ]);
    assert.equal(await runsCount(api), before, "aucun run créé");
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-25 : une consigne vide, d'espaces, trop longue ou qui n'est pas une chaîne → 400 en français, rien n'est créé", async () => {
  const { world, api } = await setup();
  try {
    const cases: [unknown, string][] = [
      ["", "instruction : consigne non vide attendue"],
      ["   ", "instruction : consigne non vide attendue"],
      ["x".repeat(4001), "instruction : 4000 caractères au plus"],
      [42, "instruction : chaîne attendue"],
    ];
    for (const [instruction, error] of cases) {
      const reply = await api.call("POST", "/v1/workstation/requests", { instruction });
      assert.deepEqual([reply.status, reply.json], [400, { error }]);
    }
    assert.deepEqual((await api.call("GET", "/v1/workstation/requests")).json, { requests: [] });
    assert.equal((await api.call("POST", "/v1/workstation/requests", { instruction: "x".repeat(4000) })).status, 201);
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-34 : annuler une demande terminée, échouée ou déjà annulée → 409, son état ne change pas", async () => {
  const { world, api } = await setup();
  const ws = world.orchestrator.workstation;
  try {
    const cancelled = await pose(api, "a");
    assert.equal((await api.call("POST", `/v1/workstation/requests/${cancelled.id}/cancel`)).status, 200);
    const done = ws.createRequest({ instruction: "b" }, { by: "test" });
    ws.startRequest(done.id);
    ws.finishRequest(done.id, { report: "fait" });
    const failed = ws.createRequest({ instruction: "c" }, { by: "test" });
    ws.startRequest(failed.id);
    ws.finishRequest(failed.id, { reason: "échec du runner : x" });
    for (const [id, state] of [
      [cancelled.id, "cancelled"],
      [done.id, "done"],
      [failed.id, "failed"],
    ] as const) {
      const reply = await api.call("POST", `/v1/workstation/requests/${id}/cancel`);
      assert.deepEqual([reply.status, reply.json], [409, { error: `la demande est déjà ${state}` }]);
      assert.equal(requestOf(world, id).state, state);
    }
    assert.equal((await api.call("POST", "/v1/workstation/requests/q-inconnue/cancel")).status, 404);
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-38 : une automatisation se crée depuis une tâche automatisable (idempotente), se lance en demande « en file » qui reprend titre et étapes, sans run", async () => {
  const { world, api } = await setup();
  try {
    const { version } = world.store.addWorkstationProfile(PROFILE);
    const created = await api.call<{ automation: WorkstationAutomation }>("POST", "/v1/workstation/automations", {
      version,
      task: 0,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const automation = created.json.automation;
    assert.deepEqual(
      [automation.title, automation.frequency, automation.steps, automation.profileVersion, automation.schedule],
      [TASKS[0]?.title, TASKS[0]?.frequency, TASKS[0]?.steps, version, null],
    );
    const again = await api.call<{ automation: WorkstationAutomation }>("POST", "/v1/workstation/automations", {
      version,
      task: 0,
    });
    assert.deepEqual([again.status, again.json.automation.id], [200, automation.id], "le même geste rend l'existante");
    const refused = await api.call("POST", "/v1/workstation/automations", { version, task: 1 });
    assert.deepEqual([refused.status, refused.json], [409, { error: "cette tâche n'est pas automatisable" }]);
    assert.equal((await api.call("POST", "/v1/workstation/automations", { version: 99, task: 0 })).status, 404);
    assert.equal((await api.call("POST", "/v1/workstation/automations", { version, task: 7 })).status, 404);
    assert.deepEqual(
      [(await api.call("POST", "/v1/workstation/automations", { version: "1", task: 0 })).json],
      [{ error: "version : entier attendu" }],
    );
    const list = await api.call<{ automations: WorkstationAutomation[] }>("GET", "/v1/workstation/automations");
    assert.deepEqual(
      list.json.automations.map((entry) => entry.id),
      [automation.id],
    );
    assert.deepEqual(
      world.store.eventsOfType("workstation_automation").map((event) => [event.payload, event.repo]),
      [[{ id: automation.id }, null]],
    );

    const before = await runsCount(api);
    const launched = await api.call<{ request: WorkstationRequest }>(
      "POST",
      `/v1/workstation/automations/${automation.id}/launch`,
    );
    assert.equal(launched.status, 201, JSON.stringify(launched.json));
    const request = launched.json.request;
    assert.deepEqual([request.state, request.automationId], ["queued", automation.id]);
    for (const part of [TASKS[0]?.title, ...(TASKS[0]?.steps ?? [])])
      assert.ok(request.instruction.includes(String(part)));
    assert.match(
      request.instruction,
      /^Automatisation « Relance des devis » : suis ces étapes dans l'ordre\.\n1\. ouvrir le CRM\n2\. lister les devis$/,
    );
    assert.equal(await runsCount(api), before, "aucun run créé");
    assert.equal((await api.call("POST", "/v1/workstation/automations/au-inconnue/launch")).status, 404);
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-39 : une automatisation supprimée quitte la liste ; la demande qu'elle a lancée reste lisible avec sa consigne", async () => {
  const { world, api } = await setup();
  try {
    const { version } = world.store.addWorkstationProfile(PROFILE);
    const { automation } = (
      await api.call<{ automation: WorkstationAutomation }>("POST", "/v1/workstation/automations", { version, task: 0 })
    ).json;
    const { request } = (
      await api.call<{ request: WorkstationRequest }>("POST", `/v1/workstation/automations/${automation.id}/launch`)
    ).json;
    const removed = await api.call("DELETE", `/v1/workstation/automations/${automation.id}`);
    assert.deepEqual([removed.status, removed.json], [200, { removed: automation.id }]);
    assert.deepEqual((await api.call("GET", "/v1/workstation/automations")).json, { automations: [] });
    assert.equal((await api.call("DELETE", `/v1/workstation/automations/${automation.id}`)).status, 404);
    const view = await api.call<{ request: WorkstationRequest; actions: WorkstationAction[] }>(
      "GET",
      `/v1/workstation/requests/${request.id}`,
    );
    assert.deepEqual([view.status, view.json.request.instruction], [200, request.instruction]);
    assert.equal(view.json.request.automationId, automation.id, "le lien reste, orphelin");
    assert.deepEqual(
      world.store.eventsOfType("workstation_automation").map((event) => event.payload),
      [{ id: automation.id }, { id: automation.id, removed: true }],
    );
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-42 : poser, annuler, lancer, créer ou supprimer exige l'approbateur ; un client restreint n'y touche pas ; les événements ne vont qu'aux clients de tous les dépôts", async () => {
  const { world, api } = await setup();
  try {
    const { version } = world.store.addWorkstationProfile(PROFILE);
    const request = await pose(api, "Ouvre la page des factures");
    const { automation } = (
      await api.call<{ automation: WorkstationAutomation }>("POST", "/v1/workstation/automations", { version, task: 0 })
    ).json;
    const writes: [string, string, unknown][] = [
      ["POST", "/v1/workstation/requests", { instruction: "autre" }],
      ["POST", `/v1/workstation/requests/${request.id}/cancel`, undefined],
      ["POST", `/v1/workstation/automations/${automation.id}/launch`, undefined],
      ["POST", "/v1/workstation/automations", { version, task: 0 }],
      ["DELETE", `/v1/workstation/automations/${automation.id}`, undefined],
    ];
    for (const token of [ADMIN, api.admin])
      for (const [method, route, body] of writes) {
        const reply = await api.call(method, route, body, token);
        assert.deepEqual([reply.status, reply.json], [403, { error: APPROVER_ONLY }], `${method} ${route}`);
      }
    const reads = ["/v1/workstation/requests", `/v1/workstation/requests/${request.id}`, "/v1/workstation/automations"];
    for (const [method, route, body] of [...writes, ...reads.map((route) => ["GET", route, undefined] as const)]) {
      const reply = await api.call(method, route, body, api.narrow);
      assert.deepEqual([reply.status, reply.json], [403, { error: "le poste est réservé au propriétaire" }]);
    }
    assert.equal(world.store.listWorkstationRequests().length, 1, "rien n'a changé");
    assert.equal(requestOf(world, request.id).state, "queued");
    assert.equal(world.store.listWorkstationAutomations().length, 1);
    for (const route of reads) assert.equal((await api.call("GET", route, undefined, api.viewer)).status, 200);

    assert.equal((await api.call("POST", `/v1/workstation/requests/${request.id}/cancel`)).status, 200);
    const events = world.store.eventsOfType("workstation_request").filter((event) => event.payload.id === request.id);
    assert.equal(events[0]?.payload.state, "queued");
    assert.equal(events.at(-1)?.payload.state, "cancelled");
    assert.ok(events.every((event) => event.repo === null));
    assert.deepEqual(world.store.eventsOfType("workstation_request", ["demo"]), []);
    assert.deepEqual(world.store.eventsOfType("workstation_automation", ["demo"]), []);
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-43 : poste désactivé → 404 sur chacune des routes des demandes et des automatisations", async () => {
  const { world, api } = await setup({}, (config) => {
    config.workstation.enabled = false;
  });
  try {
    const routes = apiRoutes(
      world.orchestrator,
      new ClientRegistry(path.join(tmpdir("poste-demandes-"), "clients.json")),
    ).filter((route) => route.path.includes("/requests") || route.path.includes("/automations"));
    assert.equal(routes.length, 8);
    for (const route of routes) {
      const sample = route.path.replace("{id}", "x1");
      const reply = await api.call(route.method, sample, route.method === "GET" ? undefined : { instruction: "a" });
      assert.equal(reply.status, 404, `${route.method} ${sample}`);
    }
  } finally {
    await teardown(world, api);
  }
});

// -- le job poste-demande ---------------------------------------------------------------------

test("poste-demandes/AC-24 : l'extension en ligne, la demande part ; l'action de son job lui est rattachée et part par /next ; le prompt porte la consigne et la règle des gestes réversibles", async () => {
  const { world, api } = await setup({ "poste-demande": [[ACT(LIST_TABS), REPORT("Page des factures ouverte.")]] });
  try {
    await online(api);
    const request = await pose(api, "Ouvre la page des factures");
    await world.orchestrator.start();
    const action = await lease(api);
    assert.deepEqual([action.kind, action.origin, action.requestId], ["tabs", "agent", request.id]);
    assert.equal(requestOf(world, request.id).state, "running");
    await done(api, action.seq);
    const finished = await until(world, request.id, "done");
    assert.equal(finished.report, "Page des factures ouverte.");
    const view = await api.call<{ actions: WorkstationAction[] }>("GET", `/v1/workstation/requests/${request.id}`);
    assert.deepEqual(
      view.json.actions.map((entry) => [entry.seq, entry.state]),
      [[action.seq, "done"]],
    );
    const prompt = world.log().find((entry) => entry.kind === "prompt" && entry.step === "poste-demande");
    assert.match(String(prompt?.message), /^# \/poste-demande — /);
    assert.ok(String(prompt?.message).includes("Ouvre la page des factures"));
    assert.ok(String(prompt?.message).includes(WORKSTATION_REVERSIBLE_ONLY));
    const states = world.store
      .eventsOfType("workstation_request")
      .filter((event) => event.payload.id === request.id)
      .map((event) => event.payload.state);
    assert.deepEqual([states[0], states.at(-2), states.at(-1)], ["queued", "running", "done"]);
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-27 : extension hors ligne, la demande attend en file avec sa raison et aucun runner ; elle part au retour de l'extension", async () => {
  const { world, api } = await setup({ "poste-demande": [[REPORT("rien à faire")]] });
  try {
    const request = await pose(api);
    await world.orchestrator.start();
    await waitFor(
      () => requestOf(world, request.id).reason === "l'extension du poste est hors ligne",
      () => JSON.stringify(requestOf(world, request.id)),
    );
    for (let index = 0; index < 3; index++) await world.orchestrator.tick();
    assert.equal(requestOf(world, request.id).state, "queued");
    assert.equal(world.spawned.length, 0, "aucun runner hors ligne");
    await online(api);
    await until(world, request.id, "done");
    assert.equal(requestOf(world, request.id).reason, null, "la raison d'attente est levée au départ");
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-28 : en observation, l'action d'une demande part (queued) ; un dépôt de l'agent hors demande reste refusé et le service 24/24 ne tourne pas", async () => {
  const { world, api } = await setup({ "poste-demande": [[ACT(CLICK), REPORT("fait")]] });
  const ws = world.orchestrator.workstation;
  try {
    assert.equal(ws.effective(), "observe");
    await online(api);
    const request = await pose(api);
    await world.orchestrator.start();
    await waitFor(
      () => world.store.listWorkstationActions({ requestId: request.id }).length === 1,
      () => JSON.stringify(world.log().slice(-3)),
    );
    assert.equal(world.store.listWorkstationActions({ requestId: request.id })[0]?.state, "queued");
    assert.throws(
      () => ws.createAction({ kind: "click", params: { tabId: 1, ref: "e1" }, rationale: "x" }, "agent", "agent"),
      { message: "l'autonomie du poste est en observation : l'agent n'agit pas" },
    );
    const action = await lease(api);
    assert.deepEqual([action.kind, action.requestId], ["click", request.id]);
    await done(api, action.seq);
    await until(world, request.id, "done");
    assert.equal(world.orchestrator.workstationAgent.isLive("poste-service"), false);
    assert.equal(world.log().filter((entry) => entry.kind === "prompt" && entry.step === "poste-service").length, 0);
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-29 : la lecture d'une demande terminée rend sa consigne, son compte rendu et ses deux actions dans l'ordre ; ni run, ni worktree, ni étape de pipeline", async () => {
  const { world, api } = await setup({
    "poste-demande": [
      [
        ACT(LIST_TABS),
        ACT({ ...CLICK, rationale: "ouvrir la dernière facture" }),
        REPORT("Deux gestes faits : la facture est ouverte."),
      ],
    ],
  });
  const tree = () => {
    const root = world.config.worktreesDir;
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry !== "workstation" && entry !== path.join("workstation", "_poste"))
      .filter((entry) => !entry.startsWith(path.join("workstation", "_poste") + path.sep))
      .sort();
  };
  try {
    await online(api);
    const runs = await runsCount(api);
    const before = tree();
    const request = await pose(api, "Ouvre la dernière facture");
    await world.orchestrator.start();
    for (let index = 0; index < 2; index++) await done(api, (await lease(api)).seq);
    await until(world, request.id, "done");
    const view = await api.call<{ request: WorkstationRequest; actions: WorkstationAction[] }>(
      "GET",
      `/v1/workstation/requests/${request.id}`,
    );
    assert.deepEqual(
      [view.json.request.state, view.json.request.instruction, view.json.request.report],
      ["done", "Ouvre la dernière facture", "Deux gestes faits : la facture est ouverte."],
    );
    assert.deepEqual(
      view.json.actions.map((action) => [action.kind, action.state, action.rationale]),
      [
        ["tabs", "done", "voir ce qui est ouvert"],
        ["click", "done", "ouvrir la dernière facture"],
      ],
    );
    assert.ok((view.json.actions[0]?.seq ?? 0) < (view.json.actions[1]?.seq ?? 0), "seq croissant");
    assert.equal(await runsCount(api), runs, "aucun run");
    assert.deepEqual(tree(), before, "aucun worktree hors du dossier de travail du poste");
    assert.equal(world.spawned.length, 1, "un seul runner : celui de la demande");
    const steps = world.log().flatMap((entry) => (entry.kind === "prompt" ? [entry.step] : []));
    assert.ok(steps.length > 0 && steps.every((step) => step === "poste-demande"), JSON.stringify(steps));
    const list = await api.call<{ requests: WorkstationRequest[] }>("GET", "/v1/workstation/requests?state=done");
    assert.deepEqual(
      list.json.requests.map((entry) => entry.id),
      [request.id],
    );
    assert.equal((await api.call("GET", "/v1/workstation/requests?state=bientot")).status, 400);
    assert.equal((await api.call("GET", "/v1/workstation/requests/q-inconnue")).status, 404);
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-30 : un job en échec (délai dépassé, erreur du runner) rend la demande échouée avec une raison lisible, et ses actions non parties passent failed", async () => {
  const { world, api } = await setup(
    {
      "poste-demande": [[ACT(CLICK)], [{ error: { message: "requête refusée par le fournisseur", httpStatus: 400 } }]],
    },
    (config) => {
      config.runner.stepTimeoutSec = 1;
    },
  );
  try {
    await online(api);
    const first = await pose(api, "a");
    await world.orchestrator.start();
    const failed = await until(world, first.id, "failed");
    assert.match(String(failed.reason), /^échec du runner : délai d'étape dépassé/);
    const [action] = world.store.listWorkstationActions({ requestId: first.id });
    assert.deepEqual([action?.state, action?.error], ["failed", failed.reason], "l'action en file est close");
    await online(api);
    const second = await pose(api, "b");
    const broken = await until(world, second.id, "failed");
    assert.equal(broken.reason, "échec du runner : requête refusée par le fournisseur");
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0", undefined, undefined, TABS)).status, 204);
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-32 : une demande en file annulée par l'approbateur est « annulée » et aucun runner ne part pour elle", async () => {
  const { world, api } = await setup({ "poste-demande": [[REPORT("x")]] });
  try {
    const request = await pose(api);
    const cancelled = await api.call<{ request: WorkstationRequest }>(
      "POST",
      `/v1/workstation/requests/${request.id}/cancel`,
    );
    assert.deepEqual([cancelled.status, cancelled.json.request.state], [200, "cancelled"]);
    assert.equal(cancelled.json.request.reason, "annulée par l'humain");
    await online(api);
    await world.orchestrator.start();
    for (let index = 0; index < 5; index++) await world.orchestrator.tick();
    assert.equal(world.spawned.length, 0);
    assert.equal(requestOf(world, request.id).state, "cancelled");
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-33 : annuler une demande en cours arrête son job, ferme ses actions non parties, refuse tout dépôt ; la louée rendue à approuver est close sans attente ni notification", async () => {
  const parallel = ["e1", "e2", "e3"].map((ref) => ACT({ ...CLICK, params: { tabId: 1, ref } }));
  const { world, api } = await setup({ "poste-demande": [[{ parallel }]] });
  const ws = world.orchestrator.workstation;
  try {
    await online(api);
    const request = await pose(api);
    await world.orchestrator.start();
    await waitFor(
      () => world.store.listWorkstationActions({ requestId: request.id }).length === 3,
      () => JSON.stringify(world.log().slice(-3)),
    );
    const [first, second, third] = world.store.listWorkstationActions({ requestId: request.id, order: "asc" });
    assert.equal((await lease(api)).seq, first?.seq);
    const parked = await api.call<{ action: WorkstationAction }>(
      "POST",
      `/v1/workstation/actions/${first?.seq}/result`,
      {
        outcome: "needs_approval",
        approval: { summary: "Envoyer à un tiers", recipients: ["tiers@example.com"], preview: "Bonjour" },
      },
    );
    assert.equal(parked.json.action.state, "awaiting_approval");
    assert.equal((await lease(api)).seq, second?.seq);

    const cancelled = await api.call<{ request: WorkstationRequest }>(
      "POST",
      `/v1/workstation/requests/${request.id}/cancel`,
    );
    assert.equal(cancelled.json.request.state, "cancelled");
    const after = (seq: number | undefined) => world.store.getWorkstationAction(seq ?? 0);
    assert.deepEqual([after(first?.seq)?.state, after(first?.seq)?.error], ["failed", "demande annulée"]);
    assert.deepEqual([after(third?.seq)?.state, after(third?.seq)?.error], ["failed", "demande annulée"]);
    assert.equal(after(second?.seq)?.state, "running", "la louée n'est pas touchée");
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0", undefined, undefined, TABS)).status, 204);
    await waitFor(
      () => !world.orchestrator.workstationAgent.isLive("poste-demande"),
      () => "le job de la demande annulée tourne encore",
    );
    assert.throws(
      () =>
        ws.createAction(
          { kind: "click", params: { tabId: 1, ref: "e9" }, rationale: "x" },
          "agent",
          "agent",
          request.id,
        ),
      {
        message: "la demande n'est plus en cours",
      },
    );

    const approvalsBefore = world.store.eventsOfType("workstation_approval").length;
    const late = await api.call<{ action: WorkstationAction }>(
      "POST",
      `/v1/workstation/actions/${second?.seq}/result`,
      {
        outcome: "needs_approval",
        approval: { summary: "Envoyer à un tiers", recipients: ["tiers@example.com"], preview: "Bonjour" },
      },
    );
    assert.equal(late.status, 200);
    assert.deepEqual(
      [late.json.action.state, late.json.action.error, late.json.action.approved],
      ["failed", "demande annulée", false],
    );
    const approvals = world.store.eventsOfType("workstation_approval");
    assert.equal(approvals.length, approvalsBefore);
    assert.ok(!approvals.some((event) => event.payload.seq === second?.seq));
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0", undefined, undefined, TABS)).status, 204);
    assert.equal(requestOf(world, request.id).state, "cancelled");
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-37 : une automatisation créée ne pose aucune demande d'elle-même : aucun runner tant que l'humain ne la lance pas", async () => {
  const { world, api } = await setup({ "poste-demande": [[REPORT("x")]] });
  try {
    const { version } = world.store.addWorkstationProfile(PROFILE);
    await api.call("POST", "/v1/workstation/automations", { version, task: 0, schedule: "0 9 * * 1" });
    await online(api);
    await world.orchestrator.start();
    for (let index = 0; index < 5; index++) await world.orchestrator.tick();
    assert.deepEqual(world.store.listWorkstationRequests(), []);
    assert.equal(world.spawned.length, 0);
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-40 poste-demandes/AC-44 : en propose, le clic d'une demande part en file ; un envoi à un tiers attend l'approbation et ne part pas sans elle", async () => {
  const { world, api } = await setup({ "poste-demande": [[ACT(CLICK), REPORT("envoi en attente d'approbation")]] });
  try {
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "propose" });
    await online(api);
    const request = await pose(api);
    await world.orchestrator.start();
    await waitFor(
      () => world.store.listWorkstationActions({ requestId: request.id }).length === 1,
      () => JSON.stringify(world.log().slice(-3)),
    );
    assert.equal(world.store.listWorkstationActions({ requestId: request.id })[0]?.state, "queued");
    const action = await lease(api);
    const held = await api.call<{ action: WorkstationAction }>("POST", `/v1/workstation/actions/${action.seq}/result`, {
      outcome: "needs_approval",
      approval: { summary: "Envoyer la facture à Paul", recipients: ["paul@exemple.fr"], preview: "Bonjour" },
    });
    assert.equal(held.json.action.state, "awaiting_approval");
    assert.ok(world.store.eventsOfType("workstation_approval").some((event) => event.payload.seq === action.seq));
    await until(world, request.id, "done");
    assert.equal((await api.call("GET", "/v1/workstation/next?wait=0", undefined, undefined, TABS)).status, 204);
    assert.equal(
      world.store.getWorkstationAction(action.seq)?.state,
      "awaiting_approval",
      "elle attend toujours l'humain",
    );
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-41 : en pause, rien ne se pose ni ne se lance ; la pause arrête la demande en cours (échouée) et retient celle en file jusqu'à la reprise", async () => {
  const { world, api } = await setup({ "poste-demande": [[ACT(CLICK)]] });
  try {
    const { version } = world.store.addWorkstationProfile(PROFILE);
    const { automation } = (
      await api.call<{ automation: WorkstationAutomation }>("POST", "/v1/workstation/automations", { version, task: 0 })
    ).json;
    await api.call("PUT", "/v1/workstation/settings", { paused: true });
    assert.deepEqual((await api.call("POST", "/v1/workstation/requests", { instruction: "a" })).json, {
      error: "le poste est en pause",
    });
    assert.equal((await api.call("POST", `/v1/workstation/automations/${automation.id}/launch`)).status, 409);
    assert.deepEqual(world.store.listWorkstationRequests(), [], "rien n'est créé");
    await api.call("PUT", "/v1/workstation/settings", { paused: false });

    await online(api);
    const first = await pose(api, "première");
    await world.orchestrator.start();
    await waitFor(
      () => world.store.listWorkstationActions({ requestId: first.id }).length === 1,
      () => JSON.stringify(world.log().slice(-3)),
    );
    const second = await pose(api, "seconde");
    await waitFor(
      () => requestOf(world, second.id).reason === "une demande plus ancienne est en cours",
      () => JSON.stringify(requestOf(world, second.id)),
    );
    await api.call("PUT", "/v1/workstation/settings", { paused: true });
    const failed = await until(world, first.id, "failed");
    assert.equal(failed.reason, "le poste a été mis en pause");
    const [action] = world.store.listWorkstationActions({ requestId: first.id });
    assert.deepEqual([action?.state, action?.error], ["failed", "le poste a été mis en pause"]);
    await waitFor(
      () => requestOf(world, second.id).reason === "le poste est en pause",
      () => JSON.stringify(requestOf(world, second.id)),
    );
    for (let index = 0; index < 3; index++) await world.orchestrator.tick();
    assert.equal(requestOf(world, second.id).state, "queued");
    await api.call("PUT", "/v1/workstation/settings", { paused: false });
    await online(api);
    await until(world, second.id, "running");
    assert.equal(requestOf(world, first.id).state, "failed", "jamais relancée");
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-45 : plafond journalier atteint ou aucun slot libre, la demande attend avec sa raison (écrite une fois) ; elle part au tour qui suit le relèvement", async () => {
  const { world, api } = await setup({ "poste-demande": [[REPORT("fait")]] }, (config) => {
    config.monitoring.dailyBudgetUsd = 1;
  });
  const spend = (cost: number) =>
    world.store.addUsage({
      runId: null,
      auditId: null,
      repo: null,
      step: "impl",
      provider: "anthropic",
      model: "m",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost,
    });
  try {
    spend(2);
    await online(api);
    const request = await pose(api);
    await world.orchestrator.start();
    await waitFor(
      () => String(requestOf(world, request.id).reason).startsWith("plafond journalier atteint"),
      () => JSON.stringify(requestOf(world, request.id)),
    );
    const reason = requestOf(world, request.id).reason;
    spend(3);
    for (let index = 0; index < 5; index++) await world.orchestrator.tick();
    const capped = world.store
      .eventsOfType("workstation_request")
      .filter(
        (event) => event.payload.id === request.id && String(event.payload.reason).startsWith("plafond journalier"),
      );
    assert.equal(capped.length, 1, "un seul signalement de la même sorte d'attente");
    assert.equal(requestOf(world, request.id).reason, reason, "la raison n'est pas réécrite");
    assert.equal(world.spawned.length, 0);
    world.orchestrator.config.monitoring.dailyBudgetUsd = 100;
    await until(world, request.id, "done");

    const slots = [];
    for (let index = 0; ; index++) {
      const slot = world.scheduler.tryAcquire("runner", `x${index}`);
      if ("refused" in slot) break;
      slots.push(slot);
    }
    await online(api);
    const waiting = await pose(api);
    await waitFor(
      () => String(requestOf(world, waiting.id).reason).startsWith("aucun runner libre : "),
      () => JSON.stringify(requestOf(world, waiting.id)),
    );
    for (const slot of slots) slot.release();
    await until(world, waiting.id, "done");
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-46 : au-delà de shiftMaxActions, le dépôt est refusé à l'agent sans action créée, et la demande finit terminée avec la mention du plafond", async () => {
  const { world, api } = await setup({ "poste-demande": [[ACT(LIST_TABS), ACT(LIST_TABS)]] }, (config) => {
    config.workstation.shiftMaxActions = 1;
  });
  try {
    await online(api);
    const request = await pose(api);
    await world.orchestrator.start();
    await done(api, (await lease(api)).seq);
    const finished = await until(world, request.id, "done");
    assert.equal(world.store.listWorkstationActions({ requestId: request.id }).length, 1);
    assert.match(String(finished.report), /Plafond d'actions atteint \(1\)/);
    const refused = world.log().filter((entry) => entry.kind === "tool" && entry.tool === "workstation_act")[1];
    assert.match(String(refused?.result), /plafond d'actions de cette demande atteint/);
  } finally {
    await teardown(world, api);
  }
});

test("poste-demandes/AC-47 : une action du service 24/24 déposée pendant une demande n'apparaît pas dans la lecture de la demande", async () => {
  const { world, api } = await setup({
    "poste-service": [[ACT({ ...CLICK, rationale: "geste du service" })]],
    "poste-demande": [[ACT(CLICK), REPORT("fait")]],
  });
  try {
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "observe" });
    await online(api);
    const request = await pose(api);
    await world.orchestrator.start();
    await waitFor(
      () => world.store.listWorkstationActions({ requestId: request.id, states: ["queued"] }).length === 1,
      () => JSON.stringify(world.log().slice(-3)),
    );
    assert.equal(requestOf(world, request.id).state, "running");
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "act" });
    await world.orchestrator.tick();
    await waitFor(
      () => world.store.listWorkstationActions({ limit: 10 }).some((action) => action.rationale === "geste du service"),
      () => JSON.stringify(world.log().slice(-3)),
    );
    const service = world.store
      .listWorkstationActions({ limit: 10 })
      .find((action) => action.rationale === "geste du service");
    assert.equal(service?.requestId, null);
    const read = async () =>
      (await api.call<{ actions: WorkstationAction[] }>("GET", `/v1/workstation/requests/${request.id}`)).json.actions;
    assert.deepEqual(
      (await read()).map((action) => action.rationale),
      [CLICK.rationale],
    );
    for (let index = 0; index < 2; index++) await done(api, (await lease(api)).seq);
    await until(world, request.id, "done");
    assert.equal((await read()).length, 1);
  } finally {
    await teardown(world, api);
  }
});
