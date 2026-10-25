// Outillage partagé des tests node : la racine du dépôt, la liste des fichiers de
// test, les dossiers jetables et la copie du dépôt où l'on plante une faute.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : ni
// scripts/test-files.sh ni `node --test` ne le lancent, seuls les tests
// l'importent.
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Racine absolue du dépôt (test/support/ → ../..). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Le fichier de test qui relance check.sh dans ses copies : une copie qui le
 * garderait se recopierait sans fin. */
export const RECURSIVE_TEST = path.join("test", "outillage", "check.test.ts");

/**
 * Les fichiers de test node sous `<root>/test`, sous-dossiers compris, en
 * chemins relatifs `test/<domaine>/<nom>.test.ts`, triés octet par octet —
 * l'ordre exact de scripts/test-files.sh (`LC_ALL=C sort`).
 */
export function listTestFiles(root: string = ROOT): string[] {
  const testDir = path.join(root, "test");
  const out: string[] = [];
  for (const entry of fs.readdirSync(testDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    out.push(path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const tracked: string[] = [];
test.after(() => {
  for (const dir of tracked) fs.rmSync(dir, { recursive: true, force: true });
});

/** Dossier temporaire (chemin réel, /var → /private/var), retiré en fin de fichier. */
export function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tracked.push(dir);
  return dir;
}

/** Ce qui n'a rien à faire dans une copie : l'historique, les dépendances, la
 * racine de types jetable, le Biome préparé, le stockage vectoriel local et les
 * artefacts de build. Les scratchs SwiftPM (`.build`, `.build-<quoi>`) sont
 * reconnus par PRÉFIXE : un scratch inconnu pèse des centaines de Mo. */
const EXCLUDED_SEGMENTS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  ".lint": true,
  qdrant_storage: true,
  build: true,
  target: true,
};

/** Les sous-arbres qui sont eux-mêmes des dépôts complets (worktrees d'agents, cf.
 * .gitignore) : recopiés, ils multiplieraient la copie et ses fichiers de test. */
const EXCLUDED_PATHS = [path.join(".claude", "worktrees")];

/** Vrai si `rel` (chemin relatif au dépôt) n'entre pas dans une copie jetable. */
export function excludedFromCopy(rel: string): boolean {
  if (EXCLUDED_PATHS.some((excluded) => rel === excluded || rel.startsWith(`${excluded}${path.sep}`))) return true;
  return rel.split(path.sep).some((segment) => EXCLUDED_SEGMENTS[segment] === true || segment.startsWith(".build"));
}

/**
 * Le Biome épinglé des `check.sh` imbriqués (section `lint`) : celui que
 * `bash scripts/lint.sh --prepare` a posé dans `<ROOT>/.lint`, ou le dossier que
 * l'appelant désigne déjà. Les copies jetables n'emportent pas `.lint/` ; à
 * étaler dans l'env de tout lancement qui exécute un check.sh complet.
 */
export const LINT_TOOL_ENV: Record<string, string> = {
  MEM0_OMP_LINT_DIR: process.env.MEM0_OMP_LINT_DIR || path.join(ROOT, ".lint"),
};

export type CopyOptions = {
  /**
   * Garde ou écarte chaque fichier de test de la copie (chemin relatif
   * `test/<domaine>/<nom>.test.ts`). Par défaut : tous gardés sauf
   * RECURSIVE_TEST, qui n'est jamais recopié quel que soit le filtre.
   */
  keepTest?: (rel: string) => boolean;
};

/** Une copie jetable du dépôt, dans `<tmp>/<prefix>XXXX`, retirée en fin de fichier. */
export function copyRepo(prefix: string, options: CopyOptions = {}): string {
  const dir = tmpdir(prefix);
  copyRepoInto(dir, options);
  return dir;
}

/** Copie le dépôt dans `dir` (qui existe déjà), avec les mêmes exclusions, puis
 * y relie le TypeScript épinglé (linkPinnedTypescript). */
export function copyRepoInto(dir: string, options: CopyOptions = {}): void {
  const keep = options.keepTest ?? (() => true);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (excludedFromCopy(rel)) return false;
      if (rel === RECURSIVE_TEST) return false;
      if (rel.startsWith(`test${path.sep}`) && rel.endsWith(".test.ts")) return keep(rel.split(path.sep).join("/"));
      return true;
    },
  });
  linkPinnedTypescript(dir);
}

