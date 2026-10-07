// Les GARDES TEXTUELLES de la feature `ios-accueil` : le noyau de l'Accueil vit
// dans ConsoleCore (une seule dérivation pour les deux coques), la coque iOS ne
// nomme aucun jeton d'écriture du magasin, et aucun bandeau de notifications
// n'existe côté iOS.
//
// Mêmes règles structurelles que `test/design-ios.test.ts` et
// `test/coque-ios.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout — une copie
//     contient le même arbre.
//
// `test/criteria.test.ts` (AC-13) exige qu'un id qualifié `<slug>/AC-<n>` ne vive
// que dans UN SEUL test de `test/*.test.ts` : les trois ids de ce fichier sont donc
// uniques ici, et ce fichier est le seul de `test/` à porter le slug `ios-accueil`.
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
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-accueil-copie-"));
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
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => ({ name, code: stripComments(fs.readFileSync(path.join(dir, name), "utf8")) }));
}

/**
 * Les fichiers de l'Accueil iOS que CETTE feature possède : les assertions de
 * périmètre ne portent que sur eux (une garde qui interdit à l'échelle de tout
 * `OMPConsoleIOS/**` ferait rougir un voisin légitime — règle du dépôt).
 */
const HOME_FILES = [
  "HomeView.swift",
  "HomeAnswerSheet.swift",
  "HomeContractSheet.swift",
  "HomeWelcomeSheet.swift",
  "IOSHomeState.swift",
  "IOSHomeContent.swift",
  "IOSHomeText.swift",
  "IOSHomeRecipe.swift",
  "RootView.swift",
];

/** Les types DÉPLACÉS dans ConsoleCore par BR-1 (S-1). */
const MOVED_TYPES = [
  "KanbanColumn",
  "KanbanMark",
  "KanbanSourceKind",
  "KanbanSource",
  "KanbanCardRun",
  "KanbanCardAction",
  "KanbanCard",
  "KanbanAnomaly",
  "KanbanBoard",
  "KanbanBoardState",
  "KanbanStep",
  "KanbanRepoKey",
  "KanbanLane",
  "KanbanLaneContent",
  "KanbanCardPresentation",
  "KanbanAnomalies",
  "KanbanActionZone",
  "KanbanActionPresentation",
  "KanbanLaunchRepos",
  "ActionsText",
  "ActionJournalState",
  "ActionJournalEntry",
  "HomeState",
  "HomeDashboard",
  "HomeAttentionNature",
  "HomeAttention",
  "HomeCardAction",
  "HomePresentation",
  "OmpStatus",
  "MainSheetPolicy",
  "ContractMoment",
  "ContractSection",
  "ContractContent",
  "ContractUnreadable",
  "ContractDocument",
  "ContractText",
  "HomeParity",
];

/** Les fonctions/constantes déplacées (valeurs de parité). */
const MOVED_FUNCS = [
  "elapsedLabel",
  "lotStateLabel",
  "lotWaitLabel",
  "projectStateLabel",
  "liveStateLabel",
  "lotOrder",
  "projectOrder",
  "featureKey",
  "realpathOr",
  "joinPath",
];

/** Les manques du noyau partagé (S-1). Vide quand tout est là. */
function coreFaults(root: string): string[] {
  const faults: string[] = [];
  const core = swiftText(path.join(root, "omp-console", "Sources", "ConsoleCore"));
  const macos = swiftText(path.join(root, "omp-console", "Sources", "OMPConsole"));
  // Un type DÉCLARÉ (jamais une extension) : `struct|enum|class|actor <Nom>`.
  const declared = (text: string, name: string) =>
    new RegExp(`\\b(?:struct|enum|class|actor)\\s+${name}\\b`).test(text);

  for (const name of MOVED_TYPES) {
    if (!declared(core, name)) faults.push(`ConsoleCore ne déclare pas ${name}`);
    else if (!new RegExp(`public\\s+(?:struct|enum|class|actor)\\s+${name}\\b`).test(core)) {
      faults.push(`ConsoleCore ne déclare pas ${name} public`);
    }
    if (declared(macos, name)) faults.push(`la coque macOS déclare encore ${name}`);
  }
  for (const name of MOVED_FUNCS) {
    if (!new RegExp(`\\bfunc\\s+${name}\\b`).test(core)) faults.push(`ConsoleCore ne déclare pas func ${name}`);
    if (new RegExp(`\\bfunc\\s+${name}\\b`).test(macos)) faults.push(`la coque macOS déclare encore func ${name}`);
  }
  // Les deux coques consomment la MÊME dérivation.
  const macHome = path.join(root, "omp-console", "Sources", "OMPConsole", "Home", "HomeView.swift");
  if (!fs.readFileSync(macHome, "utf8").includes("HomePresentation.state(omp:")) {
    faults.push("l'Accueil macOS ne dérive pas par HomePresentation.state");
  }
  const iosHome = path.join(root, "omp-console", "ios", "OMPConsoleIOS", "HomeView.swift");
  if (!fs.existsSync(iosHome) || !fs.readFileSync(iosHome, "utf8").includes("IOSHomeState.resolve(")) {
    faults.push("l'Accueil iOS ne dérive pas par IOSHomeState.resolve");
  }
  const iosContent = path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSHomeContent.swift");
  if (!fs.existsSync(iosContent) || !fs.readFileSync(iosContent, "utf8").includes("HomePresentation.")) {
    faults.push("l'Accueil iOS ne consomme pas HomePresentation");
  }
  return faults;
}

