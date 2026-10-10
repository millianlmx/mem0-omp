// Les GARDES TEXTUELLES de la feature `ios-nouvelle-feature-formulaire` : un test par
// critère `ios-nouvelle-feature-formulaire/AC-<n>`, et c'est le SEUL fichier qui porte
// ce slug (invariant `criteria/AC-13`).
//
// AC-4 est prouvé en Swift (`IOSNewFeatureSheetTests.repoChoicesUseFolderNames`,
// `repoChoicesWidenUntilDistinct`) : un libellé calculé se prouve par exécution, pas
// par lecture du source. Les autres critères sont des constats de RENDU (captures
// simulateur, `idb ui describe-all`) ; ce fichier éprouve le CÂBLAGE qui les produit —
// sans rendre de SwiftUI.
//
// Deux règles, comme les gardes voisines : tout ce qui doit ÉCHOUER se plante dans une
// COPIE JETABLE du dépôt ; les sources se lisent débarrassées de leurs commentaires.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHEET = "omp-console/ios/OMPConsoleIOS/NewFeatureSheetView.swift";
const METRICS = "omp-console/ios/OMPConsoleIOS/Design/IOSMetrics.swift";
const SHOTS = "scripts/ios-shots.sh";

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function code(root: string, rel: string): string {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return "";
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const SKIP: Record<string, true> = { ".git": true, node_modules: true, ".build-ios": true };

/** Une copie jetable du dépôt, sans racines de build ni historique. */
function copyRepo(): string {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "ios-nouvelle-feature-"))), "copie-"),
  );
  dirs.push(dir);
  const walk = (current: string, target: string) => {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP[entry.name] || entry.name === "build" || entry.name.startsWith(".build")) continue;
      const from = path.join(current, entry.name);
      const to = path.join(target, entry.name);
      if (entry.isDirectory()) walk(from, to);
      else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
      else fs.copyFileSync(from, to);
    }
  };
  walk(ROOT, dir);
  return dir;
}

/** Réécrit un fichier de la copie. */
function plant(copy: string, rel: string, edit: (text: string) => string): void {
  const target = path.join(copy, rel);
  const before = fs.readFileSync(target, "utf8");
  const after = edit(before);
  assert.notEqual(after, before, `la faute plantée dans ${rel} doit changer le fichier`);
  fs.writeFileSync(target, after);
}

/** Le corps de `submit()` : de sa déclaration à l'accolade fermante de même retrait. */
function submitBody(view: string): string {
  const start = view.indexOf("private func submit()");
  if (start < 0) return "";
  const end = view.indexOf("\n    }\n", start);
  return end < 0 ? view.slice(start) : view.slice(start, end);
}

// ---------------------------------------------------------------------------

