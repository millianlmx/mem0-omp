// Feature harness-machine : la machine à états pure req → specs → impl → review ⇄ fix.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STEP_TIERS } from "../../omp-harness/config.ts";
import {
  CANCELLABLE,
  MERGE_BACKOFF_MS,
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
  retried,
  stepTier,
} from "../../omp-harness/machine.ts";
import type { FailCause, Limits, StepOutcome } from "../../omp-harness/machine.ts";

const limits: Limits = { fixCap: 2, retryBackoffSec: [0], specsGate: false, mergeRetries: 2 };
const done = { kind: "done" as const, escalations: 0 };
const failed = (cause: FailCause, retryable = true, reason = "x"): StepOutcome => ({
  kind: "failed",
  reason,
  retryable,
  cause,
});

test("harness-machine/AC-1 : la chaîne avance req → specs → impl → review ; le runner survit de req à specs, un rebase est dû à l'entrée en revue", () => {
  const specs = nextAfter({ step: "req", fixes: 0, attempts: 0 }, done, limits);
  assert.deepEqual([specs.step, specs.keepRunner], ["specs", true]);
  assert.equal(nextAfter({ step: "specs", fixes: 0, attempts: 0 }, done, limits).step, "impl");
  const review = nextAfter({ step: "impl", fixes: 0, attempts: 0 }, done, limits);
  assert.deepEqual([review.state, review.step, review.rebase, review.keepRunner], ["running", "review", true, false]);
});

