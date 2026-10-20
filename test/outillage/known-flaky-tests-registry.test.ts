// Critères de la feature known-flaky-tests-registry : le registre versionné des
// tests Swift instables connus (`scripts/tests-instables-connus.json`),
// `scripts/ci-verdict.sh`, dont le mode agrégateur ne doit pas bouger, et la
// relance unique de la branche d'échec de `swift test` dans
// `scripts/swift-app.sh`, exercée de bout en bout avec une doublure `swift`
// scriptée (FAUX_SWIFT_TEST) — sans outil Apple, donc aussi sous ubuntu.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, tmpdir } from "../support/repo.ts";
import { montageAppIntents } from "../support/swift-app-doubles.ts";
import type { AssemblageAppIntents } from "../support/swift-app-doubles.ts";

const verdict = (...args: string[]) =>
  spawnSync("bash", [path.join(ROOT, "scripts/ci-verdict.sh"), ...args], { encoding: "utf8" });

const output = (run: SpawnSyncReturns<string>) => `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;

test("known-flaky-tests-registry/AC-7 : le mode agrégateur rend le même verdict qu'avant", () => {
  const jobs = ["macos-app-swift", "macos-app-ios", "macos-tests"];
  const red = "✗ check (macos-latest) : au moins un job macOS n'a pas réussi\n";
  for (const job of jobs) {
    for (const result of ["success", "failure", "cancelled", "skipped", "", "neutral"]) {
      const run = verdict(...jobs.map((j) => `${j}=${j === job ? result : "success"}`));
      const lines = jobs
        .map((j) => (j !== job || result === "success" ? `  ✓ ${j} : success\n` : `  ✗ ${j} : ${result || "(vide)"}\n`))
        .join("");
      const expected = result === "success" ? lines : `${lines}${red}`;
      assert.equal(run.stdout, expected, `${job}=${result}`);
      assert.equal(run.stderr, "", `${job}=${result}`);
      assert.equal(run.status, result === "success" ? 0 : 1, `${job}=${result} :\n${output(run)}`);
    }
  }

  const bare = verdict("macos-app-swift=success", "macos-tests");
  assert.equal(bare.status, 1, output(bare));
  assert.equal(bare.stdout, "  ✓ macos-app-swift : success\n✗ argument invalide : macos-tests\n");

  const none = verdict();
  assert.equal(none.status, 1, output(none));
  assert.equal(none.stdout, "✗ aucun job à juger\n");
});

const SLUG = /^[a-z0-9][a-z0-9-]*\/AC-[0-9]+$/;
const FONCTION = /^[A-Za-z_][A-Za-z0-9_]*\(\)$/;

/** Les sources Swift des cibles de test d'omp-console. */
function swiftTestSources(): string[] {
  const dir = path.join(ROOT, "omp-console", "Tests");
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".swift"))
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8"));
}

test("known-flaky-tests-registry/AC-8 : le registre liste exactement les cinq tests instables, au format imprimé, avec leur occurrence et sans condition", () => {
  const registre = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/tests-instables-connus.json"), "utf8"));

  assert.deepEqual(Object.keys(registre), ["tests"]);
  assert.ok(Array.isArray(registre.tests), "tests doit être un tableau");
  for (const entree of registre.tests) {
    assert.deepEqual(Object.keys(entree).sort(), ["filtre", "identifiant", "occurrence"], JSON.stringify(entree));
    for (const cle of ["identifiant", "filtre", "occurrence"]) {
      assert.equal(typeof entree[cle], "string", `${cle} : ${JSON.stringify(entree)}`);
      assert.notEqual(entree[cle], "", `${cle} vide : ${JSON.stringify(entree)}`);
    }
  }

  const identifiants: string[] = registre.tests.map((e: { identifiant: string }) => e.identifiant);
  assert.deepEqual(identifiants, [
    "client-rpc-omp/AC-2",
    "bug-embedded-podman-machine/AC-5",
    "duplicateHeaderIsBadRequest()",
    "trailingSpaceIsAcceptedAfterTrim()",
    "api-distante-du-console/AC-1",
  ]);
  assert.equal(new Set(identifiants).size, identifiants.length, "identifiants uniques");

  const sources = swiftTestSources();
  for (const { identifiant, filtre, occurrence } of registre.tests) {
    assert.ok(SLUG.test(identifiant) || FONCTION.test(identifiant), `format imprimé : ${identifiant}`);
    assert.match(occurrence, /run|PR/, `occurrence de ${identifiant}`);
    const fonction = /(?:\\\.|\/)([A-Za-z_][A-Za-z0-9_]*)\\\(\\\)$/.exec(filtre)?.[1];
    assert.ok(fonction, `fonction du filtre de ${identifiant} : ${filtre}`);
    const declaration = new RegExp(`\\bfunc ${fonction}\\(`);
    assert.ok(
      sources.some((s) => declaration.test(s)),
      `filtre périmé de ${identifiant} : aucun « func ${fonction}( » sous omp-console/Tests`,
    );
  }
});

// ── Branche d'échec de `swift test` (scripts/swift-app.sh, S-2/S-4) ──

const ESC = "\x1b";
const ROUGE = `${ESC}[91m✘${ESC}[0m`;
const VERT = `${ESC}[92m✔${ESC}[0m`;

const CLIENT = '"client-rpc-omp/AC-2 : le modèle garde le lancement et le prompt"';
const PODMAN = "\"bug-embedded-podman-machine/AC-5 : `start()` sonde à l'intervalle donné, `stop()` l'arrête\"";
const AUTRE = '"autre-feature/AC-1 : x"';

const echoue = (nom: string) => `✘ Test ${nom} failed after 0.307 seconds with 1 issue.`;
const passe = (nom: string) => `✔ Test ${nom} passed after 0.072 seconds.`;
const issue = (nom: string) =>
  `✘ Test ${nom} recorded an issue at RemoteVersionTests.swift:150:5: Expectation failed: (status → 200) == 400`;
const RESUME_ROUGE = "✘ Test run with 1516 tests in 41 suites failed after 169.921 seconds with 1 issue.";
const RESUME_CLIENT = "✔ Test run with 120 tests in 27 suites passed after 6.349 seconds.";

/** Un premier essai rouge au format réel : les tests rouges, un test vert, les deux résumés. */
const essaiRouge = (...noms: string[]) =>
  [
    "◇ Test run started.",
    passe('"autre-feature/AC-2 : y"'),
    ...noms.flatMap((nom) => [issue(nom), echoue(nom)]),
    RESUME_ROUGE,
    RESUME_CLIENT,
  ].join("\n");

/** Une relance verte des tests nommés (le second produit n'a aucun test retenu par le filtre). */
const relanceVerte = (...noms: string[]) =>
  [
    "◇ Test run started.",
    ...noms.map(passe),
    `✔ Test run with ${noms.length} tests in 1 suite passed after 0.080 seconds.`,
    "✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.",
  ].join("\n");

const L187 = "✗ compilation/tests release échoués (relance : cd omp-console && swift test -c release";
const NON_ATTRIBUABLE =
  "✗ échec de swift test non attribuable à un test nommé (compilation, plantage, sortie illisible ou interruption) : aucune relance";
const RELANCE_ROUGE = "✗ relance rouge des tests instables connus : verdict bloquant, aucune autre relance";
const HORS_REGISTRE = "✗ au moins un test en échec n'est pas au registre des tests instables : aucune relance";

const montage = montageAppIntents();

type Essai = { sortie: string; code: number };
type Lancement = AssemblageAppIntents & { appels: string[] };

/** Lance le vrai swift-app.sh (assemblage complet) avec un `swift test` scripté. */
function lancerSwiftApp(essai: Essai, relance?: Essai): Lancement {
  const dossier = tmpdir("faux-swift-test-");
  fs.writeFileSync(path.join(dossier, "essai.txt"), `${essai.sortie}\n`);
  fs.writeFileSync(path.join(dossier, "essai.code"), `${essai.code}\n`);
  if (relance) {
    fs.writeFileSync(path.join(dossier, "relance.txt"), `${relance.sortie}\n`);
    fs.writeFileSync(path.join(dossier, "relance.code"), `${relance.code}\n`);
  }
  const r = montage.lancer([], { FAUX_SWIFT_TEST: dossier });
  return { ...r, appels: r.lignes.filter((l) => l.startsWith("swift test ")) };
}

const trace = (r: Lancement) => `statut ${r.status}\n${r.sortie}\nappels swift test :\n${r.appels.join("\n")}`;

/** Un verdict rouge sans relance : code 1, ligne l.187, un seul `swift test`, aucun `↻`. */
function assertRougeSansRelance(r: Lancement, contexte: string) {
  assert.equal(r.status, 1, `${contexte}\n${trace(r)}`);
  assert.ok(r.sortie.includes(L187), `${contexte} : ligne rouge finale absente\n${trace(r)}`);
  assert.equal(r.appels.length, 1, `${contexte} : une relance a été lancée\n${trace(r)}`);
  assert.ok(!r.sortie.includes("↻"), `${contexte} : ligne ↻ présente\n${trace(r)}`);
  assert.ok(
    !r.sortie.includes("  ✓ compilation release (OMPConsole) et tests release"),
    `${contexte} : ✓ des tests affiché\n${trace(r)}`,
  );
}

test("known-flaky-tests-registry/AC-1 : un seul test rouge listé au registre, relancé une fois par swift-app.sh avec succès, donne un verdict vert qui nomme le test", () => {
  const r = lancerSwiftApp(
    {
      sortie: essaiRouge(CLIENT).replaceAll("✘", ROUGE).replaceAll("✔", VERT),
      code: 1,
    },
    { sortie: relanceVerte(CLIENT), code: 0 },
  );
  assert.equal(r.status, 0, trace(r));
  assert.ok(r.sortie.includes("  ✓ client-rpc-omp/AC-2 : instable connu (run local"), trace(r));
  assert.ok(r.sortie.includes("↻ relance unique des tests instables connus : client-rpc-omp/AC-2\n"), trace(r));
  assert.ok(r.sortie.includes("  ✓ relance verte des tests instables connus : client-rpc-omp/AC-2\n"), trace(r));
  assert.ok(r.sortie.includes("  ✓ compilation release (OMPConsole) et tests release (Swift Testing)"), trace(r));
  assert.ok(!r.sortie.includes(L187), trace(r));
  assert.equal(r.appels.length, 2, trace(r));
  assert.match(r.appels[0], /^swift test -c release\b/);
  assert.ok(!r.appels[0].includes("--filter"), trace(r));
  assert.equal(r.appels[1], `${r.appels[0]} --filter \\.modelGatesLaunchAndPrompt\\(\\)`, trace(r));

  // Le mode consulté par la branche : code 0, le filtre du test sur stdout.
  const mode = verdict("--instables", CLIENT);
  assert.equal(mode.status, 0, output(mode));
  assert.equal(mode.stdout, "\\.modelGatesLaunchAndPrompt\\(\\)\n");

  // Deux tests listés, symbole SF Symbols suivi de deux espaces : un seul appel
  // de relance, un motif par alternation, chaque test nommé.
  const deux = lancerSwiftApp(
    { sortie: essaiRouge(PODMAN, "trailingSpaceIsAcceptedAfterTrim()").replaceAll("✘", "\u{100884} "), code: 1 },
    { sortie: relanceVerte(PODMAN, "trailingSpaceIsAcceptedAfterTrim()"), code: 0 },
  );
  assert.equal(deux.status, 0, trace(deux));
  const ids = "bug-embedded-podman-machine/AC-5, trailingSpaceIsAcceptedAfterTrim()";
  assert.ok(deux.sortie.includes(`↻ relance unique des tests instables connus : ${ids}\n`), trace(deux));
  assert.ok(deux.sortie.includes(`  ✓ relance verte des tests instables connus : ${ids}\n`), trace(deux));
  assert.equal(deux.appels.length, 2, trace(deux));
  assert.ok(
    deux.appels[1].endsWith(
      " --filter (?:\\.startPollsUntilStopped\\(\\))|(?:RemoteVersionTests/trailingSpaceIsAcceptedAfterTrim\\(\\))",
    ),
    trace(deux),
  );
});

test("known-flaky-tests-registry/AC-2 : le test listé rougit de nouveau, ou n'est pas rejoué, pendant la relance : verdict rouge", () => {
  // (a) Le même test échoue de nouveau.
  const rouge = lancerSwiftApp(
    { sortie: essaiRouge(CLIENT), code: 1 },
    {
      sortie: [
        "◇ Test run started.",
        issue(CLIENT),
        echoue(CLIENT),
        "✘ Test run with 1 test in 1 suite failed after 0.4 seconds with 1 issue.",
      ].join("\n"),
      code: 1,
    },
  );
  assert.equal(rouge.status, 1, trace(rouge));
  assert.ok(rouge.sortie.includes(`  ✗ non revalidé par la relance : ${CLIENT}\n`), trace(rouge));
  assert.ok(rouge.sortie.includes(`${RELANCE_ROUGE}\n${L187}`), trace(rouge));
  assert.ok(!rouge.sortie.includes("relance verte"), trace(rouge));
  assert.equal(rouge.appels.length, 2, trace(rouge));

  // (b) La relance sort en 0 sans jamais imprimer le test : il n'est pas revalidé.
  const muette = lancerSwiftApp(
    { sortie: essaiRouge(CLIENT), code: 1 },
    { sortie: "◇ Test run started.\n✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.", code: 0 },
  );
  assert.equal(muette.status, 1, trace(muette));
  assert.ok(muette.sortie.includes(`  ✗ non revalidé par la relance : ${CLIENT}\n`), trace(muette));
  assert.ok(muette.sortie.includes(`${RELANCE_ROUGE}\n${L187}`), trace(muette));
  assert.equal(muette.appels.length, 2, trace(muette));
});

test("known-flaky-tests-registry/AC-3 : un test rouge absent du registre rend le verdict rouge sans relance", () => {
  const r = lancerSwiftApp({ sortie: essaiRouge(AUTRE), code: 1 });
  assertRougeSansRelance(r, "AC-3");
  assert.ok(r.sortie.includes("  ✗ autre-feature/AC-1 : absent du registre des tests instables\n"), trace(r));
  assert.ok(r.sortie.includes(`${HORS_REGISTRE}\n${L187}`), trace(r));

  // Le mode consulté : code 1, aucun filtre.
  const mode = verdict("--instables", AUTRE);
  assert.equal(mode.status, 1, output(mode));
  assert.equal(mode.stdout, "");
});

test("known-flaky-tests-registry/AC-4 : un test listé et un test non listé rouges ensemble rendent le verdict rouge sans relance", () => {
  const r = lancerSwiftApp({ sortie: essaiRouge("trailingSpaceIsAcceptedAfterTrim()", AUTRE), code: 1 });
  assertRougeSansRelance(r, "AC-4");
  assert.ok(r.sortie.includes("  ✓ trailingSpaceIsAcceptedAfterTrim() : instable connu (run 39239142987"), trace(r));
  assert.ok(r.sortie.includes("  ✗ autre-feature/AC-1 : absent du registre des tests instables\n"), trace(r));
  assert.ok(r.sortie.includes(HORS_REGISTRE), trace(r));
});

test("known-flaky-tests-registry/AC-5 : un autre test listé qui rougit pendant la relance rend le verdict rouge, sans deuxième relance", () => {
  const r = lancerSwiftApp(
    { sortie: essaiRouge("duplicateHeaderIsBadRequest()"), code: 1 },
    {
      sortie: [
        "◇ Test run started.",
        passe("duplicateHeaderIsBadRequest()"),
        issue("trailingSpaceIsAcceptedAfterTrim()"),
        echoue("trailingSpaceIsAcceptedAfterTrim()"),
        "✘ Test run with 2 tests in 1 suite failed after 5.1 seconds with 1 issue.",
      ].join("\n"),
      code: 1,
    },
  );
  assert.equal(r.status, 1, trace(r));
  assert.ok(
    r.sortie.includes("↻ relance unique des tests instables connus : duplicateHeaderIsBadRequest()\n"),
    trace(r),
  );
  assert.ok(r.sortie.includes(`${RELANCE_ROUGE}\n${L187}`), trace(r));
  assert.ok(!r.sortie.includes("non revalidé"), trace(r));
  assert.equal(r.appels.length, 2, trace(r));
  assert.ok(r.appels[1].endsWith(" --filter RemoteVersionTests/duplicateHeaderIsBadRequest\\(\\)"), trace(r));
});

test("known-flaky-tests-registry/AC-6 : un échec non attribuable à un test nommé (compilation, plantage, sortie illisible, interruption) reste rouge sans relance", () => {
  const cas: Record<string, Essai> = {
    "(a) compilation": {
      sortie: "Building for production...\n/x/Foo.swift:3:5: error: cannot find 'x' in scope\nerror: fatalError",
      code: 1,
    },
    "(b) plantage": {
      sortie: `◇ Test run started.\n◇ Test ${PODMAN} started.\nerror: Exited with unexpected signal code 11`,
      code: 1,
    },
    "(c) illisible": { sortie: "n'importe quoi", code: 1 },
    "(d) test listé rouge puis plantage": {
      sortie: `${essaiRouge(CLIENT)}\nerror: Exited with unexpected signal code 11`,
      code: 1,
    },
    "(e) interruption": { sortie: essaiRouge(CLIENT), code: 130 },
    "(f) issue hors d'un test nommé": {
      sortie: ['✘ Suite "X" recorded an issue at X.swift:1:1: Expectation failed', RESUME_ROUGE].join("\n"),
      code: 1,
    },
  };
  for (const [nom, essai] of Object.entries(cas)) {
    const r = lancerSwiftApp(essai);
    assertRougeSansRelance(r, nom);
    assert.ok(r.sortie.includes(`${NON_ATTRIBUABLE}\n${L187}`), `${nom}\n${trace(r)}`);
    assert.ok(!r.sortie.includes("instable connu"), `${nom} : registre consulté\n${trace(r)}`);
    assert.ok(!r.sortie.includes("absent du registre"), `${nom} : registre consulté\n${trace(r)}`);
  }
});

test("known-flaky-tests-registry/AC-9 : ces tests tournent dans la section tests existante de check.sh, sans nouvelle entrée dans SECTION_IDS", () => {
  const fichier = "test/outillage/known-flaky-tests-registry.test.ts";
  for (const args of [[], ["--scope=macos"]]) {
    const r = spawnSync("bash", ["scripts/test-files.sh", ...args], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, output(r));
    assert.ok(
      r.stdout.split("\n").includes(fichier),
      `test-files.sh ${args.join(" ")} ne liste pas ${fichier}\n${output(r)}`,
    );
  }
  const check = fs.readFileSync(path.join(ROOT, "scripts/check.sh"), "utf8");
  const ids = /^SECTION_IDS="([^"]*)"$/m.exec(check)?.[1];
  assert.equal(ids, "catalogue noms plugins versions extension types rust smoke tests noyau app-swift app-ios");
});
