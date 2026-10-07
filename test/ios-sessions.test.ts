// Les GARDES TEXTUELLES de la feature `ios-sessions` (BR-7) : le noyau des
// faits de session vit dans ConsoleCore (une seule dérivation pour les deux
// coques), la section `.sessions` route vers `IOSSessionsScreen`, les composants
// réutilisables ne nomment aucun type de la section Sessions, la visionneuse est
// en LECTURE SEULE, la fixture de parité porte ses deux membres, et la recette
// `-sessions.recipe` existe et est documentée par le README.
//
// Mêmes règles structurelles que `test/coque-ios.test.ts` et
// `test/ios-accueil.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout — une copie
//     contient le même arbre.
//
// `test/criteria.test.ts` (AC-13) exige qu'un id qualifié `<slug>/AC-<n>` ne vive
// que dans UN SEUL test de `test/*.test.ts` : ce fichier est le seul de `test/` à
// porter le slug `ios-sessions`, et ses ids sont uniques ici.
//
// Les preuves Swift de chaque critère vivent dans les suites iOS/macOS, que ce
// fichier NOMME sans les remplacer :
//  - AC-1/AC-2 `listGroupsByDay`, `projectFilter` (IOSSessionTests.swift) ;
//  - AC-3 `parityRows` + SessionParityTests.swift (macOS) ;
//  - AC-4 `unreadableAndTruncated` (IOSSessionTests.swift) ;
//  - AC-5 `askHighlighted` (aucun geste de réponse) et CETTE garde (appels) ;
//  - AC-6 `foldsAndDiffs` ; AC-7 `askHighlighted` ; AC-8 `additionsDoNotReload`
//    et `followPolicy` ; AC-9 `runStatusTransition` (IOSSessionTests.swift) ;
//  - AC-10 `componentIsReusable` (IOSSessionTests.swift) ;
//  - AC-11 `parityRows` (iOS) et SessionParityTests.swift (macOS).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHELL = path.join(ROOT, "omp-console");
const CORE = path.join(SHELL, "Sources", "ConsoleCore");
const MACOS = path.join(SHELL, "Sources", "OMPConsole");
const IOS_APP = path.join(SHELL, "ios", "OMPConsoleIOS");

// Ce qui n'a rien à faire dans une copie : l'historique, les dépendances, les
// racines de build et de types jetables, le stockage vectoriel local. Les racines
// de build Swift (`--scratch-path .build-<quoi>`) sont reconnues par PRÉFIXE.
const EXCLUDED_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
  build: true,
};

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Une copie du dépôt où l'on peut planter une faute. */
function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-sessions-copie-"));
  dirs.push(dir);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((segment) => EXCLUDED_DIRS[segment] === true || segment.startsWith(".build"))) {
        return false;
      }
      if (rel === path.join("test", "check.test.ts")) return false;
      return true;
    },
  });
  return dir;
}

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inBlock = false;
  while (i < source.length) {
    if (inBlock) {
      if (source.startsWith("*/", i)) {
        inBlock = false;
        i += 2;
      } else i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (source.startsWith("/*", i)) {
      inBlock = true;
      i += 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/** Le source d'un fichier, commentaires retirés, ou la chaîne vide. */
function code(file: string): string {
  return fs.existsSync(file) ? stripComments(fs.readFileSync(file, "utf8")) : "";
}

/** Toutes les sources `.swift` d'une racine, commentaires retirés, concaténées. */
function swiftText(dir: string): string {
  const out: string[] = [];
  const walk = (current: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) out.push(stripComments(fs.readFileSync(full, "utf8")));
    }
  };
  walk(dir);
  return out.join("\n");
}

/** Les sources de l'APP iOS, nom de fichier → source (commentaires retirés). */
function appSources(root: string): { name: string; code: string }[] {
  const dir = path.join(root, "omp-console", "ios", "OMPConsoleIOS");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => ({ name, code: stripComments(fs.readFileSync(path.join(dir, name), "utf8")) }));
}

/**
 * Les fichiers de la feature, ceux dont le périmètre est jugé ici : la section
 * Sessions (écran, modèle, mots, recette) et les quatre composants du fil.
 */
const FEATURE_FILES = [
  "IOSSessionsScreen.swift",
  "IOSSessionsModel.swift",
  "IOSSessionText.swift",
  "IOSSessionsRecipe.swift",
  "IOSSessionThreadModel.swift",
  "IOSSessionThreadView.swift",
  "IOSSessionRowView.swift",
  "IOSSessionViewerSheet.swift",
];

/**
 * Les composants RÉUTILISABLES (S-10) : leur seul contrat d'entrée est une
 * référence de session et une source — ils ne nomment aucun type de la section.
 */