/** Les jetons d'ÉCRITURE du magasin interdits dans les fichiers de l'Accueil iOS. */
const WRITE_TOKENS = [
  "PipelineWriter",
  "PipelineCommand",
  "writeSnapshot",
  "StoreHub",
  "StoreReader",
  "StoreWatcher",
  "StoreSnapshot",
  "PipelineStore",
];

/** Les manques du périmètre d'écriture (S-9/AC-7). */
function writeFaults(root: string): string[] {
  const faults: string[] = [];
  for (const { name, code } of appSources(root)) {
    if (!HOME_FILES.includes(name)) continue;
    for (const token of WRITE_TOKENS) {
      if (code.includes(token)) faults.push(`${name} nomme le jeton d'écriture « ${token} »`);
    }
  }
  return faults;
}

const HAS_LETTER = /[A-Za-zÀ-ÿ]/;

/** Les littéraux de chaîne d'une source Swift (commentaires déjà retirés). */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] !== '"') {
      i += 1;
      continue;
    }
    let j = i + 1;
    let value = "";
    while (j < source.length && source[j] !== '"' && source[j] !== "\n") {
      if (source[j] === "\\") {
        value += source[j + 1] ?? "";
        j += 2;
        continue;
      }
      value += source[j];
      j += 1;
    }
    out.push(value);
    i = j + 1;
  }
  return out;
}

/** Les littéraux alphabétiques hors vocabulaire dans les fichiers de l'Accueil iOS. */
function literalFaults(root: string): string[] {
  const faults: string[] = [];
  for (const { name, code } of appSources(root)) {
    if (!HOME_FILES.includes(name)) continue;
    if (name.endsWith("Text.swift")) continue;
    const withoutSymbols = code.replace(/systemImage:\s*"[^"]*"/g, 'systemImage: ""');
    for (const literal of stringLiterals(withoutSymbols)) {
      if (!HAS_LETTER.test(literal)) continue;
      if (literal.startsWith("ios.") || literal.startsWith("-")) continue;
      faults.push(`${name} : littéral « ${literal} »`);
    }
  }
  return faults;
}

/** Les jetons du bandeau de notifications, interdits partout dans l'app (S-16). */
const NOTIFICATION_TOKENS = [
  "notificationsBanner",
  "notificationsDenied",
  "HomeText.openSettings",
  "HomeText.ignore",
  "UNUserNotificationCenter",
  "requestAuthorization",
];

/** Les manques du contrôle négatif des notifications (S-16/AC-15). */
function notificationFaults(root: string): string[] {
  const faults: string[] = [];
  for (const { name, code } of appSources(root)) {
    for (const token of NOTIFICATION_TOKENS) {
      if (code.includes(token)) faults.push(`${name} nomme « ${token} »`);
    }
  }
  return faults;
}

// ---------------------------------------------------------------------------
// Les tests, un par critère.

test("ios-accueil/AC-1 : le noyau de l'Accueil vit dans ConsoleCore, plus dans la coque macOS", () => {
  assert.deepEqual(coreFaults(ROOT), [], "l'arbre réel doit être sain");

  // Faute plantée : un type redéclaré dans la coque macOS.
  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "Sources", "OMPConsole", "Home", "Duplicata.swift");
  fs.writeFileSync(target, "import ConsoleCore\n\nstruct HomeDashboard { let attention: [HomeAttention] = [] }\n");
  assert.ok(
    coreFaults(copy).some((f) => f.includes("HomeDashboard")),
    "une redéclaration dans la coque doit faire rougir la garde",
  );

  // Faute plantée : la dérivation iOS ne consomme plus le noyau partagé.
  const replant = copyRepo();
  const content = path.join(replant, "omp-console", "ios", "OMPConsoleIOS", "IOSHomeContent.swift");
  fs.writeFileSync(content, fs.readFileSync(content, "utf8").replaceAll("HomePresentation.", "consolePresentation."));
  assert.ok(
    coreFaults(replant).some((f) => f.includes("HomePresentation")),
    "une dérivation iOS déconnectée du noyau doit faire rougir la garde",
  );
});

test("ios-accueil/AC-7 : l'Accueil iOS ne nomme aucun jeton d'écriture du magasin", () => {
  assert.deepEqual(writeFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSHomeState.swift");
  fs.writeFileSync(
    target,
    `${fs.readFileSync(target, "utf8")}\nlet ecrit = PipelineWriter.self\n`,
  );
  assert.ok(
    writeFaults(copy).some((f) => f.includes("PipelineWriter")),
    "un jeton d'écriture dans l'Accueil doit faire rougir la garde",
  );
});

test("ios-accueil/AC-15 : aucun bandeau de notifications sur iOS, et aucun libellé de fait en dur", () => {
  assert.deepEqual(notificationFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(literalFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "HomeView.swift");
  fs.writeFileSync(target, `${fs.readFileSync(target, "utf8")}\nlet bandeau = "notificationsBanner"\n`);
  assert.ok(
    notificationFaults(copy).some((f) => f.includes("notificationsBanner")),
    "un bandeau de notifications doit faire rougir la garde",
  );

  const replant = copyRepo();
  fs.writeFileSync(
    path.join(replant, "omp-console", "ios", "OMPConsoleIOS", "IOSHomeState.swift"),
    `${fs.readFileSync(path.join(replant, "omp-console", "ios", "OMPConsoleIOS", "IOSHomeState.swift"), "utf8")}\nlet mot = "Bonjour"\n`,
  );
  assert.ok(
    literalFaults(replant).some((f) => f.includes("Bonjour")),
    "un libellé de fait en dur doit faire rougir la garde",
  );
});
