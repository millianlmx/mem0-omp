// Tests de la sélection des tests par le diff : `scripts/test-files.sh
// --scope=changed[=<base>]` / `--scope=files` / `--macos` / `--scope=outillage`
// et `scripts/test-ac.sh`.
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
  // Un check.sh de fixture, jamais lancé : seul son NOM compte pour la règle (d).
  fs.writeFileSync(path.join(dir, "scripts", "check.sh"), "#!/usr/bin/env bash\nexit 0\n");
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
  fs.writeFileSync(
    path.join(dir, "test", "a", "ios-ecran.test.ts"),
    'import test from "node:test";\ntest("ios/AC-9 : écran", () => {});\n',
  );
  // Un test de feature dont le slug figure dans le contrat.
  fs.writeFileSync(
    path.join(dir, "test", "req", "ma-feature.test.ts"),
    'import test from "node:test";\ntest("ma-feature/AC-1 : contrat", () => {});\n',
  );
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

/**
 * Ajoute (et commite) un module intermédiaire : service.ts importe chain.ts, et
 * service.test.ts importe service.ts sans jamais nommer chain. C'est la règle (b').
 */
function withService(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "src", "service.ts"),
    'import { chain } from "./chain.ts";\nexport const service = chain;\n',
  );
  fs.writeFileSync(
    path.join(dir, "test", "a", "service.test.ts"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { service } from "../../src/service.ts";',
      'test("service/AC-1 : le service répond", () => { assert.equal(service, 1); });',
      "",
    ].join("\n"),
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "service"]);
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} :\n${res.stdout}${res.stderr}`);
  return res.stdout;
}

function run(cwd: string, script: string, args: string[]) {
  const res = spawnSync("bash", [`scripts/${script}`, ...args], {
    cwd,
    env: childEnv(GIT_ENV),
    encoding: "utf8",
    timeout: 120_000,
  });
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
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=changed"]).stdout), [
    "test/a/chain.test.ts",
    "test/a/other.test.ts",
  ]);
});

test(`${SLUG}/AC-2 : un diff vide ou une base inconnue replie sur la liste complète hors outillage, avec un message`, () => {
  const dir = makeRepo();

  const empty = run(dir, "test-files.sh", ["--scope=changed"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(lines(empty.stdout), [
    "test/a/chain.test.ts",
    "test/a/ios-ecran.test.ts",
    "test/a/other.test.ts",
    "test/req/ma-feature.test.ts",
  ]);
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

test(`${SLUG}/AC-6 : --scope=files applique les règles a/b/c à la liste reçue, et un vide y est légitime (sortie 0)`, () => {
  const dir = makeRepo();
  // Sans diff : la liste vient d'argv. (b) un source nommé, (a) un test, (c) omp-console/.
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=files", "src/chain.ts"]).stdout), [
    "test/a/chain.test.ts",
  ]);
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=files", "test/a/other.test.ts", "src/chain.ts"]).stdout), [
    "test/a/chain.test.ts",
    "test/a/other.test.ts",
  ]);
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=files", "omp-console/App.swift"]).stdout), [
    "test/a/ios-ecran.test.ts",
  ]);
  // Un test d'outillage reçu directement reste exclu.
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=files", "test/a/outil.test.ts"]).stdout), []);

  // Liste vide ou fichiers que nul test ne nomme : rien sur stdout, message, sortie 0 (pas de repli).
  for (const args of [["--scope=files"], ["--scope=files", "LICENSE"]]) {
    const res = run(dir, "test-files.sh", args);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /rien à lancer/);
  }
  // Les chemins viennent après l'option, jamais avant.
  assert.equal(run(dir, "test-files.sh", ["src/chain.ts", "--scope=files"]).status, 1);
});

test(`${SLUG}/AC-7 : test-touched.sh lance les seuls tests que les fichiers concernent, et sort 0 sans rien lancer à vide`, () => {
  const dir = makeRepo();
  fs.copyFileSync(path.join(ROOT, "scripts", "test-touched.sh"), path.join(dir, "scripts", "test-touched.sh"));

  const other = run(dir, "test-touched.sh", ["src/other.ts"]);
  assert.equal(other.status, 0, `${other.stdout}${other.stderr}`);
  assert.match(other.stdout, /^ok \d+ - autre\/AC-2/m);
  assert.doesNotMatch(other.stdout, /chaine\/AC-1/);

  // chain.test.ts porte un AC rouge : le code de node --test est rendu tel quel.
  const chain = run(dir, "test-touched.sh", ["src/chain.ts"]);
  assert.equal(chain.status, 1);
  assert.match(chain.stdout, /^not ok \d+ - chaine\/AC-3/m);

  for (const args of [[], ["LICENSE"]]) {
    const res = run(dir, "test-touched.sh", args);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /rien à lancer/);
  }
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

test(`${SLUG}/AC-8 : (b') un test dont les imports relatifs atteignent le module modifié est retenu sans le nommer`, () => {
  const dir = makeRepo();
  withService(dir);
  fs.appendFileSync(path.join(dir, "src", "chain.ts"), "export const plus = 2;\n");

  const changed = run(dir, "test-files.sh", ["--scope=changed"]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.deepEqual(lines(changed.stdout), ["test/a/chain.test.ts", "test/a/service.test.ts"]);

  // La même clôture pour une liste reçue en argv ; other.test.ts n'importe pas chain.
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=files", "src/chain.ts"]).stdout), [
    "test/a/chain.test.ts",
    "test/a/service.test.ts",
  ]);
  // service.ts seul : service.test.ts le nomme (b), chain.test.ts ne l'importe pas.
  fs.appendFileSync(path.join(dir, "src", "service.ts"), "export const plus = 2;\n");
  git(dir, ["checkout", "--", "src/chain.ts"]);
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=changed"]).stdout), ["test/a/service.test.ts"]);
});

