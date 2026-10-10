// Les GARDES TEXTUELLES de la feature `ios-finitions-titres-icones` (BR-6) : chaque
// critère `AC-1..AC-8` a sa garde ici, qui interdit le RETOUR du défaut que les lots
// BR-1…BR-5 ont corrigé. Ce sont des gardes de non-retour du CODE, pas des preuves de
// rendu.
//
// Preuves hors de ce fichier :
//  - tests Swift (`OMPConsoleIOSTests/IOSFinitionsTests.swift`, `IOSMemoryModelTests`,
//    `IOSSectionContentTests`) : AC-4 (icônes), AC-5 (icônes Sommaire/Liste), AC-6
//    (raisons d'indisponibilité), AC-8 (coupure de ligne CoreText) ;
//  - captures idb sur simulateur, consignées dans `## Revue` du contrat (BR-7) : AC-1,
//    AC-2, AC-3 (cadre ≥ 44 pt et toucher), AC-4, AC-5, AC-6 (bulle), AC-7 (cadre et
//    fermeture), AC-8 (trois tailles de texte), AC-9 (iPad).
//
// Deux règles structurent ce fichier, comme `test/ios-memoire.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-finitions-copie-"));
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
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const APP = ["omp-console", "ios", "OMPConsoleIOS"];
const CORE_SECTION = ["omp-console", "Sources", "ConsoleCore", "Design", "ConsoleSection.swift"];

/** Le source d'un fichier de l'app iOS, commentaires retirés (vide s'il est absent). */
function appFile(root: string, name: string): string {
  const file = path.join(root, ...APP, name);
  return fs.existsSync(file) ? stripComments(fs.readFileSync(file, "utf8")) : "";
}

/** Le source de `ConsoleSection.swift` (ConsoleCore), commentaires retirés. */
function coreSection(root: string): string {
  const file = path.join(root, ...CORE_SECTION);
  return fs.existsSync(file) ? stripComments(fs.readFileSync(file, "utf8")) : "";
}

/** Le corps `{ … }` de la déclaration qui commence par `header`, accolades appariées. */
function bodyOf(text: string, header: string): string {
  const start = text.indexOf(header);
  if (start < 0) return "";
  const open = text.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return "";
}

/** Ajoute à `faults` chaque jeton de `needles` absent de `text`. */
function requireAll(faults: string[], label: string, text: string, needles: string[]): void {
  for (const needle of needles) {
    if (!text.includes(needle)) faults.push(`${label} : ${needle} absent`);
  }
}

/** Ajoute à `faults` chaque jeton de `needles` présent dans `text`. */
function forbidAll(faults: string[], label: string, text: string, needles: string[]): void {
  for (const needle of needles) {
    if (text.includes(needle)) faults.push(`${label} : ${needle} présent`);
  }
}

/** AC-1 : plus de titre interne ; le titre de navigation reste. */
function titleFaults(root: string): string[] {
  const faults: string[] = [];
  const view = appFile(root, "IOSSectionView.swift");
  if (view === "") return ["IOSSectionView.swift absent"];
  forbidAll(faults, "IOSSectionView.swift", view, ["Text(section.title)"]);
  requireAll(faults, "IOSSectionView.swift", view, [".navigationTitle(section.title)"]);
  return faults;
}

/** AC-2 : le panneau est ancré en haut, le cadre posé APRÈS `iosPanel()`. */
function anchorFaults(root: string): string[] {
  const view = appFile(root, "IOSSectionView.swift");
  if (view === "") return ["IOSSectionView.swift absent"];
  const anchored = /\.iosPanel\(\)\s*\.frame\(maxWidth: \.infinity, maxHeight: \.infinity, alignment: \.top\)/;
  return anchored.test(view)
    ? []
    : ["IOSSectionView.swift : .iosPanel() n'est pas suivi de .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)"];
}

/** AC-3 : l'appel à l'action de Projet est un bouton plein de 44 pt, même action. */
function startButtonFaults(root: string): string[] {
  const screen = appFile(root, "IOSProjectScreen.swift");
  if (screen === "") return ["IOSProjectScreen.swift absent"];
  const actions = bodyOf(screen, "private var actions");
  if (actions === "") return ["IOSProjectScreen.swift : actions introuvable"];
  const faults: string[] = [];
  requireAll(faults, "IOSProjectScreen.actions", actions, [
    "Button(action: startTapped)",
    ".buttonStyle(.borderedProminent)",
    "minHeight: IOSMetrics.minimumTarget",
    "ProjectAccessibility.start",
  ]);
  return faults;
}

