// Tranche « multi-client » M1 — la portée d'un espace : `?space=` borne toutes les lectures et le flux,
// une Demande se pose DANS un espace, un client d'API se borne à des espaces, un espace se suspend seul,
// sa consommation se relève et s'exporte pour la facturation, et une cible de notification se borne à lui.
// Sans aucun espace, le serveur se comporte comme avant.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { loadConfig, repoDefaults } from "../../omp-harness/config.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import type { EventRow, RunPatch, RunRow, Space, Store, UsageRow } from "../../omp-harness/db.ts";
import { DigestSender } from "../../omp-harness/digest.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { interpretClassification } from "../../omp-harness/intake.ts";
import { clientCommand } from "../../omp-harness/main.ts";
import { MCP_TOOLS } from "../../omp-harness/mcp.ts";
import { Notifier } from "../../omp-harness/notify.ts";
import type { DreamDossier } from "../../omp-harness/oracle.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import { workstationOwner } from "../../omp-harness/session-feed.ts";
import { USAGE_CSV_HEADER, spaceUsageOf, usageCsv, usageKind } from "../../omp-harness/space-usage.ts";
import { spaceInput } from "../../omp-harness/spaces.ts";
import { autonomyDecisions, bugWorld, eventsOf, until } from "../support/autonomie-fixtures.ts";
import { escalationArgs, readFrames } from "../support/card-fixtures.ts";
import { OK, fakeWorld, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);
const DAY = 24 * 60 * 60 * 1000;
const SLEEP = [{ sleep: 60_000 }];
const OPS = { by: "ops" };

type Json = Record<string, unknown>;
type Reply = { status: number; json: Json; text: string; type: string | null };
type Tokens = { owner: string; ops: string; viewer: string; demo: string; third: string; pilot: string };

const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
/** Les valeurs de `key` d'une liste d'objets, triées : de quoi comparer deux lectures sans égard à l'ordre. */
const idsOf = (value: unknown, key = "id"): string[] =>
  list(value)
    .map((item) => String(item[key]))
    .sort();

/** Les dépôts `other` et `third` en plus de `demo` : de quoi faire deux espaces. */
function threeRepos(config: HarnessConfig): void {
  config.repos.push(repoDefaults({ name: "other", path: harnessRepo(), scope: "other-scope" }));
  config.repos.push(repoDefaults({ name: "third", path: harnessRepo(), scope: "third-scope" }));
}

/** Le monde : trois dépôts, un serveur HTTP réel, un client de chaque portée et de quoi créer un espace. */
async function setup(scenario: Json = {}, patch: (config: HarnessConfig) => void = () => {}) {
  const world = fakeWorld(scenario, {
    patch: (config) => {
      threeRepos(config);
      patch(config);
    },
  });
  const clientsFile = path.join(tmpdir("mc-portee-clients-"), "clients.json");
  const clients = new ClientRegistry(clientsFile, ADMIN);
  const tokens: Tokens = {
    owner: clients.add("mac", "admin", "*").token,
    ops: clients.add("ops", "operator", "*").token,
    viewer: clients.add("ipad", "viewer", "*").token,
    demo: clients.add("mac-demo", "operator", ["demo"]).token,
    third: clients.add("mac-third", "operator", ["third"]).token,
    pilot: clients.add("vigie", "operator", "*", false, true).token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients, log: () => {} }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, route: string, body?: unknown, token = tokens.owner): Promise<Reply> => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const type = response.headers.get("content-type");
    return {
      status: response.status,
      text,
      type,
      json: type?.startsWith("application/json") && text !== "" ? (JSON.parse(text) as Json) : {},
    };
  };
  /** Un outil du serveur MCP : son résultat, ou le texte de son erreur. */
  const tool = async (
    name: string,
    args: Json = {},
    token = tokens.owner,
    query = "",
  ): Promise<{ error: string | null; data: Json }> => {
    const message = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
    const reply = await call("POST", `/v1/mcp${query}`, message, token);
    const result = reply.json.result as { isError?: boolean; structuredContent?: Json; content: { text: string }[] };
    return result.isError
      ? { error: result.content[0]?.text ?? "", data: {} }
      : { error: null, data: result.structuredContent ?? {} };
  };
  const space = (name: string, repos: string[], extra: Json = {}): Space =>
    world.orchestrator.spaces.create(spaceInput({ name, repos, ...extra }), { by: "mac" });
  const done = async (): Promise<void> => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    await world.orchestrator.stop();
  };
  return { world, tokens, clients, clientsFile, url, call, tool, space, done };
}

/** Un run posé en base dans son état, sans pipeline. */
function seed(store: Store, id: string, repo: string, title: string, patch: RunPatch | null = null): RunRow {
  const run = store.createRun({ id, repo, slug: id, title, request: `Demande : ${title}`, branch: `harness/${id}` });
  return patch === null ? run : (store.updateRun(id, patch) as RunRow);
}

const stateOf = (world: FakeWorld, runId: string): string => {
  const run = world.store.getRun(runId);
  return `${run?.state} (${run?.step}) — ${run?.reason}`;
};

/** Ce qui retient un run en file, tel que l'API le dit. */
function waitOf(orchestrator: Orchestrator, world: FakeWorld, runId: string) {
  const run = world.store.getRun(runId);
  assert.ok(run, `run ${runId} introuvable`);
  return orchestrator.withWait(run);
}

async function ticks(orchestrator: Orchestrator): Promise<void> {
  await orchestrator.tick();
  await orchestrator.tick();
}

/** La fin d'un message d'agent qui porte sa consommation : ce que le faux runner émet pour un coût. */
function usageFrame(cost: number, input = 10, output = 5) {
  const usage = { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } };
  return {
    frame: {
      type: "message_end",
      message: { role: "assistant", provider: "local", model: "qwen", content: [], usage },
    },
  };
}

/** Une consommation écrite en base, à l'instant `at` si on le donne (sinon maintenant). */
function spend(store: Store, row: Partial<Omit<UsageRow, "at">> & { cost: number }, at?: number): void {
  store.addUsage({
    runId: null,
    auditId: null,
    repo: null,
    step: "impl",
    provider: "anthropic",
    model: "sonnet",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...row,
  });
  if (at !== undefined) store.db.prepare("UPDATE usage SET at = ? WHERE id = (SELECT MAX(id) FROM usage)").run(at);
}

/**
 * Attend, s'il le faut, que minuit UTC soit passé : une dépense et la lecture de son « coût du jour »
 * tombent alors le même jour (les routes lisent l'horloge du serveur, qu'un test ne règle pas).
 */
async function clearOfMidnight(marginMs: number): Promise<void> {
  const left = DAY - (Date.now() % DAY);
  if (left >= marginMs) return;
  const passed = Promise.withResolvers<void>();
  setTimeout(passed.resolve, left + 50);
  await passed.promise;
}

/**
 * Lit le flux `GET /v1/events` jusqu'à `enough(événements reçus)`, puis le ferme. `opened` est appelé dès
 * que le flux répond : le serveur s'y est abonné avant d'envoyer ses en-têtes, ce qui s'écrit alors
 * arrive au direct.
 */
