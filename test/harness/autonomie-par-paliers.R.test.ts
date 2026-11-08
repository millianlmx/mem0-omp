// Feature autonomie-par-paliers, partie R : la porte de revue (AC-7 à AC-12, AC-18, AC-25, AC-26, AC-5).
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AutonomyRule } from "../../omp-harness/autonomy-rules.ts";
import { humanWaitOf } from "../../omp-harness/machine.ts";
import { createHandler } from "../../omp-harness/http.ts";
import {
  BUG_REVIEW_RULE,
  autonomyDecisions,
  bugWorld,
  configure,
  eventsOf,
  lines,
  reviewOf,
  stateOf,
  until,
} from "../support/autonomie-fixtures.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";

test("autonomie-par-paliers/AC-7 : un bug de 40 lignes avec test et suite verte, sous une règle review: auto, est fusionné seul", async () => {
  const world = bugWorld({ rules: [BUG_REVIEW_RULE] });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({
      repo: "demo",
      title: "Corriger l'export",
      request: "Corriger",
      kind: "bug",
      labels: ["export"],
    });
    const done = await until(world, run.id, ["merged", "awaiting_human", "failed"]);
    assert.equal(done.state, "merged", stateOf(world, run.id));
    const [decision, ...others] = autonomyDecisions(world, run.id);
    assert.equal(others.length, 0);
    assert.equal(decision?.status, "auto");
    assert.equal(decision?.autonomy?.gate, "review");
    assert.equal(decision?.autonomy?.rule.rank, 1);
    assert.deepEqual(decision?.autonomy?.rule.match, { kind: "bug", maxDiffLines: 50 });
    const proofs = decision?.autonomy?.proofs;
    assert.equal(proofs?.diffLines, 40);
    assert.equal(proofs?.reviewMaxDiffLines, 30);
    assert.equal(proofs?.ruleMaxDiffLines, 50);
    assert.equal(proofs?.fullTests, "pass");
    assert.deepEqual(proofs?.reproTests, ["test/export.test.ts"]);
    assert.deepEqual(proofs?.provenCriteria, ["AC-1"]);
    assert.deepEqual(
      eventsOf(world, run.id, "autonomy").map((e) => e.payload.action),
      ["hold", "validate"],
    );
    assert.equal(eventsOf(world, run.id, "verdict").length, 0, "la notification est retenue");
    const validation = eventsOf(world, run.id, "validation")[0];
    assert.equal(validation?.payload.gate, "verdict");
    assert.equal(validation?.payload.liftable, true);
    assert.match(String(validation?.payload.by), /^autonomie:demo#1$/);
    assert.equal(humanWaitOf({ state: "awaiting_human", step: null, reason: "validation humaine : x" }), "verdict");
  } finally {
    await world.orchestrator.stop();
  }
});

// ── Lot R-A : les refus de la porte de revue ────────────────────────────────────────────────────

type CaseOptionsRA = {
  rules: AutonomyRule[] | null;
  diff?: number;
  test?: "none" | "added";
  review?: unknown[];
  untyped?: boolean;
};

/** Mène un run `bug` (ou sans type si `untyped`) jusqu'à un état d'arrêt, et rend monde, id et run. */
async function runCaseRA(options: CaseOptionsRA) {
  const world = bugWorld({ rules: options.rules, diff: options.diff, test: options.test, review: options.review });
  await world.orchestrator.start();
  const run = world.orchestrator.createRun({
    repo: "demo",
    title: "Corriger l'export",
    request: "Corriger",
    ...(options.untyped === true ? {} : { kind: "bug" as const, labels: ["export"] }),
  });
  const done = await until(world, run.id, ["merged", "awaiting_human", "failed"]);
  return { world, runId: run.id, done };
}

/** La raison d'attente du même run dans un monde sans règle d'autonomie. */
async function baselineReasonRA(options: CaseOptionsRA): Promise<string | null> {
  const { world, done } = await runCaseRA({ ...options, rules: null });
  try {
    assert.equal(done.state, "awaiting_human", `le monde sans autonomie attend l'humain : ${done.state}/${done.reason}`);
    return done.reason;
  } finally {
    await world.orchestrator.stop();
  }
}

/** Le run attend l'humain, pour la raison d'un monde sans autonomie, et l'autonomie n'a laissé aucune trace. */
async function assertWaitsHumanRA(options: CaseOptionsRA & { untyped?: boolean }, message: string): Promise<void> {
  const expected = await baselineReasonRA(options);
  const { world, runId, done } = await runCaseRA(options);
  try {
    assert.equal(done.state, "awaiting_human", `${message} : ${stateOf(world, runId)}`);
    assert.equal(done.reason, expected, `${message} : raison inchangée`);
    assert.equal(eventsOf(world, runId, "autonomy").length, 0, `${message} : aucun événement autonomy`);
    assert.equal(autonomyDecisions(world, runId).length, 0, `${message} : aucune décision d'autonomie`);
    assert.equal(eventsOf(world, runId, "verdict").length, 1, `${message} : la notification part`);
    assert.match(String(expected), /diff de \d+ lignes/, `${message} : le diff est bien la raison de l'attente`);
  } finally {
    await world.orchestrator.stop();
  }
}

