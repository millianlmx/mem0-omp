// Feature rouge-de-base : un échec de la suite complète ne bloque que s'il est nouveau par rapport à main,
// mesuré dans le même slot heavy ; la base de main est calculée une fois par arbre.
//
// La « suite complète » du faux monde est un script shell : un `not ok` par fichier de `fails/`, code 1 s'il y
// en a, et une ligne dans un journal par lancement (son répertoire dit si c'est la base de main ou un run).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Baseline } from "../../omp-harness/baseline.ts";
import type { HeavyResult } from "../../omp-harness/heavy.ts";
import type { RunRow } from "../../omp-harness/db.ts";
import { tapTally } from "../../omp-harness/tap.ts";
import { OK, commitOnMain, fakeWorld, git, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

type Baselined = { failing: number; preexisting: number; new: number; newTests: string[] };

/** La suite complète du faux monde ; `crash` (un fichier de main) la fait planter sans TAP dans la base de main. */
function fullSuite(log: string): string {
  return [
    `echo "$PWD" >> '${log}'`,
    `case "$PWD" in *_baseline-*) [ -e crash ] && exit 3;; esac`,
    `r=0; for f in $(ls fails 2>/dev/null); do echo "not ok 1 - $f"; r=1; done`,
    `echo "ok 2 - le reste"; exit $r`,
  ].join("; ");
}

function launches(log: string, where: "base" | "run"): number {
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "" && line.includes("_baseline-") === (where === "base")).length;
}

function world(repo: string, log: string, scenario: Record<string, unknown> = {}): FakeWorld {
  return fakeWorld(scenario, {
    repo,
    patch: (config) => {
      config.repos[0]!.tests.full = fullSuite(log);
    },
  });
}

function newLog(): string {
  const log = path.join(tmpdir("rouge-de-base-"), "launches.log");
  fs.writeFileSync(log, "");
  return log;
}

/** Un run en `merging` : une branche avec un commit (et `extra`, fichiers de plus) au-dessus de main. */
async function mergingRun(w: FakeWorld, slug: string, extra: Record<string, string> = {}): Promise<RunRow> {
  const main = git(w.repo, "rev-parse", "main");
  const worktree = path.join(w.config.worktreesDir, slug);
  await w.deps.git.addWorktree(w.repo, worktree, `harness/${slug}`, main);
  fs.writeFileSync(path.join(worktree, "src", "api", `${slug}.ts`), `// ${slug}\n`);
  for (const [file, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    fs.writeFileSync(path.join(worktree, file), content);
  }
  await w.deps.git.commitAll(worktree, `feat: ${slug}`);
  w.store.createRun({
    id: `r-${slug}`,
    repo: "demo",
    slug,
    title: `Feature ${slug}`,
    request: `faire ${slug}`,
    branch: `harness/${slug}`,
    state: "merging",
    step: "review",
  });
  return w.store.updateRun(`r-${slug}`, {
    worktree,
    baseSha: main,
    verdict: {
      risk: "low",
      summary: "ok",
      blockers: [],
      risks: [],
      files: [`src/api/${slug}.ts`],
      unverified: [],
      criteria: [],
      confidence: "strong",
    },
  });
}

async function leftMerging(w: FakeWorld, runId: string): Promise<RunRow> {
  await waitFor(
    () => w.store.getRun(runId)?.state !== "merging",
    () => String(w.store.getRun(runId)?.state),
  );
  return w.store.getRun(runId) as RunRow;
}

/** Le scénario d'un run complet ; `fails` : les fichiers de `fails/` que /impl ajoute. */
function scenario(fails: string[] = []): Record<string, unknown> {
  return {
    req: [OK.req],
    specs: [OK.specs],
    impl: [[...fails.map((name) => ({ write: `fails/${name}`, content: "x\n" })), ...OK.impl]],
    review: [OK.review],
  };
}

async function verdictOf(w: FakeWorld, runId: string): Promise<NonNullable<RunRow["verdict"]>> {
  await waitFor(
    () => w.store.getRun(runId)?.verdict != null,
    () => {
      const run = w.store.getRun(runId);
      const steps = w.store.listSteps(runId).map((step) => `${step.kind}:${step.status}`);
      return `${run?.state}/${run?.step} — ${run?.reason} — ${steps.join(",")}`;
    },
    40_000,
  );
  return w.store.getRun(runId)?.verdict as NonNullable<RunRow["verdict"]>;
}

function baselineOf(w: FakeWorld, runId: string): Baselined | null {
  return w.orchestrator.timeline(runId).baseline as Baselined | null;
}

/** Un résultat `full` rouge tel que le heavy le rend : les `not ok` de toute la sortie. */
function red(...titles: string[]): HeavyResult {
  return {
    outcome: "fail",
    exitCode: 1,
    output: titles.map((title) => `not ok 1 - ${title}`).join("\n"),
    durationMs: 1,
    attempts: 1,
    cached: false,
    skipped: false,
    note: null,
    tree: "t",
    key: "k",
    command: "full",
    tap: tapTally(titles.map((title, i) => `not ok ${i + 1} - ${title}\n`).join("")),
  };
}

function baselineOn(w: FakeWorld): Baseline {
  return new Baseline({
    config: () => w.config,
    store: w.store,
    git: w.deps.git,
    heavy: w.deps.heavy,
    event: () => {},
  });
}

function seedRun(w: FakeWorld, id: string): { id: string } {
  w.store.createRun({
    id,
    repo: "demo",
    slug: id,
    title: id,
    request: id,
    branch: `harness/${id}`,
    state: "queued",
    step: "review",
  });
  return { id };
}

test("rouge-de-base/AC-1 : full rouge avec les mêmes échecs que main → pas de bloquant « suite complète rouge », le run est mergé, la frise dit 1 préexistant", async () => {
  const repo = harnessRepo();
  commitOnMain(repo, "fails/pre-a", "x\n");
  const log = newLog();
  const w = world(repo, log, scenario());
  await w.orchestrator.start();
  try {
    const run = await w.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => ["merged", "failed", "awaiting_human"].includes(w.store.getRun(run.id)?.state ?? ""),
      () => `${w.store.getRun(run.id)?.state} — ${w.store.getRun(run.id)?.reason}`,
      60_000,
    );
    const done = w.store.getRun(run.id);
    assert.equal(done?.state, "merged", done?.reason ?? "");
    assert.deepEqual(
      (done?.verdict?.blockers ?? []).filter((blocker) => /suite complète rouge/.test(blocker)),
      [],
    );
    assert.match(done?.verdict?.summary ?? "", /1 échec\(s\) préexistant\(s\), aucun nouveau/);
    const baseline = baselineOf(w, run.id);
    assert.deepEqual([baseline?.failing, baseline?.preexisting, baseline?.new], [1, 1, 0]);
    assert.equal(launches(log, "base"), 1, "main a été mesuré une fois");
  } finally {
    await w.orchestrator.stop();
  }
});

