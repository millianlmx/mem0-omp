// Feature file-de-merge : un dépôt en `merge: "gh"` dont la forge a sa file de merge (`mergeQueue: true` — merge
// queue de GitHub, merge train de GitLab) ne fait plus attendre ses merges l'un derrière l'autre. Le harness
// prépare chaque PR à son tour (rebase, poussée, auto-merge), puis suit sa fusion à part : la PR suivante part
// pendant que la forge teste la précédente. Sans file de la forge, rien ne change : une PR à la fois.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateConfig } from "../../omp-harness/config.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import type { RunRow } from "../../omp-harness/db.ts";
import { fakeWorld, git, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

function bareRemote(repo: string): void {
  const bare = path.join(tmpdir("harness-remote-"), "origin.git");
  git(path.dirname(bare), "clone", "-q", "--bare", repo, bare);
  git(repo, "remote", "add", "origin", bare);
}

/** Un run arrivé en `merging` : une branche avec un commit au-dessus de main, un verdict. */
async function mergingRun(world: FakeWorld, slug: string): Promise<RunRow> {
  const main = git(world.repo, "rev-parse", "main");
  const worktree = path.join(world.config.worktreesDir, slug);
  await world.deps.git.addWorktree(world.repo, worktree, `harness/${slug}`, main);
  fs.writeFileSync(path.join(worktree, "src", "api", `${slug}.ts`), `// ${slug}\n`);
  await world.deps.git.commitAll(worktree, `feat: ${slug}`);
  world.store.createRun({
    id: `r-${slug}`,
    repo: "demo",
    slug,
    title: `Feature ${slug}`,
    request: `faire ${slug}`,
    branch: `harness/${slug}`,
    state: "merging",
    step: "review",
  });
  return world.store.updateRun(`r-${slug}`, {
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

/**
 * Un faux `gh` : `pr merge --auto` note la PR dans la file ; `pr view` la dit ouverte tant que `release()` n'a pas
 * été appelé, puis fusionnée (le squash posé sur `main` du distant, dans l'ordre de la file).
 */
function queuedGh(repo: string): { exec: Exec; queued: string[]; views: () => number; release: () => void } {
  const queued: string[] = [];
  let views = 0;
  const merged = new Set<string>();
  let released = false;
  const done = (stdout: string): Promise<ProcResult> =>
    Promise.resolve({ code: 0, signal: null, stdout, stderr: "", timedOut: false, aborted: false });
  const exec: Exec = (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    const branch = String(args[2] ?? "");
    if (args[1] === "create") return done(`https://github.com/x/y/pull/${queued.length + 7}\n`);
    if (args[1] === "merge") {
      queued.push(branch);
      return done("");
    }
    views += 1;
    if (released && queued.includes(branch) && !merged.has(branch)) {
      const main = git(repo, "rev-parse", "origin/main");
      const tree = git(repo, "rev-parse", `${branch}^{tree}`);
      const sha = git(repo, "commit-tree", tree, "-p", main, "-m", branch);
      git(repo, "push", "-q", "origin", `${sha}:refs/heads/main`);
      git(repo, "fetch", "-q", "origin");
      merged.add(branch);
    }
    const state = merged.has(branch) ? "MERGED" : "OPEN";
    return done(JSON.stringify({ state, mergedAt: state === "MERGED" ? "2026-11-16T20:00:00Z" : null }));
  };
  return { exec, queued, views: () => views, release: () => (released = true) };
}

function gitHubWorld(mergeQueue: boolean): { world: FakeWorld; gh: ReturnType<typeof queuedGh> } {
  const repo = harnessRepo();
  bareRemote(repo);
  git(repo, "fetch", "-q", "origin");
  const gh = queuedGh(repo);
  const world = fakeWorld(
    {},
    {
      repo,
      exec: gh.exec,
      patch: (config) => {
        const target = config.repos[0];
        if (!target) return;
        target.merge = "gh";
        target.remote = "origin";
        target.mergeQueue = mergeQueue;
        config.review.mergePollSec = 0.02;
      },
    },
  );
  return { world, gh };
}

test("file-de-merge/AC-1 : avec la file de merge de la forge, la PR suivante part pendant que la précédente attend sa fusion ; les deux finissent mergées", async () => {
  const { world, gh } = gitHubWorld(true);
  await world.orchestrator.start();
  try {
    const first = await mergingRun(world, "un");
    const second = await mergingRun(world, "deux");
    await waitFor(
      () => gh.queued.length === 2,
      () =>
        `file de la forge : ${gh.queued.join(", ")} — ${world.store.getRun(second.id)?.state} ${world.store.getRun(second.id)?.reason} ${JSON.stringify(world.store.eventsSince(0, second.id).map((e) => e.type))}`,
    );
    // Les deux PR sont dans la file de la forge avant qu'aucune ne soit fusionnée.
    assert.deepEqual([...gh.queued].sort(), ["harness/deux", "harness/un"]);
    assert.equal(world.store.getRun(first.id)?.state, "merging");
    assert.equal(world.store.getRun(second.id)?.state, "merging");
    gh.release();
    await waitFor(
      () => [first, second].every((run) => world.store.getRun(run.id)?.state === "merged"),
      () => [first, second].map((run) => `${run.id} : ${world.store.getRun(run.id)?.state}`).join(" | "),
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("file-de-merge/AC-2 : sans file de merge de la forge, une seule PR à la fois — la suivante attend la fusion de la précédente", async () => {
  const { world, gh } = gitHubWorld(false);
  await world.orchestrator.start();
  try {
    await mergingRun(world, "un");
    await mergingRun(world, "deux");
    await waitFor(
      () => gh.queued.length >= 1,
      () => `file : ${gh.queued.join(", ")}`,
    );
    // Laissée ouverte, la première PR retient la seconde : relue plusieurs fois, toujours seule dans la file.
    await waitFor(
      () => gh.views() >= 10,
      () => `relectures : ${gh.views()}`,
    );
    assert.equal(gh.queued.length, 1);
    gh.release();
    await waitFor(
      () => gh.queued.length === 2,
      () => `file : ${gh.queued.join(", ")}`,
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test('file-de-merge/AC-3 : `mergeQueue` est un booléen et ne vaut qu\'en `merge: "gh"`', () => {
  const { world } = gitHubWorld(true);
  validateConfig(world.config);
  const target = world.config.repos[0];
  assert.ok(target);
  target.merge = "local";
  assert.throws(() => validateConfig(world.config), /mergeQueue : la file de merge de la forge demande/);
  Object.assign(target, { merge: "gh", mergeQueue: "oui" });
  assert.throws(() => validateConfig(world.config), /mergeQueue : booléen/);
});
