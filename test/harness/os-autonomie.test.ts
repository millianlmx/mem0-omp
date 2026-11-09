// Tranche « Autonomie » de l'OS agentique (contrat §2) : le curseur d'autonomie d'un run (`ask`, `null`,
// `deliver`), l'échéance visible des escalades (`autoAt`, `autoAnswer`), l'écriture d'une règle de palier
// (`POST /v1/autonomy/rules`) et les consignes permanentes (`/v1/rules`, `always: true`). Le piège des
// specs à geste irréversible sous `review.specsGate: true` (un pilote passait) y a son test.
// Faux runner : test/support/fake-omp-rpc.ts.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { Client } from "../../omp-harness/auth.ts";
import { DELIVER_DIFF_FACTOR } from "../../omp-harness/autonomy-gates.ts";
import { changesOf } from "../../omp-harness/autonomy-learning.ts";
import type { AutonomyRule } from "../../omp-harness/autonomy-rules.ts";
import { repoDefaults } from "../../omp-harness/config.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import type { StandingRule } from "../../omp-harness/db.ts";
import { HarnessError } from "../../omp-harness/errors.ts";
import { EVENT_TYPES } from "../../omp-harness/events.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { createFromPlan } from "../../omp-harness/intake-create.ts";
import { ASK_REASON, WAIT_REASON, humanWaitOf, nextAfter } from "../../omp-harness/machine.ts";
import { MCP_TOOLS } from "../../omp-harness/mcp.ts";
import { FACTORY_PILOT, HUMAN_ONLY } from "../../omp-harness/pilot.ts";
import { STANDING_MAX, standingSection, stepPrompt } from "../../omp-harness/prompts.ts";
import { ConfigAdmin } from "../../omp-harness/repos.ts";
import { MAX_ACTIVE_RULES, MAX_RULE_TEXT } from "../../omp-harness/standing-rules.ts";
import {
  autonomyDecisions,
  bugWorld,
  configure,
  eventsOf,
  reviewOf,
  stateOf,
  until,
} from "../support/autonomie-fixtures.ts";
import { escalationArgs, readFrames } from "../support/card-fixtures.ts";
import { OK, fakeWorld, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADMIN = "a".repeat(64);
const HUMAN = { by: "humain" };

const SPECS = String(OK.specs[0]?.content);
/** Des specs qui portent un geste irréversible (une suppression). */
const IRREVERSIBLE_SPECS = SPECS.replace(
  "S-1 (AC-1) : export CSV",
  "S-1 (AC-1) : export CSV, puis supprimer les données exportées",
);
/** Des specs qui proposent un découpage : deux features de plus. */
const SPLIT_SPECS = SPECS.replace(
  "## Découpage\naucun\n",
  "## Découpage\n- Export JSON — Exporter aussi en JSON — src/api, docs\n- Export XML — Exporter en XML\n",
);
/** /impl qui dort : le test juge la porte des specs, pas la suite. */
const BLOCKED = [[{ sleep: 60_000 }]];
/** Une escalade conforme à la carte (`schema`, recommandation « colonne »), puis la fin normale de /impl. */
const ESCALATING_IMPL = [[...readFrames(), { tool: "decision", args: escalationArgs() }, ...OK.impl], OK.impl];

type Reply = { status: number; body: Record<string, unknown> };

/** Le serveur HTTP réel sur le port 0, et un jeton par profil de client. */
async function serve(world: FakeWorld, admin: ConfigAdmin | null = null) {
  const clients = new ClientRegistry(path.join(tmpdir("os-autonomie-clients-"), "clients.json"), ADMIN);
  const tokens = {
    owner: clients.add("patron", "admin", "*").token,
    operator: clients.add("ops", "operator", "*").token,
    viewer: clients.add("vue", "viewer", "*").token,
    bounded: clients.add("borne", "operator", ["demo"]).token,
    boundedAdmin: clients.add("admin-borne", "admin", ["demo"]).token,
    pilot: clients.add("sentinelle", "operator", "*", false, true).token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients, admin, log: () => {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (
    method: string,
    route: string,
    body?: unknown,
    token: string = tokens.operator,
    headers: Record<string, string> = {},
  ): Promise<Reply> => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  };
  /** Un outil du serveur MCP : son résultat (`structuredContent`, `isError`). */
  const tool = async (name: string, args: Record<string, unknown>, token: string = tokens.operator) => {
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
    return (await call("POST", "/v1/mcp", rpc, token)).body.result as Record<string, unknown>;
  };
  return {
    call,
    tool,
    tokens,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    if (err instanceof HarnessError) return err.status;
    throw err;
  }
}

/** Un monde dont /specs écrit `specs` et dont /impl dort : la porte des specs seule. */
function specsWorld(options: {
  gate: boolean | "auto";
  specs?: string;
  rules?: AutonomyRule[] | null;
  patch?: (config: HarnessConfig) => void;
  pilote?: unknown[][];
}): FakeWorld {
  return fakeWorld(
    {
      req: [OK.req],
      specs: [[{ write: ".harness/specs.md", content: options.specs ?? SPECS }]],
      impl: BLOCKED,
      review: [OK.review],
      ...(options.pilote ? { pilote: options.pilote } : {}),
    },
    {
      patch: configure(options.rules ?? null, (config) => {
        config.review.specsGate = options.gate;
        options.patch?.(config);
      }),
    },
  );
}

async function started<T>(world: FakeWorld, body: () => Promise<T>): Promise<T> {
  await world.orchestrator.start();
  try {
    return await body();
  } finally {
    await world.orchestrator.stop();
  }
}

/** Laisse passer quelques tours : l'autonomie, le pilote et l'échéance ont eu toute occasion d'agir. */
async function ticks(world: FakeWorld, count = 6): Promise<void> {
  for (let i = 0; i < count; i++) await world.orchestrator.tick();
}

function promptsOf(world: FakeWorld, step: string): string[] {
  return world
    .log()
    .filter((entry) => entry.kind === "prompt" && entry.step === step)
    .map((entry) => String(entry.message));
}

const DOCS_AUTO: AutonomyRule = { match: { kind: "docs" }, require: {}, gates: { specs: "auto", review: "human" } };

test("os-autonomie/AC-1 : en « tout me demander », les specs puis la revue attendent toujours l'humain, sans autonomie ni auto-merge ni voie directe ; sans curseur le même run est fusionné seul", async () => {
  // La transition seule : la porte est posée même sans raison, et un geste irréversible reste réservé à l'humain.
  const limits = { fixCap: 3, retryBackoffSec: [0], specsGate: false as const, mergeRetries: 3, ask: true };
  const specsDone = nextAfter({ step: "specs", fixes: 0, attempts: 0 }, { kind: "done", escalations: 0 }, limits);
  assert.deepEqual(
    [specsDone.state, specsDone.step, specsDone.reason],
    ["awaiting_human", "specs", `${WAIT_REASON.specs} : ${ASK_REASON}`],
  );
  const risky = nextAfter(
    { step: "specs", fixes: 0, attempts: 0 },
    { kind: "done", escalations: 0, gateNeeded: true, gateReasons: ["geste irréversible (deletion)"] },
    limits,
  );
  assert.equal(humanWaitOf(risky), "irreversible", risky.reason);
  const reviewed = nextAfter(
    { step: "review", fixes: 0, attempts: 0 },
    { kind: "done", escalations: 0, blockers: 0, merge: { auto: true } },
    limits,
  );
  assert.deepEqual(
    [reviewed.state, reviewed.reason, humanWaitOf(reviewed)],
    ["awaiting_human", `${WAIT_REASON.verdict} : ${ASK_REASON}`, "verdict"],
  );

  // La voie directe (une demande qui porte ses critères) est coupée : la porte des specs doit pouvoir se poser.
  const idle = fakeWorld({});
  const direct =
    "Exporter.\n\n## Critères d'acceptation\nAC-1 : Given des données, When l'export part, Then un CSV sort\n";
  const laneOf = (runId: string) => eventsOf(idle, runId, "run_created")[0]?.payload.lane;
  const fast = idle.orchestrator.createRun({ repo: "demo", title: "Direct", request: direct, modules: ["src/api"] });
  const asked = idle.orchestrator.createRun({
    repo: "demo",
    title: "Demandé",
    request: direct,
    modules: ["docs"],
    autonomy: "ask",
  });
  assert.deepEqual([laneOf(fast.id), fast.step], ["direct", "impl"], "témoin : la voie directe existe");
  assert.deepEqual([laneOf(asked.id), asked.step, asked.autonomy], ["full", "req", "ask"]);
  assert.equal(eventsOf(idle, asked.id, "run_created")[0]?.payload.autonomy, "ask");

  // Le pipeline : une règle du dépôt lèverait les specs d'un run `docs`, et la revue fusionnerait seule.
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] },
    { patch: configure([DOCS_AUTO]) },
  );
  await started(world, async () => {
    const witness = world.orchestrator.createRun({ repo: "demo", title: "Témoin", request: "Exporter", kind: "docs" });
    const merged = await until(world, witness.id, ["merged", "awaiting_human", "failed"]);
    assert.deepEqual([merged.state, merged.autonomy], ["merged", null], stateOf(world, witness.id));

    const run = world.orchestrator.createRun({
      repo: "demo",
      title: "Tout me demander",
      request: "Exporter encore",
      kind: "docs",
      autonomy: "ask",
    });
    const atSpecs = await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.deepEqual(
      [atSpecs.state, atSpecs.step, atSpecs.reason],
      ["awaiting_human", "specs", `${WAIT_REASON.specs} : ${ASK_REASON}`],
    );
    await ticks(world);
    assert.equal(eventsOf(world, run.id, "autonomy").length, 0, "la règle docs en auto ne lève rien");
    assert.equal(eventsOf(world, run.id, "specs_ready").length, 1, "la notification part");
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human");

    await world.orchestrator.validate(run.id, true, "", HUMAN);
    const atReview = await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.deepEqual(
      [atReview.state, atReview.reason, humanWaitOf(atReview)],
      ["awaiting_human", `${WAIT_REASON.verdict} : ${ASK_REASON}`, "verdict"],
      "un verdict bas risque et vert n'est pas fusionné seul",
    );
    await ticks(world);
    assert.equal(autonomyDecisions(world, run.id).length, 0);
    assert.equal(eventsOf(world, run.id, "autonomy").length, 0);
    assert.equal(eventsOf(world, run.id, "verdict").length, 1);

    await world.orchestrator.validate(run.id, true, "", HUMAN);
    const done = await until(world, run.id, ["merged", "failed"]);
    assert.equal(done.state, "merged", stateOf(world, run.id));
  });
});