test("rouge-de-base/merger : la suite rejouée après rebase, rouge des seuls échecs de main, ne stoppe pas le merge", async () => {
  const repo = harnessRepo();
  const log = newLog();
  const w = world(repo, log);
  const run = await mergingRun(w, "meme-rouge");
  // main avance avec un test déjà rouge : la branche rebasée le porte aussi.
  commitOnMain(repo, "fails/pre-a", "x\n");
  await w.orchestrator.start();
  try {
    const done = await leftMerging(w, run.id);
    assert.equal(done.state, "merged", done.reason ?? "");
    assert.ok(launches(log, "run") >= 1, "la suite a été rejouée sur la branche rebasée");
    assert.equal(launches(log, "base"), 1);
    assert.deepEqual(baselineOf(w, run.id)?.new, 0);
  } finally {
    await w.orchestrator.stop();
  }
});

test("rouge-de-base/AC-2 : full rouge avec un échec nouveau → le bloquant ne nomme que le nouvel échec", async () => {
  const repo = harnessRepo();
  commitOnMain(repo, "fails/pre-a", "x\n");
  const log = newLog();
  const w = world(repo, log, scenario(["new-b"]));
  await w.orchestrator.start();
  try {
    const run = await w.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    const verdict = await verdictOf(w, run.id);
    const blockers = verdict.blockers.filter((blocker) => /suite complète rouge/.test(blocker));
    assert.equal(blockers.length, 1, verdict.blockers.join(" | "));
    assert.match(blockers[0] as string, /new-b/);
    assert.doesNotMatch(blockers[0] as string, /pre-a/);
    assert.match(blockers[0] as string, /1 échec\(s\) nouveau\(x\).*1 préexistant\(s\)/);
    const baseline = baselineOf(w, run.id);
    assert.deepEqual([baseline?.failing, baseline?.preexisting, baseline?.new], [2, 1, 1]);
    assert.deepEqual(baseline?.newTests, ["new-b"]);
  } finally {
    await w.orchestrator.stop();
  }
});

test("rouge-de-base/merger : un échec nouveau après rebase renvoie en /impl --fix avec le seul nouvel échec", async () => {
  const repo = harnessRepo();
  const log = newLog();
  const w = world(repo, log);
  const run = await mergingRun(w, "nouveau-rouge", { "fails/new-b": "x\n" });
  commitOnMain(repo, "fails/pre-a", "x\n");
  await w.orchestrator.start();
  try {
    const done = await leftMerging(w, run.id);
    assert.equal(done.state, "queued", done.reason ?? "");
    assert.equal(done.step, "fix");
    const blocker = done.verdict?.blockers[0] ?? "";
    assert.match(blocker, /suite complète rouge après rebase sur main/);
    assert.match(blocker, /new-b/);
    assert.doesNotMatch(blocker, /pre-a/);
  } finally {
    await w.orchestrator.stop();
  }
});

