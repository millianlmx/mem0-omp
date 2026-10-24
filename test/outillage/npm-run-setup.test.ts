// Critères de la feature npm-run-setup : un clone neuf se prépare par une seule
// commande, `npm run setup`, qui enchaîne chaque `--prepare` des scripts ; avant
// elle, les tests qui dépendent d'un outil épinglé se sautent par
// `outilEpingleAbsent` (test/support/prerequis.ts) au lieu de rougir — et
// `check.sh --strict`, en CI, change ce saut en échec nommé.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, childEnv, tmpdir } from "../support/repo.ts";

const BIOME_VERSION = /^BIOME_VERSION="([^"]+)"$/m.exec(
  fs.readFileSync(path.join(ROOT, "scripts", "lint.sh"), "utf8"),
)?.[1];

/** Les scripts de scripts/ dont l'aiguillage d'arguments accepte `--prepare` comme mode. */
function scriptsAvecPrepare(): string[] {
  return fs
    .readdirSync(path.join(ROOT, "scripts"))
    .filter((nom) => nom.endsWith(".sh"))
    .filter((nom) =>
      /^\s*(?:\d+:)?--prepare\b[^)\n]*\)/m.test(fs.readFileSync(path.join(ROOT, "scripts", nom), "utf8")),
    )
    .sort();
}

test("npm-run-setup/AC-1 : `npm run setup` enchaîne exactement les `--prepare` des scripts, chacun sous `&&`", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const etapes = manifest.scripts.setup?.split(" && ") ?? [];
  const lances = etapes.map((etape) => {
    const m = /^bash scripts\/([a-z0-9-]+\.sh) --prepare$/.exec(etape);
    assert.ok(m, `étape de setup inattendue : ${etape}`);
    return m[1]!;
  });
  // Les outils du lint et du type-check d'abord : ce sont eux que check.sh exige partout.
  assert.deepEqual(lances.slice(0, 2), ["lint.sh", "typecheck.sh"]);
  assert.deepEqual([...lances].sort(), scriptsAvecPrepare());
});

test("npm-run-setup/AC-2 : Biome absent ou d'une autre version, un test qui en dépend se saute en nommant l'outil et `npm run setup`", () => {
  assert.ok(BIOME_VERSION, "BIOME_VERSION introuvable dans scripts/lint.sh");
  const dossier = tmpdir("npm-run-setup-");
  const sonde = path.join(dossier, "sonde.test.ts");
  fs.writeFileSync(
    sonde,
    [
      'import test from "node:test";',
      `import { outilEpingleAbsent } from ${JSON.stringify(path.join(ROOT, "test", "support", "prerequis.ts"))};`,
      'test("sonde", (t) => {',
      '  if (outilEpingleAbsent(t, "biome")) return;',
      "});",
      "",
    ].join("\n"),
  );
  const lancer = (lintDir: string) =>
    spawnSync("node", ["--test", "--experimental-strip-types", "--test-reporter=tap", sonde], {
      encoding: "utf8",
      env: childEnv({ MEM0_OMP_LINT_DIR: lintDir }),
    });

  const vide = lancer(tmpdir("npm-run-setup-vide-"));
  assert.equal(vide.status, 0, `${vide.stdout}${vide.stderr}`);
  assert.ok(
    vide.stdout.includes(
      `# SKIP prérequis absent : Biome ${BIOME_VERSION} épinglé (absent ; npm run setup ou bash scripts/lint.sh --prepare)`,
    ),
    vide.stdout,
  );

  const autre = tmpdir("npm-run-setup-autre-");
  fs.mkdirSync(path.join(autre, "node_modules", "@biomejs", "biome"), { recursive: true });
  fs.writeFileSync(path.join(autre, "node_modules", "@biomejs", "biome", "package.json"), '{"version":"0.0.0-faux"}\n');
  const faux = lancer(autre);
  assert.equal(faux.status, 0, `${faux.stdout}${faux.stderr}`);
  assert.ok(faux.stdout.includes(`Biome ${BIOME_VERSION} épinglé (0.0.0-faux trouvé ; npm run setup`), faux.stdout);

  // La bonne version dans le dossier désigné : aucun saut.
  const bon = tmpdir("npm-run-setup-bon-");
  fs.mkdirSync(path.join(bon, "node_modules", "@biomejs", "biome"), { recursive: true });
  fs.writeFileSync(
    path.join(bon, "node_modules", "@biomejs", "biome", "package.json"),
    `${JSON.stringify({ version: BIOME_VERSION })}\n`,
  );
  const pret = lancer(bon);
  assert.equal(pret.status, 0, `${pret.stdout}${pret.stderr}`);
  assert.ok(!pret.stdout.includes("# SKIP"), pret.stdout);
  assert.match(pret.stdout, /^# pass 1$/m, pret.stdout);
});

test("npm-run-setup/AC-3 : CONTRIBUTING.md et DEVELOPPEMENT.md donnent `npm run setup` au contributeur d'un clone neuf", () => {
  for (const doc of ["CONTRIBUTING.md", "DEVELOPPEMENT.md"]) {
    assert.ok(
      fs.readFileSync(path.join(ROOT, doc), "utf8").includes("`npm run setup`"),
      `${doc} : \`npm run setup\` absent`,
    );
  }
});
