// Feature harness-merger : le merge d'un run validé ne dit « merged » que quand main
// l'est vraiment — fusion `gh --auto` constatée, push accepté — et un revert défait le
// squash sur main puis ouvre un run de suite.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execProcess } from "../../omp-harness/proc.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import type { RunRow } from "../../omp-harness/db.ts";
import { fakeWorld, git, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

/** Un distant nu qui porte `main` ; `reject` y pose un hook pre-receive qui refuse tout. */
function bareRemote(repo: string, reject: string | null): string {
  const bare = path.join(tmpdir("harness-remote-"), "origin.git");
  git(path.dirname(bare), "clone", "-q", "--bare", repo, bare);
  if (reject !== null) {
    const hook = path.join(bare, "hooks", "pre-receive");
    fs.writeFileSync(hook, `#!/bin/sh\necho "${reject}" >&2\nexit 1\n`, { mode: 0o755 });
  }
  git(repo, "remote", "add", "origin", bare);
  return bare;
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
      risks: ["aucun test de charge"],
      files: [`src/api/${slug}.ts`],
      unverified: ["le rendu iOS"],
      criteria: [],
      confidence: "strong",
    },
  });
}

/** Un faux `gh` : `pr create` rend une URL, `pr merge --auto` réussit, `pr view` suit `states`. */
function fakeGh(states: () => "OPEN" | "MERGED" | "CLOSED"): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const done = (stdout: string): Promise<ProcResult> =>
    Promise.resolve({ code: 0, signal: null, stdout, stderr: "", timedOut: false, aborted: false });
  const exec: Exec = (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    calls.push(args);
    if (args[1] === "create") return done("https://github.com/x/y/pull/7\n");
    if (args[1] === "merge") return done("");
    const state = states();
    return done(JSON.stringify({ state, mergedAt: state === "MERGED" ? "2026-10-22T20:00:00Z" : null }));
  };
  return { exec, calls };
}

/** Ce que GitHub fait à la fusion : le squash de la branche sur `main` du distant. */
function squashOnRemote(repo: string, branch: string): string {
  const main = git(repo, "rev-parse", "main");
  const tree = git(repo, "rev-parse", `${branch}^{tree}`);
  const sha = git(repo, "commit-tree", tree, "-p", main, "-m", `${branch} (#7)`);
  git(repo, "push", "-q", "origin", `${sha}:refs/heads/main`);
  return sha;
}

