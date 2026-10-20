// La porte de l'intégration continue GitHub du Swift conduit par le VPS (S-9 ; B-9, AC-14, AC-15).
//
// Tout est exercé sur le VRAI `createLotController` en machine `vps`, sur un dépôt git
// jetable avec un VRAI worktree. Les coutures réseau sont les doublures du pilote :
// `runGh` (gh factice : `repo view`, `api …/check-runs`, `pr create`) et deux runners git
// qui délèguent au vrai git SAUF `push`, qu'ils enregistrent (le push de la branche de
// travail passe par `runGitNet`, celui de la livraison par `runGit`).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  createLotController,
  lotRepoKey,
  readLot,
  type LotController,
  type LotFeature,
  type LotRunnerResult,
  type LotRunSpec,
} from "../../omp-mem0-req/extension.ts";
import { CI_DELIVERY_REFUSAL, ciBlockersLine } from "../../omp-mem0-req/ciGate.ts";
import { emptyGitRepo, GIT_ENV } from "../support/git.ts";
import { tmpdir } from "../support/repo.ts";
import { seedLot, writeContract } from "../support/req-fixtures.ts";

const AT = 1_700_000_000_000;
const SLUG = "alpha";
const BRANCH = `feat/${SLUG}`;
const REPO_URL = "https://github.com/o/r";
const CONTRACT =
  "## Besoins\n\nB-1 : faire.\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given, When, Then.\n\n## Spécifications\n\nS-1 (AC-1) : comportement.\n";
const CLEAN_REVIEW = `${CONTRACT}\n## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n`;

const IN_PROGRESS = JSON.stringify({
  total_count: 1,
  check_runs: [{ name: "check (ubuntu-latest)", status: "in_progress", conclusion: null, html_url: `${REPO_URL}/runs/1` }],
});
const RED = JSON.stringify({
  total_count: 2,
  check_runs: [
    { name: "check (ubuntu-latest)", status: "completed", conclusion: "success", html_url: `${REPO_URL}/runs/1` },
    { name: "macos-tests", status: "completed", conclusion: "failure", html_url: `${REPO_URL}/runs/2` },
  ],
});
const GREEN = JSON.stringify({
  total_count: 2,
  check_runs: [
    { name: "check (ubuntu-latest)", status: "completed", conclusion: "success", html_url: `${REPO_URL}/runs/1` },
    { name: "macos-tests", status: "completed", conclusion: "neutral", html_url: `${REPO_URL}/runs/2` },
  ],
});

function git(cwd: string, ...args: string[]): string {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();
}

/**
 * Le contrôleur d'un VPS : une feature au jalon des specs dans un vrai worktree, un clone
 * jetable de gh/git, et un runner dont l'impl pose `X.swift` et la revue écrit le verdict
 * propre (réécrit à chaque passe : une revue inchangée serait illisible).
 */
