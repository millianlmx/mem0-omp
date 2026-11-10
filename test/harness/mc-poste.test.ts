// Tranche « le poste d'un espace » (multi-client, M3) : un navigateur du poste appartient à un espace
// (un client) et tout ce qui en vient en hérite — observations, meetings, actions, captures ; les
// lectures du poste se bornent à un espace (`?space=`) ; une demande posée dans un espace s'exécute
// dans un navigateur de CET espace, jamais ailleurs ; le profil, la mémoire, le répertoire de travail
// et les identités du poste sont ceux de l'espace ; sa consommation lui est imputée ; `spaces.poste`
// se déduit des navigateurs rattachés. Et SANS espace, rien ne change.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type {
  Meeting,
  Space,
  WorkstationAction,
  WorkstationAutomation,
  WorkstationProfile,
  WorkstationRequest,
} from "../../omp-harness/db.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import type { IntakeView } from "../../omp-harness/intake.ts";
import type { BrowserView, ProfileStats, WorkstationStatus } from "../../omp-harness/workstation.ts";
import {
  APPROVER_ONLY,
  NO_SPACE_BROWSER,
  REQUEST_OUT_OF_SPACE,
  posteDir,
  uploadDir,
} from "../../omp-harness/workstation.ts";
import { WORKSTATION_SCOPE, workstationScope, workstationTarget } from "../../omp-harness/workstation-agent.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

/** Les extensions appairées : celle d'un client (« Acme »), celle d'un autre (« Exemple »), et le navigateur personnel. */
const ACME = { "X-OMP-Browser": "b-acme", "X-OMP-Browser-Label": "Acme", "X-OMP-Agent-Tabs": "1" };
const EXEMPLE = { "X-OMP-Browser": "b-exemple", "X-OMP-Browser-Label": "Exemple", "X-OMP-Agent-Tabs": "1" };
const PERSO = { "X-OMP-Browser": "b-perso", "X-OMP-Browser-Label": "Perso", "X-OMP-Agent-Tabs": "1" };
const TABS = { kind: "tabs", params: {}, rationale: "voir les onglets" };

const profile = (summary: string) => ({
  summary,
  habits: [],
  tools: [],
  schedule: "9 h – 18 h",
  repetitiveTasks: [
    { title: "Relance des devis", frequency: "chaque lundi", steps: ["CRM", "mail"], automatable: true },
  ],
  clientNeeds: [],
  preferences: [],
});

/** Un message d'assistant qui a coûté `cost` dollars : une ligne de consommation. */
const spend = (cost: number) => ({
  frame: {
    type: "message_end",
    message: { role: "assistant", usage: { input: 10, output: 5, cost: { total: cost } } },
  },
});

type Reply<T> = { status: number; json: T };
type CallOptions = { token?: string; headers?: Record<string, string> };
type Api = {
  /** L'appareil approbateur (par défaut), un admin qui ne l'est pas, un client borné au dépôt `demo`. */
  tokens: { approver: string; owner: string; demo: string };
  call: <T = Record<string, unknown>>(
    method: string,
    route: string,
    body?: unknown,
    options?: CallOptions,
  ) => Promise<Reply<T>>;
  close: () => Promise<void>;
};

async function serve(world: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("mc-poste-"), "clients.json"));
  const tokens = {
    approver: clients.add("app-approbateur", "admin", "*", true).token,
    owner: clients.add("mac", "admin", "*").token,
    demo: clients.add("mac-demo", "operator", ["demo"]).token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    tokens,
    call: async <T>(method: string, route: string, body?: unknown, options: CallOptions = {}) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.token ?? tokens.approver}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...options.headers,
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

/** Le long-poll d'une extension : l'action louée, ou `null` (204). Il la met aussi en ligne. */
async function poll(api: Api, headers: Record<string, string>, wait = 0): Promise<WorkstationAction | null> {
  const reply = await api.call<{ action: WorkstationAction }>("GET", `/v1/workstation/next?wait=${wait}`, undefined, {
    headers,
  });
  assert.ok(reply.status === 200 || reply.status === 204, JSON.stringify(reply.json));
  return reply.status === 200 ? reply.json.action : null;
}

/**
 * Les extensions se présentent, dans cet ordre : la première est le navigateur par défaut. Leur ordre
 * d'arrivée est écrit en base avant leur premier contact — deux contacts dans la même milliseconde
 * se rangeraient par identifiant, pas par arrivée.
 */
async function online(world: FakeWorld, api: Api, ...extensions: Record<string, string>[]): Promise<void> {
  for (const [index, headers] of extensions.entries()) {
    const id = String(headers["X-OMP-Browser"]);
    world.store.touchWorkstationBrowser({ id, label: null, version: null, at: index + 1 });
    assert.equal(await poll(api, headers), null);
  }
}

/** Un espace créé par un admin (ses dépôts : `repos`) ; rend son identifiant. */
async function space(api: Api, name: string, repos: string[] = []): Promise<string> {
  const reply = await api.call<{ space: Space }>("POST", "/v1/spaces", { name, repos }, { token: api.tokens.owner });
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  return reply.json.space.id;
}