test("os-autonomie/AC-2 : en « tout me demander », une escalade échue n'est jamais tranchée seule ; le curseur rendu aux règles du dépôt, l'échéance s'applique", async () => {
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: ESCALATING_IMPL, review: [OK.review] },
    {
      patch: (config) => {
        config.review.escalationTimeoutSec = 1;
      },
    },
  );
  await started(world, async () => {
    const run = world.orchestrator.createRun({
      repo: "demo",
      title: "Export daté",
      request: "Exporter",
      autonomy: "ask",
    });
    await until(world, run.id, ["awaiting_human", "failed"]);
    await world.orchestrator.validate(run.id, true, "", HUMAN);
    const escalated = await until(world, run.id, ["escalated", "merged", "failed", "awaiting_human"]);
    assert.equal(escalated.state, "escalated", stateOf(world, run.id));

    // L'échéance réelle d'une seconde passe (l'horloge du service, pas un double) : rien n'est tranché, la vue le dit.
    const [pending] = world.store.listEscalations({ runId: run.id, status: "open" });
    assert.ok(pending);
    await waitFor(
      () => Date.now() >= pending.createdAt + 1500,
      () => "l'échéance n'est pas passée",
    );
    await ticks(world);
    assert.equal(world.store.getRun(run.id)?.state, "escalated", stateOf(world, run.id));
    assert.equal(world.store.listDecisions({ runId: run.id }).length, 0);
    assert.equal(eventsOf(world, run.id, "decision_auto_timeout").length, 0);
    const view = world.orchestrator.runView(run.id) as { escalations: { autoAt: number | null }[] };
    assert.deepEqual(
      view.escalations.map((item) => item.autoAt),
      [null],
    );

    await world.orchestrator.setAutonomy(run.id, null, HUMAN);
    const done = await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(done.state, "merged", stateOf(world, run.id));
    assert.deepEqual(
      world.store.listDecisions({ runId: run.id }).map((decision) => [decision.status, decision.chosen]),
      [["auto_timeout", "colonne"]],
    );
  });
});

test("os-autonomie/AC-3 : chaque escalade rendue par /v1/escalations, /v1/inbox et /v1/runs/{id} dit son échéance (`autoAt`, `autoAnswer`) — nulle pour une suppression, sans recommandation, répondue, en « tout me demander », sur un run terminé ou sans échéance configurée", async () => {
  const world = fakeWorld(
    {},
    {
      patch: (config) => {
        config.review.escalationTimeoutSec = 600;
      },
    },
  );
  const { store } = world;
  const park = (id: string, extra: { autonomy?: "ask"; state?: "escalated" | "cancelled" } = {}) =>
    store.createRun({
      id,
      repo: "demo",
      slug: id,
      title: id,
      request: id,
      branch: `harness/${id}`,
      state: extra.state ?? "escalated",
      step: "impl",
      ...(extra.autonomy ? { autonomy: extra.autonomy } : {}),
    });
  const ask = (runId: string, category: "schema" | "deletion" | "reversible", recommended: string | null) =>
    store.addEscalation({
      runId,
      stepId: store.startStep(runId, "impl", 0, null, null).id,
      category,
      question: `Question ${category} de ${runId} ?`,
      options: ["colonne", "table"],
      context: "contexte",
      recommended,
    });
  park("libre");
  park("demande", { autonomy: "ask" });
  park("fini", { state: "cancelled" });
  const due = ask("libre", "schema", "colonne");
  const deletion = ask("libre", "deletion", "colonne");
  const bare = ask("libre", "schema", null);
  const blank = ask("libre", "schema", "   ");
  const answered = ask("libre", "schema", "colonne");
  store.answerEscalation(answered.id, "table", "humain", null);
  const asked = ask("demande", "schema", "colonne");
  const reversible = ask("demande", "reversible", "colonne");
  const orphan = ask("fini", "schema", "colonne");

  const api = await serve(world);
  try {
    type Item = { id: number; autoAt: number | null; autoAnswer: string | null; step: string | null };
    const expected = new Map<number, [number | null, string | null]>([
      [due.id, [due.createdAt + 600_000, "colonne"]],
      [deletion.id, [null, null]],
      [bare.id, [null, null]],
      [blank.id, [null, null]],
      [asked.id, [null, null]],
      [reversible.id, [null, null]],
      [orphan.id, [null, null]],
    ]);
    const check = (items: Item[], where: string) => {
      for (const item of items)
        assert.deepEqual([item.autoAt, item.autoAnswer], expected.get(item.id), `${where} : escalade ${item.id}`);
    };
    const listed = (await api.call("GET", "/v1/escalations", undefined, api.tokens.viewer)).body.batches as {
      items: Item[];
    }[];
    const open = listed.flatMap((batch) => batch.items);
    assert.equal(open.length, expected.size, "toutes les escalades ouvertes");
    check(open, "/v1/escalations");
    assert.ok(
      open.every((item) => item.step === "impl"),
      "l'étape reste dite",
    );

    const inbox = (await api.call("GET", "/v1/inbox")).body.batches as { items: Item[] }[];
    const boxed = inbox.flatMap((batch) => batch.items);
    assert.equal(boxed.length, expected.size - 1, "l'escalade du run terminé n'est pas dans la boîte");
    check(boxed, "/v1/inbox");

    const view = (await api.call("GET", "/v1/runs/libre")).body.escalations as Item[];
    assert.equal(view.length, 5);
    check(
      view.filter((item) => item.id !== answered.id),
      "/v1/runs/{id}",
    );
    const closed = view.find((item) => item.id === answered.id);
    assert.deepEqual([closed?.autoAt, closed?.autoAnswer], [null, null], "une escalade répondue n'a plus d'échéance");
    const past = (await api.call("GET", "/v1/escalations?status=answered")).body.batches as { items: Item[] }[];
    assert.deepEqual(
      past.flatMap((batch) => batch.items).map((item) => [item.id, item.autoAt, item.autoAnswer]),
      [[answered.id, null, null]],
    );

    // Un pilote ne répond jamais à la place de l'humain sur un run en « tout me demander », même au réversible.
    const refused = await statusOf(
      world.orchestrator.answerEscalations("demande", [{ id: reversible.id, answer: "colonne" }], {
        by: FACTORY_PILOT,
        pilot: true,
      }),
    );
    assert.equal(refused, 403);
    assert.equal(store.listEscalations({ runId: "demande", status: "open" }).length, 2);

    // Sans échéance configurée, plus aucune escalade n'en a.
    world.config.review.escalationTimeoutSec = null;
    const quiet = (await api.call("GET", "/v1/escalations")).body.batches as { items: Item[] }[];
    assert.ok(quiet.flatMap((batch) => batch.items).every((item) => item.autoAt === null && item.autoAnswer === null));
  } finally {
    await api.close();
  }
});

