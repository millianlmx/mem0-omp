// Les GARDES TEXTUELLES de la feature `design-ios` (BR-5) : chaque critère
// `design-ios/AC-1..AC-10` a son test ici, et c'est le SEUL fichier qui porte ce
// slug (invariant `criteria/AC-13`).
//
// Deux règles structurent ce fichier, comme `test/coque-ios.test.ts` et
// `test/console-core.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout — une copie
//     contient le même arbre.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHELL = path.join(ROOT, "omp-console");
const IOS = path.join(SHELL, "ios");
const APP = path.join(IOS, "OMPConsoleIOS");
const CORE = path.join(SHELL, "Sources", "ConsoleCore");
const SHELL_SOURCES = path.join(SHELL, "Sources", "OMPConsole");

/** Les sept sections de l'app iOS, dans l'ordre de `ConsoleSection.allCases`. */
const SECTIONS = ["home", "kanban", "project", "session", "sessions", "memory", "stats"];

/** Les deux apparences de la matrice de captures. */
const APPEARANCES = ["light", "dark"];

// Ce qui n'a rien à faire dans une copie : l'historique, les dépendances, les
// racines de build et de types jetables, le stockage vectoriel local. Les
// racines de build Swift (`--scratch-path .build-<quoi>`) sont reconnues par
// PRÉFIXE : un scratch inconnu pèse des centaines de Mo.
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
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "design-ios-copie-"));
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

/**
 * Le source débarrassé de ses commentaires `//` et `/* … *\/` : un exemple cité
 * dans un en-tête n'est ni un littéral affiché, ni un import.
 */
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

/** Le source d'un fichier, commentaires retirés. */
function code(file: string): string {
  return stripComments(fs.readFileSync(file, "utf8"));
}

/** Un chemin relatif à la racine, en forme posix (messages stables). */
const rel = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");

/** Toutes les sources Swift d'une racine, chemins absolus, ordre stable. */
function swiftFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Les sources de l'APP iOS (la cible compilée), commentaires retirés. */
function appSources(root: string): { file: string; code: string }[] {
  return swiftFiles(path.join(root, "omp-console", "ios", "OMPConsoleIOS")).map((file) => ({ file, code: code(file) }));
}

/** La source d'un fichier de l'app, ou la chaîne vide. */
function appFile(root: string, name: string): string {
  const file = path.join(root, "omp-console", "ios", "OMPConsoleIOS", name);
  return fs.existsSync(file) ? code(file) : "";
}

/** Le source d'un fichier du noyau, commentaires retirés. */
function coreCode(root: string, relPath: string): string {
  const file = path.join(root, "omp-console", "Sources", "ConsoleCore", relPath);
  return fs.existsSync(file) ? code(file) : "";
}

