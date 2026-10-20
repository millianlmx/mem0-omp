// Feature harness-safefs : les artefacts `.harness/` d'un worktree se lisent et
// s'écrivent sans jamais suivre un lien posé par un runner.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureArtifactsDir, readArtifact, writeArtifact } from "../../omp-harness/safefs.ts";
import { tmpdir } from "../support/repo.ts";

test("harness-safefs/AC-1 : un artefact qui est un lien (vers le jeton du service) n'est jamais lu", () => {
  const worktree = tmpdir("harness-safefs-");
  const secret = path.join(tmpdir("harness-secret-"), "token");
  fs.writeFileSync(secret, "jeton-du-service");
  const dir = ensureArtifactsDir(worktree, ".harness");
  fs.symlinkSync(secret, path.join(dir, "vol.md"));
  fs.writeFileSync(path.join(dir, "req.md"), "## Besoins");
  assert.equal(readArtifact(dir, "vol.md"), null);
  assert.equal(readArtifact(dir, "req.md"), "## Besoins");
  fs.mkdirSync(path.join(dir, "dossier.md"));
  assert.equal(readArtifact(dir, "dossier.md"), null);
});

test("harness-safefs/AC-2 : écrire un artefact remplace un lien au lieu d'écrire à travers lui", () => {
  const worktree = tmpdir("harness-safefs-");
  const victim = path.join(tmpdir("harness-victim-"), "config");
  fs.writeFileSync(victim, "intact");
  const dir = ensureArtifactsDir(worktree, ".harness");
  fs.symlinkSync(victim, path.join(dir, "specs.md"));
  writeArtifact(dir, "specs.md", "## Spécifications");
  assert.equal(fs.readFileSync(victim, "utf8"), "intact");
  assert.equal(fs.lstatSync(path.join(dir, "specs.md")).isFile(), true);
});

test("harness-safefs/AC-3 : un dossier `.harness` remplacé par un lien est recréé en vrai dossier, la cible intacte", () => {
  const worktree = tmpdir("harness-safefs-");
  const elsewhere = tmpdir("harness-elsewhere-");
  fs.symlinkSync(elsewhere, path.join(worktree, ".harness"));
  const dir = ensureArtifactsDir(worktree, ".harness");
  assert.equal(fs.lstatSync(dir).isDirectory(), true);
  writeArtifact(dir, "req.md", "x");
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
