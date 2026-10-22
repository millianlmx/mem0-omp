// Feature harness-git : un worktree par run, tree hash du répertoire de travail,
// checkpoints remappés après rebase, merge squash en compare-and-swap.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Git, isNonCode } from "../../omp-harness/git.ts";
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
  assert.equal(await client.diffLines(wt, main, "all"), 2);
  assert.deepEqual(await client.touchedFiles(wt, main), ["a.ts", "b.ts"]);
  await assert.rejects(client.squashMerge(repo, "harness/x", "main", "0".repeat(40), "m"));
  const sha = await client.squashMerge(repo, "harness/x", "main", main, "Feature X");
  assert.equal(git(repo, "rev-parse", "main"), sha);
  assert.equal(git(repo, "rev-parse", "main^"), main, "un seul commit : les WIP sont écrasés");

  const other = path.join(tmpdir("harness-wt-"), "wt2");
  await client.addWorktree(repo, other, "harness/y", main);
  fs.writeFileSync(path.join(other, "c.ts"), "c");
  await client.commitAll(other, "wip");
  await assert.rejects(
    client.squashMerge(repo, "harness/y", "main", git(repo, "rev-parse", "main"), "Y"),
    /pas rebasée/,
  );
});

test("harness-git/AC-6 : un `.git` de worktree repointé par un runner est ignoré — le service passe par le gitdir du clone, sans hook", async () => {
  const repo = harnessRepo();
  const wt = await worktree(repo);
  // Un gitdir piégé : un hook post-commit qui laisse une trace.
  const evil = tmpdir("harness-evil-");
  git(evil, "init", "-q");
  const trace = path.join(tmpdir("harness-trace-"), "pwned");
  fs.writeFileSync(path.join(evil, ".git/hooks/post-commit"), `#!/bin/sh\ntouch ${trace}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(evil, ".git")}\n`);
  // Et un hook dans le vrai clone : forcé à rien lui aussi.
  fs.writeFileSync(path.join(repo, ".git/hooks/post-commit"), `#!/bin/sh\ntouch ${trace}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(wt, "a.ts"), "a");
  const sha = await client.commitAll(wt, "wip");
  assert.equal(git(repo, "rev-parse", "harness/x"), sha, "le commit est sur la vraie branche");
  assert.equal(fs.existsSync(trace), false, "aucun hook n'a tourné");
  assert.throws(() => git(evil, "rev-parse", "HEAD"), "le gitdir piégé n'a rien reçu");
  // Un worktree que le clone ne connaît pas est refusé.
  await assert.rejects(client.trustWorktree(repo, tmpdir("harness-stranger-")), /inconnu du clone/);
});

test("harness-git/AC-7 : le gitdir du clone perd l'écriture de groupe et la garde (core.sharedRepository=0640)", async () => {
  const repo = harnessRepo();
  fs.chmodSync(path.join(repo, ".git/config"), 0o664);
  await client.protectRepo(repo);
  assert.equal(git(repo, "config", "core.sharedRepository"), "0640");
  const writable: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (fs.lstatSync(full).mode & 0o020) writable.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  await worktree(repo, "harness/y");
  walk(path.join(repo, ".git"));
  assert.deepEqual(writable, []);
});

test("harness-git/AC-8 : revertRange défait une plage de commits (checkpoints vides compris) en un commit, et garde le travail d'avant", async () => {
  const repo = harnessRepo();
  const wt = await worktree(repo);
  fs.writeFileSync(path.join(wt, "keep.ts"), "garde\n");
  const before = await client.commitAll(wt, "wip avant");
  const empty = await client.commitAll(wt, checkpointMessage("r1", 1, { question: "q", chosen: "c", rationale: "r" }));
  assert.equal(
    git(wt, "rev-parse", `${empty}^{tree}`),
    git(wt, "rev-parse", `${before}^{tree}`),
    "le checkpoint est vide",
  );
  fs.writeFileSync(path.join(wt, "feature.ts"), "a\n");
  await client.commitAll(wt, "wip 1");
  fs.writeFileSync(path.join(wt, "feature.ts"), "a\nb\n");
  fs.writeFileSync(path.join(wt, "keep.ts"), "garde\nmodifié\n");
  await client.commitAll(wt, "wip 2");
  const result = await client.revertRange(wt, before, "HEAD");
  assert.ok(result.ok, "le revert passe");
  assert.equal(git(wt, "rev-parse", "HEAD"), result.sha);
  assert.match(git(wt, "log", "-1", "--format=%s"), /^revert: [0-9a-f]{7}\.\.[0-9a-f]{7}$/);
  assert.equal(fs.existsSync(path.join(wt, "feature.ts")), false, "les commits de la plage sont défaits");
  assert.equal(fs.readFileSync(path.join(wt, "keep.ts"), "utf8"), "garde\n", "ce qui précède la plage reste");
  assert.equal(git(wt, "rev-parse", "HEAD^{tree}"), git(wt, "rev-parse", `${before}^{tree}`));
  assert.equal(await client.isDirty(wt), false);
  // Une plage sans changement net rend quand même un commit.
  const nothing = await client.revertRange(wt, "HEAD", "HEAD");
  assert.ok(nothing.ok && nothing.sha !== result.sha);
});

test("harness-git/AC-9 : un revert en conflit est abandonné, l'arbre rendu propre à HEAD, et ses fichiers rendus", async () => {
  const repo = harnessRepo();
  const wt = await worktree(repo);
  const base = git(wt, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(wt, "README.md"), "v1\n");
  await client.commitAll(wt, "wip 1");
  fs.writeFileSync(path.join(wt, "README.md"), "v2\n");
  const head = await client.commitAll(wt, "wip 2");
  // Défaire seulement « wip 1 » alors que « wip 2 » a réécrit la même ligne : conflit.
  const result = await client.revertRange(wt, base, `${head}^`);
  assert.deepEqual(result, { ok: false, conflicts: ["README.md"] });
  assert.equal(git(wt, "rev-parse", "HEAD"), head, "HEAD n'a pas bougé");
  assert.equal(fs.readFileSync(path.join(wt, "README.md"), "utf8"), "v2\n", "le worktree est revenu à HEAD");
  assert.equal(await client.isDirty(wt), false);
  assert.notEqual(
    (await client.raw(wt, ["rev-parse", "-q", "--verify", "REVERT_HEAD"])).code,
    0,
    "aucun revert en cours",
  );
});

test("harness-git/AC-10 : diffLines en mode `code` ignore tests, docs, changelog, manifestes et verrous ; `all` compte tout", async () => {
  const repo = harnessRepo();
  const wt = await worktree(repo);
  const main = git(repo, "rev-parse", "main");
  const files: Record<string, string> = {
    "src/x.ts": "1\n2\n",
    "test/x.test.ts": "1\n",
    "src/x.test.ts": "1\n",
    "Sources/Tests/Y.swift": "1\n",
    "docs/new.md": "1\n",
    "CHANGELOG.md": "1\n",
    "package.json": "{}\n",
    "bun.lock": "1\n",
    "Cargo.lock": "1\n",
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
    fs.writeFileSync(path.join(wt, file), content);
  }
  await client.commitAll(wt, "wip");
  assert.equal(await client.diffLines(wt, main, "all"), 10);
  assert.equal(await client.diffLines(wt, main, "code"), 2);
  assert.deepEqual(
    ["test/a.ts", "a/b/Tests/c.ts", "x.test.swift", "README.md", "CHANGELOG", "package.json", "yarn.lock"].map(
      isNonCode,
    ),
    [true, true, true, true, true, true, true],
  );
  assert.deepEqual(["src/test.ts", "testing/a.ts", "src/Tests.ts", "package-lock.json"].map(isNonCode), [
    false,
    false,
    false,
    false,
  ]);
});