/**
 * Les littéraux de chaîne d'une source Swift (commentaires déjà retirés) : le
 * contenu entre guillemets, échappements résolus d'un cran.
 */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] !== '"') {
      i += 1;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      out.push(source.slice(i + 3, end === -1 ? source.length : end));
      i = end === -1 ? source.length : end + 3;
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

const HAS_LETTER = /[A-Za-zÀ-ÿ]/;

/**
 * Les littéraux ALPHABÉTIQUES interdits dans les sources de l'app : tout
 * littéral qui porte une lettre doit être un identifiant technique (`"ios."`,
 * `"-"`, un nom de symbole SF passé à `systemImage:`) ou vivre dans un fichier
 * de VOCABULAIRE de l'app (`*Text.swift`) — c'est ce que S-4 réserve aux mots
 * qui ne vivent pas dans `ConsoleCore` (AC-5 : les libellés provisoires
 * relèvent du vocabulaire de l'app iOS, pas d'une vue).
 */
function literalFaults(root: string): string[] {
  const faults: string[] = [];
  for (const { file, code: text } of appSources(root)) {
    if (path.basename(file).endsWith("Text.swift")) continue;
    // Un nom de symbole SF est un identifiant, pas un libellé affiché.
    const withoutSymbols = text.replace(/systemImage:\s*"[^"]*"/g, 'systemImage: ""');
    for (const literal of stringLiterals(withoutSymbols)) {
      if (!HAS_LETTER.test(literal)) continue;
      if (literal.startsWith("ios.") || literal.startsWith("-")) continue;
      faults.push(`${rel(root, file)} : littéral « ${literal} »`);
    }
  }
  return faults;
}

/** Le message provisoire de `IOSText`, recopié ici (S-3). */
const PROVISIONAL: Record<string, string> = {
  recipeError: "Impossible de lire les données de cet écran.",
};

/** Les manques du vocabulaire provisoire (S-3, AC-4). */
function provisionalFaults(root: string): string[] {
  const file = path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSText.swift");
  if (!fs.existsSync(file)) return ["IOSText.swift absent"];
  const text = code(file);
  const faults: string[] = [];
  const declared = new Map<string, string>();
  for (const [, name, value] of text.matchAll(/static let (\w+)\s*=\s*"([^"]*)"/g)) declared.set(name, value);
  for (const [name, value] of Object.entries(PROVISIONAL)) {
    if (declared.get(name) !== value) {
      faults.push(`IOSText.${name} ne vaut pas « ${value} »`);
    }
  }
  if (declared.size !== Object.keys(PROVISIONAL).length) {
    faults.push(`IOSText déclare ${declared.size} messages (${Object.keys(PROVISIONAL).length} attendus)`);
  }
  const literals = stringLiterals(text).filter((literal) => HAS_LETTER.test(literal));
  if (literals.length !== Object.keys(PROVISIONAL).length) {
    faults.push(`IOSText porte ${literals.length} littéraux (${Object.keys(PROVISIONAL).length} attendus) : le vocabulaire provisoire est clos`);
  }
  const readme = path.join(root, "omp-console", "README.md");
  if (!fs.readFileSync(readme, "utf8").includes("-ios.state error")) {
    faults.push("le README ne documente pas le crochet `-ios.state error`");
  }
  return faults;
}

/** Les manques de typographie et de contrôles (S-7, AC-7 ; S-8 d'iOS, AC-8). */
function typographyFaults(root: string): string[] {
  const faults: string[] = [];
  for (const { file, code: text } of appSources(root)) {
    if (/\.system\(\s*size\s*:/.test(text)) faults.push(`${rel(root, file)} : taille de police en points`);
    if (/lineLimit\(\s*\d/.test(text)) faults.push(`${rel(root, file)} : lineLimit numérique`);
    // `Button` est un contrôle SYSTÈME (la feuille de connexion en emploie six) :
    // le contrôle maison, c'est celui qu'on pose soi-même — le geste nu.
    if (/onTapGesture/.test(text)) faults.push(`${rel(root, file)} : contrôle maison (onTapGesture)`);
  }
  const metrics = appFile(root, "Design/IOSMetrics.swift");
  if (!/static let minimumTarget: CGFloat = 44/.test(metrics)) {
    faults.push("IOSMetrics.minimumTarget n'est pas figé à 44");
  }
  return faults;
}

/** Les mots partagés attendus, section par section (tableau de S-2). */
type SectionWord = { message: string; constant: string; core: string; detail: string | null };

const SECTION_WORDS: Record<string, SectionWord> = {
  home: { message: "Lancez votre première feature", constant: "HomeText.firstRunTitle", core: "Home/HomeText.swift", detail: "HomeText.firstRunBody" },
  kanban: { message: "Aucune pipeline pour l’instant.", constant: "KanbanText.noPipeline", core: "Kanban/KanbanText.swift", detail: null },
  project: { message: "Aucun projet piloté.", constant: "ProjectViewText.emptyTitle", core: "Project/ProjectViewText.swift", detail: "ProjectViewText.emptyHelp" },
  session: { message: "Aucune session", constant: "SessionConsoleText.noProjectTitle", core: "Session/SessionConsoleText.swift", detail: "SessionConsoleText.noProjectBody" },
  sessions: { message: "Aucune session", constant: "SessionSelectorText.emptyTitle", core: "Viewer/SessionSelectorText.swift", detail: "SessionSelectorText.noRun" },
  memory: { message: "Aucun projet ouvert", constant: "MemoryText.noProjectTitle", core: "Memory/MemoryText.swift", detail: null },
  stats: { message: "Aucun projet", constant: "StatsPresentation.noProjectTitle", core: "Stats/StatsPresentation.swift", detail: "StatsPresentation.noProject" },
};

/** Les manques des sept écrans : contenu, mots partagés, composants employés. */
function screenFaults(root: string): string[] {
  const faults: string[] = [];
  const content = appFile(root, "IOSSectionContent.swift");
  const view = appFile(root, "IOSSectionView.swift");
  if (content === "") faults.push("IOSSectionContent.swift absent");
  if (view === "") faults.push("IOSSectionView.swift absent");

  for (const section of SECTIONS) {
    const word = SECTION_WORDS[section];
    if (!content.includes(`case .${section}:`)) faults.push(`IOSSectionContent ne couvre pas .${section}`);
    if (!content.includes(word.constant)) faults.push(`IOSSectionContent ne cite pas ${word.constant}`);
    if (word.detail !== null && !content.includes(word.detail)) {
      faults.push(`IOSSectionContent ne cite pas ${word.detail}`);
    }
    const core = coreCode(root, word.core);
    const member = word.constant.split(".")[1];
    if (!core.includes(`static let ${member} = "${word.message}"`)) {
      faults.push(`${word.core} ne déclare pas ${member} = « ${word.message} »`);
    }
  }

  // Aucun composant orphelin : l'écran emploie les trois surfaces et la pastille,
  // les surfaces emploient les métriques, la pastille emploie les tons.
  const surface = appFile(root, "Design/IOSSurface.swift");
  const chip = appFile(root, "Design/IOSStatusChip.swift");
  for (const token of ["iosPanel()", "iosCard()", "iosBanner(tone:", "IOSStatusChip("]) {
    if (!view.includes(token)) faults.push(`IOSSectionView n'emploie pas ${token}`);
  }
  if (!surface.includes("IOSMetrics.margin(")) faults.push("IOSSurface n'emploie pas IOSMetrics");
  if (!chip.includes("status.tone.tint")) faults.push("IOSStatusChip n'emploie pas les tons");

  // L'état d'erreur est porté par les sept (S-3).
  if (!content.includes("state.banner") || !content.includes("state.bannerMessage")) {
    faults.push("IOSSectionContent ne porte pas le bandeau de l'état");
  }
  const state = appFile(root, "IOSScreenState.swift");
  if (!state.includes("tone: .danger")) faults.push("l'état d'erreur n'a pas le ton danger");
  return faults;
}

/** Les noms des captures produites (S-6, AC-6) : 56 écrans + 12 graphe + 12 nouvelle feature + 8 fiche de carte. */
function expectedShotNames(): string[] {
  const names: string[] = [];
  for (const appearance of APPEARANCES) {
    for (const section of SECTIONS) {
      names.push(`iphone-${section}-${appearance}.png`);
      names.push(`ipad-${section}-${appearance}.png`);
      names.push(`iphone-${section}-${appearance}-ax.png`);
      names.push(`ipad-${section}-${appearance}-ax.png`);
    }
  }
  // ios-memoire-graphe : 3 états × {iPhone, iPad} × {clair, sombre}.
  for (const appearance of APPEARANCES) {
    for (const device of ["iphone", "ipad"]) {
      names.push(`${device}-memoire-graphe-${appearance}.png`);
      names.push(`${device}-memoire-graphe-zoom-${appearance}.png`);
      names.push(`${device}-memoire-graphe-fiche-${appearance}.png`);
    }
  }
  // ios-nouvelle-feature-formulaire : 3 recettes × {iPhone, iPad} × {clair, sombre}.
  for (const appearance of APPEARANCES) {
    for (const device of ["iphone", "ipad"]) {
      for (const recipe of ["vide", "choisi", "rempli"]) {
        names.push(`${device}-nouvelle-feature-${recipe}-${appearance}.png`);
      }
    }
  }
  // ios-fiche-carte-pipelines : la fiche d'une carte, en clair — iPhone × 3 tailles de
  // Dynamic Type × {fiche, actions}, l'arrêt à la taille par défaut, et la fiche sur iPad.
  for (const size of ["large", "accessibility-extra-large", "accessibility-extra-extra-extra-large"]) {
    names.push(`iphone-pipelines-fiche-${size}.png`);
    names.push(`iphone-pipelines-fiche-actions-${size}.png`);
  }
  names.push("iphone-pipelines-fiche-arret-large.png");
  names.push("ipad-pipelines-fiche-large.png");
  return names;
}

/** Les manques du script de captures (S-6, AC-6). */
function shotsFaults(root: string): string[] {
  const file = path.join(root, "scripts", "ios-shots.sh");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (text === "") return ["scripts/ios-shots.sh absent"];
  const faults: string[] = [];
  for (const token of [
    "bootstatus",
    "install",
    "launch",
    "screenshot",
    "ios-build.sh",
    "omp-console/build/",
    "sips",
    "pixelWidth",
    "pixelHeight",
    "56",
    "accessibility-extra-extra-extra-large",
    "large",
    "appearance",
    "content_size",
    "Simulator.app",
  ]) {
    if (!text.includes(token)) faults.push(`ios-shots.sh ne contient pas « ${token} »`);
  }
  if (/ipad-landscape/.test(text.replace(/\/\/.*$/gm, ""))) {
    faults.push("ios-shots.sh porte encore une ligne paysage (retirée par arbitrage du 2026-10-06)");
  }
  const listed = text.split("\n").find((line) => line.startsWith("sections=(")) ?? "";
  for (const section of SECTIONS) {
    if (!new RegExp(`\\b${section}\\b`).test(listed)) {
      faults.push(`ios-shots.sh ne liste pas la section ${section}`);
    }
  }
  if (!/if \[ "\$width" -ge "\$height" \]/.test(text)) {
    faults.push("ios-shots.sh ne sonde pas la forme des captures");
  }
  for (const section of SECTIONS) {
    if (text.includes(`"${section}"`) || text.includes(`'${section}'`)) {
      faults.push(`ios-shots.sh : littéral de section « ${section} »`);
    }
  }
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  if (!gitignore.includes("omp-console/build/")) faults.push(".gitignore n'ignore pas omp-console/build/");
  return faults;
}

/** Les manques de la déclaration d'orientations (S-5, AC-6). */
function orientationFaults(root: string): string[] {
  const file = path.join(root, "omp-console", "ios", "OMPConsoleIOS.xcodeproj", "project.pbxproj");
  const text = fs.readFileSync(file, "utf8");
  const faults: string[] = [];
  const declarations = text
    .split("\n")
    .filter((line) => line.includes("INFOPLIST_KEY_UISupportedInterfaceOrientations ="));
  if (declarations.length !== 2) {
    faults.push(`${declarations.length} configurations déclarent les orientations (2 attendues)`);
  }
  for (const line of declarations) {
    for (const orientation of [
      "UIInterfaceOrientationPortrait",
      "UIInterfaceOrientationLandscapeLeft",
      "UIInterfaceOrientationLandscapeRight",
    ]) {
      if (!line.includes(orientation)) faults.push(`une configuration ne déclare pas ${orientation}`);
    }
  }
  if (text.includes("INFOPLIST_KEY_UIRequiresFullScreen")) {
    faults.push("UIRequiresFullScreen est posé (choix produit retiré le 2026-10-06)");
  }
  const app = appSources(root)
    .map((s) => s.code)
    .join("\n");
  if (app.includes("requestGeometryUpdate") || app.includes("UIInterfaceOrientationMask")) {
    faults.push("l'app demande encore la rotation (crochet retiré le 2026-10-06)");
  }
  return faults;
}

/** Convertit un motif de capture (glob `*`) en expression régulière ancrée. */
function shotPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === "*" ? "\u0000" : `\\${m}`));
  return new RegExp(`^${escaped.split("\u0000").join("[^/]*")}$`);
}

