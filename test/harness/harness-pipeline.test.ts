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
  await waitFor(() => states.includes(world.store.getRun(runId)?.state ?? ""), () => stateOf(world, runId), timeoutMs);
}


test("harness-pipeline/AC-1 : un run bas risque aux tests verts va de /req au merge squash sur main, sans humain", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  await world.orchestrator.start();
  try {
    const mainBefore = git(world.repo, "rev-parse", "main");
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter les données en CSV" });
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
    assert.deepEqual(world.store.listSteps(run.id).map(step => `${step.kind}:${step.status}`), ["req:done", "specs:done", "impl:done", "review:done"]);
    // La suite complète a tourné une fois, en heavy, et le résultat est en cache.
    assert.deepEqual(world.store.listTestRuns(run.id).map(t => `${t.scope}:${t.outcome}`), ["touched:pass", "full:pass"]);
    // Knowledge-updater : le compte rendu de besoins et la feature mergée retournent à l'oracle.
    await waitFor(() => world.oracle.retained.length >= 2, () => JSON.stringify(world.oracle.retained));
    assert.ok(world.oracle.retained.some(m => /Compte rendu de besoins/.test(m.text) && m.scope === "demo-scope"));
    assert.ok(world.oracle.retained.some(m => /Feature mergée « Export CSV »/.test(m.text)));
  } finally {
    await world.orchestrator.stop();
  }
});


test("harness-pipeline/AC-2 : chaque étape a son runner, sauf review ⇄ fix qui garde le même process (cache de prompt)", async () => {
  const blocked = [
    { tool: "run_tests", args: { scope: "full" } },
    { tool: "review_verdict", args: { risk: "low", summary: "il manque un test", blockers: ["AC-1 sans test"], risks: [], files: ["src/api/export.ts"], unverified: [], confidence: "strong" } },
  ];
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [OK.impl],
    review: [blocked, OK.review],
    fix: [[{ write: "src/api/export.test.ts", content: "// AC-1\n" }, { tool: "run_tests", args: { scope: "touched" } }]],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export avec correction", request: "Exporter" });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.equal(world.store.getRun(run.id)?.fixes, 1);
    const prompts = world.log().filter(entry => entry.kind === "prompt" && entry.nudge === false);
    const pidOf = (step: string) => prompts.filter(p => p.step === step).map(p => p.pid);
    const reviewPids = pidOf("review");
    assert.equal(reviewPids.length, 2);
    assert.equal(reviewPids[0], reviewPids[1], "la revue reprend dans le même runner");
    assert.equal(pidOf("fix")[0], reviewPids[0], "la correction tourne dans le runner de la revue");
    const distinct = new Set([pidOf("req")[0], pidOf("specs")[0], pidOf("impl")[0], reviewPids[0]]);
    assert.equal(distinct.size, 4, "req, specs, impl et review ont chacun leur runner");
    // Le prompt de correction porte les bloquants de la revue.
    assert.match(String(prompts.find(p => p.step === "fix")?.message), /AC-1 sans test/);
  } finally {
    await world.orchestrator.stop();
  }
});