test("os-autonomie/AC-4 : en « livre et préviens-moi », des specs sans raison de porte sont validées seules sans règle de dépôt ni type ; avec un geste irréversible ou un découpage elles restent à l'humain ; sans curseur rien ne change", async () => {
  const lifted = specsWorld({ gate: true });
  const irreversible = specsWorld({ gate: true, specs: IRREVERSIBLE_SPECS });
  const untouched = specsWorld({ gate: true });
  const create = (world: FakeWorld, autonomy?: "deliver") =>
    world.orchestrator.createRun({
      repo: "demo",
      title: "Documenter l'export",
      request: "Documenter",
      lane: "full",
      ...(autonomy ? { autonomy } : {}),
    });
  await Promise.all([
    started(lifted, async () => {
      assert.equal(lifted.config.repos[0]?.autonomy, undefined, "aucune règle de dépôt");
      const run = create(lifted, "deliver");
      assert.equal(run.kind, null, "aucun type de travail");
      await waitFor(
        () => autonomyDecisions(lifted, run.id).length > 0 && lifted.store.getRun(run.id)?.step === "impl",
        () => stateOf(lifted, run.id),
        60_000,
      );
      const [decision, ...others] = autonomyDecisions(lifted, run.id);
      assert.equal(others.length, 0);
      assert.deepEqual(
        [decision?.status, decision?.autonomy?.gate, decision?.autonomy?.rule.rank],
        ["auto", "specs", 0],
      );
      assert.deepEqual(decision?.autonomy?.rule.gates, { specs: "auto", review: "auto" });
      assert.deepEqual(decision?.autonomy?.proofs.gateReasons, []);
      assert.match(decision?.rationale ?? "", /livre et préviens-moi/);
      assert.deepEqual(
        eventsOf(lifted, run.id, "autonomy").map((event) => [event.payload.action, event.payload.rank]),
        [
          ["hold", undefined],
          ["validate", 0],
        ],
      );
      assert.equal(eventsOf(lifted, run.id, "specs_ready").length, 0, "la notification est retenue");
      const validation = eventsOf(lifted, run.id, "validation")[0];
      assert.deepEqual(
        [validation?.payload.by, validation?.payload.gate, validation?.payload.approve],
        ["autonomie:demo#curseur", "specs", true],
      );
    }),
    started(irreversible, async () => {
      const run = create(irreversible, "deliver");
      await until(irreversible, run.id, ["awaiting_human", "failed"]);
      await ticks(irreversible);
      const waiting = irreversible.store.getRun(run.id);
      assert.deepEqual([waiting?.state, waiting?.step], ["awaiting_human", "specs"], stateOf(irreversible, run.id));
      assert.equal(autonomyDecisions(irreversible, run.id).length, 0);
      assert.equal(eventsOf(irreversible, run.id, "autonomy").length, 0);
      assert.equal(eventsOf(irreversible, run.id, "specs_ready").length, 1);
    }),
    started(untouched, async () => {
      const run = create(untouched);
      const waiting = await until(untouched, run.id, ["awaiting_human", "failed"]);
      await ticks(untouched);
      assert.deepEqual([waiting.state, waiting.reason, waiting.autonomy], ["awaiting_human", WAIT_REASON.specs, null]);
      assert.equal(eventsOf(untouched, run.id, "autonomy").length, 0);
      assert.equal(untouched.store.getRun(run.id)?.state, "awaiting_human");
    }),
  ]);
});

/** Un run sans type ni règle de dépôt, mené à son arrêt : 30 lignes de diff au plus pour le serveur. */
async function reviewCase(options: { diff: number; review?: unknown[]; autonomy?: "deliver" }) {
  const world = bugWorld({ rules: null, diff: options.diff, ...(options.review ? { review: options.review } : {}) });
  await world.orchestrator.start();
  const run = world.orchestrator.createRun({
    repo: "demo",
    title: "Corriger l'export",
    request: "Corriger",
    ...(options.autonomy ? { autonomy: options.autonomy } : {}),
  });
  const done = await until(world, run.id, ["merged", "awaiting_human", "failed"]);
  return { world, runId: run.id, done };
}

test("os-autonomie/AC-5 : en « livre et préviens-moi », une revue dont seul le diff dépasse est fusionnée seule jusqu'à 4 × review.maxDiffLines ; au-delà, avec un critère non prouvé, une escalade irréversible ou un budget dépassé, elle reste à l'humain", async () => {
  const bound = DELIVER_DIFF_FACTOR * 30;
  assert.equal(bound, 120);
  const unproven = reviewOf({ criteria: [{ id: "AC-1", test: "", status: "untested" }] });
  const [alone, wide, doubtful, escalated, costly, late] = await Promise.all([
    reviewCase({ diff: 40, autonomy: "deliver" }),
    reviewCase({ diff: bound + 10, autonomy: "deliver" }),
    reviewCase({ diff: 40, review: unproven, autonomy: "deliver" }),
    reviewCase({ diff: 40 }),
    reviewCase({ diff: 40 }),
    reviewCase({ diff: 40 }),
  ]);
  try {
    // Sous la borne : fusionné seul, décision de rang 0 au nom du curseur.
    assert.equal(alone.done.state, "merged", stateOf(alone.world, alone.runId));
    const [decision, ...others] = autonomyDecisions(alone.world, alone.runId);
    assert.equal(others.length, 0);
    assert.deepEqual(
      [decision?.status, decision?.autonomy?.gate, decision?.autonomy?.rule.rank],
      ["auto", "review", 0],
    );
    assert.equal(decision?.autonomy?.rule.match.maxDiffLines, bound);
    assert.deepEqual(decision?.autonomy?.rule.require, { greenChecks: true, proofs: true });
    const proofs = decision?.autonomy?.proofs;
    assert.deepEqual(
      [proofs?.kind, proofs?.diffLines, proofs?.reviewMaxDiffLines, proofs?.ruleMaxDiffLines, proofs?.fullTests],
      [null, 40, 30, bound, "pass"],
    );
    assert.deepEqual(proofs?.provenCriteria, ["AC-1"]);
    assert.equal(eventsOf(alone.world, alone.runId, "validation")[0]?.payload.by, "autonomie:demo#curseur");
    assert.equal(eventsOf(alone.world, alone.runId, "verdict").length, 0, "la notification est retenue");

    // Au-delà de la borne, ou un critère non prouvé : l'humain, sans trace d'autonomie.
    for (const [name, held] of [
      ["diff au-delà de 4 ×", wide],
      ["critère non prouvé", doubtful],
    ] as const) {
      assert.equal(held.done.state, "awaiting_human", `${name} : ${stateOf(held.world, held.runId)}`);
      assert.equal(autonomyDecisions(held.world, held.runId).length, 0, name);
      assert.equal(eventsOf(held.world, held.runId, "autonomy").length, 0, name);
      assert.equal(eventsOf(held.world, held.runId, "verdict").length, 1, `${name} : la notification part`);
    }
    assert.match(String(wide.done.reason), new RegExp(`diff de ${bound + 10} lignes`));

    // Sans curseur (`null`) : l'attente de diff reste à l'humain, comme avant.
    for (const held of [escalated, costly, late]) {
      assert.deepEqual([held.done.state, held.done.autonomy], ["awaiting_human", null]);
      assert.equal(humanWaitOf(held.done), "verdict");
      assert.equal(eventsOf(held.world, held.runId, "autonomy").length, 0);
    }

    // Le curseur monté après coup ne lève ni un run qui a porté une escalade irréversible, ni un budget dépassé.
    const stepId = escalated.world.store.listSteps(escalated.runId).at(-1)?.id ?? 0;
    const item = escalated.world.store.addEscalation({
      runId: escalated.runId,
      stepId,
      category: "schema",
      question: "Changer le schéma ?",
      options: ["oui", "non"],
      context: "contexte",
    });
    escalated.world.store.answerEscalation(item.id, "oui", "humain", "ok");
    costly.world.config.monitoring.runBudgetUsd = 0;
    for (const [name, held] of [
      ["escalade irréversible", escalated],
      ["budget dépassé", costly],
    ] as const) {
      const set = await held.world.orchestrator.setAutonomy(held.runId, "deliver", HUMAN);
      assert.equal(set.autonomy, "deliver");
      await ticks(held.world);
      assert.equal(held.world.store.getRun(held.runId)?.state, "awaiting_human", name);
      assert.equal(eventsOf(held.world, held.runId, "autonomy").length, 0, `${name} : rien n'est retenu`);
      assert.equal(autonomyDecisions(held.world, held.runId).length, 0, name);
    }

    // Témoin : sans ces gardes, monter le curseur d'un run qui attend lève l'attente au tour suivant.
    await late.world.orchestrator.setAutonomy(late.runId, "deliver", HUMAN);
    const merged = await until(late.world, late.runId, ["merged", "failed"]);
    assert.equal(merged.state, "merged", stateOf(late.world, late.runId));
    assert.equal(autonomyDecisions(late.world, late.runId)[0]?.autonomy?.rule.rank, 0);
  } finally {
    await Promise.all([alone, wide, doubtful, escalated, costly, late].map((held) => held.world.orchestrator.stop()));
  }
});