/** Les manques de la recette de design (S-8, AC-9). */
function recipeFaults(root: string): string[] {
  const file = path.join(root, "omp-console", "ios", "DESIGN.md");
  if (!fs.existsSync(file)) return ["omp-console/ios/DESIGN.md absent"];
  const text = fs.readFileSync(file, "utf8");
  const faults: string[] = [];

  const names = expectedShotNames();
  const funcs = swiftFiles(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const guardFile = fs.readFileSync(path.join(root, "test", "design-ios.test.ts"), "utf8");

  // Une PUCE est un bloc : sa première ligne commence par « - », ses
  // continuations sont indentées ; sa dernière ligne doit porter un marqueur.
  const blocks: string[][] = [];
  let block: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("- ")) {
      if (block) blocks.push(block);
      block = [line];
      continue;
    }
    if (block !== null && line.startsWith("  ")) {
      block.push(line);
      continue;
    }
    if (block) blocks.push(block);
    block = null;
  }
  if (block) blocks.push(block);

  for (const lines of blocks) {
    const last = lines[lines.length - 1];
    if (!/\[(test|capture|garde): [^\]]+\]`?$/.test(last)) {
      faults.push(`la puce n'a pas de marqueur : « ${lines[0].slice(0, 60)}… »`);
      continue;
    }
    for (const [, kind, value] of lines.join("\n").matchAll(/\[(test|capture|garde): ([^\]]+)\]/g)) {
      if (kind === "test" && !new RegExp(`func ${value}\\s*\\(`).test(funcs)) {
        faults.push(`[test: ${value}] : aucune fonction de ce nom dans les tests iOS`);
      }
      if (kind === "capture" && !names.some((name) => shotPattern(value).test(name) || shotPattern(`${value}.png`).test(name))) {
        faults.push(`[capture: ${value}] : aucune capture de ce motif`);
      }
      if (kind === "garde" && !guardFile.includes(`test("${value} `)) {
        faults.push(`[garde: ${value}] : aucun test de ce nom`);
      }
    }
  }

  const readme = fs.readFileSync(path.join(root, "omp-console", "README.md"), "utf8");
  if (!readme.includes("omp-console/ios/DESIGN.md")) {
    faults.push("le README ne renvoie pas à omp-console/ios/DESIGN.md");
  }
  return faults;
}

