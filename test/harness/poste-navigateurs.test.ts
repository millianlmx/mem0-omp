// Feature poste-navigateurs : plusieurs profils Chrome appairés au même poste (« Perso »,
// « ADEO »…). Chaque extension se présente par un `browserId` stable et un libellé ; le
// serveur garde la liste des navigateurs, cible une action ou une demande sur l'un d'eux
// (défaut : le navigateur par défaut) et ne la livre qu'à lui ; une extension ancienne,
// sans identifiant, est le navigateur par défaut. Et `Workstation.runAutomation`, le point
// d'entrée du planificateur des automatisations.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { Meeting, WorkstationAction, WorkstationRequest } from "../../omp-harness/db.ts";
import { createHandler } from "../../omp-harness/http.ts";
import type { BrowserView, WorkstationStatus } from "../../omp-harness/workstation.ts";
import { harnessCall } from "../../omp-chrome/src/lib/harness.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const PERSO = { "X-OMP-Browser": "b-perso", "X-OMP-Browser-Label": "Perso", "X-OMP-Agent-Tabs": "1" };
const ADEO = { "X-OMP-Browser": "b-adeo", "X-OMP-Browser-Label": "ADEO", "X-OMP-Agent-Tabs": "1" };
const TABS = { kind: "tabs", params: {}, rationale: "voir les onglets" };

