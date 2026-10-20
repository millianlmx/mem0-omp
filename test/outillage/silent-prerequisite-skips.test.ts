// Critères de la feature silent-prerequisite-skips : le mode `--strict` de
// `scripts/check.sh`, qui change en échec nommé tout saut faute de prérequis
// installable (forme unique `prerequisAbsent` de test/support/prerequis.ts) et
// toute absence que MEM0_OMP_REQUIRE_SMOKE/RUST/IOS=1 durcirait, sans toucher aux
// sauts de plateforme, de copie imbriquée ni aux neutralisations MEM0_OMP_SKIP_*.
//
// Trois règles structurent ce fichier, comme test/outillage/ci-macos-jobs-paralleles.test.ts :
//  1. ce qui lance `── Tests` tourne dans une COPIE LÉGÈRE dont le dossier test/
//     ne contient que des fixtures — jamais la vraie suite ;
//  2. ce qui exige une copie du dépôt (sections app-swift/app-ios) ne tourne
//     qu'au premier niveau (`MEM0_CHECK_DEPTH`) ;
//  3. les enfants reçoivent les trois MEM0_OMP_REQUIRE_* VIDES (la CI les pose et
//     la suite les hérite), surchargés cas par cas.
//
// Les sources des fixtures sont assemblées par concaténation, jamais écrites en
// début de ligne sous la forme `test("…")` : le scanner de criteria/AC-13 les
// prendrait pour des tests de ce fichier.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, childEnv, sharedRepo, tmpdir } from "../support/repo.ts";

const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");
const NESTED = "copie jetable — les sections réelles sont éprouvées au premier niveau";
/** PATH sans cargo, bun ni node sur un poste ou un runner ordinaire. */
const BARE_PATH = "/usr/bin:/bin";

const output = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;
const lines = (text: string) => text.split("\n");

function runCheck(cwd: string, args: string[], extra: Record<string, string> = {}) {
  return spawnSync("bash", ["scripts/check.sh", ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv({
      MEM0_CHECK_DEPTH: String(DEPTH + 1),
      MEM0_OMP_SKIP_SWIFT_APP: "1",
      MEM0_OMP_SKIP_IOS: "1",
      MEM0_OMP_SKIP_RUST: "1",
      MEM0_OMP_REQUIRE_SMOKE: "",
      MEM0_OMP_REQUIRE_RUST: "",
      MEM0_OMP_REQUIRE_IOS: "",
      ...extra,
    }),
    timeout: 900_000,
  });
}

/** Vrai si `bin` est trouvé dans `searchPath` — un saut non-prérequis s'impose alors. */
const presentIn = (bin: string, searchPath: string) =>
  searchPath.split(":").some((dir) => fs.existsSync(path.join(dir, bin)));

/** Un test fixture : `body` reçoit `t`. */
const fixtureTest = (title: string, body: string) => "test(" + JSON.stringify(title) + ", async (t) => { " + body + " });";

/** Fichier de test fixture qui importe la forme unique du saut. */
function fixture(...tests: string[]): string {
  return [
    'import test from "node:test";',
    'import { prerequisAbsent } from "../support/prerequis.ts";',
    "void prerequisAbsent;",
    ...tests,
    "",
  ].join("\n");
}

