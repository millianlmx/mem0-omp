// Feature harness-steps : la conduite des étapes et les outils hôtes — porte des specs,
// découpage, reste d'implémentation, interruption reprise, revue incrémentale, suite
// rouge, décisions déjà tranchées par l'humain, modules posés en cours d'étape.
import test from "node:test";
import assert from "node:assert/strict";
import { OK, fakeWorld, git, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import {
  matchingHumanDecision,
  memoryCategory,
  memoryChoice,
  parseSplitFeatures,
} from "../../omp-harness/host-tools.ts";
import {
  failCauseOf,
  gateNeeded,
  parseRemaining,
  parseSplitSection,
  sectionBody,
  specsCoverageGap,
} from "../../omp-harness/steps.ts";

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

const SPECS_SPLIT =
  "## Spécifications\nS-1 (AC-1) : export CSV\n## Critères d'acceptation\nAC-1 (B-1) : Given des données, When l'export est demandé, Then un CSV est produit\n## Modules\n- src/api\n## Découpage\n- Export JSON — Exporter aussi en JSON — src/api, docs\n- Export XML — Exporter en XML\n";

const SPECS_NO_MODULES = OK.specs[0]?.content?.replace("## Modules\n- src/api\n", "## Modules\n") ?? "";

// -- règles pures -------------------------------------------------------------

test("harness-steps/AC-1 : `## Découpage` se lit puce par puce (titre — demande — modules) ; « aucun » ou absent ⇒ vide", () => {
  assert.deepEqual(parseSplitSection(SPECS_SPLIT), [
    { title: "Export JSON", request: "Exporter aussi en JSON", modules: ["src/api", "docs"] },
    { title: "Export XML", request: "Exporter en XML", modules: [] },
  ]);
  assert.deepEqual(parseSplitSection(OK.specs[0]?.content ?? ""), []);
  assert.deepEqual(parseSplitSection("## Découpage\naucun (diff estimé 120 lignes)\n"), []);
  assert.deepEqual(parseSplitSection("## Modules\n- a\n"), []);
  assert.equal(sectionBody("## A\nx\n## B\ny\n", /^b/i), "y");
  assert.equal(sectionBody("## A\nx\n", /^b/i), null);
});

test("harness-steps/AC-2 : `## Reste` d'impl.md : vide, absent ou « aucun » ⇒ rien à suivre", () => {
  assert.equal(parseRemaining("## Fait\nAC-1\n## Reste\n"), "");
  assert.equal(parseRemaining("## Fait\nAC-1\n"), "");
  assert.equal(parseRemaining("## Fait\nAC-1\n## Reste\naucun\n"), "");
  assert.equal(
    parseRemaining("## Fait\nAC-1\n## Reste\n- la pagination\n- les tests du tri\n"),
    "- la pagination\n- les tests du tri",
  );
});

test("harness-steps/AC-3 : la couverture des specs — chaque B-n a un AC-m (B-n), chaque AC est cité par un S-k (AC-m)", () => {
  const req = OK.req[0]?.content ?? "";
  assert.equal(specsCoverageGap(req, OK.specs[0]?.content ?? ""), null);
  assert.match(
    specsCoverageGap(req.replace("format CSV\n", "format CSV\nB-2 : importer un CSV\n"), OK.specs[0]?.content ?? "") ??
      "",
    /B-2 n'a aucun critère/,
  );
  const orphanAc = (OK.specs[0]?.content ?? "").replace("S-1 (AC-1)", "S-1");
  assert.match(specsCoverageGap(req, orphanAc) ?? "", /AC-1 n'est cité par aucune spécification/);
  assert.match(specsCoverageGap(req, "## Critères d'acceptation\n(rien)\n") ?? "", /aucun critère/);
  // Un run sans req.md (ancien) : seules les règles sur specs.md s'appliquent.
  assert.equal(specsCoverageGap("", OK.specs[0]?.content ?? ""), null);
});

test("harness-steps/AC-4 : gateNeeded — découpage, modules vides, irréversible ou première feature d'un projet ; sinon faux", () => {
  const solo = { projectId: null, projectOrder: 0 };
  const specs = OK.specs[0]?.content ?? "";
  assert.equal(gateNeeded(solo, specs), false);
  assert.equal(gateNeeded(solo, SPECS_SPLIT), true);
  assert.equal(gateNeeded(solo, SPECS_NO_MODULES), true);
  assert.equal(gateNeeded(solo, specs.replace("export CSV", "export CSV après DROP TABLE exports")), true);
  assert.equal(gateNeeded({ projectId: "p1", projectOrder: 0 }, specs), true);
  assert.equal(gateNeeded({ projectId: "p1", projectOrder: 1 }, specs), false);
});

test("harness-steps/AC-5 : la cause d'un prompt manqué — délai, bascule du fournisseur, réseau, contexte, arrêt", () => {
  assert.equal(failCauseOf("aborted", null), "aborted");
  assert.equal(
    failCauseOf("error", { message: "délai d'étape dépassé (1 s) : runner arrêté", retryable: true }),
    "timeout",
  );
  assert.equal(failCauseOf("error", { message: "429", cause: "rate_limit" }), "rate_limit");
  assert.equal(failCauseOf("error", { message: "502", cause: "server_error" }), "provider");
  assert.equal(failCauseOf("error", { message: "ECONNRESET", cause: "network" }), "network");
  assert.equal(failCauseOf("error", { message: "context", cause: "context" }), "context");
  assert.equal(failCauseOf("error", { message: "?", cause: "other" }), "other");
  assert.equal(failCauseOf("error", null), "other");
});

test("harness-steps/AC-6 : un souvenir de décision humaine ne vaut réponse qu'au score ≥ 0,8 et dans la même catégorie", () => {
  const text = "Décision tranchée par l'humain [catégorie : schema] — feature « X » : clé ? → « uuid ». Raison : …";
  const base = { id: "m1", text, tags: ["harness", "decision"], createdAt: "2026-10-20T10:00:00Z" };
  assert.equal(memoryCategory(text), "schema");
  assert.equal(memoryCategory("rien"), null);
  assert.equal(memoryChoice(text), "uuid");
  assert.equal(matchingHumanDecision([{ ...base, score: 0.9 }], "schema")?.id, "m1");
  assert.equal(matchingHumanDecision([{ ...base, score: 0.79 }], "schema"), null);
  assert.equal(matchingHumanDecision([{ ...base, score: 0.9 }], "deletion"), null);
  assert.equal(matchingHumanDecision([{ ...base, score: null }], "schema"), null);
});

test("harness-steps/AC-7 : split_feature valide ses features (titre et demande requis, modules = chemins du dépôt)", () => {
  assert.deepEqual(parseSplitFeatures([{ title: "A", request: "a", modules: ["./src/x/", "src/x"] }]), {
    ok: true,
    features: [{ title: "A", request: "a", modules: ["src/x"] }],
  });
  assert.equal(parseSplitFeatures([]).ok, false);
  assert.equal(parseSplitFeatures([{ title: "A" }]).ok, false);
  assert.equal(parseSplitFeatures([{ title: "A", request: "a", modules: "src" }]).ok, false);
});

// -- conduite d'un run (faux omp RPC) ---------------------------------------------

test("harness-steps/AC-8 : des specs sans `## Modules` sont relancées une fois, puis l'étape échoue (missing_output)", async () => {
  const world = fakeWorld(
    { req: [OK.req], specs: [[{ write: ".harness/specs.md", content: SPECS_NO_MODULES }]] },
    { patch: (config) => (config.runner.stepRetries = 0) },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await until(world, run.id, ["failed", "awaiting_human", "merged"]);
    const nudges = world
      .log()
      .filter((entry) => entry.kind === "prompt" && entry.step === "specs" && entry.nudge === true);
    assert.equal(nudges.length, 1, "une relance");
    assert.match(String(nudges[0]?.message), /`## Modules` de specs\.md est vide/);
    const specsSteps = world.store.listSteps(run.id).filter((step) => step.kind === "specs");
    assert.deepEqual(
      specsSteps.map((step) => step.status),
      ["failed"],
    );
    assert.match(specsSteps[0]?.summary ?? "", /## Modules/);
    assert.equal(world.store.getRun(run.id)?.lastFailCause, "missing_output");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-steps/AC-9 : la porte « auto » — des specs qui découpent attendent l'humain et le découpage part en projet ; des specs nettes passent en /impl", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [[{ write: ".harness/specs.md", content: SPECS_SPLIT }], OK.specs],
      impl: [OK.impl],
      review: [OK.review],
    },
    { patch: (config) => (config.review.specsGate = "auto") },
  );
  await world.orchestrator.start();
  try {
    const split = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await until(world, split.id, ["awaiting_human", "failed", "merged"]);
    assert.equal(world.store.getRun(split.id)?.state, "awaiting_human", stateOf(world, split.id));
    assert.equal(world.store.getRun(split.id)?.step, "specs");
    const event = world.store.eventsSince(0, split.id).find((item) => item.type === "split");
    assert.ok(event, "événement split");
    const projectId = String(event.payload.projectId);
    const project = world.store.getProject(projectId);
    assert.equal(project?.title, "Découpage de « Export CSV »");
    const children = world.store
      .listRuns()
      .filter((run) => run.projectId === projectId)
      .sort((a, b) => a.projectOrder - b.projectOrder);
    assert.deepEqual(
      children.map((run) => [run.title, run.request, run.modules]),
      [
        ["Export JSON", "Exporter aussi en JSON", ["src/api", "docs"]],
        ["Export XML", "Exporter en XML", children[1]?.modules],
      ],
    );
    // Les specs refaites (refus humain) ne recréent pas le projet ; sans découpage, la porte « auto » laisse passer.
    for (const child of children) await world.orchestrator.cancel(child.id, { by: "test" });
    await world.orchestrator.validate(split.id, false, "trop large", { by: "test" });
    await until(world, split.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(split.id)?.state, "merged", stateOf(world, split.id));
    assert.equal(world.store.eventsSince(0, split.id).filter((item) => item.type === "split").length, 1);
    assert.equal(world.store.listProjects().length, 1);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-steps/AC-10 : un `## Reste` non vide dans impl.md ouvre un run de suite, une seule fois", async () => {
  const impl = [
    { write: "src/api/export.ts", content: "export const exportCsv = () => 'a,b';\n" },
    { write: ".harness/impl.md", content: "## Fait\nAC-1 fait\n## Reste\n- la pagination de l'export\n" },
  ];
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [impl], review: [OK.review] });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    const event = world.store.eventsSince(0, run.id).find((item) => item.type === "follow_up");
    assert.ok(event, "événement follow_up");
    const followUp = world.store.getRun(String(event.payload.runId));
    assert.equal(followUp?.title, "Suite de « Export CSV »");
    assert.match(followUp?.request ?? "", /la pagination de l'export/);
    assert.deepEqual(followUp?.modules, ["src/api"]);
    assert.equal(world.store.listRuns().filter((row) => row.title.startsWith("Suite de")).length, 1);
    await world.orchestrator.cancel(followUp?.id ?? "", { by: "test" });
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-steps/AC-11 : une étape interrompue à l'échéance laisse un commit WIP et la tentative suivante reçoit la consigne de reprise", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [[{ write: "src/api/export.ts", content: "// en cours\n" }, { sleep: 60_000 }], [{ sleep: 60_000 }]],
    },
    {
      patch: (config) => {
        config.runner.stepTimeoutSec = 2;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => world.log().filter((entry) => entry.kind === "prompt" && entry.step === "impl").length >= 2,
      () => stateOf(world, run.id),
      30_000,
    );
    const prompts = world.log().filter((entry) => entry.kind === "prompt" && entry.step === "impl");
    const second = String(prompts[1]?.message);
    assert.match(second, /Tentative 1 interrompue à \d{4}-\d{2}-\d{2}T[^ ]+ \(timeout : délai d'étape dépassé/);
    assert.match(second, /repars de `git diff [0-9a-f]{40}` et de `\.harness\/impl\.md`/);
    const worktree = world.store.getRun(run.id)?.worktree ?? "";
    assert.match(git(worktree, "log", "-1", "--format=%s"), /^wip\(impl\): interrompu \(tentative 1\)$/);
    assert.equal(git(worktree, "show", "HEAD:src/api/export.ts"), "// en cours");
    assert.equal(world.store.getRun(run.id)?.lastFailCause, "timeout");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-steps/AC-12 : la seconde revue est incrémentale — elle reçoit le HEAD de la revue précédente et ses bloquants", async () => {
  const blocked = [
    { tool: "run_tests", args: { scope: "full" } },
    {
      tool: "review_verdict",
      args: {
        risk: "low",
        summary: "manque la gestion des guillemets",
        blockers: ["les guillemets ne sont pas échappés"],
        risks: [],
        files: ["src/api/export.ts"],
        unverified: [],
        criteria: [{ id: "AC-1", test: "harness/AC-1", status: "fail" }],
        confidence: "strong",
      },
    },
  ];
  const weak = [
    { tool: "run_tests", args: { scope: "touched" } },
    {
      tool: "review_verdict",
      args: {
        risk: "low",
        summary: "corrigé",
        blockers: [],
        risks: [],
        files: ["src/api/export.ts"],
        unverified: ["AC-1 sous charge"],
        criteria: [{ id: "AC-1", test: "harness/AC-1", status: "pass" }],
        confidence: "weak",
      },
    },
  ];
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [OK.impl],
    review: [blocked, weak],
    fix: [
      [
        { write: "src/api/export.ts", content: "export const exportCsv = () => '\"a\",b';\n" },
        { write: ".harness/fix.md", content: "## Levées\n- guillemets échappés\n" },
      ],
    ],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human", stateOf(world, run.id));
    const reviews = world
      .log()
      .filter((entry) => entry.kind === "prompt" && entry.step === "review" && entry.nudge !== true);
    assert.equal(reviews.length, 2);
    const worktree = world.store.getRun(run.id)?.worktree ?? "";
    // HEAD à la fin de la première revue = le parent du commit de fin de correction.
    const sinceSha = git(worktree, "rev-parse", "HEAD~1");
    assert.doesNotMatch(String(reviews[0]?.message), /INCRÉMENTALE/);
    assert.match(String(reviews[1]?.message), /INCRÉMENTALE/);
    assert.ok(String(reviews[1]?.message).includes(sinceSha), "le sha de la revue précédente est dans le prompt");
    assert.match(String(reviews[1]?.message), /les guillemets ne sont pas échappés/);
    assert.equal(world.store.getRun(run.id)?.lastReviewSha, git(worktree, "rev-parse", "HEAD"));
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-steps/AC-13 : une suite complète rouge devient un bloquant, quoi qu'en dise la revue — le run part en correction", async () => {
  const impl = [
    { write: "src/api/export.ts", content: "export const exportCsv = () => 'a,b';\n" },
    { write: "FAIL_FULL", content: "" },
    { write: ".harness/impl.md", content: "## Fait\nAC-1 fait\n## Reste\n" },
  ];
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [impl],
    review: [OK.review],
    fix: [[{ sleep: 60_000 }]],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () =>
        world.store.getRun(run.id)?.step === "fix" ||
        ["merged", "failed", "awaiting_human"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => stateOf(world, run.id),
      30_000,
    );
    const done = world.store.getRun(run.id);
    assert.equal(done?.step, "fix", stateOf(world, run.id));
    assert.equal(done?.verdict?.blockers.length, 1);
    assert.match(done?.verdict?.blockers[0] ?? "", /^suite complète rouge : fail, code 1/);
    const review = world.store.eventsSince(0, run.id).find((item) => item.type === "review");
    assert.equal(JSON.stringify(review?.payload.merge).includes('"auto":false'), true);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-steps/AC-14 : une décision irréversible déjà tranchée par l'humain (souvenir) devient un checkpoint sans escalade ; sans souvenir, l'escalade porte la recommandation", async () => {
  const decide = (question: string) => ({
    tool: "decision",
    args: {
      question,
      context: "Les exports ont leur propre table ; la clé primaire se choisit avant la première migration.",
      options: ["entier auto-incrémenté", "uuid"],
      impacts: ["clés devinables, tri naturel", "clés opaques, index plus gros"],
      chosen: "entier auto-incrémenté",
      rationale: "plus simple",
      category: "schema",
    },
  });
  const impl = [decide("Quel type pour la clé primaire des exports ?"), ...OK.impl];
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [impl], review: [OK.review] });
  world.oracle.memories = [
    {
      id: "mem-42",
      text: "Décision tranchée par l'humain [catégorie : schema] — feature « Imports » : Quel type pour la clé primaire ? → « uuid ». Raison : fusion multi-sites.",
      score: 0.93,
      tags: ["harness", "decision"],
      createdAt: "2026-10-20T09:00:00Z",
    },
  ];
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await until(world, run.id, ["merged", "failed", "awaiting_human", "escalated"]);
    assert.equal(world.store.listEscalations({ runId: run.id }).length, 0, "aucune escalade");
    const decisions = world.store.listDecisions({ runId: run.id });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.chosen, "uuid");
    assert.equal(decisions[0]?.category, "schema");
    assert.match(decisions[0]?.rationale ?? "", /^tranché par l'humain le 2026-10-20 \(souvenir mem-42\)/);
    assert.ok(decisions[0]?.checkpointSha, "checkpoint posé");
    const tool = world.log().find((entry) => entry.kind === "tool" && entry.tool === "decision");
    assert.match(String(tool?.result), /Continue avec « uuid »/);
  } finally {
    await world.orchestrator.stop();
  }

  const without = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [impl], review: [OK.review] });
  await without.orchestrator.start();
  try {
    const run = await without.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await until(without, run.id, ["escalated", "merged", "failed", "awaiting_human"]);
    const escalations = without.store.listEscalations({ runId: run.id });
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0]?.recommended, "entier auto-incrémenté");
    assert.match(escalations[0]?.context ?? "", /^Les exports ont leur propre table/);
    assert.equal(escalations[0]?.rationale, "plus simple");
    assert.deepEqual(escalations[0]?.impacts, ["clés devinables, tri naturel", "clés opaques, index plus gros"]);
    assert.equal(without.store.listDecisions({ runId: run.id }).length, 0);
  } finally {
    await without.orchestrator.stop();
  }
});

