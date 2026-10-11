// Les GARDES TEXTUELLES de la feature `ios-bouton-connexion-introuvable` (BR-2) :
// chaque critère `ios-bouton-connexion-introuvable/AC-1..AC-6` a son test ici, et
// c'est le SEUL fichier `test/*.test.ts` qui porte ce slug.
//
// Deux règles structurent ce fichier, comme `test/ios-memoire-graphe.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout.
//
// Ces gardes prouvent la FORME du correctif (où le bouton antenne est posé, qu'il
// est inconditionnel, qu'il n'existe qu'à un endroit). Ce que l'écran RENDE — un
// bouton visible, une feuille qui s'ouvre, un seul bouton sur iPad — se prouve au
// simulateur : `scripts/ios-connexion-recette.sh` (jamais lancée par check.sh, elle
// exige un Mac, Xcode, idb et un simulateur appairé), dont ce fichier vérifie que
// chaque ligne `AC-<n>` est présente. Les preuves Swift :
//  - AC-1..AC-5 : recette simulateur (lignes `AC-1` … `AC-5`) ;
//  - AC-4 : `identifiersAreUniqueAndComplete` (ConnectionTextTests) pour l'identifiant
//    `connection.open` ;
//  - AC-6 : la recette contrôle le diff contre `merge-base`.
// Depuis `ios-navigation-onglets-adaptables`, la racine est une barre d'onglets
// (`TabView`) : le bouton est posé sur l'écran de section (`sectionScreen`) et sur
// la liste « Plus » ; `scripts/ios-connexion-recette.sh` navigue encore par
// l'ancienne liste racine, le rendu de la coque à onglets se prouve par
// `scripts/ios-navigation-onglets-recette.sh` (ligne `AC-7`).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const ROOT_VIEW = path.join("omp-console", "ios", "OMPConsoleIOS", "RootView.swift");
const CONNECTION_TEXT = path.join("omp-console", "ios", "OMPConsoleIOS", "ConnectionText.swift");
const IOS_APP = path.join("omp-console", "ios", "OMPConsoleIOS");
const RECIPE = path.join("scripts", "ios-connexion-recette.sh");