test("os-autonomie/AC-6 : le curseur vient de l'espace du dépôt à défaut d'être donné, se pose sur un projet et à la confirmation d'une Demande, et passe aux features découpées et au run de suite", async () => {
  // À la création : l'espace du dépôt, sinon ce qu'on demande ; un pilote ne dépasse pas ce défaut.
  const idle = fakeWorld({});
  const first = idle.orchestrator.createRun({ repo: "demo", title: "Avant l'espace", request: "x", modules: ["a"] });
  assert.equal(first.autonomy, null);
  idle.orchestrator.spaces.create(
    { name: "Client", repos: ["demo"], poste: false, jiraProjects: [], dailyBudgetUsd: null, autonomy: "ask" },
    HUMAN,
  );
  const create = (title: string, extra: { autonomy?: "ask" | "deliver" | null } = {}, actor = HUMAN) =>
    idle.orchestrator.createRun({ repo: "demo", title, request: "x", modules: [title], ...extra }, actor);
  assert.equal(create("défaut").autonomy, "ask");
  assert.equal(create("règles", { autonomy: null }).autonomy, null);
  assert.equal(create("livre", { autonomy: "deliver" }).autonomy, "deliver");
  const pilot = { by: "sentinelle", pilot: true };
  assert.equal(create("pilote", {}, pilot).autonomy, "ask", "un pilote prend le défaut de l'espace");
  assert.throws(
    () => create("pilote-monte", { autonomy: null }, pilot),
    (err: unknown) => err instanceof HarnessError && err.status === 403,
  );
  assert.throws(
    () => create("pilote-livre", { autonomy: "deliver" }, pilot),
    (err: unknown) => err instanceof HarnessError && err.status === 403,
  );

  // Un projet pose le curseur de toutes ses features ; la confirmation d'une Demande pose celui de son run.
  const project = await idle.orchestrator.createProject(
    {
      repo: "demo",
      title: "Projet",
      autonomy: "deliver",
      features: [
        { title: "Une", request: "x", modules: ["src/api"] },
        { title: "Deux", request: "y", modules: ["docs"] },
      ],
    },
    HUMAN,
  );
  assert.deepEqual(
    project.runs.map((run) => run.autonomy),
    ["deliver", "deliver"],
  );
  const inherited = await idle.orchestrator.createProject(
    { repo: "demo", title: "Sans curseur", features: [{ title: "Trois", request: "z", modules: ["src/db"] }] },
    HUMAN,
  );
  assert.equal(inherited.runs[0]?.autonomy, "ask", "sans curseur, celui de l'espace");
  const client: Client = { name: "ops", role: "operator", repos: "*", createdAt: 0, approver: false, pilot: false };
  const plan = { kind: "feature" as const, repo: "demo", title: "Demande", statement: "Exporter en JSON" };
  const confirmed = createFromPlan(idle.orchestrator, client, { by: "ops" }, plan, "deliver");
  assert.equal(idle.store.getRun(confirmed.id)?.autonomy, "deliver");
  const plain = createFromPlan(idle.orchestrator, client, { by: "ops" }, { ...plan, title: "Demande 2" });
  assert.equal(idle.store.getRun(plain.id)?.autonomy, "ask");

  // Une feature découpée hérite du curseur de son parent (et un découpage reste à l'humain, même en `deliver`).
  const split = specsWorld({ gate: "auto", specs: SPLIT_SPECS });
  await started(split, async () => {
    const parent = split.orchestrator.createRun({
      repo: "demo",
      title: "Export CSV",
      request: "Exporter",
      autonomy: "deliver",
    });
    const waiting = await until(split, parent.id, ["awaiting_human", "failed"]);
    assert.equal(humanWaitOf(waiting), "specs", stateOf(split, parent.id));
    assert.match(String(waiting.reason), /découpage proposé/);
    assert.equal(eventsOf(split, parent.id, "autonomy").length, 0, "un découpage n'est pas levé seul");
    await split.orchestrator.validate(parent.id, true, "", HUMAN);
    await waitFor(
      () => split.store.listRuns({ afterRun: parent.id }).length === 2,
      () => stateOf(split, parent.id),
    );
    assert.deepEqual(
      split.store.listRuns({ afterRun: parent.id }).map((child) => child.autonomy),
      ["deliver", "deliver"],
    );
  });

  // Le run de suite d'un revert hérite du curseur du run reverté.
  const { world, runId, done } = await reviewCase({ diff: 40, autonomy: "deliver" });
  try {
    assert.equal(done.state, "merged", stateOf(world, runId));
    const followUp = await world.orchestrator.revert(runId, HUMAN);
    assert.notEqual(followUp.id, runId);
    assert.equal(followUp.autonomy, "deliver");
  } finally {
    await world.orchestrator.stop();
  }
});

