// Tests des règles « anti-slop » : les plugins GritQL de scripts/biome-rules/*.grit, chargés par biome.jsonc, et leur
// baseline (scripts/biome-rules/baseline.jsonc). Chaque règle est jugée par le Biome ÉPINGLÉ, sur un exemple fautif
// (la bonne ligne est désignée) et un exemple conforme (aucun diagnostic), dans un arbre jetable qui porte la VRAIE
// configuration. Un clone sans Biome préparé saute ces tests en le disant (outilEpingleAbsent), comme
// no-ts-lint-formatter.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { outilEpingleAbsent } from "../support/prerequis.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const RULES_DIR = path.join(ROOT, "scripts", "biome-rules");
const LINT_DIR = path.resolve(ROOT, process.env.MEM0_OMP_LINT_DIR || ".lint");
const BIOME = path.join(LINT_DIR, "node_modules", ".bin", "biome");

type Diagnostic = { file: string; line: number; message: string };

/** Les diagnostics de plugin (règles GritQL) du rapport `--reporter=github` de Biome. */
function pluginDiagnostics(stdout: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const row of stdout.split("\n")) {
    const match = /^::\w+ title=plugin,file=([^,]*),line=(\d+),[^:]*::(.*)$/.exec(row);
    if (match !== null) found.push({ file: match[1]!, line: Number(match[2]), message: match[3]! });
  }
  return found;
}