test("harness-pipeline/AC-3 : une décision réversible devient un commit WIP « decision: … » ; renversée, le run reprend au checkpoint avec l'option de l'humain", async () => {
  const decide = { tool: "decision", args: { question: "Séparateur CSV ?", options: ["virgule", "point-virgule"], chosen: "virgule", rationale: "standard RFC 4180", category: "reversible" } };
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [[decide, ...OK.impl, { write: "src/api/after-decision.ts", content: "// fait après la décision\n" }], OK.impl],
    review: [
      [
        { tool: "run_tests", args: { scope: "full" } },
        { tool: "review_verdict", args: { risk: "medium", summary: "à relire", blockers: [], risks: ["format"], files: ["src/api/export.ts"], unverified: [], confidence: "strong" } },
      ],
      OK.review,
    ],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export séparateur", request: "Exporter" });
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human", stateOf(world, run.id));
    const [decision] = world.store.listDecisions({ runId: run.id });
    assert.equal(decision?.seq, 1);
    assert.equal(decision?.status, "auto");
    const worktree = world.store.getRun(run.id)?.worktree as string;
    assert.match(git(worktree, "log", "-1", "--format=%s", decision?.checkpointSha as string), /^decision: Séparateur CSV \? → virgule/);
    assert.ok(fs.existsSync(path.join(worktree, "src/api/after-decision.ts")));

    await world.orchestrator.reverseDecision(run.id, 1, "point-virgule", "Excel FR attend le point-virgule");
    // Le travail postérieur au checkpoint est annulé, l'humain est dans l'oracle.
    assert.ok(world.oracle.retained.some(m => /renversée/.test(m.text) && /Excel FR/.test(m.text)));
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.equal(world.store.getDecision(run.id, 1)?.status, "reversed");
    const resumed = world.log().filter(e => e.kind === "prompt" && e.step === "impl").pop();
    assert.match(String(resumed?.message), /Reprise au checkpoint #1/);
    assert.match(String(resumed?.message), /point-virgule/);
    assert.throws(() => git(world.repo, "show", "main:src/api/after-decision.ts"), "le travail d'après le checkpoint ne revient pas");
    assert.match(git(world.repo, "log", "-1", "--format=%B", "main"), /Séparateur CSV \? → point-virgule/);
  } finally {
    await world.orchestrator.stop();
  }
});


