// Preuve de la feature lecteur-de-sessions-omp : aucune transcription de session
// OMP (fichier .jsonl) ne doit être présente dans le dépôt public, ni indexée par
// git ni posée sur le disque. Le parcours récursif est l'invariant fort ; il est
// toujours exécuté, y compris hors worktree git.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Dossiers ignorés au parcours : dépendances, artefacts, stockage, builds. */
function isExcluded(name: string): boolean {
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === ".typecheck" ||
    name === "qdrant_storage" ||
    name === "build" ||
    name.startsWith(".build")
  );
}

/** Chemins des fichiers `.jsonl` trouvés sous `dir`, récursivement. */
function findJsonl(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!isExcluded(entry.name)) found.push(...findJsonl(path.join(dir, entry.name)));
    } else if (entry.name.endsWith(".jsonl")) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

test("lecteur-de-sessions-omp/AC-11 : aucune transcription .jsonl dans le dépôt public", () => {
  // L'assertion git n'a de sens que dans un worktree : certains harnais
  // (test/check.test.ts) recopient l'arbre sans .git puis relancent la suite.
  // Hors worktree, le parcours récursif ci-dessous couvre déjà l'invariant,
  // et même plus strictement.
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (probe.status === 0 && probe.stdout.trim() === "true") {
    const tracked = spawnSync("git", ["ls-files", "*.jsonl"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(
      tracked.status,
      0,
      `git ls-files *.jsonl a échoué (status ${tracked.status}) : ${tracked.stderr}`,
    );
    assert.equal(
      tracked.stdout.trim(),
      "",
      `git indexe des transcriptions .jsonl : ${tracked.stdout.trim()}`,
    );
  }

  const jsonl = findJsonl(ROOT);
  assert.deepEqual(
    jsonl,
    [],
    `transcriptions .jsonl présentes sur le disque : ${jsonl.join(", ")}`,
  );
});
