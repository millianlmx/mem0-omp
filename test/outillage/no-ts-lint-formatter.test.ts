// Tests de la feature no-ts-lint-formatter : `scripts/lint.sh` (Biome épinglé,
// préparé une fois, exécuté hors réseau), sa configuration `biome.jsonc` et la
// section `lint` de `scripts/check.sh` qui l'appelle.
//
// Deux règles structurent ce fichier :
//  1. Le Biome préparé est celui de la racine, désigné par `LINT_TOOL_ENV` : une
//     copie jetable n'emporte pas `.lint/`. Un outil non préparé est un ÉCHEC,
//     jamais un saut.
//  2. Les fautes sont plantées dans un arbre jetable — minimal (lint.sh +
//     biome.jsonc + deux fichiers) pour lint.sh, copie du dépôt sans fichier de
//     test pour check.sh —, jamais dans l'arbre réel.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { LINT_TOOL_ENV, ROOT, sharedRepo, tmpdir } from "../support/repo.ts";

/** Profondeur d'imbrication : 0 = `node --test test/outillage/no-ts-lint-formatter.test.ts`. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

const LINT_SH = fs.readFileSync(path.join(ROOT, "scripts", "lint.sh"), "utf8");
const BIOME_VERSION = /^BIOME_VERSION="([^"]+)"$/m.exec(LINT_SH)![1]!;
const PREPARE = "« bash scripts/lint.sh --prepare »";

/** Le dossier de l'outil préparé à la racine (même résolution que lint.sh). */
const LINT_DIR = path.resolve(ROOT, process.env.MEM0_OMP_LINT_DIR || ".lint");

const output = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

/** Dossier de doublures : chaque binaire y est un script bash, jamais le vrai. */
function stubBin(prefix: string): { bin: string; log: string } {
  const bin = path.join(tmpdir(prefix), "bin");
  fs.mkdirSync(bin);
  const log = path.join(path.dirname(bin), "journal.txt");
  return { bin, log };
}

function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

