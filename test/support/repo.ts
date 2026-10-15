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
 * racine de types jetable, le stockage vectoriel local et les artefacts de
 * build. Les scratchs SwiftPM (`.build`, `.build-<quoi>`) sont reconnus par
 * PRÉFIXE : un scratch inconnu pèse des centaines de Mo. */
const EXCLUDED_SEGMENTS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
  build: true,
  target: true,
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

/** Copie le dépôt dans `dir` (qui existe déjà), avec les mêmes exclusions. */
export function copyRepoInto(dir: string, options: CopyOptions = {}): void {
  const keep = options.keepTest ?? (() => true);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((segment) => EXCLUDED_SEGMENTS[segment] === true || segment.startsWith(".build"))) {
        return false;
      }
      if (rel === RECURSIVE_TEST) return false;
      if (rel.startsWith(`test${path.sep}`) && rel.endsWith(".test.ts")) return keep(rel.split(path.sep).join("/"));
      return true;
    },
  });
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
  const walk = (dir: string): Array<[string, fs.Dirent]> =>
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((entry) => [path.relative(dir, path.join(entry.parentPath, entry.name)), entry]);
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