async function stream(
  url: string,
  token: string,
  query: string,
  enough: (events: EventRow[]) => boolean,
  opened: () => void = () => {},
): Promise<EventRow[]> {
  const controller = new AbortController();
  const response = await fetch(`${url}/v1/events${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  opened();
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let text = "";
  // Seules les trames entières (closes par une ligne vide) se lisent.
  const received = (): EventRow[] =>
    [...text.slice(0, text.lastIndexOf("\n\n") + 2).matchAll(/^data: (.*)$/gm)].map(
      (match) => JSON.parse(match[1] as string) as EventRow,
    );
  try {
    while (!enough(received())) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    return received();
  } finally {
    controller.abort();
  }
}

test("mc-portee/AC-1 : `?space=` — par identifiant ou par nom — borne les runs, la boîte, le brief, les chiffres, les propositions, les dépôts et l'état aux dépôts de l'espace ; un run d'ailleurs y est un 404 ; les outils MCP de lecture prennent `space`, de même effet", async () => {
  const { world, call, tool, space, done } = await setup();
  try {
    const acme = space("Acme", ["demo", "other"], { dailyBudgetUsd: 20 });
    const exemple = space("Exemple", ["third"]);
    seed(world.store, "rd-wait", "demo", "Export CSV", { state: "awaiting_human", step: "review" });
    seed(world.store, "rd-fail", "demo", "Import PDF", { state: "failed", step: "impl", reason: "/impl a échoué" });
    seed(world.store, "ro-merged", "other", "Page d'accueil", { state: "merged", mergeSha: "a".repeat(40) });
    seed(world.store, "rt-wait", "third", "Tableau de bord", { state: "awaiting_human", step: "review" });
    seed(world.store, "rt-fail", "third", "Recherche", { state: "failed", step: "impl", reason: "/impl a échoué" });

    const runs = async (query: string): Promise<string[]> => idsOf((await call("GET", `/v1/runs${query}`)).json.runs);
    assert.deepEqual(await runs(""), ["rd-fail", "rd-wait", "ro-merged", "rt-fail", "rt-wait"]);
    assert.deepEqual(await runs(`?space=${acme.id}`), ["rd-fail", "rd-wait", "ro-merged"]);
    assert.deepEqual(await runs("?space=exemple"), ["rt-fail", "rt-wait"], "par son nom, sans égard à la casse");
    assert.deepEqual(await runs(`?space=${acme.id}&state=failed`), ["rd-fail"]);

    // Un run d'un autre espace n'existe pas sous `?space=` : ni lu, ni touché.
    assert.equal((await call("GET", `/v1/runs/rd-wait?space=${acme.id}`)).status, 200);
    assert.equal((await call("GET", `/v1/runs/rd-wait?space=${exemple.id}`)).status, 404);
    assert.equal((await call("POST", `/v1/runs/rd-wait/cancel?space=${exemple.id}`, {})).status, 404);
    assert.equal(world.store.getRun("rd-wait")?.state, "awaiting_human");

    const inbox = (await call("GET", "/v1/inbox?space=Exemple")).json;
    assert.deepEqual([idsOf(inbox.awaiting), idsOf(inbox.runs)], [["rt-wait"], ["rt-wait"]]);
    const brief = (await call("GET", `/v1/brief?space=${acme.id}&since=0`)).json.brief as Json;
    assert.deepEqual(
      [idsOf(brief.failed, "runId"), idsOf(brief.delivered, "runId"), brief.proposals],
      [["rd-fail"], ["ro-merged"], 1],
    );
    const board = (await call("GET", "/v1/scoreboard?space=Exemple")).json.scoreboard as Json;
    assert.deepEqual(
      idsOf(board.repos, "repo").filter((repo) => repo !== "third"),
      [],
      "aucun dépôt hors de l'espace",
    );
    const proposals = async (query: string): Promise<Json[]> =>
      list((await call("GET", `/v1/proposals${query}`)).json.proposals);
    assert.deepEqual(idsOf(await proposals(""), "repo"), ["demo", "third"]);
    assert.deepEqual(idsOf(await proposals("?space=Exemple"), "repo"), ["third"]);
    assert.deepEqual(idsOf((await call("GET", `/v1/repos?space=${acme.id}`)).json.repos, "name"), ["demo", "other"]);
    assert.deepEqual(idsOf((await call("GET", "/v1/status?space=Exemple")).json.repos, "name"), ["third"]);

    // Les espaces se lisent avec les droits du client : le propriétaire voit l'espace entier, le seul demandé.
    const spaces = list((await call("GET", `/v1/spaces?space=${acme.id}`)).json.spaces);
    assert.deepEqual(
      spaces.map((entry) => [entry.id, entry.repos, entry.dailyBudgetUsd]),
      [[acme.id, ["demo", "other"], 20]],
    );

    // Les outils MCP de lecture : l'argument `space`, ou `?space=` sur la requête du lot.
    assert.deepEqual(idsOf((await tool("runs_list", { space: "Exemple" })).data.runs), ["rt-fail", "rt-wait"]);
    assert.deepEqual(idsOf((await tool("inbox", { space: acme.id })).data.awaiting), ["rd-wait"]);
    assert.deepEqual(idsOf((await tool("proposals", { space: "exemple" })).data.proposals, "repo"), ["third"]);
    assert.deepEqual(idsOf((await tool("spaces", { space: "Exemple" })).data.spaces), [exemple.id]);
    const batch = await tool("runs_list", {}, undefined, `?space=${exemple.id}`);
    assert.deepEqual(idsOf(batch.data.runs), ["rt-fail", "rt-wait"]);
    const listed = await call("POST", "/v1/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const schemas = (listed.json.result as { tools: { name: string; inputSchema: { properties: Json } }[] }).tools;
    for (const name of [
      "runs_list",
      "inbox",
      "escalations_list",
      "digest",
      "brief",
      "scoreboard",
      "spaces",
      "schedules_list",
      "proposals",
      "rules",
    ])
      assert.ok("space" in (schemas.find((entry) => entry.name === name)?.inputSchema.properties ?? {}), name);
    const gesture = schemas.find((entry) => entry.name === "run_cancel")?.inputSchema.properties ?? {};
    assert.equal("space" in gesture, false, "un geste ne prend pas de portée");
  } finally {
    await done();
  }
});

test("mc-portee/AC-2 : un espace inconnu, ou dont le client ne voit aucun dépôt, est un 404 sur toute route et sur le flux — jamais un 403, son existence n'est pas révélée ; un client borné qui voit l'espace n'y lit que ses dépôts", async () => {
  const { world, tokens, url, call, tool, space, done } = await setup();
  try {
    const acme = space("Acme", ["demo", "other"], { dailyBudgetUsd: 20 });
    const exemple = space("Exemple", ["third"]);
    seed(world.store, "rd", "demo", "Export CSV");
    seed(world.store, "ro", "other", "Page d'accueil");
    seed(world.store, "rt", "third", "Recherche");

    const routes = [
      "/v1/runs",
      "/v1/inbox",
      "/v1/brief",
      "/v1/scoreboard",
      "/v1/proposals",
      "/v1/intake",
      "/v1/spaces",
      "/v1/pause",
      "/v1/status",
      "/v1/digest",
      "/v1/rules",
      "/v1/autonomy",
      "/v1/route-inconnue",
    ];
    for (const route of routes) {
      const unknown = await call("GET", `${route}?space=nulle-part`);
      assert.deepEqual([unknown.status, unknown.json.error], [404, "espace inconnu : nulle-part"], route);
      // Le client borné à `demo` ne voit aucun dépôt d'Exemple : la même réponse que pour un espace qui n'existe pas.
      const hidden = await call("GET", `${route}?space=${exemple.id}`, undefined, tokens.demo);
      assert.deepEqual([hidden.status, hidden.json.error], [404, `espace inconnu : ${exemple.id}`], route);
      const byName = await call("GET", `${route}?space=Exemple`, undefined, tokens.demo);
      assert.equal(byName.status, 404, route);
    }
    assert.equal((await call("GET", "/v1/runs?space=")).status, 404, "un `space` vide ne désigne rien");
    const flux = await fetch(`${url}/v1/events?space=${exemple.id}`, {
      headers: { Authorization: `Bearer ${tokens.demo}` },
    });
    assert.equal(flux.status, 404);
    await flux.body?.cancel();

    // Un client borné qui voit un dépôt de l'espace : l'intersection, et l'espace réduit à ce dépôt.
    const mine = await call("GET", `/v1/runs?space=${acme.id}`, undefined, tokens.demo);
    assert.deepEqual(idsOf(mine.json.runs), ["rd"]);
    const [reduced] = list((await call("GET", "/v1/spaces?space=Acme", undefined, tokens.demo)).json.spaces);
    assert.deepEqual([reduced?.repos, reduced?.dailyBudgetUsd], [["demo"], null]);

    assert.match((await tool("inbox", { space: "nulle-part" })).error ?? "", /espace inconnu : nulle-part/);
    assert.match((await tool("inbox", { space: exemple.id }, tokens.demo)).error ?? "", /espace inconnu/);
    assert.equal((await tool("inbox", { space: acme.id }, tokens.demo)).error, null);
  } finally {
    await done();
  }
});

test("mc-portee/AC-3 : le propriétaire reste propriétaire sous `?space=` — poste, signalements, sessions locales, configuration, administration — et un client borné ou pilote y reste refusé ; une création sous `?space=` dans un dépôt hors de l'espace est un 400 et ne crée rien", async () => {
  const { world, tokens, call, tool, space, done } = await setup();
  try {
    const acme = space("Acme", ["demo", "other"]);
    space("Exemple", ["third"]);
    const session = (id: string, repo: string) => ({ id, host: "mac", cwd: `/tmp/${repo}`, title: id, state: "idle" });
    assert.equal((await call("POST", "/v1/local-sessions", session("s-demo", "demo"))).status, 200);
    assert.equal((await call("POST", "/v1/local-sessions", session("s-third", "third"))).status, 200);

    // Les routes du propriétaire répondent toujours ; sans dépôt, elles ne rendent que ce qui se rattache à l'espace.
    const sessions = async (query: string): Promise<string[]> =>
      idsOf((await call("GET", `/v1/local-sessions${query}`)).json.sessions);
    assert.deepEqual(await sessions(""), ["s-demo", "s-third"]);
    assert.deepEqual(await sessions(`?space=${acme.id}`), ["s-demo"]);
    assert.deepEqual(await sessions("?space=Exemple"), ["s-third"]);
    const signals = await call("GET", `/v1/signals?space=${acme.id}`);
    assert.deepEqual([signals.status, signals.json.signals], [200, []]);
    assert.equal((await call("GET", `/metrics?space=${acme.id}`)).status, 200);
    const reload = await call("POST", `/v1/reload?space=${acme.id}`);
    assert.equal(reload.status, 409, "la configuration lui reste ouverte : seul `--config` manque");
    const created = await call("POST", `/v1/spaces?space=${acme.id}`, { name: "Zéta" });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal((await call("POST", `/v1/pause?space=${acme.id}`, { paused: false })).status, 200);

    // Un client borné ou un pilote n'est pas plus propriétaire avec `?space=` que sans.
    for (const token of [tokens.demo, tokens.pilot]) {
      assert.equal((await call("GET", `/v1/local-sessions?space=${acme.id}`, undefined, token)).status, 403);
      assert.equal((await call("GET", `/v1/signals?space=${acme.id}`, undefined, token)).status, 403);
    }
    assert.equal((await call("GET", `/metrics?space=${acme.id}`, undefined, tokens.demo)).status, 403);

    // Créer sous `?space=` : seulement dans un dépôt de l'espace.
    const before = world.store.listRuns({}).length;
    const feature = { title: "Export CSV", request: "Ajouter l'export" };
    const refused: [string, Json][] = [
      ["/v1/runs", { repo: "demo", ...feature }],
      ["/v1/projects", { repo: "demo", title: "Projet", features: [feature] }],
      ["/v1/audits", { repo: "demo" }],
      ["/v1/schedules", { name: "Chaque matin", cron: "0 8 * * *", target: { kind: "audit", repo: "demo" } }],
      ["/v1/dreams", { repo: "demo" }],
    ];
    for (const [route, body] of refused) {
      const reply = await call("POST", `${route}?space=Exemple`, body);
      assert.equal(reply.status, 400, route);
      assert.match(String(reply.json.error), /le dépôt demo n'est pas dans l'espace « Exemple »/, route);
    }
    const viaTool = await tool("run_start", { repo: "demo", ...feature }, undefined, "?space=Exemple");
    assert.match(viaTool.error ?? "", /n'est pas dans l'espace « Exemple »/);
    assert.deepEqual(
      [world.store.listRuns({}).length, world.store.listAudits([], null).length, world.store.listProjects().length],
      [before, 0, 0],
    );
    const inside = await call("POST", "/v1/runs?space=Exemple", { repo: "third", ...feature });
    assert.equal(inside.status, 201, JSON.stringify(inside.json));
    // Un dépôt que le client ne voit pas reste un 403, avec ou sans espace.
    const blind = await call("POST", `/v1/runs?space=${acme.id}`, { repo: "other", ...feature }, tokens.demo);
    assert.equal(blind.status, 403);
    // Sans `?space=`, rien n'a changé.
    assert.equal((await call("POST", "/v1/runs", { repo: "demo", ...feature })).status, 201);
  } finally {
    await done();
  }
});

test("mc-portee/AC-4 : le flux `GET /v1/events?space=` ne porte que les événements des dépôts de l'espace — au rejeu comme au direct — et, pour le propriétaire, ce qui parle de l'espace sans dépôt : sa pause, ses changements, ses Demandes ; jamais ceux d'un autre espace ni de tout le serveur", async () => {
  const { world, tokens, url, call, space, done } = await setup();
  try {
    const { orchestrator } = world;
    const acme = space("Acme", ["demo", "other"]);
    const exemple = space("Exemple", ["third"]);
    const feature = { title: "Export CSV", request: "Ajouter l'export", modules: ["src"] };
    const mine = orchestrator.createRun({ repo: "demo", ...feature });
    const theirs = orchestrator.createRun({ repo: "third", ...feature });
    orchestrator.setPause(true, "congés", OPS, null, false, acme.id);
    orchestrator.setPause(true, "", OPS, null, false, exemple.id);
    orchestrator.setPause(true, "", OPS);
    orchestrator.setPause(false, "", OPS);
    const post = async (body: Json): Promise<string> =>
      String(((await call("POST", "/v1/intake", { source: "cli", ...body })).json.intake as Json).id);
    const inAcme = await post({ text: "dans Acme", space: acme.id });
    const inExemple = await post({ text: "dans Exemple", space: exemple.id });
    const nowhere = await post({ text: "hors espace" });
    // Un tour : la Demande d'un espace en pause attend, et le dit une fois (son second `intake_state`).
    await orchestrator.tick();
    const last = orchestrator.createRun({ repo: "other", ...feature });

    const seen = (events: EventRow[]): boolean => events.some((event) => event.runId === last.id);
    const replayed = await stream(url, tokens.owner, `?space=${acme.id}&after=0`, seen);
    assert.ok(replayed.length > 0);
    assert.deepEqual(
      [...new Set(replayed.map((event) => event.repo))].sort(),
      ["demo", "other", null].sort(),
      "que des dépôts de l'espace, ou ce qui parle de lui",
    );
    assert.ok(replayed.some((event) => event.runId === mine.id));
    assert.ok(!replayed.some((event) => event.runId === theirs.id));
    const orphans = replayed.filter((event) => event.repo === null);
    assert.deepEqual(
      orphans.map((event) => [event.type, event.payload.id ?? event.payload.space ?? event.payload.intakeId]),
      [
        ["space", acme.id],
        ["pause", acme.id],
        ["intake_state", inAcme],
        ["intake_state", inAcme],
      ],
    );
    assert.ok(!JSON.stringify(replayed).includes(inExemple) && !JSON.stringify(replayed).includes(nowhere));

    // Au direct, la même règle : un run de l'espace passe, celui d'un autre non.
    const cursor = world.store.lastEventId();
    let liveMine = "";
    let liveTheirs = "";
    const live = await stream(
      url,
      tokens.owner,
      `?space=Acme&after=${cursor}`,
      (events) => events.some((event) => event.runId === liveMine),
      () => {
        liveTheirs = orchestrator.createRun({ repo: "third", ...feature }).id;
        orchestrator.setPause(false, "", OPS, null, false, exemple.id);
        orchestrator.setPause(false, "", OPS, null, false, acme.id);
        liveMine = orchestrator.createRun({ repo: "demo", ...feature }).id;
      },
    );
    assert.ok(!live.some((event) => event.runId === liveTheirs));
    assert.deepEqual(
      live.filter((event) => event.type === "pause").map((event) => [event.payload.paused, event.payload.space]),
      [[false, acme.id]],
    );

    // Un client borné à `demo` qui suit Acme : ses dépôts seulement, rien de ce qui n'a pas de dépôt.
    const bounded = await stream(url, tokens.demo, `?space=${acme.id}&after=0`, (events) =>
      events.some((event) => event.runId === liveMine),
    );
    assert.deepEqual([...new Set(bounded.map((event) => event.repo))], ["demo"]);
  } finally {
    await done();
  }
});

const classify = (args: Json) => [{ tool: "intake_classify", args }];
const FEATURE = { kind: "feature", title: "Ajouter l'export CSV", statement: "Exporter les factures en CSV." };
const POSTE = { kind: "workstation_request", title: "Ranger la boîte", statement: "Range mes mails de la semaine." };

test("mc-portee/AC-5 : une Demande posée dans un espace (`space` du corps ou `?space=`) le garde et le rend ; son classeur ne choisit que parmi les dépôts de l'espace que voit l'auteur, un plan hors de l'espace est refusé au classement comme à la confirmation, une tâche du poste l'est dans un espace sans poste ; `?space=` borne la liste et la lecture ; un espace retiré depuis ne laisse rien créer", async () => {
  const scenario = {
    demande: [
      classify({ ...FEATURE, repo: "third" }),
      [usageFrame(0.03), ...classify({ ...FEATURE, repo: "other" })],
      classify(POSTE),
      [usageFrame(0.07), ...classify({ ...FEATURE, repo: "third" })],
      classify({ ...FEATURE, repo: "third" }),
      classify({ ...FEATURE, repo: "demo" }),
    ],
  };
  const { world, tokens, call, tool, space, done } = await setup(scenario);
  await world.orchestrator.start();
  try {
    const { store } = world;
    const acme = space("Acme", ["demo", "other"]);
    const exemple = space("Exemple", ["third"]);
    seed(store, "rt-secret", "third", "Secret de l'autre client", { state: "awaiting_human", step: "review" });
    const post = (body: Json, query = "", token?: string): Promise<Reply> =>
      call("POST", `/v1/intake${query}`, { source: "cli", ...body }, token);
    /** La demande posée (201), puis classée : sa vue. */
    const classified = async (body: Json, query = "", token?: string): Promise<Json> => {
      const posted = await post(body, query, token);
      assert.equal(posted.status, 201, JSON.stringify(posted.json));
      const id = String((posted.json.intake as Json).id);
      await waitFor(
        () => store.getIntake(id)?.state !== "classifying",
        () => `demande ${id} toujours en classement`,
      );
      return (await call("GET", `/v1/intake/${id}`, undefined, token)).json.intake as Json;
    };
    const demandes = () => store.usageSince(0).filter((row) => row.step === "demande");

    // 1. Le classeur vise un dépôt d'un autre espace : refusé, et il n'a rien su de cet espace.
    const outside = await classified({ text: "ajoute un export", space: "acme" });
    assert.deepEqual(outside.space, { id: acme.id, name: "Acme" });
    assert.deepEqual([outside.state, store.getIntake(String(outside.id))?.scope], ["failed", ["demo", "other"]]);
    assert.match(String(outside.reason), /le dépôt « third » est hors de la portée de l'auteur/);
    const prompt = String(
      world.log().findLast((entry) => entry.kind === "prompt" && entry.step === "demande")?.message,
    );
    assert.match(prompt, /posée dans l'espace « Acme »/);
    assert.ok(prompt.includes("demo") && prompt.includes("other"), "ses dépôts sont nommés");
    assert.ok(!prompt.includes("third") && !prompt.includes("Secret de l'autre client"), "rien d'un autre espace");
    assert.match(prompt, /n'a pas de poste de travail/);

    // 2. Un plan dans l'espace : prêt ; sa correction vers un dépôt d'ailleurs est refusée, sa confirmation crée dans l'espace.
    const inside = await classified({ text: "ajoute un export" }, `?space=${acme.id}`);
    assert.deepEqual([inside.state, (inside.plan as Json).repo, inside.space], ["planned", "other", outside.space]);
    assert.deepEqual(
      demandes().map((row) => [row.repo, row.spaceId, row.cost]),
      [[null, acme.id, 0.03]],
      "le coût du classement est imputé à l'espace",
    );
    const moved = await call("POST", `/v1/intake/${inside.id}/confirm`, { plan: { repo: "third" } });
    assert.equal(moved.status, 400);
    assert.match(String(moved.json.error), /hors de la portée/);
    const confirmed = await call("POST", `/v1/intake/${inside.id}/confirm`, {});
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
    const created = (confirmed.json.intake as Json).created as { kind: string; id: string };
    assert.deepEqual([created.kind, store.getRun(created.id)?.repo], ["run", "other"]);

    // 3. Une tâche du poste dans un espace sans poste : refusée, au classement comme à la correction.
    const desk = await classified({ text: "range mes mails", space: acme.id });
    assert.equal(desk.state, "failed");
    assert.match(String(desk.reason), /cet espace n'a pas de poste de travail/);
    const judged = (poste?: boolean) =>
      interpretClassification(POSTE, { declared: ["demo"], scope: ["demo"], requestedRepo: null, poste }).state;
    assert.deepEqual([judged(false), judged(true), judged()], ["failed", "planned", "planned"]);

    // 4. Hors espace : comme avant — aucun espace, toute la portée de l'auteur, aucune consommation relevée.
    const free = await classified({ text: "sans espace" });
    assert.deepEqual([free.state, free.space, (free.plan as Json).repo], ["planned", null, "third"]);
    assert.deepEqual([store.getIntake(String(free.id))?.scope, store.getIntake(String(free.id))?.spaceId], ["*", null]);
    assert.equal(demandes().length, 1, "hors espace, le classeur ne note rien");

    // 5. Les refus à la pose : rien n'est créé.
    const count = store.listIntakes({}).length;
    const conflict = await post({ text: "x", space: "Exemple" }, `?space=${acme.id}`);
    assert.equal(conflict.status, 400);
    const elsewhere = await post({ text: "x", space: acme.id, repo: "third" });
    assert.equal(elsewhere.status, 400);
    assert.match(String(elsewhere.json.error), /n'est pas dans l'espace « Acme »/);
    assert.equal((await post({ text: "x", space: "nulle-part" })).status, 404);
    assert.equal((await post({ text: "x", space: acme.id }, "", tokens.third)).status, 404, "espace invisible");
    assert.equal((await post({ text: "x", space: 3 })).status, 400);
    assert.equal(store.listIntakes({}).length, count);

    // 6. Un client borné dans un espace qu'il voit : la portée est l'intersection.
    const ex = await classified({ text: "pour exemple", space: "Exemple" });
    assert.deepEqual([ex.state, (ex.plan as Json).repo], ["planned", "third"]);
    const bounded = await classified({ text: "borné", space: "Acme" }, "", tokens.demo);
    assert.deepEqual(
      [bounded.state, (bounded.plan as Json).repo, store.getIntake(String(bounded.id))?.scope],
      ["planned", "demo", ["demo"]],
    );

    // 7. `?space=` borne la liste et la lecture d'une demande.
    const listed = async (query: string, token?: string): Promise<string[]> =>
      idsOf((await call("GET", `/v1/intake${query}`, undefined, token)).json.intakes);
    const ids = (...views: Json[]): string[] => views.map((view) => String(view.id)).sort();
    assert.deepEqual(await listed(""), ids(outside, inside, desk, free, ex, bounded));
    assert.deepEqual(await listed(`?space=${acme.id}`), ids(outside, inside, desk, bounded));
    assert.deepEqual(await listed("?space=Exemple"), ids(free, ex), "par son espace, ou par le dépôt de son plan");
    assert.deepEqual(await listed(`?space=${acme.id}`, tokens.demo), ids(bounded));
    assert.equal((await call("GET", `/v1/intake/${inside.id}?space=Acme`)).status, 200);
    assert.equal((await call("GET", `/v1/intake/${inside.id}?space=Exemple`)).status, 404);
    assert.equal((await call("POST", `/v1/intake/${ex.id}/cancel?space=${acme.id}`, {})).status, 404);
    assert.equal(store.getIntake(String(ex.id))?.state, "planned");

    // 8. Par MCP : l'argument `space` de l'outil `intake`.
    const viaTool = await tool("intake", { text: "via mcp", space: "Acme" });
    assert.deepEqual((viaTool.data.intake as Json).space, { id: acme.id, name: "Acme" });

    // 9. L'espace retiré depuis : rien n'est créé hors de lui, et la vue n'en dit plus rien.
    world.orchestrator.spaces.delete(exemple.id, { by: "mac" });
    const orphan = await call("POST", `/v1/intake/${ex.id}/confirm`, {});
    assert.equal(orphan.status, 409);
    assert.match(String(orphan.json.error), /l'espace de cette demande n'existe plus/);
    const after = (await call("GET", `/v1/intake/${ex.id}`)).json.intake as Json;
    assert.deepEqual([after.state, after.space, after.created], ["planned", null, null]);
  } finally {
    await done();
  }
});

test("mc-portee/AC-6 : un client borné à des espaces voit leurs dépôts du moment — un dépôt ajouté à l'espace lui devient visible sans toucher au client, un espace retiré ne lui laisse rien — n'est jamais propriétaire, pose ses Demandes dans son espace, et se crée par l'API ou par `--add-client --space`", async () => {
  const { world, tokens, clients, clientsFile, call, space, done } = await setup();
  try {
    const acme = space("Acme", ["demo"]);
    const exemple = space("Exemple", ["third"]);
    seed(world.store, "rd", "demo", "Export CSV");
    seed(world.store, "ro", "other", "Page d'accueil");
    seed(world.store, "rt", "third", "Recherche");

    const made = await call("POST", "/v1/clients", { name: "client-acme", role: "operator", spaces: ["acme"] });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const client = made.json.client as Json;
    assert.deepEqual([client.spaces, client.repos], [[acme.id], ["demo"]], "gardé par identifiant, dépôts du moment");
    const token = String(made.json.token);
    const stored = JSON.parse(fs.readFileSync(clientsFile, "utf8")) as { clients: Json[] };
    const entry = stored.clients.find((candidate) => candidate.name === "client-acme");
    assert.deepEqual([entry?.repos, entry?.spaces], [[], [acme.id]], "aucun dépôt enregistré : ils se relisent");

    // Les refus : deux bornes à la fois, un espace inconnu, une liste mal formée.
    const bad: [Json, number][] = [
      [{ name: "x1", repos: ["demo"], spaces: ["Acme"] }, 400],
      [{ name: "x2", spaces: ["nulle-part"] }, 404],
      [{ name: "x3", spaces: "Acme" }, 400],
      [{ name: "x4", spaces: [] }, 400],
    ];
    for (const [body, status] of bad) assert.equal((await call("POST", "/v1/clients", body)).status, status);

    const runs = async (): Promise<string[]> => idsOf((await call("GET", "/v1/runs", undefined, token)).json.runs);
    const me = async (): Promise<unknown> =>
      ((await call("GET", "/v1/me", undefined, token)).json.client as Json).repos;
    assert.deepEqual([await runs(), await me()], [["rd"], ["demo"]]);

    // Un dépôt de plus dans l'espace : visible à l'appel suivant, le client n'a pas été touché.
    const widened = await call("PUT", `/v1/spaces/${acme.id}`, { repos: ["demo", "other"] });
    assert.equal(widened.status, 200, JSON.stringify(widened.json));
    assert.deepEqual(
      [await runs(), await me()],
      [
        ["rd", "ro"],
        ["demo", "other"],
      ],
    );
    assert.equal((await call("GET", "/v1/runs/rt", undefined, token)).status, 404);

    // Jamais propriétaire.
    assert.equal((await call("GET", "/v1/local-sessions", undefined, token)).status, 403);
    assert.equal((await call("GET", "/v1/signals", undefined, token)).status, 403);
    assert.equal((await call("GET", "/metrics", undefined, token)).status, 403);
    assert.equal((await call("POST", "/v1/pause", { paused: true }, token)).status, 403);
    assert.equal((await call("POST", "/v1/pause", { paused: true, space: acme.id }, token)).status, 403);
    assert.equal(world.orchestrator.pause.paused, false);
    // Ni admin : administrer le serveur (clients, fournisseurs) lui donnerait de quoi sortir de son espace.
    // Refusé à la création ; et un fichier édité à la main qui le dirait admin sur tout le rend operator, borné.
    const admin = await call("POST", "/v1/clients", { name: "admin-acme", role: "admin", spaces: [acme.id] });
    assert.equal(admin.status, 400);
    assert.match(String(admin.json.error), /n'est ni admin ni approbateur/);
    const forged = JSON.parse(fs.readFileSync(clientsFile, "utf8")) as { clients: Json[] };
    for (const candidate of forged.clients)
      if (candidate.name === "client-acme") Object.assign(candidate, { role: "admin", repos: "*" });
    fs.writeFileSync(clientsFile, JSON.stringify(forged));
    const read = (await call("GET", "/v1/me", undefined, token)).json.client as Json;
    assert.deepEqual([read.role, read.repos], ["operator", ["demo", "other"]]);
    assert.equal((await call("GET", "/v1/clients", undefined, token)).status, 403);
    assert.equal((await call("POST", "/v1/clients", { name: "evade", role: "admin" }, token)).status, 403);

    // Sa Demande est celle de son espace, sans qu'il le dise.
    const posted = await call("POST", "/v1/intake", { text: "ajoute un export", source: "cli" }, token);
    assert.equal(posted.status, 201, JSON.stringify(posted.json));
    assert.deepEqual((posted.json.intake as Json).space, { id: acme.id, name: "Acme" });

    // En ligne de commande : `--space <id|nom>`, sur le même fichier de clients.
    const known = () => world.store.listSpaces().map(({ id, name, repos }) => ({ id, name, repos }));
    const cli = (...argv: string[]) => clientCommand(argv, new ClientRegistry(clientsFile), known);
    const added = cli("--add-client", "cli-exemple", "--role", "viewer", "--space", "exemple");
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stderr, /client cli-exemple \(viewer, espaces : Exemple\)/);
    const cliToken = added.stdout.trim();
    assert.deepEqual(idsOf((await call("GET", "/v1/runs", undefined, cliToken)).json.runs), ["rt"]);
    assert.match(cli("--list-clients").stdout, new RegExp(`cli-exemple\tviewer\tthird\tespaces:${exemple.id}`));
    const unknown = cli("--add-client", "cli-rien", "--space", "Nulle part");
    assert.deepEqual([unknown.status, unknown.stdout], [1, ""]);
    assert.match(unknown.stderr, /espace inconnu : Nulle part/);
    const both = cli("--add-client", "cli-deux", "--space", "Acme", "--repos", "demo");
    assert.equal(both.status, 1);
    assert.equal((await call("GET", "/v1/clients")).text.includes("cli-rien"), false);

    // Un registre que rien ne branche aux espaces : le client ne voit rien (échec fermé), jamais tout.
    assert.deepEqual(new ClientRegistry(clientsFile).authenticate(token)?.repos, []);
    assert.deepEqual(clients.authenticate(token)?.repos, ["demo", "other"]);

    // L'espace retiré : plus aucun dépôt.
    world.orchestrator.spaces.delete(acme.id, { by: "mac" });
    assert.deepEqual([await runs(), await me()], [[], []]);
    assert.equal((await call("GET", "/v1/runs", undefined, tokens.demo)).status, 200, "les autres clients restent");
  } finally {
    await done();
  }
});

test("mc-portee/AC-7 : la pause d'un espace retient ses runs en file et gare son run vivant après son étape — rien n'est annulé — pendant que les runs d'un autre espace partent et continuent ; `GET /v1/pause` la rend dans `spaces` à qui voit l'espace ; client borné, pilote et lecteur sont refusés ; la reprise relance", async () => {
  const { world, tokens, call, tool, space, done } = await setup({
    req: [[{ sleep: 1200 }, ...OK.req]],
    specs: [SLEEP],
  });
  await world.orchestrator.start();
  try {
    const { orchestrator, store } = world;
    const acme = space("Acme", ["demo"]);
    const exemple = space("Exemple", ["third"]);
    const run = (repo: string, title: string, modules: string[]): RunRow =>
      orchestrator.createRun({ repo, title, request: `Demande : ${title}`, modules });
    const liveA = run("demo", "En cours chez Acme", ["src/api"]);
    const liveB = run("third", "En cours chez Exemple", ["src/api"]);
    await waitFor(
      () => store.getRun(liveA.id)?.state === "running" && store.getRun(liveB.id)?.state === "running",
      () => `${stateOf(world, liveA.id)} / ${stateOf(world, liveB.id)}`,
    );

    const before = Date.now();
    const posed = await call(
      "POST",
      "/v1/pause",
      { paused: true, space: "acme", reason: " facture en retard " },
      tokens.ops,
    );
    assert.equal(posed.status, 200, JSON.stringify(posed.json));
    const view = posed.json.pause as Json;
    const [paused, ...others] = list(view.spaces);
    assert.deepEqual([view.paused, others.length], [false, 0], "la pause globale n'est pas posée");
    assert.deepEqual(
      [paused?.id, paused?.name, paused?.paused, paused?.by, paused?.reason, paused?.now],
      [acme.id, "Acme", true, "ops", "facture en retard", false],
    );
    assert.ok(Number(paused?.at) >= before && Number(paused?.at) <= Date.now());
    assert.deepEqual((await call("GET", "/v1/pause")).json.pause, view);
    assert.equal((await call("GET", "/v1/status")).json.paused, false);
    assert.deepEqual(
      store.eventsOfType("pause").map((event) => event.payload),
      [{ paused: true, by: "ops", reason: "facture en retard", now: false, space: acme.id }],
    );

    // Un run créé dans l'espace en pause attend et dit pourquoi ; celui d'un autre espace part.
    const freshA = run("demo", "Nouvelle chez Acme", ["docs"]);
    const freshB = run("third", "Nouvelle chez Exemple", ["docs"]);
    await waitFor(
      () => waitOf(orchestrator, world, freshA.id).waitCause === "paused",
      () => stateOf(world, freshA.id),
    );
    const held = (await call("GET", `/v1/runs/${freshA.id}`)).json.run as Json;
    assert.deepEqual(
      [held.state, held.waitCause, held.reason],
      ["queued", "paused", "en pause : suspendu par ops (espace « Acme ») — facture en retard"],
    );
    await waitFor(
      () => store.getRun(freshB.id)?.state === "running",
      () => stateOf(world, freshB.id),
    );

    // Le run vivant de l'espace finit son étape, puis retourne en file à la suivante ; l'autre continue.
    await waitFor(
      () => store.getRun(liveA.id)?.state === "queued",
      () => stateOf(world, liveA.id),
    );
    const parked = store.getRun(liveA.id) as RunRow;
    assert.deepEqual(
      [parked.step, parked.reason, parked.cancelCause],
      ["specs", "en pause : suspendu par ops (espace « Acme »)", null],
    );
    assert.ok(parked.worktree !== null && store.getArtifact(liveA.id, "req.md"), "rien n'est perdu");
    await waitFor(
      () => store.getRun(liveB.id)?.step === "specs" && store.getRun(liveB.id)?.state === "running",
      () => stateOf(world, liveB.id),
    );
    await ticks(orchestrator);
    assert.deepEqual(
      [liveA, freshA, liveB, freshB].map((entry) => store.getRun(entry.id)?.state),
      ["queued", "queued", "running", "running"],
    );

    // Qui la lit : celui qui voit un dépôt de l'espace ; `?space=` n'en garde qu'un.
    const spacesOf = async (query: string, token?: string): Promise<string[]> =>
      idsOf(((await call("GET", `/v1/pause${query}`, undefined, token)).json.pause as Json).spaces);
    assert.deepEqual(await spacesOf("", tokens.demo), [acme.id]);
    assert.deepEqual(await spacesOf("", tokens.third), [], "un client d'un autre espace n'en sait rien");
    assert.deepEqual(await spacesOf(`?space=${exemple.id}`), []);
    assert.deepEqual(idsOf(((await tool("pause", { space: "Acme" }, tokens.ops)).data.pause as Json).spaces), [
      acme.id,
    ]);

    // Redire l'état ne change rien ; lecteur, client borné et pilote sont refusés ; espace inconnu : 404.
    const again = { paused: true, space: acme.id, reason: "autre" };
    assert.deepEqual((await call("POST", "/v1/pause", again, tokens.ops)).json.pause, view);
    for (const token of [tokens.viewer, tokens.demo, tokens.pilot])
      assert.equal((await call("POST", "/v1/pause", { paused: false, space: acme.id }, token)).status, 403);
    assert.equal((await call("POST", "/v1/pause", { paused: false, space: "nulle-part" }, tokens.ops)).status, 404);
    assert.equal((await call("POST", "/v1/pause", { paused: false, space: 3 }, tokens.ops)).status, 400);
    assert.match(
      (await tool("pause", { paused: false, space: acme.id }, tokens.pilot)).error ?? "",
      /réservé à l'humain/,
    );
    assert.equal(store.eventsOfType("pause").length, 1);

    // La reprise (ici par `?space=`) : le run garé repart à son étape, le nouveau est admis.
    const resumed = await call("POST", `/v1/pause?space=${acme.id}`, { paused: false }, tokens.ops);
    assert.deepEqual((resumed.json.pause as Json).spaces, []);
    await waitFor(
      () => store.getRun(liveA.id)?.state === "running" && store.getRun(freshA.id)?.state === "running",
      () => `${stateOf(world, liveA.id)} / ${stateOf(world, freshA.id)}`,
    );
    assert.equal(store.getRun(liveA.id)?.step, "specs");
    assert.deepEqual(
      store.eventsOfType("pause").map((event) => [event.payload.paused, event.payload.space]),
      [
        [true, acme.id],
        [false, acme.id],
      ],
    );
  } finally {
    await done();
  }
});

test("mc-portee/AC-8 : une pause immédiate (`now`) d'un espace interrompt son run en plein /impl — il revient en file à l'étape impl, ni annulé ni en échec — sans toucher celui d'un autre espace ; gardée en base, elle survit à un redémarrage, qui n'admet rien de l'espace tant qu'elle tient ; un pilote ne la lève pas", async () => {
  const { world, space, done } = await setup({ req: [OK.req], specs: [OK.specs], impl: [SLEEP] });
  await world.orchestrator.start();
  let restarted: Orchestrator | null = null;
  try {
    const { orchestrator, store } = world;
    const acme = space("Acme", ["demo"]);
    space("Exemple", ["third"]);
    const run = (repo: string): RunRow =>
      orchestrator.createRun({ repo, title: `Export CSV (${repo})`, request: "Ajouter l'export", modules: ["src"] });
    const mine = run("demo");
    const theirs = run("third");
    const implPrompts = (): number =>
      world.log().filter((entry) => entry.kind === "prompt" && entry.step === "impl").length;
    await waitFor(
      () => implPrompts() === 2,
      () => `${stateOf(world, mine.id)} / ${stateOf(world, theirs.id)}`,
    );

    const pause = orchestrator.setPause(true, "", OPS, null, true, acme.id);
    assert.deepEqual([pause.paused, pause.now, pause.by], [true, true, "ops"]);
    await waitFor(
      () => store.getRun(mine.id)?.state === "queued",
      () => stateOf(world, mine.id),
    );
    const parked = store.getRun(mine.id) as RunRow;
    assert.deepEqual(
      [parked.step, parked.reason, parked.attempts, parked.lastFailCause, parked.cancelCause],
      ["impl", "en pause : suspendu par ops (espace « Acme »)", 0, null, null],
    );
    assert.ok(parked.worktree !== null && fs.existsSync(parked.worktree), "le worktree reste");
    assert.match(store.instructions(mine.id) ?? "", /Étape \/impl interrompue par la pause de l'espace « Acme »/);
    assert.deepEqual(
      store.eventsSince(0, mine.id).filter((event) => event.type === "run_failed" || event.type === "retried"),
      [],
    );
    await ticks(orchestrator);
    assert.deepEqual(
      [store.getRun(mine.id)?.state, store.getRun(theirs.id)?.state, store.getRun(theirs.id)?.step],
      ["queued", "running", "impl"],
      "l'autre espace n'a rien senti",
    );
    assert.equal(implPrompts(), 2, "le run garé n'est pas relancé");

    // Le redémarrage : la pause de l'espace est relue, celle du serveur n'existe pas.
    await orchestrator.stop();
    restarted = new Orchestrator(world.deps);
    assert.deepEqual(
      [restarted.pause.paused, restarted.pauseView().spaces.map((entry) => [entry.id, entry.by, entry.now])],
      [false, [[acme.id, "ops", true]]],
    );
    await restarted.start();
    const service = restarted;
    await waitFor(
      () => waitOf(service, world, mine.id).waitCause === "paused",
      () => stateOf(world, mine.id),
    );
    await waitFor(
      () => store.getRun(theirs.id)?.state === "running",
      () => stateOf(world, theirs.id),
    );
    await ticks(service);
    assert.equal(store.getRun(mine.id)?.state, "queued");
    assert.throws(
      () => service.setPause(false, "", { by: "vigie", pilot: true }, null, false, acme.id),
      /geste réservé à l'humain/,
    );
    assert.throws(() => service.setPause(false, "", OPS, ["demo"], false, acme.id), /réservée au propriétaire/);
    service.setPause(false, "", OPS, null, false, acme.id);
    await waitFor(
      () => store.getRun(mine.id)?.state === "running",
      () => stateOf(world, mine.id),
    );
    assert.deepEqual(new Orchestrator(world.deps).pauseView().spaces, [], "la reprise aussi est gardée");
  } finally {
    await restarted?.stop();
    await done();
  }
});

test("mc-portee/AC-9 : dans un espace en pause le serveur ne décide plus rien seul — une attente que « livre et préviens-moi » lèverait reste retenue, un run validé reste en `merging`, une escalade échue n'est pas tranchée — alors que l'échéance d'un dépôt hors de l'espace s'applique ; à la reprise tout repart", async () => {
  const lift = bugWorld({ rules: null, diff: 40 });
  const merge = bugWorld({ rules: null, diff: 40 });
  const expiry = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [[...readFrames(), { tool: "decision", args: escalationArgs() }, ...OK.impl], OK.impl],
      review: [OK.review],
    },
    {
      patch: (config) => {
        threeRepos(config);
        config.review.escalationTimeoutSec = null;
      },
    },
  );
  const worlds = [lift, merge, expiry];
  const spaces = worlds.map((world) =>
    world.orchestrator.spaces.create(spaceInput({ name: "Acme", repos: ["demo"] }), { by: "mac" }),
  );
  await Promise.all(worlds.map((world) => world.orchestrator.start()));
  try {
    const create = (world: FakeWorld, title: string): RunRow =>
      world.orchestrator.createRun({ repo: "demo", title, request: "Corriger" });
    const liftable = create(lift, "Levable");
    const approved = create(merge, "À fusionner");
    const asked = create(expiry, "Échéance");
    const stops = ["awaiting_human", "escalated", "merged", "failed"];
    const reached = await Promise.all([
      until(lift, liftable.id, stops),
      until(merge, approved.id, stops),
      until(expiry, asked.id, stops),
    ]);
    assert.deepEqual(
      reached.map((run) => run.state),
      ["awaiting_human", "awaiting_human", "escalated"],
    );
    // Hors de l'espace : un run escaladé du dépôt `third`, à la même échéance.
    seed(expiry.store, "rt-asked", "third", "Ailleurs", { state: "escalated", step: "impl" });
    expiry.store.addEscalation({
      runId: "rt-asked",
      stepId: expiry.store.startStep("rt-asked", "impl", 0, null, null).id,
      category: "reversible",
      question: "Quel format ?",
      options: ["csv", "json"],
      context: "Le format de l'export.",
      recommended: "csv",
    });

    for (const [n, world] of worlds.entries())
      world.orchestrator.setPause(true, "absence", OPS, null, false, spaces[n]?.id ?? "");
    // Les gestes de l'humain passent toujours : il monte un curseur, valide un verdict ; une échéance tombe.
    await lift.orchestrator.setAutonomy(liftable.id, "deliver", OPS);
    assert.equal((await merge.orchestrator.validate(approved.id, true, "", OPS)).state, "merging");
    expiry.config.review.escalationTimeoutSec = 1;
    const [open] = expiry.store.listEscalations({ runId: asked.id, status: "open" });
    assert.ok(open);
    const [outside] = expiry.store.listEscalations({ runId: "rt-asked", status: "open" });
    assert.ok(outside);
    await waitFor(
      () => Date.now() >= Math.max(open.createdAt, outside.createdAt) + 1200,
      () => "l'échéance n'est pas passée",
    );
    for (const world of worlds) {
      await ticks(world.orchestrator);
      await ticks(world.orchestrator);
    }

    // Dans l'espace en pause : rien ne s'est validé, fusionné ni tranché.
    assert.equal(lift.store.getRun(liftable.id)?.state, "awaiting_human", stateOf(lift, liftable.id));
    assert.deepEqual(
      eventsOf(lift, liftable.id, "autonomy").map((event) => event.payload.action),
      ["hold"],
    );
    assert.equal(autonomyDecisions(lift, liftable.id).length, 0);
    const waiting = merge.store.getRun(approved.id);
    assert.deepEqual([waiting?.state, waiting?.mergeSha], ["merging", null], stateOf(merge, approved.id));
    assert.equal(expiry.store.getRun(asked.id)?.state, "escalated", stateOf(expiry, asked.id));
    assert.equal(expiry.store.listDecisions({ runId: asked.id }).length, 0);
    // Hors de l'espace : l'échéance s'est appliquée.
    assert.deepEqual(
      expiry.store.listDecisions({ runId: "rt-asked" }).map((decision) => [decision.status, decision.chosen]),
      [["auto_timeout", "csv"]],
    );

    // La reprise de l'espace : l'attente est validée, le merge part, l'échéance passée s'applique.
    for (const [n, world] of worlds.entries())
      world.orchestrator.setPause(false, "", OPS, null, false, spaces[n]?.id ?? "");
    const done = await Promise.all([
      until(lift, liftable.id, ["merged", "failed"]),
      until(merge, approved.id, ["merged", "failed"]),
      until(expiry, asked.id, ["merged", "failed", "awaiting_human"]),
    ]);
    assert.deepEqual(
      done.map((run) => run.state),
      ["merged", "merged", "merged"],
      worlds.map((world, n) => stateOf(world, done[n]?.id ?? "")).join(" / "),
    );
    assert.deepEqual(
      expiry.store.listDecisions({ runId: asked.id }).map((decision) => [decision.status, decision.chosen]),
      [["auto_timeout", "colonne"]],
    );
  } finally {
    await Promise.all(worlds.map((world) => world.orchestrator.stop()));
  }
});

const MARCH = (day: number, hour = 10): number => Date.UTC(2026, 2, day, hour);

test("mc-portee/AC-10 : `GET /v1/spaces/{id}/usage` rend la consommation d'une fenêtre — total, par jour, par dépôt, par modèle, par nature — avec ce qui est imputé à l'espace sans dépôt (Demande, poste) ; par défaut le mois UTC en cours ; un client borné n'y lit que ses dépôts ; espace invisible 404, fenêtre ou format invalides 400", async () => {
  const { world, tokens, call, space, done } = await setup();
  try {
    const { store } = world;
    const acme = space("Acme", ["demo", "other"]);
    const exemple = space("Exemple", ["third"]);
    seed(store, "r1", "demo", "Export CSV");
    // Dans la fenêtre [10 mars, 12 mars[ : un run, un audit, un rêve, une Demande et un job du poste.
    spend(store, { runId: "r1", repo: "demo", cost: 1.5, input: 100, output: 50 }, MARCH(10));
    spend(
      store,
      { auditId: "a1", repo: "other", step: "audit", model: "haiku", cost: 0.25, input: 20, output: 10 },
      MARCH(10),
    );
    spend(store, { repo: "demo", step: "reve", cost: 0.125 }, MARCH(11));
    const local = { provider: "local", model: "qwen" };
    spend(store, { ...local, spaceId: acme.id, step: "demande", cost: 0.03, input: 10, output: 5 }, MARCH(11));
    spend(
      store,
      { ...local, spaceId: acme.id, step: "poste-service", cost: 0.5, input: 30, output: 15 },
      MARCH(11, 23),
    );
    // Hors de la fenêtre, d'un autre espace, ou hors de tout espace : jamais comptés.
    spend(store, { runId: "r1", repo: "demo", cost: 2 }, MARCH(20));
    spend(store, { repo: "third", cost: 9 }, MARCH(10));
    spend(store, { spaceId: exemple.id, step: "demande", cost: 7 }, MARCH(10));
    spend(store, { step: "poste-service", cost: 4 }, MARCH(10));

    const window = `since=${MARCH(10, 0)}&until=${MARCH(12, 0)}`;
    const read = await call("GET", `/v1/spaces/${acme.id}/usage?${window}`);
    assert.equal(read.status, 200, JSON.stringify(read.json));
    assert.deepEqual(read.json.usage, {
      since: MARCH(10, 0),
      until: MARCH(12, 0),
      total: 2.405,
      days: [
        { day: "2026-03-10", cost: 1.75, input: 120, output: 60 },
        { day: "2026-03-11", cost: 0.655, input: 40, output: 20 },
      ],
      repos: [
        { repo: "demo", cost: 1.625 },
        { repo: "other", cost: 0.25 },
      ],
      models: [
        { model: "anthropic/sonnet", cost: 1.625, input: 100, output: 50 },
        { model: "local/qwen", cost: 0.53, input: 40, output: 20 },
        { model: "anthropic/haiku", cost: 0.25, input: 20, output: 10 },
      ],
      kinds: [
        { kind: "feature", cost: 1.5 },
        { kind: "audit", cost: 0.25 },
        { kind: "poste", cost: 0.5 },
        { kind: "demande", cost: 0.03 },
        { kind: "reve", cost: 0.125 },
      ],
    });
    // La fenêtre est [since, until[ : la borne haute est exclue.
    const until = (await call("GET", `/v1/spaces/${acme.id}/usage?since=${MARCH(10, 0)}&until=${MARCH(11)}`)).json;
    assert.equal((until.usage as Json).total, 1.75);
    const other = (await call("GET", `/v1/spaces/${exemple.id}/usage?${window}`)).json.usage as Json;
    assert.deepEqual([other.total, other.repos], [16, [{ repo: "third", cost: 9 }]]);

    // Un client borné : ses dépôts, sans ce qui est imputé à l'espace entier.
    const mine = (await call("GET", `/v1/spaces/${acme.id}/usage?${window}`, undefined, tokens.demo)).json
      .usage as Json;
    assert.deepEqual(
      [mine.total, mine.repos, mine.kinds],
      [
        1.625,
        [{ repo: "demo", cost: 1.625 }],
        [
          { kind: "feature", cost: 1.5 },
          { kind: "reve", cost: 0.125 },
        ],
      ],
    );
    assert.equal((await call("GET", `/v1/spaces/${acme.id}/usage`, undefined, tokens.third)).status, 404);
    assert.equal((await call("GET", "/v1/spaces/nulle-part/usage")).status, 404);
    assert.equal((await call("GET", `/v1/spaces/${acme.id}/usage?space=${exemple.id}`)).status, 404);
    for (const query of ["since=hier", "since=-1", `since=${MARCH(12)}&until=${MARCH(10)}`, "until=", "format=xml"])
      assert.equal((await call("GET", `/v1/spaces/${acme.id}/usage?${query}`)).status, 400, query);

    // Par défaut : le mois UTC en cours, et le même coût dans `stats.costMonth` ; le budget du jour compte l'imputé.
    await clearOfMidnight(3000);
    spend(store, { runId: "r1", repo: "demo", cost: 0.4 });
    const month = (await call("GET", `/v1/spaces/${acme.id}/usage`)).json.usage as Json;
    assert.equal(month.total, 0.4);
    const now = new Date();
    assert.equal(month.since, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const budgeted = await call("PUT", `/v1/spaces/${acme.id}`, { dailyBudgetUsd: 1 });
    assert.equal(budgeted.status, 200, JSON.stringify(budgeted.json));
    assert.equal(world.orchestrator.spaces.budgetHold("demo", Date.now()), null);
    spend(store, { ...local, spaceId: acme.id, step: "poste-service", cost: 0.7 });
    assert.deepEqual(world.orchestrator.spaces.budgetHold("other", Date.now()), {
      space: "Acme",
      spent: 1.1,
      ceiling: 1,
    });
    const statsOf = async (token?: string): Promise<Json> =>
      list((await call("GET", "/v1/spaces", undefined, token)).json.spaces)[0]?.stats as Json;
    const whole = await statsOf();
    assert.deepEqual([whole.costToday, whole.costMonth, whole.budgetLeftToday], [1.1, 1.1, 0]);
    const part = await statsOf(tokens.demo);
    assert.deepEqual([part.costToday, part.costMonth, part.budgetLeftToday], [0.4, 0.4, null]);
  } finally {
    await done();
  }
});

test("mc-portee/AC-11 : l'export CSV d'une fenêtre porte son en-tête puis une ligne par jour, dépôt et modèle — séparateur `;`, décimales avec un point, dépôt vide pour ce qui est imputé à l'espace — et échappe un champ qui porte le séparateur, un guillemet ou le début d'une formule", async () => {
  const { world, call, space, done } = await setup();
  try {
    const { store } = world;
    const acme = space("Acme", ["demo", "other"]);
    spend(store, { runId: "r1", repo: "demo", cost: 1.5, input: 100, output: 50 }, MARCH(10));
    spend(store, { runId: "r1", repo: "demo", cost: 0.25, input: 1, output: 2 }, MARCH(10, 18));
    spend(store, { auditId: "a1", repo: "other", model: "haiku", cost: 0.25, input: 20, output: 10 }, MARCH(10));
    const local = { provider: "local", model: "qwen", spaceId: acme.id };
    spend(store, { ...local, step: "demande", cost: 0.03, input: 10, output: 5 }, MARCH(11));
    spend(store, { ...local, step: "poste-service", cost: 0.5, input: 30, output: 15 }, MARCH(11));
    spend(store, { repo: "demo", step: "reve", cost: 0.125 }, MARCH(11));
    spend(store, { repo: "third", cost: 9 }, MARCH(10));

    const csv = await call("GET", `/v1/spaces/${acme.id}/usage?since=${MARCH(10, 0)}&until=${MARCH(12, 0)}&format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.type ?? "", /^text\/csv/);
    assert.deepEqual(csv.text.split("\r\n"), [
      "jour;espace;depot;modele;cout_usd;jetons_entree;jetons_sortie",
      "2026-03-10;Acme;demo;anthropic/sonnet;1.750000;101;52",
      "2026-03-10;Acme;other;anthropic/haiku;0.250000;20;10",
      "2026-03-11;Acme;;local/qwen;0.530000;40;20",
      "2026-03-11;Acme;demo;anthropic/sonnet;0.125000;0;0",
      "",
    ]);
    // La somme des lignes est le total de la même fenêtre en JSON.
    const json = await call(
      "GET",
      `/v1/spaces/${acme.id}/usage?since=${MARCH(10, 0)}&until=${MARCH(12, 0)}&format=json`,
    );
    const summed = csv.text
      .split("\r\n")
      .slice(1, -1)
      .reduce((sum, line) => sum + Number(line.split(";")[4]), 0);
    assert.equal(Math.round(summed * 1e6) / 1e6, (json.json.usage as Json).total);
    // Une fenêtre sans consommation : l'en-tête seul.
    const empty = await call("GET", `/v1/spaces/${acme.id}/usage?since=1&until=2&format=csv`);
    assert.equal(empty.text, `${USAGE_CSV_HEADER}\r\n`);

    // L'échappement, sur les fonctions pures : séparateur, guillemets, saut de ligne, début de formule.
    const row: UsageRow = {
      runId: "r",
      auditId: null,
      repo: "demo",
      step: "impl",
      provider: null,
      model: 'gpt;"x"',
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.1,
      spaceId: null,
      at: MARCH(10),
    };
    const [, line] = usageCsv('Client; "Sud"', [row]).split("\r\n");
    assert.equal(line, '2026-03-10;"Client; ""Sud""";demo;"gpt;""x""";0.100000;1;2');
    assert.equal(usageCsv("=SOMME(A1)", [row]).split("\r\n")[1]?.split(";")[1], "'=SOMME(A1)");
    assert.equal(usageCsv("Deux\nlignes", [row]).split("\r\n")[1]?.startsWith('2026-03-10;"Deux\nlignes";'), true);
    assert.deepEqual(
      [
        usageKind(row),
        usageKind({ runId: null, auditId: "a", step: "pilote" }),
        usageKind({ runId: null, auditId: null, step: "poste-plan" }),
        usageKind({ runId: null, auditId: null, step: "demande" }),
        usageKind({ runId: null, auditId: null, step: "reve" }),
        usageKind({ runId: null, auditId: null, step: null }),
      ],
      ["feature", "audit", "poste", "demande", "reve", "autre"],
    );
    assert.deepEqual(spaceUsageOf([], 1, 2), {
      since: 1,
      until: 2,
      total: 0,
      days: [],
      repos: [],
      models: [],
      kinds: [],
    });
  } finally {
    await done();
  }
});

