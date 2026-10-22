// Critères de la feature ci-macos-jobs-paralleles : les options de sélection de
// `scripts/check.sh` (`--sections`, `--tests-scope`, `--tests-part`), la règle
// unique de `scripts/test-files.sh --scope=macos`, et la forme du workflow
// `.github/workflows/check.yml` qui s'en sert pour éclater le contrôle macOS en
// jobs parallèles jugés par un agrégateur (`scripts/ci-verdict.sh`).
//
// Deux règles structurent ce fichier, comme test/outillage/check.test.ts :
//  1. ce qui lance `check.sh` sur une suite de tests tourne dans une COPIE
//     jetable dont le dossier test/ ne contient que des fixtures — jamais la
//     vraie suite, que `── Tests` relancerait ;
//  2. ce qui porte sur l'arbre réel, ou relance `check.sh`, ne s'exécute qu'au
//     premier niveau (`MEM0_CHECK_DEPTH`) : les copies d'autres tests élaguent
//     test/ et relancent cette suite.
//
// Les sources des fixtures sont assemblées par concaténation, jamais écrites en
// début de ligne sous la forme `test("…")` : le scanner de criteria/AC-13 (et
// celui d'AC-5 ci-dessous) les prendrait pour des tests de ce fichier.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { LINT_TOOL_ENV, linkPinnedTypescript, listTestFiles } from "../support/repo.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");
const NESTED = "copie jetable — l'arbre réel est éprouvé au premier niveau";

/** Les 13 en-têtes de check.sh, dans l'ordre d'exécution (S-1). */
const HEADERS = [
  "── Catalogue marketplace",
  "── Noms",
  "── Plugins",
  "── Versions",
  "── Extension",
  "── Types",
  "── Lint TypeScript",
  "── Rust mem0-rs",
  "── Plugins réels (OMP)",
  "── Tests",
  "── Noyau partagé",
  "── App Swift",
  "── App iOS",
];