function rig(options: { touches: string }) {
  const repoRoot = emptyGitRepo("vps-ci-repo-");
  // `.omp/` n'est jamais suivi : le contrat du worktree n'entre pas dans l'arbre poussé.
  fs.appendFileSync(path.join(repoRoot, ".git", "info", "exclude"), ".omp/\n");
  const base = path.join(tmpdir("vps-ci-base-"), "wt");
  const worktree = path.join(base, SLUG);
  fs.mkdirSync(base, { recursive: true });
  git(repoRoot, "worktree", "add", "-q", "-b", BRANCH, worktree, "main");
  writeContract(worktree, CONTRACT);
  const stateDir = path.join(tmpdir("vps-ci-state-"), "pipeline");
  const feature: LotFeature = {
    slug: SLUG,
    name: `${SLUG} — intention`,
    branch: BRANCH,
    worktree,
    deps: [],
    origin: "panneau",
    state: "waiting",
    phase: "specs",
    waitKind: "specs",
    waitPrompt: null,
    sessionFile: null,
    pendingTexts: [],
    prUrl: null,
    stopReason: null,
    fixes: 0,
    unreadableRuns: 0,
    reviewHash: null,
    lastVerdict: null,
    lastBlockers: 0,
    lastRunSessionFile: null,
    contractHash: null,
    addedAt: AT,
    sinceAt: AT,
    updatedAt: AT,
    endedAt: null,
  };
  seedLot(stateDir, repoRoot, [feature]);

  const runs: LotRunSpec[] = [];
  /** Des gestes du test au lancement d'un run (la CI réagit au rythme du pilote, pas du test). */
  const onRun: Array<(spec: LotRunSpec) => void> = [];
  const pushes: Array<{ via: "work" | "release"; args: string[] }> = [];
  const ghCalls: string[][] = [];
  const clock = { now: AT };
  const reading = { json: IN_PROGRESS };
  // Comme le runner du service : l'environnement du 4e paramètre (index temporaire du commit de travail) est honoré.
  const recordPush = (via: "work" | "release") => async (args: string[], cwd: string, _timeoutMs?: number, env?: Record<string, string>) => {
    if (args[0] === "push") {
      pushes.push({ via, args });
      return { code: 0, stdout: "", stderr: "" };
    }
    const res = spawnSync("git", args, { cwd, env: { ...GIT_ENV, ...env }, encoding: "utf8" });
    return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  };
  const controller: LotController = createLotController({
    stateDir,
    repoRoot,
    run: async ({ spec }: { spec: LotRunSpec }): Promise<LotRunnerResult> => {
      runs.push(spec);
      for (const hook of onRun) hook(spec);
      if (spec.phase === "impl") fs.writeFileSync(path.join(spec.worktree, options.touches), `// impl ${runs.length}\n`);
      if (spec.phase === "review") writeContract(spec.worktree, CLEAN_REVIEW.replace("## Revue\n\n", `## Revue\n\nPérimètre : passe ${runs.length}.\n\n`));
      return { code: 0, killed: false, stdout: "fini.", stderr: "" };
    },
    runGit: recordPush("release"),
    runGitNet: recordPush("work"),
    runGh: async (args: string[]) => {
      ghCalls.push(args);
      if (args[0] === "repo" && args[1] === "view") {
        return { code: 0, stdout: JSON.stringify({ url: REPO_URL, defaultBranchRef: { name: "main" } }), stderr: "" };
      }
      if (args[0] === "api" && String(args[1]).endsWith("/check-runs")) return { code: 0, stdout: reading.json, stderr: "" };
      if (args[0] === "pr" && args[1] === "create") return { code: 0, stdout: `${REPO_URL}/pull/7\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "non simulé" };
    },
    notify: () => {},
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now: () => clock.now,
    schedule: () => () => {},
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
    reviewCap: 3,
    inService: true,
    machine: "vps",
  });
  const current = (): LotFeature => {
    const found = readLot(stateDir, lotRepoKey(repoRoot))?.features.find((f) => f.slug === SLUG);
    assert.ok(found, "la feature doit être dans le lot");
    return found;
  };
  /** Laisse les promesses de la chaîne se résoudre (git est synchrone : des tours de boucle suffisent). */
  const settle = async (times = 40) => {
    for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  /** Une passe du pilote, jusqu'à ce que la feature soit à l'état voulu. */
  const until = async (predicate: (f: LotFeature) => boolean, what: string) => {
    for (let i = 0; i < 400; i++) {
      await settle(5);
      if (predicate(current())) return;
      await controller.tick();
    }
    assert.fail(`${what} : ${JSON.stringify(current())}`);
  };
  /** /impl puis /review propre : la feature attend la porte (ou le jalon de revue). */
  const throughReview = async () => {
    assert.equal(await controller.validate(SLUG), null);
    await until((f) => f.phase === "review" || f.state === "waiting", "fin de l'impl");
    await until((f) => f.state === "waiting" && f.phase === "review", "fin de la revue");
  };
  return { repoRoot, worktree, controller, runs, onRun, pushes, ghCalls, clock, reading, current, settle, until, throughReview };
}

test("vps-ci-gate/AC-14 : un /impl du VPS qui touche du Swift pousse sa branche de travail et la revue n'arrive au jalon qu'au vert de la CI GitHub", async () => {
  const r = rig({ touches: "X.swift" });
  const localBefore = git(r.repoRoot, "rev-parse", BRANCH);
  await r.throughReview();

  // Un seul push de la branche de travail : le commit de travail, fils de HEAD, sur feat/<slug>.
  const work = r.pushes.filter((p) => p.via === "work");
  assert.equal(work.length, 1, JSON.stringify(r.pushes));
  const [verb, force, url, refspec] = work[0]!.args;
  assert.equal(verb, "push");
  assert.equal(force, "--force");
  assert.equal(url, `${REPO_URL}.git`);
  const sha = refspec!.split(":")[0]!;
  assert.equal(refspec, `${sha}:refs/heads/${BRANCH}`);
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(git(r.worktree, "rev-parse", `${sha}^`), localBefore, "le commit de travail est un fils de HEAD");
  assert.equal(git(r.worktree, "log", "-1", "--format=%s", sha), `wip(${SLUG}): /impl 1`);
  assert.deepEqual(git(r.worktree, "ls-tree", "-r", "--name-only", sha).split("\n"), ["X.swift"]);
  // La branche locale et l'index n'ont pas bougé : le fichier reste non suivi.
  assert.equal(git(r.repoRoot, "rev-parse", BRANCH), localBefore);
  assert.equal(git(r.worktree, "diff", "--cached", "--name-only"), "");
  assert.equal(git(r.worktree, "status", "--porcelain"), "?? X.swift");
  assert.equal(r.runs.filter((s) => s.phase === "review").length, 1, "la revue a eu lieu");

  // Revue propre, contrôles en cours : la feature attend la CI, jamais le jalon de revue.
  let alpha = r.current();
  assert.equal(alpha.state, "waiting");
  assert.equal(alpha.waitKind, "ci");
  assert.equal(alpha.ci?.sha, sha);
  assert.equal(alpha.ci?.state, "pending");
  for (let i = 0; i < 3; i++) {
    r.clock.now += 61_000;
    await r.controller.tick();
    await r.settle();
  }
  alpha = r.current();
  assert.equal(alpha.waitKind, "ci", "tant que les contrôles tournent, le jalon de revue n'arrive pas");
  assert.equal(alpha.ci?.state, "pending");
  assert.ok(r.ghCalls.some((c) => c[0] === "api" && c[1] === `repos/{owner}/{repo}/commits/${sha}/check-runs`));

  // Vert : le jalon de revue arrive.
  r.reading.json = GREEN;
  r.clock.now += 61_000;
  await r.until((f) => f.waitKind === "review", "jalon de revue au vert");
  assert.equal(r.current().ci?.state, "green");
  assert.equal(r.pushes.filter((p) => p.via === "work").length, 1, "aucun autre push : l'arbre n'a pas bougé");
});

test("vps-ci-gate/AC-15 : une CI GitHub rouge renvoie la feature en /impl --fix avec son bloquant, et rien ne se livre tant qu'elle n'est pas verte sur l'arbre courant", async () => {
  const r = rig({ touches: "X.swift" });
  await r.throughReview();
  const first = r.current();
  assert.equal(first.waitKind, "ci");
  const sha = first.ci!.sha;

  // Tant que rien n'est vert, la livraison est refusée au motif exact.
  assert.equal(
    CI_DELIVERY_REFUSAL,
    "livraison impossible : l’intégration continue GitHub n’est pas verte sur l’arbre courant",
  );
  assert.equal(await r.controller.accept(SLUG), CI_DELIVERY_REFUSAL);

  // Rouge : retour en /impl --fix, avec la ligne exacte dans le prompt.
  r.reading.json = RED;
  r.clock.now += 61_000;
  // Dès que la correction part, la CI du nouvel arbre est en cours (et non plus rouge).
  r.onRun.push((spec) => {
    if (spec.phase === "impl") r.reading.json = IN_PROGRESS;
  });
  await r.until(() => r.runs.filter((s) => s.phase === "impl").length === 2, "relance en /impl --fix");
  const fix = r.runs.filter((s) => s.phase === "impl")[1]!;
  const line = `Bloquant de l’intégration continue GitHub sur ${sha.slice(0, 7)} : macos-tests (${REPO_URL}/runs/2)`;
  assert.equal(ciBlockersLine(sha, [{ name: "macos-tests", url: `${REPO_URL}/runs/2` }]), line);
  assert.ok(fix.prompt.includes(line), fix.prompt.slice(-400));

  // Le /impl --fix termine, la revue passe ; la CI du nouvel arbre est en cours : toujours refusé.
  await r.until((f) => f.state === "waiting" && f.waitKind === "ci" && f.ci?.sha !== sha, "nouvelle attente de la porte");
  const second = r.current();
  assert.equal(second.ci?.state, "pending");
  assert.equal(await r.controller.accept(SLUG), CI_DELIVERY_REFUSAL);

  // Vert sur l'arbre courant : le jalon arrive et la livraison est acceptée.
  r.reading.json = GREEN;
  r.clock.now += 61_000;
  await r.until((f) => f.waitKind === "review", "jalon de revue au vert");
  assert.equal(r.current().ci?.state, "green");
  assert.equal(await r.controller.accept(SLUG), null);
  await r.until((f) => f.state === "done", "livraison");

  // La livraison remplace la branche de travail de la porte, et elle seule.
  const release = r.pushes.filter((p) => p.via === "release");
  assert.equal(release.length, 1, JSON.stringify(r.pushes));
  assert.ok(
    release[0]!.args.includes(`--force-with-lease=refs/heads/${BRANCH}:${second.ci!.sha}`),
    release[0]!.args.join(" "),
  );
});

test("une feature qui ne touche aucun Swift ne pousse rien et passe directement au jalon de revue", async () => {
  const r = rig({ touches: "notes.md" });
  await r.throughReview();
  assert.equal(r.pushes.length, 0);
  assert.equal(r.current().ci, undefined);
  assert.equal(r.current().waitKind, "review");
});

test("un arbre qui a bougé depuis le dernier push repart avant d'être jugé : la porte couvre l'arbre courant", async () => {
  const r = rig({ touches: "X.swift" });
  await r.throughReview();
  const pushed = r.current().ci!;
  // Le worktree change pendant l'attente (un autre geste de l'utilisateur) : le tour suivant repousse.
  fs.writeFileSync(path.join(r.worktree, "Y.swift"), "// plus tard\n");
  r.clock.now += 61_000;
  await r.until((f) => f.ci?.sha !== pushed.sha, "nouveau commit de travail");
  const after = r.current().ci!;
  assert.notEqual(after.tree, pushed.tree);
  assert.equal(r.pushes.filter((p) => p.via === "work").length, 2);
  assert.equal(after.state, "pending");
});
