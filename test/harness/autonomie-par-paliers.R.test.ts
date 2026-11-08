// Feature autonomie-par-paliers, partie R : la porte de revue (AC-7 à AC-12, AC-18, AC-25, AC-26, AC-5).
import test from "node:test";
import assert from "node:assert/strict";
import { humanWaitOf } from "../../omp-harness/machine.ts";
import { BUG_REVIEW_RULE, autonomyDecisions, bugWorld, eventsOf, stateOf, until } from "../support/autonomie-fixtures.ts";

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