/** Un dossier de rêve de `facts` faits nouveaux : de quoi faire rêver un dépôt au repos. */
function dossier(facts: number): DreamDossier {
  const at = new Date().toISOString();
  return {
    horizon_us: 1_700_000_000_000_000,
    since: null,
    due: true,
    new_facts: Array.from({ length: facts }, (_, i) => ({ id: `f${i}`, memory: `Fait numéro ${i}`, updated_at: at })),
    context: [],
    observations: [],
    models: [{ name: "pieges", question: "Quels pièges ?", content: "", sources: [], stale: true }],
  };
}

const CONSOLIDATION = {
  observations: [{ text: "Chaque étape est confinée.", evidence: ["f0", "f1"] }],
  obsolete: [],
  causes: [{ source: "f0", target: "f1", reason: "le confinement a exposé le cgroup" }],
  models: [{ name: "pieges", content: "- cgroup délégué", sources: ["f1"] }],
};

test("mc-portee/AC-12 : toute consommation porte un espace — le rêve d'un dépôt d'un espace est relevé sur ce dépôt, un job du poste que `usageSpace` impute l'est à son espace, un run par son dépôt — et, hors de tout espace, rêve et poste gardent le relevé d'avant", async () => {
  const dream = (withSpace: boolean): FakeWorld => {
    const world = fakeWorld(
      { reve: [[usageFrame(0.2), { tool: "dream_consolidate", args: CONSOLIDATION }]] },
      {
        patch: (config) => {
          config.oracle = { url: "http://127.0.0.1:9", token: null };
          config.dreams.checkMinutes = 60;
        },
      },
    );
    world.oracle.dossier = dossier(6);
    if (withSpace) world.orchestrator.spaces.create(spaceInput({ name: "Acme", repos: ["demo"] }), { by: "mac" });
    return world;
  };
  const billed = dream(true);
  const plain = dream(false);
  await Promise.all([billed.orchestrator.start(), plain.orchestrator.start()]);
  try {
    for (const world of [billed, plain])
      await waitFor(
        () => world.orchestrator.dreams.list().some((row) => row.state === "done" || row.state === "failed"),
        () => JSON.stringify(world.orchestrator.dreams.list()),
      );
    assert.deepEqual(
      billed.orchestrator.dreams.list().map((row) => row.state),
      ["done"],
    );
    assert.deepEqual(
      billed.store.usageSince(0).map((row) => [row.repo, row.step, row.cost, row.spaceId, usageKind(row)]),
      [["demo", "reve", 0.2, null, "reve"]],
      "le rêve d'un dépôt d'un espace se facture par son dépôt",
    );
    assert.deepEqual(plain.store.usageSince(0), [], "hors espace, un rêve ne note rien, comme avant");

    // Un job du poste : hors espace par défaut (comme avant), à l'espace que `usageSpace` lui donne ensuite.
    const { orchestrator, store } = billed;
    const [acme] = store.listSpaces();
    assert.ok(acme);
    const owner = workstationOwner("poste-service");
    const message = {
      role: "assistant",
      provider: "local",
      model: "qwen",
      content: [],
      usage: { cost: { total: 0.5 } },
    };
    const say = (): void => orchestrator.sessions.frame(owner, "poste-service", { type: "message_end", message });
    say();
    orchestrator.monitor.usageSpace(owner, acme.id);
    say();
    orchestrator.monitor.usageSpace(owner, null);
    say();
    assert.deepEqual(
      store
        .usageSince(0)
        .filter((row) => row.step === "poste-service")
        .map((row) => [row.repo, row.spaceId]),
      [
        [null, null],
        [null, acme.id],
        [null, null],
      ],
    );
    // Un run : son dépôt, jamais `space_id` — son espace se déduit.
    const run = seed(store, "r1", "demo", "Export CSV");
    orchestrator.monitor.usageSpace(run.id, acme.id);
    orchestrator.sessions.frame(run.id, "impl", { type: "message_end", message });
    const [ofRun] = store.usageSince(0).filter((row) => row.runId === run.id);
    assert.deepEqual([ofRun?.repo, ofRun?.spaceId], ["demo", null]);
    // Une trame qui n'est pas la fin d'un message ne relève rien.
    const before = store.usageSince(0).length;
    orchestrator.monitor.recordFrame("dream:x", "reve", { type: "message_update", message }, "demo");
    orchestrator.monitor.recordFrame("dream:x", "reve", { type: "message_end", message: { role: "user" } }, "demo");
    assert.equal(store.usageSince(0).length, before);
  } finally {
    await Promise.all([billed.orchestrator.stop(), plain.orchestrator.stop()]);
  }
});