/** Les manques de la coque macOS : mots partagés et noyau sans cadre (S-9, AC-10). */
function macOSFaults(root: string): string[] {
  const faults: string[] = [];
  const shellFile = (relPath: string): string => {
    const file = path.join(root, "omp-console", "Sources", "OMPConsole", relPath);
    return fs.existsSync(file) ? code(file) : "";
  };

  const stats = shellFile("Stats/StatsModels.swift");
  if (!stats.includes("static let noProjectTitle = StatsPresentation.noProjectTitle")) {
    faults.push("StatsText.noProjectTitle ne lit pas StatsPresentation");
  }
  if (!stats.includes("static let noProject = StatsPresentation.noProject")) {
    faults.push("StatsText.noProject ne lit pas StatsPresentation");
  }
  // `KanbanModels.swift` vit désormais dans ConsoleCore (feature ios-accueil,
  // BR-1 : l'ardoise est partagée par les deux coques).
  const kanban = coreCode(root, "Kanban/KanbanModels.swift");
  if (!kanban.includes("static let noPipelineText = KanbanText.noPipeline")) {
    faults.push("KanbanBoardState.noPipelineText ne lit pas KanbanText.noPipeline");
  }
  const session = shellFile("Session/SessionConsoleText.swift");
  if (!session.includes("SessionConsoleText.Status.idleNoProject")) {
    faults.push("stateTitle(.idle, hasProject: false) n'emploie pas le mot partagé");
  }
  const selector = shellFile("Viewer/SessionSelectorView.swift");
  if (/enum SessionSelectorText/.test(selector)) {
    faults.push("SessionSelectorText est encore déclaré dans la coque macOS");
  }
  const coreSession = coreCode(root, "Session/SessionConsoleText.swift");
  if (!coreSession.includes('public static let idleNoProject = "Aucun projet"')) {
    faults.push('ConsoleCore ne déclare pas Status.idleNoProject = "Aucun projet"');
  }

  for (const file of swiftFiles(path.join(root, "omp-console", "Sources", "ConsoleCore"))) {
    const text = code(file);
    const found = /^\s*import\s+(SwiftUI|UIKit|AppKit|Cocoa)\b/m.exec(text);
    if (found) faults.push(`${rel(root, file)} importe ${found[1]}`);
  }
  return faults;
}

