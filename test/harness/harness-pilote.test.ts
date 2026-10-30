// Feature harness-pilote : le pilote d'un audit lancé tranche, à la place de l'humain, ce
// qui est réversible sur les runs qui en descendent (specs, verdicts, arbitrages, relances),
// par les gestes de l'humain ; l'irréversible, le budget et ce qui dépasse son plafond
// restent à l'humain.
import test from "node:test";
import assert from "node:assert/strict";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import type { EventRow } from "../../omp-harness/db.ts";
import { humanWaitOf } from "../../omp-harness/machine.ts";
import { notificationFor } from "../../omp-harness/notify.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";

const PROPOSAL = {
  title: "Exporter en CSV",
  request: "Exporter les données au format CSV",
  modules: ["src/api"],
  kind: "feature",
  rationale: "les clients le demandent",
  evidence: [],
  dependsOn: [],
  impact: "high",
  effort: "low",
};

const REVIEW_HIGH = [
  OK.review[0],
  { tool: "review_verdict", args: { ...(OK.review[1]?.args as Record<string, unknown>), risk: "high" } },
];

const act = (action: string, reason: string, instructions: string | null = null) => ({
  tool: "pilot_act",
  args: { action, reason, instructions },
});

const EMPTY_IMPL = [{ write: ".harness/impl.md", content: "## Fait\n## Reste\n- tout\n" }];

/** La porte « auto » des specs, comme en production (les fixtures la coupent). */
function gate(config: HarnessConfig): void {
  config.review.specsGate = "auto";
}

/** Une étape en échec attend l'humain tout de suite, sans relance différée. */
function failFast(config: HarnessConfig): void {
  config.runner.stepRetries = 0;
}

function describe(world: FakeWorld): string {
  return world.store
    .listRuns()
    .map((run) => `${run.title}: ${run.state}/${run.step} — ${run.reason}`)
    .join(" | ");
}

/** Un audit proposé puis lancé : le run de sa proposition. */
async function launched(world: FakeWorld): Promise<{ auditId: string; runId: string }> {
  const audit = world.orchestrator.audits.create("demo", "l'export");
  await waitFor(
    () => world.store.getAudit(audit.id)?.state === "proposed",
    () => JSON.stringify(world.store.getAudit(audit.id)),
  );
  const { projectId } = await world.orchestrator.audits.launch(audit.id, [0]);
  const run = world.store.listRuns({ projectId })[0];
  assert.ok(run);
  return { auditId: audit.id, runId: run.id };
}

function pilotEvents(world: FakeWorld, runId: string): EventRow[] {
  return world.store.eventsSince(0, runId).filter((event) => event.type === "pilot");
}

function pilotPrompts(world: FakeWorld): Record<string, unknown>[] {
  return world.log().filter((entry) => entry.kind === "prompt" && entry.step === "pilote" && !entry.nudge);
}

test("harness-pilote/AC-1 : l'attente d'un run se lit dans sa raison — specs, geste irréversible, verdict, arbitrage, budget, panne", () => {
  const wait = (step: string | null, reason: string, state = "awaiting_human") =>
    humanWaitOf({ state: state as "awaiting_human", step: step as "specs", reason });
  assert.equal(wait("specs", "specs à valider avant /impl : première feature d'un projet"), "specs");
  assert.equal(wait("specs", "specs à valider avant /impl : geste irréversible (deletion)"), "irreversible");
  assert.equal(wait("specs", "specs à valider avant /impl (découpage, modules ou geste irréversible)"), "specs");
  assert.equal(wait("specs", "/specs a échoué deux fois de suite pour la même cause (missing_output) : x"), "failure");
  assert.equal(wait(null, "validation humaine : diff de 555 lignes (> 300)"), "verdict");
  assert.equal(wait(null, "plafond de corrections atteint (3) avec 2 bloquant(s)"), "arbitration");
  assert.equal(wait("fix", "le correcteur conteste les bloquants une seconde fois : aucune correction"), "arbitration");
  assert.equal(
    wait("impl", "budget dépassé : 5.00 $ pour un plafond de 4.00 $ — relance la feature pour continuer"),
    "budget",
  );
  assert.equal(wait(null, "conflit avec main avant merge : a.ts — plafond de tentatives de merge atteint"), "failure");
  assert.equal(wait("impl", "validation humaine", "running"), null);
});