/**
 * Relie `<dir>/.typecheck/typescript` au TypeScript épinglé du dépôt
 * (`<ROOT>/.typecheck/typescript`, installé par `bash scripts/typecheck.sh
 * --prepare`) : une copie jetable n'emporte pas `.typecheck/`, et son
 * type-check ne télécharge jamais rien. No-op si ROOT n'a pas de TypeScript
 * préparé (la copie est alors rouge, comme le dépôt) ou si la copie porte déjà
 * un `.typecheck/typescript`, lien cassé compris. Le TypeScript de ROOT n'est
 * jamais modifié : un `--prepare` lancé dans la copie retire le lien, pas sa cible.
 */
export function linkPinnedTypescript(dir: string): void {
  const source = path.join(ROOT, ".typecheck", "typescript");
  if (!fs.existsSync(source)) return;
  const target = path.join(dir, ".typecheck", "typescript");
  if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, "dir");
}

/**
 * Une copie jetable PARTAGÉE par les tests d'un fichier : `fresh()` la crée au
 * premier appel (copyRepo), puis la remet à l'état du dépôt à chaque appel
 * suivant — fichiers modifiés ou supprimés recopiés depuis ROOT, fichiers et
 * dossiers ajoutés retirés. Une remise à neuf compare mtime et taille (≈ 10 ms
 * pour ~1 000 fichiers) là où une copie coûte ≈ 350 ms : un fichier à dix
 * copies gagne trois secondes sans rien partager entre deux `fresh()`.
 *
 * Les tests d'un même fichier tournent en série ; deux `fresh()` dans un même
 * test rendent le MÊME dossier, le premier état étant perdu — ne garder sous la
 * main qu'une copie à la fois.
 */
export function sharedRepo(prefix: string, options: CopyOptions = {}): { fresh(): string } {
  let root: string | null = null;
  const files = new Map<string, { mtimeMs: number; size: number }>();
  const dirs = new Set<string>();
  const stamp = (full: string) => {
    const stat = fs.lstatSync(full);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  };
  // Parcours qui ne suit AUCUN lien et ne descend pas dans les segments exclus
  // de la copie : `.typecheck/typescript` et `.typecheck/node_modules` sont des
  // liens vers ROOT et vers l'hôte, que `readdirSync({recursive})` suivrait
  // (Node 26) — une entrée « ajoutée » sous eux serait supprimée DANS la cible.
  // Le dossier exclu lui-même reste une entrée : ajouté par un test, il est retiré.
  const walk = (dir: string): Array<[string, fs.Dirent]> => {
    const out: Array<[string, fs.Dirent]> = [];
    const visit = (rel: string) => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const child = rel === "" ? entry.name : path.join(rel, entry.name);
        out.push([child, entry]);
        const excluded = EXCLUDED_SEGMENTS[entry.name] === true || entry.name.startsWith(".build");
        if (entry.isDirectory() && !excluded) visit(child);
      }
    };
    visit("");
    return out;
  };
  return {
    fresh(): string {
      if (root === null) {
        root = copyRepo(prefix, options);
        for (const [rel, entry] of walk(root)) {
          if (entry.isDirectory()) dirs.add(rel);
          else files.set(rel, stamp(path.join(root, rel)));
        }
        return root;
      }
      const seen = new Set<string>();
      const removed: string[] = [];
      for (const [rel, entry] of walk(root)) {
        if (removed.some((gone) => rel.startsWith(`${gone}${path.sep}`))) continue;
        if (entry.isDirectory()) {
          if (!dirs.has(rel)) removed.push(rel);
          continue;
        }
        const expected = files.get(rel);
        if (expected === undefined) {
          removed.push(rel);
          continue;
        }
        seen.add(rel);
        const actual = stamp(path.join(root, rel));
        if (actual.mtimeMs !== expected.mtimeMs || actual.size !== expected.size) restore(root, rel);
      }
      for (const rel of removed) fs.rmSync(path.join(root, rel), { recursive: true, force: true });
      for (const rel of files.keys()) if (!seen.has(rel)) restore(root, rel);
      linkPinnedTypescript(root);
      return root;
    },
  };
  function restore(dir: string, rel: string): void {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { force: true });
    fs.cpSync(path.join(ROOT, rel), target, { verbatimSymlinks: true });
    files.set(rel, stamp(target));
  }
}

/**
 * L'environnement d'un processus enfant qui relance `node --test` : sans
 * NODE_TEST_CONTEXT, le `node --test` imbriqué exécute vraiment ses fichiers
 * (avec, il sort 0 « skipping running files » sans rien lancer).
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}