/** La règle de S-3, recopiée ici pour juger le script — pas pour le remplacer. */
const MACOS_RULE = /\b(swift|swiftc|xcodebuild|xcrun)\b|swift-app\.sh|ios-build\.sh/;
const PART_SLUGS = /^\s*test\(\s*["'`]socle-app-swift\//m;

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  dirs.push(dir);
  return dir;
}

const output = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

/**
 * Environnement des enfants : sans les marqueurs de travailleur de `node:test`
 * (sinon le `node --test` de `── Tests` sort 0 sans rien exécuter, voir
 * test/outillage/release-simulation.test.ts), profondeur incrémentée, compilations Swift
 * et iOS neutralisées, Biome épinglé de la racine (une copie n'emporte pas `.lint/`).
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MEM0_CHECK_DEPTH: String(DEPTH + 1),
    MEM0_OMP_SKIP_SWIFT_APP: "1",
    MEM0_OMP_SKIP_IOS: "1",
    MEM0_OMP_SKIP_RUST: "1",
    ...LINT_TOOL_ENV,
    ...extra,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

function runCheck(cwd: string, args: string[], extra: Record<string, string> = {}) {
  return spawnSync("bash", ["scripts/check.sh", ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv(extra),
    timeout: 900_000,
  });
}

function testFiles(cwd: string, args: string[] = []) {
  return spawnSync("bash", ["scripts/test-files.sh", ...args], { cwd, encoding: "utf8", env: childEnv() });
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "");
// Seuls les 13 en-têtes de section comptent : le harnais de `── Plugins réels`
// imprime ses propres lignes `── <plugin>`.
const headersOf = (text: string) => text.split("\n").filter((line) => HEADERS.includes(line));

/** Les 13 identifiants de section de check.sh (S-1). */
const SECTION_IDS = [
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
];
const MACOS_JOBS = ["macos-app-swift", "macos-app-ios", "macos-tests"];
/** Les jobs macOS ne tournent qu'en pull_request ; l'agrégateur aussi, mais toujours (jamais « skipped »). */
const PULL_REQUEST_IF = "github.event_name == 'pull_request'";
const AGGREGATOR_IF = "${{ always() && github.event_name == 'pull_request' }}";
const WORKFLOW_FILE = ".github/workflows/check.yml";
const readWorkflow = () => fs.readFileSync(path.join(ROOT, WORKFLOW_FILE), "utf8");

/** Les jobs de check.yml, dans l'ordre du fichier : identifiant → texte du job. */
function workflowJobs(workflow: string): Map<string, string> {
  const body = workflow.split(/^jobs:\s*$/m)[1] ?? "";
  const jobs = new Map<string, string>();
  for (const chunk of body.split(/^(?= {2}[A-Za-z0-9_-]+:$)/m)) {
    const id = /^ {2}([A-Za-z0-9_-]+):$/m.exec(chunk);
    if (id) jobs.set(id[1] as string, chunk.replace(/^\s*#.*$\n?/gm, ""));
  }
  return jobs;
}

/** Une clé du job lui-même (4 espaces d'indentation), ou null. */
const jobKey = (job: string, key: string) => new RegExp(`^ {4}${key}:\\s*(.*)$`, "m").exec(job)?.[1] ?? null;

/** Les étapes d'un job, sans commentaires ni lignes vides. */
const stepsOf = (job: string) =>
  (job.split(/^ {4}steps:\s*$/m)[1] ?? "").split("\n").filter((line) => line.trim() !== "");

/** Contextes de statut que produit check.yml (D-2) : `<id> (<os>)` ou `name:`. */
function statusContexts(jobs: Map<string, string>): string[] {
  const contexts: string[] = [];
  for (const [id, job] of jobs) {
    const name = jobKey(job, "name");
    const systems = /^ {6}matrix:\s*\n {8}os:\s*\[([^\]]*)\]/m.exec(job);
    if (name !== null) contexts.push(name);
    else if (systems) contexts.push(...(systems[1] ?? "").split(",").map((os) => `${id} (${os.trim()})`));
    else contexts.push(id);
  }
  return contexts;
}

/**
 * Fichier de test fixture : chaque test nommé note son nom dans `$CI_MACOS_MARKER`.
 * La source sort déjà au format de Biome : AC-12 la soumet à la section `lint`.
 */
function fixture(names: string[], comment = ""): string {
  return [
    ...(comment === "" ? [] : [`// ${comment}`]),
    'import test from "node:test";',
    'import * as fs from "node:fs";',
    ...names.flatMap((name) => [
      "",
      `test(${JSON.stringify(name)}, () => {`,
      `  fs.appendFileSync(process.env.CI_MACOS_MARKER ?? "/dev/null", ${JSON.stringify(`${name}\n`)});`,
      "});",
    ]),
    "",
  ].join("\n");
}

/** Copie légère : ce dont `--sections=tests` a besoin, et un test/ de fixtures. */
function lightCopy(tests: Record<string, string>): string {
  const dir = tmpdir("ci-macos-copie-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "test"));
  for (const script of ["check.sh", "test-files.sh"]) {
    fs.copyFileSync(path.join(ROOT, "scripts", script), path.join(dir, "scripts", script));
  }
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  for (const [name, source] of Object.entries(tests)) {
    const target = path.join(dir, "test", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return dir;
}

test("ci-macos-jobs-paralleles/AC-12 : check.sh sans option exécute les 13 sections et toute la suite node", (t) => {
  if (DEPTH > 0) {
    t.skip(NESTED);
    return;
  }
  // Copie complète du dépôt, test/ remplacé par deux fixtures : check.sh y tourne
  // tel qu'un poste le lance, et `── Tests` doit y prendre TOUS les fichiers.
  const dir = tmpdir("ci-macos-complet-");
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      const segments = rel.split(path.sep);
      if (
        segments.some((s) =>
          [".git", "node_modules", ".typecheck", ".lint", "qdrant_storage", "build", "target"].includes(s),
        )
      )
        return false;
      if (segments.some((s) => s.startsWith(".build"))) return false;
      return segments[0] !== "test" || segments.length === 1;
    },
  });
  // `.typecheck/` n'est pas copié : la section Types y lance le TypeScript
  // épinglé de ROOT, relié, jamais téléchargé.
  linkPinnedTypescript(dir);
  fs.writeFileSync(path.join(dir, "test", "a.test.ts"), fixture(["fixture/a"]));
  fs.writeFileSync(path.join(dir, "test", "b.test.ts"), fixture(["fixture/b"]));
  const marker = path.join(tmpdir("ci-macos-marqueur-"), "ran");

  const run = runCheck(dir, [], { CI_MACOS_MARKER: marker });
  const out = output(run);

  assert.deepEqual(headersOf(out), HEADERS, out);
  assert.ok(out.includes("  · 2 fichier(s) de test : test/a.test.ts test/b.test.ts\n"), out);
  assert.ok(!out.includes("filtre de noms"), out);
  assert.ok(out.includes("  ✓ tests unitaires"), out);
  assert.deepEqual(lines(fs.readFileSync(marker, "utf8")).sort(), ["fixture/a", "fixture/b"]);
});

test("ci-macos-jobs-paralleles/AC-4 : --sections n'exécute que les sections listées, un id inconnu ne lance rien, et les jobs macOS couvrent les 13 sections", () => {
  const only = runCheck(ROOT, ["--sections=noms,catalogue"]);
  assert.equal(only.status, 0, output(only));
  // Ordre du script, pas celui de la liste.
  assert.deepEqual(headersOf(output(only)), ["── Catalogue marketplace", "── Noms"], output(only));
  assert.ok(only.stdout.includes("Dépôt prêt à publier."), output(only));

  const ids =
    "catalogue, noms, plugins, versions, extension, types, lint, rust, smoke, tests, noyau, app-swift, app-ios";
  const cases: Array<[string[], string]> = [
    [["--sections=bogus"], `✗ section inconnue : « bogus » (attendu : ${ids})`],
    [["--sections="], `✗ section inconnue : «  » (attendu : ${ids})`],
    [["--sections=noms,,catalogue"], `✗ section inconnue : «  » (attendu : ${ids})`],
    [
      ["--bogus"],
      "✗ option inconnue : --bogus (attendu : --sections=…, --tests-scope=macos, --tests-base=<réf>, --tests-part=1/2|2/2, --strict)",
    ],
    [["--sections=noms", "--sections=catalogue"], "✗ option répétée : --sections"],
  ];
  for (const [args, message] of cases) {
    const bad = runCheck(ROOT, args);
    assert.equal(bad.status, 1, `${args.join(" ")} :\n${output(bad)}`);
    assert.equal(bad.stderr, `${message}\n`, args.join(" "));
    assert.equal(bad.stdout, "", `${args.join(" ")} : aucune section ne doit s'exécuter`);
  }

  // Volet CI : l'union des --sections des jobs macOS couvre les 13 sections.
  const jobs = workflowJobs(readWorkflow());
  const covered: string[] = [];
  for (const id of MACOS_JOBS) {
    const job = jobs.get(id) ?? "";
    const calls = [...job.matchAll(/\.\/scripts\/check\.sh --sections=(\$\{\{ matrix\.sections \}\}|\S+)/g)].map(
      (m) => m[1] as string,
    );
    assert.equal(calls.length, 1, `${id} doit lancer check.sh une fois avec --sections :\n${job}`);
    const lists =
      calls[0] === "${{ matrix.sections }}"
        ? [...job.matchAll(/^ {12}sections: (\S+)$/gm)].map((m) => m[1] as string)
        : calls;
    assert.ok(lists.length > 0, `${id} : sections de la matrice introuvables`);
    for (const list of lists) covered.push(...list.split(","));
  }
  for (const id of covered) assert.ok(SECTION_IDS.includes(id), `section inconnue de check.sh : ${id}`);
  assert.deepEqual([...new Set(covered)].sort(), [...SECTION_IDS].sort());
  // `tests` figure dans les deux parts, qui se partagent ses tests (--tests-part) ;
  // toute autre section ne tourne qu'une fois sur macOS.
  const repeated = covered.filter((id, index) => id !== "tests" && covered.indexOf(id) !== index);
  assert.deepEqual(repeated, [], `sections lancées deux fois sur macOS : ${covered.join(", ")}`);
});

test("ci-macos-jobs-paralleles/AC-5 : la CI macOS ne lance que les fichiers de la règle, et ses deux parts lancent chaque test une fois", (t) => {
  if (DEPTH > 0) {
    t.skip(NESTED);
    return;
  }
  const run = testFiles(ROOT, ["--scope=macos"]);
  assert.equal(run.status, 0, output(run));
  const listed = lines(run.stdout);
  const all = listTestFiles(ROOT);

  const minimums = [
    "test/outillage/check.test.ts",
    "test/console/coque-ios.test.ts",
    "test/console/console-core.test.ts",
    "test/console/serveur-de-pipelines.test.ts",
    ...all.filter((file) => path.basename(file).startsWith("ios-")),
  ];
  for (const file of minimums) assert.ok(listed.includes(file), `${file} absent de la liste macOS`);

  const expected = all.filter(
    (file) => path.basename(file).startsWith("ios-") || MACOS_RULE.test(fs.readFileSync(path.join(ROOT, file), "utf8")),
  );
  assert.deepEqual(listed, expected, "la liste doit être exactement les fichiers qui satisfont la règle");

  // Invariant de --tests-part : les tests du motif ne vivent que dans check.test.ts.
  const owners = all.filter((file) => PART_SLUGS.test(fs.readFileSync(path.join(ROOT, file), "utf8")));
  assert.deepEqual(owners, ["test/outillage/check.test.ts"]);

  // Ce que le job macOS lance : --tests-scope=macos, puis les deux parts.
  const dir = lightCopy({
    "outillage/check.test.ts": fixture(
      ["socle-app-swift/fixture-a", "check/fixture-b", "socle-app-swift/fixture-c"],
      "lance swift",
    ),
    "console/ios-zz.test.ts": fixture(["ios-zz/fixture-d"]),
    "req/plain.test.ts": fixture(["plain/fixture-e"]),
  });
  const ran = (part: string) => {
    const marker = path.join(tmpdir("ci-macos-marqueur-"), "ran");
    const run = runCheck(dir, [`--tests-part=${part}`, "--sections=tests", "--tests-scope=macos"], {
      CI_MACOS_MARKER: marker,
    });
    assert.equal(run.status, 0, output(run));
    assert.deepEqual(headersOf(output(run)), ["── Tests"], output(run));
    return { out: output(run), names: fs.existsSync(marker) ? lines(fs.readFileSync(marker, "utf8")) : [] };
  };

  const first = ran("1/2");
  assert.ok(first.out.includes("  · 1 fichier(s) de test : test/outillage/check.test.ts\n"), first.out);
  assert.ok(first.out.includes("  · filtre de noms : --test-name-pattern=^socle-app-swift/\n"), first.out);
  assert.deepEqual(first.names.sort(), ["socle-app-swift/fixture-a", "socle-app-swift/fixture-c"]);

  const second = ran("2/2");
  assert.ok(
    second.out.includes("  · 2 fichier(s) de test : test/console/ios-zz.test.ts test/outillage/check.test.ts\n"),
    second.out,
  );
  assert.ok(second.out.includes("  · filtre de noms : --test-skip-pattern=^socle-app-swift/\n"), second.out);
  assert.deepEqual(second.names.sort(), ["check/fixture-b", "ios-zz/fixture-d"]);

  // Une part qui ne lance aucun test est rouge, même quand node rend 0.
  fs.writeFileSync(path.join(dir, "test", "outillage", "check.test.ts"), fixture(["check/fixture-b"], "lance swift"));
  const none = runCheck(dir, ["--sections=tests", "--tests-scope=macos", "--tests-part=1/2"]);
  assert.equal(none.status, 1, output(none));
  assert.ok(output(none).includes("  ✗ tests unitaires — aucun test exécuté pour --tests-part=1/2\n"), output(none));

  // Ensemble vide après scope et part : rouge, node non lancé.
  fs.rmSync(path.join(dir, "test", "outillage", "check.test.ts"));
  const empty = runCheck(dir, ["--sections=tests", "--tests-scope=macos", "--tests-part=1/2"]);
  assert.equal(empty.status, 1, output(empty));
  assert.ok(
    output(empty).includes(
      "  ✗ tests unitaires — aucun fichier de test retenu (--tests-scope=macos, --tests-part=1/2)\n",
    ),
    output(empty),
  );
  assert.ok(!output(empty).includes("fichier(s) de test :"), output(empty));
});

test("ci-macos-jobs-paralleles/AC-6 : un fichier de test nouveau qui appelle xcodebuild est retenu sans liste à modifier", () => {
  const dir = tmpdir("ci-macos-nouveau-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "test-files.sh"), path.join(dir, "scripts", "test-files.sh"));
  fs.cpSync(path.join(ROOT, "test"), path.join(dir, "test"), { recursive: true });
  const before = testFiles(dir, ["--scope=macos"]);
  assert.equal(before.status, 0, output(before));

  fs.writeFileSync(
    path.join(dir, "test", "zz-fixture.test.ts"),
    'import { spawnSync } from "node:child_process";\nspawnSync("xcodebuild", ["-version"]);\n',
  );
  fs.writeFileSync(path.join(dir, "test", "zz-neutre.test.ts"), 'import * as fs from "node:fs";\nfs.statSync(".");\n');
  const after = testFiles(dir, ["--scope=macos"]);
  assert.equal(after.status, 0, output(after));
  assert.deepEqual(lines(after.stdout), [...lines(before.stdout), "test/zz-fixture.test.ts"]);

  // Jamais de liste vide silencieuse.
  const bare = tmpdir("ci-macos-vide-");
  fs.mkdirSync(path.join(bare, "scripts"));
  fs.mkdirSync(path.join(bare, "test"));
  fs.copyFileSync(path.join(ROOT, "scripts", "test-files.sh"), path.join(bare, "scripts", "test-files.sh"));
  fs.writeFileSync(path.join(bare, "test", "neutre.test.ts"), "export {};\n");
  const empty = testFiles(bare, ["--scope=macos"]);
  assert.equal(empty.status, 1, output(empty));
  assert.equal(empty.stderr, "✗ aucun fichier de test retenu\n");
  assert.equal(empty.stdout, "");

  const unknown = testFiles(bare, ["--scope=linux"]);
  assert.equal(unknown.status, 1, output(unknown));
  assert.equal(unknown.stderr, "✗ option inconnue : --scope=linux\n");
});

test("ci-macos-jobs-paralleles/AC-7 : au push vers main, les tests node macOS ne sont pas filtrés — test-files.sh sans --scope liste tous les test/*.test.ts", () => {
  const listed = testFiles(ROOT);
  assert.equal(listed.status, 0, output(listed));
  assert.deepEqual(lines(listed.stdout), listTestFiles(ROOT));

  // Volet CI : en pull_request (seul événement du job), macos-tests filtre par
  // --tests-scope=macos et par le diff depuis la base de la PR (--tests-base).
  const workflow = readWorkflow();
  const tests = workflowJobs(workflow).get("macos-tests") ?? "";
  assert.equal(
    stepsOf(tests).find((line) => line.includes("./scripts/check.sh")),
    "        run: ./scripts/check.sh --sections=${{ matrix.sections }} --tests-part=${{ matrix.part }} " +
      "--tests-scope=macos --tests-base=${{ github.event.pull_request.base.sha }}",
  );
  // Nulle part ailleurs dans le workflow (commentaires exclus).
  assert.equal(workflow.replace(/^\s*#.*$/gm, "").split("--tests-scope=macos").length - 1, 1);
});

test("ci-macos-jobs-paralleles/AC-1 : les jobs macOS App Swift, App iOS et tests node sont distincts, sans attente, réservés aux pull_request, et l'agrégateur les attend", () => {
  const jobs = workflowJobs(readWorkflow());
  assert.equal([...jobs.keys()][0], "check", "le job ubuntu `check` reste le premier du fichier");

  const onMacos = [...jobs].filter(([, job]) => jobKey(job, "runs-on") === "macos-latest").map(([id]) => id);
  assert.deepEqual(onMacos, MACOS_JOBS, "exactement trois définitions de jobs macOS (4 runners avec la matrice)");
  for (const [id, job] of jobs) {
    assert.equal(
      jobKey(job, "needs"),
      id === "check-macos" ? "[macos-app-swift, macos-app-ios, macos-tests]" : null,
      id,
    );
    assert.equal(
      jobKey(job, "if"),
      id === "check-macos" ? AGGREGATOR_IF : MACOS_JOBS.includes(id) ? PULL_REQUEST_IF : null,
      `${id} : les jobs macOS ne tournent qu'en pull_request, l'agrégateur toujours en pull_request, le job check sans if:`,
    );
  }

  const tests = jobs.get("macos-tests") ?? "";
  assert.equal(jobKey(tests, "name"), "macos-tests (${{ matrix.part }})");
  assert.match(tests, /^ {6}fail-fast: false$/m);
  assert.match(tests, /^ {8}part: \["1\/2", "2\/2"\]$/m);

  const aggregator = jobs.get("check-macos") ?? "";
  assert.equal(jobKey(aggregator, "name"), "check (macos-latest)");
  assert.equal(jobKey(aggregator, "runs-on"), "ubuntu-latest");
});

test("ci-macos-jobs-paralleles/AC-2 : check.yml et release-simulation.yml produisent exactement les statuts requis de main", () => {
  const doc = fs.readFileSync(path.join(ROOT, "PUBLISHING.md"), "utf8");
  const body = /"required_status_checks":\{[^}]*"contexts":\[([^\]]*)\]/.exec(doc);
  assert.ok(body, "commande de protection de branche absente de PUBLISHING.md");
  assert.equal(body[1], '"check (ubuntu-latest)","check (macos-latest)","release-simulation"');

  const simulation = fs.readFileSync(path.join(ROOT, ".github/workflows/release-simulation.yml"), "utf8");
  const produced = [...statusContexts(workflowJobs(readWorkflow())), ...statusContexts(workflowJobs(simulation))];
  for (const context of ["check (ubuntu-latest)", "check (macos-latest)", "release-simulation"]) {
    assert.equal(
      produced.filter((c) => c === context).length,
      1,
      `${context} doit être produit par un seul job : ${produced.join(", ")}`,
    );
  }
});

test("ci-macos-jobs-paralleles/AC-3 : l'agrégateur ne réussit que sur trois success — échec, annulation, saut ou vide le font rougir", () => {
  const verdict = (...args: string[]) =>
    spawnSync("bash", [path.join(ROOT, "scripts/ci-verdict.sh"), ...args], { encoding: "utf8" });

  const green = verdict("macos-app-swift=success", "macos-app-ios=success", "macos-tests=success");
  assert.equal(green.status, 0, output(green));
  assert.equal(green.stdout, "  ✓ macos-app-swift : success\n  ✓ macos-app-ios : success\n  ✓ macos-tests : success\n");

  const red = "✗ check (macos-latest) : au moins un job macOS n'a pas réussi\n";
  for (const [result, shown] of [
    ["failure", "failure"],
    ["cancelled", "cancelled"],
    ["skipped", "skipped"],
    ["", "(vide)"],
    ["neutral", "neutral"],
  ]) {
    const run = verdict("macos-app-swift=success", `macos-app-ios=${result}`, "macos-tests=success");
    assert.equal(run.status, 1, `${result} :\n${output(run)}`);
    assert.equal(
      run.stdout,
      `  ✓ macos-app-swift : success\n  ✗ macos-app-ios : ${shown}\n  ✓ macos-tests : success\n${red}`,
      result,
    );
  }
  const bare = verdict("macos-app-swift=success", "macos-tests");
  assert.equal(bare.status, 1, output(bare));
  assert.ok(bare.stdout.endsWith("✗ argument invalide : macos-tests\n"), output(bare));
  const none = verdict();
  assert.equal(none.status, 1, output(none));
  assert.equal(none.stdout, "✗ aucun job à juger\n");
  // L'agrégateur tourne à chaque pull_request (`always()`, jamais « skipped »)
  // et juge le résultat de chacune de ses dépendances.
  const aggregator = workflowJobs(readWorkflow()).get("check-macos") ?? "";
  assert.equal(jobKey(aggregator, "if"), AGGREGATOR_IF);
  const call = MACOS_JOBS.map((job) => `${job}=\${{ needs.${job}.result }}`).join(" ");
  assert.ok(stepsOf(aggregator).includes(`        run: bash scripts/ci-verdict.sh ${call}`), aggregator);
});

/** L'étape de la Qdrant source des tests d'import mem0-rs, juste après celle du linter. */
const QDRANT_STEP = [
  "      - name: Préparer la Qdrant source des tests d'import mem0-rs",
  "        run: bash scripts/mem0-http-contrat.sh --prepare",
];
/** L'étape de la toolchain Rust (mem0-rs-noyau S-11), juste après celle de la Qdrant source. */
const RUST_STEP = ["      - name: Préparer la toolchain Rust (clippy)", "        run: rustup component add clippy"];
/** L'étape d'empreinte des toolchains (ci-without-cache S-1), juste après setup-node : elle nourrit les clés de cache. */
const FINGERPRINT_STEP = [
  "      - name: Empreinte des toolchains (clés de cache)",
  "        id: toolchain",
  "        run: |",
  "          {",
  '            echo "node=$(node --version 2>/dev/null || echo absent)"',
  '            echo "rust=$( (rustc -vV 2>&1 || echo absent) | shasum -a 256 | cut -c1-16)"',
  '            echo "swift=$( (swift --version 2>&1 || echo absent; xcode-select -p 2>&1 || echo absent) | shasum -a 256 | cut -c1-16)"',
  '          } >> "$GITHUB_OUTPUT"',
];
/** Le cache npm de l'hôte OMP (ci-without-cache S-2), juste après l'empreinte. */
const NPM_CACHE_STEP = [
  "      - name: Cache npm (hôte OMP)",
  "        uses: actions/cache@v6",
  "        with:",
  "          path: ~/.npm",
  "          key: npm-${{ github.job }}-${{ strategy.job-index }}-${{ runner.os }}-${{ runner.arch }}-node-${{ steps.toolchain.outputs.node }}-omp-${{ env.OMP_HOST_VERSION }}-types-node-${{ env.OMP_HOST_TYPES_NODE }}",
];
/** Le cache cargo de mem0-rs (ci-without-cache S-2), juste après le cache npm. */
const CARGO_CACHE_STEP = [
  "      - name: Cache cargo (mem0-rs)",
  "        uses: actions/cache@v6",
  "        with:",
  "          path: |",
  "            ~/.cargo/registry/index",
  "            ~/.cargo/registry/cache",
  "            ~/.cargo/git/db",
  "            mem0-stack/mem0-rs/target",
  "          key: cargo-${{ github.job }}-${{ strategy.job-index }}-${{ runner.os }}-${{ runner.arch }}-rustc-${{ steps.toolchain.outputs.rust }}-${{ hashFiles('mem0-stack/mem0-rs/Cargo.lock', 'mem0-stack/mem0-rs/Cargo.toml') }}",
];
/** L'installation de l'hôte : la version vient de l'`env:` du workflow (ci-without-cache S-1). */
const HOST_INSTALL =
  '          npm install --no-save --prefix "$RUNNER_TEMP/omp-host" "@oh-my-pi/pi-coding-agent@$OMP_HOST_VERSION" "@types/node@$OMP_HOST_TYPES_NODE"';
/** L'étape du TypeScript épinglé du type-check (typecheck-fetches-tsc-from-network S-6), après l'installation de l'hôte. */
const TYPESCRIPT_STEP = [
  "      - name: Installer le TypeScript épinglé du type-check",
  "        run: bash scripts/typecheck.sh --prepare",
];
/** Le lancement de check.sh du job check : strict, et en pull_request filtré par le diff depuis la base. */
const STRICT_RUN = "        run: ./scripts/check.sh --strict ";
/** L'étape du linter épinglé (no-ts-lint-formatter S-6), juste avant celle de la Qdrant source. */
const LINT_STEP = ["      - name: Préparer le linter épinglé (Biome)", "        run: bash scripts/lint.sh --prepare"];

test("ci-macos-jobs-paralleles/AC-8 : le job check (ubuntu-latest) reste unique et complet : strict, filtré par --tests-base en pull_request seulement, sans banc Python ni iOS, avec l'empreinte, les caches, le linter, la Qdrant source et la toolchain Rust dans l'ordre", () => {
  const jobs = workflowJobs(readWorkflow());
  const contexts = statusContexts(jobs);
  assert.equal(contexts.filter((c) => c === "check (ubuntu-latest)").length, 1, contexts.join(", "));
  const check = jobs.get("check") ?? "";
  assert.equal(jobKey(check, "runs-on"), "${{ matrix.os }}");
  assert.equal(jobKey(check, "name"), null);
  const steps = stepsOf(check);
  const runs = steps.filter((line) => line.startsWith(STRICT_RUN));
  assert.equal(runs.length, 1, "check.sh --strict, une seule fois, sur ubuntu");
  // La sélection par le diff n'a de base qu'en pull_request ; au push vers main,
  // l'option est vide et la suite entière tourne.
  assert.match(
    runs[0] ?? "",
    /\$\{\{ github\.event_name == 'pull_request' && format\('--tests-base=\{0\}', github\.event\.pull_request\.base\.sha\) \|\| '' \}\}$/,
    runs[0],
  );
  assert.ok(!check.includes("MEM0_OMP_REQUIRE_IOS"), check);
  // (a) Plus aucune trace du banc Python de mem0-http.
  for (const needle of ["mem0-http-test.sh", "setup-python", "image_python", "MEM0_OMP_REQUIRE_HTTP_API"]) {
    assert.ok(!steps.some((line) => line.includes(needle)), `${needle} encore présent dans le job check :\n${check}`);
  }
  // (b) L'étape de la Qdrant source : une seule fois, ses deux lignes consécutives,
  // immédiatement suivie de l'étape Rust ; la section Rust y est exigée
  // (MEM0_OMP_REQUIRE_RUST), une seule fois.
  const at = steps.indexOf(QDRANT_STEP[0] ?? "");
  assert.equal(steps.filter((line) => QDRANT_STEP.includes(line)).length, 2, check);
  assert.ok(at > 0, check);
  assert.equal(steps[at + 1], QDRANT_STEP[1], check);
  assert.equal(steps.filter((line) => RUST_STEP.includes(line)).length, 2, check);
  assert.equal(steps[at + 2], RUST_STEP[0], check);
  assert.equal(steps[at + 3], RUST_STEP[1], check);
  assert.equal(steps.filter((line) => line === '          MEM0_OMP_REQUIRE_RUST: "1"').length, 1, check);
  // (b') ci-without-cache : l'empreinte puis les caches npm et cargo, d'un seul
  // tenant et juste après setup-node ; l'installation lit la version de l'hôte
  // dans l'`env:` du workflow, une seule fois.
  const fingerprint = steps.indexOf(FINGERPRINT_STEP[0] ?? "");
  assert.equal(steps[fingerprint - 1], '          node-version: "22"', check);
  const caches = [...FINGERPRINT_STEP, ...NPM_CACHE_STEP, ...CARGO_CACHE_STEP];
  assert.deepEqual(steps.slice(fingerprint, fingerprint + caches.length), caches, check);
  assert.equal(steps.filter((line) => line === HOST_INSTALL).length, 1, check);
  // (b'') L'étape du linter épinglé : une seule fois, ses deux lignes consécutives,
  // immédiatement avant l'étape de la Qdrant source.
  assert.equal(steps.filter((line) => LINT_STEP.includes(line)).length, 2, check);
  assert.equal(steps[at - 2], LINT_STEP[0], check);
  assert.equal(steps[at - 1], LINT_STEP[1], check);
  // (c) L'étape du TypeScript épinglé suit l'installation de l'hôte ; le linter
  // la suit (après setup-bun) : l'ordre relatif des préparations est fixé.
  const typescript = steps.indexOf(TYPESCRIPT_STEP[0] ?? "");
  assert.ok(typescript > steps.indexOf(HOST_INSTALL), check);
  assert.equal(steps[typescript + 1], TYPESCRIPT_STEP[1], check);
  assert.ok(typescript < at - 2, check);
});

/** L'appel de scripts/ci-scope.sh d'un job d'app : la base de la PR, puis la section. */
const scopeCall = (section: string) =>
  `          if bash scripts/ci-scope.sh --base="\${{ github.event.pull_request.base.sha }}" ${section}; then`;

test("ci-macos-jobs-paralleles/AC-13 : les jobs d'app ne compilent que si le diff de la PR touche l'app — étape de portée, puis étapes coûteuses conditionnées", () => {
  const jobs = workflowJobs(readWorkflow());
  for (const [id, section, costly] of [
    ["macos-app-swift", "app-swift", ["App Swift", "Archiver l'app Mac", "Publier l'app Mac (artefact du run)"]],
    ["macos-app-ios", "app-ios", ["App iOS"]],
  ] as const) {
    const job = jobs.get(id) ?? "";
    const steps = stepsOf(job);
    // L'historique complet : la portée compare la base et la tête de la PR.
    assert.equal(steps[0], "      - uses: actions/checkout@v4", id);
    assert.ok(steps.includes("          fetch-depth: 0"), `${id} : fetch-depth: 0 attendu\n${job}`);
    // L'étape de portée, identifiée `scope`, appelle ci-scope.sh avec la base de la PR.
    const scope = steps.indexOf("        id: scope");
    assert.ok(scope > 0, `${id} : étape id: scope introuvable\n${job}`);
    assert.equal(
      steps[scope - 1],
      `      - name: Portée du diff (${section === "app-swift" ? "app Swift" : "app iOS"})`,
      id,
    );
    assert.equal(steps.filter((line) => line === "        id: scope").length, 1, id);
    assert.ok(steps.slice(scope, scope + 4).includes(scopeCall(section)), `${id} : appel de ci-scope.sh\n${job}`);
    // Chaque étape coûteuse, après la portée, porte la condition au niveau étape.
    const guarded = steps.filter((line) => line === "        if: steps.scope.outputs.run == '1'").length;
    assert.equal(guarded, costly.length, `${id} : ${costly.length} étapes conditionnées attendues\n${job}`);
    for (const name of costly) {
      const step = steps.indexOf(`      - name: ${name}`);
      assert.ok(step > scope, `${id} : étape « ${name} » absente ou avant la portée\n${job}`);
      assert.equal(steps[step + 1], "        if: steps.scope.outputs.run == '1'", `${id} : « ${name} »`);
    }
    assert.ok(
      steps.some((line) => line === `        run: ./scripts/check.sh --sections=${section}`),
      `${id} : lancement de check.sh --sections=${section}\n${job}`,
    );
  }
});

const WORKFLOW_CONCURRENCY = [
  "concurrency:",
  "  group: ${{ github.event_name == 'pull_request' && format('check-pr-{0}', github.event.pull_request.number) || format('check-run-{0}', github.run_id) }}",
  "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
];

/** Le bloc `concurrency` au niveau du workflow (entre `on:` et `jobs:`), sans commentaires. */
function workflowConcurrency(): string[] {
  const workflow = readWorkflow();
  const head = workflow.split(/^jobs:\s*$/m)[0] ?? "";
  assert.ok(/^on:\s*$/m.test(head), "on: doit précéder jobs:");
  assert.ok(!/^ +concurrency:/m.test(workflow.split(/^jobs:\s*$/m)[1] ?? ""), "aucun concurrency au niveau d'un job");
  const after = head.split(/^concurrency:\s*$/m)[1];
  assert.ok(after !== undefined, "bloc concurrency absent du workflow");
  const block = after.split("\n").filter((line) => line.startsWith("  ") && !line.trimStart().startsWith("#"));
  return ["concurrency:", ...block];
}

test("ci-macos-jobs-paralleles/AC-9 : un nouveau commit sur une PR annule le run check en cours de cette PR", () => {
  const block = workflowConcurrency();
  assert.deepEqual(block, WORKFLOW_CONCURRENCY);
  // Même PR ⇒ même groupe `check-pr-<n>`, et l'annulation du run en cours.
  assert.ok(block[1]?.includes("format('check-pr-{0}', github.event.pull_request.number)"));
  assert.ok(block[2]?.endsWith("${{ github.event_name == 'pull_request' }}"));
});

test("ci-macos-jobs-paralleles/AC-10 : un push vers main n'annule jamais un run check", () => {
  const block = workflowConcurrency();
  assert.deepEqual(block, WORKFLOW_CONCURRENCY);
  // Hors pull_request : groupe unique par run (rien à remplacer) et pas d'annulation.
  assert.ok(block[1]?.endsWith("|| format('check-run-{0}', github.run_id) }}"));
  // Préfixe propre : aucun groupe partagé avec release-simulation.yml.
  const simulation = fs.readFileSync(path.join(ROOT, ".github/workflows/release-simulation.yml"), "utf8");
  assert.ok(!/group:.*check-/.test(simulation), simulation);
});
