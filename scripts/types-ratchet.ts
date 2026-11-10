#!/usr/bin/env node
// Plafond (« ratchet ») d'erreurs TypeScript PAR FICHIER pour une option stricte que le dépôt n'active pas encore.
//
//   node --experimental-strip-types scripts/types-ratchet.ts           compare à la baseline, hors réseau, sans rien écrire
//   node --experimental-strip-types scripts/types-ratchet.ts --write   réécrit scripts/types-ratchet-baseline.json
//
// L'option (OPTION, ci-dessous) est ajoutée aux TROIS programmes de scripts/typecheck.sh (tsconfig.json,
// tsconfig.test.json, omp-chrome/tsconfig.json) par MEM0_OMP_TSC_ARGS : mêmes entrées, même tsc épinglé, mêmes types de
// l'hôte. Les erreurs sont dédoublonnées (un fichier de src/ est vu par deux programmes) puis comptées par fichier.
//
// Verdict :
//   - un fichier dont le compte DÉPASSE son plafond (ou un fichier absent de la baseline qui a des erreurs) : échec, code 1 ;
//   - un compte qui BAISSE : le script le dit et invite à `--write` (code 0) — le plafond descend, il ne remonte pas ;
//   - tsc ou les types de l'hôte absents : « plafond non vérifié », code 0 (la section Types de check.sh rougit déjà
//     pour un tsc absent) ; `--write` refuse alors d'écrire (code 1).
// Aucun réseau, aucune écriture hors `--write`.
//
// Pourquoi noUncheckedIndexedAccess : mesuré le 2026-11-10 sur main (372 erreurs brutes, 316 distinctes ; 0 pour
// noImplicitOverride, 122 brutes pour exactOptionalPropertyTypes), c'est la seule option à la fois bornée et utile — chaque erreur est un `tab[i]` ou
// `.find()` non gardé qui peut renvoyer `undefined`. Le dépôt ne l'active pas (biome.jsonc : la convention `!` après un
// accès indexé) : le plafond n'impose AUCUN changement de comportement, il empêche seulement d'en ajouter.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** L'option stricte mesurée, sans les tirets. */
export const OPTION = "noUncheckedIndexedAccess";

export const BASELINE_FILE = "scripts/types-ratchet-baseline.json";

/** La baseline : l'option mesurée et, par fichier, le nombre d'erreurs tolérées. */
export interface Baseline {
  option: string;
  files: Record<string, number>;
}

