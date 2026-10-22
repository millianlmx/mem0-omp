// Les GARDES TEXTUELLES de la feature `design-ios` (BR-5) : chaque critère
// `design-ios/AC-1..AC-10` a son test ici, et c'est le SEUL fichier qui porte ce
// slug (invariant `criteria/AC-13`).
//
// Deux règles structurent ce fichier, comme `test/console/coque-ios.test.ts` et
// `test/console/console-core.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout — une copie
//     contient le même arbre.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, listTestFiles, sharedRepo } from "../support/repo.ts";
import { stripComments, swiftFiles } from "../support/swift-source.ts";

/** La copie du dépôt où l'on plante les fautes, remise à neuf à chaque `fresh()`. */
const shared = sharedRepo("design-ios-copie-");

/** Les six sections de l'app iOS, dans l'ordre de `ConsoleSection.allCases`. */
const SECTIONS = ["home", "kanban", "project", "audit", "stats", "memory"];

/** Les deux apparences de la matrice de captures. */
const APPEARANCES = ["light", "dark"];

/** Le source d'un fichier, commentaires retirés : un exemple cité dans un
 * en-tête n'est ni un littéral affiché, ni un import. */
function code(file: string): string {
  return stripComments(fs.readFileSync(file, "utf8"));
}

/** Un chemin relatif à la racine, en forme posix (messages stables). */
const rel = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");

/** Les sources Swift d'une racine, chemins absolus, ordre stable ; aucune si la racine est absente. */
const swiftFilesIn = (dir: string) => (fs.existsSync(dir) ? swiftFiles(dir) : []);

/** Les sources de l'APP iOS (la cible compilée), commentaires retirés. */
function appSources(root: string): { file: string; code: string }[] {
  return swiftFilesIn(path.join(root, "omp-console", "ios", "OMPConsoleIOS")).map((file) => ({
    file,
    code: code(file),
  }));
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
    faults.push(
      `IOSText porte ${literals.length} littéraux (${Object.keys(PROVISIONAL).length} attendus) : le vocabulaire provisoire est clos`,
    );
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

/** Les mots partagés attendus, section par section (tableau de S-2) : l'écran qui
 * rend la section, son fichier, et le mot d'état vide qu'il lit dans le noyau. */
type SectionWord = { screen: string; file: string; message: string; constant: string; core: string };

const SECTION_WORDS: Record<string, SectionWord> = {
  home: {
    screen: "IOSHarnessHomeScreen",
    file: "IOSHarnessScreens.swift",
    message: "Rien n’attend votre décision.",
    constant: "PipelineServerText.nothingPending",
    core: "Design/PipelineServerText.swift",
  },
  kanban: {
    screen: "IOSHarnessPipelinesScreen",
    file: "IOSHarnessScreens.swift",
    message: "Aucune feature sur ce serveur.",
    constant: "PipelineServerText.noRun",
    core: "Design/PipelineServerText.swift",
  },
  project: {
    screen: "IOSHarnessProjectsScreen",
    file: "IOSHarnessScreens.swift",
    message: "Aucun projet sur ce serveur.",
    constant: "PipelineServerText.noProject",
    core: "Design/PipelineServerText.swift",
  },
  audit: {
    screen: "IOSHarnessAuditsScreen",
    file: "IOSHarnessScreens.swift",
    message: "Aucun audit sur ce serveur.",
    constant: "PipelineServerText.noAudit",
    core: "Design/PipelineServerText.swift",
  },
  stats: {
    screen: "IOSHarnessStatsScreen",
    file: "IOSHarnessScreens.swift",
    message: "Les statistiques arrivent avec le premier échange du serveur.",
    constant: "PipelineServerText.noStats",
    core: "Design/PipelineServerText.swift",
  },
  memory: {
    screen: "IOSMemoryScreen",
    file: "IOSMemoryScreen.swift",
    message: "Aucun projet ouvert",
    constant: "MemoryText.noProjectTitle",
    core: "Memory/MemoryText.swift",
  },
};

/** Le corps d'une déclaration `struct <name>` : jusqu'à la déclaration de premier niveau suivante. */
function structBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^struct ${name}\\b`, "m"));
  if (start === -1) return "";
  const rest = source.slice(start + 1);
  const next = rest.search(/^(struct|private struct|enum|extension|final class|\/\/ MARK)\b/m);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/** Les manques des six écrans : aiguillage, mots partagés, cadre, composants employés. */
function screenFaults(root: string): string[] {
  const faults: string[] = [];
  const view = appFile(root, "IOSSectionView.swift");
  if (view === "") faults.push("IOSSectionView.swift absent");

  for (const section of SECTIONS) {
    const word = SECTION_WORDS[section];
    if (!new RegExp(`case [^:]*\\.${section}\\b[^:]*:\\s*${word.screen}\\(`).test(view)) {
      faults.push(`IOSSectionView n'aiguille pas .${section} vers ${word.screen}`);
    }
    if (!appFile(root, word.file).includes(word.constant)) faults.push(`${word.file} ne cite pas ${word.constant}`);
    const core = coreCode(root, word.core);
    const member = word.constant.split(".")[1];
    if (!core.includes(`static let ${member} = "${word.message}"`)) {
      faults.push(`${word.core} ne déclare pas ${member} = « ${word.message} »`);
    }
  }

  // Les cinq écrans de pilotage passent par le MÊME cadre, qui porte le bandeau
  // d'échec du serveur (S-3) ; la Mémoire porte le bandeau de l'état de recette.
  const harness = appFile(root, "IOSHarnessScreens.swift");
  for (const section of SECTIONS.filter((s) => s !== "memory")) {
    const screen = SECTION_WORDS[section].screen;
    const body = structBody(harness, screen);
    if (body === "") faults.push(`${screen} absent`);
    else if (!body.includes("IOSHarnessScreen(")) faults.push(`${screen} ne passe pas par le cadre IOSHarnessScreen`);
  }
  const frame = structBody(harness, "IOSHarnessScreen");
  if (!frame.includes("server.failure") || !frame.includes(".iosBanner(tone:")) {
    faults.push("le cadre IOSHarnessScreen ne porte pas le bandeau d'échec");
  }
  const memory = appFile(root, "IOSMemoryScreen.swift");
  if (!memory.includes("recipe.banner") || !memory.includes("recipe.bannerMessage")) {
    faults.push("IOSMemoryScreen ne porte pas le bandeau de l'état");
  }
  const state = appFile(root, "IOSScreenState.swift");
  if (!state.includes("tone: .danger")) faults.push("l'état d'erreur n'a pas le ton danger");

  // Aucun composant orphelin : chaque élément du kit est employé par un écran (hors
  // `Design/`), les surfaces emploient les métriques, la pastille emploie les tons.
  const screens = appSources(root)
    .filter(({ file }) => !file.includes(`${path.sep}Design${path.sep}`))
    .map(({ code: text }) => text)
    .join("\n");
  for (const token of ["iosPanel()", "iosCard()", "iosBanner(tone:", "IOSStatusChip("]) {
    if (!screens.includes(token)) faults.push(`aucun écran n'emploie ${token}`);
  }
  const surface = appFile(root, "Design/IOSSurface.swift");
  const chip = appFile(root, "Design/IOSStatusChip.swift");
  if (!surface.includes("IOSMetrics.margin(")) faults.push("IOSSurface n'emploie pas IOSMetrics");
  if (!chip.includes("status.tone.tint")) faults.push("IOSStatusChip n'emploie pas les tons");
  return faults;
}

