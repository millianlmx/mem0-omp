// Tests de la sélection par le diff côté CI : `scripts/ci-scope.sh` (faut-il
// compiler l'app Mac ou iOS pour cette pull_request ?), l'option `--tests-base`
// de `scripts/check.sh` (la section Tests réduite au diff) et la ligne de durée
// que chaque section de check.sh imprime en se fermant.
//
// Tout ce qui lance les scripts tourne dans un dépôt git MINIMAL ou une COPIE
// LÉGÈRE (scripts + fixtures de test), jamais dans la suite réelle ; seule la
// preuve des durées lance deux sections sans fichier de test sur le dépôt réel.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { GIT_ENV, emptyGitRepo } from "../support/git.ts";
import { ROOT, childEnv, tmpdir } from "../support/repo.ts";

const SLUG = "ci-par-diff";
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

/** Un `git` qui doit réussir, dans `cwd`. */
function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} :\n${res.stdout}${res.stderr}`);
  return res.stdout;
}

function run(cwd: string, script: string, args: string[], extra: Record<string, string> = {}) {
  const res = spawnSync("bash", [`scripts/${script}`, ...args], {
    cwd,
    env: childEnv({ ...GIT_ENV, ...extra }),
    encoding: "utf8",
    timeout: 300_000,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

/** Écrit `rel` dans `dir` en créant ses dossiers. */
function write(dir: string, rel: string, content: string): void {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** Un dépôt git minimal portant scripts/ci-scope.sh et un README commité. */
function scopeRepo(): string {
  const dir = emptyGitRepo("ci-scope-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "ci-scope.sh"), path.join(dir, "scripts", "ci-scope.sh"));
  write(dir, "README.md", "# fixture\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "fixture"]);
  return dir;
}

test(`${SLUG}/AC-1 : ci-scope.sh ne fait compiler une app que si le diff touche un de ses préfixes, et compile dans le doute`, () => {
  const dir = scopeRepo();

  // Diff vide : à lancer (sortie 0), sans fichier imprimé.
  const empty = run(dir, "ci-scope.sh", ["--base=HEAD", "app-swift"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, "");
  assert.match(empty.stderr, /diff vide depuis HEAD : app-swift à lancer/);

  // README.md seul : rien ne touche l'app, section sautée (sortie 1), rien sur stdout.
  fs.appendFileSync(path.join(dir, "README.md"), "plus\n");
  for (const section of ["app-swift", "app-ios"]) {
    const skipped = run(dir, "ci-scope.sh", ["--base=HEAD", section]);
    assert.equal(skipped.status, 1, `${section} : ${skipped.stderr}`);
    assert.equal(skipped.stdout, "");
    assert.match(skipped.stderr, new RegExp(`rien du diff depuis HEAD ne touche ${section} .*section sautée`));
  }

  // Chaque préfixe de app-swift impose la section ; app-ios ignore mem0-stack/.
  write(dir, "omp-console/x.swift", "let x = 1\n");
  write(dir, "scripts/y.sh", "exit 0\n");
  write(dir, "mem0-stack/z.rs", "fn main() {}\n");
  write(dir, ".github/workflows/check.yml", "name: check\n");
  const swift = run(dir, "ci-scope.sh", ["--base=HEAD", "app-swift"]);
  assert.equal(swift.status, 0, swift.stderr);
  assert.deepEqual(lines(swift.stdout), [
    ".github/workflows/check.yml",
    "mem0-stack/z.rs",
    "omp-console/x.swift",
    "scripts/y.sh",
  ]);
  const ios = run(dir, "ci-scope.sh", ["--base=HEAD", "app-ios"]);
  assert.equal(ios.status, 0, ios.stderr);
  assert.deepEqual(lines(ios.stdout), [".github/workflows/check.yml", "omp-console/x.swift", "scripts/y.sh"]);

  // mem0-stack/ seul (le reste commité) : app-swift à lancer, app-ios sautée.
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "app"]);
  fs.appendFileSync(path.join(dir, "mem0-stack", "z.rs"), "// plus\n");
  assert.deepEqual(lines(run(dir, "ci-scope.sh", ["--base=HEAD", "app-swift"]).stdout), ["mem0-stack/z.rs"]);
  assert.equal(run(dir, "ci-scope.sh", ["--base=HEAD", "app-ios"]).status, 1);

  // Base inconnue : le doute fait compiler (sortie 0).
  const unknown = run(dir, "ci-scope.sh", ["--base=revision-inconnue", "app-ios"]);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.match(unknown.stderr, /git diff --name-only revision-inconnue a échoué .*: app-ios à lancer/);

  // Usage : sortie 2, rien sur stdout.
  for (const args of [
    [],
    ["app-swift"],
    ["--base=HEAD"],
    ["--base=HEAD", "app-tv"],
    ["--base=HEAD", "app-swift", "app-ios"],
  ]) {
    const usage = run(dir, "ci-scope.sh", args);
    assert.equal(usage.status, 2, args.join(" "));
    assert.equal(usage.stdout, "");
    assert.match(usage.stderr, /^✗ /);
  }
});

/**
 * Copie légère pour `--sections=tests` : check.sh et test-files.sh du dépôt, deux
 * modules, un test par module et un test macOS (préfixe `ios-`), le tout commité.
 */
function lightRepo(): string {
  const dir = tmpdir("ci-tests-base-");
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const script of ["check.sh", "test-files.sh"]) {
    fs.copyFileSync(path.join(ROOT, "scripts", script), path.join(dir, "scripts", script));
  }
  write(dir, "package.json", '{ "type": "module" }\n');
  write(dir, "src/chain.ts", "export const chain = 1;\n");
  write(dir, "src/other.ts", "export const other = 2;\n");
  write(dir, "src/socle.ts", "export const socle = 3;\n");
  write(
    dir,
    "test/a/chain.test.ts",
    'import test from "node:test";\nimport { chain } from "../../src/chain.ts";\ntest("chaine/AC-1 : répond", () => { if (chain !== 1) throw new Error("x"); });\n',
  );
  write(
    dir,
    "test/a/other.test.ts",
    'import test from "node:test";\nimport { other } from "../../src/other.ts";\ntest("autre/AC-1 : répond", () => { if (other !== 2) throw new Error("x"); });\n',
  );
  // Un test que la part 2/2 saute entièrement (motif `^socle-app-swift/` de check.sh).
  write(
    dir,
    "test/a/socle.test.ts",
    'import test from "node:test";\nimport { socle } from "../../src/socle.ts";\ntest("socle-app-swift/AC-1 : répond", () => { if (socle !== 3) throw new Error("x"); });\n',
  );
  write(dir, "test/a/ios-ecran.test.ts", 'import test from "node:test";\ntest("ios/AC-1 : écran", () => {});\n');
  write(dir, "omp-console/App.swift", "let app = 1\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "fixture"]);
  return dir;
}

const CHECK_ENV = {
  MEM0_CHECK_DEPTH: String(DEPTH + 1),
  MEM0_OMP_SKIP_SWIFT_APP: "1",
  MEM0_OMP_SKIP_IOS: "1",
  MEM0_OMP_SKIP_RUST: "1",
  MEM0_OMP_REQUIRE_SMOKE: "",
  MEM0_OMP_REQUIRE_RUST: "",
  MEM0_OMP_REQUIRE_IOS: "",
};

const checkTests = (dir: string, args: string[]) => run(dir, "check.sh", ["--sections=tests", ...args], CHECK_ENV);

test(`${SLUG}/AC-2 : check.sh --tests-base réduit la section Tests au diff, et un diff sans test est vert, jamais rouge`, () => {
  const dir = lightRepo();

  // Un seul source modifié : seul le test qui le nomme est lancé.
  fs.appendFileSync(path.join(dir, "src", "chain.ts"), "export const plus = 2;\n");
  const one = checkTests(dir, ["--tests-base=HEAD"]);
  assert.equal(one.status, 0, `${one.stdout}${one.stderr}`);
  const out = lines(one.stdout);
  assert.ok(out.includes("  · 1 fichier(s) de test : test/a/chain.test.ts"), one.stdout);
  assert.ok(out.includes("  ✓ tests unitaires (mémoire, harness, client du harness, console, outillage)"), one.stdout);
  assert.ok(!one.stdout.includes("other.test.ts"), one.stdout);
  git(dir, ["checkout", "--", "src/chain.ts"]);

  // Un diff que nul test ne concerne : message de test-files.sh recopié, section verte, sortie 0.
  write(dir, "LICENSE", "MIT\n");
  const none = checkTests(dir, ["--tests-base=HEAD"]);
  assert.equal(none.status, 0, `${none.stdout}${none.stderr}`);
  assert.deepEqual(
    lines(none.stdout).filter((line) => !/^ {2}· \d+ s$/.test(line)),
    [
      "── Tests",
      "  · aucun test ne concerne ces fichiers : rien à lancer",
      "  · aucun fichier de test concerné par le diff depuis HEAD (--tests-scope=aucun, --tests-part=aucune)",
      "Dépôt prêt à publier.",
    ],
    none.stdout,
  );
  assert.ok(!none.stdout.includes("✗"), none.stdout);

  // --tests-scope=macos --tests-part=2/2 sur un diff sans fichier macOS : même vert.
  const macos = checkTests(dir, ["--tests-scope=macos", "--tests-base=HEAD", "--tests-part=2/2"]);
  assert.equal(macos.status, 0, `${macos.stdout}${macos.stderr}`);
  assert.ok(
    lines(macos.stdout).includes(
      "  · aucun fichier de test concerné par le diff depuis HEAD (--tests-scope=macos, --tests-part=2/2)",
    ),
    macos.stdout,
  );
  assert.ok(!macos.stdout.includes("✗"), macos.stdout);
  fs.rmSync(path.join(dir, "LICENSE"));

  // omp-console/ bouge : la part macOS lance les tests macOS (le test `ios-` et le
  // test `socle-app-swift/`, macOS par son contenu), jamais chain.test.ts.
  fs.appendFileSync(path.join(dir, "omp-console", "App.swift"), "let plus = 2\n");
  fs.appendFileSync(path.join(dir, "src", "chain.ts"), "export const plus = 2;\n");
  const ios = checkTests(dir, ["--tests-scope=macos", "--tests-base=HEAD", "--tests-part=2/2"]);
  assert.equal(ios.status, 0, `${ios.stdout}${ios.stderr}`);
  assert.ok(
    lines(ios.stdout).includes("  · 2 fichier(s) de test : test/a/ios-ecran.test.ts test/a/socle.test.ts"),
    ios.stdout,
  );
  assert.ok(!ios.stdout.includes("chain.test.ts"), ios.stdout);
  git(dir, ["checkout", "--", "."]);

  // Une part dont le filtre de noms ne laisse rien : note, pas d'échec.
  fs.appendFileSync(path.join(dir, "src", "socle.ts"), "export const plus = 2;\n");
  const part = checkTests(dir, ["--tests-base=HEAD", "--tests-part=2/2"]);
  assert.equal(part.status, 0, `${part.stdout}${part.stderr}`);
  assert.ok(lines(part.stdout).includes("  · aucun test du diff depuis HEAD pour --tests-part=2/2"), part.stdout);
  assert.ok(!part.stdout.includes("✗"), part.stdout);
  git(dir, ["checkout", "--", "."]);

  // Sans --tests-base, le même filtre reste un échec nommé.
  const strict = checkTests(dir, ["--tests-scope=macos", "--tests-part=1/2"]);
  assert.equal(strict.status, 1, `${strict.stdout}${strict.stderr}`);
  assert.ok(
    lines(strict.stdout).includes(
      "  ✗ tests unitaires — aucun fichier de test retenu (--tests-scope=macos, --tests-part=1/2)",
    ),
    strict.stdout,
  );

  // Référence vide : erreur d'usage, rien sur stdout.
  const empty = checkTests(dir, ["--tests-base="]);
  assert.equal(empty.status, 1);
  assert.equal(empty.stdout, "");
  assert.equal(empty.stderr, "✗ --tests-base : référence vide (attendu : --tests-base=<réf git>)\n");
});

test(`${SLUG}/AC-3 : chaque section exécutée se ferme par sa durée, et une erreur d'usage n'imprime rien sur stdout`, () => {
  const res = run(ROOT, "check.sh", ["--sections=catalogue,noms"], CHECK_ENV);
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  const out = res.stdout.split("\n");
  const headers = out.map((line, index) => (line.startsWith("── ") ? index : -1)).filter((index) => index !== -1);
  const durations = out.map((line, index) => (/^ {2}· \d+ s$/.test(line) ? index : -1)).filter((index) => index !== -1);
  assert.equal(headers.length, 2, res.stdout);
  assert.equal(durations.length, headers.length, res.stdout);
  for (const [i, header] of headers.entries()) {
    const duration = durations[i]!;
    const end = headers[i + 1] ?? out.indexOf("", header);
    assert.ok(
      duration > header && duration < end,
      `durée de la section ${out[header]} hors de ses lignes :\n${res.stdout}`,
    );
    // La durée ferme la section : juste avant l'en-tête suivant ou la ligne vide finale.
    assert.equal(duration, end - 1, res.stdout);
    assert.ok(!out.slice(header + 1, duration).some((line) => /^ {2}· \d+ s$/.test(line)), res.stdout);
  }
  assert.ok(res.stdout.endsWith("\nDépôt prêt à publier.\n"), res.stdout);

  const usage = run(ROOT, "check.sh", ["--sections=catalogue", "--tests-base="], CHECK_ENV);
  assert.equal(usage.status, 1);
  assert.equal(usage.stdout, "");
  const unknown = run(ROOT, "check.sh", ["--inconnue"], CHECK_ENV);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, "");
  assert.equal(
    unknown.stderr,
    "✗ option inconnue : --inconnue (attendu : --sections=…, --tests-scope=macos, --tests-base=<réf>, --tests-part=1/2|2/2, --strict)\n",
  );
});

test(`${SLUG}/AC-4 : en vert, la section Tests nomme ses tests de 2 s ou plus, et se tait quand il n'y en a pas`, () => {
  const dir = lightRepo();
  // Des tests courts seulement : aucune ligne.
  const quick = checkTests(dir, []);
  assert.equal(quick.status, 0, `${quick.stdout}${quick.stderr}`);
  assert.ok(!quick.stdout.includes("tests les plus longs"), quick.stdout);

  // Un test de 2,3 s et un autre de 0 s : seul le premier est nommé, en secondes
  // entières. L'attente est RÉELLE, à dessein : la ligne lit le `duration_ms` que
  // node mesure à l'horloge, qu'aucune horloge factice ne ferait avancer.
  write(
    dir,
    "test/a/lent.test.ts",
    [
      'import test from "node:test";',
      'import { setTimeout as sleep } from "node:timers/promises";',
      'test("lent/AC-1 : attend", async () => { await sleep(2300); });',
      'test("lent/AC-2 : répond", () => {});',
      "",
    ].join("\n"),
  );
  const slow = checkTests(dir, []);
  assert.equal(slow.status, 0, `${slow.stdout}${slow.stderr}`);
  const summary = lines(slow.stdout).filter((line) => line.startsWith("  · tests les plus longs :"));
  assert.equal(summary.length, 1, slow.stdout);
  assert.equal(summary[0], "  · tests les plus longs : 2 s lent/AC-1 : attend");
  // La ligne précède le ✓ de la section, après le compte des sauts.
  const out = lines(slow.stdout);
  assert.ok(
    out.indexOf(summary[0]!) <
      out.indexOf("  ✓ tests unitaires (mémoire, harness, client du harness, console, outillage)"),
    slow.stdout,
  );
});