/** `biome lint` dans `cwd` (ou avec les arguments donnés), rapport au format github. */
function biomeLint(cwd: string, ...extra: string[]) {
  return spawnSync(BIOME, ["lint", "--colors=off", "--reporter=github", "--max-diagnostics=none", ...extra], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
}

/** Un arbre jetable avec la vraie configuration Biome, ses règles et leur baseline, plus `files`. */
function tree(files: Record<string, string>): string {
  const dir = tmpdir("anti-slop-");
  fs.copyFileSync(path.join(ROOT, "biome.jsonc"), path.join(dir, "biome.jsonc"));
  fs.cpSync(RULES_DIR, path.join(dir, "scripts", "biome-rules"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** Les diagnostics de plugin que Biome rend pour `rel`, dans l'arbre jetable `dir`, par ligne croissante. */
function lintFile(dir: string, rel: string): Diagnostic[] {
  const r = biomeLint(dir);
  assert.notEqual(r.status, null, `biome interrompu : ${r.stderr}`);
  return pluginDiagnostics(r.stdout)
    .filter((d) => d.file === path.join(dir, rel))
    .sort((a, b) => a.line - b.line);
}

type Case = {
  rule: string;
  /** Chemin (dans l'arbre jetable) du fichier jugé. */
  file: string;
  /** Le code fautif, et les lignes que la règle doit désigner (toutes, et rien d'autre). */
  faulty: string;
  lines: number[];
  /** Un code voisin qui ne doit déclencher AUCUNE règle. */
  compliant: string;
};

const CASES: Case[] = [
  {
    rule: "no-snapshot-tests",
    file: "test/zz-instantane.test.ts",
    faulty: [
      'import test from "node:test";',
      'test("a", (t) => {',
      "  t.assert.snapshot({ a: 1 });",
      "  expect(valeur).toMatchSnapshot();",
      '  expect(valeur).toMatchInlineSnapshot("1");',
      "});",
    ].join("\n"),
    lines: [3, 4, 5],
    // `snapshot` est aussi un nom de méthode du domaine (le fil d'une session) : seul le test d'instantané est visé.
    compliant: [
      'import test from "node:test";',
      'test("a", (t) => {',
      '  t.assert.equal(feed.snapshot("r1").length, 3);',
      "  t.assert.deepEqual(valeur, { a: 1 });",
      "});",
    ].join("\n"),
  },
  {
    rule: "no-sleep-in-tests",
    file: "test/zz-delai.test.ts",
    faulty: [
      'import { setTimeout as sleep } from "node:timers/promises";',
      'test("a", async () => {',
      "  await sleep(50);",
      "  await new Promise((resolve) => setTimeout(resolve, 20));",
      "  await delay(10);",
      "});",
    ].join("\n"),
    lines: [3, 4, 5],
    // Attendre un événement, avancer une horloge simulée ou retarder la réponse d'un faux serveur n'est pas une attente.
    compliant: [
      'test("a", async (t) => {',
      '  t.mock.timers.enable({ apis: ["setTimeout"] });',
      "  t.mock.timers.tick(1_000);",
      '  await new Promise((resolve) => emitter.once("pret", resolve));',
      '  const serveur = (res) => setTimeout(() => res.end("ok"), 5);',
      "});",
    ].join("\n"),
  },
  {
    rule: "no-module-mocking",
    file: "test/zz-doublure.test.ts",
    faulty: [
      'import { mock } from "node:test";',
      'test("a", (t) => {',
      '  mock.module("./x.ts", { namedExports: {} });',
      '  t.mock.method(service, "lire");',
      '  mock.getter(service, "etat");',
      '  jest.mock("./y.ts");',
      '  vi.spyOn(service, "lire");',
      "});",
    ].join("\n"),
    lines: [3, 4, 5, 6, 7],
    // Une fonction jetable passée en dépendance et une horloge simulée restent permises.
    compliant: [
      'import { mock } from "node:test";',
      'test("a", (t) => {',
      "  const rappel = mock.fn();",
      "  service.lire(rappel);",
      "  t.mock.timers.enable();",
      "});",
    ].join("\n"),
  },
  {
    rule: "no-only-tests",
    file: "test/zz-seul.test.ts",
    faulty: [
      'import test, { describe } from "node:test";',
      'test.only("a", () => {});',
      'describe.only("b", () => {});',
      'test("c", { only: true }, () => {});',
    ].join("\n"),
    lines: [2, 3, 4],
    compliant: [
      'import test from "node:test";',
      'test("a", () => {});',
      'test("b", { skip: false, timeout: 1_000 }, () => {});',
    ].join("\n"),
  },
  {
    rule: "no-tautological-assertions",
    file: "test/zz-tautologie.test.ts",
    faulty: [
      'import assert from "node:assert/strict";',
      'test("a", (t) => {',
      "  assert.equal(resultat.valeur, resultat.valeur);",
      '  assert.deepStrictEqual(liste, liste, "idem");',
      "  assert.ok(true);",
      "  t.assert.equal(x, x);",
      "});",
    ].join("\n"),
    lines: [3, 4, 5, 6],
    compliant: [
      'import assert from "node:assert/strict";',
      'test("a", () => {',
      "  assert.equal(resultat.valeur, 2);",
      "  assert.equal(premier.valeur, second.valeur);",
      "  assert.ok(drapeau);",
      "});",
    ].join("\n"),
  },
  {
    rule: "no-unknown-returns",
    file: "omp-harness/zz-retour-unknown.ts",
    faulty: [
      "export function a(x: number): unknown {",
      "  return x;",
      "}",
      "export async function b(x: number): Promise<unknown> {",
      "  return x;",
      "}",
      "export const c = (x: number): unknown => x;",
      "export function d<T>(x: T): unknown {",
      "  return x;",
      "}",
    ].join("\n"),
    lines: [1, 4, 7, 8],
    // `unknown` en entrée, une fonction non exportée et un retour typé sont conformes.
    compliant: [
      "export function a(x: unknown): string {",
      "  return String(x);",
      "}",
      "function b(): unknown {",
      "  return 1;",
      "}",
      "export async function c(): Promise<number> {",
      "  return b() === 1 ? 1 : 2;",
      "}",
    ].join("\n"),
  },
];

for (const [index, c] of CASES.entries()) {
  test(`anti-slop/AC-${index + 1} : ${c.rule} désigne les lignes fautives et laisse le code conforme en paix`, (t) => {
    if (outilEpingleAbsent(t, "biome")) return;
    const dir = tree({ [c.file]: `${c.faulty}\n` });
    const faulty = lintFile(dir, c.file);
    assert.deepEqual(
      faulty.map((d) => d.line),
      c.lines,
      JSON.stringify(faulty),
    );
    for (const d of faulty)
      assert.ok(d.message.includes(`(anti-slop/${c.rule})`), `${d.message} ne nomme pas ${c.rule}`);

    fs.writeFileSync(path.join(dir, c.file), `${c.compliant}\n`);
    assert.deepEqual(lintFile(dir, c.file), []);
  });
}

test("anti-slop/AC-7 : les règles de test ne visent que test/, la règle de retour que les sources", (t) => {
  if (outilEpingleAbsent(t, "biome")) return;
  const testRules = CASES.filter((c) => c.file.startsWith("test/"));
  const unknown = CASES.find((c) => c.rule === "no-unknown-returns")!;
  const files: Record<string, string> = { "test/zz-support-unknown.ts": `${unknown.faulty}\n` };
  // Le code fautif de chaque règle de test, posé dans une source : aucune ne s'y applique.
  for (const [index, c] of testRules.entries()) files[`omp-harness/zz-hors-test-${index}.ts`] = `${c.faulty}\n`;
  assert.deepEqual(pluginDiagnostics(biomeLint(tree(files)).stdout), []);
});

/** Le contenu d'un fichier .jsonc dont les commentaires occupent des lignes entières. */
function readJsonc(file: string): unknown {
  return JSON.parse(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n"),
  );
}

type BaselinePlugin = { path: string; includes: string[] };

/** Les règles de la baseline : nom → chemins exclus (relatifs à la racine du dépôt). */
function baselineByRule(): Map<string, string[]> {
  const parsed = readJsonc(path.join(RULES_DIR, "baseline.jsonc"));
  assert.ok(typeof parsed === "object" && parsed !== null && "plugins" in parsed && Array.isArray(parsed.plugins));
  const byRule = new Map<string, string[]>();
  for (const plugin of parsed.plugins as BaselinePlugin[]) {
    const excluded = plugin.includes.filter((glob) => glob.startsWith("!**/")).map((glob) => glob.slice("!**/".length));
    byRule.set(path.basename(plugin.path, ".grit"), excluded);
  }
  return byRule;
}

/** Le nombre de chemins que la baseline portait à la pose (2026-11-10). Il ne peut que BAISSER : en ajouter échoue. */
const BASELINE_CEILING: Record<string, number> = { "no-sleep-in-tests": 27, "no-unknown-returns": 1 };

test("anti-slop/AC-8 : la baseline ne fait que décroître — aucun chemin ajouté, aucun chemin qui ne viole plus sa règle", (t) => {
  const byRule = baselineByRule();
  assert.deepEqual([...byRule.keys()].sort(), Object.keys(BASELINE_CEILING).sort(), "règle baselinée sans plafond");
  for (const [rule, files] of byRule) {
    assert.ok(
      files.length <= BASELINE_CEILING[rule]!,
      `${rule} : ${files.length} chemins pour un plafond de ${BASELINE_CEILING[rule]} — corrige le code, n'ajoute pas à la baseline`,
    );
    assert.deepEqual(files, [...new Set(files)].sort(), `${rule} : chemins triés et uniques`);
    for (const file of files) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${rule} : ${file} n'existe plus — retire-le de la baseline`);
    }
  }
  if (outilEpingleAbsent(t, "biome")) return;

  // Chaque chemin listé viole TOUJOURS sa règle (jugée sans périmètre ni exclusion) : sinon il se retire de la baseline.
  const scratch = tmpdir("anti-slop-baseline-");
  for (const [rule, files] of byRule) {
    const config = {
      root: true,
      files: { includes: ["**"] },
      linter: { enabled: true, rules: { preset: "none" } },
      plugins: [path.join(RULES_DIR, `${rule}.grit`)],
    };
    fs.writeFileSync(path.join(scratch, "biome.jsonc"), JSON.stringify(config));
    const r = biomeLint(ROOT, `--config-path=${scratch}`, ...files.map((file) => path.join(ROOT, file)));
    const violating = new Set(pluginDiagnostics(r.stdout).map((d) => path.relative(ROOT, d.file)));
    const clean = files.filter((file) => !violating.has(file));
    assert.deepEqual(
      clean,
      [],
      `${rule} : ces chemins ne violent plus — retire-les de scripts/biome-rules/baseline.jsonc`,
    );
  }
});

test("anti-slop/AC-9 : l'arbre livré ne porte aucune violation hors baseline, et une nouvelle violation fait échouer lint.sh", (t) => {
  if (outilEpingleAbsent(t, "biome")) return;
  assert.deepEqual(pluginDiagnostics(biomeLint(ROOT).stdout), []);

  // lint.sh (`biome ci --error-on-warnings`) sur un arbre minimal : un fichier NEUF qui attend un délai échoue en
  // désignant la ligne, le même fichier sans attente passe. C'est la propriété que la baseline protège.
  const dir = tree({});
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "scripts", "lint.sh"), path.join(dir, "scripts", "lint.sh"));
  const lint = () =>
    spawnSync("bash", ["scripts/lint.sh"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, MEM0_OMP_LINT_DIR: LINT_DIR },
      timeout: 120_000,
    });
  const file = path.join(dir, "test", "zz-neuf.test.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    'import { setTimeout as sleep } from "node:timers/promises";\n\nexport async function attendre(): Promise<void> {\n  await sleep(50);\n}\n',
  );
  const red = lint();
  assert.equal(red.status, 1, `${red.stdout}${red.stderr}`);
  const report = `${red.stdout}${red.stderr}`;
  assert.match(report, /^test\/zz-neuf\.test\.ts:4:3 plugin/m, report);
  assert.match(report, /anti-slop\/no-sleep-in-tests/, report);

  fs.writeFileSync(file, "export async function attendre(): Promise<void> {\n  await Promise.resolve();\n}\n");
  const green = lint();
  assert.equal(green.status, 0, `${green.stdout}${green.stderr}`);
});
