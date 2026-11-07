// Feature commit-conventionnel-sans-vide : le commit squash d'un run porte le message
// Conventional Commits rédigé par la revue (`review_verdict.commit`), pas son récit, et
// une branche que le rebase a vidée se termine mergée sans commit vide sur main.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunRow } from "../../omp-harness/db.ts";
import { hostToolsFor } from "../../omp-harness/runner.ts";
import type { Verdict } from "../../omp-harness/verdict.ts";
import { parseVerdict } from "../../omp-harness/verdict.ts";
import { OK, commitOnMain, fakeWorld, git, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";

const SUMMARY = "J'ai relu tout le diff, critère par critère.";

const VERDICT: Verdict = {
  risk: "low",
  summary: SUMMARY,
  blockers: [],
  risks: [],
  files: ["src/api/x.ts"],
  unverified: [],
  criteria: [],
  confidence: "strong",
};

/** Un run en `merging` : une branche qui ajoute `file` au-dessus de main, et un verdict. */
async function mergingRun(world: FakeWorld, slug: string, file: string, verdict: Verdict): Promise<RunRow> {
  const main = git(world.repo, "rev-parse", "main");
  const worktree = path.join(world.config.worktreesDir, slug);
  await world.deps.git.addWorktree(world.repo, worktree, `harness/${slug}`, main);
  fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  fs.writeFileSync(path.join(worktree, file), `// ${slug}\n`);
  await world.deps.git.commitAll(worktree, `feat: ${slug}`);
  world.store.createRun({
    id: `r-${slug}`,
    repo: "demo",
    slug,
    title: `Personnes : ${slug}`,
    request: `faire ${slug}`,
    branch: `harness/${slug}`,
    state: "merging",
    step: "review",
  });
  return world.store.updateRun(`r-${slug}`, { worktree, baseSha: main, verdict });
}

async function settled(world: FakeWorld, runId: string): Promise<RunRow | null> {
  await waitFor(
    () => world.store.getRun(runId)?.state !== "merging",
    () => `${world.store.getRun(runId)?.state} — ${world.store.getRun(runId)?.reason}`,
  );
  return world.store.getRun(runId);
}

test("commit-conventionnel-sans-vide/AC-1 : le commit squash prend le sujet et le corps du verdict, puis les décisions et Harness-Run — jamais le résumé de la revue", async () => {
  const commit = {
    subject: "feat(timeline): regrouper les photos par jour",
    body: "La timeline regroupe les photos par jour de prise de vue,\npour retrouver une sortie d'un coup d'œil.",
  };
  const review = OK.review.map((step) =>
    step.tool === "review_verdict" ? { ...step, args: { ...step.args, summary: SUMMARY, commit } } : step,
  );
  const decide = {
    tool: "decision",
    args: {
      question: "Séparateur CSV ?",
      context: "La feature exporte en CSV ; le séparateur n'est fixé nulle part.",
      options: ["virgule", "point-virgule"],
      chosen: "virgule",
      rationale: "le plus réversible",
      category: "reversible",
      dependsOn: [],
    },
  };
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [[decide, ...OK.impl]], review: [review] });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Timeline par jour", request: "Grouper par jour" });
    await waitFor(
      () => ["merged", "failed", "awaiting_human"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => `${world.store.getRun(run.id)?.state} — ${world.store.getRun(run.id)?.reason}`,
    );
    const done = world.store.getRun(run.id);
    assert.equal(done?.state, "merged", done?.reason ?? "");
    assert.deepEqual(done?.verdict?.commit, commit, "le message est gardé avec le verdict, en base");
    const message = git(world.repo, "log", "-1", "--format=%B", "main");
    const lines = message.split("\n");
    assert.equal(lines[0], commit.subject);
    assert.equal(lines[1], "");
    assert.ok(message.includes(commit.body), message);
    assert.match(message, /\nDécisions :\n- Séparateur CSV \? → virgule/);
    assert.match(message, /\nHarness-Run: /);
    assert.ok(!message.includes(SUMMARY), "le récit de la revue reste hors du commit");
  } finally {
    await world.orchestrator.stop();
  }
});

