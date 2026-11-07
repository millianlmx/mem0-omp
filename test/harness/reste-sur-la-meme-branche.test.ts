// Feature reste-sur-la-meme-branche : un `## Reste` d'impl.md est repris par le même run,
// sur sa branche, une seule fois, au lieu d'ouvrir un run de suite mergé à part.
import test from "node:test";
import assert from "node:assert/strict";
import { OK, fakeWorld, git, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { nextAfter } from "../../omp-harness/machine.ts";
import type { Limits } from "../../omp-harness/machine.ts";

const REMAINING = "- la pagination de l'export";

const IMPL_WITH_REST = [
  { write: "src/api/export.ts", content: "export const exportCsv = () => 'a,b';\n" },
  { write: ".harness/impl.md", content: `## Fait\nAC-1 fait\n## Reste\n${REMAINING}\n` },
];

const IMPL_REST_DONE = [
  { write: "src/api/pagination.ts", content: "export const page = (n: number) => n;\n" },
  { write: ".harness/impl.md", content: "## Fait\nAC-1 fait\nla pagination de l'export\n## Reste\n" },
];

/** La revue du run repris relit les fichiers des deux /impl (sinon l'auto-merge attend l'humain). */
const REVIEW_BOTH = OK.review.map((action) =>
  action.tool === "review_verdict"
    ? { ...action, args: { ...action.args, files: ["src/api/export.ts", "src/api/pagination.ts"] } }
    : action,
);

function stateOf(world: FakeWorld, runId: string): string {
  const run = world.store.getRun(runId);
  return `${run?.state}/${run?.step} — ${run?.reason}`;
}

async function settled(world: FakeWorld, runId: string): Promise<void> {
  await waitFor(
    () => ["merged", "failed", "awaiting_human"].includes(world.store.getRun(runId)?.state ?? ""),
    () => stateOf(world, runId),
    30_000,
  );
}

function continuations(world: FakeWorld, runId: string): number {
  return world.store.eventsSince(0, runId).filter((event) => event.type === "impl_continued").length;
}

test("reste-sur-la-meme-branche/AC-1 : un `## Reste` non vide avec un diff relance /impl sur la même branche, sans nouveau run", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [IMPL_WITH_REST, IMPL_REST_DONE],
    review: [REVIEW_BOTH],
  });
  await world.orchestrator.start();
  try {
    const commitsBefore = Number(git(world.repo, "rev-list", "--count", "main"));
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await settled(world, run.id);
    const steps = world.store.listSteps(run.id);
    assert.deepEqual(
      steps.map((step) => step.kind),
      ["req", "specs", "impl", "impl", "review"],
      stateOf(world, run.id),
    );
    // La reprise ne consomme pas les relances : chaque /impl est une tentative 0.
    assert.deepEqual(
      steps.filter((step) => step.kind === "impl").map((step) => [step.status, step.attempt]),
      [
        ["done", 0],
        ["done", 0],
      ],
    );
    assert.equal(continuations(world, run.id), 1);
    assert.equal(world.store.eventsSince(0, run.id).filter((event) => event.type === "worktree").length, 1);
    assert.deepEqual(
      world.store.listRuns().map((row) => row.id),
      [run.id],
    );
    // Le travail des deux /impl arrive sur main d'un seul commit.
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.equal(Number(git(world.repo, "rev-list", "--count", "main")), commitsBefore + 1);
    assert.equal(git(world.repo, "show", "main:src/api/export.ts"), "export const exportCsv = () => 'a,b';");
    assert.equal(git(world.repo, "show", "main:src/api/pagination.ts"), "export const page = (n: number) => n;");
  } finally {
    await world.orchestrator.stop();
  }
});

test("reste-sur-la-meme-branche/AC-2 : un reste qui persiste après la reprise passe en revue, sans run de suite", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [IMPL_WITH_REST], review: [OK.review] });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await settled(world, run.id);
    const steps = world.store.listSteps(run.id);
    assert.deepEqual(
      steps.map((step) => step.kind),
      ["req", "specs", "impl", "impl", "review"],
      stateOf(world, run.id),
    );
    assert.equal(continuations(world, run.id), 1);
    assert.equal(world.store.listRuns().length, 1);
  } finally {
    await world.orchestrator.stop();
  }
});

test("reste-sur-la-meme-branche/AC-3 : un /impl sans diff qui laisse un reste passe directement en revue, sans reprise", async () => {
  const impl = [
    {
      write: ".harness/impl.md",
      content: `## Fait\nAC-1 → déjà livré par src/api (test harness/AC-1)\n## Reste\n${REMAINING}\n`,
    },
  ];
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [impl], review: [OK.review] });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await settled(world, run.id);
    assert.deepEqual(
      world.store.listSteps(run.id).map((step) => step.kind),
      ["req", "specs", "impl", "review"],
      stateOf(world, run.id),
    );
    assert.equal(continuations(world, run.id), 0);
    assert.equal(world.store.listRuns().length, 1);
  } finally {
    await world.orchestrator.stop();
  }
});

test("reste-sur-la-meme-branche/AC-4 : la consigne de la reprise porte le reste à livrer", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [IMPL_WITH_REST, IMPL_REST_DONE],
    review: [OK.review],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await settled(world, run.id);
    const prompts = world
      .log()
      .filter((entry) => entry.kind === "prompt" && entry.step === "impl" && entry.nudge !== true)
      .map((entry) => String(entry.message));
    assert.equal(prompts.length, 2, stateOf(world, run.id));
    assert.ok(!prompts[0]?.includes(REMAINING), "le premier /impl ne connaît pas encore le reste");
    assert.ok(prompts[1]?.includes(REMAINING), "la reprise reçoit le reste dans sa consigne");
    assert.equal(world.store.instructions(run.id), null, "la consigne est consommée par la reprise");
  } finally {
    await world.orchestrator.stop();
  }
});

test("reste-sur-la-meme-branche/AC-5 : nextAfter — une issue de /impl qui demande une reprise rend running sur impl, relances à zéro", () => {
  const limits: Limits = { fixCap: 2, retryBackoffSec: [120], specsGate: false, mergeRetries: 2 };
  const resumed = nextAfter(
    { step: "impl", fixes: 0, attempts: 1, lastFailCause: "timeout" },
    { kind: "done", escalations: 0, continueImpl: REMAINING },
    limits,
    1_000,
  );
  assert.deepEqual(
    [resumed.state, resumed.step, resumed.attempts, resumed.fixes, resumed.rebase, resumed.notBefore],
    ["running", "impl", 0, 0, false, null],
  );
  // Sans demande de reprise, /impl passe en revue ; des escalades passent avant la reprise.
  assert.equal(
    nextAfter({ step: "impl", fixes: 0, attempts: 0 }, { kind: "done", escalations: 0 }, limits).step,
    "review",
  );
  assert.equal(
    nextAfter(
      { step: "impl", fixes: 0, attempts: 0 },
      { kind: "done", escalations: 1, continueImpl: REMAINING },
      limits,
    ).state,
    "escalated",
  );
});