// ---------------------------------------------------------------------------
// Les tests, un par critère.

test("design-ios/AC-1 : les sept écrans portent le kit (surfaces, pastille, métriques)", () => {
  assert.deepEqual(screenFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSSectionView.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("iosPanel()", "padding(0)"));
  assert.ok(screenFaults(copy).some((f) => f.includes("iosPanel()")), "une surface retirée doit faire rougir la garde");
});

test("design-ios/AC-2 : aucun composant orphelin — les sept sections rendent le bandeau d'erreur", () => {
  assert.deepEqual(screenFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSScreenState.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("tone: .danger", "tone: .info"));
  assert.ok(screenFaults(copy).some((f) => f.includes("danger")), "un bandeau non dangereux doit faire rougir la garde");
});

test("design-ios/AC-3 : chaque état vide porte le mot partagé, mot pour mot", () => {
  assert.deepEqual(screenFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "Sources", "ConsoleCore", "Kanban", "KanbanText.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace('"Aucune pipeline pour l’instant."', '"Aucune pipeline."'));
  assert.ok(screenFaults(copy).some((f) => f.includes("KanbanText")), "un mot réécrit doit faire rougir la garde");
});

test("design-ios/AC-4 : le vocabulaire provisoire est clos et le crochet documenté", () => {
  assert.deepEqual(provisionalFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSText.swift");
  fs.writeFileSync(target, `${fs.readFileSync(target, "utf8")}\nlet extra = "Un mot réinventé."\n`);
  assert.ok(provisionalFaults(copy).some((f) => f.includes("IOSText")), "un message de plus doit faire rougir la garde");
});

test("design-ios/AC-5 : aucun libellé alphabétique en dur hors du vocabulaire", () => {
  assert.deepEqual(literalFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  fs.writeFileSync(path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "Libelle.swift"), 'let bonjour = "Bonjour"\n');
  const faults = literalFaults(copy);
  assert.ok(faults.some((f) => f.includes("Bonjour")), `un libellé en dur doit faire rougir la garde : ${faults.join(" | ")}`);
});

test("design-ios/AC-6 : le script produit les captures et n'en committe aucune", () => {
  assert.deepEqual(shotsFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(orientationFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.equal(expectedShotNames().length, 88, "la matrice attendue fait 88 noms");

  const copy = copyRepo();
  const target = path.join(copy, "scripts", "ios-shots.sh");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replaceAll("sips", "file"));
  assert.ok(shotsFaults(copy).some((f) => f.includes("sips")), "une sonde retirée doit faire rougir la garde");

  const replant = copyRepo();
  const pbxproj = path.join(replant, "omp-console", "ios", "OMPConsoleIOS.xcodeproj", "project.pbxproj");
  fs.writeFileSync(pbxproj, fs.readFileSync(pbxproj, "utf8").replaceAll("UIInterfaceOrientationLandscapeLeft ", ""));
  assert.ok(
    orientationFaults(replant).some((f) => f.includes("LandscapeLeft")),
    "une orientation retirée doit faire rougir la garde",
  );
});

test("design-ios/AC-7 : aucune taille en points ni lineLimit numérique", () => {
  assert.deepEqual(typographyFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  fs.writeFileSync(
    path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "Pointe.swift"),
    'let grosse = Font.system(size: 22)\n',
  );
  assert.ok(typographyFaults(copy).some((f) => f.includes("taille de police en points")), "une taille en points doit faire rougir la garde");
});

test("design-ios/AC-8 : la cible tactile minimale est 44 pt et aucun contrôle n'est maison", () => {
  assert.deepEqual(typographyFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "Design", "IOSMetrics.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("minimumTarget: CGFloat = 44", "minimumTarget: CGFloat = 32"));
  assert.ok(typographyFaults(copy).some((f) => f.includes("minimumTarget")), "une cible sous 44 doit faire rougir la garde");
});

test("design-ios/AC-9 : chaque règle de la recette est vérifiable, et le README y renvoie", () => {
  assert.deepEqual(recipeFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "DESIGN.md");
  const text = fs.readFileSync(target, "utf8").replace("`[test: minimumTargetIsFortyFour]`", "");
  fs.writeFileSync(target, text);
  assert.ok(recipeFaults(copy).some((f) => f.includes("marqueur")), "une puce sans marqueur doit faire rougir la garde");
});

test("design-ios/AC-10 : les mots partagés gardent leur valeur et ConsoleCore reste sans cadre", () => {
  assert.deepEqual(macOSFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "Sources", "OMPConsole", "Stats", "StatsModels.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("StatsPresentation.noProject", '"Les statistiques viendront."'));
  assert.ok(macOSFaults(copy).some((f) => f.includes("StatsText.noProject")), "un mot réécrit dans la coque doit faire rougir la garde");
});