/** Copie légère : ce dont `--sections=tests` a besoin, le module de saut, et un test/ de fixtures. */
function lightCopy(tests: Record<string, string>): string {
  const dir = tmpdir("strict-copie-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "test", "support"), { recursive: true });
  for (const script of ["check.sh", "test-files.sh"]) {
    fs.copyFileSync(path.join(ROOT, "scripts", script), path.join(dir, "scripts", script));
  }
  fs.copyFileSync(path.join(ROOT, "test", "support", "prerequis.ts"), path.join(dir, "test", "support", "prerequis.ts"));
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  for (const [name, source] of Object.entries(tests)) {
    const target = path.join(dir, "test", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  return dir;
}

/** Le saut « prérequis absent » de référence (S-2, exemple d'acceptation). */
const TOOL_SKIP = fixtureTest("fixture/AC-1 : outil requis", 'prerequisAbsent(t, "outil-fictif", "preuve non exécutée");');
const TOOL_LINE =
  "  ✗ test sauté en mode strict : « fixture/AC-1 : outil requis » — prérequis absent : outil-fictif — preuve non exécutée";

const STRICT_SKIP = "  ✗ test sauté en mode strict : ";

/** Doublure d'exécutable en tête de PATH (patron de test/console/coque-ios.test.ts). */
function stubBin(prefix: string): { bin: string; log: string } {
  const bin = tmpdir(prefix);
  return { bin, log: path.join(bin, "appels.log") };
}

function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

// Une seule copie du dépôt (sans aucun fichier de test) pour les sections app-*.
const shared = sharedRepo("strict-depot-", { keepTest: () => false });

test("silent-prerequisite-skips/AC-1 : sans --strict, un prérequis installable absent reste un saut et check.sh reste vert", async (t) => {
  // Test de test/ sauté par prerequisAbsent : vert, compteur de sauts imprimé.
  const dir = lightCopy({ "outillage/fixture.test.ts": fixture(TOOL_SKIP) });
  const run = runCheck(dir, ["--sections=tests"]);
  const out = output(run);
  assert.equal(run.status, 0, out);
  assert.ok(out.includes("# skipped 1\n"), out);
  assert.ok(out.includes("  ✓ tests unitaires"), out);
  assert.ok(!out.includes("  ✗ "), out);

  // Toolchain Rust absente : saut annoncé, comme aujourd'hui.
  await t.test("cargo absent du PATH", (st) => {
    if (presentIn("cargo", BARE_PATH)) {
      st.skip(`cargo présent dans ${BARE_PATH}`);
      return;
    }
    const rust = runCheck(ROOT, ["--sections=rust"], { PATH: BARE_PATH, MEM0_OMP_SKIP_RUST: "" });
    assert.equal(rust.status, 0, output(rust));
    assert.ok(
      output(rust).includes("  · cargo absent, sections Rust non exécutées (installe la toolchain : https://rustup.rs)\n"),
      output(rust),
    );
  });
});

test("silent-prerequisite-skips/AC-2 : en --strict, chaque saut « prérequis absent » fait sortir check.sh en échec", () => {
  const dir = lightCopy({
    "outillage/fixture.test.ts": fixture(
      TOOL_SKIP,
      fixtureTest("fixture/parent", 'await t.test("sous-test requis", (st) => prerequisAbsent(st, "autre-outil", "sous-preuve non exécutée"));'),
      fixtureTest("fixture/passe", ""),
    ),
  });
  const run = runCheck(dir, ["--sections=tests", "--strict"]);
  const out = output(run);
  assert.equal(run.status, 1, out);
  assert.deepEqual(
    lines(out).filter((line) => line.startsWith(STRICT_SKIP)),
    [
      TOOL_LINE,
      "  ✗ test sauté en mode strict : « sous-test requis » — prérequis absent : autre-outil — sous-preuve non exécutée",
    ],
    out,
  );
  assert.ok(!out.includes("  ✓ tests unitaires"), out);
  assert.ok(out.includes("# skipped 2\n"), out);

  // L'option elle-même : répétée, elle ne lance rien (S-1).
  const twice = runCheck(dir, ["--strict", "--sections=tests", "--strict"]);
  assert.equal(twice.status, 1, output(twice));
  assert.equal(twice.stderr, "✗ option répétée : --strict\n");
  assert.equal(twice.stdout, "", "aucune section ne doit s'exécuter");
});

test("silent-prerequisite-skips/AC-3 : hors macOS, --strict laisse les sauts de plateforme et les « non exécuté » Swift/iOS", (t) => {
  // Un saut de plateforme dans test/ reste un saut.
  const dir = lightCopy({
    "outillage/fixture.test.ts": fixture(fixtureTest("fixture/macos", 't.skip("macOS seul — fixture");')),
  });
  const tests = runCheck(dir, ["--sections=tests", "--strict"]);
  assert.equal(tests.status, 0, output(tests));
  assert.ok(output(tests).includes("# skipped 1\n"), output(tests));
  assert.ok(output(tests).includes("  ✓ tests unitaires"), output(tests));

  if (DEPTH > 0) {
    t.skip(NESTED);
    return;
  }
  // Sections app-swift et app-ios sous un `uname` Linux : « non exécuté », sans
  // ✓ ni ✗, et sans jamais appeler swift ni xcodebuild.
  const { bin, log } = stubBin("strict-linux-");
  stub(bin, "uname", "printf 'Linux\\n'");
  stub(bin, "swift", `printf 'swift %s\\n' "$*" >> '${log}'`);
  stub(bin, "xcodebuild", `printf 'xcodebuild %s\\n' "$*" >> '${log}'`);
  const run = runCheck(shared.fresh(), ["--sections=app-swift,app-ios", "--strict"], {
    PATH: `${bin}:${process.env.PATH}`,
    MEM0_OMP_SKIP_SWIFT_APP: "",
    MEM0_OMP_SKIP_IOS: "",
  });
  const out = output(run);
  assert.equal(run.status, 0, out);
  assert.equal(lines(out).filter((line) => line.includes("non exécuté")).length, 2, out);
  assert.ok(!/[✓✗] App/.test(out), out);
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  assert.equal(calls, "", "swift et xcodebuild ne doivent jamais être appelés hors macOS");
});

test("silent-prerequisite-skips/AC-4 : en --strict, les sauts de copie imbriquée et les MEM0_OMP_SKIP_* restent des sauts", (t) => {
  const dir = lightCopy({
    "outillage/fixture.test.ts": fixture(fixtureTest("fixture/imbriquee", 't.skip("copie imbriquée — fixture");')),
  });
  const tests = runCheck(dir, ["--sections=tests", "--strict"]);
  assert.equal(tests.status, 0, output(tests));
  assert.ok(output(tests).includes("# skipped 1\n"), output(tests));
  assert.ok(output(tests).includes("  ✓ tests unitaires"), output(tests));

  if (DEPTH > 0) {
    t.skip(NESTED);
    return;
  }
  // Les neutralisations des copies jetables priment sur --strict, même sans
  // cargo, swift ni Xcode à portée.
  const run = runCheck(shared.fresh(), ["--sections=rust,app-swift,app-ios", "--strict"], { PATH: BARE_PATH });
  const out = output(run);
  assert.equal(run.status, 0, out);
  for (const name of ["RUST", "SWIFT_APP", "IOS"]) {
    assert.ok(out.includes(`  · ignorée (MEM0_OMP_SKIP_${name}=1)\n`), out);
  }
});

test("silent-prerequisite-skips/AC-5 : en --strict, la section Tests rougit et nomme le test et le prérequis manquant", () => {
  const dir = lightCopy({ "outillage/fixture.test.ts": fixture(TOOL_SKIP) });
  const run = runCheck(dir, ["--sections=tests", "--strict"]);
  const out = output(run);
  assert.equal(run.status, 1, out);
  assert.ok(out.includes("── Tests\n"), out);
  assert.ok(lines(out).includes(TOOL_LINE), out);

  // Un `#` du titre est échappé par le reporter TAP : le titre est recopié tel
  // quel, et la directive est le premier ` # SKIP `.
  fs.writeFileSync(
    path.join(dir, "test", "outillage", "fixture.test.ts"),
    fixture(fixtureTest("fixture/diese # SKIP leurre", 'prerequisAbsent(t, "outil\\n  multiligne ", "preuve non exécutée");')),
  );
  const hash = output(runCheck(dir, ["--sections=tests", "--strict"]));
  assert.deepEqual(
    lines(hash).filter((line) => line.startsWith(STRICT_SKIP)),
    ["  ✗ test sauté en mode strict : « fixture/diese \\# SKIP leurre » — prérequis absent : outil multiligne — preuve non exécutée"],
    hash,
  );

  // Node rend ≠ 0 : le diagnostic reste, les sauts nommés précèdent le ✗ final.
  fs.writeFileSync(
    path.join(dir, "test", "outillage", "fixture.test.ts"),
    fixture(TOOL_SKIP, fixtureTest("fixture/tombe", 'throw new Error("échec de fixture");')),
  );
  const red = runCheck(dir, ["--sections=tests", "--strict"]);
  const redLines = lines(output(red));
  assert.equal(red.status, 1, output(red));
  assert.ok(redLines.some((line) => line.startsWith("not ok") && line.includes("fixture/tombe")), output(red));
  const named = redLines.indexOf(TOOL_LINE);
  assert.ok(named > 0, output(red));
  assert.ok(redLines[named + 1]?.startsWith("  ✗ tests unitaires — relance : "), output(red));
});

test("silent-prerequisite-skips/AC-6 : une variable MEM0_OMP_REQUIRE_* seule durcit son domaine, et lui seul", async (t) => {
  await t.test("REQUIRE_SMOKE / REQUIRE_RUST sans bun ni cargo", (st) => {
    if (presentIn("bun", BARE_PATH) || presentIn("cargo", BARE_PATH)) {
      st.skip(`bun ou cargo présent dans ${BARE_PATH}`);
      return;
    }
    const smoke = runCheck(ROOT, ["--sections=smoke"], { PATH: BARE_PATH, MEM0_OMP_REQUIRE_SMOKE: "1" });
    assert.equal(smoke.status, 1, output(smoke));
    assert.ok(lines(output(smoke)).includes("  ✗ plugins réels : bun absent"), output(smoke));

    const other = runCheck(ROOT, ["--sections=smoke"], { PATH: BARE_PATH, MEM0_OMP_REQUIRE_RUST: "1" });
    assert.equal(other.status, 0, output(other));
    assert.ok(lines(output(other)).includes("  · bun absent, plugins réels non vérifiés"), output(other));

    // Sous la variable, le message historique est inchangé, --strict ou non.
    for (const args of [["--sections=rust"], ["--sections=rust", "--strict"]]) {
      const rust = runCheck(ROOT, args, { PATH: BARE_PATH, MEM0_OMP_SKIP_RUST: "", MEM0_OMP_REQUIRE_RUST: "1" });
      assert.equal(rust.status, 1, `${args.join(" ")} :\n${output(rust)}`);
      assert.ok(lines(output(rust)).includes("  ✗ Rust mem0-rs — cargo absent (MEM0_OMP_REQUIRE_RUST=1)"), output(rust));
    }
  });

  await t.test("REQUIRE_IOS hors macOS", (st) => {
    if (DEPTH > 0) {
      st.skip(NESTED);
      return;
    }
    const { bin } = stubBin("strict-ios-linux-");
    stub(bin, "uname", "printf 'Linux\\n'");
    const ios = runCheck(shared.fresh(), ["--sections=app-ios", "--strict"], {
      PATH: `${bin}:${process.env.PATH}`,
      MEM0_OMP_SKIP_IOS: "",
      MEM0_OMP_REQUIRE_IOS: "1",
    });
    assert.notEqual(ios.status, 0, output(ios));
    assert.ok(output(ios).includes("✗ App iOS"), output(ios));
  });
});

test("silent-prerequisite-skips/AC-7 : --strict durcit seul les prérequis que les MEM0_OMP_REQUIRE_* durciraient", async (t) => {
  await t.test("rust : cargo absent", (st) => {
    if (presentIn("cargo", BARE_PATH)) {
      st.skip(`cargo présent dans ${BARE_PATH}`);
      return;
    }
    const rust = runCheck(ROOT, ["--sections=rust", "--strict"], { PATH: BARE_PATH, MEM0_OMP_SKIP_RUST: "" });
    assert.equal(rust.status, 1, output(rust));
    assert.ok(lines(output(rust)).includes("  ✗ Rust mem0-rs — cargo absent (--strict)"), output(rust));
  });

  await t.test("smoke : bun absent", (st) => {
    if (presentIn("bun", BARE_PATH)) {
      st.skip(`bun présent dans ${BARE_PATH}`);
      return;
    }
    const smoke = runCheck(ROOT, ["--sections=smoke", "--strict"], { PATH: BARE_PATH });
    assert.equal(smoke.status, 1, output(smoke));
    assert.ok(lines(output(smoke)).includes("  ✗ plugins réels : bun absent (--strict)"), output(smoke));
  });

  await t.test("app-ios : Xcode inutilisable sous macOS", (st) => {
    if (DEPTH > 0) {
      st.skip(NESTED);
      return;
    }
    const copy = shared.fresh();
    fs.writeFileSync(
      path.join(copy, "scripts", "ios-build.sh"),
      '#!/usr/bin/env bash\necho "  · non exécuté : Xcode inutilisable (doublure)"\nexit 2\n',
    );
    const { bin } = stubBin("strict-ios-darwin-");
    stub(bin, "uname", "printf 'Darwin\\n'");
    const env = { PATH: `${bin}:${process.env.PATH}`, MEM0_OMP_SKIP_IOS: "" };
    const ios = runCheck(copy, ["--sections=app-ios", "--strict"], env);
    assert.equal(ios.status, 1, output(ios));
    assert.ok(
      lines(output(ios)).includes(
        "  ✗ App iOS — Xcode inutilisable (--strict) (relance : DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bash scripts/ios-build.sh)",
      ),
      output(ios),
    );
    // Sans --strict, la même absence reste un « non exécuté ».
    const lax = runCheck(copy, ["--sections=app-ios"], env);
    assert.equal(lax.status, 0, output(lax));
    assert.ok(!output(lax).includes("✗"), output(lax));
  });

  await t.test("tests : node absent", (st) => {
    if (presentIn("node", BARE_PATH)) {
      st.skip(`node présent dans ${BARE_PATH}`);
      return;
    }
    const dir = lightCopy({ "outillage/fixture.test.ts": fixture(fixtureTest("fixture/passe", "")) });
    const tests = runCheck(dir, ["--sections=tests", "--strict"], { PATH: BARE_PATH });
    assert.equal(tests.status, 1, output(tests));
    assert.ok(lines(output(tests)).includes("  ✗ tests unitaires — node absent (--strict)"), output(tests));
  });
});
