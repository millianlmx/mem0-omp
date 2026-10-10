// Les gardes TEXTUELLES de la feature `client-distant-ios` : les preuves de CI
// (AC-19), le scénario manuel doublé de sa recette gated (AC-20) et la surface
// iOS en composants système (AC-21).
//
// INVARIANT DE NOMMAGE : `criteria/AC-13` exige qu'un slug de feature vive dans
// UN SEUL fichier de `test/*.test.ts` et qu'un id qualifié désigne UN SEUL test.
// Les trois critères de `client-distant-ios` vivent donc ICI, un test par
// critère, chacun portant son id QUALIFIÉ (jamais la forme nue `AC-<n>`).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHELL = path.join(ROOT, "omp-console");
const IOS_APP = path.join(SHELL, "ios", "OMPConsoleIOS");
const CLIENT_TESTS = path.join(SHELL, "Tests", "ConsoleClientTests");
const CHECK = path.join(ROOT, "scripts", "check.sh");
const SWIFT_APP = path.join(ROOT, "scripts", "swift-app.sh");
const CHECK_YML = path.join(ROOT, ".github", "workflows", "check.yml");
const MANIFEST = path.join(SHELL, "Package.swift");
const CONTRACT = path.join(ROOT, ".omp", "pipeline", "contract.md");
const CONTRACT_TESTS = path.join(SHELL, "Tests", "OMPConsoleTests", "ClientContractTests.swift");

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Toutes les sources Swift d'une racine, en ordre stable. */
function swiftFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry): string[] => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return swiftFiles(full);
      return entry.name.endsWith(".swift") ? [full] : [];
    })
    .sort();
}

/** Les sources de l'APP iOS, commentaires retirés, concaténées. */
function appCode(): string {
  const files = fs.existsSync(IOS_APP) ? swiftFiles(IOS_APP) : [];
  assert.ok(files.length > 0, `aucune source Swift sous ${path.relative(ROOT, IOS_APP)}`);
  return files.map((file) => code(file)).join("\n");
}

/** Une section d'un script shell : de son marqueur jusqu'à la fin du fichier. */
function section(source: string, marker: string): string {
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `la section « ${marker} » doit exister`);
  return source.slice(index);
}

