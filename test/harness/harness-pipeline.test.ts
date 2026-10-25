// Feature harness-pipeline : le Pipeline Service conduit un run de bout en bout —
// req → specs → impl → review ⇄ fix → merge — avec de vrais process runners (faux omp
// RPC), du vrai git, la vraie base SQLite et les vrais jobs heavy (isolation `none`).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { OK, commitOnMain, fakeWorld, git, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";

function stateOf(world: FakeWorld, runId: string): string {
  const run = world.store.getRun(runId);
  return `${run?.state}/${run?.step} — ${run?.reason}`;
}

async function until(world: FakeWorld, runId: string, states: string[], timeoutMs = 30_000): Promise<void> {
  await waitFor(
    () => states.includes(world.store.getRun(runId)?.state ?? ""),
    () => stateOf(world, runId),
    timeoutMs,
  );
}

/** La revue qui passe d'OK, mais qui relit `files` (le verdict doit couvrir tous les fichiers touchés). */
function reviewOf(files: string[]): Record<string, unknown>[] {
  return OK.review.map((step) => (step.tool === "review_verdict" ? { ...step, args: { ...step.args, files } } : step));
}

test("harness-pipeline/AC-1 : un run bas risque aux tests verts va de /req au merge squash sur main, sans humain", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  await world.orchestrator.start();
  try {
    const mainBefore = git(world.repo, "rev-parse", "main");
    const run = world.orchestrator.createRun({
      repo: "demo",
      title: "Export CSV",
      request: "Exporter les données en CSV",
    });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    const done = world.store.getRun(run.id);
    assert.equal(done?.state, "merged", stateOf(world, run.id));
    // Le squash : un seul commit au-dessus de l'ancien main, qui porte le fichier et le run.
    assert.equal(git(world.repo, "rev-parse", "main^"), mainBefore);
    assert.match(git(world.repo, "log", "-1", "--format=%B", "main"), /Harness-Run: /);
    assert.equal(git(world.repo, "show", "main:src/api/export.ts"), "export const exportCsv = () => 'a,b';");
    // Les artefacts d'étape vivent dans la base, jamais dans main.
    assert.match(world.store.getArtifact(run.id, "specs.md") ?? "", /## Modules/);
    assert.throws(() => git(world.repo, "show", "main:.harness/specs.md"));
    assert.deepEqual(done?.modules, ["src/api"]);
    assert.deepEqual(
      world.store.listSteps(run.id).map((step) => `${step.kind}:${step.status}`),
      ["req:done", "specs:done", "impl:done", "review:done"],
    );
    // La suite complète a tourné une fois, en heavy (mise en route par le service à l'entrée en revue,
    // rejointe par le runner : un relevé chacun), et le résultat est en cache.
    assert.deepEqual(
      world.store.listTestRuns(run.id).map((t) => `${t.scope}:${t.outcome}`),
      ["touched:pass", "full:pass", "full:pass"],
    );
    // Knowledge-updater : le compte rendu de besoins et la feature mergée retournent à l'oracle.
    await waitFor(
      () => world.oracle.retained.length >= 2,
      () => JSON.stringify(world.oracle.retained),
    );
    assert.ok(world.oracle.retained.some((m) => /Compte rendu de besoins/.test(m.text) && m.scope === "demo-scope"));
    assert.ok(world.oracle.retained.some((m) => /Feature mergée « Export CSV »/.test(m.text)));
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-2 : chaque étape a son runner, sauf req → specs et review → fix qui gardent le même process ; la revue après correction repart d'un runner neuf", async () => {
  const blocked = [
    { tool: "run_tests", args: { scope: "full" } },
    {
      tool: "review_verdict",
      args: {
        risk: "low",
        summary: "il manque un test",
        blockers: ["AC-1 sans test"],
        risks: [],
        files: ["src/api/export.ts"],
        unverified: [],
        criteria: [{ id: "AC-1", test: "harness/AC-1", status: "fail" }],
        confidence: "strong",
      },
    },
  ];
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [OK.impl],
    review: [blocked, reviewOf(["src/api/export.ts", "src/api/export.test.ts"])],
    fix: [
      [
        { write: "src/api/export.test.ts", content: "// AC-1\n" },
        { tool: "run_tests", args: { scope: "touched" } },
      ],
    ],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export avec correction", request: "Exporter" });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.equal(world.store.getRun(run.id)?.fixes, 1);
    const prompts = world.log().filter((entry) => entry.kind === "prompt" && entry.nudge === false);
    const pidOf = (step: string) => prompts.filter((p) => p.step === step).map((p) => p.pid);
    const reviewPids = pidOf("review");
    assert.equal(reviewPids.length, 2);
    assert.notEqual(reviewPids[0], reviewPids[1], "la revue après correction juge dans un runner neuf");
    assert.equal(pidOf("fix")[0], reviewPids[0], "la correction tourne dans le runner de la revue");
    assert.equal(pidOf("specs")[0], pidOf("req")[0], "/specs continue dans le runner de /req");
    const distinct = new Set([pidOf("req")[0], pidOf("impl")[0], reviewPids[0], reviewPids[1]]);
    assert.equal(distinct.size, 4, "req+specs, impl, et chaque revue ont leur runner");
    // Le prompt de correction porte les bloquants de la revue.
    assert.match(String(prompts.find((p) => p.step === "fix")?.message), /AC-1 sans test/);
  } finally {
    await world.orchestrator.stop();
  }
});

