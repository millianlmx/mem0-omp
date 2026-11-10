// Tranche « clarté » de l'OS agentique (audit UI/UX n° 3, constats G3, G6, G7, G12) : le serveur rend des
// CODES et des FAITS, pour que les apps écrivent elles-mêmes leur phrase — pourquoi un fil attend l'humain
// (`humanWait`), pourquoi il a échoué (`failure`), ce qui le retient en file (`waitFacts`), le brief
// (`counts`, `costToday`), une confiance qui compte les arrêts (`stopped`, `sample`), les faits d'une
// proposition (`facts`) et un titre de Demande court. Le texte des raisons (`run.reason`) ne change pas.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { briefOf } from "../../omp-harness/brief.ts";
import type { HarnessConfig, RepoConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import type { NewRun, RunPatch } from "../../omp-harness/db.ts";
import { API_FEATURES, createHandler } from "../../omp-harness/http.ts";
import { interpretClassification } from "../../omp-harness/intake.ts";
import {
  afterMergeFailed,
  afterMergeStopped,
  cancelled,
  crashed,
  humanWaitOf,
  nextAfter,
  pausedForBudget,
  specsBackToHuman,
  splitAbandoned,
} from "../../omp-harness/machine.ts";
import type { Limits, Transition } from "../../omp-harness/machine.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { INTAKE_TITLE_MAX, intakePrompt } from "../../omp-harness/prompts.ts";
import { shortTitle } from "../../omp-harness/proposals.ts";
import type { Proposal } from "../../omp-harness/proposals.ts";
import { scoreboardOf } from "../../omp-harness/scoreboard.ts";
import { REVIEW_EVIDENCE, gateReasons } from "../../omp-harness/steps.ts";
import { mergeDecision, mergeFacts } from "../../omp-harness/verdict.ts";
import type { MergeEvidence, Verdict } from "../../omp-harness/verdict.ts";
import { OK, fakeWorld, git, testConfig, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const TOKEN = "t".repeat(64);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HUMAN = { by: "mac" };
const SHA = "c0ffee1234567890c0ffee1234567890c0ffee12";

type Fact = { code: string } & Record<string, unknown>;
type Wait = { kind: string; reasons: Fact[] };
/** Un run tel que l'API le rend, pour ce que ces tests en lisent. */
type Shown = {
  id: string;
  state: string;
  step: string | null;
  reason: string | null;
  waitCause?: string;
  waitUntil?: number;
  waitFacts?: Record<string, unknown>;
  humanWait?: Wait;
  failure?: { step: string | null; cause: string | null };
};
type Api = {
  get: (route: string) => Promise<Record<string, unknown>>;
  run: (id: string) => Promise<Shown>;
  close: () => Promise<void>;
};

async function serve(world: FakeWorld): Promise<Api> {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const port = (server.address() as AddressInfo).port;
  const get = async (route: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200, `${route} : ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };
  return {
    get,
    run: async (id) => (await get(`/v1/runs/${id}`)).run as Shown,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

/** Un monde où rien ne tourne : les runs sont posés en base, l'API les rend. */
async function idle(patch: (config: HarnessConfig) => void = () => {}): Promise<{ world: FakeWorld; api: Api }> {
  const world = fakeWorld({}, { patch });
  return { world, api: await serve(world) };
}

async function closing(world: FakeWorld, api: Api, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
}

const AUTO: Limits = { fixCap: 3, retryBackoffSec: [0], specsGate: "auto", mergeRetries: 3 };
const SPECS = String(OK.specs[0]?.content);
const RISKY_SPECS = SPECS.replace(
  "S-1 (AC-1) : export CSV",
  "S-1 (AC-1) : export CSV, puis supprimer les données exportées",
);
const SPLIT_SPECS = SPECS.replace("## Modules\n- src/api\n", "## Modules\n").replace(
  "## Découpage\naucun\n",
  "## Découpage\n- Export JSON — Exporter aussi en JSON — src/api, docs\n",
);

/** Un run posé en base dans l'état où la machine l'a mené : la raison est celle que la transition écrit. */
function park(
  store: Store,
  id: string,
  transition: Transition,
  patch: RunPatch = {},
  extra: Partial<NewRun> = {},
): void {
  store.createRun({ id, repo: "demo", slug: id, title: id, request: "x", branch: `harness/${id}`, ...extra });
  store.updateRun(id, {
    state: transition.state,
    step: transition.step,
    fixes: transition.fixes,
    attempts: transition.attempts,
    reason: transition.reason,
    ...patch,
  });
}

/** La transition de fin de /specs pour ces specs, telle que steps.ts la demande (`gateReasons`). */
function specsDone(
  specs: string,
  limits: Limits,
  run: { projectId: string | null; projectOrder: number } = { projectId: null, projectOrder: 1 },
  more: string[] = [],
): Transition {
  const reasons = [...gateReasons(run, specs), ...more];
  return nextAfter(
    { step: "specs", fixes: 0, attempts: 0 },
    { kind: "done", escalations: 0, gateNeeded: reasons.length > 0, gateReasons: reasons },
    limits,
  );
}

function spend(store: Store, cost: number, runId: string | null = null, repo = "demo"): void {
  store.addUsage({
    runId,
    auditId: null,
    repo,
    step: "impl",
    provider: "p",
    model: "m",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost,
  });
}

/** Attend, dans les dernières secondes du jour UTC, que minuit soit passé : la dépense et sa lecture tombent le même jour. */
async function clearOfMidnight(marginMs = 60_000): Promise<void> {
  const left = DAY - (Date.now() % DAY);
  if (left >= marginMs) return;
  // Une vraie attente : l'admission lit l'horloge du serveur (`Date.now()`), qu'un test ne règle pas.
  const passed = Promise.withResolvers<void>();
  setTimeout(passed.resolve, left + 50);
  await passed.promise;
}

const GOOD_VERDICT: Verdict = {
  risk: "low",
  summary: "export CSV simple",
  blockers: [],
  risks: [],
  files: ["src/api/export.ts"],
  unverified: [],
  criteria: [{ id: "AC-1", test: "harness/AC-1", status: "pass" }],
  confidence: "strong",
};
const GOOD_EVIDENCE: MergeEvidence = {
  fullTests: "pass",
  diffLines: 40,
  maxDiffLines: 300,
  openEscalations: 0,
  acIds: ["AC-1"],
  specsDrift: [],
  autoMergeRisk: "low",
  touchedFiles: ["src/api/export.ts"],
};

/** Un run posé en base à la fin de sa revue : verdict, évidence gardée, et l'attente que la machine en tire. */
function reviewed(
  store: Store,
  id: string,
  verdict: Verdict,
  evidence: MergeEvidence,
  limits: Limits = AUTO,
  extra: Partial<NewRun> = {},
): void {
  const merge = mergeDecision(verdict, evidence);
  park(
    store,
    id,
    nextAfter({ step: "review", fixes: 0, attempts: 0 }, { kind: "done", escalations: 0, blockers: 0, merge }, limits),
    { verdict, lastReviewSha: "abc" },
    extra,
  );
  store.putArtifact(
    id,
    REVIEW_EVIDENCE,
    JSON.stringify({ merge, evidence: { ...evidence, reproTests: [], reviewSha: "abc" } }),
    null,
  );
}

test("os-clarte/AC-1 : une revue dont le diff dépasse le plafond attend l'humain avec `humanWait {kind: verdict, reasons: [diff_over_limit …]}` — dans la vue du run, la liste et la boîte —, sa raison reste le texte d'avant, et le champ disparaît une fois le run fusionné", async () => {
  const lines = Array.from({ length: 8 }, (_, index) => `export const colonne${index} = ${index};`).join("\n");
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [[{ write: "src/api/export.ts", content: `${lines}\n` }, ...OK.impl.slice(1)]],
      review: [OK.review],
    },
    {
      patch: (config) => {
        config.review.maxDiffLines = 3;
      },
    },
  );
  await world.orchestrator.start();
  const api = await serve(world);
  await closing(world, api, async () => {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter" });
    const stateOf = () => String(world.store.getRun(run.id)?.state);
    await waitFor(() => ["awaiting_human", "merged", "failed"].includes(stateOf()), stateOf);
    const saved = JSON.parse(world.store.getArtifact(run.id, REVIEW_EVIDENCE) ?? "{}") as {
      evidence: { diffLines: number };
    };
    const diffLines = saved.evidence.diffLines;
    assert.ok(diffLines > 3, `le diff compté (${diffLines}) dépasse le plafond`);
    const expected: Wait = { kind: "verdict", reasons: [{ code: "diff_over_limit", diffLines, maxDiffLines: 3 }] };

    const shown = await api.run(run.id);
    assert.deepEqual([shown.state, shown.humanWait], ["awaiting_human", expected]);
    assert.equal(shown.reason, `validation humaine : diff de ${diffLines} lignes (> 3)`, "le texte n'a pas changé");
    assert.deepEqual([shown.failure, shown.waitCause, shown.waitFacts], [undefined, undefined, undefined]);
    const listed = ((await api.get("/v1/runs")).runs as Shown[]).find((item) => item.id === run.id);
    assert.deepEqual(listed?.humanWait, expected, "GET /v1/runs");
    const inbox = await api.get("/v1/inbox");
    assert.deepEqual(
      (inbox.awaiting as Shown[]).map((item) => item.humanWait),
      [expected],
      "awaiting de la boîte",
    );
    assert.deepEqual(
      (inbox.runs as Shown[]).find((item) => item.id === run.id)?.humanWait,
      expected,
      "runs de la boîte",
    );

    await world.orchestrator.validate(run.id, true, "", HUMAN);
    await waitFor(() => ["merged", "failed"].includes(stateOf()), stateOf);
    const merged = await api.run(run.id);
    assert.deepEqual([merged.state, merged.humanWait, merged.failure], ["merged", undefined, undefined]);
  });
});

test("os-clarte/AC-2 : des specs à valider disent leurs raisons de porte en codes — première tâche d'un projet, découpage proposé, modules vides, désaccord, validation renversée, porte systématique — et un geste irréversible rend `irreversible` avec sa catégorie, même quand la raison du run est nue", async () => {
  const { world, api } = await idle();
  const { store } = world;
  await closing(world, api, async () => {
    const specs = (id: string, text: string, transition: Transition, extra: Partial<NewRun> = {}) => {
      park(store, id, transition, {}, extra);
      store.putArtifact(id, "specs.md", text, null);
    };
    const always: Limits = { ...AUTO, specsGate: true };
    store.createProject({ id: "p1", repo: "demo", title: "Refonte des exports" });
    const first = { projectId: "p1", projectOrder: 0 };
    specs("premier", SPECS, specsDone(SPECS, AUTO, first), first);
    specs("decoupe", SPLIT_SPECS, specsDone(SPLIT_SPECS, AUTO));
    specs("risque", RISKY_SPECS, specsDone(RISKY_SPECS, AUTO));
    specs("nu", RISKY_SPECS, specsDone(RISKY_SPECS, always));
    specs("porte", SPECS, specsDone(SPECS, always));
    specs("conteste", SPECS, specsDone(SPECS, AUTO, undefined, ["désaccord avec le contradicteur (/specs C-2)"]));
    store.putArtifact(
      "conteste",
      "_contradicteur.json",
      JSON.stringify({
        specs: { step: "specs", model: null, authorModel: null, findings: [], answers: {}, disputes: ["C-2"] },
      }),
      null,
    );
    specs("renverse", SPECS, specsBackToHuman({ step: "specs", fixes: 0, attempts: 0 }, 4));

    const waitOf = async (id: string) => (await api.run(id)).humanWait;
    assert.deepEqual(await waitOf("premier"), { kind: "specs", reasons: [{ code: "first_of_project" }] });
    assert.equal(
      (await api.run("premier")).reason,
      "specs à valider avant /impl : première feature d'un projet",
      "le texte n'a pas changé",
    );
    assert.deepEqual(await waitOf("decoupe"), {
      kind: "specs",
      reasons: [{ code: "split_proposed" }, { code: "empty_modules" }],
    });
    const irreversible: Wait = { kind: "irreversible", reasons: [{ code: "irreversible", category: "deletion" }] };
    assert.deepEqual(await waitOf("risque"), irreversible);
    // Sous `review.specsGate: true` la raison ne dit rien du geste : les specs sont relues.
    const bare = store.getRun("nu");
    assert.deepEqual([bare?.reason, bare ? humanWaitOf(bare) : null], ["specs à valider avant /impl", "specs"]);
    assert.deepEqual(await waitOf("nu"), irreversible);
    assert.deepEqual(await waitOf("porte"), { kind: "specs", reasons: [{ code: "specs_gate" }] });
    assert.deepEqual(await waitOf("conteste"), {
      kind: "specs",
      reasons: [{ code: "dispute", ids: ["/specs C-2"] }],
    });
    assert.deepEqual(await waitOf("renverse"), { kind: "specs", reasons: [{ code: "autonomy_reversed" }] });
  });
});

test("os-clarte/AC-3 : chaque motif du refus d'auto-merge a son code et ses chiffres, dans l'ordre des raisons en texte, qui ne changent pas ; l'API les relit de l'évidence gardée par la revue, et un verdict sans évidence rend `other`, jamais son texte", async () => {
  const verdict: Verdict = {
    ...GOOD_VERDICT,
    risk: "high",
    files: ["src/a.ts"],
    unverified: ["AC-3 : pas de test de charge"],
    criteria: [
      { id: "AC-1", test: "t", status: "pass" },
      { id: "AC-2", test: "", status: "untested" },
    ],
    confidence: "weak",
  };
  const evidence: MergeEvidence = {
    fullTests: "fail",
    diffLines: 412,
    maxDiffLines: 300,
    openEscalations: 1,
    acIds: ["AC-1", "AC-2", "AC-3"],
    specsDrift: [
      { id: "AC-1", validated: "avant", current: "après" },
      { id: "AC-9", validated: null, current: "ajouté" },
    ],
    autoMergeRisk: "low",
    touchedFiles: ["src/a.ts", "src/b.ts"],
  };
  const facts: Fact[] = [
    { code: "risk", risk: "high", max: "low" },
    { code: "tests_not_green", tests: "fail" },
    { code: "diff_over_limit", diffLines: 412, maxDiffLines: 300 },
    { code: "open_questions", count: 1 },
    { code: "criteria_missing", ids: ["AC-3"] },
    { code: "criteria_unproven", ids: ["AC-2"] },
    { code: "specs_drift", ids: ["AC-1"] },
    { code: "files_unread", count: 1, files: ["src/b.ts"] },
    { code: "criteria_unverified", ids: ["AC-3"] },
    { code: "weak_verdict" },
  ];
  assert.deepEqual(mergeFacts(verdict, evidence), facts);
  assert.deepEqual(mergeDecision(verdict, evidence), {
    auto: false,
    reasons: [
      "risque high",
      "suite complète rouge",
      "diff de 412 lignes (> 300)",
      "1 escalade(s) ouverte(s)",
      "critère(s) absent(s) du verdict : AC-3",
      "critère(s) non prouvé(s) : AC-2 untested",
      "critère(s) validé(s) modifié(s) depuis /specs : AC-1 réécrit",
      "fichier(s) touchés non relus : src/b.ts",
      "critère(s) non vérifié(s) : AC-3 : pas de test de charge",
      "verdict faible",
    ],
    readCode: true,
  });
  const blocked = { ...GOOD_VERDICT, blockers: ["fuite mémoire", "test manquant"] };
  assert.deepEqual(mergeFacts(blocked, { ...GOOD_EVIDENCE, fullTests: "not_run" }), [
    { code: "blockers", count: 2 },
    { code: "tests_not_green", tests: "not_run" },
  ]);
  assert.deepEqual(mergeFacts(GOOD_VERDICT, GOOD_EVIDENCE), []);
  assert.deepEqual(mergeDecision(GOOD_VERDICT, GOOD_EVIDENCE), { auto: true });

  const { world, api } = await idle();
  const { store } = world;
  await closing(world, api, async () => {
    reviewed(store, "revue", verdict, evidence);
    const shown = await api.run("revue");
    assert.deepEqual(shown.humanWait, { kind: "verdict", reasons: facts });
    assert.match(shown.reason ?? "", /^validation humaine : risque high ; suite complète rouge ; diff de 412 lignes/);
    // Un verdict d'avant l'évidence gardée : la sorte d'attente reste dite, le motif n'est pas inventé.
    park(
      store,
      "ancien",
      nextAfter({ step: "review", fixes: 0, attempts: 0 }, { kind: "done", escalations: 0, blockers: 0 }, AUTO),
      { verdict: GOOD_VERDICT },
    );
    const old = await api.run("ancien");
    assert.deepEqual(
      [old.reason, old.humanWait],
      ["validation humaine requise", { kind: "verdict", reasons: [{ code: "other" }] }],
    );
    // Une évidence illisible ne casse pas la lecture.
    store.putArtifact("ancien", REVIEW_EVIDENCE, "{pas du JSON", null);
    assert.deepEqual((await api.run("ancien")).humanWait, { kind: "verdict", reasons: [{ code: "other" }] });
  });
});

test("os-clarte/AC-4 : en « tout me demander », les specs comme le verdict que l'auto-merge acceptait disent `ask_level` ; un arbitrage dit le plafond de corrections (`fix_cap {fixes, cap}` et ses bloquants) ou la contestation ; un budget dépassé dit la dépense et le seuil", async () => {
  const { world, api } = await idle();
  const { store } = world;
  await closing(world, api, async () => {
    const ask: Limits = { ...AUTO, ask: true };
    park(store, "specs-ask", specsDone(SPECS, ask), {}, { autonomy: "ask" });
    store.putArtifact("specs-ask", "specs.md", SPECS, null);
    reviewed(store, "verdict-ask", GOOD_VERDICT, GOOD_EVIDENCE, ask, { autonomy: "ask" });
    assert.deepEqual((await api.run("specs-ask")).humanWait, { kind: "specs", reasons: [{ code: "ask_level" }] });
    const asked = await api.run("verdict-ask");
    assert.equal(asked.reason, "validation humaine : autonomie « tout me demander »");
    assert.deepEqual(asked.humanWait, { kind: "verdict", reasons: [{ code: "ask_level" }] });

    const cap = world.config.review.fixCap;
    const limits: Limits = { ...AUTO, fixCap: cap };
    park(
      store,
      "plafond",
      nextAfter({ step: "review", fixes: cap, attempts: 0 }, { kind: "done", escalations: 0, blockers: 2 }, limits),
      { verdict: { ...GOOD_VERDICT, blockers: ["fuite mémoire", "test manquant"] } },
    );
    const capped = await api.run("plafond");
    assert.equal(capped.reason, `plafond de corrections atteint (${cap}) avec 2 bloquant(s)`);
    assert.deepEqual(capped.humanWait, {
      kind: "arbitration",
      reasons: [
        { code: "fix_cap", fixes: cap, cap },
        { code: "blockers", count: 2 },
      ],
    });
    park(
      store,
      "conteste",
      nextAfter(
        { step: "fix", fixes: 1, attempts: 0, lastFailCause: "missing_output" },
        { kind: "failed", reason: "aucun changement", retryable: true, cause: "missing_output" },
        limits,
      ),
      { lastFailCause: "missing_output" },
    );
    assert.deepEqual((await api.run("conteste")).humanWait, { kind: "arbitration", reasons: [{ code: "contest" }] });

    park(store, "budget", pausedForBudget({ step: "impl", fixes: 0, attempts: 0 }, 1.5, 1));
    store.setSetting("run-budget:budget", 1, "mac");
    spend(store, 1.5, "budget");
    const paused = await api.run("budget");
    assert.match(paused.reason ?? "", /^budget dépassé : 1\.50 \$ pour un plafond de 1\.00 \$/);
    assert.deepEqual(paused.humanWait, { kind: "budget", reasons: [{ code: "budget", spent: 1.5, budget: 1 }] });
  });
});

test("os-clarte/AC-5 : une panne rendue à l'humain dit son étape et sa cause (`step_failed {step, cause, attempts, oom}`), un merge arrêté ses tentatives et l'étape de reprise, un merge impossible son code ; un motif que le serveur ne sait pas structurer rend `other`", async () => {
  const { world, api } = await idle();
  const { store } = world;
  await closing(world, api, async () => {
    const failing = (id: string, cause: "provider" | "runner", reason: string) =>
      park(
        store,
        id,
        nextAfter(
          { step: "impl", fixes: 0, attempts: 1, lastFailCause: cause },
          { kind: "failed", reason, retryable: true, cause },
          AUTO,
        ),
        { lastFailCause: cause },
      );
    failing("epuise", "provider", "le fournisseur de modèles a coupé la session");
    failing("oom", "runner", "runner arrêté : code 137");
    park(
      store,
      "merge-arrete",
      afterMergeStopped({ fixes: 0, mergeRetries: 3 }, "fix", "suite complète rouge après rebase", AUTO, Date.now()),
      { mergeRetries: 4 },
    );
    park(store, "merge-impossible", afterMergeFailed({ fixes: 0 }, "push refusé par le distant"));
    park(store, "inconnu", {
      ...crashed({ step: "impl", fixes: 0, attempts: 0 }, "interrompu : service arrêté"),
      state: "awaiting_human",
    });

    const exhausted = await api.run("epuise");
    assert.equal(
      exhausted.reason,
      "/impl a échoué 2 fois (provider), relances épuisées : le fournisseur de modèles a coupé la session",
      "le texte n'a pas changé",
    );
    assert.deepEqual(exhausted.humanWait, {
      kind: "failure",
      reasons: [{ code: "step_failed", step: "impl", cause: "provider", attempts: 2, oom: false }],
    });
    assert.deepEqual((await api.run("oom")).humanWait, {
      kind: "failure",
      reasons: [{ code: "step_failed", step: "impl", cause: "runner", attempts: 2, oom: true }],
    });
    assert.deepEqual((await api.run("merge-arrete")).humanWait, {
      kind: "failure",
      reasons: [{ code: "merge_stopped", attempts: 4, resume: "fix" }],
    });
    assert.deepEqual((await api.run("merge-impossible")).humanWait, {
      kind: "failure",
      reasons: [{ code: "merge_failed" }],
    });
    const unknown = await api.run("inconnu");
    assert.deepEqual(unknown.humanWait, { kind: "failure", reasons: [{ code: "other" }] });
    assert.ok(!JSON.stringify(unknown.humanWait).includes("service arrêté"), "jamais le texte dans les faits");
  });
});

test("os-clarte/AC-6 : un run qui pose des questions rend `humanWait {kind: questions, reasons: [open_questions {count}]}`, aussi dans les lots d'escalades ; un run échoué rend `failure {step, cause}` — la cause de son étape, `null` pour une panne du service — et aucun des deux champs hors de ces états", async () => {
  const { world, api } = await idle();
  const { store } = world;
  await closing(world, api, async () => {
    store.createRun({
      id: "questions",
      repo: "demo",
      slug: "q",
      title: "Sauvegarde",
      request: "x",
      branch: "harness/q",
    });
    const step = store.startStep("questions", "specs", 1, null, null);
    for (const question of ["Quel format ?", "Quelle rétention ?"])
      store.addEscalation({
        runId: "questions",
        stepId: step.id,
        category: "schema",
        question,
        options: ["a", "b"],
        context: "",
      });
    store.updateRun("questions", {
      state: "escalated",
      step: "specs",
      reason: "2 décision(s) irréversible(s) à trancher",
    });
    const expected: Wait = { kind: "questions", reasons: [{ code: "open_questions", count: 2 }] };
    assert.deepEqual((await api.run("questions")).humanWait, expected);
    const batches = (await api.get("/v1/escalations")).batches as { run: Shown }[];
    assert.deepEqual(
      batches.map((batch) => [batch.run.id, batch.run.humanWait]),
      [["questions", expected]],
    );
    const inbox = (await api.get("/v1/inbox")).batches as { run: Shown }[];
    assert.deepEqual(inbox[0]?.run.humanWait, expected);

    park(
      store,
      "echec",
      nextAfter(
        { step: "impl", fixes: 0, attempts: 0 },
        { kind: "failed", reason: "contexte dépassé", retryable: false, cause: "context" },
        AUTO,
      ),
      { lastFailCause: "context" },
    );
    // Une panne du service : la cause d'un échec d'étape antérieur ne lui est pas attribuée.
    park(store, "panne", crashed({ step: "review", fixes: 0, attempts: 0 }, "worktree perdu"), {
      lastFailCause: "provider",
    });
    store.createRun({ id: "file", repo: "demo", slug: "f", title: "En file", request: "x", branch: "harness/f" });
    const failed = await api.run("echec");
    assert.equal(failed.reason, "/impl a échoué : contexte dépassé");
    assert.deepEqual([failed.failure, failed.humanWait], [{ step: "impl", cause: "context" }, undefined]);
    assert.deepEqual((await api.run("panne")).failure, { step: "review", cause: null });
    const listed = (await api.get("/v1/runs?state=failed")).runs as Shown[];
    assert.deepEqual(listed.map((run) => [run.id, run.failure]).sort(), [
      ["echec", { step: "impl", cause: "context" }],
      ["panne", { step: "review", cause: null }],
    ]);
    const queued = await api.run("file");
    assert.deepEqual([queued.failure, queued.humanWait, queued.waitFacts], [undefined, undefined, undefined]);
  });
});

test("os-clarte/AC-7 : un run retenu en file porte les chiffres de sa cause dans `waitFacts` — slots tenus, plafond du dépôt, relance différée (étape et cause) —, son texte et son `waitCause` inchangés", async () => {
  const world = fakeWorld(
    { req: [[{ sleep: 60_000 }]] },
    {
      patch: (config) => {
        config.runner.slots = 1;
      },
    },
  );
  await world.orchestrator.start();
  const api = await serve(world);
  await closing(world, api, async () => {
    const { store, orchestrator } = world;
    const first = orchestrator.createRun({ repo: "demo", title: "Premier", request: "x", modules: ["src/api"] });
    await waitFor(
      () => store.getRun(first.id)?.state === "running",
      () => String(store.getRun(first.id)?.state),
    );
    const second = orchestrator.createRun({ repo: "demo", title: "Second", request: "x", modules: ["src/db"] });
    const until = Date.now() + HOUR;
    store.createRun({
      id: "differe",
      repo: "demo",
      slug: "differe",
      title: "Relance différée",
      request: "x",
      branch: "harness/differe",
      step: "impl",
      reason: "relance de /impl dans 3600 s (provider) : session coupée",
    });
    store.updateRun("differe", { notBefore: until, lastFailCause: "provider", attempts: 1 });
    const causeOf = (id: string) => {
      const row = store.getRun(id);
      return row ? orchestrator.withWait(row).waitCause : undefined;
    };
    await waitFor(
      () => causeOf(second.id) === "slots" && causeOf("differe") === "backoff",
      () => `${causeOf(second.id)}, ${causeOf("differe")}`,
    );
    const slots = await api.run(second.id);
    assert.deepEqual(
      [slots.waitCause, slots.reason, slots.waitFacts],
      ["slots", "slots runner pleins 1/1", { used: 1, slots: 1 }],
    );
    const delayed = await api.run("differe");
    assert.deepEqual(
      [delayed.waitCause, delayed.waitUntil, delayed.waitFacts],
      ["backoff", until, { step: "impl", cause: "provider" }],
    );
    const listed = ((await api.get("/v1/runs")).runs as Shown[]).find((run) => run.id === second.id);
    assert.deepEqual(listed?.waitFacts, { used: 1, slots: 1 }, "GET /v1/runs");

    (world.config.repos[0] as RepoConfig).maxParallel = 1;
    await waitFor(
      () => causeOf(second.id) === "repo_cap",
      () => String(causeOf(second.id)),
    );
    const capped = await api.run(second.id);
    assert.deepEqual(
      [capped.reason, capped.waitFacts],
      ["plafond du dépôt demo atteint : 1 run(s) en cours, maxParallel 1", { running: 1, maxParallel: 1 }],
    );
    // Un run qui tourne n'a rien à dire de la file.
    assert.equal((await api.run(first.id)).waitFacts, undefined);
  });
});

test("os-clarte/AC-8 : la mémoire, le plafond journalier du serveur et le budget d'un espace disent leurs chiffres — Mio disponibles et requis, dépense et plafond du jour, nom de l'espace (sans montant)", async () => {
  await clearOfMidnight();
  const world = fakeWorld({}, { memAvailableMiB: () => 2908 });
  await world.orchestrator.start();
  const api = await serve(world);
  await closing(world, api, async () => {
    const { store, orchestrator } = world;
    const run = orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter" });
    const causeOf = () => {
      const row = store.getRun(run.id);
      return row ? orchestrator.withWait(row).waitCause : undefined;
    };
    const held = async (cause: string) => {
      await waitFor(
        () => causeOf() === cause,
        () => `retenu par ${causeOf()}, attendu ${cause}`,
      );
      return api.run(run.id);
    };
    const memory = await held("memory");
    assert.deepEqual(memory.waitFacts, { availableMiB: 2908, requiredMiB: 3072 });
    assert.match(memory.reason ?? "", /^mémoire insuffisante : 2908 Mio disponibles, 3072 requis/);

    world.config.monitoring.dailyBudgetUsd = 1;
    spend(store, 2);
    const daily = await held("daily_budget");
    const resetsAt = Date.now() - (Date.now() % DAY) + DAY;
    assert.deepEqual(daily.waitFacts, { spent: 2, ceiling: 1, resetsAt });

    orchestrator.spaces.create(
      { name: "Client", repos: ["demo"], jiraProjects: [], dailyBudgetUsd: 1, autonomy: null },
      HUMAN,
    );
    const space = await held("space_budget");
    assert.deepEqual(space.waitFacts, { space: "Client" });
    assert.ok(!JSON.stringify(space.waitFacts).includes("2"), "la dépense de l'espace n'est pas dite");
  });
});

test("os-clarte/AC-9 : le brief porte les mêmes codes que les runs (`humanWait`, `failure`, `waitCause` et ses faits, `cause` d'un arrêt) à côté de ses textes, ses comptes en clair (`counts`), et le coût du jour UTC (`costToday`) à côté du coût de la fenêtre", async () => {
  // Les comptes, la file et les deux coûts : sur une base à l'horloge réglée.
  const midnight = 20_000 * DAY;
  const clock = { now: midnight - 2 * HOUR };
  const store = new Store(path.join(tmpdir("os-clarte-"), "h.sqlite"), () => clock.now);
  try {
    const put = (id: string, patch: RunPatch) => {
      store.createRun({ id, repo: "demo", slug: id, title: `feat(api): ${id}`, request: "x", branch: `harness/${id}` });
      store.updateRun(id, patch);
    };
    spend(store, 3);
    clock.now = midnight + HOUR;
    spend(store, 2);
    put("livre", { state: "merged" });
    put("travail", { state: "running", step: "impl" });
    put("fusion", { state: "merging" });
    put("specs", { state: "awaiting_human", step: "specs", reason: "specs à valider avant /impl" });
    put("rate", {
      state: "failed",
      step: "impl",
      reason: "/impl a échoué : contexte dépassé",
      lastFailCause: "context",
    });
    put("stop", { state: "cancelled", cancelCause: "too_big", reason: "annulé par l'humain : trop gros" });
    put("file", {});
    put("libre", {});
    const input = {
      seenAt: null,
      repos: null,
      heldBy: (run: { id: string }) =>
        run.id === "file"
          ? {
              cause: "repo_cap",
              text: "plafond du dépôt demo atteint : 1 run(s) en cours, maxParallel 1",
              facts: { running: 1, maxParallel: 1 },
            }
          : null,
      humanWait: () => null,
      proposals: 0,
    };
    const brief = briefOf(store, { ...input, since: midnight - 24 * HOUR, until: midnight + 6 * HOUR });
    assert.deepEqual(brief.counts, {
      yours: 1,
      working: 2,
      waiting: 1,
      delivered: 1,
      failed: 1,
      stopped: 1,
      decided: 0,
    });
    assert.deepEqual([brief.cost, brief.costToday], [5, 2], "la fenêtre de 30 heures, et le seul jour UTC");
    assert.deepEqual(brief.blocked, [
      {
        runId: "file",
        repo: "demo",
        title: "file",
        cause: "repo_cap",
        text: "plafond du dépôt demo atteint : 1 run(s) en cours, maxParallel 1",
        waitCause: "repo_cap",
        waitFacts: { running: 1, maxParallel: 1 },
      },
    ]);
    assert.deepEqual(brief.failed, [
      {
        runId: "rate",
        repo: "demo",
        title: "rate",
        reason: "/impl a échoué : contexte dépassé",
        at: midnight + HOUR,
        failure: { step: "impl", cause: "context" },
      },
    ]);
    assert.deepEqual(
      brief.stopped.map((item) => [item.runId, item.cause]),
      [["stop", "too_big"]],
    );
    // Sans lecteur des faits, la sorte d'attente reste dite et le motif vaut `other`.
    assert.deepEqual(
      brief.waiting.map((item) => [item.runId, item.wait, item.humanWait]),
      [["specs", "specs", { kind: "specs", reasons: [{ code: "other" }] }]],
    );
    // Une fenêtre ouverte après minuit : le coût du jour compte aussi ce qui la précède.
    clock.now = midnight + 3 * HOUR;
    spend(store, 1);
    const late = briefOf(store, { ...input, since: midnight + 2 * HOUR, until: midnight + 6 * HOUR });
    assert.deepEqual([late.cost, late.costToday], [1, 3]);
  } finally {
    store.close();
  }

  // Les codes des attentes : par la route, sur le vrai lecteur des faits.
  await clearOfMidnight();
  const { world, api } = await idle();
  await closing(world, api, async () => {
    world.store.createProject({ id: "p1", repo: "demo", title: "Refonte" });
    const first = { projectId: "p1", projectOrder: 0 };
    park(world.store, "specs", specsDone(SPECS, AUTO, first), {}, first);
    world.store.putArtifact("specs", "specs.md", SPECS, null);
    reviewed(world.store, "revue", GOOD_VERDICT, { ...GOOD_EVIDENCE, diffLines: 412 });
    spend(world.store, 1.25, "revue");
    const brief = (await api.get("/v1/brief")).brief as {
      waiting: { runId: string; wait: string; humanWait: Wait }[];
      counts: Record<string, number>;
      cost: number;
      costToday: number;
    };
    assert.deepEqual(brief.waiting.map((item) => [item.runId, item.wait, item.humanWait]).sort(), [
      [
        "revue",
        "verdict",
        { kind: "verdict", reasons: [{ code: "diff_over_limit", diffLines: 412, maxDiffLines: 300 }] },
      ],
      ["specs", "specs", { kind: "specs", reasons: [{ code: "first_of_project" }] }],
    ]);
    assert.deepEqual([brief.counts.yours, brief.cost, brief.costToday], [2, 1.25, 1.25]);
  });
});

test("os-clarte/AC-10 : la réussite d'un dépôt compte les arrêts par l'humain — 3 fusions et 6 arrêts ne font plus 100 % —, pas les motifs `obsolete` et `duplicate` ni une tâche abandonnée avec son parent, et `sample` dit la taille de l'échantillon", () => {
  const now = 5000 * HOUR;
  const clock = { now: now - HOUR };
  const store = new Store(path.join(tmpdir("os-clarte-"), "h.sqlite"), () => clock.now);
  try {
    const cursor = { step: "impl" as const, fixes: 0, attempts: 0 };
    const end = (id: string, patch: RunPatch, repo = "demo") => {
      store.createRun({ id, repo, slug: id, title: id, request: "x", branch: `harness/${id}` });
      store.updateRun(id, patch);
    };
    const stop = (id: string, cause: RunPatch["cancelCause"], motive = "") =>
      end(id, { state: "cancelled", cancelCause: cause ?? null, reason: cancelled(cursor, motive).reason });
    for (const id of ["m1", "m2", "m3"]) end(id, { state: "merged" });
    for (const id of ["s1", "s2", "s3", "s4", "s5"]) stop(id, null);
    stop("gros", "too_big", "trop gros");
    stop("perime1", "obsolete", "plus d'actualité");
    stop("perime2", "obsolete", "plus d'actualité");
    stop("doublon", "duplicate", "doublon");
    end("orpheline", {
      state: "cancelled",
      reason: splitAbandoned(cursor, "annulée : « Socle », dont elle attendait le merge, a été annulé").reason,
    });
    end("rate", { state: "failed", reason: "/impl a échoué : contexte dépassé" });
    end("seul", { state: "merged" }, "other");

    const score = scoreboardOf(store, testConfig(tmpdir("os-clarte-repo-")), 7, now);
    assert.deepEqual(score.repos, [
      {
        repo: "demo",
        merged: 3,
        mergedAlone: 3,
        cancelled: 10,
        failed: 1,
        stopped: 6,
        sample: 10,
        successRate: 0.3,
        suggestion: null,
      },
      // Un seul cas : l'app lit `sample` et n'affiche pas de pourcentage.
      {
        repo: "other",
        merged: 1,
        mergedAlone: 1,
        cancelled: 0,
        failed: 0,
        stopped: 0,
        sample: 1,
        successRate: 1,
        suggestion: null,
      },
    ]);
    // Les motifs d'annulation restent comptés tels quels.
    assert.deepEqual([score.cancelled, score.cancelCauses], [10, { none: 6, too_big: 1, obsolete: 2, duplicate: 1 }]);
  } finally {
    store.close();
  }
});

const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString();
const out = (value: unknown): ProcResult => ({
  code: 0,
  signal: null,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
  timedOut: false,
  aborted: false,
});

/** Un GitHub doublé derrière `gh` (projet `moi/demo`) : une issue du label, une PR sans activité, une CI rouge. */
const hub: Exec = async (command, args, options) => {
  if (command !== "gh") return execProcess(command, args, options);
  const [noun, verb = ""] = args;
  if (noun === "repo" && verb === "view") return out({ visibility: "PRIVATE" });
  if (noun === "issue" && verb === "list")
    return out([
      {
        number: 7,
        title: "fix(export): Le tri des exports est instable",
        url: "https://github.com/moi/demo/issues/7",
        labels: [{ name: "omp:fix" }],
        author: { login: "alice" },
        createdAt: ago(2),
        body: "Deux exports de suite diffèrent.",
        state: "OPEN",
        comments: [],
      },
    ]);
  if (noun === "run" && verb === "list")
    return out([
      {
        databaseId: 900,
        workflowName: "check",
        displayTitle: "feat: export CSV",
        status: "completed",
        conclusion: "failure",
        headSha: SHA,
        updatedAt: ago(0.2),
        event: "push",
        url: "https://github.com/moi/demo/actions/runs/900",
      },
    ]);
  if (noun === "run" && verb === "view") return out("check\tTests\t✗ export/AC-3\n");
  // `gh api <ressource>` : la ressource suit le nom de la commande.
  if (noun === "api" && verb.startsWith("repos/moi/demo/pulls?state=open&"))
    return out([
      {
        number: 12,
        title: "feat(branding,widgets,share-extension,i18n): Pagination des exports",
        html_url: "https://github.com/moi/demo/pull/12",
        draft: false,
        updated_at: ago(5),
        user: { login: "bob" },
        author_association: "MEMBER",
        head: { ref: "feature/pagination", repo: { id: 1 } },
        base: { ref: "main", repo: { id: 1 } },
      },
    ]);
  if (noun === "api" && verb.includes("/check-runs")) return out({ check_runs: [] });
  if (noun === "api" && verb.includes("/status")) return out({ statuses: [] });
  if (noun === "api" && verb.includes("/rules/branches/")) return out("[]");
  return { ...out(""), code: 1, stderr: `commande gh inattendue : ${args.join(" ")}` };
};

test("os-clarte/AC-11 : chaque proposition porte les faits de sa source (`facts`) à côté de son détail — PR, CI, issue, audit, relance, palier — et un titre sans préfixe de commit ni nom de branche", async () => {
  const world = fakeWorld(
    {},
    {
      exec: hub,
      patch: (config) => {
        (config.repos[0] as RepoConfig).remote = "origin";
        config.autonomyLearning.minRuns = 1;
      },
    },
  );
  git(world.repo, "remote", "add", "origin", "git@github.com:moi/demo.git");
  const { store, orchestrator } = world;
  try {
    park(
      store,
      "rate",
      nextAfter(
        { step: "impl", fixes: 0, attempts: 0 },
        { kind: "failed", reason: "contexte dépassé", retryable: false, cause: "context" },
        AUTO,
      ),
      { lastFailCause: "context" },
      { title: "Issue #3 : fix(api): Export CSV" },
    );
    store.createAudit({ id: "a-1", repo: "demo", focus: "robustesse" });
    store.updateAuditIf("a-1", ["queued"], {
      state: "proposed",
      proposals: ["Borner la taille des exports", "Exporter en JSON"].map((title) => ({
        title,
        request: title,
        modules: ["src/api"],
        kind: "feature",
        rationale: "utile",
        evidence: [],
        dependsOn: [],
        impact: "medium",
        effort: "low",
      })),
    });
    store.createRun({
      id: "livre",
      repo: "demo",
      slug: "livre",
      title: "Livré",
      request: "x",
      branch: "harness/livre",
      kind: "bug",
    });
    store.updateRun("livre", { state: "merged" });
    store.appendEvent("validation", "livre", { gate: "verdict", approve: true, liftable: true, by: "mac" });

    await orchestrator.proposals.collect();
    const proposals = orchestrator.proposals.list({ repos: null, owner: true });
    const of = (source: string): Proposal => {
      const found = proposals.filter((proposal) => proposal.source === source);
      assert.equal(found.length, 1, `une proposition « ${source} » attendue, ${found.length} trouvée(s)`);
      return found[0] as Proposal;
    };
    assert.deepEqual(
      [of("pr").title, of("pr").facts, of("pr").detail],
      [
        "Pagination des exports",
        { number: 12, author: "bob", branch: "feature/pagination", idleDays: 5, draft: false },
        "Ouverte par bob, sans activité depuis 5 jours, branche feature/pagination",
      ],
    );
    assert.deepEqual([of("ci").title, of("ci").facts], ["CI en échec", { branch: "main", sha: SHA }]);
    assert.deepEqual([of("issue").title, of("issue").facts], ["Le tri des exports est instable", { number: 7 }]);
    assert.deepEqual(
      [of("retry").title, of("retry").facts, of("retry").detail],
      ["Export CSV", { runId: "rate", step: "impl", cause: "context" }, "/impl a échoué : contexte dépassé"],
    );
    assert.deepEqual(of("audit").facts, {
      count: 2,
      titles: ["Borner la taille des exports", "Exporter en JSON"],
    });
    assert.deepEqual(of("autonomy").facts, {
      kind: "bug",
      gate: "review",
      direction: "raise",
      corrected: 0,
      runs: 1,
      windowDays: 30,
    });
    for (const proposal of proposals) {
      assert.ok(!/^[a-z]+(\([^)]*\))?!?: /.test(proposal.title), `préfixe de commit : ${proposal.title}`);
      assert.ok(!proposal.title.includes("feature/pagination") && !proposal.title.includes("main"), proposal.title);
    }
  } finally {
    await orchestrator.stop();
  }
});

test("os-clarte/AC-12 : le classeur d'une Demande doit rendre un titre d'au plus 50 caractères sans préfixe technique — le prompt le dit, et le serveur coupe à la fin d'un mot un titre plus long", () => {
  const long = "feat(orders): Ajouter un filtre par statut à la liste des commandes du tableau de bord";
  const cut = "Ajouter un filtre par statut à la liste des…";
  assert.equal(INTAKE_TITLE_MAX, 50);
  assert.equal(shortTitle(long, INTAKE_TITLE_MAX), cut);
  // Court : rendu tel quel, le préfixe technique en moins ; à la borne exacte : entier.
  assert.equal(shortTitle("fix(api): Export CSV", INTAKE_TITLE_MAX), "Export CSV");
  const exact = "Exporter les commandes du mois en CSV par client !";
  assert.equal(exact.length, 50);
  assert.equal(shortTitle(exact, INTAKE_TITLE_MAX), exact);
  // La coupe ne laisse ni ponctuation pendante ni mot entamé ; un mot plus long que la borne est coupé net.
  assert.equal(
    shortTitle("Refonte de la page des commandes du client : filtres, tri et export", INTAKE_TITLE_MAX),
    "Refonte de la page des commandes du client…",
  );
  const word = shortTitle("x".repeat(80), INTAKE_TITLE_MAX);
  assert.deepEqual([word.length, word.endsWith("…")], [50, true]);
  for (const title of [long, `${exact} Et la suite`, "Un   titre\nsur deux lignes ".repeat(4)])
    assert.ok(shortTitle(title, INTAKE_TITLE_MAX).length <= INTAKE_TITLE_MAX, title);

  const classify = (title: string) =>
    interpretClassification(
      { kind: "feature", repo: "demo", title, statement: "Ajouter un filtre par statut." },
      { declared: ["demo"], scope: "*", requestedRepo: null },
    );
  const planned = classify(long);
  assert.deepEqual([planned.state, planned.plan?.title], ["planned", cut]);
  assert.equal(classify("Export CSV").plan?.title, "Export CSV");
  assert.equal(classify("   ").state, "failed", "un titre vide reste refusé");

  const prompt = intakePrompt({
    text: "x",
    source: "console",
    visibleRepos: ["demo"],
    requestedRepo: null,
    exchanges: [],
  });
  assert.match(prompt, /`title` est ce qu'une liste montre : 50 caractères au plus/);
  assert.match(prompt, /Sans préfixe technique/);
});

test("os-clarte/AC-13 : la capacité `run-facts` est annoncée et le README décrit chaque champ nouveau", () => {
  assert.ok((API_FEATURES as readonly string[]).includes("run-facts"));
  const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
  for (const field of [
    "`run-facts`",
    "`humanWait`",
    "`failure`",
    "`waitFacts`",
    "`counts`",
    "`costToday`",
    "`stopped`",
    "`sample`",
    "`facts`",
    "`diff_over_limit {diffLines, maxDiffLines}`",
    "`step_failed {step, cause, attempts, oom}`",
  ])
    assert.ok(readme.includes(field), `le README ne décrit pas ${field}`);
});