test("autonomie-par-paliers/AC-8 : le même run avec 80 lignes de diff reste awaiting_human, sans décision prise seule", async () => {
  await assertWaitsHumanRA({ rules: [BUG_REVIEW_RULE], diff: 80 }, "80 lignes > match.maxDiffLines 50");
});

test("autonomie-par-paliers/AC-9 : sans test ajouté ou avec une suite complète rouge, le run attend l'humain", async () => {
  // Cas 1 : aucun test ajouté ni modifié (suite verte, diff seul en cause) → l'humain.
  await assertWaitsHumanRA({ rules: [BUG_REVIEW_RULE], diff: 40, test: "none" }, "sans test de reproduction");

  // Cas 2 : suite complète rouge sur l'arbre — le test de reproduction n'est pas vert. L'auto-merge refuse
  // pour autre chose que le diff (bloquant « suite complète rouge ») : le run repart en correction, il n'est
  // ni fusionné ni validé seul.
  const impl = [
    { write: "src/api/export.ts", content: lines(40) },
    { write: "test/export.test.ts", content: "import test from 'node:test';\ntest('export', () => {});\n" },
    { write: "FAIL_FULL", content: "" },
    { write: ".harness/impl.md", content: "## Fait\nAC-1 fait\n## Reste\n" },
  ];
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: [impl], review: [reviewOf()], fix: [[{ sleep: 60_000 }]] },
    { patch: configure([BUG_REVIEW_RULE]) },
  );
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Corriger l'export", request: "Corriger", kind: "bug" });
    await waitFor(
      () =>
        world.store.getRun(run.id)?.step === "fix" ||
        ["merged", "failed", "awaiting_human"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => stateOf(world, run.id),
      30_000,
    );
    const current = world.store.getRun(run.id);
    assert.equal(current?.step, "fix", `suite rouge : ni fusionné ni validé seul — ${stateOf(world, run.id)}`);
    assert.notEqual(current?.state, "merged");
    assert.equal(autonomyDecisions(world, run.id).length, 0, "suite rouge : aucune décision prise seule");
    assert.equal(eventsOf(world, run.id, "autonomy").length, 0, "suite rouge : aucun événement autonomy");
  } finally {
    await world.orchestrator.stop();
  }
});

test("autonomie-par-paliers/AC-10 : avec require.proofs, un critère non prouvé pass (absent, non testé, en échec ou non vérifié) laisse l'attente à l'humain", async () => {
  const proofsRule: AutonomyRule = {
    match: { kind: "bug", maxDiffLines: 50 },
    require: { reproTest: true, greenChecks: true, proofs: true },
    gates: { specs: "human", review: "auto" },
  };
  const verdictOf = (args: Record<string, unknown>) => reviewOf(args);
  const cases: { name: string; review: unknown[] }[] = [
    { name: "AC-1 non testé", review: verdictOf({ criteria: [{ id: "AC-1", test: "", status: "untested" }] }) },
    { name: "AC-1 en échec", review: verdictOf({ criteria: [{ id: "AC-1", test: "harness/AC-1", status: "fail" }] }) },
    { name: "AC-1 absent du verdict", review: verdictOf({ criteria: [{ id: "AC-2", test: "harness/AC-2", status: "pass" }] }) },
    { name: "AC-1 non vérifié", review: verdictOf({ unverified: ["AC-1 : export non rejoué"] }) },
  ];
  for (const item of cases) {
    const expected = await baselineReasonRA({ rules: null, review: item.review });
    const { world, runId, done } = await runCaseRA({ rules: [proofsRule], review: item.review });
    try {
      assert.equal(done.state, "awaiting_human", `${item.name} : ${stateOf(world, runId)}`);
      assert.equal(done.reason, expected, `${item.name} : raison inchangée`);
      assert.match(String(done.reason), /critère/, `${item.name} : le critère est la raison de l'attente`);
      assert.equal(eventsOf(world, runId, "autonomy").length, 0, `${item.name} : aucun événement autonomy`);
      assert.equal(autonomyDecisions(world, runId).length, 0, `${item.name} : aucune décision d'autonomie`);
    } finally {
      await world.orchestrator.stop();
    }
  }
  // Témoin : la même règle, tous les critères prouvés pass → la règle n'est pas ce qui bloque.
  const { world, runId, done } = await runCaseRA({ rules: [proofsRule] });
  try {
    assert.equal(done.state, "merged", stateOf(world, runId));
    assert.deepEqual(autonomyDecisions(world, runId)[0]?.autonomy?.proofs.provenCriteria, ["AC-1"]);
  } finally {
    await world.orchestrator.stop();
  }
});