/** AC-1 : le mot « Dépôt » n'est écrit qu'une fois, et le sélecteur le porte pour VoiceOver. */
function repoWordFaults(root: string): string[] {
  const view = code(root, SHEET);
  if (view === "") return ["NewFeatureSheetView.swift absent"];
  const faults: string[] = [];
  if (/Picker\(\s*NewFeatureText\.repo\b/.test(view)) faults.push("le Picker redit « Dépôt » en libellé");
  const uses = view.match(/NewFeatureText\.repo\b/g)?.length ?? 0;
  if (uses !== 2) faults.push(`NewFeatureText.repo employé ${uses} fois (2 attendues : en-tête et libellé d'accessibilité)`);
  if (!view.includes("Section(NewFeatureText.repo)")) faults.push("l'en-tête de section n'est plus « Dépôt »");
  if (!view.includes(".accessibilityLabel(NewFeatureText.repo)")) faults.push("le sélecteur ne porte plus le libellé d'accessibilité « Dépôt »");
  return faults;
}

/** AC-2 : le sélecteur montre le dépôt choisi, par son libellé d'affichage. */
function shownRepoFaults(root: string): string[] {
  const view = code(root, SHEET);
  const faults: string[] = [];
  if (!view.includes("KanbanLaunchRepos.choices(")) faults.push("la feuille ne calcule pas les libellés par KanbanLaunchRepos.choices");
  if (!view.includes(".accessibilityValue(")) faults.push("le sélecteur n'expose pas sa valeur à l'accessibilité");
  if (!/current\?\.label/.test(view)) faults.push("le libellé visible n'est pas celui du choix courant");
  return faults;
}

/** AC-3 : sans dépôt choisi, l'invite s'affiche et « Lancer » reste inactif. */
function promptFaults(root: string): string[] {
  const view = code(root, SHEET);
  const faults: string[] = [];
  if (!view.includes("NewFeatureText.repoPrompt")) faults.push("la feuille n'affiche pas l'invite « Choisir un dépôt »");
  const ready = view.match(/private var ready: Bool \{([\s\S]*?)\n    \}/)?.[1] ?? "";
  if (!ready.includes("repos.contains(repo)")) faults.push("« Lancer » n'exige pas un dépôt effectivement proposé");
  if (!view.includes(".disabled(!ready")) faults.push("« Lancer » n'est pas désactivé quand la feuille n'est pas prête");
  const text = code(root, "omp-console/Sources/ConsoleCore/Kanban/NewFeatureText.swift");
  if (!/repoPrompt\s*=\s*"Choisir un dépôt"/.test(text)) faults.push("NewFeatureText.repoPrompt n'est pas « Choisir un dépôt »");
  if (/@State private var repo = [^"\s]/.test(view)) faults.push("la feuille présélectionne un dépôt");
  return faults;
}

/** AC-5 : le menu ne montre que des noms de dépôt, jamais un chemin. */
function menuNamesFaults(root: string): string[] {
  const view = code(root, SHEET);
  const faults: string[] = [];
  if (view.includes("ConsoleFormat.path(")) faults.push("la feuille affiche encore un chemin (ConsoleFormat.path)");
  if (!view.includes("Text(verbatim: choice.label)")) faults.push("les entrées du menu ne montrent pas le libellé de dépôt");
  return faults;
}

/** AC-6 : la valeur lancée est la racine complète, jamais le libellé d'affichage. */
function launchedRootFaults(root: string): string[] {
  const view = code(root, SHEET);
  const faults: string[] = [];
  if (!view.includes("repo = choice.root")) faults.push("toucher une entrée ne pose pas la racine complète");
  if (view.includes("repo = choice.label")) faults.push("toucher une entrée pose le libellé au lieu de la racine");
  const body = submitBody(view);
  if (body === "") faults.push("submit() introuvable");
  if (body.includes(".label")) faults.push("submit() emploie un libellé d'affichage");
  if (!/client\.launch\(\s*repoRoot:\s*repoRoot/.test(body)) faults.push("le lancement n'envoie pas la racine du dépôt");
  return faults;
}

/** AC-7 : titre et besoin portent chacun un libellé VoiceOver et un identifiant propres. */
function fieldLabelFaults(root: string): string[] {
  const view = code(root, SHEET);
  const faults: string[] = [];
  if (!view.includes(".accessibilityLabel(NewFeatureText.featureTitle)")) faults.push("le champ titre n'a pas de libellé « Titre »");
  if (!view.includes(".accessibilityLabel(NewFeatureText.need)")) faults.push("le champ besoin n'a pas de libellé « Besoin »");
  if (!view.includes("PipelinesAccessibility.titleField")) faults.push("le champ titre perd son identifiant");
  if (!view.includes("PipelinesAccessibility.needField")) faults.push("le champ besoin perd son identifiant");
  const access = code(root, "omp-console/ios/OMPConsoleIOS/PipelinesText.swift");
  const ids = [...access.matchAll(/(?:titleField|needField|repoField)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  if (new Set(ids).size !== 3) faults.push("les identifiants dépôt/titre/besoin ne sont pas trois valeurs distinctes");
  const text = code(root, "omp-console/Sources/ConsoleCore/Kanban/NewFeatureText.swift");
  if (!/featureTitle\s*=\s*"Titre"/.test(text)) faults.push("NewFeatureText.featureTitle n'est pas « Titre »");
  if (!/need\s*=\s*"Besoin"/.test(text)) faults.push("NewFeatureText.need n'est pas « Besoin »");
  return faults;
}

/** La plage de lignes déclarée par `IOSMetrics.needLines`, ou `null`. */
function needRange(root: string): [number, number] | null {
  const m = code(root, METRICS).match(/static let needLines: ClosedRange<Int> = (\d+)\.\.\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** AC-8 : champ besoin vide ⇒ au moins 3 lignes de hauteur. */
function emptyHeightFaults(root: string): string[] {
  const range = needRange(root);
  if (!range) return ["IOSMetrics.needLines n'est pas une plage a...b de ClosedRange<Int>"];
  return range[0] >= 3 ? [] : [`borne basse de needLines = ${range[0]} (3 attendues au moins)`];
}

/** AC-9 : le champ grandit jusqu'à 8 lignes puis défile en lui-même (un seul défilement). */
function growFaults(root: string): string[] {
  const view = code(root, SHEET);
  const faults: string[] = [];
  const range = needRange(root);
  if (!range) faults.push("IOSMetrics.needLines n'est pas une plage a...b de ClosedRange<Int>");
  else if (range[1] !== 8) faults.push(`borne haute de needLines = ${range[1]} (8 attendues)`);
  if (!/TextField\(NewFeatureText\.needPlaceholder,[^)]*axis: \.vertical\)\s*\.lineLimit\(IOSMetrics\.needLines\)/.test(view)) {
    faults.push("le champ besoin n'est pas un TextField vertical borné par IOSMetrics.needLines");
  }
  if (view.includes("ScrollView")) faults.push("la feuille ajoute un ScrollView (second défilement imbriqué)");
  if (/\.frame\([^)]*\bheight:\s*\d/.test(view)) faults.push("une hauteur en points fige le champ (le Dynamic Type ne la suit plus)");
  return faults;
}

/** Les appels du passage de captures de la feuille, par appareil. */
function shotsFaults(root: string): string[] {
  const script = fs.existsSync(path.join(root, SHOTS)) ? fs.readFileSync(path.join(root, SHOTS), "utf8") : "";
  if (script === "") return ["scripts/ios-shots.sh absent"];
  const faults: string[] = [];
  if (!script.includes("nouvelle_feature_recipes=(vide choisi rempli)")) faults.push("les trois recettes vide/choisi/rempli ne sont pas listées");
  if (!script.includes("-pipelines.recipe")) faults.push("le passage ne lance pas le crochet -pipelines.recipe");
  if (!script.includes("nouvelle-feature-$recipe")) faults.push("les captures ne portent pas le nom nouvelle-feature-<recette>");
  if (!script.includes('"112"')) faults.push("le total contrôlé n'est pas 112");
  if (!/shoot_nouvelle_feature iphone /.test(script)) faults.push("le passage n'est pas appelé pour iPhone");
  if (!/shoot_nouvelle_feature ipad /.test(script)) faults.push("le passage n'est pas appelé pour iPad");
  const recipe = code(root, "omp-console/ios/OMPConsoleIOS/IOSPipelinesRecipe.swift");
  for (const state of ["vide", "choisi", "rempli"]) {
    if (!new RegExp(`case[^\\n]*\\b${state}\\b`).test(recipe)) faults.push(`IOSPipelinesRecipe n'a pas le cas ${state}`);
  }
  return faults;
}

// ---------------------------------------------------------------------------
// Les tests, un par critère.

test("ios-nouvelle-feature-formulaire/AC-1 : le mot « Dépôt » n'est écrit qu'une fois, le sélecteur le porte en libellé d'accessibilité", () => {
  assert.deepEqual(repoWordFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  plant(copy, SHEET, (t) => t.replace(".accessibilityLabel(NewFeatureText.repo)", ""));
  assert.ok(repoWordFaults(copy).some((f) => f.includes("« Dépôt »")), "un sélecteur sans libellé doit faire rougir la garde");
  const copy2 = copyRepo();
  plant(copy2, SHEET, (t) => t.replace("Menu {", "Picker(NewFeatureText.repo, selection: $repo) {"));
  assert.ok(repoWordFaults(copy2).some((f) => f.includes("Picker")), "un Picker libellé « Dépôt » doit faire rougir la garde");
});

test("ios-nouvelle-feature-formulaire/AC-2 : le sélecteur affiche en clair le nom du dépôt choisi", () => {
  assert.deepEqual(shownRepoFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  plant(copy, SHEET, (t) => t.replace(".accessibilityValue(shown)", ""));
  assert.ok(shownRepoFaults(copy).some((f) => f.includes("accessibilité")), "un sélecteur sans valeur doit faire rougir la garde");
});

test("ios-nouvelle-feature-formulaire/AC-3 : sans dépôt choisi, l'invite « Choisir un dépôt » s'affiche et « Lancer » est inactif", () => {
  assert.deepEqual(promptFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  plant(copy, SHEET, (t) => t.replace("repos.contains(repo) &&", "!repo.isEmpty &&"));
  assert.ok(promptFaults(copy).some((f) => f.includes("Lancer")), "une activation sur simple non-vide doit faire rougir la garde");
});

test("ios-nouvelle-feature-formulaire/AC-5 : le menu de dépôts ne montre que des noms, aucun chemin absolu", () => {
  assert.deepEqual(menuNamesFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  plant(copy, SHEET, (t) => t.replace("Text(verbatim: choice.label)", "Text(verbatim: ConsoleFormat.path(choice.root))"));
  assert.ok(menuNamesFaults(copy).some((f) => f.includes("chemin")), "un chemin affiché doit faire rougir la garde");
});

test("ios-nouvelle-feature-formulaire/AC-6 : la feature est lancée avec le chemin complet du dépôt choisi", () => {
  assert.deepEqual(launchedRootFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  plant(copy, SHEET, (t) => t.replace("repo = choice.root", "repo = choice.label"));
  assert.ok(launchedRootFaults(copy).some((f) => f.includes("libellé")), "un libellé posé comme dépôt doit faire rougir la garde");
});

test("ios-nouvelle-feature-formulaire/AC-7 : les champs titre et besoin portent les libellés « Titre » et « Besoin » et des identifiants distincts", () => {
  assert.deepEqual(fieldLabelFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  plant(copy, SHEET, (t) => t.replace(".accessibilityLabel(NewFeatureText.need)", ""));
  assert.ok(fieldLabelFaults(copy).some((f) => f.includes("« Besoin »")), "un besoin sans libellé doit faire rougir la garde");
});

test("ios-nouvelle-feature-formulaire/AC-8 : le champ besoin vide réserve au moins 3 lignes", () => {
  assert.deepEqual(emptyHeightFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  plant(copy, METRICS, (t) => t.replace("3...8", "1...8"));
  assert.ok(emptyHeightFaults(copy).some((f) => f.includes("borne basse")), "une borne basse à 1 doit faire rougir la garde");
});

test("ios-nouvelle-feature-formulaire/AC-9 : le champ besoin grandit jusqu'à 8 lignes puis défile en lui-même", () => {
  assert.deepEqual(growFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  plant(copy, SHEET, (t) => t.replace(".lineLimit(IOSMetrics.needLines)", ""));
  assert.ok(growFaults(copy).some((f) => f.includes("borné")), "un champ sans plage de lignes doit faire rougir la garde");
  const copy2 = copyRepo();
  plant(copy2, SHEET, (t) => t.replace("Form {", "ScrollView {"));
  assert.ok(growFaults(copy2).some((f) => f.includes("ScrollView")), "un second défilement doit faire rougir la garde");
});

test("ios-nouvelle-feature-formulaire/AC-10 : la feuille est capturée sur iPhone ET iPad dans ses trois états, sans régression", () => {
  assert.deepEqual(shotsFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  plant(copy, SHOTS, (t) => t.replace("  shoot_nouvelle_feature ipad \"$ipad\" \"$appearance\"\n", ""));
  assert.ok(shotsFaults(copy).some((f) => f.includes("iPad")), "un passage sans iPad doit faire rougir la garde");
});