type Received = { path: string; body: Json };

/** Un receveur de webhooks local : garde chaque POST, avec le chemin qui dit à quelle cible il est allé. */
async function receiver(): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      // Un webhook poste du JSON, une cible ntfy son texte nu.
      received.push({
        path: request.url ?? "",
        body: body.startsWith("{") ? (JSON.parse(body) as Json) : { text: body },
      });
      response.writeHead(200).end();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

test("mc-portee/AC-13 : une cible de notification bornée à un espace (`notify.targets[].spaces`, par nom ou identifiant) ne reçoit que les événements de ses dépôts et son propre rapport du matin, sans la santé ni le commit ; une cible sans `spaces` reçoit tout ; un espace inconnu est un avertissement, jamais un refus, et la cible n'en reçoit rien ; une liste vide ou mal formée est refusée", async () => {
  const hooks = await receiver();
  const { world, call, space, done } = await setup();
  try {
    const { store } = world;
    const acme = space("Acme", ["demo"]);
    const exemple = space("Exemple", ["third"]);
    const target = (name: string, spaces?: string[]) => ({
      kind: "webhook" as const,
      url: `${hooks.url}/${name}`,
      headers: {},
      ...(spaces ? { spaces } : {}),
    });
    const config: HarnessConfig = {
      ...world.config,
      notify: {
        ...world.config.notify,
        events: ["run_failed", "daily_budget_reached"],
        dedupMin: null,
        digestHour: 0,
        targets: [
          target("acme", ["acme"]),
          target("exemple", [exemple.id]),
          target("tout"),
          target("fantome", ["Fantôme"]),
        ],
      },
    };
    const notifier = new Notifier({ config, store });
    seed(store, "rd", "demo", "Export CSV chez Acme", { state: "merged", mergeSha: "a".repeat(40) });
    seed(store, "rt", "third", "Recherche chez Exemple", { state: "merged", mergeSha: "b".repeat(40) });
    store.appendEvent("run_failed", "rd", { reason: "tests rouges" });
    store.appendEvent("run_failed", "rt", { reason: "runner mort" });
    store.appendEvent("daily_budget_reached", null, { spent: 12, ceiling: 10 }, null);
    for (const type of ["run_failed", "daily_budget_reached"])
      for (const event of store.eventsOfType(type)) notifier.handle(event);
    await notifier.idle();
    const got = (name: string): Json[] =>
      hooks.received.filter((entry) => entry.path === `/${name}`).map((entry) => entry.body);
    assert.deepEqual(
      got("acme").map((body) => [body.event, body.repo, body.runId]),
      [["run_failed", "demo", "rd"]],
    );
    assert.deepEqual(
      got("exemple").map((body) => [body.event, body.repo]),
      [["run_failed", "third"]],
    );
    assert.deepEqual(
      got("tout")
        .map((body) => `${body.event}:${body.repo}`)
        .sort(),
      ["daily_budget_reached:null", "run_failed:demo", "run_failed:third"],
      "une cible sans `spaces` reçoit tout, comme avant",
    );
    assert.deepEqual(got("fantome"), [], "un espace inconnu n'apporte aucun dépôt");

    // Le rapport du matin : celui du serveur aux cibles globales, celui de ses dépôts à chaque cible bornée.
    hooks.received.length = 0;
    const sent = new DigestSender({ config, store, notifier }).check();
    assert.ok(sent, "le rapport est dû");
    await notifier.idle();
    const report = (name: string): string[] => got(name).map((body) => `${body.title}\n${body.body}`);
    assert.equal(report("tout").length, 1);
    assert.match(report("tout")[0] ?? "", /Export CSV chez Acme[\s\S]*Commit déployé|Commit déployé/);
    assert.ok(report("tout")[0]?.includes("Recherche chez Exemple"));
    assert.equal(report("acme").length, 1);
    assert.match(report("acme")[0] ?? "", /^Rapport du matin\n/);
    assert.ok(report("acme")[0]?.includes("Export CSV chez Acme"));
    assert.ok(!report("acme")[0]?.includes("Recherche chez Exemple"), "rien d'un autre espace");
    assert.ok(!report("acme")[0]?.includes("Commit déployé"), "ni santé ni commit du service");
    assert.ok(report("exemple")[0]?.includes("Recherche chez Exemple"));
    assert.deepEqual(report("fantome"), ["Rapport du matin\nRien de neuf."]);

    // L'espace inconnu : dit au démarrage et dans `warnings`, jamais un refus.
    assert.deepEqual(notifier.spaceWarnings(), [
      "notify.targets[3].spaces : espace inconnu « Fantôme » — cette cible n'en recevra rien",
    ]);
    world.config.notify.targets = [target("fantome", ["Fantôme", acme.id])];
    const warnings = (await call("GET", "/v1/status")).json.warnings as string[];
    assert.ok(warnings.some((warning) => warning.includes("espace inconnu « Fantôme »")));
    assert.equal(
      warnings.some((warning) => warning.includes(acme.id)),
      false,
    );

    // La configuration : `spaces` est une liste non vide de noms ; absente, la cible est celle d'avant.
    const dir = tmpdir("mc-portee-conf-");
    const load = (targets: unknown[]): HarnessConfig => {
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, JSON.stringify({ dataDir: dir, notify: { targets } }));
      return loadConfig(file);
    };
    const hook = { kind: "webhook", url: "https://hooks.example/a" };
    assert.deepEqual(load([{ ...hook, spaces: [" Acme "] }, hook]).notify.targets, [
      { ...hook, headers: {}, spaces: ["Acme"] },
      { ...hook, headers: {} },
    ]);
    for (const spaces of [[], "Acme", [3], [""]])
      assert.throws(() => load([{ ...hook, spaces }]), /notify\.targets\[0\]\.spaces/, JSON.stringify(spaces));
  } finally {
    await done();
    await hooks.close();
  }
});