/** Les six fichiers que la feature ne doit pas toucher (S-3). */
const UNTOUCHED = [
  "omp-console/ios/OMPConsoleIOS/Design/IOSSurface.swift",
  "omp-console/ios/OMPConsoleIOS/HomeView.swift",
  "omp-console/Sources/ConsoleCore/Viewer/ConversationText.swift",
  "omp-console/ios/OMPConsoleIOS/IOSSessionViewerSheet.swift",
  "omp-console/ios/OMPConsoleIOS/IOSMarkdownView.swift",
  "omp-console/ios/OMPConsoleIOS/IOSMemoryDetailView.swift",
];

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
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-bouton-connexion-copie-"));
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
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let inBlock = false;
  while (i < text.length) {
    if (inBlock) {
      if (text.startsWith("*/", i)) {
        inBlock = false;
        i += 2;
      } else i += 1;
      continue;
    }
    if (text.startsWith("//", i)) {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline;
      continue;
    }
    if (text.startsWith("/*", i)) {
      inBlock = true;
      i += 2;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** Le source d'un fichier du dépôt `root`, commentaires retirés, ou la chaîne vide. */
function source(root: string, rel: string): string {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? stripComments(fs.readFileSync(file, "utf8")) : "";
}

/** Le segment de `text` entre deux repères (le second cherché après le premier), ou null. */
function between(text: string, from: string, to: string): string | null {
  const start = text.indexOf(from);
  if (start === -1) return null;
  const end = text.indexOf(to, start + from.length);
  if (end === -1) return null;
  return text.slice(start, end);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const ITEM = "connectionToolbarItem";

/** Les segments de `RootView.swift` que les gardes lisent. */
function segments(root: string): {
  all: string;
  screen: string | null;
  plus: string | null;
  chain: string | null;
  item: string | null;
  beforeItem: string;
} {
  const all = source(root, ROOT_VIEW);
  const screen = between(all, "func sectionScreen(", "var plusList");
  const plus = between(all, "var plusList", "func select(");
  const chain = between(all, "TabView(selection:", ".sheet(isPresented: $showWelcome");
  let item: string | null = null;
  let beforeItem = "";
  const at = all.indexOf(`var ${ITEM}`);
  if (at !== -1) {
    const rest = all.slice(at);
    const next = rest.slice(1).search(/\n\s*private (?:var|func)\b|\n\}/);
    item = next === -1 ? rest : rest.slice(0, next + 1);
    beforeItem = all.slice(Math.max(0, at - 80), at);
  }
  return { all, screen, plus, chain, item, beforeItem };
}

// ---------------------------------------------------------------------------
// Fonctions de fautes : chacune rend `string[]`, vide = sain.

/** Les fautes d'un segment qui doit poser le bouton une fois, sans condition de taille. */
function placementFaults(name: string, segment: string): string[] {
  const faults: string[] = [];
  if (!segment.includes(".toolbar")) faults.push(`${name} ne pose aucun .toolbar`);
  const refs = occurrences(segment, ITEM);
  if (refs !== 1) faults.push(`${name} référence ${ITEM} ${refs} fois (attendu : 1)`);
  for (const size of ["sizeClass", "isCompact"]) {
    if (segment.includes(size)) faults.push(`${name} dépend de ${size} : le bouton doit y être inconditionnel`);
  }
  return faults;
}

/** La liste de l'onglet « Plus » porte le bouton, sans condition. */
function plusFaults(root: string): string[] {
  const { plus } = segments(root);
  if (plus === null) return ["RootView.swift : le segment de la liste « Plus » (`var plusList`) est introuvable"];
  return placementFaults("la liste « Plus »", plus);
}

/**
 * L'écran de section porte le bouton, sans condition ; et cette fonction UNIQUE
 * sert à la fois au contenu de chaque onglet de section et à la destination de « Plus ».
 */
function screenFaults(root: string): string[] {
  const { screen, chain } = segments(root);
  if (screen === null) return ["RootView.swift : le segment de l'écran de section (`func sectionScreen(`) est introuvable"];
  const faults = placementFaults("l'écran de section", screen);
  if (chain === null) return [...faults, "RootView.swift : la chaîne du `TabView(selection:` est introuvable"];
  if (!/Tab\([^\n]*value: IOSTab\.section\(section\)\)\s*\{\s*NavigationStack\s*\{\s*sectionScreen\(section\)\s*\}/.test(chain)) {
    faults.push("l'onglet de section ne rend pas `NavigationStack { sectionScreen(section) }`");
  }
  if (!/\.navigationDestination\(for: ConsoleSection\.self\)\s*\{\s*sectionScreen\(\$0\)\s*\}/.test(chain)) {
    faults.push("la destination de « Plus » ne rend pas `sectionScreen($0)`");
  }
  return faults;
}

/** Un seul bouton par écran : rien sur le `TabView`, deux emplacements exactement. */
function uniqueFaults(root: string): string[] {
  const { all, chain } = segments(root);
  const faults: string[] = [];
  if (chain === null) faults.push("RootView.swift : la chaîne du `TabView(selection:` est introuvable");
  else if (chain.includes(".toolbar")) faults.push("un .toolbar est posé sur le TabView lui-même");
  const refs = occurrences(all, ITEM) - occurrences(all, `var ${ITEM}`);
  if (refs !== 2) faults.push(`${ITEM} est référencé ${refs} fois hors déclaration (attendu : 2)`);
  return [...faults, ...plusFaults(root), ...screenFaults(root)];
}

/** Le bouton ne dépend de rien : même action, mêmes éléments, quel que soit l'état. */
function actionFaults(root: string): string[] {
  const { item, beforeItem } = segments(root);
  if (item === null) return [`RootView.swift ne déclare pas ${ITEM}`];
  const faults: string[] = [];
  if (!/@ToolbarContentBuilder\s+private\s*$/.test(beforeItem)) {
    faults.push(`${ITEM} n'est pas précédé de @ToolbarContentBuilder`);
  }
  for (const required of [
    "ToolbarItem(placement: .topBarTrailing)",
    "showConnection = true",
    'Label(ConnectionText.title, systemImage: "antenna.radiowaves.left.and.right")',
    ".accessibilityIdentifier(ConnectionAccessibility.open)",
  ]) {
    if (!item.includes(required)) faults.push(`${ITEM} ne contient pas « ${required} »`);
  }
  const forbidden: Array<[string, RegExp]> = [
    ["if ", /\bif\s/],
    ["guard ", /\bguard\s/],
    ["client.", /\bclient\./],
    ["isConnected", /\bisConnected\b/],
    ["state", /state/],
    ["showConnection = false", /showConnection\s*=\s*false/],
    [".disabled(", /\.disabled\(/],
  ];
  for (const [label, pattern] of forbidden) {
    if (pattern.test(item)) faults.push(`${ITEM} contient « ${label} » : le bouton doit être inconditionnel`);
  }
  return faults;
}

/** Les `.swift` de l'app iOS, récursivement : [chemin relatif à `root`, source sans commentaires]. */
function appSwiftFiles(root: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (current: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) {
        out.push([path.relative(root, full), stripComments(fs.readFileSync(full, "utf8"))]);
      }
    }
  };
  walk(path.join(root, IOS_APP));
  return out;
}

/** Le bouton n'est déclaré que dans RootView.swift ; l'identifiant n'est défini que dans ConnectionText.swift. */
function scopeFaults(root: string): string[] {
  const faults: string[] = [];
  for (const [rel, text] of appSwiftFiles(root)) {
    if (rel === ROOT_VIEW) continue;
    if (text.includes("antenna.radiowaves.left.and.right")) {
      faults.push(`${rel} porte le symbole antenne : le bouton n'est déclaré que dans RootView.swift`);
    }
    if (/ConnectionAccessibility\.open\b/.test(text)) {
      faults.push(`${rel} référence ConnectionAccessibility.open : seul RootView.swift le pose`);
    }
  }
  const rootView = source(root, ROOT_VIEW);
  if (!rootView.includes("antenna.radiowaves.left.and.right")) faults.push("RootView.swift ne porte plus le symbole antenne");
  if (!/ConnectionAccessibility\.open\b/.test(rootView)) faults.push("RootView.swift ne référence pas ConnectionAccessibility.open");
  const text = source(root, CONNECTION_TEXT);
  if (!text.includes('static let open = "connection.open"')) {
    faults.push('ConnectionText.swift ne déclare pas `static let open = "connection.open"`');
  }
  const list = between(text, "static let identifiers", "\n    ]");
  if (list === null || !/\bopen,/.test(list)) faults.push("ConnectionAccessibility.identifiers ne contient pas `open,`");
  return faults;
}

/** La recette simulateur existe, sonde ce qu'il faut et nomme l'AC. */
function recipeFaults(root: string, ac: string): string[] {
  const file = path.join(root, RECIPE);
  if (!fs.existsSync(file)) return [`${RECIPE} absent`];
  const text = fs.readFileSync(file, "utf8");
  const faults: string[] = [];
  const tokens = [
    "describe-point",
    "describe-all",
    "connection.open",
    "connection.sheet",
    "connection.state",
    "connection.close",
    "xcodebuild build",
    "codesign -dv",
    "ios.connexion.connect",
    "-home.welcomeSeen YES",
    "omp-console/build/ios-connexion",
    "merge-base",
    ac,
  ];
  if (ac === "AC-6") tokens.push(...UNTOUCHED);
  for (const token of tokens) {
    if (!text.includes(token)) faults.push(`${RECIPE} ne contient pas « ${token} »`);
  }
  // Le build doit rester SIGNÉ : sans `application-identifier` le trousseau du simulateur
  // refuse l'écriture du jeton (-34018) et l'état connecté est inatteignable.
  const code = text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  if (/CODE_SIGNING_ALLOWED\s*=\s*NO/.test(code)) {
    faults.push(`${RECIPE} compile sans signature (CODE_SIGNING_ALLOWED=NO) : le trousseau du simulateur refuse le jeton`);
  }
  return faults;
}

/** Remplace `from` par `to` dans le fichier `rel` de la copie `root` ; la faute doit exister. */
function plant(root: string, rel: string, from: string, to: string): void {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, "utf8");
  assert.ok(before.includes(from), `la faute ne peut pas être plantée : « ${from} » est absent de ${rel}`);
  fs.writeFileSync(file, before.replace(from, to));
}

// ---------------------------------------------------------------------------

/** Remplace `from` par `to` dans le seul segment [`start`, `end`) de RootView.swift de la copie `root`. */
function plantBetween(root: string, start: string, end: string, from: string, to: string): void {
  const file = path.join(root, ROOT_VIEW);
  const text = fs.readFileSync(file, "utf8");
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.ok(a !== -1 && b > a, `segment « ${start} » … « ${end} » introuvable dans la copie`);
  const segment = text.slice(a, b);
  assert.ok(segment.includes(from), `la faute ne peut pas être plantée : « ${from} » est absent du segment « ${start} »`);
  fs.writeFileSync(file, text.slice(0, a) + segment.replace(from, to) + text.slice(b));
}

test("ios-bouton-connexion-introuvable/AC-1 : la liste « Plus » porte le bouton antenne", () => {
  assert.deepEqual(plusFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(actionFaults(ROOT), []);
  assert.deepEqual(recipeFaults(ROOT, "AC-1"), []);
  const copy = copyRepo();
  plantBetween(copy, "var plusList", "func select(", `.toolbar { ${ITEM} }`, "");
  assert.ok(plusFaults(copy).length > 0, "une liste « Plus » sans bouton doit faire rougir la garde");
  // Un build sans signature rend l'état connecté inatteignable au simulateur (-34018).
  const unsigned = copyRepo();
  plant(unsigned, RECIPE, "-destination \"generic/platform=iOS Simulator\" \\", "-destination \"generic/platform=iOS Simulator\" CODE_SIGNING_ALLOWED=NO \\");
  assert.ok(recipeFaults(unsigned, "AC-1").length > 0, "une recette compilée sans signature doit faire rougir la garde");
});

test("ios-bouton-connexion-introuvable/AC-2 : chaque écran de section porte le bouton antenne", () => {
  assert.deepEqual(screenFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(recipeFaults(ROOT, "AC-2"), []);
  const bare = copyRepo();
  plantBetween(bare, "func sectionScreen(", "var plusList", `.toolbar { ${ITEM} }`, "");
  assert.ok(screenFaults(bare).length > 0, "un écran de section sans bouton doit faire rougir la garde");
  const bypass = copyRepo();
  plant(bypass, ROOT_VIEW, "{ sectionScreen($0) }", "{ IOSSectionView(section: $0) }");
  assert.ok(screenFaults(bypass).length > 0, "une destination de « Plus » qui contourne sectionScreen doit faire rougir la garde");
});

test("ios-bouton-connexion-introuvable/AC-3 : le bouton ne dépend pas de l'état de connexion", () => {
  assert.deepEqual(actionFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(recipeFaults(ROOT, "AC-3"), []);
  const copy = copyRepo();
  const item = segments(copy).item ?? "";
  assert.ok(item.includes("showConnection = true"), "action introuvable dans la copie");
  plant(copy, ROOT_VIEW, "showConnection = true", "if !isConnected { showConnection = true }");
  assert.ok(actionFaults(copy).length > 0, "un bouton conditionné à la connexion doit faire rougir la garde");
});

test("ios-bouton-connexion-introuvable/AC-4 : la feuille se rouvre à chaque tap", () => {
  assert.deepEqual(actionFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(recipeFaults(ROOT, "AC-4"), []);
  const copy = copyRepo();
  plant(copy, ROOT_VIEW, "showConnection = true", "showConnection = !isConnected");
  assert.ok(actionFaults(copy).length > 0, "une réouverture limitée à un état doit faire rougir la garde");
});

test("ios-bouton-connexion-introuvable/AC-5 : un seul bouton antenne par écran", () => {
  assert.deepEqual(uniqueFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(recipeFaults(ROOT, "AC-5"), []);

  const doubled = copyRepo();
  plant(doubled, ROOT_VIEW, ".tabViewStyle(.sidebarAdaptable)", `.tabViewStyle(.sidebarAdaptable)\n        .toolbar { ${ITEM} }`);
  assert.ok(uniqueFaults(doubled).length > 0, "un .toolbar sur le TabView doit faire rougir la garde");

  const sized = copyRepo();
  plantBetween(sized, "func sectionScreen(", "var plusList", `.toolbar { ${ITEM} }`, `.toolbar { if sizeClass == .regular { ${ITEM} } }`);
  assert.ok(uniqueFaults(sized).length > 0, "un bouton conditionné à la classe de taille doit faire rougir la garde");
});

test("ios-bouton-connexion-introuvable/AC-6 : le correctif reste confiné à la racine", () => {
  assert.deepEqual(scopeFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.deepEqual(recipeFaults(ROOT, "AC-6"), []);
  const copy = copyRepo();
  const home = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "HomeView.swift");
  fs.appendFileSync(
    home,
    '\nlet antenne = Label(ConnectionText.title, systemImage: "antenna.radiowaves.left.and.right")\n',
  );
  assert.ok(scopeFaults(copy).length > 0, "le bouton déclaré hors de RootView.swift doit faire rougir la garde");
});
