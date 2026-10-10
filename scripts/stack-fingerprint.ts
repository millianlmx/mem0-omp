// Empreinte des sources embarquées de la pile mem0-http (S-7, BR-6).
//
// Pourquoi : l'app construit l'image `omp-console-mem0-http` depuis les quatre
// fichiers de `mem0-stack/mem0-http/` embarqués dans son bundle. Sans empreinte,
// une source modifiée passerait inaperçue et l'app réutiliserait silencieusement
// une image périmée (le bogue du passé : étiqueter par le seul numéro de
// version). L'empreinte est un fichier VERSIONNÉ, `STACK_FINGERPRINT`, dont ce
// script est le SEUL écrivain ; `test/stack.test.ts` échoue si le dépôt le
// laisse désynchronisé.
//
// CLI : sans argument, vérifie et sort 1 en nommant le fichier et la commande
// exacte à lancer ; `--write` réécrit `<64 hex>\n` dans le fichier.
//
// La racine est DÉDUITE du script (comme check.sh), jamais du cwd appelant.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Les quatre fichiers qui forment l'unité embarquée, DANS CET ORDRE. */
export const STACK_SOURCES = ["Dockerfile", "http_server.py", "memory_config.py", "test_api.py"];
export const FINGERPRINT_FILE = "STACK_FINGERPRINT";
/** Dossier des sources, relatif à la racine du dépôt. */
export const STACK_SOURCES_DIR = "mem0-stack/mem0-http";
/** La commande exacte à lancer pour régénérer le fichier (message d'échec). */
export const REGENERATE_COMMAND = "bun scripts/stack-fingerprint.ts --write";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Le verdict d'une vérification : `expected` = empreinte recalculée, `actual` = fichier lu. */
export interface FingerprintCheck {
  ok: boolean;
  expected: string;
  actual: string | null;
}

/** Chemin ABSOLU du fichier d'empreinte pour une racine donnée. */
export function fingerprintPath(root: string): string {
  return path.join(root, STACK_SOURCES_DIR, FINGERPRINT_FILE);
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * SHA-256 hexadécimal (minuscule) de la concaténation, dans l'ordre de
 * `STACK_SOURCES`, des lignes `"<nom> <sha256hex du fichier>\n"`.
 */
export function sourceFingerprint(root: string): string {
  const dir = path.join(root, STACK_SOURCES_DIR);
  const lines = STACK_SOURCES.map(
    (name) => `${name} ${sha256Hex(fs.readFileSync(path.join(dir, name)))}\n`,
  );
  return sha256Hex(lines.join(""));
}

/** Le verdict : `expected` = empreinte recalculée, `actual` = contenu du fichier (`null` si absent). */
export function check(root: string): FingerprintCheck {
  const expected = sourceFingerprint(root);
  let actual: string | null = null;
  try {
    actual = fs.readFileSync(fingerprintPath(root), "utf8").trim();
  } catch {
    actual = null;
  }
  return { ok: actual === expected, expected, actual };
}

/** Le texte d'échec, tel que la CLI le rend : nomme le fichier ET la commande. */
export function failureMessage(root: string, result: FingerprintCheck): string {
  return [
    `✗ empreinte de la pile désynchronisée : ${path.relative(root, fingerprintPath(root))}`,
    `   attendu ${result.expected}, lu ${result.actual ?? "<absent>"}`,
    `   régénère avec : ${REGENERATE_COMMAND}`,
  ].join("\n");
}

function main(argv: string[]): number {
  if (argv.includes("--write")) {
    fs.writeFileSync(fingerprintPath(ROOT), `${sourceFingerprint(ROOT)}\n`);
    console.log(`  ✓ ${path.relative(ROOT, fingerprintPath(ROOT))} écrit`);
    return 0;
  }
  const result = check(ROOT);
  if (result.ok) {
    console.log(`  ✓ empreinte de la pile à jour (${result.expected.slice(0, 12)}…)`);
    return 0;
  }
  console.error(failureMessage(ROOT, result));
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