test(`${SLUG}/AC-9 : (d) package.json ou scripts/check.sh dans le diff rend la liste complète hors outillage, avec le message`, () => {
  const dir = makeRepo();
  const everything = [
    "test/a/chain.test.ts",
    "test/a/ios-ecran.test.ts",
    "test/a/other.test.ts",
    "test/req/ma-feature.test.ts",
  ];

  fs.appendFileSync(path.join(dir, "package.json"), "\n");
  const pkg = run(dir, "test-files.sh", ["--scope=changed"]);
  assert.equal(pkg.status, 0, pkg.stderr);
  assert.deepEqual(lines(pkg.stdout), everything);
  assert.equal(pkg.stderr, "· package.json dans le diff : liste complète hors outillage\n");

  fs.appendFileSync(path.join(dir, "scripts", "check.sh"), "# touché\n");
  const both = run(dir, "test-files.sh", ["--scope=changed"]);
  assert.deepEqual(lines(both.stdout), everything);
  assert.equal(both.stderr, "· package.json, scripts/check.sh dans le diff : liste complète hors outillage\n");

  // La même règle pour une liste reçue en argv.
  const files = run(dir, "test-files.sh", ["--scope=files", "scripts/check.sh"]);
  assert.deepEqual(lines(files.stdout), everything);
  assert.equal(files.stderr, "· scripts/check.sh dans le diff : liste complète hors outillage\n");
});

test(`${SLUG}/AC-10 : --macos réduit la sélection (et ses replis) aux tests macOS, et ne s'emploie qu'avec changed ou files`, () => {
  const dir = makeRepo();

  // Repli « diff vide » : la liste complète, réduite aux tests macOS.
  const empty = run(dir, "test-files.sh", ["--scope=changed", "--macos"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(lines(empty.stdout), ["test/a/ios-ecran.test.ts"]);
  assert.match(empty.stderr, /diff vide/);

  // Seul chain.ts bouge : la sélection réduite est vide, et c'est « rien à lancer ».
  fs.appendFileSync(path.join(dir, "src", "chain.ts"), "export const plus = 2;\n");
  const none = run(dir, "test-files.sh", ["--scope=changed", "--macos"]);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, "");
  assert.equal(none.stderr, "· aucun test ne concerne ces fichiers : rien à lancer\n");

  // omp-console/ bouge aussi : seul le test macOS reste.
  fs.appendFileSync(path.join(dir, "omp-console", "App.swift"), "let plus = 2\n");
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=changed", "--macos"]).stdout), [
    "test/a/ios-ecran.test.ts",
  ]);
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=files", "--macos", "omp-console/App.swift"]).stdout), [
    "test/a/ios-ecran.test.ts",
  ]);
  const filesNone = run(dir, "test-files.sh", ["--scope=files", "--macos", "src/chain.ts"]);
  assert.equal(filesNone.status, 0, filesNone.stderr);
  assert.equal(filesNone.stdout, "");
  assert.match(filesNone.stderr, /rien à lancer/);

  // Hors changed/files : refus explicite, rien sur stdout.
  for (const args of [["--macos"], ["--scope=macos", "--macos"], ["--scope=outillage", "--macos"]]) {
    const res = run(dir, "test-files.sh", args);
    assert.equal(res.status, 1, args.join(" "));
    assert.equal(res.stdout, "");
    assert.equal(res.stderr, "✗ --macos ne s'emploie qu'avec --scope=changed ou --scope=files\n");
  }
});