test("rouge-de-base/disparu : un échec de main qui disparaît dans la branche n'est jamais une erreur", async () => {
  const repo = harnessRepo();
  commitOnMain(repo, "fails/pre-a", "x\n");
  commitOnMain(repo, "fails/pre-c", "x\n");
  const w = world(repo, newLog());
  const judged = await baselineOn(w).judge(seedRun(w, "r-disparu"), w.deps.config.repos[0]!, red("pre-a"));
  assert.deepEqual(judged, { failing: ["pre-a"], preexisting: ["pre-a"], new: [] });
});

test("rouge-de-base/AC-3 : la base est calculée une fois par arbre de main — deux runs, un seul lancement sur main, le worktree de base est rendu", async () => {
  const repo = harnessRepo();
  commitOnMain(repo, "fails/pre-a", "x\n");
  const log = newLog();
  const w = world(repo, log);
  const baseline = baselineOn(w);
  const config = w.deps.config.repos[0]!;
  const one = seedRun(w, "r-un");
  const two = seedRun(w, "r-deux");
  // Deux appels simultanés partagent le calcul ; un troisième, plus tard, relit le cache.
  const [first, second] = await Promise.all([
    baseline.judge(one, config, red("pre-a")),
    baseline.judge(two, config, red("pre-a")),
  ]);
  const later = await baselineOn(w).judge(two, config, red("pre-a", "autre"));
  assert.deepEqual(first?.preexisting, ["pre-a"]);
  assert.deepEqual(second?.preexisting, ["pre-a"]);
  assert.deepEqual(later?.new, ["autre"]);
  assert.equal(launches(log, "base"), 1);
  const dir = path.join(w.config.worktreesDir, "demo");
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith("_baseline-")) : [], []);
  // main avance : un autre arbre, un autre calcul.
  commitOnMain(repo, "fails/pre-d", "x\n");
  const moved = await baseline.judge(one, config, red("pre-a", "pre-d"));
  assert.deepEqual(moved?.new, []);
  assert.equal(launches(log, "base"), 2);
});

test("rouge-de-base/base-illisible : suite de main plantée sans TAP → pas de base, jamais un vert par défaut", async () => {
  const repo = harnessRepo();
  commitOnMain(repo, "fails/pre-a", "x\n");
  commitOnMain(repo, "crash", "x\n");
  const w = world(repo, newLog());
  assert.equal(await baselineOn(w).judge(seedRun(w, "r-illisible"), w.deps.config.repos[0]!, red("pre-a")), null);
  const dir = path.join(w.config.worktreesDir, "demo");
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith("_baseline-")) : [], []);
});

test("rouge-de-base/AC-4 : base illisible → le bloquant garde le comportement actuel, rouge", async () => {
  const repo = harnessRepo();
  commitOnMain(repo, "fails/pre-a", "x\n");
  commitOnMain(repo, "crash", "x\n");
  const log = newLog();
  const w = world(repo, log, scenario(["new-b"]));
  await w.orchestrator.start();
  try {
    const run = await w.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    const verdict = await verdictOf(w, run.id);
    const blockers = verdict.blockers.filter((blocker) => /suite complète rouge/.test(blocker));
    assert.equal(blockers.length, 1, verdict.blockers.join(" | "));
    assert.match(blockers[0] as string, /^suite complète rouge : fail, code 1 — /);
    assert.doesNotMatch(blockers[0] as string, /préexistant/);
    assert.equal(baselineOf(w, run.id), null);
  } finally {
    await w.orchestrator.stop();
  }
});

test("rouge-de-base/main-vert : un dépôt dont main est vert ne produit pas de base — le rouge reste rouge", async () => {
  const repo = harnessRepo();
  const w = world(repo, newLog());
  assert.equal(await baselineOn(w).judge(seedRun(w, "r-vert"), w.deps.config.repos[0]!, red("new-b")), null);
});

test("rouge-de-base/AC-5 : un dépôt dont main est vert garde le comportement actuel — rouge dès le premier échec, message d'origine", async () => {
  const repo = harnessRepo();
  const log = newLog();
  const w = world(repo, log, scenario(["new-b"]));
  await w.orchestrator.start();
  try {
    const run = await w.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    const verdict = await verdictOf(w, run.id);
    const blockers = verdict.blockers.filter((blocker) => /suite complète rouge/.test(blocker));
    assert.equal(blockers.length, 1, verdict.blockers.join(" | "));
    assert.match(blockers[0] as string, /^suite complète rouge : fail, code 1 — .*new-b/);
    assert.equal(baselineOf(w, run.id), null);
  } finally {
    await w.orchestrator.stop();
  }
});
