// Feature harness-machine : la machine à états pure req → specs → impl → review ⇄ fix.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STEP_TIERS } from "../../omp-harness/config.ts";
import {
  CANCELLABLE,
  TRANSITIONS,
  afterHumanValidation,
  afterMergeFailed,
  afterMergeStopped,
  afterMerged,
  afterSpecsValidation,
  assertTransition,
  canTransition,
  cancelled,
  nextAfter,
  recovered,
  resumeAfterEscalations,
  resumeAtCheckpoint,
  stepTier,
} from "../../omp-harness/machine.ts";

const limits = { fixCap: 2, stepRetries: 1, specsGate: false };
const done = { kind: "done" as const, escalations: 0 };

test("harness-machine/AC-1 : la chaîne avance req → specs → impl → review, avec un rebase dû à l'entrée en revue", () => {
  assert.equal(nextAfter({ step: "req", fixes: 0, attempts: 0 }, done, limits).step, "specs");
  assert.equal(nextAfter({ step: "specs", fixes: 0, attempts: 0 }, done, limits).step, "impl");
  const review = nextAfter({ step: "impl", fixes: 0, attempts: 0 }, done, limits);
  assert.deepEqual([review.state, review.step, review.rebase, review.keepRunner], ["running", "review", true, false]);
});

test("harness-machine/AC-2 : des bloquants envoient en correction dans le MÊME runner jusqu'au plafond, puis à l'humain", () => {
  const fix = nextAfter({ step: "review", fixes: 0, attempts: 0 }, { ...done, blockers: 2 }, limits);
  assert.deepEqual([fix.step, fix.fixes, fix.keepRunner], ["fix", 1, true]);
  const back = nextAfter({ step: "fix", fixes: 1, attempts: 0 }, done, limits);
  assert.deepEqual([back.step, back.keepRunner], ["review", true]);
  const capped = nextAfter({ step: "review", fixes: 2, attempts: 0 }, { ...done, blockers: 1 }, limits);
  assert.equal(capped.state, "awaiting_human");
  assert.equal(capped.keepRunner, false);
});

test("harness-machine/AC-3 : revue propre → auto-merge si la règle le dit, sinon validation humaine avec ses raisons", () => {
  assert.equal(
    nextAfter({ step: "review", fixes: 0, attempts: 0 }, { ...done, merge: { auto: true } }, limits).state,
    "merging",
  );
  const human = nextAfter(
    { step: "review", fixes: 0, attempts: 0 },
    { ...done, merge: { auto: false, reasons: ["risque high"], readCode: false } },
    limits,
  );
  assert.equal(human.state, "awaiting_human");
  assert.match(human.reason, /risque high/);
});

test("harness-machine/AC-4 : des escalades ouvertes en fin d'étape arrêtent le run, quelle que soit l'étape", () => {
  for (const step of ["req", "specs", "impl", "review", "fix"] as const) {
    const t = nextAfter(
      { step, fixes: 0, attempts: 0 },
      { kind: "done", escalations: 2, blockers: 0, merge: { auto: true } },
      limits,
    );
    assert.deepEqual([t.state, t.step, t.keepRunner], ["escalated", step, false]);
  }
  assert.deepEqual(
    [
      resumeAfterEscalations({ step: "impl", fixes: 0, attempts: 0 }).state,
      resumeAtCheckpoint({ step: "review", fixes: 1, attempts: 0 }, "specs", 3).step,
    ],
    ["queued", "specs"],
  );
});

test("harness-machine/AC-5 : un échec relançable est relancé une fois, puis le run échoue", () => {
  const retry = nextAfter(
    { step: "impl", fixes: 0, attempts: 0 },
    { kind: "failed", reason: "runner mort", retryable: true },
    limits,
  );
  assert.deepEqual([retry.state, retry.step, retry.attempts], ["running", "impl", 1]);
  assert.equal(
    nextAfter({ step: "impl", fixes: 0, attempts: 1 }, { kind: "failed", reason: "x", retryable: true }, limits).state,
    "failed",
  );
  assert.equal(
    nextAfter({ step: "impl", fixes: 0, attempts: 0 }, { kind: "failed", reason: "x", retryable: false }, limits).state,
    "failed",
  );
});

