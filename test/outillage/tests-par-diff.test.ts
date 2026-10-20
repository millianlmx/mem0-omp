// Tests de la sélection des tests par le diff : `scripts/test-files.sh
// --scope=changed[=<base>]` / `--scope=outillage` et `scripts/test-ac.sh`.
//
// Tout tourne dans un dépôt git MINIMAL (quelques fichiers, jamais une copie du
// dépôt) : ce qu'on prouve, c'est la règle de sélection et la lecture du TAP,
// pas la suite du dépôt. Les scripts sont copiés tels quels depuis scripts/.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { GIT_ENV, emptyGitRepo } from "../support/git.ts";
import { ROOT, childEnv } from "../support/repo.ts";

const SLUG = "tests-par-diff";

/** Un dépôt jetable : deux modules, trois tests, un test d'outillage, un contrat. */
function makeRepo(): string {
  const dir = emptyGitRepo("tests-par-diff-");
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const script of ["test-files.sh", "test-ac.sh"]) {
    fs.copyFileSync(path.join(ROOT, "scripts", script), path.join(dir, "scripts", script));
  }
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "test", "a"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test", "req"), { recursive: true });
  fs.mkdirSync(path.join(dir, "omp-console"));
  fs.writeFileSync(path.join(dir, "src", "chain.ts"), "export const chain = 1;\n");
  fs.writeFileSync(path.join(dir, "src", "other.ts"), "export const other = 2;\n");
  fs.writeFileSync(path.join(dir, "omp-console", "App.swift"), "let app = 1\n");
  // Le test qui nomme le module modifié : un AC vert (AC-1) et un AC rouge (AC-3).
  fs.writeFileSync(
    path.join(dir, "test", "a", "chain.test.ts"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { chain } from "../../src/chain.ts";',
      'test("chaine/AC-1 : le module répond", () => { assert.equal(chain, 1); });',
      'test("chaine/AC-3 : un critère qui tombe", () => { assert.equal(chain, 2); });',
      "",
    ].join("\n"),
  );
  // Le test de l'AUTRE module : il porte AC-2, mais n'est pas dans le diff.
  fs.writeFileSync(
    path.join(dir, "test", "a", "other.test.ts"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { other } from "../../src/other.ts";',
      'test("autre/AC-2 : le module répond", () => { assert.equal(other, 2); });',
      "",
    ].join("\n"),
  );
  // Un test macOS (préfixe `ios-`) sans import : retenu seulement si omp-console/ bouge.
  fs.writeFileSync(path.join(dir, "test", "a", "ios-ecran.test.ts"), 'import test from "node:test";\ntest("ios/AC-9 : écran", () => {});\n');
  // Un test de feature dont le slug figure dans le contrat.
  fs.writeFileSync(path.join(dir, "test", "req", "ma-feature.test.ts"), 'import test from "node:test";\ntest("ma-feature/AC-1 : contrat", () => {});\n');
  // Un test d'outillage : il relance check.sh entier, jamais dans `changed`. Le
  // tableau d'arguments à un seul élément (`scripts/check.sh` sans option) est
  // construit à l'exécution, sinon CE fichier serait lui-même classé outillage.
  const gateArgs = JSON.stringify([`scripts/${"check.sh"}`]);
  fs.writeFileSync(
    path.join(dir, "test", "a", "outil.test.ts"),
    `import test from "node:test";\nimport { spawnSync } from "node:child_process";\ntest("outil/AC-1 : gate", () => { spawnSync("bash", ${gateArgs}); });\n`,
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "fixture"]);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} :\n${res.stdout}${res.stderr}`);
  return res.stdout;
}

function run(cwd: string, script: string, args: string[]) {
  const res = spawnSync("bash", [`scripts/${script}`, ...args], { cwd, env: childEnv(GIT_ENV), encoding: "utf8", timeout: 120_000 });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

test(`${SLUG}/AC-1 : --scope=changed retient le test qui nomme le module modifié, et pas les autres`, () => {
  const dir = makeRepo();
  fs.appendFileSync(path.join(dir, "src", "chain.ts"), "export const plus = 2;\n");

  const res = run(dir, "test-files.sh", ["--scope=changed"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(lines(res.stdout), ["test/a/chain.test.ts"]);
  assert.equal(res.stderr, "");

  // La même sélection depuis une base explicite (le commit de la fixture).
  const head = git(dir, ["rev-parse", "HEAD"]).trim();
  assert.deepEqual(lines(run(dir, "test-files.sh", [`--scope=changed=${head}`]).stdout), ["test/a/chain.test.ts"]);

  // Un fichier de test du diff est retenu pour lui-même, même sans module modifié.
  fs.appendFileSync(path.join(dir, "test", "a", "other.test.ts"), "// touché\n");
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=changed"]).stdout), ["test/a/chain.test.ts", "test/a/other.test.ts"]);
});

test(`${SLUG}/AC-2 : un diff vide ou une base inconnue replie sur la liste complète hors outillage, avec un message`, () => {
  const dir = makeRepo();

  const empty = run(dir, "test-files.sh", ["--scope=changed"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(lines(empty.stdout), ["test/a/chain.test.ts", "test/a/ios-ecran.test.ts", "test/a/other.test.ts", "test/req/ma-feature.test.ts"]);
  assert.match(empty.stderr, /diff vide/);

  const unknown = run(dir, "test-files.sh", ["--scope=changed=revision-inconnue"]);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.deepEqual(lines(unknown.stdout), lines(empty.stdout));
  assert.match(unknown.stderr, /git diff --name-only revision-inconnue a échoué/);
  assert.match(unknown.stderr, /repli : liste complète/);

  // Hors dépôt git : même repli, même message.
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  const nogit = run(dir, "test-files.sh", ["--scope=changed"]);
  assert.equal(nogit.status, 0, nogit.stderr);
  assert.deepEqual(lines(nogit.stdout), lines(empty.stdout));
  assert.match(nogit.stderr, /git absent ou hors dépôt/);
});

test(`${SLUG}/AC-3 : --scope=outillage liste les tests qui relancent check.sh entier, et --scope=changed ne les inclut jamais`, () => {
  const dir = makeRepo();
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=outillage"]).stdout), ["test/a/outil.test.ts"]);

  // Même touché directement, le test d'outillage reste hors de `changed`.
  fs.appendFileSync(path.join(dir, "test", "a", "outil.test.ts"), "// touché\n");
  fs.appendFileSync(path.join(dir, "src", "chain.ts"), "export const plus = 2;\n");
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=changed"]).stdout), ["test/a/chain.test.ts"]);

  // Sur le dépôt réel : les quatre fichiers connus pour relancer check.sh.
  const real = run(ROOT, "test-files.sh", ["--scope=outillage"]);
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual(lines(real.stdout), [
    "test/outillage/check.test.ts",
    "test/outillage/release-simulation.test.ts",
    "test/outillage/release.test.ts",
  ]);
});

test(`${SLUG}/AC-4 : omp-console/ élargit la sélection`, () => {
  const dir = makeRepo();
  fs.appendFileSync(path.join(dir, "src", "chain.ts"), "export const plus = 2;\n");

  // (c) un fichier de omp-console/ dans le diff retient les tests macOS.
  fs.appendFileSync(path.join(dir, "omp-console", "App.swift"), "let plus = 2\n");
  const withConsole = run(dir, "test-files.sh", ["--scope=changed"]);
  assert.deepEqual(lines(withConsole.stdout), ["test/a/chain.test.ts", "test/a/ios-ecran.test.ts"]);
});

test(`${SLUG}/AC-5 : test-ac.sh prouve chaque AC par les tests du diff en une passe : pass, absent, fail, sortie 1`, () => {
  const dir = makeRepo();
  fs.appendFileSync(path.join(dir, "src", "chain.ts"), "export const plus = 2;\n");

  const res = run(dir, "test-ac.sh", ["AC-1", "AC-2", "AC-3"]);
  assert.equal(res.status, 1, `${res.stdout}${res.stderr}`);
  const out = lines(res.stdout);
  assert.ok(out.includes("AC-1 : test/a/chain.test.ts"), res.stdout);
  assert.ok(out.includes("AC-2 : (aucun test dans le diff)"), res.stdout);
  assert.ok(out.includes("AC-3 : test/a/chain.test.ts"), res.stdout);
  assert.ok(out.includes("AC-1 : pass"), res.stdout);
  assert.ok(out.includes("AC-2 : absent"), res.stdout);
  assert.ok(out.includes("AC-3 : fail"), res.stdout);
  // L'échec est recopié depuis le TAP, pour nommer le test tombé.
  assert.match(res.stdout, /not ok \d+ - chaine\/AC-3/);

  // Un seul AC vert : sortie 0, même si un autre test du fichier tombe.
  const green = run(dir, "test-ac.sh", ["AC-1"]);
  assert.equal(green.status, 0, `${green.stdout}${green.stderr}`);
  assert.ok(lines(green.stdout).includes("AC-1 : pass"), green.stdout);

  // `AC-1` ne compte pas pour `AC-10`, ni un test sauté pour une preuve.
  fs.writeFileSync(
    path.join(dir, "test", "a", "chain.test.ts"),
    [
      'import test from "node:test";',
      'import { chain } from "../../src/chain.ts";',
      'test("chaine/AC-10 : dix", () => { if (chain !== 1) throw new Error("x"); });',
      'test("chaine/AC-4 : sauté", (t) => { t.skip("prérequis"); });',
      "",
    ].join("\n"),
  );
  const edge = run(dir, "test-ac.sh", ["AC-1", "AC-4"]);
  assert.equal(edge.status, 1, `${edge.stdout}${edge.stderr}`);
  assert.ok(lines(edge.stdout).includes("AC-1 : (aucun test dans le diff)"), edge.stdout);
  assert.ok(lines(edge.stdout).includes("AC-1 : absent"), edge.stdout);
  assert.ok(lines(edge.stdout).includes("AC-4 : absent"), edge.stdout);

  // Sans identifiant ou avec un identifiant mal formé : refus explicite.
  assert.equal(run(dir, "test-ac.sh", []).status, 1);
  assert.match(run(dir, "test-ac.sh", ["AC-x"]).stderr, /identifiant invalide/);
});