const COMPONENT_FILES = [
  "IOSSessionThreadModel.swift",
  "IOSSessionThreadView.swift",
  "IOSSessionRowView.swift",
  "IOSSessionViewerSheet.swift",
];

/** Les types de la SECTION Sessions : interdits dans les composants (S-10). */
const SECTION_TYPES = ["IOSSessionsScreen", "IOSSessionsModel", "IOSSectionView", "IOSSectionContent"];

/** Les types DÉPLACÉS dans ConsoleCore par BR-1 (un seul noyau pour deux coques). */
const SHARED_TYPES = ["SessionList", "SessionDays", "SessionRowBuilder", "FollowPolicy", "SessionDiffText", "SessionParity"];

/** Un appel d'écriture sur la session : aucune route de la coque (S-5). */
const WRITE_CALL = /\.(answer|reply|text|verdict|resume|stop|prompt|merge)\(/;

/** Un type est DÉCLARÉ (jamais une extension) dans une source. */
function declares(text: string, name: string, isPublic = false): boolean {
  const prefix = isPublic ? "\\bpublic\\s+" : "\\b";
  return new RegExp(`${prefix}(?:struct|enum|class|actor)\\s+${name}\\b`).test(text);
}

/** Les manques du noyau partagé (S-1). Vide quand tout est là. */
function kernelFaults(root: string): string[] {
  const faults: string[] = [];
  const core = swiftText(path.join(root, "omp-console", "Sources", "ConsoleCore"));
  const macos = swiftText(path.join(root, "omp-console", "Sources", "OMPConsole"));
  for (const name of SHARED_TYPES) {
    if (!declares(core, name, true)) faults.push(`ConsoleCore ne déclare pas ${name} public`);
    if (declares(macos, name)) faults.push(`la coque macOS déclare encore ${name}`);
  }
  return faults;
}

/** Le routage de la section `.sessions` vers son écran réel (S-1). Vide quand tout est là. */
function routeFaults(root: string): string[] {
  const faults: string[] = [];
  const view = code(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSectionView.swift"));
  if (!/section\s*==\s*\.sessions/.test(view)) faults.push("IOSSectionView ne teste pas `section == .sessions`");
  if (!view.includes("IOSSessionsScreen(")) faults.push("IOSSectionView ne monte pas IOSSessionsScreen");
  return faults;
}

/** Les manques du noyau de la recette (S-8). Vide quand tout est là. */
function recipeFaults(root: string): string[] {
  const faults: string[] = [];
  if (!fs.existsSync(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionsRecipe.swift"))) {
    faults.push("IOSSessionsRecipe.swift absent");
  }
  const app = appSources(root)
    .map((s) => s.code)
    .join("\n");
  if (!app.includes("IOSSessionsRecipe.resolve(")) faults.push("l'app ne lit pas IOSSessionsRecipe.resolve");
  if (!app.includes('"-sessions.recipe"')) faults.push('le drapeau "-sessions.recipe" est absent des sources iOS');
  const readme = fs.readFileSync(path.join(root, "omp-console", "README.md"), "utf8");
  for (const token of ["-sessions.recipe", "liste", "vide", "visionneuse", "illisible", "en-direct", "omp-console/ios/DESIGN.md"]) {
    if (!readme.includes(token)) faults.push(`README console : « ${token} » absent`);
  }
  return faults;
}

/** Les jetons d'écriture interdits dans les fichiers de la feature (S-5). Vide quand tout est là. */
function writeFaults(root: string): string[] {
  const faults: string[] = [];
  for (const { name, code: text } of appSources(root)) {
    if (!FEATURE_FILES.includes(name)) continue;
    if (text.includes("TextField")) faults.push(`${name} nomme TextField`);
    if (text.includes("UserDefaults")) faults.push(`${name} nomme UserDefaults`);
    text.split("\n").forEach((line, index) => {
      // Un motif de `case .text(let …)` n'est pas un appel : on ne juge qu'un
      // appel portant un point, hors ligne `case …`.
      if (line.includes("case ")) return;
      if (WRITE_CALL.test(line)) faults.push(`${name}:${index + 1} appelle une écriture de session`);
    });
  }
  return faults;
}

/** Les manques de l'isolation des composants réutilisables (S-10). Vide quand tout est là. */
function componentFaults(root: string): string[] {
  const faults: string[] = [];
  const sources = appSources(root);
  for (const { name, code: text } of sources) {
    if (!COMPONENT_FILES.includes(name)) continue;
    for (const type of SECTION_TYPES) {
      if (new RegExp(`\\b${type}\\b`).test(text)) faults.push(`${name} nomme le type de section ${type}`);
    }
  }
  // Aucun composant livré n'est orphelin : un autre fichier de l'app le monte.
  for (const name of COMPONENT_FILES) {
    const type = name.replace(/\.swift$/, "");
    const employed = sources.some((other) => other.name !== name && new RegExp(`\\b${type}\\b`).test(other.code));
    if (!employed) faults.push(`${name} n'est monté par aucun autre fichier`);
  }
  return faults;
}

/** Les manques de la fixture de parité (S-11). Vide quand tout est là. */
function parityFaults(root: string): string[] {
  const faults: string[] = [];
  const parity = code(path.join(root, "omp-console", "Sources", "ConsoleCore", "Session", "SessionParity.swift"));
  if (parity === "") return ["ConsoleCore/Session/SessionParity.swift absent"];
  if (!/public\s+static\s+let\s+lines\b/.test(parity)) faults.push("SessionParity ne déclare pas `lines`");
  if (!/public\s+static\s+let\s+payloadJSON\b/.test(parity)) faults.push("SessionParity ne déclare pas `payloadJSON`");
  return faults;
}

// ---------------------------------------------------------------------------
// Les tests, un par critère. Chacun exige l'arbre réel sain PUIS plante une
// faute dans une copie jetable et exige que la garde rougisse.

test("ios-sessions/AC-1 : le noyau des faits de session vit dans ConsoleCore, et la section route vers IOSSessionsScreen", () => {
  assert.deepEqual(kernelFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(routeFaults(ROOT), [], "l'arbre réel doit être sain");

  // Faute plantée : un type redéclaré dans la coque macOS.
  const copy = copyRepo();
  fs.writeFileSync(
    path.join(copy, "omp-console", "Sources", "OMPConsole", "Viewer", "Duplicata.swift"),
    "import ConsoleCore\n\nstruct SessionList { let choices: [RunChoice] = [] }\n",
  );
  assert.ok(
    kernelFaults(copy).some((f) => f.includes("SessionList")),
    "une redéclaration dans la coque macOS doit faire rougir la garde",
  );

  // Faute plantée : la section ne route plus vers son écran.
  const replant = copyRepo();
  const view = path.join(replant, "omp-console", "ios", "OMPConsoleIOS", "IOSSectionView.swift");
  fs.writeFileSync(view, fs.readFileSync(view, "utf8").replace("section == .sessions", "section == .memory"));
  assert.ok(
    routeFaults(replant).some((f) => f.includes(".sessions")),
    "un mauvais aiguillage de section doit faire rougir la garde",
  );
});

test("ios-sessions/AC-4 : la recette -sessions.recipe existe et est documentée par le README", () => {
  assert.deepEqual(recipeFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const readme = path.join(copy, "omp-console", "README.md");
  fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replaceAll("-sessions.recipe", "-session.recipe"));
  assert.ok(
    recipeFaults(copy).some((f) => f.includes("-sessions.recipe")),
    "une recette non documentée doit faire rougir la garde",
  );
});

test("ios-sessions/AC-5 : lecture seule — aucun appel d'écriture, ni TextField ni UserDefaults dans les fichiers de la feature", () => {
  assert.deepEqual(writeFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const model = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionsModel.swift");
  fs.writeFileSync(model, `${fs.readFileSync(model, "utf8")}\nlet ecrit = client.prompt("bonjour")\n`);
  assert.ok(
    writeFaults(copy).some((f) => f.includes("écriture de session")),
    "un appel d'écriture doit faire rougir la garde",
  );

  const replant = copyRepo();
  const screen = path.join(replant, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionsScreen.swift");
  fs.writeFileSync(screen, `${fs.readFileSync(screen, "utf8")}\nlet saisie = TextField()\n`);
  assert.ok(
    writeFaults(replant).some((f) => f.includes("TextField")),
    "un champ de saisie doit faire rougir la garde",
  );
});

test("ios-sessions/AC-10 : les composants réutilisables ne nomment aucun type de la section Sessions", () => {
  assert.deepEqual(componentFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const view = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionThreadView.swift");
  fs.writeFileSync(view, `${fs.readFileSync(view, "utf8")}\nlet section = IOSSessionsScreen.self\n`);
  assert.ok(
    componentFaults(copy).some((f) => f.includes("IOSSessionsScreen")),
    "un composant qui nomme la section doit faire rougir la garde",
  );
});

test("ios-sessions/AC-11 : SessionParity porte les deux membres de la fixture partagée", () => {
  assert.deepEqual(parityFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const parity = path.join(copy, "omp-console", "Sources", "ConsoleCore", "Session", "SessionParity.swift");
  fs.writeFileSync(parity, fs.readFileSync(parity, "utf8").replace("public static let payloadJSON", "public static let payload"));
  assert.ok(
    parityFaults(copy).some((f) => f.includes("payloadJSON")),
    "un membre de la fixture disparu doit faire rougir la garde",
  );
});
