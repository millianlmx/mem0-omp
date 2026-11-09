// Feature session-graph : le graphe de ce que l'agent a lu, cherché, testé, modifié et décidé, construit par
// le serveur depuis le direct des sessions, borné, persisté, servi par `GET /v1/runs/{id}/graph` et poussé en
// événement éphémère `graph`. Les preuves (`evidence`) d'une décision sont vérifiées contre lui.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { EscalationRow, EventRow, RunRow, StepRow } from "../../omp-harness/db.ts";
import { Store } from "../../omp-harness/db.ts";
import { Briefings } from "../../omp-harness/briefing.ts";
import type { Briefing } from "../../omp-harness/briefing.ts";
import { buildCard } from "../../omp-harness/card.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import type { HarnessContext } from "../../omp-harness/context.ts";
import { WAIT_REASON } from "../../omp-harness/machine.ts";
import { notificationFor } from "../../omp-harness/notify.ts";
import { alertFor } from "../../omp-harness/push-alerts.ts";
import { EVIDENCE_MAX, planDecision } from "../../omp-harness/decisions.ts";
import { EPHEMERAL_EVENTS, EVENT_TYPES } from "../../omp-harness/events.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import type { GraphNode, SessionGraphView } from "../../omp-harness/session-graph.ts";
import {
  GRAPH_ARTIFACT,
  GRAPH_EVENT_MIN_MS,
  GRAPH_NODES_MAX,
  SessionGraphs,
  repoPath,
} from "../../omp-harness/session-graph.ts";
import { CARD_CONTEXT, CARD_FIELDS, escalationArgs, readFrames } from "../support/card-fixtures.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const CONTEXT =
  "La feature exporte les factures en CSV. `src/a.ts` doit dater chaque export ; le modèle n'a pas encore de champ de date. Il faut choisir où le stocker.";

// -- outils des tests unitaires ----------------------------------------------------------------------------

let units: FakeWorld | null = null;
let unitSeq = 0;
const WORKTREE = "/srv/worktrees/demo/graphe";

type Timer = { fn: () => void; at: number; cancelled: boolean };

