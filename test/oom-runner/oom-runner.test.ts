// Fix oom-runner (#374) : un runner tué faute de mémoire (code 137) est reconnu et prévenu.
// Le runner a 1 Go sans swap ; les prompts disent les règles, la relance les rappelle, la
// seconde mort de suite nomme la cause à l'humain.
import test from "node:test";
import assert from "node:assert/strict";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { OOM_CAUSE, isRunnerOom, nextAfter } from "../../omp-harness/machine.ts";
import type { Limits } from "../../omp-harness/machine.ts";
import { RUNNER_MEMORY_RULES, stepPrompt } from "../../omp-harness/prompts.ts";
import type { PromptContext } from "../../omp-harness/prompts.ts";

function stateOf(world: FakeWorld, runId: string): string {
  const run = world.store.getRun(runId);
  return `${run?.state}/${run?.step} — ${run?.reason}`;
}

async function until(world: FakeWorld, runId: string, states: string[]): Promise<void> {
  await waitFor(
    () => states.includes(world.store.getRun(runId)?.state ?? ""),
    () => stateOf(world, runId),
    30_000,
  );
}

function ctx(step: PromptContext["step"]): PromptContext {
  return {
    step,
    title: "Export",
    request: "Exporter",
    baseSha: "abc",
    maxDiffLines: 300,
    memories: null,
    blockers: ["b"],
    previousVerdict: null,
    sinceSha: null,
    previousBlockers: [],
    resume: null,
    decisions: [],
    conflicts: [],
    specsDrift: [],
    direct: false,
  };
}

function assertRules(text: string): void {
  assert.match(text, /UNIQUEMENT par l'outil `run_tests`/);
  assert.match(text, /ni ne lance jamais node, bun, swift, cargo, tsc ou check\.sh dans le shell du runner/);
  assert.match(text, /au plus UN sous-agent à la fois/);
}

test("oom-runner/AC-1 : les prompts de /impl, /impl --fix et /review disent les règles de mémoire du runner", () => {
  for (const step of ["impl", "fix", "review"] as const) assertRules(stepPrompt(ctx(step)));
  assert.doesNotMatch(stepPrompt(ctx("req")), /Mémoire du runner/);
});

test("oom-runner/AC-2 : un runner sorti en 137 est reconnu OOM ; la relance le dit et rappelle les règles", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [[{ exit: 137 }], OK.impl],
    review: [OK.review],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const failed = world.store.listSteps(run.id).find((s) => s.kind === "impl" && s.status === "failed");
    assert.ok(failed && isRunnerOom(String(failed.summary)), String(failed?.summary));
    const prompts = world.log().filter((e) => e.kind === "prompt" && e.step === "impl");
    assert.equal(prompts.length, 2);
    const retry = String(prompts[1]?.message);
    assert.match(retry, /tuée faute de mémoire \(runner arrêté : code 137, OOM\)/);
    assertRules(retry.slice(retry.indexOf("tuée faute de mémoire")));
  } finally {
    await world.orchestrator.stop();
  }
});

test("oom-runner/AC-3 : deux 137 de suite sur la même étape : l'attente humaine nomme la mémoire du runner", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [[{ exit: 137 }]], review: [OK.review] });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    const done = world.store.getRun(run.id);
    assert.equal(done?.state, "awaiting_human", stateOf(world, run.id));
    assert.match(String(done?.reason), /deux fois de suite pour la même cause \(mémoire du runner \(code 137\)\)/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("oom-runner/AC-4 : un échec non 137 garde le comportement actuel", () => {
  const limits: Limits = { fixCap: 3, retryBackoffSec: [0], specsGate: false, mergeRetries: 3 };
  const reason = "runner arrêté : code 1, signal ∅ — boom";
  assert.equal(isRunnerOom(reason), false);
  assert.equal(isRunnerOom("runner arrêté : code 1370, signal ∅"), false);
  const first = nextAfter(
    { step: "impl", fixes: 0, attempts: 0 },
    { kind: "failed", cause: "runner", reason, retryable: true },
    limits,
  );
  assert.equal(first.state, "queued");
  const second = nextAfter(
    { step: "impl", fixes: 0, attempts: 1, lastFailCause: "runner" },
    { kind: "failed", cause: "runner", reason, retryable: true },
    limits,
  );
  assert.equal(second.state, "awaiting_human");
  assert.equal(second.reason, `/impl a échoué deux fois de suite pour la même cause (runner) : ${reason}`);
  assert.ok(!second.reason?.includes(OOM_CAUSE));
  assert.ok(RUNNER_MEMORY_RULES.length > 0);
});