test("os-autonomie/AC-7 : `POST /v1/runs/{id}/autonomy` pose le curseur (événement `autonomy_level`), refuse un niveau inconnu (400), un run terminal (409), une révision périmée (412) et un pilote qui le monterait (403) ; `POST /v1/runs` et l'outil `run_autonomy` suivent les mêmes gardes", async () => {
  const world = fakeWorld({});
  const api = await serve(world);
  try {
    const created = await api.call("POST", "/v1/runs", {
      repo: "demo",
      title: "Curseur",
      request: "x",
      modules: ["src/api"],
      autonomy: "ask",
    });
    assert.equal(created.status, 201);
    const run = created.body.run as { id: string; autonomy: string | null; rev: number };
    assert.equal(run.autonomy, "ask");
    const route = `/v1/runs/${run.id}/autonomy`;

    for (const bad of [{}, { level: "max" }, { level: 2 }, { level: "" }])
      assert.equal((await api.call("POST", route, bad)).status, 400, JSON.stringify(bad));
    assert.equal((await api.call("POST", route, { level: "deliver" }, api.tokens.viewer)).status, 403);
    assert.equal((await api.call("POST", route, { level: null }, api.tokens.pilot)).status, 403, "ask → règles");
    assert.equal((await api.call("POST", route, { level: "deliver" }, api.tokens.pilot)).status, 403);
    const stale = await api.call("POST", route, { level: null }, api.tokens.operator, { "If-Match": '"999"' });
    assert.equal(stale.status, 412);
    assert.equal(world.store.getRun(run.id)?.autonomy, "ask", "aucun refus n'écrit");
    assert.equal(eventsOf(world, run.id, "autonomy_level").length, 0);

    const raised = await api.call("POST", route, { level: "deliver" });
    assert.equal(raised.status, 200);
    assert.equal((raised.body.run as { autonomy: string }).autonomy, "deliver");
    const lowered = await api.call("POST", route, { level: "ask" }, api.tokens.pilot);
    assert.equal(lowered.status, 200, "un pilote peut baisser le curseur");
    const reset = await api.tool("run_autonomy", { id: run.id, level: null });
    assert.equal(reset.isError, undefined, JSON.stringify(reset));
    assert.equal((reset.structuredContent as { run: { autonomy: string | null } }).run.autonomy, null);
    assert.equal((await api.tool("run_autonomy", { id: run.id, level: "deliver" }, api.tokens.pilot)).isError, true);
    assert.deepEqual(
      eventsOf(world, run.id, "autonomy_level").map((event) => [event.payload.level, event.payload.by]),
      [
        ["deliver", "ops"],
        ["ask", "sentinelle"],
        [null, "ops"],
      ],
    );
    const seen = await api.call("GET", `/v1/runs/${run.id}`, undefined, api.tokens.viewer);
    assert.equal((seen.body.run as { autonomy: string | null }).autonomy, null);

    // À la création : mêmes valeurs, même garde pour un pilote.
    const body = { repo: "demo", title: "Autre", request: "x", modules: ["docs"] };
    assert.equal((await api.call("POST", "/v1/runs", { ...body, autonomy: "toujours" })).status, 400);
    assert.equal((await api.call("POST", "/v1/runs", { ...body, autonomy: "deliver" }, api.tokens.pilot)).status, 403);
    assert.equal(world.store.listRuns({}).length, 1, "aucun run créé par un refus");

    // Un run terminal ne change plus de curseur.
    await world.orchestrator.cancel(run.id, HUMAN);
    assert.equal((await api.call("POST", route, { level: "deliver" })).status, 409);
  } finally {
    await api.close();
  }
});

test("os-autonomie/AC-8 : sous `review.specsGate: true`, des specs à geste irréversible refusent un pilote (403) alors que la raison du run est nue ; le pilote de l'usine les rend à l'humain sans session ; des specs sans ce geste lui restent ouvertes", async () => {
  const approve = [[{ tool: "pilot_act", args: { action: "approve", reason: "specs conformes à la demande" } }]];
  const factory = (config: HarnessConfig) => {
    config.pilot.allRuns = true;
  };
  const risky = specsWorld({ gate: true, specs: IRREVERSIBLE_SPECS, patch: factory, pilote: approve });
  const safe = specsWorld({ gate: true, patch: factory, pilote: approve });
  const create = (world: FakeWorld) =>
    world.orchestrator.createRun({ repo: "demo", title: "Documenter l'export", request: "Documenter", lane: "full" });
  const pilotEvents = (world: FakeWorld, runId: string) =>
    eventsOf(world, runId, "pilot").map((event) => [event.payload.action, event.payload.by]);
  await Promise.all([
    started(risky, async () => {
      const run = create(risky);
      const waiting = await until(risky, run.id, ["awaiting_human", "failed"]);
      // Le piège : la raison ne dit rien du geste irréversible, `humanWaitOf` rend `specs`.
      assert.equal(waiting.reason, WAIT_REASON.specs);
      assert.equal(humanWaitOf(waiting), "specs");
      await waitFor(
        () => eventsOf(risky, run.id, "pilot").length > 0,
        () => `le pilote n'a rien écrit : ${stateOf(risky, run.id)}`,
      );
      await ticks(risky);
      assert.deepEqual(pilotEvents(risky, run.id), [["defer", FACTORY_PILOT]]);
      assert.equal(eventsOf(risky, run.id, "pilot")[0]?.payload.reason, HUMAN_ONLY.irreversible);
      assert.equal(promptsOf(risky, "pilote").length, 0, "aucune session de pilote");
      const before = risky.store.getRun(run.id);
      assert.deepEqual([before?.state, before?.step], ["awaiting_human", "specs"], stateOf(risky, run.id));

      // Le geste lui-même est refusé à tout pilote, sans rien écrire.
      const refused = await statusOf(risky.orchestrator.validate(run.id, true, "", { by: "sentinelle", pilot: true }));
      assert.equal(refused, 403);
      assert.equal(risky.store.getRun(run.id)?.rev, before?.rev);
      assert.equal(eventsOf(risky, run.id, "validation").length, 0);

      // L'humain, lui, valide.
      const moved = await risky.orchestrator.validate(run.id, true, "", HUMAN);
      assert.equal(moved.step, "impl", stateOf(risky, run.id));
    }),
    started(safe, async () => {
      const run = create(safe);
      await waitFor(
        () => safe.store.getRun(run.id)?.step === "impl",
        () => stateOf(safe, run.id),
        60_000,
      );
      assert.deepEqual(pilotEvents(safe, run.id), [["approve", FACTORY_PILOT]]);
      assert.equal(eventsOf(safe, run.id, "validation")[0]?.payload.pilot, true);
    }),
  ]);
});

test("os-autonomie/AC-9 : en « tout me demander », ni le pilote de l'usine ni un client pilote ne valide à la place de l'humain", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: BLOCKED,
      pilote: [[{ tool: "pilot_act", args: { action: "approve", reason: "conforme" } }]],
    },
    {
      patch: (config) => {
        config.pilot.allRuns = true;
      },
    },
  );
  await started(world, async () => {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Demandé", request: "Exporter", autonomy: "ask" });
    await until(world, run.id, ["awaiting_human", "failed"]);
    await waitFor(
      () => eventsOf(world, run.id, "pilot").length > 0,
      () => `le pilote n'a rien écrit : ${stateOf(world, run.id)}`,
    );
    await ticks(world);
    const [event, ...others] = eventsOf(world, run.id, "pilot");
    assert.equal(others.length, 0);
    assert.equal(event?.payload.action, "defer");
    assert.match(String(event?.payload.reason), /tout me demander/);
    assert.equal(promptsOf(world, "pilote").length, 0, "aucune session de pilote");
    for (const gesture of [
      world.orchestrator.validate(run.id, true, "", { by: "sentinelle", pilot: true }),
      world.orchestrator.validate(run.id, false, "à revoir", { by: "sentinelle", pilot: true }),
      world.orchestrator.cancel(run.id, { by: "sentinelle", pilot: true }),
    ])
      assert.equal(await statusOf(gesture), 403);
    const waiting = world.store.getRun(run.id);
    assert.deepEqual([waiting?.state, waiting?.step], ["awaiting_human", "specs"], stateOf(world, run.id));
  });
});