/** Un `SessionGraphs` sur une vraie base, à horloge et minuteur pilotés, et un run neuf. */
function unit(options: { secrets?: string[]; worktree?: string } = {}) {
  units ??= fakeWorld({});
  const { store } = units;
  unitSeq += 1;
  const id = `g${unitSeq}`;
  store.createRun({ id, repo: "demo", slug: id, title: id, request: id, branch: `harness/${id}` });
  let now = 0;
  const timers: Timer[] = [];
  const sent: { at: number; version: number; nodes: number; edges: number }[] = [];
  const warnings: string[] = [];
  const graphs = new SessionGraphs({
    store,
    publish: (_runId, payload) => sent.push({ at: now, ...payload }),
    secrets: () => options.secrets ?? [],
    now: () => now,
    schedule: (fn, ms) => {
      const timer: Timer = { fn, at: now + ms, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    log: (line) => {
      warnings.push(line);
    },
  });
  const run = { id, worktree: options.worktree ?? WORKTREE };
  let calls = 0;
  /** Un outil réussi : sa trame de début, puis sa trame de fin (dont le résultat n'entre jamais dans le graphe). */
  const tool = (step: { id: number; kind: StepRow["kind"] }, name: string, args: Record<string, unknown>) => {
    calls += 1;
    const toolCallId = `c${calls}`;
    graphs.frame(run, step, { type: "tool_execution_start", toolCallId, toolName: name, args });
    graphs.frame(run, step, {
      type: "tool_execution_end",
      toolCallId,
      toolName: name,
      result: { content: [{ type: "text", text: "contenu du fichier avec sk-ant-api03-abcdefghijkl" }] },
    });
  };
  return {
    graphs,
    run,
    store,
    sent,
    warnings,
    tool,
    clock: (value: number) => {
      now = value;
    },
    /** Fait tourner les minuteurs échus (l'horloge est avancée à leur échéance). */
    tick: (to: number) => {
      for (const timer of timers.filter((t) => !t.cancelled && t.at <= to).sort((a, b) => a.at - b.at)) {
        now = timer.at;
        timer.cancelled = true;
        timer.fn();
      }
      now = to;
    },
    timers,
  };
}

const IMPL = { id: 1, kind: "impl" } as const;

const byId = (view: SessionGraphView, id: string): GraphNode | undefined => view.nodes.find((n) => n.id === id);
const edgeOf = (view: SessionGraphView, kind: string, from: string, to: string) =>
  view.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

/** Chaque extrémité d'arc est un nœud de la vue. */
function assertClosed(view: SessionGraphView): void {
  const ids = new Set(view.nodes.map((n) => n.id));
  assert.equal(ids.size, view.nodes.length, "les ids de nœuds sont uniques");
  for (const edge of view.edges) {
    assert.ok(ids.has(edge.from), `arc ${edge.kind} : origine ${edge.from} absente`);
    assert.ok(ids.has(edge.to), `arc ${edge.kind} : cible ${edge.to} absente`);
  }
}

// -- un vrai run : le scénario d'AC-1 ----------------------------------------------------------------------

const frames = (id: string, tool: string, args: Record<string, unknown>) => [
  { frame: { type: "tool_execution_start", toolCallId: id, toolName: tool, args } },
  { frame: { type: "tool_execution_end", toolCallId: id, toolName: tool, result: { content: [] } } },
];

type Main = {
  world: FakeWorld;
  run: RunRow;
  impl: StepRow;
  seq: number;
  view: SessionGraphView;
  events: EventRow[];
};

let mainRun: Promise<Main> | null = null;

/** Le scénario d'AC-1, joué une fois pour tous les tests qui lisent son graphe. */
function main(): Promise<Main> {
  mainRun ??= (async () => {
    const world = fakeWorld({
      req: [OK.req],
      specs: [OK.specs],
      impl: [
        [
          ...frames("t1", "read", { path: "src/a.ts" }),
          ...frames("t2", "read", { path: "src/b.ts" }),
          ...frames("t3", "grep", { pattern: "TODO", path: "src" }),
          { tool: "run_tests", args: { scope: "touched" } },
          ...frames("t4", "edit", { input: "[src/a.ts#A1B2]\nPUT 3.=3:\n+const x = 1;\n" }),
          {
            tool: "decision",
            args: {
              question: "Où stocker la date d'export ?",
              context: CONTEXT,
              options: ["ajouter une colonne", "table séparée"],
              chosen: "ajouter une colonne",
              rationale: "une seule lecture par facture",
              category: "reversible",
              evidence: ["src/a.ts:3"],
            },
          },
          ...OK.impl,
        ],
      ],
      review: [OK.review],
    });
    const events: EventRow[] = [];
    world.store.onEvent((event) => events.push(event));
    await world.orchestrator.start();
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export daté", request: "Exporter" });
    await waitFor(
      () => ["merged", "failed", "awaiting_human", "escalated"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => String(world.store.getRun(run.id)?.state),
      30_000,
    );
    const view = world.orchestrator.graphView(run.id);
    const impl = world.store.listSteps(run.id).find((s) => s.kind === "impl") as StepRow;
    const decision = world.store.listDecisions({ runId: run.id })[0];
    assert.ok(decision, "la décision du scénario est posée");
    return { world, run, impl, seq: decision.seq, view, events };
  })();
  return mainRun;
}

after(async () => {
  if (!mainRun) return;
  try {
    await (await mainRun).world.orchestrator.stop();
  } catch {
    /* déjà arrêté par AC-31 */
  }
});

// -- AC-1, AC-2 --------------------------------------------------------------------------------------------

test("session-graph/AC-1 : le graphe d'un run porte des nœuds step, dir, file, search, test, edit et decision", async () => {
  const { view } = await main();
  const kinds = new Set(view.nodes.map((n) => n.kind));
  for (const kind of ["step", "dir", "file", "search", "test", "edit", "decision"] as const)
    assert.ok(kinds.has(kind), `nœud ${kind} absent : ${[...kinds].join(", ")}`);
  assert.ok(byId(view, "dir:src"), "le dossier des deux fichiers lus");
  assertClosed(view);
});

test("session-graph/dossier-lu : un dossier lu est un nœud dir, relié à l'étape par un arc read", () => {
  const worktree = tmpdir("graph-wt-");
  fs.mkdirSync(path.join(worktree, "lib"));
  const u = unit({ worktree });
  u.graphs.step(u.run, IMPL);
  u.tool(IMPL, "read", { path: "lib" });
  u.tool(IMPL, "read", { path: `${worktree}/lib/x.ts` });
  const view = u.graphs.view(u.run.id);
  assert.equal(byId(view, "dir:lib")?.reads, 2, "la lecture du dossier et celle de son fichier");
  assert.equal(edgeOf(view, "read", "step:1", "dir:lib")?.count, 1);
  assert.equal(byId(view, "file:lib/x.ts")?.parent, "dir:lib");
});

test("session-graph/AC-2 : arcs read, searched, tested, edited, led_to et evidence, et champ step de chaque nœud", async () => {
  const { view, impl, seq } = await main();
  const S = `step:${impl.id}`;
  assert.ok(edgeOf(view, "read", S, "file:src/a.ts"));
  assert.ok(edgeOf(view, "read", S, "file:src/b.ts"));
  const search = view.nodes.find((n) => n.kind === "search" && n.pattern === "TODO");
  assert.ok(search, "la recherche garde son motif");
  assert.ok(edgeOf(view, "searched", S, search.id));
  const test_ = view.nodes.find((n) => n.kind === "test" && n.id === `test:${impl.id}:touched`);
  assert.equal(test_?.outcome, "pass");
  assert.ok(edgeOf(view, "tested", S, `test:${impl.id}:touched`));
  assert.ok(edgeOf(view, "edited", `edit:${impl.id}`, "file:src/a.ts"));
  assert.equal(byId(view, "file:src/a.ts")?.edits, 1);
  assert.ok(edgeOf(view, "led_to", S, "file:src/a.ts"), "l'ordre de lecture : de l'étape au premier fichier");
  assert.ok(edgeOf(view, "led_to", "file:src/a.ts", "file:src/b.ts"), "puis au suivant");
  assert.ok(edgeOf(view, "evidence", `decision:${seq}`, "file:src/a.ts"), "`src/a.ts:3` désigne le fichier lu");
  for (const id of [search.id, `test:${impl.id}:touched`, `edit:${impl.id}`, `decision:${seq}`])
    assert.equal(byId(view, id)?.step, S, id);
  for (const id of [S, "dir:src", "file:src/a.ts"]) assert.equal(byId(view, id)?.step, null, id);
  assert.equal(byId(view, `edit:${impl.id}`)?.label, "1 fichier");
});

test("session-graph/escalade-graphe : une escalade a son nœud, ses arcs evidence et son entrée ambiguities ; une preuve absente est refusée", async () => {
  const escalate = (evidence: string[]) => ({ tool: "decision", args: escalationArgs({ evidence }) });
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [
      [...frames("t1", "read", { path: "src/a.ts" }), escalate(["src/a.ts"]), escalate(["nulle/part.ts"])],
      OK.impl,
    ],
    review: [OK.review],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Schéma", request: "Exporter" });
    await waitFor(
      () => ["escalated", "merged", "failed"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => String(world.store.getRun(run.id)?.state),
      30_000,
    );
    const escalations = world.store.listEscalations({ runId: run.id });
    assert.equal(escalations.length, 1, "la seconde est refusée");
    const impl = world.store.listSteps(run.id).find((s) => s.kind === "impl") as StepRow;
    const view = world.orchestrator.graphView(run.id);
    const id = `escalation:${escalations[0]?.id}`;
    assert.equal(byId(view, id)?.step, `step:${impl.id}`);
    assert.ok(edgeOf(view, "evidence", id, "file:src/a.ts"));
    assert.deepEqual(view.ambiguities, [{ node: id, kind: "escalation", evidence: ["file:src/a.ts"] }]);
    assert.equal(view.nodes.filter((n) => n.kind === "escalation").length, 1);
    const refused = world
      .log()
      .filter((entry) => entry.kind === "tool" && entry.tool === "decision")
      .map((entry) => String(entry.result));
    assert.match(refused[1] ?? "", /décision refusée : preuve absente du graphe du run/);
    assert.match(refused[1] ?? "", /nulle\/part\.ts/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("session-graph/recherche-partagée : une recherche faite dans deux étapes est un seul nœud, avec un arc searched par étape", () => {
  const u = unit();
  const A = { id: 1, kind: "impl" } as const;
  const B = { id: 2, kind: "review" } as const;
  u.graphs.step(u.run, A);
  u.tool(A, "grep", { pattern: "TODO", path: "src" });
  u.graphs.step(u.run, B);
  u.tool(B, "grep", { pattern: "TODO", path: "src" });
  const view = u.graphs.view(u.run.id);
  const searches = view.nodes.filter((n) => n.kind === "search");
  assert.equal(searches.length, 1);
  assert.equal(searches[0]?.step, "step:1", "la première étape qui l'a faite");
  assert.equal(searches[0]?.count, 2);
  assert.equal(searches[0]?.label, "TODO — src");
  assert.ok(edgeOf(view, "searched", "step:1", searches[0]?.id as string));
  assert.ok(edgeOf(view, "searched", "step:2", searches[0]?.id as string));
});

// -- AC-3, AC-4, AC-5 --------------------------------------------------------------------------------------

test("session-graph/AC-3 : un fichier lu trois fois et modifié une fois porte 3 lectures et 1 modification ; son dossier les agrège", () => {
  const u = unit();
  u.graphs.step(u.run, IMPL);
  for (let i = 0; i < 3; i++) u.tool(IMPL, "read", { path: "src/a.ts" });
  u.tool(IMPL, "edit", { path: "src/a.ts" });
  u.tool(IMPL, "read", { path: "src/b.ts" });
  const view = u.graphs.view(u.run.id);
  assert.deepEqual([byId(view, "file:src/a.ts")?.reads, byId(view, "file:src/a.ts")?.edits], [3, 1]);
  const dir = byId(view, "dir:src");
  assert.deepEqual([dir?.reads, dir?.edits, dir?.files], [4, 1, 2]);
});

test("session-graph/AC-4 : 400 fichiers dans 20 dossiers tiennent en 300 nœuds au plus, regroupés par dossier, compteurs conservés", () => {
  const u = unit();
  u.graphs.step(u.run, IMPL);
  for (let i = 0; i < 400; i++) u.tool(IMPL, "read", { path: `d${i % 20}/f${i}.ts` });
  const view = u.graphs.view(u.run.id);
  assert.ok(view.nodes.length <= GRAPH_NODES_MAX, `${view.nodes.length} nœuds`);
  const dirs = view.nodes.filter((n) => n.kind === "dir");
  assert.ok(dirs.some((d) => d.grouped));
  assert.equal(
    dirs.reduce((sum, d) => sum + d.reads, 0),
    400,
  );
  assertClosed(view);
});

test("session-graph/racine-regroupée : regroupement de la racine — les fichiers de la racine vont dans `.`, pas ceux de ses sous-dossiers", () => {
  const u = unit();
  u.graphs.step(u.run, IMPL);
  for (let i = 0; i < 20; i++) u.tool(IMPL, "read", { path: `r${i}.ts` });
  for (let k = 0; k < 140; k++) u.tool(IMPL, "read", { path: `s${k}/f.ts` });
  let view = u.graphs.view(u.run.id);
  assert.equal(byId(view, "dir:.")?.grouped, true);
  assert.equal(view.nodes.filter((n) => n.kind === "file" && n.parent === "dir:.").length, 0);
  u.tool(IMPL, "read", { path: "src/x.ts" });
  view = u.graphs.view(u.run.id);
  assert.equal(byId(view, "file:src/x.ts")?.parent, "dir:src");
  assert.equal(byId(view, "dir:src")?.reads, 1);
  assert.deepEqual([byId(view, "dir:.")?.reads, byId(view, "dir:.")?.files], [20, 20]);
  u.tool(IMPL, "read", { path: "r99.ts" });
  view = u.graphs.view(u.run.id);
  assert.deepEqual([byId(view, "dir:.")?.reads, byId(view, "dir:.")?.files], [21, 21]);
  assert.equal(byId(view, "file:r99.ts"), undefined);
});

test("session-graph/dossier-fondu : dossier fondu par la borne — ses lectures vont à l'absorbant, un dossier regroupé garde les siennes", () => {
  const u = unit();
  u.graphs.step(u.run, IMPL);
  for (let k = 0; k <= 300; k++) u.tool(IMPL, "read", { path: `p/d${k}/f.ts` });
  let view = u.graphs.view(u.run.id);
  assert.ok(view.nodes.length <= GRAPH_NODES_MAX);
  const p = byId(view, "dir:p");
  assert.deepEqual([p?.grouped, p?.files], [true, 3]);
  assert.equal(byId(view, "dir:p/d0"), undefined);
  u.tool(IMPL, "read", { path: "p/d0/g.ts" });
  view = u.graphs.view(u.run.id);
  assert.deepEqual([byId(view, "dir:p")?.reads, byId(view, "dir:p")?.files], [4, 4]);
  assert.equal(byId(view, "dir:p/d0"), undefined);
  assert.equal(byId(view, "file:p/d0/g.ts"), undefined);
  const before = byId(view, "dir:p")?.reads;
  u.tool(IMPL, "read", { path: "p/d200/g.ts" });
  view = u.graphs.view(u.run.id);
  assert.equal(byId(view, "dir:p/d200")?.grouped, true);
  assert.equal(byId(view, "dir:p/d200")?.files, 2);
  assert.equal(byId(view, "dir:p")?.reads, before);
  const found = u.graphs.resolve(u.run, ["p/d10", "p/d1/f.ts"]);
  assert.deepEqual(found, { ok: true, nodes: ["dir:p"] });
  assertClosed(view);
});

test("session-graph/AC-5 : aucun chemin hors dépôt, aucun contenu ni secret dans le graphe", () => {
  const u = unit({ secrets: ["valeur-connue-123456"] });
  u.graphs.step(u.run, IMPL);
  u.tool(IMPL, "read", { path: "/etc/passwd" });
  u.tool(IMPL, "read", { path: "~/.ssh/id_rsa" });
  u.tool(IMPL, "read", { path: "/home/u/x.ts" });
  u.tool(IMPL, "read", { path: `${WORKTREE}/src/c.ts` });
  u.tool(IMPL, "read", { path: "local://notes.md" });
  u.tool(IMPL, "grep", { pattern: "token=abcdef123456", path: `${WORKTREE}/src;/etc` });
  u.tool(IMPL, "grep", { pattern: "valeur-connue-123456" });
  u.tool(IMPL, "find", { pattern: "/etc/*" });
  u.tool(IMPL, "find", { pattern: "~/.ssh/*" });
  u.tool(IMPL, "glob", { pattern: "../../etc/*" });
  u.tool(IMPL, "glob", { pattern: `${WORKTREE}/src/**/*.ts` });
  const view = u.graphs.view(u.run.id);
  const json = JSON.stringify(view);
  for (const leak of ["/etc", ".ssh", "/home", WORKTREE, "sk-ant-", "abcdef123456", "valeur-connue-123456", "contenu"])
    assert.ok(!json.includes(leak), `fuite : ${leak}`);
  assert.ok(byId(view, "file:src/c.ts"));
  assert.ok(view.nodes.every((n) => n.path === null || !path.isAbsolute(n.path)));
  assert.deepEqual(
    view.nodes.filter((n) => n.kind === "file").map((n) => n.id),
    ["file:src/c.ts"],
  );
  const searches = view.nodes.filter((n) => n.kind === "search").map((n) => n.label);
  assert.deepEqual(searches, ["token=•••• — src", "••••", "src/**/*.ts"]);
  assert.equal(repoPath("a.ts:50-90:raw", null), "a.ts");
  assert.equal(repoPath("./x/", null), "x");
  assert.equal(repoPath("../x", null), null);
  assert.equal(repoPath("https://x.example/a", null), null);
  assert.equal(repoPath(`${WORKTREE}`, WORKTREE), ".");
  assert.equal(repoPath("/etc/passwd", null), null);
});

// -- AC-6, AC-7, AC-8 -------------------------------------------------------------------------------------

async function serve(orchestrator: Orchestrator, clients: ClientRegistry) {
  const server = http.createServer(createHandler({ orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: (route: string, token: string) => fetch(`${url}${route}`, { headers: { Authorization: `Bearer ${token}` } }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("session-graph/AC-6 : `GET /v1/runs/{id}/graph` rend {nodes, edges, ambiguities} avec la décision et ses preuves", async () => {
  const { world, run } = await main();
  const clients = new ClientRegistry(path.join(tmpdir("graph-clients-"), "clients.json"), "t".repeat(64));
  const narrow = clients.add("ipad", "viewer", ["demo"]).token;
  const api = await serve(world.orchestrator, clients);
  try {
    const response = await api.get(`/v1/runs/${run.id}/graph`, narrow);
    assert.equal(response.status, 200);
    const body = (await response.json()) as SessionGraphView;
    assert.equal(body.runId, run.id);
    assert.ok(body.version > 0 && body.updatedAt !== null);
    assert.ok(Array.isArray(body.nodes) && Array.isArray(body.edges));
    assert.equal(body.ambiguities[0]?.kind, "decision");
    assert.deepEqual(body.ambiguities[0]?.evidence, ["file:src/a.ts"]);
    const node = body.nodes.find((n) => n.id === "file:src/a.ts") as GraphNode;
    assert.deepEqual(Object.keys(node).sort(), [
      "count",
      "edits",
      "files",
      "grouped",
      "id",
      "kind",
      "label",
      "outcome",
      "parent",
      "path",
      "pattern",
      "reads",
      "step",
    ]);
  } finally {
    await api.close();
  }
});

test("session-graph/AC-7 : un client d'un autre dépôt et un run inconnu reçoivent 404", async () => {
  const { world, run } = await main();
  const clients = new ClientRegistry(path.join(tmpdir("graph-clients-"), "clients.json"), "t".repeat(64));
  const elsewhere = clients.add("autre", "viewer", ["autre"]).token;
  const narrow = clients.add("ipad", "viewer", ["demo"]).token;
  const api = await serve(world.orchestrator, clients);
  try {
    assert.equal((await api.get(`/v1/runs/${run.id}/graph`, elsewhere)).status, 404);
    assert.equal((await api.get("/v1/runs/inconnu/graph", narrow)).status, 404);
  } finally {
    await api.close();
  }
});

test("session-graph/AC-8 : la capacité `session-graph` est annoncée par /v1/health", async () => {
  assert.ok((API_FEATURES as readonly string[]).includes("session-graph"));
  const { world } = await main();
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: "t".repeat(64) }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/health`);
    const body = (await response.json()) as { features: string[] };
    assert.ok(body.features.includes("session-graph"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// -- AC-9 --------------------------------------------------------------------------------------------------

test("session-graph/AC-9 : l'événement `graph` part au plus une fois par intervalle ; le dernier état part toujours ; flush écrit sans pousser", () => {
  const u = unit();
  u.clock(0);
  u.graphs.step(u.run, IMPL);
  for (let i = 0; i < 50; i++) {
    u.clock(i * 2);
    u.tool(IMPL, "read", { path: `src/f${i}.ts` });
  }
  assert.equal(u.sent.length, 1, "le premier envoi part aussitôt, la rafale attend le minuteur");
  u.tick(GRAPH_EVENT_MIN_MS);
  const version = u.graphs.view(u.run.id).version;
  assert.equal(u.sent.length, 2);
  assert.equal(u.sent[1]?.version, version, "le dernier état part");
  assert.equal(u.sent[1]?.at, GRAPH_EVENT_MIN_MS);
  assert.deepEqual(
    [u.sent[1]?.nodes, u.sent[1]?.edges],
    [u.graphs.view(u.run.id).nodes.length, u.graphs.view(u.run.id).edges.length],
  );
  // Une mutation à t < 2 s de l'envoi, puis un flush : l'artefact est écrit tout de suite, l'événement attend.
  u.clock(GRAPH_EVENT_MIN_MS + 100);
  u.tool(IMPL, "read", { path: "src/last.ts" });
  u.clock(GRAPH_EVENT_MIN_MS + 200);
  u.graphs.flush(u.run.id);
  const saved = JSON.parse(u.store.getArtifact(u.run.id, GRAPH_ARTIFACT) as string) as { version: number };
  assert.equal(saved.version, version + 1, "l'état est écrit sans attendre");
  assert.equal(u.sent.length, 2, "l'événement respecte l'intervalle");
  assert.equal(u.timers.filter((t) => !t.cancelled && t.at > GRAPH_EVENT_MIN_MS).length, 1, "le minuteur reste armé");
  u.tick(2 * GRAPH_EVENT_MIN_MS);
  assert.equal(u.sent.length, 3);
  assert.equal(u.sent[2]?.version, version + 1);
  for (let i = 1; i < u.sent.length; i++)
    assert.ok((u.sent[i]?.at ?? 0) - (u.sent[i - 1]?.at ?? 0) >= GRAPH_EVENT_MIN_MS, `intervalle ${i}`);
});

test("session-graph/graphe-éphémère : dans un vrai run, `graph` est éphémère, poussé au dépôt du run, de charge {version, nodes, edges}, jamais au journal", async () => {
  const { world, run, events } = await main();
  const final = world.orchestrator.graphView(run.id).version;
  await waitFor(
    () => events.filter((e) => e.type === "graph").at(-1)?.payload.version === final,
    () => JSON.stringify(events.filter((e) => e.type === "graph").map((e) => e.payload)),
    10_000,
  );
  const graphs = events.filter((e) => e.type === "graph");
  assert.ok(graphs.length >= 1);
  for (const event of graphs) {
    assert.equal(event.ephemeral, true);
    assert.equal(event.runId, run.id);
    assert.equal(event.repo, "demo");
    assert.deepEqual(Object.keys(event.payload).sort(), ["edges", "nodes", "version"]);
    assert.ok(Object.values(event.payload).every((value) => typeof value === "number"));
    assert.ok((event.payload.version as number) > 0);
  }
  for (let i = 1; i < graphs.length; i++)
    assert.ok((graphs[i]?.at ?? 0) - (graphs[i - 1]?.at ?? 0) >= GRAPH_EVENT_MIN_MS - 5, "débit borné");
  assert.ok(EPHEMERAL_EVENTS.has("graph"));
  assert.equal(world.store.eventsSince(0, null, 100_000).filter((e) => e.type === "graph").length, 0);
});

// -- AC-10, AC-31 ------------------------------------------------------------------------------------------

test("session-graph/AC-10 : après un redémarrage, la route rend le même graphe", async () => {
  const { world, run, view } = await main();
  const reborn = new Orchestrator(world.deps);
  assert.deepEqual(reborn.graphView(run.id), view);
});

// -- AC-15 -------------------------------------------------------------------------------------------------

test("session-graph/AC-15 : une preuve citant un fichier regroupé désigne son dossier ; un chemin jamais lu est manquant", () => {
  const u = unit();
  u.graphs.step(u.run, IMPL);
  for (let i = 0; i < 400; i++) u.tool(IMPL, "read", { path: `d${i % 20}/f${i}.ts` });
  const view = u.graphs.view(u.run.id);
  const grouped = view.nodes.find((n) => n.kind === "dir" && n.grouped) as GraphNode;
  assert.ok(grouped);
  const absorbed = Array.from({ length: 400 }, (_, i) => `d${i % 20}/f${i}.ts`).find(
    (p) => !byId(view, `file:${p}`) && p.startsWith(`${grouped.path}/`),
  ) as string;
  assert.deepEqual(u.graphs.resolve(u.run, [absorbed]), { ok: true, nodes: [grouped.id] });
  assert.deepEqual(u.graphs.resolve(u.run, ["d0/jamais.ts", "d0/f0.ts:12"]), {
    ok: false,
    missing: ["d0/jamais.ts"],
  });
});

test("session-graph/borne-long-run : borne sur un long run — recherches fondues par étape, preuve suivie jusqu'à son absorbant", () => {
  const u = unit();
  const [impl, review, fix] = [
    { id: 1, kind: "impl" },
    { id: 2, kind: "review" },
    { id: 3, kind: "fix" },
  ] as const;
  u.graphs.step(u.run, impl);
  for (let k = 1; k <= 5; k++) for (let f = 0; f < 10; f++) u.tool(impl, "read", { path: `pkg/d${k}/f${f}.ts` });
  for (let i = 0; i < 100; i++) {
    u.tool(impl, "grep", { pattern: `m-${i}` });
    if (i === 9) u.graphs.decision(u.run, impl, { kind: "decision", seq: 1 }, "q", ["m-3"]);
  }
  u.graphs.step(u.run, review);
  for (let i = 100; i < 200; i++) u.tool(review, "grep", { pattern: `m-${i}` });
  u.graphs.step(u.run, fix);
  for (let i = 200; i < 300; i++) u.tool(fix, "grep", { pattern: `m-${i}` });
  const view = u.graphs.view(u.run.id);
  assert.ok(view.nodes.length <= GRAPH_NODES_MAX);
  for (let k = 1; k <= 5; k++) assert.equal(byId(view, `dir:pkg/d${k}`)?.grouped, true, `dir:pkg/d${k}`);
  assert.equal(byId(view, "dir:."), undefined);
  assert.ok(byId(view, "search:1:*"));
  assert.equal(byId(view, "search:1:*")?.step, "step:1");
  assert.deepEqual(view.ambiguities[0]?.evidence, ["search:1:*"]);
  assert.deepEqual(u.graphs.resolve(u.run, ["m-3"]), { ok: true, nodes: ["search:1:*"] });
  assert.deepEqual(u.graphs.resolve(u.run, ["pkg/d1/f0.ts"]), { ok: true, nodes: ["dir:pkg/d1"] });
  assertClosed(view);
});

test("session-graph/borne-290-étapes : borne sur 290 étapes — la recherche citée reste, les autres recherches puis les tests partent", () => {
  const u = unit();
  u.graphs.step(u.run, { id: 1, kind: "impl" });
  u.tool({ id: 1, kind: "impl" }, "grep", { pattern: "s-0" });
  u.graphs.decision(u.run, { id: 1, kind: "impl" }, { kind: "decision", seq: 1 }, "q", ["s-0"]);
  for (let n = 1; n <= 290; n++) {
    const step = { id: n, kind: "impl" } as const;
    if (n > 1) u.graphs.step(u.run, step);
    if (n > 1) u.tool(step, "grep", { pattern: `s-${n - 1}` });
    u.graphs.test(u.run.id, step, "touched", null, "pass");
  }
  const view = u.graphs.view(u.run.id);
  assert.ok(view.nodes.length <= GRAPH_NODES_MAX, `${view.nodes.length} nœuds`);
  assert.equal(view.nodes.filter((n) => n.kind === "step").length, 290, "les étapes ne sont jamais retirées");
  const cited = view.nodes.find((n) => n.kind === "search" && n.pattern === "s-0") as GraphNode;
  assert.ok(cited);
  assert.ok(edgeOf(view, "evidence", "decision:1", cited.id));
  assert.equal(u.graphs.resolve(u.run, ["s-5"]).ok, false, "une recherche retirée ne se résout plus");
  assertClosed(view);
});

test("session-graph/preuve-fondue : preuve fondue pendant la décision — l'arc vise l'absorbant ; une preuve retirée ne laisse aucun arc", () => {
  const u = unit();
  u.graphs.step(u.run, IMPL);
  u.tool(IMPL, "read", { path: "src/a.ts" });
  assert.deepEqual(u.graphs.resolve(u.run, ["src/a.ts"]), { ok: true, nodes: ["file:src/a.ts"] });
  for (let k = 0; k < 300; k++) u.tool(IMPL, "read", { path: `src/f${k}.ts` });
  u.graphs.decision(u.run, IMPL, { kind: "decision", seq: 1 }, "q", ["src/a.ts"]);
  let view = u.graphs.view(u.run.id);
  assert.ok(edgeOf(view, "evidence", "decision:1", "dir:src"));
  assert.deepEqual(view.ambiguities[0]?.evidence, ["dir:src"]);
  assertClosed(view);
  u.tool(IMPL, "grep", { pattern: "zz" });
  assert.equal(u.graphs.resolve(u.run, ["zz"]).ok, true);
  for (let n = 2; n <= 151; n++) {
    const step = { id: n, kind: "fix" } as const;
    u.graphs.step(u.run, step);
    u.graphs.test(u.run.id, step, "touched", null, "pass");
  }
  assert.equal(u.graphs.resolve(u.run, ["zz"]).ok, false, "la borne a retiré la recherche");
  u.graphs.decision(u.run, IMPL, { kind: "decision", seq: 2 }, "q2", ["zz"]);
  view = u.graphs.view(u.run.id);
  assert.deepEqual(view.ambiguities[1], { node: "decision:2", kind: "decision", evidence: [] });
  assert.ok(u.warnings.some((line) => line.includes("decision:2")));
  assert.ok(view.nodes.length <= GRAPH_NODES_MAX);
  assertClosed(view);
});

// -- AC-29, AC-30 ------------------------------------------------------------------------------------------

test("session-graph/AC-29 : la route, l'événement et la capacité sont déclarés (README, apiRoutes, API_FEATURES, EVENT_TYPES)", () => {
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
  assert.ok(routes.some((r) => r.method === "GET" && r.path === "/v1/runs/{id}/graph"));
  assert.ok(readme.includes("`GET /v1/runs/{id}/graph`"));
  assert.ok(readme.includes("session-graph"));
  assert.ok((API_FEATURES as readonly string[]).includes("session-graph"));
  assert.ok((EVENT_TYPES as readonly string[]).includes("graph"));
  assert.ok(EPHEMERAL_EVENTS.has("graph"));
});

test("session-graph/AC-30 : `evidence` est validée par planDecision ; une preuve absente du graphe refuse la décision, sans preuve elle passe", async () => {
  const base = {
    question: "Où stocker la date d'export ?",
    context: CONTEXT,
    options: ["colonne", "table"],
    chosen: "colonne",
    rationale: "une seule lecture",
    category: "reversible",
  };
  const parse = (raw: unknown) => planDecision(raw);
  assert.equal(parse({ ...base, evidence: "x" }).ok, false);
  assert.equal(parse({ ...base, evidence: Array.from({ length: EVIDENCE_MAX + 1 }, (_, i) => `f${i}`) }).ok, false);
  assert.equal(parse({ ...base, evidence: [""] }).ok, false);
  const ok = parse({ ...base, evidence: ["a.ts", "a.ts", " b.ts "] });
  assert.deepEqual(ok.ok && ok.plan.input.evidence, ["a.ts", "b.ts"]);
  const bare = parse(base);
  assert.deepEqual(bare.ok && bare.plan.input.evidence, []);

  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [
      [
        ...frames("t1", "read", { path: "src/a.ts" }),
        { tool: "decision", args: { ...base, evidence: ["nulle/part.ts"] } },
        { tool: "decision", args: base },
        ...OK.impl,
      ],
    ],
    review: [OK.review],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Preuve", request: "Exporter" });
    await waitFor(
      () => ["merged", "failed", "awaiting_human", "escalated"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => String(world.store.getRun(run.id)?.state),
      30_000,
    );
    const results = world
      .log()
      .filter((entry) => entry.kind === "tool" && entry.tool === "decision")
      .map((entry) => String(entry.result));
    assert.match(results[0] ?? "", /décision refusée : preuve absente du graphe du run/);
    assert.match(results[1] ?? "", /décision #1 enregistrée/);
    assert.equal(world.store.listDecisions({ runId: run.id }).length, 1);
    const view = world.orchestrator.graphView(run.id);
    assert.equal(view.nodes.filter((n) => n.kind === "decision").length, 1, "la décision refusée n'a pas de nœud");
    assert.deepEqual(view.ambiguities[0]?.evidence, []);
  } finally {
    await world.orchestrator.stop();
  }
});

test("session-graph/AC-31 : le graphe survit à la purge du direct — il vient de l'artefact, arc evidence compris", async () => {
  const { world, run, view } = await main();
  assert.ok(view.edges.some((e) => e.kind === "evidence"));
  await world.orchestrator.stop();
  world.store.pruneSessions(Date.now() + 1);
  const reborn = new Orchestrator(world.deps);
  assert.deepEqual((reborn.sessionView(run.id) as { entries: unknown[] }).entries, []);
  assert.deepEqual(reborn.graphView(run.id), view);
  const clients = new ClientRegistry(path.join(tmpdir("graph-clients-"), "clients.json"), "t".repeat(64));
  const token = clients.add("ipad", "viewer", ["demo"]).token;
  const api = await serve(reborn, clients);
  try {
    const served = (await (await api.get(`/v1/runs/${run.id}/graph`, token)).json()) as SessionGraphView;
    assert.deepEqual(served, view);
  } finally {
    await api.close();
  }
});

// -- la carte de décision d'une escalade (AC-11 à AC-22, AC-27 à AC-29) ------------------------------------

type Escalated = { world: FakeWorld; run: RunRow; escalations: EscalationRow[]; events: EventRow[] };

/** Un run dont /impl lit `src/a.ts`, puis joue `calls` (par défaut : une escalade conforme) ; `check` lit le résultat. */
async function withEscalation(
  opts: {
    calls?: Record<string, unknown>[];
    before?: Record<string, unknown>[];
    carte?: unknown[][];
    patch?: (config: HarnessConfig) => void;
  },
  check: (seen: Escalated) => Promise<void> | void,
): Promise<void> {
  const calls = opts.calls ?? [{ tool: "decision", args: escalationArgs() }];
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [[...(opts.before ?? readFrames()), ...calls, ...OK.impl], OK.impl],
      review: [OK.review],
      ...(opts.carte ? { carte: opts.carte } : {}),
    },
    { patch: opts.patch ?? (() => {}) },
  );
  const events: EventRow[] = [];
  world.store.onEvent((event) => events.push(event));
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Carte", request: "Exporter" });
    await waitFor(
      () => ["escalated", "merged", "failed", "awaiting_human"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => String(world.store.getRun(run.id)?.state),
      40_000,
    );
    await check({ world, run, escalations: world.store.listEscalations({ runId: run.id }), events });
  } finally {
    await world.orchestrator.stop();
  }
}

const decisionResults = (world: FakeWorld): string[] =>
  world
    .log()
    .filter((entry) => entry.kind === "tool" && entry.tool === "decision")
    .map((entry) => String(entry.result));

const WORDS_16 = "un deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize";

test("session-graph/AC-11 : une headline de plus de 15 mots, avec un chemin ou du code, est refusée en nommant la règle, sans escalade", async () => {
  const refusal = (headline: string): string => {
    const parsed = planDecision(escalationArgs({ headline }));
    return parsed.ok ? "" : parsed.error;
  };
  assert.match(refusal(WORDS_16), /15 mots au plus/);
  assert.equal(refusal(WORDS_16.split(" ").slice(0, 15).join(" ")), "", "quinze mots passent");
  assert.match(refusal("Faut-il changer src/api/export.ts maintenant ?"), /pas de chemin de fichier/);
  assert.match(refusal("Faut-il changer export.ts ?"), /pas de chemin de fichier/);
  assert.match(refusal("Que faire de `exportedAt` ?"), /pas de `code`/);
  assert.match(refusal("Que faire de exportedAt ?"), /pas de `code`/);
  assert.equal(refusal(CARD_FIELDS.headline), "");
  await withEscalation(
    { calls: [{ tool: "decision", args: escalationArgs({ headline: WORDS_16 }) }] },
    ({ world, escalations }) => {
      assert.equal(escalations.length, 0, "aucune escalade n'est créée");
      assert.match(decisionResults(world)[0] ?? "", /décision refusée : headline : 15 mots au plus/);
    },
  );
});

test("session-graph/AC-12 : un stake ou un established absent ou sur plusieurs lignes, une option sans impact ni reversible, un cost inconnu sont refusés", () => {
  const refusal = (extra: Record<string, unknown>): string => {
    const parsed = planDecision(escalationArgs(extra));
    return parsed.ok ? "" : parsed.error;
  };
  const [first, second] = CARD_FIELDS.options as unknown as [Record<string, unknown>, Record<string, unknown>];
  assert.match(refusal({ stake: undefined }), /stake est requis/);
  assert.match(refusal({ stake: "une ligne\nune autre" }), /stake tient sur une seule ligne/);
  assert.match(refusal({ established: "" }), /established est requis/);
  assert.match(refusal({ established: "a\nb" }), /established tient sur une seule ligne/);
  assert.match(refusal({ options: [{ ...first, impact: undefined }, second] }), /impact est requis/);
  assert.match(refusal({ options: [{ ...first, impact: "  " }, second] }), /impact est requis/);
  assert.match(refusal({ options: [first, { ...second, reversible: undefined }] }), /reversible est requis/);
  assert.match(refusal({ options: [first, { ...second, reversible: "oui" }] }), /reversible est requis/);
  assert.match(refusal({ options: [{ ...first, cost: "énorme" }, second] }), /cost vaut faible \| moyen \| fort/);
  assert.match(refusal({ confidence: "certaine" }), /confidence/);
  assert.match(refusal({ recommended: "autre" }), /recommended/);
  for (const cost of ["faible", "moyen", "fort"]) assert.equal(refusal({ options: [{ ...first, cost }, second] }), "");
});

test("session-graph/AC-13 : une escalade sans evidence, ou dont une evidence n'est pas dans le graphe du run, est refusée", async () => {
  const parsed = planDecision(escalationArgs({ evidence: [] }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /au moins une preuve/);
  await withEscalation(
    { calls: [{ tool: "decision", args: escalationArgs({ evidence: ["src/a.ts", "nulle/part.ts"] }) }] },
    ({ world, escalations }) => {
      assert.equal(escalations.length, 0);
      assert.match(
        decisionResults(world)[0] ?? "",
        /décision refusée : preuve absente du graphe du run : « nulle\/part\.ts »/,
      );
    },
  );
});

test("session-graph/AC-14 : une décision déclarée réversible qui trahit un schéma, sans carte, est refusée : elle serait escaladée", async () => {
  const base = {
    question: "Nettoyer l'ancienne colonne ?",
    context: CARD_CONTEXT,
    options: ["la garder", "la supprimer"],
    chosen: "la garder",
    rationale: "on fait DROP COLUMN legacy",
    category: "reversible",
  };
  const parsed = planDecision(base);
  assert.equal(parsed.ok, false);
  assert.match(
    parsed.ok ? "" : parsed.error,
    /déclarée réversible mais classée schema par le service : elle sera escaladée/,
  );
  assert.match(parsed.ok ? "" : parsed.error, /exige sa carte/);
  await withEscalation({ calls: [{ tool: "decision", args: base }] }, ({ world, escalations }) => {
    assert.equal(escalations.length, 0);
    assert.equal(world.store.listDecisions({ runId: world.store.listRuns()[0]?.id as string }).length, 0);
    assert.match(decisionResults(world)[0] ?? "", /sera escaladée/);
  });
});

test("session-graph/carte-preuve-regroupée : une carte dont la preuve cite un fichier regroupé dans son dossier est acceptée, l'arc evidence visant le dossier", async () => {
  const reads = Array.from({ length: 350 }, (_, n) =>
    readFrames(`d${Math.floor(n / 50)}/f${n % 50}.ts`, `rd${n}`),
  ).flat();
  await withEscalation(
    { before: reads, calls: [{ tool: "decision", args: escalationArgs({ evidence: ["d0/f0.ts"] }) }] },
    ({ world, run, escalations }) => {
      assert.equal(escalations.length, 1, "acceptée");
      const view = world.orchestrator.graphView(run.id);
      assert.ok(view.nodes.length <= GRAPH_NODES_MAX);
      const dir = byId(view, "dir:d0");
      assert.equal(dir?.grouped, true, "d0 a été regroupé par la borne");
      assert.ok(!byId(view, "file:d0/f0.ts"), "son fichier est absorbé");
      const id = `escalation:${escalations[0]?.id}`;
      assert.ok(edgeOf(view, "evidence", id, "dir:d0"));
      assert.deepEqual(view.ambiguities[0], { node: id, kind: "escalation", evidence: ["dir:d0"] });
      assertClosed(view);
    },
  );
});

let cardRun: Promise<Escalated> | null = null;

/** L'escalade conforme d'un vrai run, posée une fois pour les tests qui lisent sa carte. */
function cardMain(): Promise<Escalated> {
  cardRun ??= new Promise<Escalated>((resolve, reject) => {
    withEscalation({}, (seen) => resolve(seen)).catch(reject);
  });
  return cardRun;
}

test("session-graph/AC-16 : une escalade conforme porte card ; question = headline, options = les libellés, context = le détail ; l'API la rend", async () => {
  const { world, run, escalations } = await cardMain();
  const item = escalations[0] as EscalationRow;
  const card = item.card;
  assert.ok(card, "la carte est gardée avec l'escalade");
  assert.deepEqual(Object.keys(card).sort(), [
    "confidence",
    "headline",
    "options",
    "recommended",
    "reviewed",
    "schema",
    "stake",
  ]);
  assert.equal(card.headline, CARD_FIELDS.headline);
  assert.equal(card.stake, CARD_FIELDS.stake);
  assert.deepEqual(card.options, CARD_FIELDS.options);
  assert.equal(card.recommended, "colonne");
  assert.equal(card.confidence, "moyenne");
  assert.equal(card.reviewed, false, "relecteur coupé : non relue");
  assert.equal(item.question, CARD_FIELDS.headline);
  assert.deepEqual(item.options, ["colonne", "table"]);
  assert.equal(item.context, CARD_CONTEXT);
  assert.equal(item.recommended, "colonne");
  // Elle se relit après un redémarrage (artefact interne), et l'artefact reste caché de l'API.
  assert.deepEqual(new Orchestrator(world.deps).runView(run.id).escalations, escalations);
  const artifacts = (world.orchestrator.runView(run.id).artifacts as { name: string }[]).map((a) => a.name);
  assert.ok(artifacts.every((name) => !name.startsWith("_")));
  const clients = new ClientRegistry(path.join(tmpdir("card-clients-"), "clients.json"), "t".repeat(64));
  const token = clients.add("ipad", "viewer", ["demo"]).token;
  const api = await serve(world.orchestrator, clients);
  try {
    for (const route of ["/v1/escalations", "/v1/inbox"]) {
      const body = (await (await api.get(route, token)).json()) as {
        batches: { items: { id: number; card: unknown; question: string }[] }[];
      };
      const served = body.batches[0]?.items[0];
      assert.deepEqual(served?.card, card, route);
      assert.equal(served?.question, CARD_FIELDS.headline, route);
    }
  } finally {
    await api.close();
  }
});

test("session-graph/AC-17 : le schéma d'une carte à 4 options tient en 12 nœuds au plus : établi → ambiguïté → options → impacts, sans image", () => {
  const options = ["a", "b", "c", "d"].map((label) => ({
    label,
    impact: `Conséquence de ${label}.`,
    reversible: label !== "a",
  }));
  const parsed = planDecision(escalationArgs({ options, recommended: "b" }));
  assert.ok(parsed.ok && parsed.plan.kind === "escalate");
  const card = buildCard(parsed.plan.input.card as NonNullable<typeof parsed.plan.input.card>, false);
  const { nodes, edges } = card.schema;
  assert.ok(nodes.length <= 12);
  assert.deepEqual(
    nodes.map((n) => n.kind),
    ["established", "ambiguity", "option", "impact", "option", "impact", "option", "impact", "option", "impact"],
  );
  assert.equal(nodes[0]?.label, CARD_FIELDS.established, "le nœud établi porte established");
  assert.equal(nodes[1]?.label, CARD_FIELDS.headline, "l'ambiguïté porte la headline");
  assert.deepEqual(
    nodes.filter((n) => n.kind === "option").map((n) => [n.label, n.recommended]),
    [
      ["a", false],
      ["b", true],
      ["c", false],
      ["d", false],
    ],
  );
  assert.deepEqual(
    nodes.filter((n) => n.kind === "impact").map((n) => n.label),
    options.map((o) => o.impact),
  );
  const ids = new Set(nodes.map((n) => n.id));
  assert.equal(ids.size, nodes.length);
  assert.deepEqual(edges[0], { from: nodes[0]?.id, to: nodes[1]?.id });
  for (const edge of edges) assert.ok(ids.has(edge.from) && ids.has(edge.to));
  const optionIds = nodes.filter((n) => n.kind === "option").map((n) => n.id);
  assert.deepEqual(
    edges.filter((e) => e.from === "ambiguity").map((e) => e.to),
    optionIds,
  );
  assert.equal(edges.length, 1 + 2 * options.length, "établi → ambiguïté, puis option → impact par option");
  assert.ok(!/image|mermaid|svg/i.test(JSON.stringify(card)));
});

const REWRITE = {
  headline: "Faut-il une colonne ou une table pour la date ?",
  stake: "Sans réponse, les exports restent impossibles à dater.",
  impacts: ["Une migration, puis une lecture simple.", CARD_FIELDS.options[1]?.impact],
};
const READER_ON = (config: HarnessConfig): void => {
  config.review.cardReader = true;
};

test("session-graph/AC-18 : le relecteur réécrit headline, stake et un impact, jamais les options ni la recommandation ; reviewed vaut true", async () => {
  const tentative = {
    ...REWRITE,
    options: [{ label: "autre", impact: "x", reversible: true }],
    recommended: "table",
    confidence: "forte",
  };
  await withEscalation(
    { carte: [[{ tool: "card_review", args: tentative }]], patch: READER_ON },
    ({ world, escalations }) => {
      const item = escalations[0] as EscalationRow;
      const card = item.card as NonNullable<EscalationRow["card"]>;
      assert.equal(card.reviewed, true);
      assert.equal(card.headline, REWRITE.headline);
      assert.equal(card.stake, REWRITE.stake);
      assert.equal(card.options[0]?.impact, REWRITE.impacts[0]);
      assert.deepEqual(
        card.options.map((o) => [o.label, o.reversible, o.cost]),
        [
          ["colonne", false, "moyen"],
          ["table", true, undefined],
        ],
      );
      assert.equal(card.recommended, "colonne");
      assert.equal(card.confidence, "moyenne");
      assert.equal(item.question, REWRITE.headline, "question = la headline relue");
      assert.deepEqual(item.options, ["colonne", "table"]);
      assert.equal(card.schema.nodes[1]?.label, REWRITE.headline, "le schéma suit la carte relue");
      assert.ok(world.log().some((entry) => entry.kind === "prompt" && entry.step === "carte"));
    },
  );
});

test("session-graph/AC-19 : une réécriture de plus de 15 mots ou avec un chemin est jetée : la carte de l'agent part inchangée, reviewed false", async () => {
  for (const bad of [{ headline: WORDS_16 }, { headline: "Que faire de src/a.ts ?", stake: "Un enjeu." }]) {
    await withEscalation(
      { carte: [[{ tool: "card_review", args: bad }]], patch: READER_ON },
      ({ world, escalations }) => {
        const card = escalations[0]?.card as NonNullable<EscalationRow["card"]>;
        assert.equal(card.reviewed, false);
        assert.equal(card.headline, CARD_FIELDS.headline);
        assert.equal(card.stake, CARD_FIELDS.stake);
        assert.ok(
          world.log().some((entry) => entry.kind === "prompt" && entry.step === "carte"),
          "le relecteur a bien lu",
        );
      },
    );
  }
});

test("session-graph/AC-20 : un relecteur en échec ou en retard ne retarde pas l'escalade au-delà de sa borne ; carte inchangée, reviewed false", async () => {
  for (const carte of [[[{ sleep: 60_000 }]], [[{ error: { message: "modèle indisponible", httpStatus: 400 } }]]]) {
    const start = Date.now();
    await withEscalation(
      {
        carte,
        patch: (config) => {
          config.review.cardReader = true;
          config.review.cardReaderSec = 2;
        },
      },
      ({ escalations }) => {
        const card = escalations[0]?.card as NonNullable<EscalationRow["card"]>;
        assert.equal(card.reviewed, false);
        assert.equal(card.headline, CARD_FIELDS.headline);
        assert.deepEqual(card.options, CARD_FIELDS.options);
        assert.ok(Date.now() - start < 30_000, "l'étape n'a pas attendu le relecteur au-delà de sa borne");
      },
    );
  }
});

test("session-graph/AC-21 : review.cardReader false : aucun modèle n'est appelé, reviewed vaut false", async () => {
  await withEscalation(
    {
      carte: [[{ tool: "card_review", args: REWRITE }]],
      patch: (config) => {
        config.review.cardReader = false;
      },
    },
    ({ world, escalations }) => {
      const card = escalations[0]?.card as NonNullable<EscalationRow["card"]>;
      assert.equal(card.reviewed, false);
      assert.equal(card.headline, CARD_FIELDS.headline);
      assert.ok(!world.log().some((entry) => entry.step === "carte"), "aucun prompt du relecteur");
    },
  );
});

test("session-graph/AC-22 : un client ancien lit toujours question, options (des textes) et context, avec leurs types d'avant", async () => {
  const { world, run } = await cardMain();
  const view = world.orchestrator.runView(run.id) as { escalations: Record<string, unknown>[] };
  const old = view.escalations[0] as Record<string, unknown>;
  assert.equal(typeof old.question, "string");
  assert.ok(Array.isArray(old.options) && old.options.every((option) => typeof option === "string"));
  assert.equal(typeof old.context, "string");
  assert.ok(Array.isArray(old.impacts) && old.impacts.every((impact) => typeof impact === "string"));
  assert.equal(typeof old.recommended, "string");
});

// -- notification d'un lot d'escalades (AC-27, AC-28) -------------------------------------------------------

function batch(count: number) {
  return {
    id: 1,
    at: Date.now(),
    runId: "r1",
    repo: "demo",
    type: "escalations" as const,
    payload: {
      step: "impl",
      items: Array.from({ length: count }, (_, n) => ({
        id: n + 1,
        category: "schema",
        question: n === 0 ? CARD_FIELDS.headline : `Autre question ${n} ?`,
        options: ["colonne", "table"],
        stake: n === 0 ? CARD_FIELDS.stake : `Autre enjeu ${n}.`,
      })),
    },
  };
}

function pushStore(): Store {
  const store = new Store(":memory:");
  store.createRun({ id: "r1", repo: "demo", slug: "r1", title: "Export daté", request: "x", branch: "b" });
  return store;
}

test("session-graph/AC-27 : la notification d'une escalade (ntfy, webhook, alerte push) a pour titre la headline et pour corps le stake, rien d'autre", () => {
  const run = { repo: "demo", title: "Export daté src/a.ts", step: "impl" } as Parameters<typeof notificationFor>[1];
  const ntfy = notificationFor(batch(1), run);
  assert.equal(ntfy?.title, CARD_FIELDS.headline);
  assert.equal(ntfy?.body, CARD_FIELDS.stake);
  const store = pushStore();
  try {
    const alert = alertFor(batch(1), store);
    assert.equal(alert?.title, CARD_FIELDS.headline);
    assert.equal(alert?.body, CARD_FIELDS.stake);
    for (const text of [JSON.stringify(ntfy), JSON.stringify(alert)])
      assert.ok(!/colonne|table|src\/|Export daté/.test(text.replace(CARD_FIELDS.headline, "")), text);
  } finally {
    store.close();
  }
  // Une escalade antérieure aux cartes garde la notification d'avant : jamais sa question brute.
  const old = batch(1);
  (old.payload.items[0] as { stake: string | null }).stake = null;
  assert.equal(notificationFor(old, run)?.title, "Question — demo · Export daté src/a.ts");
});

test("session-graph/AC-28 : un lot de trois escalades dit la première, suivie de « · +2 autres questions », en une seule notification", () => {
  const run = { repo: "demo", title: "Export daté", step: "impl" } as Parameters<typeof notificationFor>[1];
  const suffix = " · +2 autres questions";
  assert.deepEqual(
    [notificationFor(batch(3), run)?.title, notificationFor(batch(3), run)?.body],
    [CARD_FIELDS.headline, `${CARD_FIELDS.stake}${suffix}`],
  );
  assert.equal(notificationFor(batch(2), run)?.body, `${CARD_FIELDS.stake} · +1 autre question`);
  const store = pushStore();
  try {
    const alert = alertFor(batch(3), store);
    assert.equal(alert?.title, CARD_FIELDS.headline);
    assert.equal(alert?.body, `${CARD_FIELDS.stake}${suffix}`);
  } finally {
    store.close();
  }
});

test("session-graph/lot-émis : le lot réellement émis par un run porte question = headline et stake", async () => {
  const { events } = await cardMain();
  const lot = events.find((event) => event.type === "escalations");
  const items = lot?.payload.items as { question: string; stake: string }[];
  assert.deepEqual([items[0]?.question, items[0]?.stake], [CARD_FIELDS.headline, CARD_FIELDS.stake]);
});

// -- la carte en tête des specs à valider et d'un arbitrage (AC-23 à AC-26, AC-32, AC-33) --------------------

const FEATURE = "exporter les données au format CSV.";
const EMPTY_BRIEFING: Briefing = { feature: "", cards: [] };

const SPECS_ON = (config: HarnessConfig): void => {
  config.review.specsGate = true;
};

/** Une décision réversible avec sa carte (sans preuve : elle reste facultative hors escalade). */
const cardDecision = (headline: string, labels: [string, string]) => ({
  tool: "decision",
  args: escalationArgs({
    headline,
    category: "reversible",
    evidence: [],
    options: labels.map((label) => ({ label, impact: `Choisir ${label}.`, reversible: true })),
    recommended: labels[0],
  }),
});

test("session-graph/AC-23 : la clôture de /specs est refusée sans la ligne « Ce que fait cette feature »", async () => {
  const bare = (OK.specs[0]?.content ?? "").replace(/^Ce que fait cette feature.*\n/, "");
  assert.ok(!bare.includes("Ce que fait"));
  const world = fakeWorld({ req: [OK.req], specs: [[{ write: ".harness/specs.md", content: bare }]] });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Sans ligne", request: "Exporter" });
    await waitFor(
      () => ["awaiting_human", "failed", "merged"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => String(world.store.getRun(run.id)?.state),
      30_000,
    );
    const nudge = world
      .log()
      .filter((entry) => entry.kind === "prompt" && entry.step === "specs")
      .map((entry) => String(entry.message))
      .find((message) => message.includes("n'est pas terminée"));
    assert.match(nudge ?? "", /Ce que fait cette feature/);
    const specs = world.store.listSteps(run.id).filter((step) => step.kind === "specs");
    assert.ok(specs.length > 0 && specs.every((step) => step.status !== "done"), "aucune clôture de /specs");
    assert.ok(!world.store.listSteps(run.id).some((step) => step.kind === "impl"), "/impl n'a pas démarré");
  } finally {
    await world.orchestrator.stop();
  }
});

test("session-graph/AC-24 : en /req et /specs une décision exige sa carte (sans preuve) ; en /impl une décision réversible sans carte passe", async () => {
  const bare = {
    question: "Quel séparateur ?",
    context: CARD_CONTEXT,
    options: ["virgule", "point-virgule"],
    chosen: "virgule",
    rationale: "le plus courant",
    category: "reversible",
  };
  const refused = planDecision(bare, { cardRequired: true });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /la carte est requise pour toute décision de \/req et \/specs/);
  assert.equal(planDecision(bare).ok, true, "hors /req et /specs, la carte reste facultative");
  const carded = cardDecision("Quel séparateur pour le CSV ?", ["virgule", "point-virgule"]);
  assert.equal(planDecision(carded.args, { cardRequired: true }).ok, true);
  const world = fakeWorld({
    req: [[{ tool: "decision", args: bare }, carded, ...OK.req]],
    specs: [OK.specs],
    impl: [[{ tool: "decision", args: bare }, ...OK.impl]],
    review: [OK.review],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Cartes", request: "Exporter" });
    await waitFor(
      () => ["merged", "failed", "awaiting_human", "escalated"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => String(world.store.getRun(run.id)?.state),
      40_000,
    );
    const results = decisionResults(world);
    assert.match(results[0] ?? "", /décision refusée : la carte est requise/);
    assert.match(results[1] ?? "", /décision #1 enregistrée/, "carte conforme sans evidence : acceptée");
    assert.match(results[2] ?? "", /décision #2 enregistrée/, "en /impl, sans carte : acceptée");
  } finally {
    await world.orchestrator.stop();
  }
});

test("session-graph/AC-25 : des specs à valider s'ouvrent sur la ligne de la feature et une carte par décision et escalade de /req et /specs, au même endroit dans le run et l'inbox", async () => {
  const world = fakeWorld(
    {
      req: [
        [
          ...readFrames(),
          cardDecision("Quel séparateur pour le CSV ?", ["virgule", "point-virgule"]),
          { tool: "decision", args: escalationArgs() },
          ...OK.req,
        ],
        OK.req,
      ],
      specs: [[cardDecision("Faut-il un en-tête dans le CSV ?", ["avec", "sans"]), ...OK.specs]],
    },
    { patch: SPECS_ON },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter" });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "escalated",
      () => String(world.store.getRun(run.id)?.state),
      30_000,
    );
    const open = world.store.listEscalations({ runId: run.id, status: "open" });
    await world.orchestrator.answerEscalations(run.id, [{ id: open[0]?.id as number, answer: "table" }]);
    await waitFor(
      () => world.store.getRun(run.id)?.state === "awaiting_human",
      () => String(world.store.getRun(run.id)?.state),
      30_000,
    );
    const viewed = world.orchestrator.runView(run.id) as { run: { briefing: Briefing }; artifacts: { name: string }[] };
    const { briefing } = viewed.run;
    assert.equal(briefing.feature, FEATURE);
    assert.deepEqual(
      briefing.cards.map((card) => card.headline),
      ["Quel séparateur pour le CSV ?", "Faut-il un en-tête dans le CSV ?", CARD_FIELDS.headline],
    );
    for (const card of briefing.cards) {
      assert.deepEqual(Object.keys(card).sort(), [
        "confidence",
        "headline",
        "options",
        "recommended",
        "reviewed",
        "schema",
        "stake",
      ]);
      assert.ok(card.schema.nodes.length <= 12);
    }
    assert.ok(
      viewed.artifacts.some((artifact) => artifact.name === "specs.md"),
      "le document complet suit",
    );
    const inbox = world.orchestrator.inboxView() as { awaiting: { id: string; briefing: Briefing }[] };
    assert.deepEqual(
      inbox.awaiting.find((entry) => entry.id === run.id)?.briefing,
      briefing,
      "même forme dans l'inbox",
    );
  } finally {
    await world.orchestrator.stop();
  }

  // Sans décision ni raison de porte : la liste est vide ; un run qui n'attend rien a un briefing vide.
  const quiet = fakeWorld({ req: [OK.req], specs: [OK.specs] }, { patch: SPECS_ON });
  await quiet.orchestrator.start();
  try {
    const run = await quiet.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter" });
    await waitFor(
      () => quiet.store.getRun(run.id)?.state === "awaiting_human",
      () => String(quiet.store.getRun(run.id)?.state),
      30_000,
    );
    const view = quiet.orchestrator.runView(run.id) as { run: { briefing: Briefing } };
    assert.deepEqual(view.run.briefing, { feature: FEATURE, cards: [] });
    const idle = quiet.store.createRun({
      id: "idle",
      repo: "demo",
      slug: "idle",
      title: "Au repos",
      request: "x",
      branch: "b",
    });
    assert.deepEqual(
      (quiet.orchestrator.runView(idle.id) as { run: { briefing: Briefing } }).run.briefing,
      EMPTY_BRIEFING,
    );
  } finally {
    await quiet.orchestrator.stop();
  }
});

const BLOCKERS = ["Le CSV n'échappe pas les guillemets", "Aucun test ne couvre l'export vide"];

const withBlockers = OK.review.map((step) =>
  step.tool === "review_verdict" ? { ...step, args: { ...step.args, blockers: BLOCKERS } } : step,
);

/** Un run arrêté au plafond de corrections avec deux bloquants, jusqu'à `awaiting_human` ; `check` lit son briefing. */
async function arbitrated(
  opts: { request?: string; carte?: unknown[][]; patch?: (config: HarnessConfig) => void; direct?: boolean },
  check: (seen: { briefing: Briefing; inbox: Briefing | undefined; title: string }) => void,
): Promise<void> {
  const world = fakeWorld(
    {
      ...(opts.direct ? {} : { req: [OK.req], specs: [OK.specs] }),
      impl: [OK.impl],
      review: [withBlockers],
      ...(opts.carte ? { carte: opts.carte } : {}),
    },
    {
      patch: (config) => {
        config.review.fixCap = 0;
        opts.patch?.(config);
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({
      repo: "demo",
      title: "Export arbitré",
      request: opts.request ?? "Exporter",
    });
    await waitFor(
      () => ["awaiting_human", "merged", "failed"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => String(world.store.getRun(run.id)?.state),
      40_000,
    );
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human");
    const viewed = world.orchestrator.runView(run.id) as { run: { briefing: Briefing } };
    const inbox = (world.orchestrator.inboxView() as { awaiting: { id: string; briefing: Briefing }[] }).awaiting.find(
      (entry) => entry.id === run.id,
    );
    check({ briefing: viewed.run.briefing, inbox: inbox?.briefing, title: "Export arbitré" });
  } finally {
    await world.orchestrator.stop();
  }
}

test("session-graph/AC-26 : un arbitrage s'ouvre sur la ligne de la feature et une carte « valider malgré » / « corriger encore » par bloquant ; relecteur en échec : le texte du bloquant, reviewed false", async () => {
  await arbitrated({}, ({ briefing, inbox }) => {
    assert.equal(briefing.feature, FEATURE);
    assert.equal(briefing.cards.length, 2);
    for (const [index, card] of briefing.cards.entries()) {
      assert.deepEqual(
        card.options.map((option) => option.label),
        ["valider malgré", "corriger encore"],
      );
      assert.equal(card.stake, BLOCKERS[index]);
      assert.equal(card.reviewed, false);
    }
    assert.deepEqual(inbox, briefing, "même forme dans l'inbox");
  });
  await arbitrated(
    { direct: true, request: "Exporter\n## Critères d'acceptation\nAC-1 (B-1) : Given a, When b, Then c\n" },
    ({ briefing, title }) => {
      assert.equal(briefing.feature, title, "voie directe : le titre du run");
      assert.equal(briefing.cards.length, 2);
    },
  );
  await arbitrated(
    {
      carte: [[{ tool: "card_review", args: { stake: "Les guillemets cassent le fichier ouvert dans Excel." } }]],
      patch: READER_ON,
    },
    ({ briefing }) => {
      assert.deepEqual(
        briefing.cards.map((card) => card.reviewed),
        [true, true],
      );
      assert.ok(briefing.cards.every((card) => card.stake === "Les guillemets cassent le fichier ouvert dans Excel."));
      assert.deepEqual(
        briefing.cards[0]?.options.map((option) => option.label),
        ["valider malgré", "corriger encore"],
      );
    },
  );
});

/** Un run en attente de specs à valider, posé en base, et son briefing écrit comme l'orchestrateur le fait. */
async function gated(specs: string, reason: string, extra: (store: Store, id: string) => void = () => {}) {
  const world = fakeWorld({});
  const { store } = world;
  store.createRun({
    id: "g",
    repo: "demo",
    slug: "g",
    title: "Export CSV",
    request: "x",
    branch: "b",
    state: "awaiting_human",
    step: "specs",
    reason,
  });
  store.putArtifact("g", "specs.md", specs, null);
  extra(store, "g");
  const ctx = {
    store,
    config: world.config,
    providers: { runnerEnv: () => ({}) },
    log: () => {},
  } as unknown as HarnessContext;
  await new Briefings(ctx).prepare(store.getRun("g") as RunRow, { state: "awaiting_human", step: "specs", reason });
  const view = world.orchestrator.runView("g") as { run: { briefing: Briefing } };
  return view.run.briefing;
}

test("session-graph/AC-32 : un désaccord resté ouvert avec le contradicteur est une carte aux options « valider les specs » / « refaire /specs », avec le constat et la réfutation", async () => {
  const record = {
    specs: {
      step: "specs",
      model: null,
      authorModel: null,
      findings: [
        {
          id: "C-1",
          target: "AC-1",
          kind: "inverifiable",
          severity: "bloquant",
          claim: "AC-1 n'est pas testable",
          evidence: "x",
          suggestion: "y",
        },
      ],
      answers: { "C-1": { status: "réfuté", note: "un test TAP le prouve" } },
      disputes: ["C-1"],
    },
  };
  const briefing = await gated(
    OK.specs[0]?.content ?? "",
    `${WAIT_REASON.specs} : désaccord avec le contradicteur (/specs C-1)`,
    (store, id) => store.putArtifact(id, "_contradicteur.json", JSON.stringify(record), null),
  );
  assert.equal(briefing.feature, FEATURE);
  assert.equal(briefing.cards.length, 1, "pas de raison de porte, un seul désaccord, aucune décision");
  const card = briefing.cards[0] as Briefing["cards"][number];
  assert.deepEqual(
    card.options.map((option) => option.label),
    ["valider les specs", "refaire /specs"],
  );
  assert.match(card.stake, /AC-1 n'est pas testable/);
  assert.match(card.schema.nodes[0]?.label ?? "", /un test TAP le prouve/);
  assert.equal(card.reviewed, false);
});

test("session-graph/AC-33 : des specs arrêtées pour un geste irréversible portent une carte qui donne cette raison", async () => {
  const specs = `${OK.specs[0]?.content}\nOn fait DROP TABLE legacy.\n`;
  const briefing = await gated(specs, `${WAIT_REASON.specs} : geste irréversible (schema)`);
  assert.equal(briefing.cards.length, 1);
  assert.match(briefing.cards[0]?.stake ?? "", /geste irréversible \(schema\)/);
  assert.deepEqual(
    briefing.cards[0]?.options.map((option) => option.label),
    ["valider les specs", "refaire /specs"],
  );
});

// -- AC-29 : la carte et le briefing sont déclarés au README -----------------------------------------------

test("session-graph/readme-carte : le README déclare la carte des escalades, le briefing du run, le relecteur et le lot notifié", () => {
  const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
  for (const needle of ["`card`", "`headline`", "`stake`", "`briefing`", "review.cardReader", "autres questions"])
    assert.ok(readme.includes(needle), `README : ${needle}`);
});
