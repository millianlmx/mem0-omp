// Feature harness-machine : la machine à états pure req → specs → impl → review ⇄ fix.
import test from "node:test";
import assert from "node:assert/strict";
import { STEP_TIER, afterHumanValidation, nextAfter, resumeAfterEscalations, resumeAtCheckpoint } from "../../omp-harness/machine.ts";

const limits = { fixCap: 2, stepRetries: 1 };
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
  assert.equal(nextAfter({ step: "review", fixes: 0, attempts: 0 }, { ...done, merge: { auto: true } }, limits).state, "merging");
  const human = nextAfter({ step: "review", fixes: 0, attempts: 0 }, { ...done, merge: { auto: false, reasons: ["risque high"], readCode: false } }, limits);
  assert.equal(human.state, "awaiting_human");
  assert.match(human.reason, /risque high/);
});


test("harness-machine/AC-4 : des escalades ouvertes en fin d'étape arrêtent le run, quelle que soit l'étape", () => {
  for (const step of ["req", "specs", "impl", "review", "fix"] as const) {
    const t = nextAfter({ step, fixes: 0, attempts: 0 }, { kind: "done", escalations: 2, blockers: 0, merge: { auto: true } }, limits);
    assert.deepEqual([t.state, t.step, t.keepRunner], ["escalated", step, false]);
  }
  assert.deepEqual([resumeAfterEscalations({ step: "impl", fixes: 0, attempts: 0 }).state, resumeAtCheckpoint({ step: "review", fixes: 1, attempts: 0 }, "specs", 3).step], ["queued", "specs"]);
});


test("harness-machine/AC-5 : un échec relançable est relancé une fois, puis le run échoue", () => {
  const retry = nextAfter({ step: "impl", fixes: 0, attempts: 0 }, { kind: "failed", reason: "runner mort", retryable: true }, limits);
  assert.deepEqual([retry.state, retry.step, retry.attempts], ["running", "impl", 1]);
  assert.equal(nextAfter({ step: "impl", fixes: 0, attempts: 1 }, { kind: "failed", reason: "x", retryable: true }, limits).state, "failed");
  assert.equal(nextAfter({ step: "impl", fixes: 0, attempts: 0 }, { kind: "failed", reason: "x", retryable: false }, limits).state, "failed");
});


test("harness-machine/AC-6 : modèle rapide pour /req et /specs, lourd pour /impl, /review et la correction ; un refus humain repart en correction", () => {
  assert.deepEqual(STEP_TIER, { req: "fast", specs: "fast", impl: "heavy", review: "heavy", fix: "heavy" });
  assert.equal(afterHumanValidation({ step: "review", fixes: 3, attempts: 0 }, true, "").state, "merging");
  const refused = afterHumanValidation({ step: "review", fixes: 3, attempts: 0 }, false, "trop lent");
  assert.deepEqual([refused.state, refused.step, refused.fixes], ["queued", "fix", 4]);
});