test("os-autonomie/AC-10 : `POST /v1/autonomy/rules` écrit la règle d'une proposition de palier dans la configuration et la recharge ; admin non borné seulement ; un champ ou une configuration invalide est un 400 et rien ne change", async () => {
  const world = fakeWorld({});
  const demo = world.config.repos[0];
  assert.ok(demo);
  const file = path.join(tmpdir("os-autonomie-config-"), "config.json");
  const base = { name: "demo", path: demo.path, scope: "demo", tests: demo.tests };
  const write = (entry: Record<string, unknown>) =>
    fs.writeFileSync(
      file,
      `${JSON.stringify({ dataDir: world.config.dataDir, worktreesDir: world.config.worktreesDir, repos: [entry] }, null, 2)}\n`,
    );
  // Une règle écrite à la main, non normalisée, sous le seuil du serveur.
  write({ ...base, autonomy: { rules: [{ match: { kind: "test", maxDiffLines: 100 }, gates: { review: "human" } }] } });
  const max = world.config.review.maxDiffLines;
  const api = await serve(world, new ConfigAdmin(file, world.orchestrator, { git: world.deps.git }));
  const bare = await serve(world);
  const rulesNow = () => world.orchestrator.config.repos.find((repo) => repo.name === "demo")?.autonomy?.rules;
  const post = (body: unknown, token: string = api.tokens.owner) => api.call("POST", "/v1/autonomy/rules", body, token);
  try {
    const raise = { repo: "demo", kind: "bug", gate: "review", mode: "auto" };
    const before = fs.readFileSync(file, "utf8");
    assert.equal((await post(raise, api.tokens.operator)).status, 403, "operator");
    assert.equal((await post(raise, api.tokens.boundedAdmin)).status, 403, "admin borné à des dépôts");
    assert.equal(
      (await bare.call("POST", "/v1/autonomy/rules", raise, bare.tokens.owner)).status,
      409,
      "sans --config",
    );
    assert.equal((await post({ ...raise, repo: "inconnu" })).status, 404);
    for (const bad of [
      {},
      { ...raise, kind: "refonte" },
      { ...raise, gate: "merge" },
      { ...raise, mode: "toujours" },
      { kind: "bug", gate: "review", mode: "auto" },
    ])
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    assert.equal(fs.readFileSync(file, "utf8"), before, "aucun refus n'écrit");
    assert.equal(rulesNow(), undefined, "la configuration en vigueur n'a pas bougé");
    assert.equal(world.store.eventsOfType("autonomy_rule").length, 0);

    // Aucune règle du type : la règle prudente d'une proposition de palier est ajoutée.
    const added = await post(raise);
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const cautious = changesOf(
      { repo: "demo", kind: "bug", gate: "review", direction: "raise", rule: null },
      null,
      max,
    );
    assert.equal(cautious[0]?.path, "repos.demo.autonomy.rules[+]");
    const rules = added.body.rules as AutonomyRule[];
    assert.equal(added.body.repo, "demo");
    assert.equal(rules.length, 2);
    assert.deepEqual(rules[1], cautious[0]?.value);
    assert.deepEqual(rules[1], {
      match: { kind: "bug", maxDiffLines: 2 * max },
      require: { reproTest: true, greenChecks: true, proofs: true },
      gates: { specs: "human", review: "auto" },
    });
    assert.deepEqual(rulesNow(), rules, "la configuration est rechargée");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { repos: { autonomy: { rules: AutonomyRule[] } }[] };
    assert.deepEqual(onDisk.repos[0]?.autonomy.rules, rules, "et écrite");
    assert.deepEqual(world.store.eventsOfType("autonomy_rule").at(-1)?.payload, { ...raise, by: "patron" });
    const read = await api.call("GET", "/v1/autonomy", undefined, api.tokens.viewer);
    assert.deepEqual((read.body.repos as { repo: string; rules: AutonomyRule[] }[])[0]?.rules, rules);

    // Une règle du type règle déjà la porte : elle change de porte, et reçoit un seuil utile si le sien ne dépasse pas celui du serveur.
    const widened = (await post({ repo: "demo", kind: "test", gate: "review", mode: "auto" })).body
      .rules as AutonomyRule[];
    assert.deepEqual(widened[0], {
      match: { kind: "test", maxDiffLines: 2 * max },
      require: {},
      gates: { specs: "human", review: "auto" },
    });
    const lowered = (await post({ ...raise, mode: "human" })).body.rules as AutonomyRule[];
    assert.deepEqual(lowered[1]?.gates, { specs: "human", review: "human" });
    assert.equal(lowered[1]?.match.maxDiffLines, 2 * max, "le seuil reste");
    assert.equal(lowered.length, 2);

    // À la porte des specs, une règle qui porte un seuil ne compte pas : une règle de specs est ajoutée.
    const specs = (await post({ repo: "demo", kind: "bug", gate: "specs", mode: "auto" })).body.rules as AutonomyRule[];
    assert.equal(specs.length, 3);
    assert.deepEqual(specs[2], { match: { kind: "bug" }, require: {}, gates: { specs: "auto", review: "human" } });

    // Mettre à l'humain une porte qu'aucune règle ne règle ne change rien.
    const idle = (await post({ repo: "demo", kind: "docs", gate: "specs", mode: "human" })).body
      .rules as AutonomyRule[];
    assert.deepEqual(idle, specs);

    // Une configuration que le serveur refuserait : 400, ni fichier ni règles en vigueur ne bougent.
    const events = world.store.eventsOfType("autonomy_rule").length;
    for (const [name, entry] of [
      ["règle existante illisible", { ...base, autonomy: { rules: [{ match: { kind: "refonte" } }] } }],
      ["juge ci sans forge", { ...base, tests: { ...demo.tests, judge: "ci" } }],
    ] as const) {
      write(entry);
      const broken = fs.readFileSync(file, "utf8");
      const refused = await post(raise);
      assert.equal(refused.status, 400, `${name} : ${JSON.stringify(refused.body)}`);
      assert.equal(fs.readFileSync(file, "utf8"), broken, `${name} : le fichier n'est pas réécrit`);
      assert.deepEqual(rulesNow(), specs, `${name} : les règles en vigueur restent`);
    }
    assert.equal(world.store.eventsOfType("autonomy_rule").length, events, "aucun événement pour un refus");
  } finally {
    await api.close();
    await bare.close();
  }
});