test("harness-pipeline/AC-4 : une décision irréversible n'est pas appliquée ; les escalades partent ensemble en fin d'étape, le runner meurt, la réponse fait reprendre l'étape", async () => {
  const escalate = (question: string) => ({
    tool: "decision",
    args: { question, options: ["ajouter une colonne", "table séparée"], chosen: "ajouter une colonne", rationale: "simple", category: "schema" },
  });
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [[escalate("Où stocker la date d'export ?"), { tool: "decision", args: { question: "Purger l'historique ?", options: ["oui", "non"], chosen: "oui", rationale: "supprimer les données de l'historique", category: "reversible" } }, ...OK.impl], OK.impl],
    review: [OK.review],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export daté", request: "Exporter" });
    await until(world, run.id, ["escalated", "merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "escalated", stateOf(world, run.id));
    const open = world.store.listEscalations({ runId: run.id, status: "open" });
    assert.equal(open.length, 2, "les deux escalades sont dans le même lot");
    // La seconde était déclarée réversible : le service l'a durcie (suppression de données).
    assert.equal(open[1]?.category, "deletion");
    assert.equal(world.store.listDecisions({ runId: run.id }).length, 0, "aucun checkpoint pour l'irréversible");
    const batch = world.store.eventsSince(0, run.id).filter(e => e.type === "escalations");
    assert.equal(batch.length, 1);
    assert.equal((batch[0]?.payload.items as unknown[]).length, 2);
    const toolResult = world.log().find(e => e.kind === "tool" && e.tool === "decision");
    assert.match(String(toolResult?.result), /ESCALADÉE/);
    await waitFor(() => !(world.orchestrator.status().live as string[]).includes(run.id), () => "le runner escaladé doit mourir");

    await world.orchestrator.answerEscalations(run.id, [{ id: open[0]?.id as number, answer: "table séparée" }]);
    assert.equal(world.store.getRun(run.id)?.state, "escalated", "une réponse partielle ne relance rien");
    await world.orchestrator.answerEscalations(run.id, [{ id: open[1]?.id as number, answer: "non, on garde l'historique" }]);
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const resumed = world.log().filter(e => e.kind === "prompt" && e.step === "impl").pop();
    assert.match(String(resumed?.message), /table séparée/);
    assert.ok(world.oracle.retained.some(m => /tranchée par l'humain/.test(m.text) && /table séparée/.test(m.text)));
  } finally {
    await world.orchestrator.stop();
  }
});


test("harness-pipeline/AC-5 : un verdict faible (points non vérifiés) attend l'humain, qui lit le code ; un refus renvoie en correction avec sa raison", async () => {
  const weak = [
    { tool: "run_tests", args: { scope: "full" } },
    { tool: "review_verdict", args: { risk: "low", summary: "ok ?", blockers: [], risks: [], files: ["src/api/export.ts"], unverified: ["perf sur 1M lignes"], confidence: "strong" } },
  ];
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [weak, OK.review], fix: [[{ write: "src/api/stream.ts", content: "// streaming\n" }]] });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export gros volumes", request: "Exporter" });
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    const waiting = world.store.getRun(run.id);
    assert.equal(waiting?.state, "awaiting_human");
    assert.match(waiting?.reason ?? "", /verdict faible/);
    const review = world.store.eventsSince(0, run.id).find(e => e.type === "review");
    assert.equal((review?.payload.merge as { readCode: boolean }).readCode, true, "verdict faible : l'humain lit le code");

    await world.orchestrator.validate(run.id, false, "streamer au lieu de tout charger");
    await until(world, run.id, ["merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const fixPrompt = world.log().find(e => e.kind === "prompt" && e.step === "fix");
    assert.match(String(fixPrompt?.message), /streamer au lieu de tout charger/);
    assert.ok(world.oracle.retained.some(m => /Correction humaine/.test(m.text)));
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
      patch: config => {
        config.models = { fast: [{ provider: "fastco", model: "f1" }], heavy: [{ provider: "alpha", model: "big" }, { provider: "beta", model: "big2" }] };
        config.providers = { alpha: { capacity: 10, refillPerMinute: 10 } };
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export limité", request: "Exporter" });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const switched = world.log().filter(e => e.kind === "command" && e.type === "set_model");
    assert.deepEqual(switched.map(e => `${e.provider}/${e.modelId}`), ["beta/big2"]);
    assert.ok(world.store.eventsSince(0, run.id).some(e => e.type === "model_failover" && e.payload.to === "beta/big2"));
    // Le modèle de départ suit le tier : rapide pour req, lourd pour impl.
    const argvs = world.log().filter(e => e.kind === "argv").map(e => (e.argv as string[]).join(" "));
    assert.match(argvs[0] as string, /--model fastco\/f1/);
    assert.match(argvs[2] as string, /--model alpha\/big/);
  } finally {
    await world.orchestrator.stop();
  }
});


test("harness-pipeline/AC-7 : /review part d'un rebase sur main ; un main qui bouge après la revue est rebasé et re-testé en heavy (sans LLM) avant le merge", async () => {
  const medium = [
    { tool: "run_tests", args: { scope: "full" } },
    { tool: "review_verdict", args: { risk: "medium", summary: "export ok", blockers: [], risks: ["volumétrie"], files: ["src/api/export.ts"], unverified: [], confidence: "strong" } },
  ];
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [medium] });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export rebasé", request: "Exporter" });
    await waitFor(() => world.store.getRun(run.id)?.step === "impl", () => stateOf(world, run.id));
    const beforeReview = commitOnMain(world.repo, "docs/changelog.md", "v2\n");
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.ok(world.store.eventsSince(0, run.id).some(e => e.type === "rebased" && e.payload.base === beforeReview), "rebase avant /review");
    assert.equal(world.store.getRun(run.id)?.baseSha, beforeReview);

    const afterReview = commitOnMain(world.repo, "docs/guide.md", "// guide v2\n");
    const fullRunsBefore = world.store.listTestRuns(run.id).filter(t => t.scope === "full" && !t.cached).length;
    const promptsBefore = world.log().filter(e => e.kind === "prompt").length;
    await world.orchestrator.validate(run.id, true, "ok pour moi");
    await until(world, run.id, ["merged", "failed", "queued", "running"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.equal(git(world.repo, "rev-parse", "main^"), afterReview, "le squash est posé sur le main qui a bougé après la revue");
    assert.equal(world.store.listTestRuns(run.id).filter(t => t.scope === "full" && !t.cached).length, fullRunsBefore + 1, "la suite complète a repassé sur le nouvel arbre");
    assert.equal(world.log().filter(e => e.kind === "prompt").length, promptsBefore, "aucun prompt LLM pour ce re-test");
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
      impl: [[{ write: "src/api/partial.ts", content: "// non commité\n" }, { tool: "progress", args: { message: "à moitié" } }, { tool: "run_tests", args: { scope: "touched" } }], OK.impl],
      review: [OK.review],
    },
    { patch: config => ((config.repos[0] as { tests: { touched: string } }).tests.touched = "sleep 1 # {files}") },
  );
  await world.orchestrator.start();
  const run = world.orchestrator.createRun({ repo: "demo", title: "Export interrompu", request: "Exporter" });
  // L'arrêt tombe PENDANT l'étape /impl : son runner attend un job heavy.
  await waitFor(() => world.store.eventsSince(0, run.id).some(e => e.type === "progress" && e.payload.message === "à moitié"), () => stateOf(world, run.id));
  await world.orchestrator.stop();
  assert.equal(world.store.getRun(run.id)?.state, "running", "l'état écrit est celui d'un crash : running");
  const worktree = world.store.getRun(run.id)?.worktree as string;
  assert.ok(fs.existsSync(path.join(worktree, "src/api/partial.ts")));

  const restarted = new Orchestrator(world.deps);
  await restarted.start();
  try {
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.ok(world.store.eventsSince(0, run.id).some(e => e.type === "recovered"));
    assert.ok(world.store.listSteps(run.id).some(step => step.kind === "impl" && step.status === "interrupted"));
    const implPids = new Set(world.log().filter(e => e.kind === "prompt" && e.step === "impl").map(e => e.pid));
    assert.equal(implPids.size, 2, "l'étape reprend avec un nouveau runner");
    assert.throws(() => git(world.repo, "show", "main:src/api/partial.ts"), "le travail non commité de l'étape interrompue est jeté");
  } finally {
    await restarted.stop();
  }
});


test("harness-pipeline/AC-9 : un rebase en conflit devient une fusion de main faite par le service ; le runner résout dans les fichiers, sans git", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [[{ sleep: 300 }, { write: "README.md", content: "// README.md\nexport CSV\n" }, ...OK.impl]],
    review: [[{ write: "README.md", content: "// README.md\nexport CSV\nguide v2\n" }, ...OK.review]],
  });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export en conflit", request: "Exporter" });
    await waitFor(() => world.store.getRun(run.id)?.step === "impl", () => stateOf(world, run.id));
    const moved = commitOnMain(world.repo, "README.md", "// README.md\nguide v2\n");
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.ok(world.store.eventsSince(0, run.id).some(e => e.type === "rebase_conflict" && e.payload.strategy === "merge"));
    const review = world.log().find(e => e.kind === "prompt" && e.step === "review");
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
    const merging = world.store.createRun({ id: "rm", repo: "demo", slug: "m", title: "M", request: "m", branch: "harness/m", state: "merging" });
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
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] }, { patch: config => (config.review.specsGate = true) });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export validé", request: "Exporter" });
    await until(world, run.id, ["awaiting_human", "failed"]);
    assert.deepEqual([world.store.getRun(run.id)?.state, world.store.getRun(run.id)?.step], ["awaiting_human", "specs"], stateOf(world, run.id));
    assert.ok(world.store.eventsSince(0, run.id).some(e => e.type === "specs_ready"));
    await assert.rejects(world.orchestrator.validate(run.id, false, " "), /raison/);
    await world.orchestrator.validate(run.id, false, "AC-1 doit nommer son test");
    await until(world, run.id, ["awaiting_human", "failed"]);
    const specsPrompts = world.log().filter(e => e.kind === "prompt" && e.step === "specs" && e.nudge === false);
    assert.equal(specsPrompts.length, 2, "/specs refait une fois");
    assert.match(String(specsPrompts[1]?.message), /refusé les specs : AC-1 doit nommer son test/);
    assert.ok(world.oracle.retained.some(m => /Correction humaine — specs/.test(m.text)));
    await world.orchestrator.validate(run.id, true, "");
    await until(world, run.id, ["merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
  } finally {
    await world.orchestrator.stop();
  }
});


