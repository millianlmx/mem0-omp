// Les GARDES TEXTUELLES de la feature `ios-finitions-titres-icones` (BR-6) : chaque
// critère gardé a sa garde ici, qui interdit le RETOUR du défaut que les lots
// BR-1…BR-5 ont corrigé. Ce sont des gardes de non-retour du CODE, pas des preuves de
// rendu. Exception : AC-6 (« Sommaire » touchable + bulle) a été RENVERSÉ par
// `ios-gestes-et-retours-natifs` (AC-13, vrai bouton désactivé) — sa garde a été retirée.
// AC-2 (panneau d'IOSSectionView), AC-3 (bouton de Projet) et AC-8 (noms de feature
// de l'Accueil) gardaient des écrans du moteur local, retirés avec lui : les écrans
// de pilotage sont désormais ceux du serveur de pipelines, en listes groupées.
//
// Preuves hors de ce fichier :
//  - tests Swift (`OMPConsoleIOSTests/IOSFinitionsTests.swift`) : AC-5 (icônes
//    Sommaire/Liste) ;
//  - captures idb sur simulateur, consignées dans `## Revue` du contrat (BR-7) : AC-1,
//    AC-4, AC-5, AC-7 (cadre et fermeture), AC-9 (iPad).
//
// Deux règles structurent ce fichier, comme `test/console/ios-memoire.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { copyRepo, ROOT } from "../support/repo.ts";
import { readIfExists, stripFullLineComments } from "../support/swift-source.ts";

const APP = ["omp-console", "ios", "OMPConsoleIOS"];

/** Le source d'un fichier de l'app iOS, commentaires retirés (vide s'il est absent). */
function appFile(root: string, name: string): string {
  return stripFullLineComments(readIfExists(path.join(root, ...APP, name)));
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

/** AC-1 : plus de titre interne ; le titre de navigation reste, posé par le cadre. */
function titleFaults(root: string): string[] {
  const faults: string[] = [];
  const frame = appFile(root, "IOSHarnessScreens.swift");
  const memory = appFile(root, "IOSMemoryScreen.swift");
  if (frame === "") return ["IOSHarnessScreens.swift absent"];
  forbidAll(faults, "IOSHarnessScreens.swift", frame, ["Text(section.title)"]);
  requireAll(faults, "IOSHarnessScreens.swift", frame, [".navigationTitle(section.title)"]);
  forbidAll(faults, "IOSMemoryScreen.swift", memory, ["Text(ConsoleSection.memory.title)"]);
  requireAll(faults, "IOSMemoryScreen.swift", memory, [".navigationTitle(ConsoleSection.memory.title)"]);
  return faults;
}

/** AC-4 : l'icône iOS d'une section passe par `IOSSection.systemImage(of:)`. */
function sectionIconFaults(root: string): string[] {
  const faults: string[] = [];
  const text = appFile(root, "RootView.swift");
  if (text === "") return ["RootView.swift absent"];
  requireAll(faults, "RootView.swift", text, ["IOSSection.systemImage(of: section)"]);
  forbidAll(faults, "RootView.swift", text, ["systemImage: section.systemImage"]);
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
  shared ??= copyRepo("ios-finitions-copie-");
  return shared;
}

const app = (name: string): string[] => [...APP, name];

test("ios-finitions-titres-icones/AC-1 : chaque écran n'a que le titre de navigation", () => {
  assert.deepEqual(titleFaults(ROOT), []);
  const faults = plant(
    copy(),
    app("IOSHarnessScreens.swift"),
    (text) => text.replace("List {\n", "List {\n                    Text(section.title)\n"),
    titleFaults,
  );
  assert.ok(faults.some((f) => f.includes("Text(section.title)")), `un titre interne réinséré doit faire rougir la garde : ${faults.join(" | ")}`);
});

test("ios-finitions-titres-icones/AC-4 : l'icône iOS d'une section passe par IOSSection.systemImage(of:)", () => {
  assert.deepEqual(sectionIconFaults(ROOT), []);

  const root = plant(
    copy(),
    app("RootView.swift"),
    (text) => text.replaceAll("IOSSection.systemImage(of: section)", "section.systemImage"),
    sectionIconFaults,
  );
  assert.ok(root.some((f) => f.includes("RootView.swift")), `une icône du noyau dans la barre latérale doit faire rougir la garde : ${root.join(" | ")}`);
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
