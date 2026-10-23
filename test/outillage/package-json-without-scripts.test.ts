// Tests du package.json racine : les alias `npm run check`, `npm run typecheck`
// et `npm test` ne sont que des raccourcis vers scripts/check.sh et
// scripts/typecheck.sh — même sortie, même code, arguments après `--` transmis.
//
// Chaque test qui lance un script travaille dans une COPIE JETABLE élaguée de
// tous ses fichiers de test : la section `── Tests` d'une copie ne lance donc que
// le test fixture planté ici (test/npm/alias.test.ts), jamais la suite réelle.
// Les comparaisons strictes de sortie se font en `npm --silent` : sans lui, npm
// imprime sa bannière `> check` sur stdout.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, childEnv, copyRepo } from "../support/repo.ts";

/** Sans NODE_TEST_CONTEXT : le `node --test` lancé par check.sh exécute vraiment ses fichiers. */
const ENV = childEnv({ npm_config_update_notifier: "false" });

function npm(cwd: string, args: string[], timeout = 600_000): SpawnSyncReturns<string> {
  return spawnSync("npm", args, { cwd, encoding: "utf8", env: ENV, timeout });
}

function bash(cwd: string, args: string[], timeout = 600_000): SpawnSyncReturns<string> {
  return spawnSync("bash", args, { cwd, encoding: "utf8", env: ENV, timeout });
}

const output = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

/**
 * stdout sans les lignes de durée `  · <n> s` que check.sh ferme chaque section
 * avec : deux lancements n'ont aucune raison de rendre la même seconde entière.
 */
const sansDurees = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => !/^ {2}· \d+ s$/.test(line))
    .join("\n");

/** Copie du dépôt sans aucun fichier de test. */
const prunedCopy = (): string => copyRepo("npm-alias-", { keepTest: () => false });

/** Fichier que le test fixture vert écrit à la racine de la copie : la preuve qu'il a tourné. */
const RAN_MARKER = "npm-test-a-tourne";

const FIXTURE_REL = "test/npm/alias.test.ts";

const GREEN_BODY = `test("alias npm : test fixture vert", () => {
  fs.writeFileSync(${JSON.stringify(RAN_MARKER)}, "1");
  assert.equal(1, 1);
});
`;

const RED_BODY = `test("alias npm : assertion volontairement faussée", () => {
  assert.equal(1, 2);
});
`;

/** Plante dans la copie l'unique fichier de test que la section `── Tests` retiendra. */
function fixture(dir: string, body: string): void {
  const file = path.join(dir, FIXTURE_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport fs from "node:fs";\n${body}`,
  );
}

const HOST_TYPES_ABSENT = "types de l'hôte absents";

test("package-json-without-scripts/AC-4 : le package.json racine est privé et ne porte que les alias vers scripts/", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(manifest, {
    private: true,
    type: "module",
    scripts: {
      check: "bash scripts/check.sh",
      typecheck: "bash scripts/typecheck.sh",
      test: "bash scripts/check.sh --sections=tests",
      "test:touched": "bash scripts/test-touched.sh",
    },
  });
});

test("package-json-without-scripts/AC-3 : npm run check -- --sections=<id> ne lance que la section demandée, comme check.sh", () => {
  const dir = prunedCopy();
  const n = npm(dir, ["--silent", "run", "check", "--", "--sections=catalogue"]);
  const b = bash(dir, ["scripts/check.sh", "--sections=catalogue"]);
  assert.equal(b.status, 0, output(b));
  assert.equal(n.status, 0, output(n));
  assert.equal(sansDurees(n.stdout), sansDurees(b.stdout));
  assert.ok(n.stdout.includes("── Catalogue marketplace"), n.stdout);
  assert.ok(!n.stdout.includes("── Noms"), n.stdout);
  assert.ok(!n.stdout.includes("── Tests"), n.stdout);
});

test("package-json-without-scripts/AC-1 : npm run check rend la sortie et le code non nul de check.sh quand une section échoue", () => {
  const dir = prunedCopy();
  fs.appendFileSync(path.join(dir, ".claude-plugin/marketplace.json"), "\n");
  const n = npm(dir, ["run", "check", "--", "--sections=catalogue"]);
  const b = bash(dir, ["scripts/check.sh", "--sections=catalogue"]);
  assert.notEqual(b.status, 0, output(b));
  assert.equal(n.status, b.status, output(n));
  assert.ok(b.stdout.includes("les catalogues .omp-plugin et .claude-plugin ont divergé"), output(b));
  assert.ok(sansDurees(n.stdout).includes(sansDurees(b.stdout)), `npm :\n${n.stdout}\ncheck.sh :\n${b.stdout}`);
});

test("package-json-without-scripts/AC-2 : npm run typecheck sort 0 sur une copie verte et non nul sur une erreur de type plantée", (t) => {
  const dir = prunedCopy();
  const green = npm(dir, ["--silent", "run", "typecheck"], 900_000);
  if (output(green).includes(HOST_TYPES_ABSENT)) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.equal(green.status, 0, output(green));
  assert.ok(!output(green).includes("error TS"), output(green));

  const target = path.join(dir, "omp-mem0-memory/state.ts");
  fs.writeFileSync(target, `const q: number = "boom";\n${fs.readFileSync(target, "utf8")}`);
  const red = npm(dir, ["--silent", "run", "typecheck"], 900_000);
  assert.notEqual(red.status, 0, output(red));
  assert.ok(output(red).includes("error TS2322"), output(red));
});

test("package-json-without-scripts/AC-6 : npm test exécute réellement la section Tests et sort 0 sur un dépôt vert", () => {
  const dir = prunedCopy();
  fixture(dir, GREEN_BODY);
  const marker = path.join(dir, RAN_MARKER);

  const n = npm(dir, ["--silent", "test"]);
  assert.equal(n.status, 0, output(n));
  assert.ok(fs.existsSync(marker), `le test fixture n'a pas tourné :\n${output(n)}`);
  assert.ok(n.stdout.includes(`  · 1 fichier(s) de test : ${FIXTURE_REL}`), n.stdout);
  assert.ok(n.stdout.includes("  ✓ tests unitaires"), n.stdout);

  fs.rmSync(marker);
  const b = bash(dir, ["scripts/check.sh", "--sections=tests"]);
  assert.equal(b.status, 0, output(b));
  assert.equal(sansDurees(n.stdout), sansDurees(b.stdout));
});