test("autonomie-par-paliers/AC-11 : match.paths [docs/] ne correspond pas à un fichier hors de docs/ ; une règle suivante qui correspond s'applique", async () => {
  const docsOnly: AutonomyRule = { ...BUG_REVIEW_RULE, match: { kind: "bug", maxDiffLines: 50, paths: ["docs/"] } };
  await assertWaitsHumanRA({ rules: [docsOnly] }, "seule règle limitée à docs/");

  const srcRule: AutonomyRule = { ...BUG_REVIEW_RULE, match: { kind: "bug", maxDiffLines: 50, paths: ["src/", "test/"] } };
  const { world, runId, done } = await runCaseRA({ rules: [docsOnly, srcRule] });
  try {
    assert.equal(done.state, "merged", stateOf(world, runId));
    const [decision, ...others] = autonomyDecisions(world, runId);
    assert.equal(others.length, 0);
    assert.equal(decision?.autonomy?.rule.rank, 2, "la seconde règle s'applique");
    assert.deepEqual(decision?.autonomy?.rule.match, { kind: "bug", maxDiffLines: 50, paths: ["src/", "test/"] });
  } finally {
    await world.orchestrator.stop();
  }
});

test("autonomie-par-paliers/AC-12 : deux règles correspondantes, la première review: human et la seconde auto, laissent l'attente à l'humain", async () => {
  const human: AutonomyRule = { match: { kind: "bug", maxDiffLines: 50 }, require: {}, gates: { specs: "human", review: "human" } };
  await assertWaitsHumanRA({ rules: [human, BUG_REVIEW_RULE] }, "la première règle retenue est human");
  // Contre-épreuve : dans l'ordre inverse, la règle auto vient d'abord et le run est fusionné.
  const { world, runId, done } = await runCaseRA({ rules: [BUG_REVIEW_RULE, human] });
  try {
    assert.equal(done.state, "merged", stateOf(world, runId));
    assert.equal(autonomyDecisions(world, runId)[0]?.autonomy?.rule.rank, 1);
  } finally {
    await world.orchestrator.stop();
  }
});

test("autonomie-par-paliers/AC-26 : une règle sans match.maxDiffLines ne lève pas l'attente de diff", async () => {
  const unbounded: AutonomyRule = {
    match: { kind: "bug" },
    require: { reproTest: true, greenChecks: true },
    gates: { specs: "human", review: "auto" },
  };
  await assertWaitsHumanRA({ rules: [unbounded] }, "règle sans maxDiffLines");
});

test("autonomie-par-paliers/AC-5 : un run créé sans type attend l'humain, mêmes preuves vertes et règle bug en auto", async () => {
  await assertWaitsHumanRA({ rules: [BUG_REVIEW_RULE], untyped: true }, "run sans type");
});

test("autonomie-par-paliers/AC-18 : un run validé seul est lu dans /v1/inbox et /v1/decisions?status=auto : run, porte, règle et preuves, hors pendingCount", async () => {
  const { world, runId, done } = await runCaseRA({ rules: [BUG_REVIEW_RULE] });
  const token = "t".repeat(64);
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token }));
  try {
    assert.equal(done.state, "merged", stateOf(world, runId));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (route: string) => {
      const response = await fetch(`${url}${route}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200, route);
      return (await response.json()) as Record<string, unknown>;
    };
    type Seen = { runId: string; status: string; autonomy: { gate: string; rule: { rank: number; match: unknown }; proofs: Record<string, unknown> } | null };
    const decisions = ((await get("/v1/decisions?status=auto")).decisions as Seen[]).filter((d) => d.autonomy !== null);
    const inbox = await get("/v1/inbox");
    const inboxed = (inbox.decisions as Seen[]).filter((d) => d.autonomy !== null);
    for (const [where, seen] of [["decisions", decisions], ["inbox", inboxed]] as const) {
      assert.equal(seen.length, 1, `${where} : une décision d'autonomie`);
      const [decision] = seen;
      assert.equal(decision?.runId, runId, `${where} : nomme le run`);
      assert.equal(decision?.status, "auto");
      assert.equal(decision?.autonomy?.gate, "review", `${where} : la porte franchie`);
      assert.equal(decision?.autonomy?.rule.rank, 1, `${where} : le rang`);
      assert.deepEqual(decision?.autonomy?.rule.match, { kind: "bug", maxDiffLines: 50 }, `${where} : le match`);
      const proofs = decision?.autonomy?.proofs;
      assert.equal(proofs?.diffLines, 40, `${where} : diff`);
      assert.equal(proofs?.reviewMaxDiffLines, 30);
      assert.equal(proofs?.ruleMaxDiffLines, 50);
      assert.equal(proofs?.fullTests, "pass");
      assert.deepEqual(proofs?.reproTests, ["test/export.test.ts"]);
      assert.deepEqual(proofs?.provenCriteria, ["AC-1"]);
    }
    assert.equal(inbox.pendingCount, 0, "une décision prise seule ne bloque rien : hors de pendingCount");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});