test("harness-machine/AC-6 : gros modèle pour /req, /specs et /review, moyen pour /impl et la correction — la dernière correction passe en heavy ; un refus humain repart en correction", () => {
  assert.deepEqual(DEFAULT_STEP_TIERS, {
    req: "heavy",
    specs: "heavy",
    impl: "standard",
    fix: "standard",
    review: "heavy",
  });
  const tiers = { ...DEFAULT_STEP_TIERS };
  assert.deepEqual(
    [1, 2, 3, 4].map((fixes) => stepTier(tiers, "fix", fixes, 3)),
    ["standard", "standard", "heavy", "heavy"],
  );
  assert.equal(stepTier({ ...tiers, impl: "fast" }, "impl", 0, 3), "fast", "le tier d'une étape se configure");
  assert.equal(afterHumanValidation({ step: "review", fixes: 3, attempts: 0 }, true, "").state, "merging");
  const refused = afterHumanValidation({ step: "review", fixes: 3, attempts: 0 }, false, "trop lent");
  assert.deepEqual([refused.state, refused.step, refused.fixes], ["queued", "fix", 4]);
});

test("harness-machine/AC-7 : avec la porte des specs, /specs terminé attend l'humain ; accord → /impl, refus → /specs refait", () => {
  const gated = nextAfter({ step: "specs", fixes: 0, attempts: 0 }, done, { ...limits, specsGate: true });
  assert.deepEqual([gated.state, gated.step, gated.keepRunner], ["awaiting_human", "specs", false]);
  // Une escalade passe avant la porte : l'humain tranche d'abord, l'étape reprend.
  assert.equal(
    nextAfter({ step: "specs", fixes: 0, attempts: 0 }, { ...done, escalations: 1 }, { ...limits, specsGate: true })
      .state,
    "escalated",
  );
  const cursor = { step: "specs" as const, fixes: 0, attempts: 0 };
  assert.deepEqual(
    [afterSpecsValidation(cursor, true, "").state, afterSpecsValidation(cursor, true, "").step],
    ["queued", "impl"],
  );
  const refused = afterSpecsValidation(cursor, false, "AC-2 invérifiable");
  assert.deepEqual([refused.state, refused.step, refused.fixes], ["queued", "specs", 0]);
  assert.match(refused.reason, /AC-2 invérifiable/);
});

test("harness-machine/AC-8 : toute transition passe par la table — le merge, l'annulation et la reprise aussi ; une transition hors table lève", () => {
  // Les états terminaux ne bougent plus.
  assert.deepEqual(TRANSITIONS.merged, []);
  assert.deepEqual(TRANSITIONS.cancelled, []);
  // Un merge en cours ne s'annule pas ; un run échoué se rouvre ou s'annule.
  assert.ok(!CANCELLABLE.includes("merging"));
  assert.ok(canTransition("failed", "queued"));
  assert.throws(() => assertTransition(["merged"], "queued"), /merged → queued/);
  assert.throws(() => assertTransition(["queued", "merging"], "cancelled"), /merging → cancelled/);
  assert.doesNotThrow(() => assertTransition(CANCELLABLE, "cancelled"));
  // Le merge arrêté retourne en correction, une de plus au compteur ; au plafond, l'humain.
  const stopped = afterMergeStopped({ fixes: 1 }, "fix", "suite rouge", 2);
  assert.deepEqual([stopped.state, stopped.step, stopped.fixes], ["queued", "fix", 2]);
  const capped = afterMergeStopped({ fixes: 2 }, "review", "conflit", 2);
  assert.deepEqual([capped.state, capped.step], ["awaiting_human", null]);
  assert.match(capped.reason, /plafond/);
  assert.deepEqual([afterMerged({ fixes: 1 }).state, afterMerged({ fixes: 1 }).step], ["merged", null]);
  assert.match(afterMergeFailed({ fixes: 0 }, "push refusé").reason, /merge impossible : push refusé/);
  assert.equal(cancelled({ step: "impl", fixes: 0, attempts: 0 }).state, "cancelled");
  const back = recovered({ step: "impl", fixes: 1, attempts: 1 });
  assert.deepEqual([back.state, back.step, back.fixes, back.attempts], ["queued", "impl", 1, 1]);
  // Chaque issue de la machine est une transition que la table permet.
  for (const transition of [stopped, capped]) assert.ok(canTransition("merging", transition.state));
  assert.ok(canTransition("running", recovered({ step: "req", fixes: 0, attempts: 0 }).state));
});