/** Les noms des captures produites (S-6, AC-6) : 48 écrans + 12 graphe. */
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
  return names;
}

/** Les manques du script de captures (S-6, AC-6). */
function shotsFaults(root: string): string[] {
  const file = path.join(root, "scripts", "recette", "ios-shots.sh");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (text === "") return ["scripts/recette/ios-shots.sh absent"];
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
  const funcs = swiftFilesIn(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const guardFile = listTestFiles(root)
    .map((name) => fs.readFileSync(path.join(root, name), "utf8"))
    .join("\n");

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
      if (
        kind === "capture" &&
        !names.some((name) => shotPattern(value).test(name) || shotPattern(`${value}.png`).test(name))
      ) {
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
  const shell = swiftFilesIn(path.join(root, "omp-console", "Sources", "OMPConsole"))
    .map((file) => code(file))
    .join("\n");
  // La coque macOS lit les MÊMES mots d'état vide que l'iPhone, jamais une copie.
  for (const word of Object.values(SECTION_WORDS)) {
    if (!shell.includes(word.constant)) faults.push(`la coque macOS ne lit pas ${word.constant}`);
  }
  for (const file of swiftFilesIn(path.join(root, "omp-console", "Sources", "ConsoleCore"))) {
    const text = code(file);
    const found = /^\s*import\s+(SwiftUI|UIKit|AppKit|Cocoa)\b/m.exec(text);
    if (found) faults.push(`${rel(root, file)} importe ${found[1]}`);
  }
  return faults;
}

// ---------------------------------------------------------------------------
// Les tests, un par critère.

test("design-ios/AC-1 : les six écrans portent le kit (surfaces, pastille, métriques)", () => {
  assert.deepEqual(screenFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryScreen.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("iosPanel()", "padding(0)"));
  assert.ok(
    screenFaults(copy).some((f) => f.includes("iosPanel()")),
    "une surface retirée doit faire rougir la garde",
  );
});

test("design-ios/AC-2 : aucun composant orphelin — les six sections rendent le bandeau d'erreur", () => {
  assert.deepEqual(screenFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSScreenState.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("tone: .danger", "tone: .info"));
  assert.ok(
    screenFaults(copy).some((f) => f.includes("danger")),
    "un bandeau non dangereux doit faire rougir la garde",
  );
});

test("design-ios/AC-3 : chaque état vide porte le mot partagé, mot pour mot", () => {
  assert.deepEqual(screenFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "Sources", "ConsoleCore", "Design", "PipelineServerText.swift");
  fs.writeFileSync(
    target,
    fs.readFileSync(target, "utf8").replace('"Aucune feature sur ce serveur."', '"Aucune pipeline."'),
  );
  assert.ok(
    screenFaults(copy).some((f) => f.includes("noRun")),
    "un mot réécrit doit faire rougir la garde",
  );
});

test("design-ios/AC-4 : le vocabulaire provisoire est clos et le crochet documenté", () => {
  assert.deepEqual(provisionalFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSText.swift");
  fs.writeFileSync(target, `${fs.readFileSync(target, "utf8")}\nlet extra = "Un mot réinventé."\n`);
  assert.ok(
    provisionalFaults(copy).some((f) => f.includes("IOSText")),
    "un message de plus doit faire rougir la garde",
  );
});

test("design-ios/AC-5 : aucun libellé alphabétique en dur hors du vocabulaire", () => {
  assert.deepEqual(literalFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  fs.writeFileSync(
    path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "Libelle.swift"),
    'let bonjour = "Bonjour"\n',
  );
  const faults = literalFaults(copy);
  assert.ok(
    faults.some((f) => f.includes("Bonjour")),
    `un libellé en dur doit faire rougir la garde : ${faults.join(" | ")}`,
  );
});

test("design-ios/AC-6 : le script produit les captures et n'en committe aucune", () => {
  assert.deepEqual(shotsFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(orientationFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.equal(expectedShotNames().length, 60, "la matrice attendue fait 60 noms");

  const copy = shared.fresh();
  const target = path.join(copy, "scripts", "recette", "ios-shots.sh");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replaceAll("sips", "file"));
  assert.ok(
    shotsFaults(copy).some((f) => f.includes("sips")),
    "une sonde retirée doit faire rougir la garde",
  );

  const replant = shared.fresh();
  const pbxproj = path.join(replant, "omp-console", "ios", "OMPConsoleIOS.xcodeproj", "project.pbxproj");
  fs.writeFileSync(pbxproj, fs.readFileSync(pbxproj, "utf8").replaceAll("UIInterfaceOrientationLandscapeLeft ", ""));
  assert.ok(
    orientationFaults(replant).some((f) => f.includes("LandscapeLeft")),
    "une orientation retirée doit faire rougir la garde",
  );
});

test("design-ios/AC-7 : aucune taille en points ni lineLimit numérique", () => {
  assert.deepEqual(typographyFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  fs.writeFileSync(
    path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "Pointe.swift"),
    "let grosse = Font.system(size: 22)\n",
  );
  assert.ok(
    typographyFaults(copy).some((f) => f.includes("taille de police en points")),
    "une taille en points doit faire rougir la garde",
  );
});

test("design-ios/AC-8 : la cible tactile minimale est 44 pt et aucun contrôle n'est maison", () => {
  assert.deepEqual(typographyFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "Design", "IOSMetrics.swift");
  fs.writeFileSync(
    target,
    fs.readFileSync(target, "utf8").replace("minimumTarget: CGFloat = 44", "minimumTarget: CGFloat = 32"),
  );
  assert.ok(
    typographyFaults(copy).some((f) => f.includes("minimumTarget")),
    "une cible sous 44 doit faire rougir la garde",
  );
});

test("design-ios/AC-9 : chaque règle de la recette est vérifiable, et le README y renvoie", () => {
  assert.deepEqual(recipeFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "DESIGN.md");
  const text = fs.readFileSync(target, "utf8").replace("`[test: minimumTargetIsFortyFour]`", "");
  fs.writeFileSync(target, text);
  assert.ok(
    recipeFaults(copy).some((f) => f.includes("marqueur")),
    "une puce sans marqueur doit faire rougir la garde",
  );
});

test("design-ios/AC-10 : les mots partagés gardent leur valeur et ConsoleCore reste sans cadre", () => {
  assert.deepEqual(macOSFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "Sources", "OMPConsole", "Server", "HarnessSectionViews.swift");
  fs.writeFileSync(
    target,
    fs.readFileSync(target, "utf8").replace("PipelineServerText.noStats", '"Les statistiques viendront."'),
  );
  assert.ok(
    macOSFaults(copy).some((f) => f.includes("noStats")),
    "un mot réécrit dans la coque doit faire rougir la garde",
  );
});