test("mc-portee/AC-14 : sans aucun espace, rien ne change — `?space=` n'existe pas (404), la pause globale suspend et dit la même raison, une Demande n'a pas d'espace et garde toute la portée de son auteur sans rien noter de son coût, un client garde sa forme, les notifications vont à toutes les cibles", async () => {
  const hooks = await receiver();
  const { world, tokens, call, done } = await setup({
    req: [[{ sleep: 600 }, ...OK.req]],
    specs: [SLEEP],
    demande: [[usageFrame(0.07), ...classify({ ...FEATURE, repo: "third" })]],
  });
  await world.orchestrator.start();
  try {
    const { orchestrator, store } = world;
    assert.deepEqual(store.listSpaces(), []);
    assert.deepEqual((await call("GET", "/v1/spaces")).json.spaces, []);
    assert.equal((await call("GET", "/v1/runs?space=demo")).status, 404, "un dépôt n'est pas un espace");
    assert.deepEqual((await call("GET", "/v1/pause")).json, {
      pause: { paused: false, by: null, at: null, reason: null, now: false, spaces: [] },
    });
    assert.deepEqual(Object.keys((await call("GET", "/v1/me", undefined, tokens.demo)).json.client as Json).sort(), [
      "approver",
      "createdAt",
      "name",
      "pilot",
      "repos",
      "role",
    ]);

    // La pause globale : la même suspension, la même raison, le même événement.
    const live = orchestrator.createRun({ repo: "demo", title: "En cours", request: "x", modules: ["src"] });
    await waitFor(
      () => store.getRun(live.id)?.state === "running",
      () => stateOf(world, live.id),
    );
    const posed = await call("POST", "/v1/pause", { paused: true, reason: "je pars" }, tokens.ops);
    const pause = posed.json.pause as Json;
    assert.deepEqual([pause.paused, pause.by, pause.reason, pause.spaces], [true, "ops", "je pars", []]);
    assert.deepEqual(
      store.eventsOfType("pause").map((event) => event.payload),
      [{ paused: true, by: "ops", reason: "je pars", now: false }],
    );
    await waitFor(
      () => store.getRun(live.id)?.state === "queued",
      () => stateOf(world, live.id),
    );
    assert.deepEqual(
      [store.getRun(live.id)?.step, store.getRun(live.id)?.reason],
      ["specs", "en pause : suspendu par ops"],
    );
    await waitFor(
      () => waitOf(orchestrator, world, live.id).waitCause === "paused",
      () => stateOf(world, live.id),
    );
    assert.equal(waitOf(orchestrator, world, live.id).reason, "en pause : suspendu par ops — je pars");
    assert.equal((await call("GET", "/v1/status")).json.paused, true);
    assert.equal((await call("POST", "/v1/pause", { paused: false }, tokens.ops)).status, 200);

    // Une Demande : aucun espace, la portée de son auteur, aucun relevé de son coût.
    const posted = await call("POST", "/v1/intake", { text: "ajoute un export", source: "cli" });
    const id = String((posted.json.intake as Json).id);
    await waitFor(
      () => store.getIntake(id)?.state !== "classifying",
      () => `demande ${id} toujours en classement`,
    );
    const row = store.getIntake(id);
    assert.deepEqual([row?.state, row?.spaceId, row?.scope, row?.repo], ["planned", null, "*", "third"]);
    assert.equal(((await call("GET", `/v1/intake/${id}`)).json.intake as Json).space, null);
    assert.deepEqual(
      store.usageSince(0).filter((usage) => usage.step === "demande"),
      [],
    );
    const prompt = String(
      world.log().findLast((entry) => entry.kind === "prompt" && entry.step === "demande")?.message,
    );
    assert.ok(!prompt.includes("posée dans l'espace"));

    // Les notifications : toutes les cibles reçoivent tout, avec ou sans dépôt.
    const config: HarnessConfig = {
      ...world.config,
      notify: {
        ...world.config.notify,
        url: `${hooks.url}/ntfy`,
        events: ["run_failed", "daily_budget_reached"],
        dedupMin: null,
        targets: [{ kind: "webhook", url: `${hooks.url}/hook`, headers: {} }],
      },
    };
    const notifier = new Notifier({ config, store });
    assert.deepEqual(notifier.spaceWarnings(), []);
    assert.deepEqual(
      notifier.targets().map((target) => notifier.scopeOf(target)),
      [null, null],
    );
    assert.equal(
      notifier.post({ title: "Plafond", body: "atteint", priority: 4, tags: [], click: null }),
      true,
      "une notification sans dépôt part",
    );
    await notifier.idle();
    assert.deepEqual(hooks.received.map((entry) => entry.path).sort(), ["/hook", "/ntfy"]);
  } finally {
    await done();
    await hooks.close();
  }
});