/** Une revue sans bloquant mais à risque haut : au-dessus de `review.autoMergeRisk`, l'humain valide. */
const HUMAN_REVIEW = [
  { tool: "run_tests", args: { scope: "full" } },
  {
    tool: "review_verdict",
    args: {
      risk: "high",
      summary: "à relire",
      blockers: [],
      risks: ["format"],
      files: ["src/api/export.ts"],
      unverified: [],
      criteria: [{ id: "AC-1", test: "harness/AC-1", status: "pass" }],
      confidence: "strong",
    },
  },
];

const CONTEXT = "La feature exporte les factures en CSV ; `src/export.ts` doit dater chaque export.";

function decide(question: string, options: string[], dependsOn: number[] = []) {
  return {
    tool: "decision",
    args: {
      question,
      context: CONTEXT,
      options,
      chosen: options[0],
      rationale: "le plus réversible",
      category: "reversible",
      dependsOn,
    },
  };
}

test("harness-pipeline/AC-3 : une décision réversible devient un commit WIP « decision: … » ; renversée avec des dépendantes, ses commits et ceux de ses dépendantes sont revertés — le travail indépendant reste dans l'arbre", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [
      [
        decide("Séparateur CSV ?", ["virgule", "point-virgule"]),
        { write: "src/api/separator.ts", content: "export const SEP = ',';\n" },
        decide("Échappement des guillemets ?", ["doublés", "antislash"], [1]),
        { write: "src/api/quotes.ts", content: "export const QUOTE = '\"\"';\n" },
        decide("Nom du fichier ?", ["export.csv", "donnees.csv"]),
        ...OK.impl,
        { write: "src/api/after-decision.ts", content: "// fait après la décision\n" },
      ],
      OK.impl,
    ],
    review: [HUMAN_REVIEW, reviewOf(["src/api/export.ts", "src/api/after-decision.ts"])],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export séparateur", request: "Exporter" });
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human", stateOf(world, run.id));
    const decisions = world.store.listDecisions({ runId: run.id });
    assert.deepEqual(
      decisions.map((d) => [d.seq, d.status, d.dependsOn]),
      [
        [1, "auto", []],
        [2, "auto", [1]],
        [3, "auto", []],
      ],
    );
    const worktree = world.store.getRun(run.id)?.worktree as string;
    assert.match(
      git(worktree, "log", "-1", "--format=%s", decisions[0]?.checkpointSha as string),
      /^decision: Séparateur CSV \? → virgule/,
    );
    assert.ok(fs.existsSync(path.join(worktree, "src/api/after-decision.ts")));

    const checkpoint3 = decisions[2]?.checkpointSha;
    await world.orchestrator.reverseDecision(run.id, 1, "point-virgule", "Excel FR attend le point-virgule");
    // Les commits de #1 et #2 sont revertés, l'humain est dans l'oracle.
    assert.ok(world.oracle.retained.some((m) => /renversée/.test(m.text) && /Excel FR/.test(m.text)));
    assert.deepEqual(
      world.store.listDecisions({ runId: run.id }).map((d) => d.status),
      ["reversed", "superseded", "auto"],
      "seule la dépendante tombe",
    );
    const reversed = world.store.eventsSince(0, run.id).find((e) => e.type === "decision_reversed");
    assert.equal(reversed?.payload.mode, "revert");
    assert.equal(world.store.getDecision(run.id, 3)?.checkpointSha, checkpoint3, "le checkpoint de #3 est conservé");
    assert.ok(!fs.existsSync(path.join(worktree, "src/api/separator.ts")), "le travail de #1 est défait");
    assert.ok(!fs.existsSync(path.join(worktree, "src/api/quotes.ts")), "le travail de #2 est défait");
    assert.ok(fs.existsSync(path.join(worktree, "src/api/after-decision.ts")), "le travail indépendant reste");
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const resumed = world
      .log()
      .filter((e) => e.kind === "prompt" && e.step === "impl")
      .pop();
    assert.match(String(resumed?.message), /les commits après le checkpoint #1 \(jusqu'à #3\) ont été revertés/);
    assert.match(String(resumed?.message), /point-virgule/);
    assert.match(String(resumed?.message), /décisions #2 en découlaient/);
    assert.match(String(resumed?.message), /décisions #3 n'en dépendent pas : elles tiennent et restent dans l'arbre/);
    assert.match(String(resumed?.message), /#3 Nom du fichier \? → « export\.csv »/, "l'indépendante tient");
    assert.match(git(world.repo, "show", "main:src/api/after-decision.ts"), /fait après la décision/);
    assert.throws(() => git(world.repo, "show", "main:src/api/separator.ts"), "le travail de #1 ne revient pas");
    assert.match(git(world.repo, "log", "-1", "--format=%B", "main"), /Séparateur CSV \? → point-virgule/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-15 : une décision dont rien ne dépend se renverse sans retour arrière — une correction applique l'option sur l'état courant, les autres décisions tiennent", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [
      [
        decide("Séparateur CSV ?", ["virgule", "point-virgule"]),
        decide("Nom du fichier ?", ["export.csv", "donnees.csv"]),
        ...OK.impl,
        { write: "src/api/after-decision.ts", content: "// fait après la décision\n" },
      ],
    ],
    review: [HUMAN_REVIEW, reviewOf(["src/api/export.ts", "src/api/after-decision.ts"])],
    fix: [[{ write: "src/api/export.ts", content: "export const exportCsv = () => 'a;b';\n" }]],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export séparateur", request: "Exporter" });
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human", stateOf(world, run.id));
    const head = git(world.store.getRun(run.id)?.worktree as string, "rev-parse", "HEAD");

    await world.orchestrator.reverseDecision(run.id, 1, "point-virgule", "Excel FR attend le point-virgule");
    const reversed = world.store.eventsSince(0, run.id).find((e) => e.type === "decision_reversed");
    assert.equal(reversed?.payload.mode, "rework");
    assert.deepEqual(
      world.store.listDecisions({ runId: run.id }).map((d) => d.status),
      ["reversed", "auto"],
    );
    assert.equal(
      git(world.store.getRun(run.id)?.worktree as string, "rev-parse", "HEAD"),
      head,
      "aucun retour arrière",
    );
    await until(world, run.id, ["merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const fix = world.log().find((e) => e.kind === "prompt" && e.step === "fix");
    assert.match(String(fix?.message), /remplace « virgule » par « point-virgule »/);
    assert.match(String(fix?.message), /les autres décisions tiennent/);
    assert.equal(world.log().filter((e) => e.kind === "prompt" && e.step === "impl").length, 1, "/impl ne repasse pas");
    assert.match(
      git(world.repo, "show", "main:src/api/after-decision.ts"),
      /fait après la décision/,
      "le travail est gardé",
    );
    assert.match(git(world.repo, "show", "main:src/api/export.ts"), /a;b/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-4 : une décision irréversible n'est pas appliquée ; les escalades partent ensemble en fin d'étape, le runner meurt, la réponse fait reprendre l'étape", async () => {
  const escalate = (question: string) => ({
    tool: "decision",
    args: {
      question,
      context: CONTEXT,
      options: ["ajouter une colonne", "table séparée"],
      impacts: ["une migration de la table existante", "une jointure de plus à chaque lecture"],
      chosen: "ajouter une colonne",
      rationale: "simple",
      category: "schema",
    },
  });
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [
      [
        escalate("Où stocker la date d'export ?"),
        {
          tool: "decision",
          args: {
            question: "Purger l'historique ?",
            context: CONTEXT,
            options: ["oui", "non"],
            chosen: "oui",
            rationale: "supprimer les données de l'historique",
            category: "reversible",
          },
        },
        ...OK.impl,
      ],
      OK.impl,
    ],
    review: [OK.review],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export daté", request: "Exporter" });
    await until(world, run.id, ["escalated", "merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "escalated", stateOf(world, run.id));
    const open = world.store.listEscalations({ runId: run.id, status: "open" });
    assert.equal(open.length, 2, "les deux escalades sont dans le même lot");
    // La seconde était déclarée réversible : le service l'a durcie (suppression de données).
    assert.equal(open[1]?.category, "deletion");
    assert.equal(world.store.listDecisions({ runId: run.id }).length, 0, "aucun checkpoint pour l'irréversible");
    const batch = world.store.eventsSince(0, run.id).filter((e) => e.type === "escalations");
    assert.equal(batch.length, 1);
    assert.equal((batch[0]!.payload.items as unknown[]).length, 2);
    const toolResult = world.log().find((e) => e.kind === "tool" && e.tool === "decision");
    assert.match(String(toolResult?.result), /ESCALADÉE/);
    await waitFor(
      () => !(world.orchestrator.status().live as string[]).includes(run.id),
      () => "le runner escaladé doit mourir",
    );

    await world.orchestrator.answerEscalations(run.id, [{ id: open[0]?.id as number, answer: "table séparée" }]);
    assert.equal(world.store.getRun(run.id)?.state, "escalated", "une réponse partielle ne relance rien");
    await world.orchestrator.answerEscalations(run.id, [
      { id: open[1]?.id as number, answer: "non, on garde l'historique" },
    ]);
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const resumed = world
      .log()
      .filter((e) => e.kind === "prompt" && e.step === "impl")
      .pop();
    assert.match(String(resumed?.message), /table séparée/);
    assert.ok(world.oracle.retained.some((m) => /tranchée par l'humain/.test(m.text) && /table séparée/.test(m.text)));
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-5 : un verdict faible (un critère non vérifié) attend l'humain, qui lit le code ; un refus renvoie en correction avec sa raison", async () => {
  const weak = [
    { tool: "run_tests", args: { scope: "full" } },
    {
      tool: "review_verdict",
      args: {
        risk: "low",
        summary: "ok ?",
        blockers: [],
        risks: [],
        files: ["src/api/export.ts"],
        unverified: ["AC-1 : la perf sur 1M lignes n'a pas été vérifiée"],
        criteria: [{ id: "AC-1", test: "harness/AC-1", status: "untested" }],
        confidence: "strong",
      },
    },
  ];
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [OK.impl],
    review: [weak, reviewOf(["src/api/export.ts", "src/api/stream.ts"])],
    fix: [[{ write: "src/api/stream.ts", content: "// streaming\n" }]],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export gros volumes", request: "Exporter" });
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    const waiting = world.store.getRun(run.id);
    assert.equal(waiting?.state, "awaiting_human");
    assert.match(waiting?.reason ?? "", /non vérifié|verdict faible/);
    const review = world.store.eventsSince(0, run.id).find((e) => e.type === "review");
    assert.equal(
      (review!.payload.merge as { readCode: boolean }).readCode,
      true,
      "verdict faible : l'humain lit le code",
    );

    await world.orchestrator.validate(run.id, false, "streamer au lieu de tout charger");
    await until(world, run.id, ["merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const fixPrompt = world.log().find((e) => e.kind === "prompt" && e.step === "fix");
    assert.match(String(fixPrompt?.message), /streamer au lieu de tout charger/);
    assert.ok(world.oracle.retained.some((m) => /Correction humaine/.test(m.text)));
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-6 : un rate limit bascule le runner sur le fournisseur suivant (set_model) sans perdre l'étape", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [[{ error: { message: "429 Too Many Requests", httpStatus: 429, retryable: true } }], OK.impl],
      review: [OK.review],
    },
    {
      patch: (config) => {
        config.stepTiers = { ...config.stepTiers, req: "fast", specs: "fast" };
        config.models = {
          fast: [{ provider: "fastco", model: "f1" }],
          standard: [],
          heavy: [
            { provider: "alpha", model: "big" },
            { provider: "beta", model: "big2" },
          ],
        };
        config.providers = { alpha: { capacity: 10, refillPerMinute: 10 } };
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export limité", request: "Exporter" });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const switched = world.log().filter((e) => e.kind === "command" && e.type === "set_model");
    assert.deepEqual(
      switched.map((e) => `${e.provider}/${e.modelId}`),
      ["beta/big2"],
    );
    assert.ok(
      world.store.eventsSince(0, run.id).some((e) => e.type === "model_failover" && e.payload.to === "beta/big2"),
    );
    // Le modèle de départ suit le tier de l'étape : rapide pour req (et specs, même
    // runner), et pour impl (standard) la chaîne lourde, faute de chaîne standard.
    const argvs = world
      .log()
      .filter((e) => e.kind === "argv")
      .map((e) => (e.argv as string[]).join(" "));
    assert.equal(argvs.length, 3, "req+specs, impl, review");
    assert.match(argvs[0] as string, /--model fastco\/f1/);
    assert.match(argvs[1] as string, /--model alpha\/big/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-7 : /review part d'un rebase sur main ; un main qui bouge après la revue est rebasé et re-testé en heavy (sans LLM) avant le merge", async () => {
  const medium = [
    { tool: "run_tests", args: { scope: "full" } },
    {
      tool: "review_verdict",
      args: {
        risk: "medium",
        summary: "export ok",
        blockers: [],
        risks: ["volumétrie"],
        files: ["src/api/export.ts"],
        unverified: [],
        confidence: "strong",
      },
    },
  ];
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [medium] });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export rebasé", request: "Exporter" });
    await waitFor(
      () => world.store.getRun(run.id)?.step === "impl",
      () => stateOf(world, run.id),
    );
    const beforeReview = commitOnMain(world.repo, "docs/changelog.md", "v2\n");
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.ok(
      world.store.eventsSince(0, run.id).some((e) => e.type === "rebased" && e.payload.base === beforeReview),
      "rebase avant /review",
    );
    assert.equal(world.store.getRun(run.id)?.baseSha, beforeReview);

    const afterReview = commitOnMain(world.repo, "docs/guide.md", "// guide v2\n");
    const fullRunsBefore = world.store.listTestRuns(run.id).filter((t) => t.scope === "full" && !t.cached).length;
    const promptsBefore = world.log().filter((e) => e.kind === "prompt").length;
    await world.orchestrator.validate(run.id, true, "ok pour moi");
    await until(world, run.id, ["merged", "failed", "queued", "running"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.equal(
      git(world.repo, "rev-parse", "main^"),
      afterReview,
      "le squash est posé sur le main qui a bougé après la revue",
    );
    assert.equal(
      world.store.listTestRuns(run.id).filter((t) => t.scope === "full" && !t.cached).length,
      fullRunsBefore + 1,
      "la suite complète a repassé sur le nouvel arbre",
    );
    assert.equal(
      world.log().filter((e) => e.kind === "prompt").length,
      promptsBefore,
      "aucun prompt LLM pour ce re-test",
    );
    assert.equal(git(world.repo, "show", "main:docs/guide.md"), "// guide v2");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-8 : un service redémarré reprend chaque run au dernier checkpoint, avec un nouveau runner", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [
        [
          { write: "src/api/partial.ts", content: "// non commité\n" },
          { tool: "progress", args: { message: "à moitié" } },
          { tool: "run_tests", args: { scope: "touched" } },
        ],
        OK.impl,
      ],
      review: [OK.review],
    },
    { patch: (config) => ((config.repos[0] as { tests: { touched: string } }).tests.touched = "sleep 1 # {files}") },
  );
  await world.orchestrator.start();
  const run = world.orchestrator.createRun({ repo: "demo", title: "Export interrompu", request: "Exporter" });
  // L'arrêt tombe PENDANT l'étape /impl : son runner attend un job heavy.
  await waitFor(
    () => world.store.eventsSince(0, run.id).some((e) => e.type === "progress" && e.payload.message === "à moitié"),
    () => stateOf(world, run.id),
  );
  await world.orchestrator.stop();
  assert.equal(world.store.getRun(run.id)?.state, "running", "l'état écrit est celui d'un crash : running");
  const worktree = world.store.getRun(run.id)?.worktree as string;
  assert.ok(fs.existsSync(path.join(worktree, "src/api/partial.ts")));

  const restarted = new Orchestrator(world.deps);
  await restarted.start();
  try {
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.ok(world.store.eventsSince(0, run.id).some((e) => e.type === "recovered"));
    assert.ok(world.store.listSteps(run.id).some((step) => step.kind === "impl" && step.status === "interrupted"));
    const implPids = new Set(
      world
        .log()
        .filter((e) => e.kind === "prompt" && e.step === "impl")
        .map((e) => e.pid),
    );
    assert.equal(implPids.size, 2, "l'étape reprend avec un nouveau runner");
    assert.throws(
      () => git(world.repo, "show", "main:src/api/partial.ts"),
      "le travail non commité de l'étape interrompue est jeté",
    );
  } finally {
    await restarted.stop();
  }
});

test("harness-pipeline/AC-9 : un rebase en conflit devient une fusion de main faite par le service ; le runner résout dans les fichiers, sans git", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [[{ sleep: 300 }, { write: "README.md", content: "// README.md\nexport CSV\n" }, ...OK.impl]],
    review: [
      [
        { write: "README.md", content: "// README.md\nexport CSV\nguide v2\n" },
        ...reviewOf(["src/api/export.ts", "README.md"]),
      ],
    ],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export en conflit", request: "Exporter" });
    await waitFor(
      () => world.store.getRun(run.id)?.step === "impl",
      () => stateOf(world, run.id),
    );
    const moved = commitOnMain(world.repo, "README.md", "// README.md\nguide v2\n");
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.ok(
      world.store.eventsSince(0, run.id).some((e) => e.type === "rebase_conflict" && e.payload.strategy === "merge"),
    );
    const review = world.log().find((e) => e.kind === "prompt" && e.step === "review");
    assert.match(String(review?.message), /marqueurs de conflit : README\.md/);
    assert.match(String(review?.message), /n'appelle pas git/);
    assert.equal(git(world.repo, "rev-parse", "main^"), moved);
    assert.equal(git(world.repo, "show", "main:README.md"), "// README.md\nexport CSV\nguide v2");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-10 : les gestes humains ne s'écrasent pas — annuler pendant un merge est refusé, valider un run annulé aussi", async () => {
  const world = fakeWorld({ req: [[{ sleep: 60_000 }]] });
  try {
    const merging = world.store.createRun({
      id: "rm",
      repo: "demo",
      slug: "m",
      title: "M",
      request: "m",
      branch: "harness/m",
      state: "merging",
    });
    await assert.rejects(world.orchestrator.cancel(merging.id), /merge en cours/);
    const run = world.orchestrator.createRun({ repo: "demo", title: "Annulée", request: "x" });
    await world.orchestrator.cancel(run.id);
    await assert.rejects(world.orchestrator.validate(run.id, true, ""), /n'attend pas de validation/);
    await world.orchestrator.tick();
    assert.equal(world.store.getRun(run.id)?.state, "cancelled", "aucun tick ne relance un run annulé");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-11 : avec la porte des specs, le run attend l'humain après /specs ; un refus refait /specs avec sa raison, l'accord lance /impl", async () => {
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] },
    { patch: (config) => (config.review.specsGate = true) },
  );
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export validé", request: "Exporter" });
    await until(world, run.id, ["awaiting_human", "failed"]);
    assert.deepEqual(
      [world.store.getRun(run.id)?.state, world.store.getRun(run.id)?.step],
      ["awaiting_human", "specs"],
      stateOf(world, run.id),
    );
    assert.ok(world.store.eventsSince(0, run.id).some((e) => e.type === "specs_ready"));
    await assert.rejects(world.orchestrator.validate(run.id, false, " "), /raison/);
    await world.orchestrator.validate(run.id, false, "AC-1 doit nommer son test");
    await until(world, run.id, ["awaiting_human", "failed"]);
    const specsPrompts = world.log().filter((e) => e.kind === "prompt" && e.step === "specs" && e.nudge === false);
    assert.equal(specsPrompts.length, 2, "/specs refait une fois");
    assert.match(String(specsPrompts[1]?.message), /refusé les specs : AC-1 doit nommer son test/);
    assert.ok(world.oracle.retained.some((m) => /Correction humaine — specs/.test(m.text)));
    await world.orchestrator.validate(run.id, true, "");
    await until(world, run.id, ["merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-12 : un audit lit main en lecture seule, rend ses propositions, et celles retenues partent en projet planifié", async () => {
  const proposals = [
    {
      title: "Valider les entrées de l'API",
      request: "Valider les paramètres des routes",
      modules: ["src/api"],
      kind: "faiblesse",
      rationale: "aucune validation",
      evidence: ["src/api/routes.ts:12"],
      dependsOn: [],
      impact: "medium",
      effort: "low",
    },
    {
      title: "Index du schéma",
      request: "Indexer les colonnes lues",
      modules: ["src/db"],
      kind: "feature",
      rationale: "requêtes lentes",
      evidence: [],
      dependsOn: [],
      impact: "medium",
      effort: "low",
    },
  ];
  const world = fakeWorld({
    audit: [
      [
        { tool: "progress", args: { message: "src/ lu" } },
        { tool: "audit_propose", args: { proposals } },
      ],
    ],
    req: [[{ sleep: 60_000 }]],
  });
  await world.orchestrator.start();
  try {
    const audit = world.orchestrator.audits.create("demo", "src/");
    await waitFor(
      () => ["proposed", "failed"].includes(world.store.getAudit(audit.id)?.state ?? ""),
      () => JSON.stringify(world.store.getAudit(audit.id)),
    );
    const done = world.store.getAudit(audit.id);
    assert.equal(done?.state, "proposed", done?.reason ?? "");
    assert.deepEqual(
      done?.proposals.map((p) => p.kind),
      ["faiblesse", "feature"],
    );
    // Le runner d'audit a tourné dans un worktree détaché, rendu ensuite ; aucun commit, aucune branche.
    const argv = world.log().find((e) => e.kind === "argv");
    assert.match(String(argv?.cwd), /_audit-/);
    assert.ok(!fs.existsSync(String(argv?.cwd)));
    assert.equal(git(world.repo, "branch", "--list", "harness/*"), "");
    const prompt = world.log().find((e) => e.kind === "prompt" && e.step === "audit");
    assert.match(String(prompt?.message), /LECTURE SEULE/);
    await assert.rejects(world.orchestrator.audits.launch(audit.id, [5]), /index de propositions/);
    const { projectId } = await world.orchestrator.audits.launch(audit.id, [1]);
    await assert.rejects(world.orchestrator.audits.launch(audit.id, [0]), /pas de propositions à lancer/);
    const runs = world.store.listRuns({ projectId });
    assert.deepEqual(
      runs.map((run) => [run.title, run.modules]),
      [["Index du schéma", ["src/db"]]],
    );
    assert.equal(world.store.getAudit(audit.id)?.state, "launched");
    assert.equal(world.store.getAudit(audit.id)?.projectId, projectId);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-13 : un audit sans propositions est relancé une fois puis échoue ; un audit en cours s'annule et rend son runner", async () => {
  const world = fakeWorld({ audit: [[]] });
  await world.orchestrator.start();
  try {
    const silent = world.orchestrator.audits.create("demo", "");
    await waitFor(
      () => world.store.getAudit(silent.id)?.state === "failed",
      () => JSON.stringify(world.store.getAudit(silent.id)),
    );
    assert.match(world.store.getAudit(silent.id)?.reason ?? "", /audit_propose/);
    assert.equal(world.log().filter((e) => e.kind === "prompt" && e.step === "audit").length, 2);
  } finally {
    await world.orchestrator.stop();
  }
  const slow = fakeWorld({ audit: [[{ sleep: 60_000 }]] });
  await slow.orchestrator.start();
  try {
    const audit = slow.orchestrator.audits.create("demo", "");
    await waitFor(
      () => slow.store.getAudit(audit.id)?.state === "analysing" && slow.log().some((e) => e.kind === "prompt"),
      () => JSON.stringify(slow.store.getAudit(audit.id)),
    );
    await slow.orchestrator.audits.cancel(audit.id);
    assert.equal(slow.store.getAudit(audit.id)?.state, "cancelled");
    assert.equal(slow.scheduler.snapshot().runner.used, 0);
  } finally {
    await slow.orchestrator.stop();
  }
});

test("harness-pipeline/AC-14 : un run créé avec son compte rendu de besoins (/req interactif) part de /specs, qui le lit", async () => {
  const world = fakeWorld({ specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  await world.orchestrator.start();
  try {
    assert.throws(
      () => world.orchestrator.createRun({ repo: "demo", title: "Sans section", request: "x", req: "des besoins" }),
      /## Besoins/,
    );
    const run = world.orchestrator.createRun({
      repo: "demo",
      title: "Export clarifié",
      request: "Exporter",
      req: "## Besoins\nB-1 : exporter en CSV\n",
    });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.deepEqual(
      world.store.listSteps(run.id).map((step) => step.kind),
      ["specs", "impl", "review"],
    );
    assert.ok(world.oracle.retained.some((m) => /Compte rendu de besoins — « Export clarifié »/.test(m.text)));
    // Le runner de /specs a trouvé req.md dans son worktree.
    assert.equal(world.store.getArtifact(run.id, "req.md"), "## Besoins\nB-1 : exporter en CSV\n");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-16 : chaque étape prend le modèle de son tier ; review → fix garde son runner et change seulement de modèle, la dernière correction passe en heavy", async () => {
  const blocked = [
    { tool: "run_tests", args: { scope: "full" } },
    {
      tool: "review_verdict",
      args: {
        risk: "low",
        summary: "il manque un test",
        blockers: ["AC-1 sans test"],
        risks: [],
        files: ["src/api/export.ts"],
        unverified: [],
        criteria: [{ id: "AC-1", test: "harness/AC-1", status: "fail" }],
        confidence: "strong",
      },
    },
  ];
  const fixed = (n: number) => [{ write: `src/api/export-${n}.test.ts`, content: "// AC-1\n" }];
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [OK.impl],
      review: [
        blocked,
        blocked,
        reviewOf(["src/api/export.ts", "src/api/export-1.test.ts", "src/api/export-2.test.ts"]),
      ],
      fix: [fixed(1), fixed(2)],
    },
    {
      patch: (config) => {
        config.review.fixCap = 2;
        config.models = {
          fast: [],
          standard: [{ provider: "mid", model: "m1" }],
          heavy: [{ provider: "big", model: "h1" }],
        };
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export par tiers", request: "Exporter" });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const argvs = world
      .log()
      .filter((e) => e.kind === "argv")
      .map((e) => (e.argv as string[]).join(" "));
    assert.equal(argvs.length, 5, "req+specs, impl, et une revue par passe : un runner chacun");
    assert.match(argvs[0] as string, /--model big\/h1/, "/req (puis /specs) : heavy");
    assert.match(argvs[1] as string, /--model mid\/m1/, "/impl : standard");
    assert.match(argvs[2] as string, /--model big\/h1/, "/review : heavy");
    assert.match(argvs[3] as string, /--model big\/h1/, "/review après la correction 1 : heavy, runner neuf");
    assert.match(argvs[4] as string, /--model big\/h1/, "/review après la correction 2 : heavy, runner neuf");
    const switched = world.log().filter((e) => e.kind === "command" && e.type === "set_model");
    assert.deepEqual(
      switched.map((e) => `${e.provider}/${e.modelId}`),
      ["mid/m1"],
      "fix 1 en standard dans le runner de la revue ; fix 2 (dernière) reste en heavy, sans bascule",
    );
    assert.ok(world.store.eventsSince(0, run.id).some((e) => e.type === "model_tier" && e.payload.to === "mid/m1"));
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-17 : une étape qui dépasse son échéance arrête son runner et échoue, relançable ; relances épuisées, l'humain reprend la main — un agent qui boucle ne garde pas son slot", async () => {
  const world = fakeWorld({ req: [[{ sleep: 60_000 }]] }, { patch: (config) => (config.runner.stepTimeoutSec = 1) });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Boucle", request: "ne finit jamais" });
    await until(world, run.id, ["failed", "merged", "awaiting_human"], 20_000);
    const steps = world.store.listSteps(run.id);
    // Une relance (stepRetries = 1, sans attente) ; le délai se résout en attendant, donc
    // la liste se consomme entière, puis l'humain (qui peut relancer), jamais `failed`.
    assert.deepEqual(
      steps.map((step) => `${step.kind}:${step.status}`),
      ["req:failed", "req:failed"],
    );
    assert.match(steps[0]?.summary ?? "", /délai d'étape dépassé \(1 s\)/);
    assert.equal(world.store.eventsSince(0, run.id).filter((event) => event.type === "step_timeout").length, 2);
    const halted = world.store.getRun(run.id);
    assert.deepEqual([halted?.state, halted?.step, halted?.lastFailCause], ["awaiting_human", "req", "timeout"]);
    assert.match(halted?.reason ?? "", /2 fois \(timeout\), relances épuisées/);
    // Entre les deux tentatives, le run est repassé par la file avec sa cause gardée.
    assert.ok(
      world.store
        .eventsSince(0, run.id)
        .some(
          (e) => e.type === "run_state" && e.payload.state === "queued" && /relance/.test(String(e.payload.reason)),
        ),
    );
    assert.equal(world.scheduler.snapshot().runner.used, 0, "le slot est rendu");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-pipeline/AC-18 : un run en file dont l'heure n'est pas venue (`notBefore`) n'est pas admis, puis part quand elle l'est", async () => {
  const world = fakeWorld({ req: [[{ sleep: 60_000 }]] });
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Plus tard", request: "x", modules: ["src/api"] });
    world.store.updateRun(run.id, { notBefore: Date.now() + 60 * 60 * 1000 });
    await world.orchestrator.start();
    await world.orchestrator.tick();
    assert.equal(world.store.getRun(run.id)?.state, "queued", "pas avant l'heure");
    assert.ok(!(world.orchestrator.status().live as string[]).includes(run.id));
    world.store.updateRun(run.id, { notBefore: Date.now() - 1 });
    await world.orchestrator.tick();
    await waitFor(
      () => world.store.getRun(run.id)?.state === "running",
      () => stateOf(world, run.id),
    );
    assert.equal(world.store.getRun(run.id)?.notBefore, null, "l'admission efface l'attente");
  } finally {
    await world.orchestrator.stop();
  }
});