const ERROR_LINE = /^(\S.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/** Les erreurs de la sortie de tsc, dédoublonnées, regroupées par fichier du dépôt (chemins relatifs, `/`). */
export function errorsByFile(output: string): Map<string, string[]> {
  const seen = new Set<string>();
  const byFile = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const match = ERROR_LINE.exec(line);
    if (match === null) continue;
    const file = match[1]!.replaceAll("\\", "/");
    // Hors dépôt (types de l'hôte, cache) : propre à la machine, jamais comptée.
    if (path.isAbsolute(file) || file.startsWith("../")) continue;
    const key = `${file}:${match[2]}:${match[3]}:${match[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byFile.get(file) ?? [];
    list.push(line.trim());
    byFile.set(file, list);
  }
  return byFile;
}

/** Les dépassements : fichier, compte courant, plafond (0 pour un fichier absent de la baseline). */
export function exceedances(
  counts: ReadonlyMap<string, number>,
  baseline: Baseline,
): Array<{ file: string; count: number; ceiling: number }> {
  const out: Array<{ file: string; count: number; ceiling: number }> = [];
  for (const [file, count] of counts) {
    const ceiling = baseline.files[file] ?? 0;
    if (count > ceiling) out.push({ file, count, ceiling });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Les fichiers passés sous leur plafond (ou devenus propres) : fichier, compte courant, plafond. */
export function reductions(
  counts: ReadonlyMap<string, number>,
  baseline: Baseline,
): Array<{ file: string; count: number; ceiling: number }> {
  const out: Array<{ file: string; count: number; ceiling: number }> = [];
  for (const [file, ceiling] of Object.entries(baseline.files)) {
    const count = counts.get(file) ?? 0;
    if (count < ceiling) out.push({ file, count, ceiling });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** La baseline sérialisée : clés triées, un fichier par ligne, newline final. */
export function serialize(counts: ReadonlyMap<string, number>): string {
  const files: Record<string, number> = {};
  for (const file of [...counts.keys()].sort()) files[file] = counts.get(file)!;
  const lines = Object.entries(files).map(([file, count]) => `    ${JSON.stringify(file)}: ${count}`);
  const body = lines.length === 0 ? "{}" : `{\n${lines.join(",\n")}\n  }`;
  return `{\n  "option": ${JSON.stringify(OPTION)},\n  "files": ${body}\n}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/** La version de TypeScript que scripts/typecheck.sh épingle, et celle que `.typecheck` porte (`null` si absent). */
function typescriptState(root: string): { wanted: string; found: string | null } {
  const script = fs.readFileSync(path.join(root, "scripts", "typecheck.sh"), "utf8");
  const wanted = /^TS_VERSION=(\S+)$/m.exec(script)?.[1] ?? "";
  const pkg = path.join(root, ".typecheck", "typescript", "node_modules", "typescript", "package.json");
  try {
    const version = asRecord(JSON.parse(fs.readFileSync(pkg, "utf8")))?.version;
    return { wanted, found: typeof version === "string" ? version : null };
  } catch {
    return { wanted, found: null };
  }
}

function readBaseline(root: string): Baseline | string {
  const file = path.join(root, BASELINE_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return `baseline illisible (${BASELINE_FILE}) : ${error instanceof Error ? error.message : String(error)} — écris-la avec --write`;
  }
  const candidate = asRecord(parsed);
  const files = asRecord(candidate?.files);
  if (candidate === null || typeof candidate.option !== "string" || files === null) {
    return `baseline invalide (${BASELINE_FILE}) : { option, files: { fichier: entier > 0 } } attendu`;
  }
  const counts: Record<string, number> = {};
  for (const [file, count] of Object.entries(files)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
      return `baseline invalide (${BASELINE_FILE}) : « ${file} » doit porter un entier > 0`;
    }
    counts[file] = count;
  }
  if (candidate.option !== OPTION) {
    return `baseline mesurée pour l'option « ${candidate.option} », ce script mesure « ${OPTION} » — réécris-la avec --write`;
  }
  return { option: OPTION, files: counts };
}

function main(argv: string[]): number {
  const write = argv.includes("--write");
  const unknown = argv.filter((arg) => arg !== "--write");
  if (unknown.length > 0) {
    console.error(`  ✗ option inconnue : ${unknown.join(" ")} (attendu : --write)`);
    return 2;
  }
  const root = path.resolve(import.meta.dirname, "..");

  const ts = typescriptState(root);
  const refusal = (why: string): number => {
    console.log(`  · ${why}, plafond non vérifié`);
    return write ? 1 : 0;
  };
  if (ts.found === null)
    return refusal(`TypeScript ${ts.wanted} absent de .typecheck (bash scripts/typecheck.sh --prepare)`);
  if (ts.found !== ts.wanted) return refusal(`TypeScript ${ts.wanted} attendu, ${ts.found} trouvé dans .typecheck`);

  const run = spawnSync("bash", ["scripts/typecheck.sh"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, MEM0_OMP_TSC_ARGS: `--${OPTION}` },
    maxBuffer: 512 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (output.includes("types de l'hôte absents")) return refusal("types de l'hôte absents");

  const byFile = errorsByFile(output);
  if (run.status !== 0 && byFile.size === 0) {
    // tsc a échoué sans une seule erreur de fichier du dépôt : on ne conclut rien, on montre ce qu'il a dit.
    console.log(output.trimEnd());
    console.log(`  ✗ scripts/typecheck.sh a échoué sans erreur TypeScript exploitable (avec --${OPTION})`);
    return 1;
  }
  const counts = new Map([...byFile].map(([file, errors]) => [file, errors.length] as const));
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);

  if (write) {
    const previous = readBaseline(root);
    if (typeof previous !== "string") {
      for (const { file, count, ceiling } of exceedances(counts, previous)) {
        console.log(`  ! plafond RELEVÉ : ${file} ${ceiling} → ${count} (un plafond ne doit que baisser)`);
      }
    }
    fs.writeFileSync(path.join(root, BASELINE_FILE), serialize(counts));
    console.log(`  ✓ ${BASELINE_FILE} réécrit : ${total} erreur(s) ${OPTION} dans ${counts.size} fichier(s)`);
    return 0;
  }

  const baseline = readBaseline(root);
  if (typeof baseline === "string") {
    console.log(`  ✗ ${baseline}`);
    return 1;
  }

  const over = exceedances(counts, baseline);
  if (over.length > 0) {
    for (const { file, count, ceiling } of over) {
      console.log(`  ✗ ${file} : ${count} erreur(s) ${OPTION} pour un plafond de ${ceiling}`);
      for (const line of (byFile.get(file) ?? []).slice(0, 5)) console.log(`      ${line}`);
    }
    console.log(
      `  ✗ plafond ${OPTION} dépassé dans ${over.length} fichier(s) : corrige l'erreur (accès indexé : \`tab[i]!\` selon la convention du dépôt, \`?.\` ou un test explicite) — n'écris pas la baseline pour la faire taire`,
    );
    return 1;
  }

  const lower = reductions(counts, baseline);
  const ceilingTotal = Object.values(baseline.files).reduce((sum, count) => sum + count, 0);
  console.log(`  ✓ plafond ${OPTION} tenu : ${total} erreur(s) pour un plafond de ${ceilingTotal}`);
  if (lower.length > 0) {
    const shown = lower.slice(0, 5).map((item) => `${item.file} ${item.ceiling} → ${item.count}`);
    if (lower.length > shown.length) shown.push(`… +${lower.length - shown.length}`);
    console.log(
      `  · ${lower.length} fichier(s) sous leur plafond (${shown.join(", ")}) : relance avec --write pour resserrer la baseline`,
    );
  }
  return 0;
}

if (process.argv[1] === import.meta.filename) process.exit(main(process.argv.slice(2)));