test("harness-pilote/AC-2 : le pilote valide les specs puis le verdict d'une feature de l'audit, qui fusionne sans geste humain", async () => {
  const world = fakeWorld(
    {
      audit: [[{ tool: "audit_propose", args: { proposals: [PROPOSAL] } }]],
      req: [OK.req],
      specs: [OK.specs],
      impl: [OK.impl],
      review: [REVIEW_HIGH],
      pilote: [[act("approve", "AC-1 livré et prouvé par harness/AC-1")]],
    },
    { patch: gate },
  );
  await world.orchestrator.start();
  try {
    const { auditId, runId } = await launched(world);
    await waitFor(
      () => world.store.getRun(runId)?.state === "merged",
      () => describe(world),
      60_000,
    );
    assert.deepEqual(
      pilotEvents(world, runId).map((event) => [event.payload.action, event.payload.by]),
      [
        ["approve", `pilote:${auditId}`],
        ["approve", `pilote:${auditId}`],
      ],
    );
    const moved = world.store
      .eventsSince(0, runId)
      .filter((event) => event.type === "run_state" && event.payload.by === `pilote:${auditId}`)
      .map((event) => event.payload.state);
    assert.deepEqual(moved, ["queued", "merging"]);
    // Le pilote lit le contexte de l'audit : son focus et la proposition d'origine.
    const prompt = String(pilotPrompts(world)[0]?.message ?? "");
    assert.match(prompt, /focus : l'export/);
    assert.match(prompt, /## Proposition de l'audit\nExporter en CSV \(feature/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pilote/AC-3 : des specs à geste irréversible restent à l'humain, sans session ; seul un `defer` notifie", async () => {
  const specs = [
    {
      write: ".harness/specs.md",
      content: String(OK.specs[0]?.content).replace(
        "S-1 (AC-1) : export CSV",
        "S-1 (AC-1) : export CSV, puis supprimer les données exportées",
      ),
    },
  ];
  const world = fakeWorld(
    {
      audit: [[{ tool: "audit_propose", args: { proposals: [PROPOSAL] } }]],
      req: [OK.req],
      specs: [specs],
      pilote: [[act("approve", "ne doit jamais être appelé")]],
    },
    { patch: gate },
  );
  await world.orchestrator.start();
  try {
    const { runId } = await launched(world);
    await waitFor(
      () => pilotEvents(world, runId).length > 0,
      () => describe(world),
      60_000,
    );
    const [event] = pilotEvents(world, runId);
    assert.equal(event?.payload.action, "defer");
    assert.match(String(event?.payload.reason), /irréversible/);
    // Deux tours de scheduling de plus : le pilote a revu l'attente, sans rien relancer.
    await world.orchestrator.tick();
    await world.orchestrator.tick();
    assert.equal(pilotPrompts(world).length, 0);
    assert.equal(pilotEvents(world, runId).length, 1, "une attente n'est lue qu'une fois");
    assert.equal(world.store.getRun(runId)?.state, "awaiting_human");
    const run = world.store.getRun(runId);
    assert.match(notificationFor(event as EventRow, run)?.title ?? "", /Le pilote te laisse la main/);
    assert.equal(
      notificationFor({ ...(event as EventRow), payload: { ...event?.payload, action: "approve" } }, run),
      null,
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pilote/AC-4 : sur une panne, seuls relance, abandon et défèrement sont permis ; la relance porte sa consigne à l'étape", async () => {
  const world = fakeWorld(
    {
      audit: [[{ tool: "audit_propose", args: { proposals: [PROPOSAL] } }]],
      req: [OK.req],
      specs: [OK.specs],
      impl: [EMPTY_IMPL, OK.impl],
      review: [OK.review],
      pilote: [
        [
          act("approve", "tout est livré"),
          act("retry", "l'export n'existe pas encore", "Écris src/api/export.ts et son test AC-1"),
        ],
      ],
    },
    { patch: failFast },
  );
  await world.orchestrator.start();
  try {
    const { runId } = await launched(world);
    await waitFor(
      () => world.store.getRun(runId)?.state === "merged",
      () => describe(world),
      60_000,
    );
    const results = world.log().filter((entry) => entry.kind === "tool" && entry.tool === "pilot_act");
    assert.match(String(results[0]?.result), /geste non permis ici : approve \(permis : retry, cancel, defer\)/);
    assert.match(String(results[1]?.result), /retry appliqué/);
    const implPrompts = world.log().filter((entry) => entry.kind === "prompt" && entry.step === "impl" && !entry.nudge);
    assert.match(String(implPrompts.at(-1)?.message), /Écris src\/api\/export\.ts et son test AC-1/);
    assert.match(
      String(world.store.eventsSince(0, runId).find((e) => e.type === "run_state" && e.payload.by)?.payload.reason),
      /relancé par le pilote de l'audit/,
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pilote/AC-5 : au-delà de `pilot.actionsPerRun` gestes sur un run, l'attente suivante revient à l'humain sans session", async () => {
  const world = fakeWorld(
    {
      audit: [[{ tool: "audit_propose", args: { proposals: [PROPOSAL] } }]],
      req: [OK.req],
      specs: [OK.specs],
      impl: [EMPTY_IMPL],
      pilote: [[act("retry", "nouvel essai", "Écris le code")]],
    },
    {
      patch: (config) => {
        failFast(config);
        config.pilot.actionsPerRun = 1;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const { runId } = await launched(world);
    await waitFor(
      () => pilotEvents(world, runId).length >= 2,
      () => describe(world),
      60_000,
    );
    assert.deepEqual(
      pilotEvents(world, runId).map((event) => event.payload.action),
      ["retry", "defer"],
    );
    assert.match(String(pilotEvents(world, runId)[1]?.payload.reason), /déjà agi 1 fois/);
    assert.equal(pilotPrompts(world).length, 1);
    assert.equal(world.store.getRun(runId)?.state, "awaiting_human");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pilote/AC-6 : un refus du pilote part en correction avec sa consigne, sans devenir une correction humaine dans l'oracle", async () => {
  const world = fakeWorld(
    {
      audit: [[{ tool: "audit_propose", args: { proposals: [PROPOSAL] } }]],
      req: [OK.req],
      specs: [OK.specs],
      impl: [OK.impl],
      review: [REVIEW_HIGH],
      fix: [[{ sleep: 60_000 }]],
      pilote: [[act("refuse", "AC-1 : le CSV n'échappe pas les virgules ; ajoute ce cas au test")]],
    },
    { patch: failFast },
  );
  await world.orchestrator.start();
  try {
    const { runId } = await launched(world);
    await waitFor(
      () => world.log().some((entry) => entry.kind === "prompt" && entry.step === "fix"),
      () => describe(world),
      60_000,
    );
    const fix = world.log().find((entry) => entry.kind === "prompt" && entry.step === "fix");
    assert.match(String(fix?.message), /Le pilote de l'audit a refusé le verdict : AC-1 : le CSV n'échappe pas/);
    assert.ok(!world.oracle.retained.some((memory) => /Correction humaine/.test(memory.text)));
    assert.match(
      String(world.store.eventsSince(0, runId).find((e) => e.type === "run_state" && e.payload.by)?.payload.reason),
      /refusé par le pilote de l'audit/,
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pilote/AC-7 : le pilote suit les runs de suite d'une feature de l'audit, jamais un run hors de l'audit", async () => {
  const world = fakeWorld(
    {
      audit: [[{ tool: "audit_propose", args: { proposals: [PROPOSAL] } }]],
      req: [OK.req],
      specs: [OK.specs],
      impl: [OK.impl],
      review: [REVIEW_HIGH],
      pilote: [[act("approve", "AC-1 livré et prouvé")]],
    },
    { patch: failFast },
  );
  await world.orchestrator.start();
  try {
    const { runId } = await launched(world);
    const suite = await world.orchestrator.createRun({
      repo: "demo",
      title: "Suite de « Exporter en CSV »",
      request: "Le reste",
    });
    world.store.appendEvent("follow_up", runId, { runId: suite.id }, "demo");
    const outsider = await world.orchestrator.createRun({ repo: "demo", title: "Hors audit", request: "Autre chose" });
    await waitFor(
      () =>
        world.store.getRun(runId)?.state === "merged" &&
        world.store.getRun(suite.id)?.state === "merged" &&
        world.store.getRun(outsider.id)?.state === "awaiting_human",
      () => describe(world),
      90_000,
    );
    await world.orchestrator.tick();
    await world.orchestrator.tick();
    assert.equal(pilotEvents(world, suite.id).length, 1);
    assert.equal(pilotEvents(world, outsider.id).length, 0);
    assert.equal(world.store.getRun(outsider.id)?.state, "awaiting_human");
  } finally {
    await world.orchestrator.stop();
  }
});