type Reply<T> = { status: number; json: T };
type Api = {
  call: <T = Record<string, unknown>>(
    method: string,
    route: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Reply<T>>;
  close: () => Promise<void>;
};

/** L'API du monde, appelée par l'approbateur (les extensions s'y présentent par leurs en-têtes). */
async function serve(world: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("poste-navigateurs-"), "clients.json"));
  const token = clients.add("app-approbateur", "admin", "*", true).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    call: async <T>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => {
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

async function setup(scenario: Record<string, unknown> = {}): Promise<{ world: FakeWorld; api: Api }> {
  const world = fakeWorld(scenario);
  return { world, api: await serve(world) };
}

async function teardown(world: FakeWorld, api: Api): Promise<void> {
  await api.close();
  await world.orchestrator.stop();
}

/** Le long-poll d'une extension : l'action louée, ou `null` (204). */
async function poll(api: Api, headers: Record<string, string>, wait = 0): Promise<WorkstationAction | null> {
  const reply = await api.call<{ action: WorkstationAction }>(
    "GET",
    `/v1/workstation/next?wait=${wait}`,
    undefined,
    headers,
  );
  assert.ok(reply.status === 200 || reply.status === 204, JSON.stringify(reply.json));
  return reply.status === 200 ? reply.json.action : null;
}

async function deposit(api: Api, body: Record<string, unknown>): Promise<WorkstationAction> {
  const reply = await api.call<{ action: WorkstationAction }>("POST", "/v1/workstation/actions", body);
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  return reply.json.action;
}

test("poste-navigateurs/AC-1 : deux extensions en ligne ne reçoivent chacune que les actions qui les ciblent ; sans cible, le navigateur par défaut", async () => {
  const { world, api } = await setup();
  try {
    assert.equal(await poll(api, PERSO), null);
    assert.equal(await poll(api, ADEO), null);
    const forAdeo = await deposit(api, { ...TABS, browserId: "b-adeo" });
    assert.equal(forAdeo.browserId, "b-adeo");
    assert.equal(await poll(api, PERSO), null, "Perso ne prend pas l'action d'ADEO");
    assert.equal((await poll(api, ADEO))?.seq, forAdeo.seq);
    const untargeted = await deposit(api, TABS);
    assert.equal(untargeted.browserId, "b-perso", "le premier vu est le navigateur par défaut");
    assert.equal(await poll(api, ADEO), null);
    assert.equal((await poll(api, PERSO))?.seq, untargeted.seq);

    // Deux long-polls garés en même temps : le dépôt pour Perso ne réveille qu'elle avec une action.
    const parkedAdeo = poll(api, ADEO, 2);
    const parkedPerso = poll(api, PERSO, 2);
    const forPerso = await deposit(api, { ...TABS, browserId: "b-perso" });
    assert.equal((await parkedPerso)?.seq, forPerso.seq);
    assert.equal(await parkedAdeo, null, "ADEO rend 204 sans avoir pris l'action");

    // Le navigateur par défaut se règle ; un navigateur inconnu est refusé.
    assert.equal((await api.call("PUT", "/v1/workstation/settings", { defaultBrowser: "b-adeo" })).status, 200);
    assert.equal((await deposit(api, TABS)).browserId, "b-adeo");
    assert.equal((await api.call("PUT", "/v1/workstation/settings", { defaultBrowser: "b-zzz" })).status, 404);
    const unknown = await api.call("POST", "/v1/workstation/actions", { ...TABS, browserId: "b-zzz" });
    assert.deepEqual([unknown.status, unknown.json], [404, { error: "navigateur inconnu : b-zzz" }]);
    const bad = await api.call("GET", "/v1/workstation/next?wait=0", undefined, { "X-OMP-Browser": "pas un id !" });
    assert.equal(bad.status, 400);
  } finally {
    await teardown(world, api);
  }
});

test("poste-navigateurs/AC-2 : le statut et le profil exposent les navigateurs (libellé, en ligne, dernière vue, défaut) ; un navigateur hors ligne refuse une action qui le cible", async () => {
  const { world, api } = await setup();
  try {
    await poll(api, PERSO);
    await poll(api, { ...ADEO, "X-OMP-Browser-Label": encodeURIComponent("ADEO · bureau") });
    const status = (await api.call<WorkstationStatus>("GET", "/v1/workstation")).json;
    assert.deepEqual(
      status.browsers.map((browser) => [browser.id, browser.label, browser.online, browser.isDefault]),
      [
        ["b-perso", "Perso", true, true],
        ["b-adeo", "ADEO · bureau", true, false],
      ],
    );
    assert.equal(status.defaultBrowser, "b-perso");
    assert.ok(status.browsers.every((browser) => typeof browser.lastSeenAt === "number"));
    const profile = (await api.call<{ browsers: BrowserView[] }>("GET", "/v1/workstation/profile")).json;
    assert.deepEqual(
      profile.browsers.map((browser) => browser.id),
      ["b-perso", "b-adeo"],
    );
    assert.deepEqual(
      world.store.eventsOfType("workstation_browser").map((event) => [event.payload, event.repo]),
      [
        [{ id: "b-perso", label: "Perso" }, null],
        [{ id: "b-adeo", label: "ADEO · bureau" }, null],
      ],
    );
    // Un navigateur connu mais muet depuis plus d'une minute est hors ligne : rien ne part pour lui.
    world.store.touchWorkstationBrowser({ id: "b-ancien", label: "Ancien", version: null, at: 1 });
    const refused = await api.call("POST", "/v1/workstation/actions", { ...TABS, browserId: "b-ancien" });
    assert.deepEqual([refused.status, refused.json], [409, { error: "l'extension du poste est hors ligne" }]);
  } finally {
    await teardown(world, api);
  }
});

test("poste-navigateurs/AC-3 : une extension ancienne, sans identifiant, est le navigateur par défaut", async () => {
  const { world, api } = await setup();
  try {
    assert.equal(await poll(api, { "X-OMP-Agent-Tabs": "1" }), null);
    const status = (await api.call<WorkstationStatus>("GET", "/v1/workstation")).json;
    assert.deepEqual(
      status.browsers.map((browser) => [browser.id, browser.isDefault, browser.online]),
      [["default", true, true]],
    );
    const action = await deposit(api, TABS);
    assert.equal((await poll(api, {}))?.seq, action.seq);
    // Une extension récente apparaît : l'ancienne reste le défaut (premier vu) et garde ses actions.
    await poll(api, PERSO);
    const next = await deposit(api, TABS);
    assert.equal(await poll(api, PERSO), null);
    assert.equal((await poll(api, {}))?.seq, next.seq);
  } finally {
    await teardown(world, api);
  }
});

test("poste-navigateurs/AC-4 : observations et meetings portent le navigateur d'où ils viennent ; le cantonnement se juge dans le navigateur ciblé", async () => {
  const { world, api } = await setup();
  try {
    await poll(api, PERSO);
    await poll(api, { ...ADEO, "X-OMP-Agent-Tabs": "" });
    const at = Date.now();
    const observed = await api.call(
      "POST",
      "/v1/workstation/observations",
      {
        tz: 0,
        events: [{ kind: "visit", at, url: "https://intranet.adeo.com/", title: "Intranet", durationMs: 1000 }],
      },
      ADEO,
    );
    assert.equal(observed.status, 200);
    const observations = (
      await api.call<{ observations: { browserId: string | null }[] }>("GET", "/v1/workstation/observations")
    ).json.observations;
    assert.deepEqual(
      observations.map((entry) => entry.browserId),
      ["b-adeo"],
    );
    const meeting = await api.call<{ meeting: Meeting }>(
      "POST",
      "/v1/workstation/meetings",
      { title: "Point", url: "https://meet.google.com/x", startedAt: at },
      ADEO,
    );
    assert.equal(meeting.json.meeting.browserId, "b-adeo");
    // L'onglet 1 est à l'agent dans Perso, pas dans ADEO : le même clic attend l'humain chez ADEO.
    const click = { kind: "click", params: { tabId: 1, ref: "e1" }, rationale: "ouvrir" };
    assert.equal((await deposit(api, { ...click, browserId: "b-perso" })).state, "queued");
    assert.equal((await deposit(api, { ...click, browserId: "b-adeo" })).state, "awaiting_approval");
  } finally {
    await teardown(world, api);
  }
});

test("poste-navigateurs/AC-5 : runAutomation pose une demande depuis l'automatisation (consigne, navigateur) ; le job mène ses actions dans ce seul navigateur", async () => {
  const { world, api } = await setup({
    "poste-demande": [
      [
        { tool: "workstation_act", args: TABS },
        { tool: "workstation_request_report", args: { report: "fait" } },
      ],
    ],
  });
  const ws = world.orchestrator.workstation;
  try {
    await poll(api, PERSO);
    await poll(api, ADEO);
    const { version } = world.store.addWorkstationProfile({
      summary: "s",
      habits: [],
      tools: [],
      schedule: "",
      repetitiveTasks: [
        { title: "Relevé ADEO", frequency: "chaque matin", steps: ["ouvrir l'intranet"], automatable: true },
      ],
      clientNeeds: [],
      preferences: [],
    });
    const bad = await api.call("POST", "/v1/workstation/automations", { version, task: 0, schedule: "tous les jours" });
    assert.equal(bad.status, 400);
    const created = await api.call<{ automation: { id: string; schedule: string; browserId: string } }>(
      "POST",
      "/v1/workstation/automations",
      { version, task: 0, schedule: "0  8 * * 1-5", browserId: "b-adeo" },
    );
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const { automation } = created.json;
    assert.deepEqual([automation.schedule, automation.browserId], ["0 8 * * 1-5", "b-adeo"]);

    const request = ws.runAutomation(automation.id, { by: "planificateur" });
    assert.deepEqual(
      [request.state, request.automationId, request.browserId, request.by],
      ["queued", automation.id, "b-adeo", "planificateur"],
    );
    assert.match(request.instruction, /Relevé ADEO/);
    assert.throws(() => ws.runAutomation("au-inconnue", { by: "planificateur" }), { status: 404 });

    await world.orchestrator.start();
    assert.equal(await poll(api, PERSO, 1), null, "Perso ne reçoit rien de la demande d'ADEO");
    const action = await poll(api, ADEO, 25);
    assert.deepEqual([action?.requestId, action?.browserId], [request.id, "b-adeo"]);
    await api.call(
      "POST",
      `/v1/workstation/actions/${action?.seq}/result`,
      { outcome: "done", result: { text: "ok" } },
      ADEO,
    );
    await waitFor(
      () => world.store.getWorkstationRequest(request.id)?.state === "done",
      () => JSON.stringify(world.store.getWorkstationRequest(request.id)),
    );

    await api.call("PUT", "/v1/workstation/settings", { paused: true });
    assert.throws(() => ws.runAutomation(automation.id, { by: "planificateur" }), {
      status: 409,
      message: "le poste est en pause",
    });
    const requests = (await api.call<{ requests: WorkstationRequest[] }>("GET", "/v1/workstation/requests")).json
      .requests;
    assert.equal(requests.length, 1, "rien n'est posé en pause");
  } finally {
    await teardown(world, api);
  }
});

test("poste-navigateurs/AC-6 : une demande en file attend que SON navigateur soit en ligne", async () => {
  const { world, api } = await setup({
    "poste-demande": [[{ tool: "workstation_request_report", args: { report: "ok" } }]],
  });
  try {
    await poll(api, PERSO);
    world.store.touchWorkstationBrowser({ id: "b-adeo", label: "ADEO", version: null, at: 1 });
    const posed = await api.call<{ request: WorkstationRequest }>("POST", "/v1/workstation/requests", {
      instruction: "relever les commandes",
      browserId: "b-adeo",
    });
    assert.equal(posed.status, 201, JSON.stringify(posed.json));
    const { request } = posed.json;
    await world.orchestrator.start();
    await waitFor(
      () => world.store.getWorkstationRequest(request.id)?.reason === "l'extension du poste est hors ligne",
      () => JSON.stringify(world.store.getWorkstationRequest(request.id)),
    );
    assert.equal(world.spawned.length, 0, "Perso en ligne ne suffit pas");
    await poll(api, ADEO);
    await waitFor(
      () => world.store.getWorkstationRequest(request.id)?.state === "done",
      () => JSON.stringify(world.store.getWorkstationRequest(request.id)),
    );
    const unknown = await api.call("POST", "/v1/workstation/requests", { instruction: "x", browserId: "b-zzz" });
    assert.equal(unknown.status, 404);
  } finally {
    await teardown(world, api);
  }
});

test("poste-navigateurs/AC-7 : l'extension présente son identifiant stable et son libellé (encodé) à chaque appel ; sans identité, aucun en-tête", async () => {
  const seen: Headers[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const pairing = { url: "https://harness.exemple", token: "t" };
  await harnessCall(
    { ...pairing, browser: { id: "b-perso", label: "Perso ADEO é" } },
    "GET",
    "/v1/workstation/next",
    undefined,
    {
      fetcher,
    },
  );
  await harnessCall({ ...pairing, browser: { id: "b-perso", label: "  " } }, "GET", "/v1/workstation/next", undefined, {
    fetcher,
  });
  await harnessCall(pairing, "GET", "/v1/workstation/next", undefined, { fetcher });
  assert.deepEqual(
    seen.map((headers) => [headers.get("X-OMP-Browser"), headers.get("X-OMP-Browser-Label")]),
    [
      ["b-perso", encodeURIComponent("Perso ADEO é")],
      ["b-perso", null],
      [null, null],
    ],
  );

  // L'identifiant est créé une fois et gardé dans chrome.storage.local ; le ré-appairage ne le change pas.
  const local = new Map<string, unknown>();
  const chromeStub = {
    storage: {
      local: {
        get: async (key: string) => (local.has(key) ? { [key]: local.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) local.set(key, value);
        },
      },
    },
  };
  Object.assign(globalThis, { chrome: chromeStub });
  try {
    // store.ts touche `chrome` : chemin calculé, le programme de types des tests (sans DOM) ne le suit pas.
    const store = (await import(pathToFileURL(path.join(ROOT, "omp-chrome", "src", "store.ts")).href)) as {
      browserId: () => Promise<string>;
      identified: (pairing: { url: string; token: string }, label: string) => Promise<unknown>;
      saveSettings: (patch: Record<string, unknown>) => Promise<unknown>;
    };
    const { browserId, identified, saveSettings } = store;
    const first = await browserId();
    assert.match(first, /^[A-Za-z0-9_.-]{1,64}$/);
    await saveSettings({ pairing, browserLabel: "ADEO" });
    await saveSettings({ pairing: { url: "https://autre.exemple", token: "u" } });
    assert.equal(await browserId(), first);
    assert.deepEqual(await identified(pairing, "ADEO"), { ...pairing, browser: { id: first, label: "ADEO" } });
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("poste-navigateurs/AC-8 : l'approbateur règle à chaud les hôtes permis et la garde anti-exfiltration ; la garde de navigation les applique, la configuration reste le défaut", async () => {
  const { world, api } = await setup();
  try {
    await poll(api, PERSO);
    const initial = (await api.call<WorkstationStatus>("GET", "/v1/workstation")).json;
    assert.deepEqual(
      [initial.allowedHosts, initial.exfiltrationGuard, initial.navigationSource],
      [[], true, { allowedHosts: "config", exfiltrationGuard: "config" }],
    );
    const open = { kind: "open", params: { url: "https://intranet.adeo.com/x" }, rationale: "ouvrir" };
    assert.equal((await deposit(api, open)).state, "queued", "aucune liste : l'hôte passe");

    const clients = new ClientRegistry(path.join(tmpdir("poste-navigateurs-"), "clients.json"));
    const admin = clients.add("mac", "admin", "*").token;
    const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const refused = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/workstation/settings`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
          body: JSON.stringify({ allowedHosts: ["exemple.fr"] }),
        },
      );
      assert.equal(refused.status, 403);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    for (const allowedHosts of [
      ["https://adeo.com"],
      ["adeo.com/chemin"],
      ["adeo.com:443"],
      "adeo.com",
      Array(201).fill("a.fr"),
    ])
      assert.equal(
        (await api.call("PUT", "/v1/workstation/settings", { allowedHosts })).status,
        400,
        JSON.stringify(allowedHosts).slice(0, 40),
      );
    assert.equal((await api.call("PUT", "/v1/workstation/settings", { exfiltrationGuard: "non" })).status, 400);

    const set = await api.call<WorkstationStatus>("PUT", "/v1/workstation/settings", {
      allowedHosts: [" Mail.Exemple.fr ", "*.adeo.com", "mail.exemple.fr"],
      exfiltrationGuard: false,
    });
    assert.equal(set.status, 200);
    assert.deepEqual(
      [set.json.allowedHosts, set.json.exfiltrationGuard, set.json.navigationSource],
      [["mail.exemple.fr", "*.adeo.com"], false, { allowedHosts: "setting", exfiltrationGuard: "setting" }],
    );
    assert.equal((await deposit(api, open)).state, "queued", "un sous-domaine listé passe");
    const outside = await deposit(api, { ...open, params: { url: "https://ailleurs.example/" } });
    assert.equal(outside.state, "awaiting_approval");
    assert.match(String(outside.approval?.summary), /hors de la liste des hôtes permis/);

    const reset = await api.call<WorkstationStatus>("PUT", "/v1/workstation/settings", {
      allowedHosts: null,
      exfiltrationGuard: null,
    });
    assert.deepEqual(
      [reset.json.allowedHosts, reset.json.exfiltrationGuard, reset.json.navigationSource],
      [[], true, { allowedHosts: "config", exfiltrationGuard: "config" }],
    );
  } finally {
    await teardown(world, api);
  }
});
