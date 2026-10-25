// Feature worktrees-imbriques : un worktree d'agent de Claude Code
// (`.claude/worktrees/<nom>/`, un dépôt complet) posé dans le clone ne change pas
// le verdict de la suite. Il est ignoré par git — donc par les tests qui parcourent
// le dépôt en suivant .gitignore (docs/AC-21) — et n'entre pas dans les copies
// jetables, qui l'auraient recopié avec tous ses fichiers de test. Biome ne le
// parcourt pas : son biome.jsonc serait refusé comme seconde racine.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { outilEpingleAbsent } from "../support/prerequis.ts";
import { LINT_TOOL_ENV, ROOT, excludedFromCopy, tmpdir } from "../support/repo.ts";

const NESTED = path.join(".claude", "worktrees", "agent-sonde", "PUBLISHING.md");

test("worktrees-imbriques/AC-1 : git ignore les worktrees d'agents, et seulement eux sous .claude/", (t) => {
  if (spawnSync("git", ["rev-parse", "--git-dir"], { cwd: ROOT }).status !== 0) {
    t.skip("copie sans .git : rien à demander à git");
    return;
  }
  const ignored = (rel: string) =>
    spawnSync("git", ["check-ignore", "-q", "--no-index", rel], { cwd: ROOT }).status === 0;
  assert.ok(ignored(NESTED), `${NESTED} doit être ignoré`);
  assert.ok(!ignored(path.join(".claude", "settings.json")), "le reste de .claude/ reste suivi");
});

test("worktrees-imbriques/AC-2 : une copie jetable n'emporte pas les worktrees d'agents", () => {
  assert.equal(excludedFromCopy(path.join(".claude", "worktrees")), true);
  assert.equal(excludedFromCopy(NESTED), true);
  assert.equal(excludedFromCopy(path.join(".claude", "settings.json")), false);
  assert.equal(excludedFromCopy(path.join("omp-harness", "db.ts")), false);
});

test("worktrees-imbriques/AC-3 : un worktree d'agent imbriqué, sa racine Biome et ses fautes comprises, laisse la section lint verte", (t) => {
  if (outilEpingleAbsent(t, "biome")) return;
  const dir = tmpdir("worktrees-imbriques-lint-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "lint.sh"), path.join(dir, "scripts", "lint.sh"));
  fs.copyFileSync(path.join(ROOT, "biome.jsonc"), path.join(dir, "biome.jsonc"));
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "test", "propre.ts"), "export const propre = 1;\n");
  // Le worktree : un second biome.jsonc racine, et du TypeScript hors format dans un dossier lint.
  const nested = path.join(dir, ".claude", "worktrees", "agent-sonde");
  fs.mkdirSync(path.join(nested, "test"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "biome.jsonc"), path.join(nested, "biome.jsonc"));
  fs.writeFileSync(path.join(nested, "test", "sale.ts"), "export   const   sale=1\n");
  const result = spawnSync("bash", [path.join(dir, "scripts", "lint.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...LINT_TOOL_ENV },
    timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