test("harness-machine/AC-2 : des bloquants envoient en correction dans le MÊME runner jusqu'au plafond, puis à l'humain ; la revue qui suit une correction part d'un runner neuf", () => {
  const fix = nextAfter({ step: "review", fixes: 0, attempts: 0 }, { ...done, blockers: 2 }, limits);
  assert.deepEqual([fix.step, fix.fixes, fix.keepRunner], ["fix", 1, true]);
  const back = nextAfter({ step: "fix", fixes: 1, attempts: 0 }, done, limits);
  assert.deepEqual([back.step, back.keepRunner], ["review", false]);
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

test("harness-machine/AC-5 : un échec relançable est remis en file après le backoff de sa tentative ; liste épuisée ⇒ l'humain (qui peut relancer) ; non relançable ⇒ échec", () => {
  const backoff: Limits = { ...limits, retryBackoffSec: [120, 600] };
  const first = nextAfter({ step: "impl", fixes: 0, attempts: 0 }, failed("timeout"), backoff, 1_000_000);
  assert.deepEqual([first.state, first.step, first.attempts, first.notBefore], ["queued", "impl", 1, 1_120_000]);
  assert.match(first.reason, /120 s/);
  const second = nextAfter(
    { step: "impl", fixes: 0, attempts: 1, lastFailCause: "timeout" },
    failed("network"),
    backoff,
    2_000_000,
  );
  assert.deepEqual([second.state, second.attempts, second.notBefore], ["queued", 2, 2_600_000]);
  const exhausted = nextAfter(
    { step: "impl", fixes: 0, attempts: 2, lastFailCause: "network" },
    failed("rate_limit"),
    backoff,
    3_000_000,
  );
  assert.deepEqual([exhausted.state, exhausted.step, exhausted.attempts, exhausted.notBefore], ["awaiting_human", "impl", 2, null]);
  assert.match(exhausted.reason, /3 fois \(rate_limit\), relances épuisées/);
  const fatal = nextAfter({ step: "impl", fixes: 0, attempts: 0 }, failed("runner", false), backoff, 0);
  assert.deepEqual([fatal.state, fatal.notBefore], ["failed", null]);
  // Une transition sans échec n'attend pas.
  assert.equal(nextAfter({ step: "req", fixes: 0, attempts: 0 }, done, limits).notBefore, null);
});

test("harness-machine/AC-9 : une cause qui se résout en attendant consomme toute la liste de backoff, même répétée ; une autre cause répétée deux fois de suite passe à l'humain", () => {
  const three: Limits = { ...limits, retryBackoffSec: [0, 0, 0] };
  // Quota, réseau, fournisseur, délai : on attend, encore et encore.
  for (const cause of ["rate_limit", "network", "provider", "server_error", "timeout"] as const) {
    const again = nextAfter({ step: "impl", fixes: 0, attempts: 1, lastFailCause: cause }, failed(cause), three);
    assert.deepEqual([again.state, again.attempts], ["queued", 2], cause);
  }
  // Contexte, runner, inconnu : la seconde fois de suite, l'humain.
  for (const cause of ["context", "runner", "other"] as const) {
    const human = nextAfter({ step: "impl", fixes: 0, attempts: 1, lastFailCause: cause }, failed(cause, true, "x"), three);
    assert.deepEqual([human.state, human.step, human.attempts], ["awaiting_human", "impl", 1], cause);
    assert.match(human.reason, new RegExp(`deux fois de suite .*${cause}.*x`));
    // Une cause différente continue les relances.
    assert.equal(nextAfter({ step: "impl", fixes: 0, attempts: 1, lastFailCause: cause }, failed("network"), three).state, "queued");
  }
  // Un run sans échec précédent n'est pas concerné ; liste à une entrée épuisée ⇒ l'humain.
  assert.equal(nextAfter({ step: "impl", fixes: 0, attempts: 1, lastFailCause: null }, failed("context"), limits).state, "awaiting_human");
  assert.equal(nextAfter({ step: "impl", fixes: 0, attempts: 0, lastFailCause: null }, failed("context"), limits).state, "queued");
});

test("harness-machine/AC-10 : un correcteur qui ne change rien conteste — retour en revue dans un runner neuf, puis l'humain à la seconde contestation", () => {
  const contest = failed("missing_output", true, "aucune correction");
  const again = nextAfter({ step: "fix", fixes: 1, attempts: 0 }, contest, limits);
  assert.deepEqual([again.state, again.step, again.keepRunner, again.fixes], ["running", "review", false, 1]);
  assert.match(again.reason, /conteste/);
  const human = nextAfter({ step: "fix", fixes: 2, attempts: 0, lastFailCause: "missing_output" }, contest, limits);
  assert.deepEqual([human.state, human.step], ["awaiting_human", "fix"]);
  // Hors de la correction, `missing_output` est un échec ordinaire.
  assert.equal(nextAfter({ step: "specs", fixes: 0, attempts: 0 }, contest, limits).state, "queued");
});

test("harness-machine/AC-11 : la porte des specs en « auto » n'attend l'humain que si l'étape l'a jugé utile", () => {
  const auto: Limits = { ...limits, specsGate: "auto" };
  const cursor = { step: "specs" as const, fixes: 0, attempts: 0 };
  const gated = nextAfter(cursor, { ...done, gateNeeded: true }, auto);
  assert.deepEqual([gated.state, gated.step], ["awaiting_human", "specs"]);
  assert.match(gated.reason, /découpage, modules ou geste irréversible/);
  assert.deepEqual(
    [nextAfter(cursor, { ...done, gateNeeded: false }, auto).step, nextAfter(cursor, done, auto).step],
    ["impl", "impl"],
  );
  // `true` et `false` ignorent le jugement de l'étape.
  assert.equal(nextAfter(cursor, { ...done, gateNeeded: false }, { ...limits, specsGate: true }).state, "awaiting_human");
  assert.equal(nextAfter(cursor, { ...done, gateNeeded: true }, { ...limits, specsGate: false }).step, "impl");
});

test("harness-machine/AC-12 : la relance par l'humain remet le run en file à la même étape, compteur de relances à zéro, sans attente", () => {
  const back = retried({ step: "impl", fixes: 1, attempts: 2, lastFailCause: "timeout" });
  assert.deepEqual(
    [back.state, back.step, back.fixes, back.attempts, back.notBefore, back.keepRunner],
    ["queued", "impl", 1, 0, null, false],
  );
  for (const from of ["failed", "awaiting_human"] as const) assert.ok(canTransition(from, back.state));
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
  // Le merge arrêté retourne en correction après un délai, compté dans `mergeRetries` — jamais dans `fixes`.
  const stopped = afterMergeStopped({ fixes: 1, mergeRetries: 0 }, "fix", "suite rouge", { mergeRetries: 2 }, 10_000);
  assert.deepEqual(
    [stopped.state, stopped.step, stopped.fixes, stopped.notBefore],
    ["queued", "fix", 1, 10_000 + (MERGE_BACKOFF_MS[0] ?? 0)],
  );
  const later = afterMergeStopped({ fixes: 1, mergeRetries: 1 }, "review", "conflit", { mergeRetries: 2 }, 0);
  assert.equal(later.notBefore, MERGE_BACKOFF_MS[1]);
  const capped = afterMergeStopped({ fixes: 2, mergeRetries: 2 }, "review", "conflit", { mergeRetries: 2 }, 0);
  assert.deepEqual([capped.state, capped.step], ["awaiting_human", null]);
  assert.match(capped.reason, /plafond de tentatives de merge/);
  assert.deepEqual([afterMerged({ fixes: 1 }).state, afterMerged({ fixes: 1 }).step], ["merged", null]);
  assert.match(afterMergeFailed({ fixes: 0 }, "push refusé").reason, /merge impossible : push refusé/);
  assert.equal(cancelled({ step: "impl", fixes: 0, attempts: 0 }).state, "cancelled");
  const back = recovered({ step: "impl", fixes: 1, attempts: 1 });
  assert.deepEqual([back.state, back.step, back.fixes, back.attempts], ["queued", "impl", 1, 1]);
  // Chaque issue de la machine est une transition que la table permet.
  for (const transition of [stopped, capped]) assert.ok(canTransition("merging", transition.state));
  assert.ok(canTransition("running", recovered({ step: "req", fixes: 0, attempts: 0 }).state));
});