test("package-json-without-scripts/AC-5 : npm test sort non nul et nomme le test en échec quand une assertion est faussée", () => {
  const dir = prunedCopy();
  fixture(dir, RED_BODY);
  const n = npm(dir, ["test"]);
  assert.notEqual(n.status, 0, output(n));
  assert.ok(n.stdout.includes("not ok 1 - alias npm : assertion volontairement faussée"), output(n));
  assert.ok(n.stdout.includes("node --test a rendu"), output(n));
});

test("package-json-without-scripts/AC-7 : npm test -- <option> transmet --tests-part et --tests-scope à check.sh", () => {
  const dir = prunedCopy();
  fixture(dir, GREEN_BODY);
  // Dans la copie élaguée, le test fixture n'est ni check.test.ts (seul fichier de
  // la part 1/2) ni un test macOS : chaque option laisse `── Tests` sans fichier,
  // et la ligne qui le dit est la preuve que l'option est arrivée à check.sh.
  const cases: Array<[string, string]> = [
    ["--tests-part=1/2", "  ✗ tests unitaires — aucun fichier de test retenu (--tests-scope=aucun, --tests-part=1/2)"],
    [
      "--tests-scope=macos",
      "  ✗ tests unitaires — scripts/test-files.sh a échoué (relance : bash scripts/test-files.sh --scope=macos)",
    ],
  ];
  for (const [arg, verdict] of cases) {
    const n = npm(dir, ["--silent", "test", "--", arg]);
    const b = bash(dir, ["scripts/check.sh", "--sections=tests", arg]);
    assert.notEqual(b.status, 0, `${arg} : ${output(b)}`);
    assert.equal(n.status, b.status, `${arg} : ${output(n)}`);
    assert.equal(sansDurees(n.stdout), sansDurees(b.stdout), arg);
    const lines = n.stdout.split("\n");
    assert.ok(lines.includes(verdict), `${arg} : ${output(n)}`);
    assert.ok(!n.stderr.includes("option inconnue"), `${arg} : ${n.stderr}`);
    assert.ok(!b.stderr.includes("option inconnue"), `${arg} : ${b.stderr}`);
  }
  assert.ok(
    !fs.existsSync(path.join(dir, RAN_MARKER)),
    "le test fixture a tourné alors que le filtre ne retenait rien",
  );
});

test("package-json-without-scripts/AC-8 : DEVELOPPEMENT.md associe npm run check, npm run typecheck et npm test au script qu'ils lancent", () => {
  // Espaces repliés : le paragraphe de DEVELOPPEMENT.md coupe ses phrases en fin de ligne.
  const readme = fs.readFileSync(path.join(ROOT, "DEVELOPPEMENT.md"), "utf8").replace(/\s+/g, " ");
  for (const [command, script] of [
    ["npm run check", "bash scripts/check.sh"],
    ["npm run typecheck", "bash scripts/typecheck.sh"],
    ["npm test", "bash scripts/check.sh --sections=tests"],
    ["npm run test:touched -- <fichiers…>", "bash scripts/test-touched.sh"],
  ]) {
    assert.ok(
      readme.includes(`\`${command}\` lance \`${script}\``),
      `DEVELOPPEMENT.md : « \`${command}\` lance \`${script}\` » absent`,
    );
  }
});

test("package-json-without-scripts/AC-9 : check.sh garde les sections de la base (plus `lint` de no-ts-lint-formatter) et ne contrôle pas les alias npm", () => {
  const checkSh = fs.readFileSync(path.join(ROOT, "scripts", "check.sh"), "utf8");
  const line = checkSh.match(/^SECTION_IDS="([^"]*)"$/m);
  assert.ok(line, 'ligne SECTION_IDS="…" introuvable dans scripts/check.sh');
  assert.deepEqual(line[1].split(/\s+/), [
    "catalogue",
    "noms",
    "plugins",
    "versions",
    "extension",
    "types",
    "lint",
    "rust",
    "smoke",
    "tests",
    "noyau",
    "app-swift",
    "app-ios",
  ]);
  for (const needle of ["npm run", "npm test", '"scripts"']) {
    assert.ok(!checkSh.includes(needle), `scripts/check.sh contient ${needle}`);
  }
});