/** Un faux dossier d'outil dont le lanceur `biome` exécute `body`. */
function fakeLintDir(body: string): string {
  const dir = tmpdir("lint-faux-");
  const bin = path.join(dir, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  stub(bin, "biome", body);
  return dir;
}

/** Un arbre minimal : scripts/lint.sh et biome.jsonc du dépôt, plus `files`. */
function miniTree(files: Record<string, string>): string {
  const dir = tmpdir("lint-arbre-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "lint.sh"), path.join(dir, "scripts", "lint.sh"));
  fs.copyFileSync(path.join(ROOT, "biome.jsonc"), path.join(dir, "biome.jsonc"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function runLint(cwd: string, args: string[], env: Record<string, string>) {
  return spawnSync("bash", [path.join(cwd, "scripts", "lint.sh"), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
}

/** AC-5 au niveau de lint.sh : le Biome préparé rend son verdict sans npm, npx, curl ni réseau. */
function assertLintShOffline(): void {
  // Doublures qui journalisent toute tentative de téléchargement, et un proxy mort.
  const { bin, log } = stubBin("lint-reseau-");
  for (const name of ["npm", "npx", "curl"]) stub(bin, name, `echo "${name} $*" >> "${log}"\nexit 1`);
  const env = {
    MEM0_OMP_LINT_DIR: LINT_DIR,
    PATH: `${bin}:${process.env.PATH}`,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
  };
  const conforme = 'export const a = "x";\n';
  const tree = miniTree({ "omp-mem0-req/a.ts": conforme, "test/b.ts": conforme });

  const prepared = runLint(tree, ["--prepare"], env);
  assert.equal(prepared.status, 0, output(prepared));
  assert.equal(prepared.stdout, `  · Biome ${BIOME_VERSION} déjà préparé dans ${LINT_DIR}\n`, output(prepared));

  const green = runLint(tree, [], env);
  assert.equal(green.status, 0, output(green));
  assert.match(green.stdout, /^Checked 3 files/m, output(green));

  // Le verdict rouge est rendu lui aussi hors réseau, et désigne le fichier fautif.
  fs.writeFileSync(path.join(tree, "test", "b.ts"), "export function f(): void {\n  debugger;\n}\n");
  const red = runLint(tree, [], env);
  assert.equal(red.status, 1, output(red));
  assert.match(output(red), /^test\/b\.ts:2:3 lint\/suspicious\/noDebugger/m, output(red));

  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", "", "aucun téléchargement tenté");
}

/** AC-6 au niveau de lint.sh : Biome absent ou d'une autre version ⇒ exit 3 et commande de (ré)installation. */
function assertLintShUnavailable(): void {
  const tree = miniTree({ "omp-mem0-req/a.ts": "export const a = 1;\n" });
  // Un `biome` du PATH, même à la bonne version, n'est jamais utilisé.
  const { bin } = stubBin("lint-path-");
  stub(bin, "biome", `echo "Version: ${BIOME_VERSION}"\nexit 0`);
  const PATH = `${bin}:${process.env.PATH}`;

  const absentCases: Array<[string, string]> = [
    ["dossier vide", tmpdir("lint-vide-")],
    ["lanceur sans binaire de plateforme", fakeLintDir('echo "binaire de plateforme introuvable" >&2\nexit 1')],
    ["lanceur sans ligne Version", fakeLintDir('echo "biome"\nexit 0')],
  ];
  for (const [label, dir] of absentCases) {
    const r = runLint(tree, [], { MEM0_OMP_LINT_DIR: dir, PATH });
    assert.equal(r.status, 3, `${label} : ${output(r)}`);
    assert.equal(
      r.stdout,
      `  ✗ Biome ${BIOME_VERSION} absent de ${dir} : installe-le avec ${PREPARE} (réseau requis une seule fois)\n`,
      label,
    );
    assert.doesNotMatch(output(r), /^ {2}· |✓/m, label);
  }

  const wrong = fakeLintDir('echo "Version: 0.0.0-faux"\nexit 0');
  const r = runLint(tree, [], { MEM0_OMP_LINT_DIR: wrong, PATH });
  assert.equal(r.status, 3, output(r));
  assert.equal(
    r.stdout,
    `  ✗ Biome 0.0.0-faux trouvé dans ${wrong}, ${BIOME_VERSION} attendu : réinstalle-le avec ${PREPARE}\n`,
  );
  assert.doesNotMatch(output(r), /^ {2}· |✓/m);
}

/** La copie où check.sh tourne : le dépôt sans aucun fichier de test, remise à neuf par cas. */
const repo = sharedRepo("lint-", { keepTest: () => false });

const LINT_FAULT = "export function f(): void {\n  debugger;\n}\n";
const FORMAT_FAULT = "export const  a = 1;\n";
const PASS_LINE = "  ✓ lint et format du TypeScript conformes (omp-mem0-req/, test/)";
const UNAVAILABLE_LINE = "  ✗ linter épinglé indisponible (installe : bash scripts/lint.sh --prepare)";

/** `scripts/check.sh --sections=lint` dans `cwd`, avec le Biome de la racine. */
function runSection(cwd: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["scripts/check.sh", "--sections=lint"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...LINT_TOOL_ENV, MEM0_CHECK_DEPTH: String(DEPTH + 1), ...env },
    timeout: 300_000,
  });
}

/**
 * Les lignes de la section `── Lint TypeScript` (seule lancée), en-tête exclu : la
 * sortie de Biome a ses propres lignes vides, seules la ligne vide et le verdict
 * final de check.sh sont retirés.
 */
function sectionLines(stdout: string): string[] {
  const lines = stdout.split("\n");
  const start = lines.indexOf("── Lint TypeScript");
  assert.ok(start !== -1, `en-tête « ── Lint TypeScript » absent :\n${stdout}`);
  const section = lines.slice(start + 1);
  while (section.length > 0 && ["", "Dépôt prêt à publier."].includes(section.at(-1) ?? "")) section.pop();
  return section;
}

test("no-ts-lint-formatter/AC-1 : sur l'arbre livré, la section lint de check.sh est verte", () => {
  const r = runSection(ROOT);
  assert.equal(r.status, 0, output(r));
  const section = sectionLines(r.stdout);
  assert.equal(section.at(-1), PASS_LINE, output(r));
  assert.ok(!section.some((line) => line.startsWith("  ✗ ") || line.startsWith("  · ")), output(r));
  assert.ok(r.stdout.includes("Dépôt prêt à publier."), output(r));
});

test("no-ts-lint-formatter/AC-2 : une faute de lint dans omp-mem0-req/ puis test/ rougit la section et désigne le fichier", () => {
  for (const rel of ["omp-mem0-req/zz-faute-lint.ts", "test/support/zz-faute-lint.ts"]) {
    const dir = repo.fresh();
    fs.writeFileSync(path.join(dir, rel), LINT_FAULT);
    const r = runSection(dir);
    assert.equal(r.status, 1, `${rel} :\n${output(r)}`);
    const section = sectionLines(r.stdout);
    assert.equal(section.at(-1), `  ✗ lint/format : ${rel} (relance : bash scripts/lint.sh)`, output(r));
    assert.ok(
      section.some((line) => line.startsWith(`${rel}:2:3 lint/suspicious/noDebugger`)),
      output(r),
    );
  }
});

test("no-ts-lint-formatter/AC-3 : une faute de format seule dans omp-mem0-req/ puis test/ rougit la section", () => {
  for (const rel of ["omp-mem0-req/zz-faute-format.ts", "test/support/zz-faute-format.ts"]) {
    const dir = repo.fresh();
    fs.writeFileSync(path.join(dir, rel), FORMAT_FAULT);
    const r = runSection(dir);
    assert.equal(r.status, 1, `${rel} :\n${output(r)}`);
    const section = sectionLines(r.stdout);
    assert.equal(section.at(-1), `  ✗ lint/format : ${rel} (relance : bash scripts/lint.sh)`, output(r));
    assert.ok(
      section.some((line) => line.startsWith(`${rel} format`)),
      output(r),
    );
    // Aucun diagnostic de lint (`<chemin>:<l>:<c> lint/…`) : la faute est de format seulement.
    assert.ok(
      !section.some((line) => /^\S+:\d+:\d+ lint\//.test(line)),
      `aucune faute de lint attendue :\n${output(r)}`,
    );
  }
});

test("no-ts-lint-formatter/AC-4 : les mêmes fautes hors de omp-mem0-req/ et test/ laissent la section verte", () => {
  const dir = repo.fresh();
  for (const rel of ["scripts/zz-faute.ts", "omp-mem0-memory/zz-faute.ts"]) {
    fs.writeFileSync(path.join(dir, rel), `${LINT_FAULT}${FORMAT_FAULT}`);
  }
  const r = runSection(dir);
  assert.equal(r.status, 0, output(r));
  assert.equal(sectionLines(r.stdout).at(-1), PASS_LINE, output(r));
  assert.ok(!r.stdout.includes("zz-faute"), output(r));
});

test("no-ts-lint-formatter/AC-5 : lint.sh et la section lint de check.sh rendent leur verdict sans npm, npx, curl ni réseau", () => {
  assertLintShOffline();

  const { bin, log } = stubBin("lint-section-reseau-");
  for (const name of ["npm", "npx", "curl"]) stub(bin, name, `echo "${name} $*" >> "${log}"\nexit 1`);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
  };

  const green = runSection(repo.fresh(), env);
  assert.equal(green.status, 0, output(green));
  assert.equal(sectionLines(green.stdout).at(-1), PASS_LINE, output(green));

  const dir = repo.fresh();
  fs.writeFileSync(path.join(dir, "test", "support", "zz-faute-lint.ts"), LINT_FAULT);
  const red = runSection(dir, env);
  assert.equal(red.status, 1, output(red));
  assert.equal(
    sectionLines(red.stdout).at(-1),
    "  ✗ lint/format : test/support/zz-faute-lint.ts (relance : bash scripts/lint.sh)",
    output(red),
  );

  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", "", "aucun téléchargement tenté");
});

test("no-ts-lint-formatter/AC-6 : outil absent ou d'une autre version ⇒ lint.sh sort 3 et la section lint est rouge, jamais sautée, avec la commande de (ré)installation", () => {
  assertLintShUnavailable();

  const dir = repo.fresh();
  const empty = tmpdir("lint-section-vide-");
  const wrong = fakeLintDir('echo "Version: 0.0.0-faux"\nexit 0');
  const cases: Array<[string, string, string]> = [
    [
      "dossier vide",
      empty,
      `  ✗ Biome ${BIOME_VERSION} absent de ${empty} : installe-le avec ${PREPARE} (réseau requis une seule fois)`,
    ],
    [
      "autre version",
      wrong,
      `  ✗ Biome 0.0.0-faux trouvé dans ${wrong}, ${BIOME_VERSION} attendu : réinstalle-le avec ${PREPARE}`,
    ],
  ];
  for (const [label, lintDir, toolLine] of cases) {
    const r = runSection(dir, { MEM0_OMP_LINT_DIR: lintDir });
    assert.equal(r.status, 1, `${label} :\n${output(r)}`);
    // Exactement ces deux lignes : ni `  · ` (saut), ni `✓`.
    assert.deepEqual(sectionLines(r.stdout), [toolLine, UNAVAILABLE_LINE], `${label} :\n${output(r)}`);
  }

  // scripts/lint.sh disparu : échec qui ne désigne aucun fichier, jamais un saut.
  fs.rmSync(path.join(dir, "scripts", "lint.sh"));
  const missing = runSection(dir);
  assert.equal(missing.status, 1, output(missing));
  const section = sectionLines(missing.stdout);
  assert.equal(
    section.at(-1),
    "  ✗ lint/format : sortie non nulle sans fichier désigné (relance : bash scripts/lint.sh)",
    output(missing),
  );
  assert.ok(!section.some((line) => line.startsWith("  · ") || line.includes("✓")), output(missing));
});

test("no-ts-lint-formatter/AC-8 : une copie jetable, sans .lint/, passe sa section lint avec le Biome de la racine", () => {
  const dir = repo.fresh();
  assert.ok(!fs.existsSync(path.join(dir, ".lint")), "une copie jetable n'emporte pas .lint/");
  const r = runSection(dir);
  assert.equal(r.status, 0, output(r));
  assert.equal(sectionLines(r.stdout).at(-1), PASS_LINE, output(r));
});

/** Les lignes de biome.jsonc, et l'objet qu'elles décrivent (commentaires `//` en ligne entière). */
const CONFIG_LINES = fs.readFileSync(path.join(ROOT, "biome.jsonc"), "utf8").split("\n");
type Rules = Record<string, unknown>;
const CONFIG = JSON.parse(CONFIG_LINES.filter((line) => !line.trim().startsWith("//")).join("\n")) as {
  linter: { rules: Rules };
  assist: { enabled: boolean };
  overrides?: unknown;
};

/** Le bloc de commentaires contigu au-dessus de la ligne qui porte `key`. */
function commentAbove(key: string): string {
  const at = CONFIG_LINES.findIndex((line) => line.trim().startsWith(`"${key}"`));
  assert.ok(at > 0, `clé ${key} absente de biome.jsonc`);
  const block: string[] = [];
  for (let i = at - 1; i >= 0 && CONFIG_LINES[i]!.trim().startsWith("//"); i--) block.unshift(CONFIG_LINES[i]!.trim());
  return block.join(" ");
}

/** Fichiers sous `dir`, récursivement, hors dépendances installées. */
function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && !entry.parentPath.split(path.sep).includes("node_modules"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("no-ts-lint-formatter/AC-7 : seules les règles contraires à une convention du dépôt sont coupées, chacune justifiée", () => {
  const off: string[] = [];
  for (const [group, rules] of Object.entries(CONFIG.linter.rules)) {
    if (typeof rules !== "object" || rules === null) continue;
    for (const [rule, level] of Object.entries(rules)) if (level === "off") off.push(`${group}/${rule}`);
  }
  assert.deepEqual(off.sort(), [
    "style/noNonNullAssertion",
    "suspicious/noControlCharactersInRegex",
    "suspicious/noTemplateCurlyInString",
  ]);
  assert.equal(CONFIG.linter.rules.preset, "recommended");
  assert.equal(CONFIG.overrides, undefined, "aucun override ne coupe une règle en douce");

  // Chaque justification nomme la convention ET l'endroit du dépôt qui l'établit.
  assert.match(
    commentAbove("noNonNullAssertion"),
    /noUncheckedIndexedAccess.*tsconfig\.json|tsconfig\.json.*noUncheckedIndexedAccess/,
  );
  assert.match(commentAbove("noNonNullAssertion"), /comportement/);
  assert.match(commentAbove("noTemplateCurlyInString"), /test\/outillage\/check\.test\.ts:\d+/);
  assert.match(commentAbove("noTemplateCurlyInString"), /test\/console\/ios-memoire-graphe\.test\.ts:\d+/);
  assert.match(commentAbove("noControlCharactersInRegex"), /omp-mem0-req\/panelWidth\.ts/);
  assert.match(commentAbove("noControlCharactersInRegex"), /ANSI/);
  assert.equal(CONFIG.assist.enabled, false);
  assert.match(commentAbove("assist"), /imports/);

  // Aucune règle n'est coupée fichier par fichier : pas de commentaire de suppression.
  const marker = ["biome", "ignore"].join("-");
  const suppressed = [...walk(path.join(ROOT, "omp-mem0-req")), ...walk(path.join(ROOT, "test"))]
    .filter((file) => file.endsWith(".ts") && fs.readFileSync(file, "utf8").includes(marker))
    .map((file) => path.relative(ROOT, file));
  assert.deepEqual(suppressed, []);
});

const PREPARE_STEP = "        run: bash scripts/lint.sh --prepare";

function workflow(name: string): string {
  return fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
}

/** Les lignes d'un job : de `  <id>:` jusqu'au job suivant (ou la fin du fichier). */
function jobLines(yaml: string, id: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  assert.notEqual(start, -1, `job « ${id} » absent`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:$/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end);
}

/** L'étape de préparation précède, dans ces lignes, la première qui satisfait `launches`. */
function assertPreparedBefore(lines: string[], launches: (line: string) => boolean, where: string): void {
  const launch = lines.findIndex(launches);
  assert.notEqual(launch, -1, `${where} : aucun lancement trouvé`);
  const prepare = lines.indexOf(PREPARE_STEP);
  assert.notEqual(prepare, -1, `${where} : l'outil épinglé n'est jamais préparé`);
  assert.ok(prepare < launch, `${where} : l'outil est préparé APRÈS le lancement de check.sh`);
}

test("no-ts-lint-formatter/AC-9 : chaque job qui lance check.sh avec lint prépare l'outil épinglé avant, et check.yml compte les sections de check.sh", () => {
  const check = workflow("check.yml");
  for (const job of ["check", "macos-tests"]) {
    assertPreparedBefore(
      jobLines(check, job),
      (line) => line.startsWith("        run: ./scripts/check.sh"),
      `check.yml, job ${job}`,
    );
  }
  // release.ts lance lui-même `bash scripts/check.sh` dans le clone.
  assertPreparedBefore(
    workflow("release.yml").split("\n"),
    (line) => line.includes("scripts/release.ts"),
    "release.yml",
  );
  // release-simulation.sh lance release.ts --simulate, donc check.sh, dans sa copie.
  assertPreparedBefore(
    workflow("release-simulation.yml").split("\n"),
    (line) => line === "        run: bash scripts/release-simulation.sh",
    "release-simulation.yml",
  );

  // Le commentaire de comptage suit SECTION_IDS, sans autre décompte resté en arrière.
  const ids = /^SECTION_IDS="([^"]+)"$/m.exec(fs.readFileSync(path.join(ROOT, "scripts", "check.sh"), "utf8"));
  assert.ok(ids, "SECTION_IDS introuvable dans check.sh");
  const count = ids[1]!.trim().split(/\s+/).length;
  assert.ok(ids[1]!.split(/\s+/).includes("lint"), "lint absent de SECTION_IDS");
  assert.ok(
    check.includes(`les ${count} sections de check.sh`),
    `check.yml ne dit pas « les ${count} sections de check.sh »`,
  );
  assert.deepEqual(
    [...check.matchAll(/les (\d+) sections/g)].map((match) => match[1]),
    [String(count)],
  );
});