/** AC-4 : l'icône iOS passe par `IOSSection.systemImage(of:)` ; le noyau macOS ne bouge pas. */
function sectionIconFaults(root: string): string[] {
  const faults: string[] = [];
  for (const name of ["RootView.swift", "IOSSectionContent.swift"]) {
    const text = appFile(root, name);
    if (text === "") {
      faults.push(`${name} absent`);
      continue;
    }
    requireAll(faults, name, text, ["IOSSection.systemImage(of: section)"]);
    forbidAll(faults, name, text, ["systemImage: section.systemImage"]);
  }
  const core = coreSection(root);
  if (core === "") return [...faults, "ConsoleSection.swift absent"];
  requireAll(faults, "ConsoleSection.swift", core, [
    'case .session: "bubble.left.and.bubble.right"',
    'case .sessions: "bubble.left.and.text.bubble.right"',
  ]);
  return faults;
}

/** AC-5 : « Sommaire » et « Liste » ont deux symboles, nommés dans `IOSMemoryText`. */
function memoryIconFaults(root: string): string[] {
  const screen = appFile(root, "IOSMemoryScreen.swift");
  if (screen === "") return ["IOSMemoryScreen.swift absent"];
  const faults: string[] = [];
  forbidAll(faults, "IOSMemoryScreen.swift", screen, ['systemImage: "list.bullet"']);
  // Chaque Label d'un bouton porte SON symbole : un Sommaire au symbole de Liste n'est pas toléré.
  const labels = (word: string): string[] =>
    [...screen.matchAll(new RegExp(`Label\\(MemoryText\\.${word}, systemImage: ([^)]*)\\)`, "g"))].map((m) => m[1]);
  const summary = labels("summaryButton");
  const list = labels("listButton");
  if (summary.length === 0 || summary.some((symbol) => symbol !== "IOSMemoryText.summarySymbol")) {
    faults.push(`IOSMemoryScreen.swift : Label Sommaire sans IOSMemoryText.summarySymbol (${summary.join(", ")})`);
  }
  if (list.length === 0 || list.some((symbol) => symbol !== "IOSMemoryText.listSymbol")) {
    faults.push(`IOSMemoryScreen.swift : Label Liste sans IOSMemoryText.listSymbol (${list.join(", ")})`);
  }
  return faults;
}

/** AC-6 : « Sommaire » toujours visible, jamais désactivé, raison dans une bulle. */
function summaryFaults(root: string): string[] {
  const screen = appFile(root, "IOSMemoryScreen.swift");
  if (screen === "") return ["IOSMemoryScreen.swift absent"];
  const faults: string[] = [];
  forbidAll(faults, "IOSMemoryScreen.swift", screen, ["if !graph.shown {", ".disabled(!model.canShowSummary)"]);
  requireAll(faults, "IOSMemoryScreen.swift", screen, [
    "summaryUnavailableReason(graphShown: graph.shown)",
    ".popover(",
    ".presentationCompactAdaptation(.popover)",
  ]);
  return faults;
}

/** AC-7 : la fiche porte « Fermer » (44 pt) et la liste présente la même vue. */
function detailCloseFaults(root: string): string[] {
  const detail = appFile(root, "IOSMemoryDetailView.swift");
  const screen = appFile(root, "IOSMemoryScreen.swift");
  if (detail === "") return ["IOSMemoryDetailView.swift absent"];
  const faults: string[] = [];
  requireAll(faults, "IOSMemoryDetailView.swift", detail, [
    "@Environment(\\.dismiss)",
    "ToolbarItem(placement: .confirmationAction)",
    "IOSMemoryAccessibility.close",
    "minHeight: IOSMetrics.minimumTarget",
  ]);
  requireAll(faults, "IOSMemoryScreen.swift", screen, [".sheet(item: $model.selection)", "IOSMemoryDetailView("]);
  return faults;
}

/** AC-8 : les trois noms de feature de l'Accueil passent par `featureName`. */
function featureNameFaults(root: string): string[] {
  const home = appFile(root, "HomeView.swift");
  if (home === "") return ["HomeView.swift absent"];
  const faults: string[] = [];
  const routed = home.split("IOSHomeText.featureName(card.title)").length - 1;
  if (routed !== 3) faults.push(`HomeView.swift : ${routed} appel(s) de IOSHomeText.featureName(card.title), attendu 3`);
  forbidAll(faults, "HomeView.swift", home, ["Text(card.title)"]);
  return faults;
}

/** Une faute plantée dans `rel` de la copie jetable, puis retirée : la garde doit rougir. */
function plant(copy: string, rel: string[], mutate: (text: string) => string, run: (root: string) => string[]): string[] {
  const file = path.join(copy, ...rel);
  const original = fs.readFileSync(file, "utf8");
  const mutated = mutate(original);
  assert.notEqual(mutated, original, `la faute plantée dans ${rel.join("/")} ne change rien`);
  fs.writeFileSync(file, mutated);
  try {
    return run(copy);
  } finally {
    fs.writeFileSync(file, original);
  }
}

let shared: string | undefined;
/** Une seule copie pour tout le fichier : chaque faute est retirée après son essai. */
function copy(): string {
  shared ??= copyRepo();
  return shared;
}

const app = (name: string): string[] => [...APP, name];