test("commit-conventionnel-sans-vide/AC-2 : review_verdict refuse un sujet hors Conventional Commits en disant le format, et accepte `fix(people): …`", () => {
  const body = "La recherche de personnes trouve aussi les noms partiels.";
  for (const subject of [
    "Personnes : rechercher par nom",
    "fix(people) rechercher par nom",
    "wip(people): rechercher par nom",
    "fix(people): rechercher\npar nom",
    `fix(people): ${"x".repeat(70)}`,
  ]) {
    const refused = parseVerdict({ ...VERDICT, commit: { subject, body } });
    assert.ok(!refused.ok, subject);
    assert.ok(
      !refused.ok && refused.errors.some((error) => error.startsWith("commit.subject") && /type\(scope\)/.test(error)),
      subject,
    );
  }
  assert.ok(!parseVerdict({ ...VERDICT, commit: undefined }).ok, "le message est obligatoire");
  assert.ok(!parseVerdict({ ...VERDICT, commit: { subject: "fix(people): rechercher par nom", body: " " } }).ok);
  for (const subject of [
    "fix(people): rechercher par nom",
    "docs: décrire la recherche",
    "refactor(harness,console): x",
  ]) {
    const accepted = parseVerdict({ ...VERDICT, commit: { subject, body } });
    assert.ok(accepted.ok, subject);
    assert.deepEqual(accepted.ok && accepted.verdict.commit, { subject, body });
  }
  const tool = hostToolsFor("review").find((candidate) => candidate.name === "review_verdict");
  const required = tool?.parameters.required;
  assert.ok(Array.isArray(required) && required.includes("commit"), "le schéma de l'outil exige `commit`");
});

test("commit-conventionnel-sans-vide/AC-3 : une branche que le rebase sur main a vidée est mergée sans aucun commit — main inchangée, et squashMerge refuse un commit vide", async () => {
  const repo = harnessRepo();
  const world = fakeWorld({}, { repo });
  const run = await mergingRun(world, "deja-livre", "src/api/x.ts", VERDICT);
  // Un autre run a livré le même fichier, puis main a avancé ailleurs : le rebase vide la branche.
  commitOnMain(repo, "src/api/x.ts", "// deja-livre\n");
  const main = commitOnMain(repo, "docs/autre.md", "# autre\n");
  await world.orchestrator.start();
  try {
    const done = await settled(world, run.id);
    assert.equal(done?.state, "merged", done?.reason ?? "");
    assert.equal(git(repo, "rev-parse", "main"), main, "aucun nouveau commit sur main");
    assert.equal(done?.mergeSha, null, "aucun commit de ce run à reverter");
    const events = world.store.eventsSince(0, run.id);
    const merged = events.filter((event) => event.type === "merged");
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.payload.empty, true);
    assert.ok(!events.some((event) => event.type === "heavy_started"), "pas de suite complète sur l'arbre de main");
    // Garde-fou du squash lui-même : une branche dont l'arbre est celui de main ne fait pas de commit.
    git(repo, "branch", "harness/vide", main);
    await assert.rejects(world.deps.git.squashMerge(repo, "harness/vide", "main", main, "fix: rien"), /commit vide/);
    assert.equal(git(repo, "rev-parse", "main"), main);
  } finally {
    await world.orchestrator.stop();
  }
});

test("commit-conventionnel-sans-vide/AC-4 : un verdict rendu avant le champ `commit` merge encore, avec le titre du run pour sujet", async () => {
  const repo = harnessRepo();
  const world = fakeWorld({}, { repo });
  const run = await mergingRun(world, "ancien-verdict", "src/api/ancien.ts", VERDICT);
  assert.equal(run.verdict?.commit, undefined);
  await world.orchestrator.start();
  try {
    const done = await settled(world, run.id);
    assert.equal(done?.state, "merged", done?.reason ?? "");
    assert.equal(git(repo, "rev-parse", "main"), done?.mergeSha);
    assert.equal(git(repo, "log", "-1", "--format=%s", "main"), run.title);
    const message = git(repo, "log", "-1", "--format=%B", "main");
    assert.match(message, /Harness-Run: r-ancien-verdict/);
    assert.ok(!message.includes(SUMMARY));
  } finally {
    await world.orchestrator.stop();
  }
});