// AC-19 : la CI compile la cible iOS et joue les tests hermétiques de la couche.
// Ce test porte sur les artefacts de CI, pas sur un run — il exige que le câblage
// soit en place et que les suites hermétiques existent.
test("client-distant-ios/AC-19 : la CI compile l'iOS et joue les tests hermétiques de la couche", () => {
  const check = fs.readFileSync(CHECK, "utf8");

  // La section « App iOS » appelle le script de compilation iOS.
  const iosSection = section(check, "── App iOS");
  assert.match(iosSection, /scripts\/ios-build\.sh/, "la section « App iOS » appelle scripts/ios-build.sh");

  // La section « App Swift » appelle le script qui joue `swift test`.
  const swiftSection = section(check, "── App Swift");
  assert.match(swiftSection, /scripts\/swift-app\.sh/, "la section « App Swift » appelle scripts/swift-app.sh");

  // Le manifeste déclare la cible cliente et sa cible de tests.
  const manifest = fs.readFileSync(MANIFEST, "utf8");
  assert.match(manifest, /\.target\(\s*name:\s*"ConsoleClient"/, "Package.swift déclare la cible ConsoleClient");
  assert.match(
    manifest,
    /\.testTarget\(\s*name:\s*"ConsoleClientTests"/,
    "Package.swift déclare la cible de tests ConsoleClientTests",
  );

  // Les suites hermétiques couvrent les quatre chemins d'échec nommés par B-10.
  const expected = [
    "PairingTests.swift", // appairage / Mac absent
    "VersionTests.swift", // version d'API incompatible
    "RevocationTests.swift", // jeton révoqué
    "ReconnectTests.swift", // reconnexion
    "StateTests.swift", // états honnêtes (dont Mac absent)
  ];
  for (const name of expected) {
    const file = path.join(CLIENT_TESTS, name);
    assert.ok(fs.existsSync(file), `la suite hermétique ${name} doit exister sous omp-console/Tests/ConsoleClientTests/`);
  }

  // L'exigence iOS (un « non exécuté » est un échec en CI) est portée par le
  // script Swift de la coque ou par le workflow.
  const require = [SWIFT_APP, CHECK_YML]
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  assert.match(
    require,
    /MEM0_OMP_REQUIRE_IOS/,
    "swift-app.sh ou .github/workflows/check.yml doit porter MEM0_OMP_REQUIRE_IOS",
  );
});

// AC-20 : le scénario manuel est écrit dans le contrat ET la recette gated existe.
test("client-distant-ios/AC-20 : le scénario manuel et sa recette gated sont en place", () => {
  // Le scénario vit dans le contrat `.omp/pipeline/contract.md`, un artefact
  // GITIGNORÉ : une copie git (`git worktree`, la simulation de release) et la CI
  // ne le portent pas — et un worktree VOISIN porte le contrat d'une AUTRE
  // feature. On n'éprouve donc les marqueurs que quand le contrat est bien le
  // nôtre : il se nomme lui-même. La preuve TRACKÉE (la recette gated) est
  // exigée sans condition.
  if (fs.existsSync(CONTRACT)) {
    const contract = fs.readFileSync(CONTRACT, "utf8");
    if (contract.includes("feature `client-distant-ios`")) {
      for (const marker of ["Mode avion ACTIVÉ", "Jeton révoqué", "Effacer", "appairage"]) {
        assert.ok(contract.includes(marker), `le contrat doit porter le marqueur du scénario « ${marker} »`);
      }
    }
  }

  assert.ok(fs.existsSync(CONTRACT_TESTS), "la recette AC-20 vit dans ClientContractTests.swift");
  const recipe = fs.readFileSync(CONTRACT_TESTS, "utf8");
  assert.match(recipe, /MEM0_REMOTE_RECIPE/, "la recette est gated par MEM0_REMOTE_RECIPE");
  assert.match(recipe, /clientDistantRecipe/, "la recette est ciblable par swift test --filter clientDistantRecipe");
  assert.ok(
    recipe.includes("client-distant-ios/AC-20"),
    "le titre de la recette porte l'id qualifié client-distant-ios/AC-20",
  );
});

// AC-21 : les surfaces de connexion reposent sur des composants système, sans
// composant visuel maison, et portent les quatre zones et leurs identifiants.
test("client-distant-ios/AC-21 : la feuille de connexion n'emploie que des composants système", () => {
  const source = appCode();

  // (a) Les quatre zones et leurs identifiants d'accessibilité (S-11).
  const identifiers = [
    "connection.sheet",
    "connection.state",
    "connection.endpoint",
    "connection.discovered",
    "connection.denied",
    "connection.address",
    "connection.address.save",
    "connection.address.clear",
    "connection.address.error",
    "connection.code",
    "connection.code.pair",
    "connection.code.error",
    "connection.retry",
    "connection.close",
  ];
  for (const identifier of identifiers) {
    assert.ok(source.includes(`"${identifier}"`), `l'identifiant d'accessibilité « ${identifier} » doit être posé`);
  }

  // (b) La liste blanche des composants système est réellement employée.
  const system: Array<[RegExp, string]> = [
    [/\bForm\b/, "Form"],
    [/\bSection\b/, "Section"],
    [/\bText\(/, "Text"],
    [/\bTextField\(/, "TextField"],
    [/\bButton\(/, "Button"],
    [/\bLabel\(/, "Label"],
    [/Image\(/, "Image"],
    [/\bProgressView\(/, "ProgressView"],
    [/\bNavigationStack\b/, "NavigationStack"],
    [/\bToolbarItem\b/, "ToolbarItem"],
  ];
  for (const [pattern, name] of system) {
    assert.match(source, pattern, `la surface doit employer le composant système ${name}`);
  }

  // (b) Aucun composant visuel maison dans les surfaces de CETTE feature : le
  //     reste de l'app appartient aux autres features — le kit de `design-ios`
  //     porte l'habillage, `ViewModifier` privés compris, et son contrat le lui
  //     réserve. La liste blanche ci-dessus reste, elle, globale.
  const own = ["ConnectionSheet.swift", "ConnectionText.swift"]
    .map((name) => path.join(IOS_APP, name))
    .filter((file) => fs.existsSync(file))
    .map((file) => code(file))
    .join("\n");
  assert.ok(own.length > 0, "les sources de la feuille de connexion doivent exister");
  assert.doesNotMatch(
    own,
    /\bShape\b|\bPath\s*\(|\bCanvas\b|\bViewModifier\b|\bButtonStyle\b|\bLabelStyle\b/,
    "aucun composant visuel maison (Shape, Path(, Canvas, ViewModifier, ButtonStyle, LabelStyle)",
  );

  // (c) `ConnectionText` et ses libellés exacts de S-11.
  assert.match(source, /enum ConnectionText\b/, "la feuille déclare enum ConnectionText");
  const labels = [
    "Non appairé",
    "Recherche d’un Mac…",
    "Hors réseau",
    "Jeton révoqué",
    "Version de protocole incompatible",
    "Aucun Mac trouvé.",
    "Adresse manuelle",
    "Appairer",
    "Fermer",
  ];
  for (const label of labels) {
    assert.ok(source.includes(label), `ConnectionText doit porter le libellé exact « ${label} »`);
  }
});
