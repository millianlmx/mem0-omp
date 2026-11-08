import test from "node:test";
import { BUG_REVIEW_RULE, bugWorld, eventsOf, until } from "../support/autonomie-fixtures.ts";

test("diag", async () => {
  const world = bugWorld({ rules: [BUG_REVIEW_RULE] });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "t", request: "r", kind: "bug", labels: ["export"] });
    await until(world, run.id, ["merged", "awaiting_human", "failed"]);
    console.log(JSON.stringify(eventsOf(world, run.id, "autonomy").map((e) => e.payload)));
    console.log(world.store.getArtifact(run.id, "_review-evidence.json"));
    const r = world.store.getRun(run.id);
    console.log(r?.state, r?.step, r?.kind, JSON.stringify(r?.verdict));
  } finally {
    await world.orchestrator.stop?.();
  }
});