test("harness-merger/AC-1 : en mode gh, le merge pose `gh pr merge --squash --auto` puis attend la fusion constatée avant de dire « merged »", async () => {
  const repo = harnessRepo();
  bareRemote(repo, null);
  let views = 0;
  let squash: string | null = null;
  const gh = fakeGh(() => {
    views += 1;
    if (views < 3) return "OPEN";
    squash ??= squashOnRemote(repo, "harness/gh-ok");
    return "MERGED";
  });
  const world = fakeWorld(
    {},
    {
      repo,
      exec: gh.exec,
      patch: (config) => {
        config.repos[0]!.merge = "gh";
        config.repos[0]!.remote = "origin";
        config.review.mergePollSec = 0.02;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await mergingRun(world, "gh-ok");
    await waitFor(
      () => world.store.getRun(run.id)?.state !== "merging",
      () => String(world.store.getRun(run.id)?.state),
    );
    const done = world.store.getRun(run.id);
    assert.equal(done?.state, "merged", done?.reason ?? "");
    assert.equal(done?.mergeSha, squash, "le sha de merge est celui que GitHub a posé");
    assert.equal(done?.prUrl, "https://github.com/x/y/pull/7");
    assert.deepEqual(gh.calls[1], ["pr", "merge", "harness/gh-ok", "--squash", "--auto", "--delete-branch"]);
    assert.ok(views >= 3, "la fusion a été relue jusqu'à être constatée");
    assert.deepEqual(gh.calls[2]?.slice(0, 2), ["pr", "view"]);
    const memory = world.oracle.retained.find((m) => /Feature mergée/.test(m.text));
    assert.match(memory?.text ?? "", /Risques résiduels : aucun test de charge/);
    assert.match(memory?.text ?? "", /Non vérifié par la revue : le rendu iOS/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-merger/AC-2 : une fusion gh non constatée dans `mergeWaitSec` arrête le merge — mergeRetries +1, retour en revue après un délai (notBefore)", async () => {
  const repo = harnessRepo();
  bareRemote(repo, null);
  const gh = fakeGh(() => "OPEN");
  const world = fakeWorld(
    {},
    {
      repo,
      exec: gh.exec,
      patch: (config) => {
        config.repos[0]!.merge = "gh";
        config.repos[0]!.remote = "origin";
        config.review.mergePollSec = 0.02;
        config.review.mergeWaitSec = 0.1;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const before = Date.now();
    const run = await mergingRun(world, "gh-slow");
    await waitFor(
      () => (world.store.getRun(run.id)?.mergeRetries ?? 0) > 0,
      () => String(world.store.getRun(run.id)?.state),
    );
    const stopped = world.store.getRun(run.id);
    assert.equal(stopped?.mergeRetries, 1);
    assert.equal(stopped?.fixes, 0, "un merge arrêté ne compte pas comme une correction");
    assert.equal(stopped?.state, "queued");
    assert.equal(stopped?.step, "review");
    assert.ok((stopped?.notBefore ?? 0) >= before + 5 * 60_000 - 1000, "première relance dans 5 min");
    assert.match(stopped?.reason ?? "", /fusion non constatée/);
    assert.notEqual(stopped?.state, "merged");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-merger/AC-3 : en mode local, un push refusé par le distant n'est jamais « merged » — le run attend l'humain avec la raison du refus", async () => {
  const repo = harnessRepo();
  bareRemote(repo, "GH006: Protected branch update failed for refs/heads/main");
  const world = fakeWorld({}, { repo, patch: (config) => (config.repos[0]!.remote = "origin") });
  await world.orchestrator.start();
  try {
    const run = await mergingRun(world, "push-refused");
    await waitFor(
      () => world.store.getRun(run.id)?.state !== "merging",
      () => String(world.store.getRun(run.id)?.state),
    );
    const waiting = world.store.getRun(run.id);
    assert.equal(waiting?.state, "awaiting_human");
    assert.match(waiting?.reason ?? "", /^push refusé : .*GH006/);
    assert.equal(waiting?.mergeSha, null);
    assert.ok(world.store.eventsSince(0, run.id).some((e) => e.type === "push_failed"));
    assert.ok(!world.store.eventsSince(0, run.id).some((e) => e.type === "merged"));
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-merger/AC-4 : le revert d'un run mergé pose un commit revert sur main, l'événement `reverted`, et ouvre un run de suite ; un run non mergé rend 409", async () => {
  const repo = harnessRepo();
  bareRemote(repo, null);
  const world = fakeWorld({}, { repo, patch: (config) => (config.repos[0]!.remote = "origin") });
  await world.orchestrator.start();
  try {
    const run = await mergingRun(world, "to-revert");
    await waitFor(
      () => world.store.getRun(run.id)?.state === "merged",
      () => String(world.store.getRun(run.id)?.state),
    );
    const mergeSha = world.store.getRun(run.id)?.mergeSha;
    assert.ok(mergeSha);
    const other = world.store.createRun({
      id: "r-open",
      repo: "demo",
      slug: "open",
      title: "Ouverte",
      request: "x",
      branch: "harness/open",
      state: "cancelled",
    });
    await assert.rejects(world.orchestrator.revert(other.id, { by: "millian" }), /n'est pas mergé/);

    const followUp = await world.orchestrator.revert(run.id, { by: "millian" });
    const head = git(repo, "rev-parse", "main");
    assert.equal(git(repo, "rev-parse", "main^"), mergeSha, "le revert est posé juste au-dessus du squash");
    assert.match(git(repo, "log", "-1", "--format=%s", "main"), /^Revert/);
    assert.equal(git(repo, "ls-tree", "--name-only", "main", "src/api/to-revert.ts"), "", "le fichier est défait");
    assert.equal(git(repo, "rev-parse", "origin/main"), head, "le revert est poussé");
    const reverted = world.store.eventsSince(0, run.id).find((e) => e.type === "reverted");
    assert.equal(reverted?.payload.sha, head);
    assert.equal(reverted?.payload.revertedSha, mergeSha);
    assert.equal(reverted?.payload.by, "millian");
    assert.equal(followUp.repo, "demo");
    assert.match(followUp.title, /Reprise après revert — Feature to-revert/);
    assert.match(followUp.request, /revertée/);
    assert.equal(world.store.getRun(run.id)?.state, "merged", "le run d'origine reste mergé dans l'historique");
  } finally {
    await world.orchestrator.stop();
  }
});