test("ios-finitions-titres-icones/AC-1 : Projet et Statistiques n'ont que le titre de navigation", () => {
  assert.deepEqual(titleFaults(ROOT), []);
  const faults = plant(
    copy(),
    app("IOSSectionView.swift"),
    (text) => text.replace(".iosPanel()", ".iosPanel()\n        .overlay { Text(section.title) }"),
    titleFaults,
  );
  assert.ok(faults.some((f) => f.includes("Text(section.title)")), `un titre interne réinséré doit faire rougir la garde : ${faults.join(" | ")}`);
});

test("ios-finitions-titres-icones/AC-2 : le panneau est ancré en haut, cadre posé après iosPanel()", () => {
  assert.deepEqual(anchorFaults(ROOT), []);
  const faults = plant(copy(), app("IOSSectionView.swift"), (text) => text.replace("maxHeight: .infinity, ", ""), anchorFaults);
  assert.ok(faults.length > 0, "un cadre sans maxHeight doit faire rougir la garde");
});

test("ios-finitions-titres-icones/AC-3 : « Piloter un projet… » est un bouton plein de 44 pt, même action", () => {
  assert.deepEqual(startButtonFaults(ROOT), []);
  const faults = plant(
    copy(),
    app("IOSProjectScreen.swift"),
    (text) => text.replace(".buttonStyle(.borderedProminent)", ".buttonStyle(.plain)"),
    startButtonFaults,
  );
  assert.ok(faults.some((f) => f.includes(".borderedProminent")), `un bouton non plein doit faire rougir la garde : ${faults.join(" | ")}`);
});

test("ios-finitions-titres-icones/AC-4 : l'icône de Sessions est celle d'iOS, le noyau macOS ne bouge pas", () => {
  assert.deepEqual(sectionIconFaults(ROOT), []);

  const root = plant(
    copy(),
    app("RootView.swift"),
    (text) => text.replace("IOSSection.systemImage(of: section)", "section.systemImage"),
    sectionIconFaults,
  );
  assert.ok(root.some((f) => f.includes("RootView.swift")), `une icône du noyau dans la barre latérale doit faire rougir la garde : ${root.join(" | ")}`);

  const core = plant(
    copy(),
    CORE_SECTION,
    (text) => text.replace('"bubble.left.and.text.bubble.right"', '"clock.arrow.circlepath"'),
    sectionIconFaults,
  );
  assert.ok(core.some((f) => f.includes("ConsoleSection.swift")), `une icône macOS changée doit faire rougir la garde : ${core.join(" | ")}`);
});

test("ios-finitions-titres-icones/AC-5 : « Sommaire » et « Liste » portent deux symboles distincts", () => {
  assert.deepEqual(memoryIconFaults(ROOT), []);
  const faults = plant(
    copy(),
    app("IOSMemoryScreen.swift"),
    (text) => text.replace("IOSMemoryText.summarySymbol", "IOSMemoryText.listSymbol"),
    memoryIconFaults,
  );
  assert.ok(faults.some((f) => f.includes("summarySymbol")), `Sommaire sans son symbole doit faire rougir la garde : ${faults.join(" | ")}`);
});

test("ios-finitions-titres-icones/AC-6 : « Sommaire » reste visible et touchable, la raison s'affiche en bulle", () => {
  assert.deepEqual(summaryFaults(ROOT), []);
  const faults = plant(
    copy(),
    app("IOSMemoryScreen.swift"),
    (text) => text.replace(".accessibilityIdentifier(IOSMemoryAccessibility.summary)", ".disabled(!model.canShowSummary)\n        .accessibilityIdentifier(IOSMemoryAccessibility.summary)"),
    summaryFaults,
  );
  assert.ok(faults.some((f) => f.includes(".disabled(!model.canShowSummary)")), `un bouton redésactivé doit faire rougir la garde : ${faults.join(" | ")}`);
});

test("ios-finitions-titres-icones/AC-7 : la fiche d'un souvenir a son bouton « Fermer » de 44 pt", () => {
  assert.deepEqual(detailCloseFaults(ROOT), []);
  const faults = plant(
    copy(),
    app("IOSMemoryDetailView.swift"),
    (text) => text.replace(/^.*\.accessibilityIdentifier\(IOSMemoryAccessibility\.close\)\n/m, ""),
    detailCloseFaults,
  );
  assert.ok(faults.some((f) => f.includes("IOSMemoryAccessibility.close")), `un bouton sans identifiant doit faire rougir la garde : ${faults.join(" | ")}`);
});

test("ios-finitions-titres-icones/AC-8 : les trois noms de feature de l'Accueil passent par featureName", () => {
  assert.deepEqual(featureNameFaults(ROOT), []);
  const faults = plant(
    copy(),
    app("HomeView.swift"),
    (text) => text.replace("Text(IOSHomeText.featureName(card.title))", "Text(card.title)"),
    featureNameFaults,
  );
  assert.ok(faults.some((f) => f.includes("Text(card.title)")), `un nom brut doit faire rougir la garde : ${faults.join(" | ")}`);
});
