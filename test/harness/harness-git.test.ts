// Feature harness-git : un worktree par run, tree hash du répertoire de travail,
// checkpoints remappés après rebase, merge squash en compare-and-swap.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Git } from "../../omp-harness/git.ts";
import { checkpointMessage } from "../../omp-harness/decisions.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { commitOnMain, git, harnessRepo } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const client = new Git(execProcess, { authorName: "Harness", authorEmail: "h@example.com" });


async function worktree(repo: string, branch = "harness/x"): Promise<string> {
  const dir = path.join(tmpdir("harness-wt-"), "wt");
  await client.addWorktree(repo, dir, branch, git(repo, "rev-parse", "main"));
  return dir;
}


test("harness-git/AC-1 : le worktree d'un run naît sur sa branche, et `.harness/` est exclu de git pour tous les worktrees", async () => {
  const repo = harnessRepo();
  const wt = await worktree(repo);
  assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "harness/x");
  fs.mkdirSync(path.join(wt, ".harness"));
  fs.writeFileSync(path.join(wt, ".harness/specs.md"), "x");
  assert.equal(await client.isDirty(wt), false);
  await client.addWorktree(repo, wt, "harness/x", "main");
});


test("harness-git/AC-2 : le tree hash couvre le non commité et le non suivi, ignore `.harness/`, et ne touche pas l'index", async () => {
  const repo = harnessRepo();
  const wt = await worktree(repo);
  const clean = await client.workingTreeHash(wt);
  assert.equal(clean, git(wt, "rev-parse", "HEAD^{tree}"));
  fs.mkdirSync(path.join(wt, ".harness"));
  fs.writeFileSync(path.join(wt, ".harness/notes.md"), "x");
  assert.equal(await client.workingTreeHash(wt), clean);
  fs.writeFileSync(path.join(wt, "new.ts"), "x");
  const dirty = await client.workingTreeHash(wt);
  assert.notEqual(dirty, clean);
  assert.equal(git(wt, "diff", "--cached", "--name-only"), "", "l'index du worktree est intact");
});


test("harness-git/AC-3 : les checkpoints de décision se retrouvent par leur trailer après un rebase", async () => {
  const repo = harnessRepo();
  const wt = await worktree(repo);
  fs.writeFileSync(path.join(wt, "a.ts"), "a");
  const before = await client.commitAll(wt, checkpointMessage("r1", 1, { question: "q", chosen: "c", rationale: "r" }));
  const moved = commitOnMain(repo, "docs/x.md", "x");
  const rebased = await client.rebase(wt, moved);
  assert.ok(rebased.ok);
  const map = await client.checkpoints(wt, moved, "r1");
  assert.notEqual(map.get(1), before);
  assert.match(git(wt, "log", "-1", "--format=%s", map.get(1) as string), /^decision: q → c/);
});


test("harness-git/AC-4 : un rebase en conflit est abandonné et rend ses fichiers", async () => {
  const repo = harnessRepo();
  const wt = await worktree(repo);
  fs.writeFileSync(path.join(wt, "README.md"), "branche\n");
  await client.commitAll(wt, "wip");
  const moved = commitOnMain(repo, "README.md", "main\n");
  const result = await client.rebase(wt, moved);
  assert.deepEqual(result, { ok: false, conflicts: ["README.md"] });
  assert.equal(fs.readFileSync(path.join(wt, "README.md"), "utf8"), "branche\n", "le worktree est revenu à son état");
});


test("harness-git/AC-5 : le merge squash pose un commit sur main sans checkout, et refuse une branche non rebasée ou un main qui a bougé", async () => {
  const repo = harnessRepo();
  const wt = await worktree(repo);
  const main = git(repo, "rev-parse", "main");
  fs.writeFileSync(path.join(wt, "a.ts"), "a");
  await client.commitAll(wt, "wip 1");
  fs.writeFileSync(path.join(wt, "b.ts"), "b");
  await client.commitAll(wt, "wip 2");
  assert.equal(await client.diffLines(wt, main), 2);
  assert.deepEqual(await client.touchedFiles(wt, main), ["a.ts", "b.ts"]);
  await assert.rejects(client.squashMerge(repo, "harness/x", "main", "0".repeat(40), "m"));
  const sha = await client.squashMerge(repo, "harness/x", "main", main, "Feature X");
  assert.equal(git(repo, "rev-parse", "main"), sha);
  assert.equal(git(repo, "rev-parse", "main^"), main, "un seul commit : les WIP sont écrasés");

  const other = path.join(tmpdir("harness-wt-"), "wt2");
  await client.addWorktree(repo, other, "harness/y", main);
  fs.writeFileSync(path.join(other, "c.ts"), "c");
  await client.commitAll(other, "wip");
  await assert.rejects(client.squashMerge(repo, "harness/y", "main", git(repo, "rev-parse", "main"), "Y"), /pas rebasée/);
});