test("harness-pipeline/AC-12 : un audit lit main en lecture seule, rend ses propositions, et celles retenues partent en projet planifié", async () => {
  const proposals = [
    { title: "Valider les entrées de l'API", request: "Valider les paramètres des routes", modules: ["src/api"], kind: "faiblesse", rationale: "aucune validation" },
    { title: "Index du schéma", request: "Indexer les colonnes lues", modules: ["src/db"], kind: "feature", rationale: "requêtes lentes" },
  ];
  const world = fakeWorld({ audit: [[{ tool: "progress", args: { message: "src/ lu" } }, { tool: "audit_propose", args: { proposals } }]], req: [[{ sleep: 60_000 }]] });
  await world.orchestrator.start();
  try {
    const audit = world.orchestrator.audits.create("demo", "src/");
    await waitFor(() => ["proposed", "failed"].includes(world.store.getAudit(audit.id)?.state ?? ""), () => JSON.stringify(world.store.getAudit(audit.id)));
    const done = world.store.getAudit(audit.id);
    assert.equal(done?.state, "proposed", done?.reason ?? "");
    assert.deepEqual(done?.proposals.map(p => p.kind), ["faiblesse", "feature"]);
    // Le runner d'audit a tourné dans un worktree détaché, rendu ensuite ; aucun commit, aucune branche.
    const argv = world.log().find(e => e.kind === "argv");
    assert.match(String(argv?.cwd), /_audit-/);
    assert.ok(!fs.existsSync(String(argv?.cwd)));
    assert.equal(git(world.repo, "branch", "--list", "harness/*"), "");
    const prompt = world.log().find(e => e.kind === "prompt" && e.step === "audit");
    assert.match(String(prompt?.message), /LECTURE SEULE/);
    await assert.rejects(world.orchestrator.audits.launch(audit.id, [5]), /index de propositions/);
    const { projectId } = await world.orchestrator.audits.launch(audit.id, [1]);
    await assert.rejects(world.orchestrator.audits.launch(audit.id, [0]), /pas de propositions à lancer/);
    const runs = world.store.listRuns({ projectId });
    assert.deepEqual(runs.map(run => [run.title, run.modules]), [["Index du schéma", ["src/db"]]]);
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
    await waitFor(() => world.store.getAudit(silent.id)?.state === "failed", () => JSON.stringify(world.store.getAudit(silent.id)));
    assert.match(world.store.getAudit(silent.id)?.reason ?? "", /audit_propose/);
    assert.equal(world.log().filter(e => e.kind === "prompt" && e.step === "audit").length, 2);
  } finally {
    await world.orchestrator.stop();
  }
  const slow = fakeWorld({ audit: [[{ sleep: 60_000 }]] });
  await slow.orchestrator.start();
  try {
    const audit = slow.orchestrator.audits.create("demo", "");
    await waitFor(() => slow.store.getAudit(audit.id)?.state === "analysing" && slow.log().some(e => e.kind === "prompt"), () => JSON.stringify(slow.store.getAudit(audit.id)));
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
    assert.throws(() => world.orchestrator.createRun({ repo: "demo", title: "Sans section", request: "x", req: "des besoins" }), /## Besoins/);
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export clarifié", request: "Exporter", req: "## Besoins\nB-1 : exporter en CSV\n" });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.deepEqual(world.store.listSteps(run.id).map(step => step.kind), ["specs", "impl", "review"]);
    assert.ok(world.oracle.retained.some(m => /Compte rendu de besoins — « Export clarifié »/.test(m.text)));
    // Le runner de /specs a trouvé req.md dans son worktree.
    assert.equal(world.store.getArtifact(run.id, "req.md"), "## Besoins\nB-1 : exporter en CSV\n");
  } finally {
    await world.orchestrator.stop();
  }
});