test("mc-portee/AC-15 : la route de consommation est servie par apiRoutes() et décrite dans le README du harness, la capacité `space-scope` est annoncée, et le README dit `?space=`, la pause et la Demande d'un espace, le client borné à des espaces et `notify.targets[].spaces`", () => {
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
  const usage = routes.find((route) => route.method === "GET" && route.path === "/v1/spaces/{id}/usage");
  assert.equal(usage?.role, "viewer");
  assert.ok(readme.includes("| `GET /v1/spaces/{id}/usage"), "la route est absente du tableau d'API du README");
  assert.ok((API_FEATURES as readonly string[]).includes("space-scope"));
  for (const said of [
    "### La portée d'un espace",
    "`?space=<id\\|nom>`",
    "| `POST /v1/pause` `{paused, space, reason?, now?}`",
    "| `POST /v1/intake` `{text, source, space, repo?, context?}`",
    "| `POST /v1/clients` `{name, role?, pilot?, spaces}`",
    "--add-client <nom> --space <id|nom>",
    "`notify.targets[].spaces`",
    "stats.costMonth",
    "jour;espace;depot;modele;cout_usd;jetons_entree;jetons_sortie",
    "`space-scope` annonce",
  ])
    assert.ok(readme.includes(said), `${said} absent du README`);
  for (const name of ["pause", "intake"]) {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool && "space" in tool.properties, `l'outil ${name} prend \`space\``);
    assert.ok(new RegExp(`\\| \`${name}\` \`\\{[^}]*space\\?`).test(readme), `${name} : \`space?\` absent du README`);
  }
  assert.ok(readme.includes("| argument `space` des outils de lecture"));
});