/** Rattache un navigateur à un espace (ou le détache : `null`), par l'appareil approbateur. */
async function attach(api: Api, browserId: string, target: string | null): Promise<BrowserView> {
  const reply = await api.call<{ browser: BrowserView }>("PUT", `/v1/workstation/browsers/${browserId}`, {
    space: target,
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  return reply.json.browser;
}

/** Une visite observée par une extension. */
async function visit(api: Api, headers: Record<string, string>, url: string, title: string): Promise<void> {
  const reply = await api.call(
    "POST",
    "/v1/workstation/observations",
    {
      tz: -60,
      events: [{ kind: "visit", at: Date.now(), url, title, durationMs: 60_000 }],
    },
    { headers },
  );
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
}

async function deposit(api: Api, body: Record<string, unknown>, query = ""): Promise<WorkstationAction> {
  const reply = await api.call<{ action: WorkstationAction }>("POST", `/v1/workstation/actions${query}`, body);
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  return reply.json.action;
}

/** Un meeting digéré venu du navigateur `browserId`, écrit en base (le digest a ses propres tests). */
function meeting(world: FakeWorld, id: string, title: string, browserId: string): void {
  world.store.createWorkstationMeeting({
    id,
    title,
    url: "https://meet.exemple.fr/x",
    startedAt: Date.now(),
    browserId,
  });
  world.store.updateWorkstationMeetingIf(id, ["live"], { state: "digested", summary: `résumé de ${title}`, needs: [] });
}

const prompts = (world: FakeWorld, step: string): string[] =>
  world
    .log()
    .filter((entry) => entry.kind === "prompt" && entry.step === step)
    .map((entry) => String(entry.message));

/** Les lancements du faux runner : répertoire de travail et scope mémoire de chacun. */
const launches = (world: FakeWorld): { cwd: string; scope: unknown }[] =>
  world
    .log()
    .filter((entry) => entry.kind === "argv")
    .map((entry) => ({
      cwd: path.basename(String(entry.cwd)),
      scope: (entry.env as Record<string, unknown> | undefined)?.MEM0_PROJECT_ID,
    }));

async function until(world: FakeWorld, id: string, state: WorkstationRequest["state"]): Promise<WorkstationRequest> {
  await waitFor(
    () => world.store.getWorkstationRequest(id)?.state === state,
    () => `${JSON.stringify(world.store.getWorkstationRequest(id))} ${JSON.stringify(world.log().slice(-3))}`,
  );
  return world.store.getWorkstationRequest(id) as WorkstationRequest;
}

test("mc-poste/AC-1 : l'approbateur rattache un navigateur à un espace (par id ou par nom) et le détache ; le statut rend `browsers[].space` ; un autre client est refusé, un espace ou un navigateur inconnu rend 404", async () => {
  const { world, api } = await setup();
  try {
    await online(world, api, PERSO, ACME);
    const acme = await space(api, "Acme");
    const route = "/v1/workstation/browsers/b-acme";

    const forbidden = await api.call("PUT", route, { space: acme }, { token: api.tokens.owner });
    assert.deepEqual([forbidden.status, forbidden.json], [403, { error: APPROVER_ONLY }]);
    assert.equal((await api.call("PUT", route, { space: acme }, { token: api.tokens.demo })).status, 403);
    const unknownSpace = await api.call("PUT", route, { space: "e-inconnu" });
    assert.deepEqual([unknownSpace.status, unknownSpace.json], [404, { error: "espace inconnu : e-inconnu" }]);
    const unknownBrowser = await api.call("PUT", "/v1/workstation/browsers/b-zzz", { space: acme });
    assert.deepEqual([unknownBrowser.status, unknownBrowser.json], [404, { error: "navigateur inconnu : b-zzz" }]);
    for (const body of [{}, { space: 3 }, { space: "" }])
      assert.equal((await api.call("PUT", route, body)).status >= 400, true, JSON.stringify(body));
    const browsersOf = async () =>
      (await api.call<WorkstationStatus>("GET", "/v1/workstation")).json.browsers.map((b) => [b.id, b.space]);
    assert.deepEqual(
      await browsersOf(),
      [
        ["b-perso", null],
        ["b-acme", null],
      ],
      "aucun refus n'a rien rattaché",
    );

    const attached = await attach(api, "b-acme", acme);
    assert.deepEqual([attached.id, attached.label, attached.space, attached.online], ["b-acme", "Acme", acme, true]);
    assert.deepEqual(await browsersOf(), [
      ["b-perso", null],
      ["b-acme", acme],
    ]);
    assert.deepEqual(world.store.eventsOfType("workstation_browser").at(-1)?.payload, {
      id: "b-acme",
      label: "Acme",
      space: acme,
    });
    // Par son nom, sans égard à la casse ; puis détaché.
    assert.equal((await attach(api, "b-perso", "acme")).space, acme);
    assert.equal((await attach(api, "b-perso", null)).space, null);
    assert.deepEqual(await browsersOf(), [
      ["b-perso", null],
      ["b-acme", acme],
    ]);
    // Le long-poll suivant de l'extension ne défait rien : le rattachement est durable.
    await poll(api, ACME);
    assert.deepEqual(await browsersOf(), [
      ["b-perso", null],
      ["b-acme", acme],
    ]);
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-2 : avec `?space=`, observations, meetings, actions, demandes, automatisations et statut ne rendent que ce qui vient des navigateurs de l'espace ; un objet d'ailleurs y est inconnu (404), comme un espace inconnu", async () => {
  const { world, api } = await setup();
  try {
    await online(world, api, PERSO, ACME);
    const acme = await space(api, "Acme");
    const autre = await space(api, "Exemple");
    await attach(api, "b-acme", acme);

    await visit(api, ACME, "https://crm.acme.exemple/deals", "Affaires Acme");
    await visit(api, PERSO, "https://perso.exemple.fr/blog", "Blog perso");
    const meet = async (headers: Record<string, string>, title: string): Promise<string> =>
      (
        await api.call<{ meeting: Meeting }>(
          "POST",
          "/v1/workstation/meetings",
          { title, url: "https://meet.exemple.fr/abc", startedAt: Date.now() },
          { headers },
        )
      ).json.meeting.id;
    const meetAcme = await meet(ACME, "Point Acme");
    const meetPerso = await meet(PERSO, "Point perso");
    const actAcme = await deposit(api, { ...TABS, browserId: "b-acme" }, `?space=${acme}`);
    const actPerso = await deposit(api, { ...TABS, browserId: "b-perso" });
    const post = async (body: Record<string, unknown>): Promise<WorkstationRequest> =>
      (await api.call<{ request: WorkstationRequest }>("POST", "/v1/workstation/requests", body)).json.request;
    const askAcme = await post({ instruction: "relever les commandes Acme", space: acme });
    const askPerso = await post({ instruction: "ranger mes favoris" });
    world.store.addWorkstationProfile(profile("profil Acme"), acme);
    world.store.addWorkstationProfile(profile("profil perso"));
    const automate = async (query: string): Promise<WorkstationAutomation> =>
      (
        await api.call<{ automation: WorkstationAutomation }>("POST", `/v1/workstation/automations${query}`, {
          version: 1,
          task: 0,
        })
      ).json.automation;
    const autoAcme = await automate(`?space=${acme}`);
    const autoPerso = await automate("");
    assert.notEqual(autoAcme.id, autoPerso.id, "la même tâche dans deux portées : deux automatisations");
    assert.deepEqual([autoAcme.browserId, autoPerso.browserId], ["b-acme", null]);

    const read = async <T>(route: string, key: string, query: string): Promise<T[]> => {
      const reply = await api.call<Record<string, T[]>>("GET", `${route}${query}`);
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      return reply.json[key] as T[];
    };
    const inAcme = `?space=${acme}`;
    assert.deepEqual(
      (await read<{ url: string }>("/v1/workstation/observations", "observations", inAcme)).map((o) => o.url),
      ["https://crm.acme.exemple/deals"],
    );
    assert.deepEqual(
      (await read<Meeting>("/v1/workstation/meetings", "meetings", inAcme)).map((m) => m.id),
      [meetAcme],
    );
    assert.deepEqual(
      (await read<WorkstationAction>("/v1/workstation/actions", "actions", inAcme)).map((a) => a.seq),
      [actAcme.seq],
    );
    assert.deepEqual(
      (await read<WorkstationRequest>("/v1/workstation/requests", "requests", inAcme)).map((r) => r.id),
      [askAcme.id],
    );
    assert.deepEqual(
      (await read<WorkstationAutomation>("/v1/workstation/automations", "automations", inAcme)).map((a) => a.id),
      [autoAcme.id],
    );
    // Sans `?space=` : tout, comme avant. Dans un espace sans navigateur : rien.
    for (const [route, key, all] of [
      ["/v1/workstation/observations", "observations", 2],
      ["/v1/workstation/meetings", "meetings", 2],
      ["/v1/workstation/actions", "actions", 2],
      ["/v1/workstation/requests", "requests", 2],
      ["/v1/workstation/automations", "automations", 2],
    ] as const) {
      assert.equal((await read(route, key, "")).length, all, route);
      assert.equal((await read(route, key, `?space=${autre}`)).length, 0, route);
    }

    const status = (await api.call<WorkstationStatus>("GET", `/v1/workstation${inAcme}`)).json;
    assert.deepEqual([status.browsers.map((b) => b.id), status.online, status.observedSeconds], [["b-acme"], true, 60]);
    const empty = (await api.call<WorkstationStatus>("GET", `/v1/workstation?space=${autre}`)).json;
    assert.deepEqual([empty.browsers, empty.online, empty.observedSeconds, empty.lastSeenAt], [[], false, 0, null]);
    assert.equal((await api.call<WorkstationStatus>("GET", "/v1/workstation")).json.observedSeconds, 120);

    // Un objet d'un autre navigateur n'existe pas dans l'espace ; il reste lisible sans `?space=`.
    for (const [mine, theirs] of [
      [`/v1/workstation/actions/${actAcme.seq}`, `/v1/workstation/actions/${actPerso.seq}`],
      [`/v1/workstation/meetings/${meetAcme}`, `/v1/workstation/meetings/${meetPerso}`],
      [`/v1/workstation/requests/${askAcme.id}`, `/v1/workstation/requests/${askPerso.id}`],
    ] as const) {
      assert.equal((await api.call("GET", `${mine}${inAcme}`)).status, 200, mine);
      assert.equal((await api.call("GET", `${theirs}${inAcme}`)).status, 404, theirs);
      assert.equal((await api.call("GET", `${mine}?space=${autre}`)).status, 404, mine);
      assert.equal((await api.call("GET", theirs)).status, 200, theirs);
    }
    assert.equal((await api.call("GET", `/v1/workstation/actions/${actPerso.seq}/capture${inAcme}`)).status, 404);
    assert.equal((await api.call("GET", "/v1/workstation/requests?space=e-inconnu")).status, 404);
    // Une action déposée « dans l'espace » part dans son navigateur ; celui d'ailleurs est refusé.
    assert.equal((await deposit(api, TABS, inAcme)).browserId, "b-acme");
    const elsewhere = await api.call("POST", `/v1/workstation/actions${inAcme}`, { ...TABS, browserId: "b-perso" });
    assert.deepEqual(
      [elsewhere.status, elsewhere.json],
      [409, { error: "le navigateur b-perso n'appartient pas à cet espace" }],
    );
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-3 : une demande posée dans un espace vise un navigateur de CET espace (celui en ligne de préférence) ; 409 si l'espace n'en a pas ou si le navigateur désigné est ailleurs ; jamais le navigateur par défaut d'un autre", async () => {
  const { world, api } = await setup();
  try {
    // Le navigateur par défaut (le premier vu) est celui d'un AUTRE espace.
    await online(world, api, EXEMPLE, PERSO);
    const acme = await space(api, "Acme");
    const exemple = await space(api, "Exemple");
    await attach(api, "b-exemple", exemple);
    const post = (body: Record<string, unknown>, query = "") =>
      api.call<{ request: WorkstationRequest; error?: string }>("POST", `/v1/workstation/requests${query}`, body);

    const none = await post({ instruction: "relever les commandes", space: acme });
    assert.deepEqual([none.status, none.json.error], [409, NO_SPACE_BROWSER]);
    assert.equal((await post({ instruction: "x", space: "e-inconnu" })).status, 404);
    assert.equal((await post({ instruction: "x", space: 7 })).status, 400);
    assert.equal(world.store.listWorkstationRequests().length, 0, "aucun refus n'a rien créé");

    // Deux navigateurs dans l'espace : le premier vu est hors ligne, l'autre en ligne.
    world.store.touchWorkstationBrowser({ id: "b-acme-vieux", label: "Acme (ancien)", version: null, at: 3 });
    await attach(api, "b-acme-vieux", acme);
    await poll(api, ACME);
    await attach(api, "b-acme", acme);
    const placed = (await post({ instruction: "relever les commandes", space: acme })).json.request;
    assert.deepEqual([placed.browserId, placed.space, placed.state], ["b-acme", acme, "queued"]);
    // `?space=` vaut `body.space` ; le nom de l'espace aussi.
    assert.equal((await post({ instruction: "par la requête" }, `?space=${acme}`)).json.request.space, acme);
    assert.equal((await post({ instruction: "par le nom", space: "ACME" })).json.request.space, acme);
    // Un navigateur désigné : le sien passe, celui d'un autre espace ou hors espace est refusé.
    const chosen = await post({ instruction: "dans l'ancien", space: acme, browserId: "b-acme-vieux" });
    assert.deepEqual([chosen.status, chosen.json.request.browserId], [201, "b-acme-vieux"]);
    for (const browserId of ["b-exemple", "b-perso"]) {
      const refused = await post({ instruction: "ailleurs", space: acme, browserId });
      assert.deepEqual(
        [refused.status, refused.json.error],
        [409, `le navigateur ${browserId} n'appartient pas à cet espace`],
        browserId,
      );
    }
    // Sans espace donné, la demande hérite de l'espace du navigateur où elle partira.
    assert.equal((await post({ instruction: "ciblée", browserId: "b-acme" })).json.request.space, acme);
    assert.equal((await post({ instruction: "par défaut" })).json.request.space, exemple);
    assert.equal("space" in (await post({ instruction: "perso", browserId: "b-perso" })).json.request, false);
    // L'événement de chaque pose dit l'espace (clé absente hors espace).
    assert.deepEqual(
      world.store
        .eventsOfType("workstation_request")
        .filter((event) => event.payload.state === "queued" && event.payload.reason === null)
        .map((event) => event.payload.space ?? null),
      [acme, acme, acme, acme, acme, exemple, null],
    );
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-4 : la demande d'un espace s'exécute dans SON navigateur, avec le profil, la mémoire (`workstation:<espace>`) et le répertoire de travail de l'espace ; sa consommation lui est imputée", async () => {
  const { world, api } = await setup({
    "poste-demande": [
      [
        spend(0.12),
        { tool: "workstation_act", args: { kind: "tabs", params: {}, rationale: "voir les onglets du client" } },
        { tool: "workstation_request_report", args: { report: "Commandes relevées." } },
      ],
    ],
  });
  try {
    await online(world, api, PERSO, ACME);
    const acme = await space(api, "Acme");
    await attach(api, "b-acme", acme);
    world.store.addWorkstationProfile(profile("PROFIL-HORS-ESPACE"));
    world.store.addWorkstationProfile(profile("PROFIL-ACME"), acme);
    const posted = await api.call<{ request: WorkstationRequest }>("POST", "/v1/workstation/requests", {
      instruction: "relever les commandes",
      space: acme,
    });
    const { id } = posted.json.request;
    await world.orchestrator.start();
    // Le navigateur par défaut (hors espace) ne reçoit rien ; celui de l'espace loue l'action.
    const leased = await poll(api, ACME, 25);
    assert.deepEqual([leased?.kind, leased?.browserId, leased?.requestId], ["tabs", "b-acme", id]);
    assert.equal(await poll(api, PERSO), null);
    await api.call(
      "POST",
      `/v1/workstation/actions/${leased?.seq}/result`,
      { outcome: "done", result: { text: "1 · Commandes · https://crm.acme.exemple/" } },
      { headers: ACME },
    );
    const done = await until(world, id, "done");
    assert.equal(done.report, "Commandes relevées.");

    assert.deepEqual(launches(world), [{ cwd: `_poste-${acme}`, scope: `workstation:${acme}` }]);
    assert.equal(workstationScope(acme), `workstation:${acme}`);
    const [prompt] = prompts(world, "poste-demande");
    assert.match(String(prompt), /PROFIL-ACME/, "le profil de l'espace est donné");
    assert.doesNotMatch(String(prompt), /PROFIL-HORS-ESPACE/, "jamais le profil d'ailleurs");
    assert.match(String(prompt), /## Espace\nTu travailles dans l'espace « Acme »/);
    const usage = world.store.usageSince(0).filter((row) => row.step === "poste-demande");
    assert.deepEqual(
      usage.map((row) => [row.cost, row.repo, row.spaceId]),
      [[0.12, null, acme]],
    );
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-5 : une demande dont le navigateur a quitté son espace avant de partir échoue au lieu de s'exécuter ailleurs — aucun runner, aucune action — et la suivante prend la tête", async () => {
  const { world, api } = await setup({
    "poste-demande": [[{ tool: "workstation_request_report", args: { report: "fait" } }]],
  });
  try {
    await online(world, api, PERSO, ACME);
    const acme = await space(api, "Acme");
    const exemple = await space(api, "Exemple");
    await attach(api, "b-acme", acme);
    // Posées sans passer par la route : elle relance le tour, qui ferait partir la première tout de suite.
    const post = (body: Record<string, unknown>): WorkstationRequest =>
      world.orchestrator.workstation.createRequest(body, { by: "app-approbateur" });
    const moved = post({ instruction: "pour Acme", space: acme });
    const detached = post({ instruction: "pour Acme aussi", space: acme });
    const next = post({ instruction: "perso", browserId: "b-perso" });
    // Le navigateur passe chez un autre client : les demandes d'Acme ne le suivent pas.
    await attach(api, "b-acme", exemple);
    await world.orchestrator.start();
    const settled = await until(world, next.id, "done");
    assert.equal(settled.report, "fait");
    for (const request of [moved, detached]) {
      const failed = world.store.getWorkstationRequest(request.id);
      assert.deepEqual([failed?.state, failed?.reason], ["failed", REQUEST_OUT_OF_SPACE], request.instruction);
    }
    assert.deepEqual(
      launches(world),
      [{ cwd: "_poste", scope: WORKSTATION_SCOPE }],
      "un seul runner : la demande perso",
    );
    assert.equal(world.store.listWorkstationActions({ limit: 50 }).length, 0);
    // Une demande en cours ne dépose rien non plus dans un navigateur sorti de son espace.
    await attach(api, "b-acme", acme);
    const running = post({ instruction: "en cours", space: acme });
    world.orchestrator.workstation.startRequest(running.id);
    await attach(api, "b-acme", null);
    assert.throws(
      () =>
        world.orchestrator.workstation.createAction(
          { kind: "tabs", params: {}, rationale: "onglets" },
          "agent",
          "agent",
          running.id,
        ),
      { status: 409, message: REQUEST_OUT_OF_SPACE },
    );
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-6 : une Demande classée `workstation_request` dans un espace devient une demande du poste de CET espace, dans son navigateur ; dans un espace sans navigateur, elle ne crée rien", async () => {
  const plan = {
    kind: "workstation_request",
    repo: null,
    title: "Ouvrir la facture",
    statement: "Ouvre la facture du mois dans le navigateur.",
  };
  const { world, api } = await setup({ demande: [[{ tool: "intake_classify", args: plan }]] });
  try {
    await online(world, api, PERSO, ACME);
    const acme = await space(api, "Acme", ["demo"]);
    const vide = await space(api, "Exemple");
    await attach(api, "b-acme", acme);
    const classified = async (target: string): Promise<IntakeView> => {
      const posted = await api.call<{ intake: IntakeView }>("POST", "/v1/intake", {
        text: "ouvre la facture du mois",
        source: "cli",
        space: target,
      });
      assert.equal(posted.status, 201, JSON.stringify(posted.json));
      const { id } = posted.json.intake;
      await waitFor(
        () => world.store.getIntake(id)?.state !== "classifying" && !world.orchestrator.intake.isLive(id),
        () => JSON.stringify(world.store.getIntake(id)),
      );
      return (await api.call<{ intake: IntakeView }>("GET", `/v1/intake/${id}`)).json.intake;
    };
    const intake = await classified(acme);
    assert.deepEqual([intake.state, intake.space], ["planned", { id: acme, name: "Acme" }]);
    const confirmed = await api.call<{ intake: IntakeView }>("POST", `/v1/intake/${intake.id}/confirm`, {});
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
    assert.equal(confirmed.json.intake.created?.kind, "workstation_request");
    const request = world.store.getWorkstationRequest(confirmed.json.intake.created?.id ?? "");
    assert.deepEqual(
      [request?.instruction, request?.space, request?.browserId],
      [plan.statement, acme, "b-acme"],
      "dans le navigateur de l'espace, pas le navigateur par défaut",
    );
    const lost = await classified(vide);
    assert.equal(lost.state, "failed");
    assert.equal(world.store.listWorkstationRequests().length, 1, "rien n'est parti ailleurs");
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-7 : le profil se synthétise par espace, sur les SEULES observations et réunions de ses navigateurs, dans la portée `workstation:<espace>` ; le profil hors espace ne lit plus que les navigateurs sans espace ; 409 pour un espace sans navigateur", async () => {
  const { world, api } = await setup({
    "poste-profil": [[{ tool: "workstation_profile_write", args: profile("profil synthétisé") }]],
  });
  try {
    await online(world, api, PERSO, ACME);
    const acme = await space(api, "Acme");
    const vide = await space(api, "Exemple");
    await attach(api, "b-acme", acme);
    await visit(api, ACME, "https://crm.acme.exemple/deals", "Affaires Acme");
    await visit(api, PERSO, "https://perso.exemple.fr/blog", "Blog perso");
    meeting(world, "m-acme", "Point Acme", "b-acme");
    meeting(world, "m-perso", "Point perso", "b-perso");
    await world.orchestrator.start();

    const refused = await api.call("POST", `/v1/workstation/profile/rebuild?space=${vide}`);
    assert.deepEqual([refused.status, refused.json], [409, { error: NO_SPACE_BROWSER }]);
    const queued = await api.call("POST", `/v1/workstation/profile/rebuild?space=${acme}`);
    assert.deepEqual([queued.status, queued.json], [202, { queued: true }]);
    await waitFor(
      () => world.store.latestWorkstationProfile(acme)?.version === 1,
      () => JSON.stringify(world.log().slice(-3)),
    );
    assert.equal(world.store.latestWorkstationProfile(), null, "le profil hors espace n'a pas bougé");
    const [ofAcme] = prompts(world, "poste-profil");
    assert.match(String(ofAcme), /crm\.acme\.exemple/);
    assert.match(String(ofAcme), /Point Acme/);
    assert.match(String(ofAcme), /Tu travailles dans l'espace « Acme »/);
    assert.doesNotMatch(String(ofAcme), /perso\.exemple\.fr|Point perso|Blog perso/, "rien d'un autre navigateur");
    assert.deepEqual(launches(world), [{ cwd: `_poste-${acme}`, scope: `workstation:${acme}` }]);
    assert.deepEqual(world.store.eventsOfType("workstation_profile").at(-1)?.payload, { version: 1, space: acme });
    type ProfileView = { profile: WorkstationProfile | null; stats: ProfileStats; browsers: BrowserView[] };
    const view = (await api.call<ProfileView>("GET", `/v1/workstation/profile?space=${acme}`)).json;
    assert.deepEqual(
      [view.profile?.version, view.stats.topSites.map((site) => site.host), view.stats.observedSeconds],
      [1, ["crm.acme.exemple"], 60],
    );
    assert.deepEqual(
      view.browsers.map((browser) => browser.id),
      ["b-acme"],
    );
    assert.equal(
      (await api.call<WorkstationStatus>("GET", `/v1/workstation?space=${acme}`)).json.profileUpdatedAt !== null,
      true,
    );

    // Le profil hors espace : les seuls navigateurs sans espace, dans la portée `workstation`.
    assert.equal((await api.call("POST", "/v1/workstation/profile/rebuild")).status, 202);
    await waitFor(
      () => world.store.latestWorkstationProfile()?.version === 1,
      () => JSON.stringify(world.log().slice(-3)),
    );
    const [, global] = prompts(world, "poste-profil");
    assert.match(String(global), /perso\.exemple\.fr/);
    assert.match(String(global), /Point perso/);
    assert.doesNotMatch(String(global), /crm\.acme\.exemple|Point Acme|Affaires Acme|## Espace/, "rien de l'espace");
    assert.deepEqual(launches(world)[1], { cwd: "_poste", scope: WORKSTATION_SCOPE });
    assert.deepEqual(world.store.eventsOfType("workstation_profile").at(-1)?.payload, { version: 1 });
    const free = (await api.call<ProfileView>("GET", "/v1/workstation/profile")).json;
    assert.deepEqual(
      [free.stats.topSites.map((site) => site.host), free.stats.observedSeconds, free.browsers.length],
      [["perso.exemple.fr"], 60, 2],
    );
    assert.equal(world.store.latestWorkstationProfile(acme)?.version, 1, "une version par portée");
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-8 : les identités d'un espace (`PUT /v1/spaces/{id} {identities}`) remplacent la liste globale pour ses navigateurs — un envoi « à soi » chez un client ne l'est pas ailleurs — et ne sont rendues qu'au propriétaire", async () => {
  const { world, api } = await setup();
  try {
    await online(world, api, PERSO, ACME);
    const acme = await space(api, "Acme", ["demo"]);
    await attach(api, "b-acme", acme);
    const edit = (body: Record<string, unknown>) =>
      api.call<{ space: Space }>("PUT", `/v1/spaces/${acme}`, body, { token: api.tokens.owner });
    const many = Array.from({ length: 51 }, (_, index) => `moi-${index}@acme.exemple`);
    for (const identities of ["moi@acme.exemple", [3], [""], ["x".repeat(201)], many])
      assert.equal((await edit({ identities })).status, 400, JSON.stringify(identities).slice(0, 40));
    const edited = await edit({ identities: [" moi@acme.exemple ", "moi@acme.exemple", "@moi-acme"] });
    assert.deepEqual([edited.status, edited.json.space.identities], [200, ["moi@acme.exemple", "@moi-acme"]]);
    await api.call("PUT", "/v1/workstation/settings", { selfIdentities: ["moi@perso.exemple"] });

    /** Une action louée par le navigateur, qui rend un envoi à approuver vers `recipient` : l'état qui en sort. */
    const send = async (headers: Record<string, string>, recipient: string): Promise<WorkstationAction> => {
      // Le navigateur d'un espace ne reçoit une action que si l'on nomme cet espace.
      await deposit(
        api,
        { kind: "click", params: { tabId: 1, ref: "e1" }, rationale: "envoyer", browserId: headers["X-OMP-Browser"] },
        headers === ACME ? `?space=${acme}` : "",
      );
      const leased = await poll(api, headers);
      const reply = await api.call<{ action: WorkstationAction }>(
        "POST",
        `/v1/workstation/actions/${leased?.seq}/result`,
        {
          outcome: "needs_approval",
          approval: { summary: "Envoyer le message", recipients: [recipient], preview: "bonjour" },
        },
        { headers },
      );
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      return reply.json.action;
    };
    const own = await send(ACME, "Moi@Acme.exemple");
    assert.deepEqual([own.state, own.approved, own.approval?.decidedBy], ["queued", true, "soi"]);
    await poll(api, ACME);
    assert.equal(
      (await send(ACME, "moi@perso.exemple")).state,
      "awaiting_approval",
      "l'identité globale ne vaut pas ici",
    );
    const free = await send(PERSO, "moi@perso.exemple");
    assert.deepEqual([free.state, free.approval?.decidedBy], ["queued", "soi"]);
    await poll(api, PERSO);
    assert.equal((await send(PERSO, "moi@acme.exemple")).state, "awaiting_approval", "ni celle d'un espace ailleurs");
    // Un espace sans identité : rien n'y est « à soi ».
    assert.equal((await edit({ identities: [] })).status, 200);
    assert.equal((await send(ACME, "moi@acme.exemple")).state, "awaiting_approval");

    await edit({ identities: ["moi@acme.exemple"] });
    const scoped = (await api.call<WorkstationStatus>("GET", `/v1/workstation?space=${acme}`)).json;
    assert.deepEqual([scoped.selfIdentities, scoped.pending], [["moi@acme.exemple"], 2]);
    const whole = (await api.call<WorkstationStatus>("GET", "/v1/workstation")).json;
    assert.deepEqual([whole.selfIdentities, whole.pending], [["moi@perso.exemple"], 3]);
    const bounded = await api.call<{ spaces: Space[] }>("GET", "/v1/spaces", undefined, { token: api.tokens.demo });
    assert.deepEqual(
      bounded.json.spaces.map((entry) => [entry.name, entry.identities, entry.poste]),
      [["Acme", [], false]],
      "un client borné ne lit ni les identités ni le poste",
    );
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-9 : `poste` d'un espace est dérivé — vrai dès qu'un navigateur lui est rattaché, faux sinon, quoi que dise `PUT` ; retirer l'espace rend ses navigateurs hors espace et emporte son profil", async () => {
  const { world, api } = await setup();
  try {
    await online(world, api, ACME);
    const acme = await space(api, "Acme");
    const owner = { token: api.tokens.owner };
    const posteOf = async (): Promise<boolean | undefined> =>
      (await api.call<{ spaces: Space[] }>("GET", "/v1/spaces", undefined, owner)).json.spaces.find(
        (entry) => entry.id === acme,
      )?.poste;
    assert.equal(await posteOf(), false);
    const forced = await api.call<{ space: Space }>("PUT", `/v1/spaces/${acme}`, { poste: true }, owner);
    assert.deepEqual([forced.status, forced.json.space.poste], [200, false], "le champ donné est ignoré");
    assert.equal(await posteOf(), false);
    await attach(api, "b-acme", acme);
    assert.equal(await posteOf(), true);
    assert.equal(
      (await api.call<{ space: Space }>("PUT", `/v1/spaces/${acme}`, { poste: false }, owner)).json.space.poste,
      true,
    );
    await attach(api, "b-acme", null);
    assert.equal(await posteOf(), false);

    await attach(api, "b-acme", acme);
    world.store.addWorkstationProfile(profile("profil Acme"), acme);
    assert.equal((await api.call("DELETE", `/v1/spaces/${acme}`, undefined, owner)).status, 200);
    const status = (await api.call<WorkstationStatus>("GET", "/v1/workstation")).json;
    assert.deepEqual(
      status.browsers.map((browser) => [browser.id, browser.space]),
      [["b-acme", null]],
    );
    assert.equal(world.store.latestWorkstationProfile(acme), null);
    assert.deepEqual(world.store.eventsOfType("workstation_browser").at(-1)?.payload, {
      id: "b-acme",
      label: "Acme",
      space: null,
    });
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-10 : le service 24/24 tourne dans l'espace du navigateur par défaut — son profil, son journal, sa mémoire, ses actions épinglées à ce navigateur — sans rien lire d'un autre navigateur", async () => {
  const { world, api } = await setup({
    "poste-service": [
      [
        spend(0.05),
        { tool: "workstation_act", args: { kind: "tabs", params: {}, rationale: "voir ce qui est ouvert" } },
      ],
    ],
  });
  try {
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "act" });
    await online(world, api, ACME, PERSO);
    const acme = await space(api, "Acme");
    await attach(api, "b-acme", acme);
    world.store.addWorkstationProfile(profile("PROFIL-HORS-ESPACE"));
    world.store.addWorkstationProfile(profile("PROFIL-ACME"), acme);
    await visit(api, ACME, "https://crm.acme.exemple/deals", "Affaires Acme");
    await visit(api, PERSO, "https://perso.exemple.fr/blog", "Blog perso");
    await deposit(api, {
      kind: "decision",
      params: { summary: "note perso" },
      rationale: "JOURNAL-PERSO",
      browserId: "b-perso",
    });
    await deposit(
      api,
      { kind: "decision", params: { summary: "note Acme" }, rationale: "JOURNAL-ACME", browserId: "b-acme" },
      `?space=${acme}`,
    );
    await world.orchestrator.start();
    const leased = await poll(api, ACME, 25);
    assert.deepEqual([leased?.kind, leased?.origin, leased?.browserId], ["tabs", "agent", "b-acme"]);
    await api.call(
      "POST",
      `/v1/workstation/actions/${leased?.seq}/result`,
      { outcome: "done", result: { text: "1 · CRM" } },
      { headers: ACME },
    );
    await waitFor(
      () => world.store.lastWorkstationShift() !== null,
      () => JSON.stringify(world.log().slice(-3)),
    );
    const [prompt] = prompts(world, "poste-service");
    assert.match(String(prompt), /PROFIL-ACME/);
    assert.match(String(prompt), /JOURNAL-ACME/);
    assert.match(String(prompt), /crm\.acme\.exemple/);
    assert.doesNotMatch(String(prompt), /PROFIL-HORS-ESPACE|JOURNAL-PERSO|perso\.exemple\.fr/);
    assert.deepEqual(launches(world), [{ cwd: `_poste-${acme}`, scope: `workstation:${acme}` }]);
    assert.deepEqual(
      world.store
        .usageSince(0)
        .filter((row) => row.step === "poste-service")
        .map((row) => [row.cost, row.spaceId]),
      [[0.05, acme]],
    );
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-11 : rien ne passe d'un espace à l'autre par les à-côtés — le dossier d'envoi est celui de l'espace du navigateur, un hôte vu chez un client n'est pas « déjà vu » ailleurs, le mirroir de session ne copie pas d'un espace vers un autre", async () => {
  const { world, api } = await setup();
  try {
    await api.call("PUT", "/v1/workstation/settings", { autonomy: "act" });
    await online(world, api, PERSO, ACME);
    const acme = await space(api, "Acme");
    await attach(api, "b-acme", acme);
    const workstation = world.orchestrator.workstation;

    // Le dossier d'envoi : un fichier écrit par un job de l'espace ne se joint que dans son navigateur.
    assert.equal(path.basename(posteDir(world.config, acme)), `_poste-${acme}`);
    fs.mkdirSync(uploadDir(world.config, acme), { recursive: true });
    fs.writeFileSync(path.join(uploadDir(world.config, acme), "devis.pdf"), "%PDF-1.7 devis Acme");
    const upload = (browserId: string, query = "") =>
      api.call<{ action: WorkstationAction; error?: string }>("POST", `/v1/workstation/actions${query}`, {
        kind: "upload",
        params: { tabId: 1, ref: "e1", file: "devis.pdf" },
        rationale: "joindre le devis",
        browserId,
      });
    assert.equal((await upload("b-acme", `?space=${acme}`)).status, 201);
    const leaked = await upload("b-perso");
    assert.equal(leaked.status, 400);
    assert.match(String(leaked.json.error), /absent du dossier d'envoi/);

    // La garde anti-exfiltration de l'agent : « déjà vu » se juge dans l'espace du navigateur.
    await visit(api, ACME, "https://crm.acme.exemple/deals", "Affaires Acme");
    const open = (browserId: string) =>
      workstation.createAction(
        { kind: "open", params: { url: "https://crm.acme.exemple/clients" }, rationale: "ouvrir le CRM", browserId },
        "agent",
        "agent",
      );
    assert.equal(open("b-acme").state, "queued");
    const elsewhere = open("b-perso");
    assert.equal(elsewhere.state, "awaiting_approval");
    assert.match(String(elsewhere.approval?.summary), /crm\.acme\.exemple jamais vu dans l'observation/);

    // Le mirroir : la source et le navigateur `vps` doivent être dans le même espace.
    world.store.touchWorkstationBrowser({ id: "vps", label: "VPS", version: null, at: Date.now() });
    const crossed = await api.call<{ error: string }>("PUT", "/v1/workstation/settings", { mirrorBrowser: "b-acme" });
    assert.equal(crossed.status, 409);
    assert.match(crossed.json.error, /même espace/);
    assert.equal((await api.call("PUT", "/v1/workstation/settings", { mirrorBrowser: "b-perso" })).status, 200);
    assert.equal(workstation.mirrorSource(), "b-perso");
    await attach(api, "vps", acme);
    assert.equal(workstation.mirrorSource(), null, "la copie est suspendue dès que les espaces diffèrent");
    assert.equal((await api.call("PUT", "/v1/workstation/settings", { mirrorBrowser: "b-acme" })).status, 200);
    assert.equal(workstation.mirrorSource(), "b-acme");
    assert.equal((await api.call<WorkstationStatus>("GET", "/v1/workstation")).json.mirrorBrowser, "b-acme");
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-12 : SANS espace, rien ne change — forme des demandes et des événements, navigateur par défaut, répertoire de travail `_poste`, portée `workstation`, profil unique sur toutes les observations, consommation hors espace", async () => {
  const { world, api } = await setup({
    "poste-profil": [[{ tool: "workstation_profile_write", args: profile("profil synthétisé") }]],
    "poste-demande": [
      [
        spend(0.07),
        { tool: "workstation_act", args: { kind: "tabs", params: {}, rationale: "voir les onglets" } },
        { tool: "workstation_request_report", args: { report: "fait" } },
      ],
    ],
  });
  try {
    await online(world, api, PERSO, ACME);
    await api.call("PUT", "/v1/workstation/settings", { selfIdentities: ["moi@perso.exemple"] });
    await visit(api, PERSO, "https://perso.exemple.fr/blog", "Blog perso");
    await visit(api, ACME, "https://crm.acme.exemple/deals", "Affaires Acme");
    const status = (await api.call<WorkstationStatus>("GET", "/v1/workstation")).json;
    assert.deepEqual(
      status.browsers.map((browser) => [browser.id, browser.space, browser.isDefault]),
      [
        ["b-perso", null, true],
        ["b-acme", null, false],
      ],
    );
    assert.deepEqual([status.observedSeconds, status.selfIdentities], [120, ["moi@perso.exemple"]]);

    const posted = await api.call<{ request: WorkstationRequest }>("POST", "/v1/workstation/requests", {
      instruction: "ranger mes favoris",
    });
    assert.deepEqual(Object.keys(posted.json.request).sort(), [
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
    assert.equal(posted.json.request.browserId, null, "le navigateur par défaut, résolu au départ");
    await world.orchestrator.start();
    const leased = await poll(api, PERSO, 25);
    assert.equal(leased?.browserId, "b-perso");
    await api.call(
      "POST",
      `/v1/workstation/actions/${leased?.seq}/result`,
      { outcome: "done", result: { text: "1 · Favoris" } },
      { headers: PERSO },
    );
    await until(world, posted.json.request.id, "done");
    assert.deepEqual(
      world.store.eventsOfType("workstation_request").map((event) => event.payload),
      [
        { id: posted.json.request.id, state: "queued", reason: null },
        { id: posted.json.request.id, state: "running", reason: null },
        { id: posted.json.request.id, state: "done", reason: null },
      ],
    );
    assert.doesNotMatch(String(prompts(world, "poste-demande")[0]), /## Espace/);
    assert.deepEqual(
      world.store
        .usageSince(0)
        .filter((row) => row.step === "poste-demande")
        .map((row) => [row.cost, row.spaceId]),
      [[0.07, null]],
    );

    await api.call("POST", "/v1/workstation/profile/rebuild");
    await waitFor(
      () => world.store.latestWorkstationProfile()?.version === 1,
      () => JSON.stringify(world.log().slice(-3)),
    );
    const [prompt] = prompts(world, "poste-profil");
    assert.match(String(prompt), /perso\.exemple\.fr/);
    assert.match(String(prompt), /crm\.acme\.exemple/, "tous les navigateurs, comme avant");
    assert.deepEqual(
      world.store.eventsOfType("workstation_profile").map((event) => event.payload),
      [{ version: 1 }],
    );
    assert.deepEqual(launches(world), [
      { cwd: "_poste", scope: WORKSTATION_SCOPE },
      { cwd: "_poste", scope: WORKSTATION_SCOPE },
    ]);
    const target = workstationTarget(world.config);
    assert.deepEqual([path.basename(target.cwd), target.repo.scope], ["_poste", "workstation"]);
    assert.equal(uploadDir(world.config), path.join(target.cwd, "envois"));
    const view = (await api.call<{ stats: ProfileStats }>("GET", "/v1/workstation/profile")).json;
    assert.deepEqual(
      [view.stats.topSites.map((site) => site.host).sort(), view.stats.observedSeconds],
      [["crm.acme.exemple", "perso.exemple.fr"], 120],
    );
  } finally {
    await teardown(world, api);
  }
});

test("mc-poste/AC-13 : la route de rattachement est servie par apiRoutes() et décrite dans le README du harness, comme `?space=` sur les lectures du poste, et la capacité `space-workstation` est annoncée", () => {
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
  assert.ok(routes.some((route) => route.method === "PUT" && route.path === "/v1/workstation/browsers/{id}"));
  assert.ok(readme.includes("`PUT /v1/workstation/browsers/{id}`"), "la route est absente du README");
  for (const read of [
    "GET /v1/workstation?space=",
    "GET /v1/workstation/observations?since=&limit=&space=",
    "GET /v1/workstation/actions?state=a,b&limit=&before=&space=",
    "GET /v1/workstation/meetings?limit=&space=",
    "GET /v1/workstation/requests?state=a,b&limit=&space=",
    "GET /v1/workstation/automations?space=",
    "GET /v1/workstation/profile?space=",
  ])
    assert.ok(readme.includes(`\`${read}`), `${read} absente du README`);
  for (const word of ["`space-workstation`", "`workstation:<espace>`", "workstation/_poste-<espace>`", "`identities`"])
    assert.ok(readme.includes(word), `${word} absent du README`);
  assert.ok((API_FEATURES as readonly string[]).includes("space-workstation"));
});

test("mc-poste/AC-14 : le digest d'un meeting tourne dans l'espace du navigateur d'où il vient ; un navigateur qui change d'espace laisse closes les actions pas encore parties de la demande de son ancien espace", async () => {
  const { world, api } = await setup({
    "poste-digest": [
      [spend(0.03), { tool: "workstation_meeting_digest", args: { summary: "Acme veut un export.", needs: [] } }],
    ],
  });
  try {
    await online(world, api, PERSO, ACME);
    const acme = await space(api, "Acme");
    await attach(api, "b-acme", acme);
    await world.orchestrator.start();
    const created = await api.call<{ meeting: Meeting }>(
      "POST",
      "/v1/workstation/meetings",
      { title: "Point Acme", url: "https://meet.exemple.fr/abc", startedAt: Date.now() },
      { headers: ACME },
    );
    const { id } = created.json.meeting;
    await api.call(
      "POST",
      `/v1/workstation/meetings/${id}/segments`,
      { segments: [{ at: Date.now(), speaker: "autres", text: "Il nous faut l'export" }] },
      { headers: ACME },
    );
    await api.call("POST", `/v1/workstation/meetings/${id}/end`, undefined, { headers: ACME });
    await waitFor(
      () => world.store.getWorkstationMeeting(id)?.state === "digested",
      () => JSON.stringify(world.log().slice(-3)),
    );
    assert.deepEqual(launches(world), [{ cwd: `_poste-${acme}`, scope: `workstation:${acme}` }]);
    assert.deepEqual(
      world.store
        .usageSince(0)
        .filter((row) => row.step === "poste-digest")
        .map((row) => [row.cost, row.spaceId]),
      [[0.03, acme]],
    );

    // Une demande d'Acme en cours, une action en file pour son navigateur : il est détaché, elle ne part plus.
    const workstation = world.orchestrator.workstation;
    const request = workstation.createRequest({ instruction: "pour Acme", space: acme }, { by: "app-approbateur" });
    workstation.startRequest(request.id);
    const pending = workstation.createAction(
      { kind: "tabs", params: {}, rationale: "onglets" },
      "agent",
      "agent",
      request.id,
    );
    assert.deepEqual([pending.state, pending.browserId], ["queued", "b-acme"]);
    await attach(api, "b-acme", null);
    const closed = world.store.getWorkstationAction(pending.seq);
    assert.deepEqual([closed?.state, closed?.error], ["failed", REQUEST_OUT_OF_SPACE]);
    assert.equal(await poll(api, ACME), null, "le navigateur détaché ne loue rien de l'ancien espace");
  } finally {
    await teardown(world, api);
  }
});