test(`${SLUG}/AC-11 : un diff non vide que nul test ne concerne sort 0, stdout vide, « rien à lancer »`, () => {
  const dir = makeRepo();
  const expectNothing = (label: string) => {
    const res = run(dir, "test-files.sh", ["--scope=changed"]);
    assert.equal(res.status, 0, `${label} : ${res.stderr}`);
    assert.equal(res.stdout, "", label);
    assert.equal(res.stderr, "· aucun test ne concerne ces fichiers : rien à lancer\n", label);
  };
  // Un fichier non suivi que rien ne nomme.
  fs.writeFileSync(path.join(dir, "LICENSE"), "MIT\n");
  expectNothing("LICENSE non suivi");
  // Le même fichier commité puis modifié : le diff est non vide, et toujours sans test.
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "licence"]);
  fs.appendFileSync(path.join(dir, "LICENSE"), "2026\n");
  expectNothing("LICENSE modifié");
});

test(`${SLUG}/AC-12 : (c) un .md sous omp-console/ ne retient pas les tests macOS`, () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "omp-console", "README.md"), "# App\n");
  const alone = run(dir, "test-files.sh", ["--scope=changed"]);
  assert.equal(alone.status, 0, alone.stderr);
  assert.equal(alone.stdout, "");
  assert.match(alone.stderr, /rien à lancer/);

  fs.appendFileSync(path.join(dir, "src", "chain.ts"), "export const plus = 2;\n");
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=changed"]).stdout), ["test/a/chain.test.ts"]);
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=files", "omp-console/README.md"]).stdout), []);

  // Un fichier non-.md de omp-console/ garde la règle (c).
  fs.appendFileSync(path.join(dir, "omp-console", "App.swift"), "let plus = 2\n");
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=changed"]).stdout), [
    "test/a/chain.test.ts",
    "test/a/ios-ecran.test.ts",
  ]);
});

test(`${SLUG}/AC-13 : --with-outillage retient les tests d'outillage par les mêmes règles, replis compris, avec changed ou files seulement`, () => {
  const dir = makeRepo();

  // (a) touché directement : retenu, là où `changed` seul l'exclut (AC-3).
  fs.appendFileSync(path.join(dir, "test", "a", "outil.test.ts"), "// touché\n");
  assert.deepEqual(lines(run(dir, "test-files.sh", ["--scope=changed"]).stdout), []);
  const touched = run(dir, "test-files.sh", ["--scope=changed", "--with-outillage"]);
  assert.equal(touched.status, 0, touched.stderr);
  assert.deepEqual(lines(touched.stdout), ["test/a/outil.test.ts"]);
  assert.deepEqual(
    lines(run(dir, "test-files.sh", ["--scope=files", "--with-outillage", "test/a/outil.test.ts"]).stdout),
    ["test/a/outil.test.ts"],
  );

  // (d) et les replis : la liste complète le comprend, et le message le dit.
  fs.appendFileSync(path.join(dir, "scripts", "check.sh"), "# touché\n");
  const whole = run(dir, "test-files.sh", ["--scope=changed", "--with-outillage"]);
  assert.deepEqual(lines(whole.stdout), [
    "test/a/chain.test.ts",
    "test/a/ios-ecran.test.ts",
    "test/a/other.test.ts",
    "test/a/outil.test.ts",
    "test/req/ma-feature.test.ts",
  ]);
  assert.equal(whole.stderr, "· scripts/check.sh dans le diff : liste complète\n");
  const empty = run(makeRepo(), "test-files.sh", ["--scope=changed", "--with-outillage"]);
  assert.ok(lines(empty.stdout).includes("test/a/outil.test.ts"), empty.stdout);
  assert.equal(empty.stderr, "· diff vide depuis la base : liste complète\n");

  // `--macos` se combine : macOS ∩ diff, outillage compris, mais rien ici n'est macOS.
  assert.equal(
    run(dir, "test-files.sh", ["--scope=changed", "--with-outillage", "--macos"]).stdout,
    "test/a/ios-ecran.test.ts\n",
  );

  // Hors changed/files : refusé, sans rien sur stdout.
  const refused = run(dir, "test-files.sh", ["--scope=macos", "--with-outillage"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.equal(refused.stderr, "✗ --with-outillage ne s'emploie qu'avec --scope=changed ou --scope=files\n");
});