test("os-autonomie/AC-11 : les consignes permanentes se créent, se modifient et se retirent par /v1/rules, bornées à 600 caractères et à 40 actives par dépôt ; un client borné ne voit et n'écrit que celles de ses dépôts, un pilote n'en écrit pas", async () => {
  const other = harnessRepo("os-autonomie-autre-");
  const world = fakeWorld(
    {},
    {
      patch: (config) => {
        config.repos.push(repoDefaults({ name: "autre", path: other, scope: "autre-scope" }));
      },
    },
  );
  const api = await serve(world);
  const { operator, viewer, bounded, pilot } = api.tokens;
  const post = (body: unknown, token: string = operator) => api.call("POST", "/v1/rules", body, token);
  const list = async (token: string) =>
    (await api.call("GET", "/v1/rules", undefined, token)).body.rules as StandingRule[];
  try {
    assert.deepEqual(await list(viewer), []);
    const made = await post({ text: "  Toujours écrire\n les migrations à part.  ", repo: "demo" });
    assert.equal(made.status, 201);
    const rule = made.body.rule as StandingRule;
    assert.match(rule.id, /^sr[\w]+$/);
    assert.deepEqual(
      [rule.repo, rule.text, rule.enabled, rule.source, rule.sourceRunId, rule.by],
      ["demo", "Toujours écrire les migrations à part.", true, "manual", null, "ops"],
    );
    const global = (await post({ text: "Répondre en français." })).body.rule as StandingRule;
    assert.equal(global.repo, null);
    const foreign = (await post({ text: "Pas de dépendance nouvelle.", repo: "autre" })).body.rule as StandingRule;

    // Les refus de forme, de rôle et de portée.
    for (const bad of [
      {},
      { text: "   " },
      { text: "x".repeat(MAX_RULE_TEXT + 1) },
      { text: "ok", repo: 3 },
      { text: "ok", source: "rumeur" },
      { text: "ok", repo: "demo", sourceRunId: "inconnu" },
    ])
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
    assert.equal((await post({ text: "x".repeat(MAX_RULE_TEXT), repo: "demo" })).status, 201, "la borne est incluse");
    assert.equal((await post({ text: "ok", repo: "fantôme" })).status, 404);
    assert.equal((await post({ text: "ok", repo: "demo" }, viewer)).status, 403);
    assert.equal((await post({ text: "ok", repo: "demo" }, pilot)).status, 403);
    assert.equal((await post({ text: "ok" }, bounded)).status, 403, "un client borné n'écrit pas pour tous les dépôts");
    assert.equal((await post({ text: "ok", repo: "autre" }, bounded)).status, 403);
    const own = (await post({ text: "Tester chaque route.", repo: "demo", source: "cancel" }, bounded)).body
      .rule as StandingRule;
    assert.deepEqual([own.repo, own.source, own.by], ["demo", "cancel", "borne"]);

    // La visibilité : tout pour qui voit tous les dépôts, les siennes pour un client borné, les plus récentes d'abord.
    assert.equal((await list(viewer)).length, 5);
    assert.equal((await list(viewer))[0]?.id, own.id);
    const narrow = await list(bounded);
    assert.equal(narrow.length, 3);
    assert.ok(narrow.every((item) => item.repo === "demo"));
    for (const hidden of [global.id, foreign.id]) {
      assert.equal((await api.call("PUT", `/v1/rules/${hidden}`, { enabled: false }, bounded)).status, 404);
      assert.equal((await api.call("DELETE", `/v1/rules/${hidden}`, undefined, bounded)).status, 404);
    }
    assert.equal((await api.call("PUT", `/v1/rules/${rule.id}`, { enabled: false }, pilot)).status, 403);
    assert.equal((await api.call("DELETE", `/v1/rules/${rule.id}`, undefined, pilot)).status, 403);

    // Modifier, suspendre, retirer.
    for (const bad of [{}, { enabled: "non" }, { text: "" }, { text: "x".repeat(MAX_RULE_TEXT + 1) }])
      assert.equal((await api.call("PUT", `/v1/rules/${rule.id}`, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    const edited = await api.call("PUT", `/v1/rules/${rule.id}`, { text: "Une migration par PR.", enabled: false });
    assert.equal(edited.status, 200);
    const next = edited.body.rule as StandingRule;
    assert.deepEqual([next.text, next.enabled, next.source], ["Une migration par PR.", false, "manual"]);
    assert.equal((await api.call("PUT", "/v1/rules/sr-inconnue", { enabled: true })).status, 404);
    const removed = await api.call("DELETE", `/v1/rules/${foreign.id}`);
    assert.deepEqual([removed.status, removed.body], [200, { removed: true }]);
    assert.equal((await api.call("DELETE", `/v1/rules/${foreign.id}`)).status, 404);
    assert.deepEqual(
      world.store.eventsOfType("standing_rule").map((event) => [event.payload.action, event.payload.repo]),
      [
        ["created", "demo"],
        ["created", null],
        ["created", "autre"],
        ["created", "demo"],
        ["created", "demo"],
        ["updated", "demo"],
        ["removed", "autre"],
      ],
    );

    // 40 consignes actives au plus par dépôt : la 41e est refusée, une consigne suspendue ne compte pas.
    for (let n = 0; n < MAX_ACTIVE_RULES; n++)
      world.store.insertStandingRule({
        id: `sr-plein-${n}`,
        repo: "autre",
        text: `Consigne ${n}.`,
        source: "manual",
        sourceRunId: null,
        by: null,
      });
    const full = await post({ text: "Une de trop.", repo: "autre" });
    assert.equal(full.status, 400);
    assert.match(String(full.body.error), /40 consignes actives/);
    assert.equal((await post({ text: "Ailleurs, il reste de la place.", repo: "demo" })).status, 201);
    assert.equal((await api.call("PUT", "/v1/rules/sr-plein-0", { enabled: false })).status, 200);
    const fits = await post({ text: "La place est libérée.", repo: "autre" });
    assert.equal(fits.status, 201);
    assert.equal((await api.call("PUT", "/v1/rules/sr-plein-0", { enabled: true })).status, 400, "réactiver compte");

    // Les mêmes gestes par MCP.
    const viaTool = await api.tool("rule_set", { text: "Par outil.", repo: "demo" });
    assert.equal(viaTool.isError, undefined, JSON.stringify(viaTool));
    const toolRule = (viaTool.structuredContent as { rule: StandingRule }).rule;
    assert.equal((await api.tool("rule_set", { text: "Refusé." }, pilot)).isError, true);
    const read = (await api.tool("rules", {}, viewer)).structuredContent as { rules: StandingRule[] };
    assert.ok(read.rules.some((item) => item.id === toolRule.id));
    await api.tool("rule_set", { id: toolRule.id, enabled: false });
    assert.equal(world.store.getStandingRule(toolRule.id)?.enabled, false);
    await api.tool("rule_set", { id: toolRule.id, remove: true });
    assert.equal(world.store.getStandingRule(toolRule.id), null);
  } finally {
    await api.close();
  }
});

test("os-autonomie/AC-12 : le prompt de chaque étape porte les consignes actives du dépôt et celles de tous les dépôts, les plus récentes d'abord, bornées à 4000 caractères ; ni une consigne suspendue, ni celle d'un autre dépôt ; rien sans consigne", async () => {
  // La section seule : bornée, les plus récentes gardées, vide sans consigne.
  assert.equal(standingSection([]), "");
  const many = Array.from({ length: MAX_ACTIVE_RULES }, (_, n) => `Consigne ${n} ${"x".repeat(MAX_RULE_TEXT - 20)}`);
  const section = standingSection(many);
  assert.match(section, /^\n## Consignes permanentes de l'humain\n/);
  assert.ok(section.includes("Elles s'imposent : ne les rouvre pas."));
  const body = section.split("\n").slice(2).join("\n").trim();
  assert.ok(body.length <= STANDING_MAX, `${body.length} caractères`);
  const kept = section.split("\n").filter((line) => line.startsWith("- "));
  assert.ok(kept.length >= 5 && kept.length < many.length, `${kept.length} consignes gardées`);
  assert.deepEqual(
    kept,
    many.slice(0, kept.length).map((rule) => `- ${rule}`),
  );
  const context = {
    step: "impl" as const,
    title: "Export",
    request: "Exporter",
    baseSha: "main",
    maxDiffLines: 300,
    memories: null,
    blockers: [],
    previousVerdict: null,
    sinceSha: null,
    previousBlockers: [],
    resume: null,
    decisions: [],
    conflicts: [],
    specsDrift: [],
    direct: false,
  };
  assert.doesNotMatch(stepPrompt(context), /Consignes permanentes/);
  assert.match(
    stepPrompt({ ...context, standing: ["Toujours tester."] }),
    /## Consignes permanentes de l'humain\n.*\n- Toujours tester\./,
  );

  // Le pipeline : chaque étape du run, et le contradicteur, la reçoivent.
  const other = harnessRepo("os-autonomie-autre-");
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [OK.impl],
      review: [OK.review],
      contradicteur: [[{ tool: "challenge_report", args: { findings: [] } }]],
    },
    {
      patch: (config) => {
        config.repos.push(repoDefaults({ name: "autre", path: other, scope: "autre-scope" }));
        config.challenge.steps = ["specs"];
      },
    },
  );
  const { standing } = world.orchestrator;
  const input = (text: string, repo: string | null) => ({ text, repo, source: "manual" as const, sourceRunId: null });
  standing.create(input("Les migrations vont dans un fichier à part.", "demo"), HUMAN);
  standing.create(input("Réponds toujours en français.", null), HUMAN);
  const suspended = standing.create(input("Consigne suspendue.", "demo"), HUMAN);
  standing.update(suspended.id, { enabled: false }, HUMAN);
  standing.create(input("Consigne d'un autre dépôt.", "autre"), HUMAN);
  await started(world, async () => {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter" });
    const done = await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(done.state, "merged", stateOf(world, run.id));
    for (const step of ["req", "specs", "contradicteur", "impl", "review"]) {
      const [prompt] = promptsOf(world, step);
      assert.ok(prompt, `un prompt /${step}`);
      assert.match(prompt, /## Consignes permanentes de l'humain\n/, step);
      assert.ok(prompt.includes("Elles s'imposent : ne les rouvre pas."), step);
      const recent = prompt.indexOf("- Réponds toujours en français.");
      const older = prompt.indexOf("- Les migrations vont dans un fichier à part.");
      assert.ok(recent > 0 && older > recent, `${step} : les deux consignes, la plus récente d'abord`);
      assert.ok(!prompt.includes("Consigne suspendue."), step);
      assert.ok(!prompt.includes("Consigne d'un autre dépôt."), step);
    }
  });
});

const MEDIUM_REVIEW = reviewOf({ risk: "medium", risks: ["volumétrie"], files: ["src/api/export.ts"] });

test("os-autonomie/AC-13 : `always: true` fait d'une réponse d'escalade, d'un refus et d'une correction une consigne permanente du dépôt, dite au prompt suivant ; ignoré pour un pilote ; un dépôt plein refuse le geste sans rien écrire", async () => {
  const fixes = [1, 2, 3, 4].map((n) => [
    { write: "src/api/export.ts", content: `export const exportCsv = () => 'v${n}';\n` },
  ]);
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: ESCALATING_IMPL, review: [MEDIUM_REVIEW], fix: fixes },
    {
      patch: (config) => {
        config.review.autoMergeRisk = "low";
        config.review.escalationTimeoutSec = null;
      },
    },
  );
  const api = await serve(world);
  const rules = () => world.store.listStandingRules(null);
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export daté", request: "Exporter" });
    const escalated = await until(world, run.id, ["escalated", "merged", "failed", "awaiting_human"]);
    assert.equal(escalated.state, "escalated", stateOf(world, run.id));
    const [question] = world.store.listEscalations({ runId: run.id, status: "open" });
    assert.ok(question);
    const answers = (always: unknown) => ({ answers: [{ id: question.id, answer: "table", always }] });
    assert.equal((await api.call("POST", `/v1/runs/${run.id}/escalations`, answers("oui"))).status, 400);
    assert.equal(rules().length, 0);
    const answered = await api.call("POST", `/v1/runs/${run.id}/escalations`, answers(true));
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    const [fromAnswer] = rules();
    assert.deepEqual(
      [fromAnswer?.source, fromAnswer?.repo, fromAnswer?.sourceRunId, fromAnswer?.by, fromAnswer?.enabled],
      ["answer", "demo", run.id, "ops", true],
    );
    assert.equal(fromAnswer?.text, `Quand la question « ${question.question} » se pose : table.`);

    // Le prompt qui reprend /impl la porte déjà.
    const atVerdict = await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.equal(humanWaitOf(atVerdict), "verdict", stateOf(world, run.id));
    assert.ok(promptsOf(world, "impl").at(-1)?.includes(`- ${fromAnswer?.text}`), "la consigne est dite à la reprise");

    // Le refus d'un pilote passe, sans consigne.
    const byPilot = await api.call(
      "POST",
      `/v1/runs/${run.id}/validate`,
      { approve: false, reason: "Le pilote veut une autre forme.", always: true },
      api.tokens.pilot,
    );
    assert.equal(byPilot.status, 200, JSON.stringify(byPilot.body));
    assert.equal(rules().length, 1, "`always` d'un pilote est ignoré");
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);

    // Le refus de l'humain devient une consigne `correction`, dite à la correction qui suit.
    const reason = "N'ajoute jamais de colonne sans migration réversible.";
    for (const bad of [
      { approve: false, reason, always: "oui" },
      { approve: false, reason: "", always: true },
    ])
      assert.equal((await api.call("POST", `/v1/runs/${run.id}/validate`, bad)).status, 400);
    assert.equal(rules().length, 1);
    const refused = await api.call("POST", `/v1/runs/${run.id}/validate`, { approve: false, reason, always: true });
    assert.equal(refused.status, 200, JSON.stringify(refused.body));
    const fromRefusal = rules().find((rule) => rule.source === "correction");
    assert.deepEqual([fromRefusal?.text, fromRefusal?.repo, fromRefusal?.sourceRunId], [reason, "demo", run.id]);
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.ok(promptsOf(world, "fix").at(-1)?.includes(`- ${reason}`), "la consigne est dite à la correction");

    // Une validation avec `always` ne crée rien ; la même phrase n'est pas doublée.
    const { standing } = world.orchestrator;
    const current = world.store.getRun(run.id);
    assert.ok(current);
    assert.equal(standing.fromCorrection(current, `  ${reason} `, HUMAN)?.id, fromRefusal?.id);
    assert.equal(standing.fromCorrection(current, reason, { by: "sentinelle", pilot: true }), null);
    assert.equal(rules().length, 2);

    // `amend` (ici : un verdict en attente, voie `fix`) transmet `always`.
    const correction = "Garde l'export rétrocompatible avec la v1.";
    const amended = await api.call("POST", `/v1/runs/${run.id}/amend`, { text: correction, always: true });
    assert.deepEqual([amended.status, amended.body.via], [200, "fix"], JSON.stringify(amended.body));
    assert.ok(rules().some((rule) => rule.source === "correction" && rule.text === correction));
    assert.equal(rules().length, 3);
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);

    // Un dépôt qui porte déjà ses 40 consignes refuse le geste, sans rien écrire sur le run.
    for (let n = rules().length; n < MAX_ACTIVE_RULES; n++)
      world.store.insertStandingRule({
        id: `sr-plein-${n}`,
        repo: "demo",
        text: `Consigne ${n}.`,
        source: "manual",
        sourceRunId: null,
        by: null,
      });
    const before = world.store.getRun(run.id);
    const full = await api.call("POST", `/v1/runs/${run.id}/validate`, {
      approve: false,
      reason: "Une consigne de trop.",
      always: true,
    });
    assert.equal(full.status, 400, JSON.stringify(full.body));
    const after = world.store.getRun(run.id);
    assert.deepEqual([after?.state, after?.rev], [before?.state, before?.rev], "le refus n'a pas eu lieu");
    assert.equal(rules().length, MAX_ACTIVE_RULES);
    const fullAmend = await api.call("POST", `/v1/runs/${run.id}/amend`, { text: "Encore une.", always: true });
    assert.equal(fullAmend.status, 400);
    assert.equal(world.store.getRun(run.id)?.rev, before?.rev);

    // Sans `always`, le même refus passe.
    const plain = await api.call("POST", `/v1/runs/${run.id}/validate`, { approve: false, reason: "Sans consigne." });
    assert.equal(plain.status, 200);
    assert.equal(rules().length, MAX_ACTIVE_RULES);
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("os-autonomie/AC-14 : les routes de l'autonomie sont servies par apiRoutes() avec leur rôle, décrites dans le README du harness avec leurs outils MCP, et la capacité `os-autonomy` comme les événements `autonomy_level`, `autonomy_rule` et `standing_rule` sont annoncés", () => {
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
  const expected = [
    ["POST", "/v1/runs/{id}/autonomy", "operator"],
    ["POST", "/v1/autonomy/rules", "admin"],
    ["GET", "/v1/rules", "viewer"],
    ["POST", "/v1/rules", "operator"],
    ["PUT", "/v1/rules/{id}", "operator"],
    ["DELETE", "/v1/rules/{id}", "operator"],
  ] as const;
  for (const [method, route, role] of expected) {
    const served = routes.find((candidate) => candidate.method === method && candidate.path === route);
    assert.ok(served, `${method} ${route} n'est pas servie`);
    assert.equal(served.role, role, `${method} ${route}`);
    assert.ok(readme.includes(`\`${method} ${route}`), `${method} ${route} absente du README`);
  }
  assert.ok((API_FEATURES as readonly string[]).includes("os-autonomy"));
  assert.ok(readme.includes("`os-autonomy`"), "la capacité est nommée dans le README");
  for (const type of ["autonomy_level", "autonomy_rule", "standing_rule"]) {
    assert.ok((EVENT_TYPES as readonly string[]).includes(type), type);
    assert.ok(readme.includes(`\`${type}\``), `${type} absent du README`);
  }
  for (const [name, role, readOnly] of [
    ["run_autonomy", "operator", false],
    ["rules", "viewer", true],
    ["rule_set", "operator", false],
  ] as const) {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool, `outil MCP ${name}`);
    assert.deepEqual([tool.role, tool.readOnly], [role, readOnly], name);
    assert.ok(readme.includes(`| \`${name}\``), `${name} absent du README`);
  }
  for (const field of [
    "autoAt",
    "autoAnswer",
    "always?",
    "## Consignes permanentes de l'humain",
    "autonomie:<dépôt>#curseur",
  ])
    assert.ok(readme.includes(field), `${field} absent du README`);
});