test("harness-steps/AC-15 : une clarification est un checkpoint (jamais une escalade), rangée dans sa catégorie", async () => {
  const impl = [
    {
      tool: "decision",
      args: {
        question: "Séparateur par défaut ?",
        context: "L'export CSV n'a pas de séparateur dans la demande ; Excel français attend un point-virgule.",
        options: ["virgule", "point-virgule"],
        chosen: "virgule",
        rationale: "standard",
        category: "clarification",
      },
    },
    ...OK.impl,
  ];
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [impl], review: [OK.review] });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await until(world, run.id, ["merged", "failed", "awaiting_human", "escalated"]);
    assert.equal(world.store.listEscalations({ runId: run.id }).length, 0);
    const decision = world.store.listDecisions({ runId: run.id })[0];
    assert.equal(decision?.category, "clarification");
    assert.equal(decision?.status, "auto");
    assert.ok(decision?.checkpointSha);
    // Le prompt suivant la présente comme un choix de l'agent, non validé.
    const review = world.log().find((entry) => entry.kind === "prompt" && entry.step === "review");
    assert.match(String(review?.message), /#1 Séparateur par défaut \? → « virgule » \(choix de l'agent, non validé\)/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-steps/AC-16 : set_modules pose les modules du run pendant l'étape ; checkpoint commite l'état courant", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [
      [
        { tool: "set_modules", args: { paths: ["src/db", "./docs/"] } },
        { write: "src/db/notes.txt", content: "brouillon\n" },
        { tool: "checkpoint", args: { message: "schéma esquissé" } },
        { tool: "checkpoint", args: { message: "rien de neuf" } },
        { sleep: 60_000 },
      ],
    ],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => world.log().filter((entry) => entry.kind === "tool" && entry.tool === "checkpoint").length === 2,
      () => stateOf(world, run.id),
    );
    const live = world.store.getRun(run.id);
    assert.equal(live?.state, "running");
    assert.equal(live?.step, "specs");
    assert.deepEqual(live?.modules, ["src/db", "docs"]);
    assert.ok(
      world.store.eventsSince(0, run.id).some((item) => item.type === "modules" && item.payload.by === "runner"),
    );
    const tools = world.log().filter((entry) => entry.kind === "tool" && entry.tool === "checkpoint");
    assert.match(String(tools[0]?.result), /^checkpoint [0-9a-f]{12} posé$/);
    assert.match(String(tools[1]?.result), /^rien à committer : HEAD [0-9a-f]{12}$/);
    const worktree = live?.worktree ?? "";
    assert.equal(git(worktree, "log", "-1", "--format=%s"), "wip(specs): schéma esquissé");
    assert.equal(git(worktree, "show", "HEAD:src/db/notes.txt"), "brouillon");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-steps/AC-17 : run_tests scope:check lance une commande nommée du dépôt ; un nom inconnu est refusé sans rien lancer", async () => {
  const impl = [
    { write: "src/api/export.ts", content: "export const exportCsv = () => 'a,b';\n" },
    { tool: "run_tests", args: { scope: "check", check: "lint" } },
    { tool: "run_tests", args: { scope: "check", check: "format" } },
    { write: ".harness/impl.md", content: "## Fait\nAC-1 fait\n## Reste\n" },
  ];
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: [impl], review: [OK.review] },
    {
      patch: (config) => {
        const repo = config.repos[0];
        if (repo) repo.checks = { lint: "test -f src/api/export.ts" };
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    const tools = world.log().filter((entry) => entry.kind === "tool" && entry.tool === "run_tests");
    assert.match(String(tools[0]?.result), /^VERT/);
    assert.match(String(tools[1]?.result), /check inconnu : « format » \(connus : lint\)/);
    // La suite complète : mise en route par le service à l'entrée en revue, rejointe par le runner (un relevé chacun).
    assert.deepEqual(
      world.store.listTestRuns(run.id).map((item) => `${item.scope}:${item.outcome}`),
      ["check:pass", "full:pass", "full:pass"],
    );
  } finally {
    await world.orchestrator.stop();
  }
});
