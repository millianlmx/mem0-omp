// Les GARDES TEXTUELLES de la feature `ios-listes-groupees-natives` : un test par
// critère `ios-listes-groupees-natives/AC-<n>`, et c'est le SEUL fichier qui porte
// ce slug (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source des écrans ; chaque faute est plantée EN
// MÉMOIRE (`source.replace(…)`) : aucune copie du dépôt, aucun SwiftUI rendu. La
// preuve visuelle (groupes arrondis, en-têtes natifs, AX-XL) est la recette de
// captures `scripts/recette/ios-listes-groupees-recette.sh`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { braceBlock, memberBody, stripComments, stripHashComments } from "../support/swift-source.ts";

const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");

/** Le source d'un fichier de l'app, tel qu'écrit (les fautes s'y plantent). */
function appSource(name: string): string {
  return fs.readFileSync(path.join(APP, name), "utf8");
}

/** Le nombre d'occurrences d'un motif littéral. */
const count = (source: string, needle: string) => source.split(needle).length - 1;

/** Les écrans rendus en liste groupée (S-3, S-4, S-5, S-6). */
const LIST_SCREENS = [
  "IOSSessionsScreen.swift",
  "IOSMemoryScreen.swift",
  "IOSStatsScreen.swift",
  "HomeView.swift",
  "IOSProjectScreen.swift",
  "PipelinesScreen.swift",
];

/** Les vues rendues DANS la liste d'un écran : des sections, sans List propre (S-6). */
const LIST_COMPONENTS = ["IOSProjectPlanView.swift", "IOSProjectPRView.swift"];

/**
 * Les seules cartes admises dans un écran en liste : la carte élevée « À vous »
 * de l'Accueil, dans `attentionCard` (S-4), et les cartes élevées du kanban iPad,
 * dans `regularBoard` (S-5).
 */
const CARD_HOSTS: Record<string, string> = {
  "HomeView.swift": "func attentionCard",
  "PipelinesScreen.swift": "func regularBoard",
};

/**
 * Le seul défilement admis hors de la List : le kanban iPad de Pipelines, vertical
 * et horizontal, dans `regularBoard` (S-5).
 */
const SCROLL_HOSTS: Record<string, string> = { "PipelinesScreen.swift": "func regularBoard" };

/** Le bloc de la branche `if graph.shown {` de `var surface` (Mémoire), ou "". */
function graphBranch(code: string): string {
  const surface = code.indexOf("var surface");
  const branch = surface < 0 ? -1 : code.indexOf("if graph.shown {", surface);
  return branch < 0 ? "" : braceBlock(code, code.indexOf("{", branch));
}

/**
 * AC-2 / AC-10 : l'écran est une `List` groupée native — aucun panneau, aucune
 * carte hors des cartes élevées admises, aucun filet tracé à la main, aucun
 * défilement autour. Seul le mode Graphe de la Mémoire garde son panneau, dans la
 * branche `if graph.shown {`, et seul le kanban iPad de Pipelines garde ses
 * défilements, dans `regularBoard`. Une vue de `LIST_COMPONENTS` suit les mêmes
 * règles sans porter de List.
 */
function listScreenFaults(name: string, source: string): string[] {
  const code = stripComments(source);
  const faults: string[] = [];
  if (!LIST_COMPONENTS.includes(name)) {
    if (!code.includes(".iosGroupedList()")) faults.push(`${name} : aucune liste groupée .iosGroupedList()`);
    if (!/\bList\s*[({]/.test(code)) faults.push(`${name} : aucune List`);
  }
  const dividers = count(code, "Divider()");
  if (dividers > 0) faults.push(`${name} : Divider() ×${dividers}, le système trace les séparateurs`);
  const scrolls = count(code, "ScrollView(");
  const scrollHost = SCROLL_HOSTS[name];
  const hostedScrolls = scrollHost ? count(memberBody(code, scrollHost), "ScrollView(") : 0;
  if (scrolls > hostedScrolls) {
    faults.push(`${name} : ScrollView( ×${scrolls - hostedScrolls}${scrollHost ? ` hors de \`${scrollHost}\`` : ""}, la List est le seul défilement`);
  }
  const cards = count(code, ".iosCard(");
  const host = CARD_HOSTS[name];
  if (host) {
    const raised = count(code, ".iosCard(raised: true)");
    if (raised !== cards) faults.push(`${name} : ${cards - raised} .iosCard( sans raised: true, seule la carte élevée est admise`);
    if (count(memberBody(code, host), ".iosCard(raised: true)") !== raised) {
      faults.push(`${name} : .iosCard(raised: true) hors de \`${host}\``);
    }
  } else if (cards > 0) {
    faults.push(`${name} : .iosCard( ×${cards}, une rangée n'est pas une carte`);
  }
  const panels = count(code, ".iosPanel()");
  if (name === "IOSMemoryScreen.swift") {
    if (panels !== 1) faults.push(`${name} : .iosPanel() ×${panels}, attendu 1 (mode Graphe)`);
    if (!graphBranch(code).includes(".iosPanel()")) faults.push(`${name} : .iosPanel() hors de la branche \`if graph.shown {\``);
  } else if (panels > 0) {
    faults.push(`${name} : .iosPanel() ×${panels}, aucun panneau autour d'une liste`);
  }
  return faults;
}

/** Les feuilles réécrites en formulaire groupé natif (S-7). */
const GROUPED_SHEETS = [
  "IOSSessionViewerSheet.swift",
  "IOSMemoryDetailView.swift",
  "PipelinesCardSheet.swift",
  "IOSProjectDialogSheet.swift",
];

/** Les feuilles déjà en `Form`, inchangées : `Form {` seul, sans `.formStyle(.grouped)` (S-7). */
const FORM_SHEETS = ["NewFeatureSheetView.swift", "IOSProjectLaunchSheet.swift"];

/**
 * AC-3 : une feuille ouverte depuis Sessions, Mémoire, Pipelines ou Projet est un
 * `Form` groupé natif — aucun panneau, aucune carte, aucun filet tracé à la main,
 * aucun défilement maison autour des rangées.
 */
function sheetFaults(name: string, source: string): string[] {
  const code = stripComments(source);
  const faults: string[] = [];
  if (!code.includes("Form {")) faults.push(`${name} : aucun Form {`);
  if (!FORM_SHEETS.includes(name) && !code.includes(".formStyle(.grouped)")) {
    faults.push(`${name} : aucun .formStyle(.grouped)`);
  }
  for (const token of [".iosPanel()", ".iosCard(", "Divider()"]) {
    const n = count(code, token);
    if (n > 0) faults.push(`${name} : ${token} ×${n}, la feuille est un formulaire groupé`);
  }
  const scrolls = code.match(/\bScrollView\s*[({]/g)?.length ?? 0;
  if (scrolls > 0) faults.push(`${name} : ScrollView ×${scrolls}, le Form est le seul défilement`);
  return faults;
}

/**
 * AC-5 : un seul titre, celui de la barre de navigation (S-8). Dans l'écran
 * Projet, le nom de la fenêtre ne sert plus que de libellé (non affiché) au
 * sélecteur segmenté.
 */
function titleFaults(name: string, source: string): string[] {
  const code = stripComments(source);
  const faults: string[] = [];
  const titles = count(code, ".navigationTitle(");
  if (titles !== 1) faults.push(`${name} : .navigationTitle( ×${titles}, attendu 1`);
  if (/Text\(\s*ConsoleSection\.\w+\.title\s*\)/.test(code)) faults.push(`${name} : le titre de section est répété dans le contenu`);
  if (name === "IOSProjectScreen.swift") {
    const windowTitle = count(code, "ProjectViewText.windowTitle");
    const inPicker = count(memberBody(code, "private var picker"), "ProjectViewText.windowTitle");
    if (windowTitle !== 1 || inPicker !== 1) {
      faults.push(`${name} : ProjectViewText.windowTitle ×${windowTitle} (×${inPicker} dans le sélecteur), attendu 1, libellé du sélecteur seulement`);
    }
  }
  if (name === "IOSProjectDialogSheet.swift" && /Text\(\s*SessionConsoleText\.dialogTitle\s*\)/.test(code)) {
    faults.push(`${name} : « OMP vous demande » est répété dans le contenu, il n'est que le titre de la barre`);
  }
  return faults;
}

/**
 * AC-4 : les rangées grandissent avec le texte — aucune hauteur fixe ni plafond,
 * aucun libellé plafonné en lignes, sauf l'extrait de souvenir borné par
 * `IOSMetrics.memoryRowLines` (T-3) et le champ de réponse vertical du dialogue,
 * borné par `IOSMetrics.dialogAnswerLines` (ios-finitions-composants, S-5) : il
 * grandit avec le texte puis défile, rien n'y est tronqué.
 */
function dynamicTypeFaults(name: string, source: string): string[] {
  const code = stripComments(source);
  const faults: string[] = [];
  for (const token of [".frame(height:", ".frame(maxHeight:", ".fixedSize(horizontal: false, vertical: false)"]) {
    // La seule hauteur admise : celle, MESURÉE, de l'en-tête de la visionneuse (S-7).
    const measured = token === ".frame(height:" && name === "IOSSessionViewerSheet.swift" ? count(code, ".frame(height: headerHeight)") : 0;
    const n = count(code, token) - measured;
    if (n > 0) faults.push(`${name} : ${token} ×${n}, la rangée doit suivre le texte`);
  }
  const limits = count(code, "lineLimit(");
  const allowed =
    name === "IOSMemoryScreen.swift"
      ? count(code, "lineLimit(IOSMetrics.memoryRowLines(")
      : name === "IOSProjectDialogSheet.swift"
        ? count(code, "lineLimit(IOSMetrics.dialogAnswerLines)")
        : 0;
  if (limits !== allowed) faults.push(`${name} : lineLimit( ×${limits - allowed} hors de l'extrait de souvenir`);
  return faults;
}

/**
 * AC-7 : la carte élevée se détache du fond groupé — `cardFill(raised: true)`
 * rend `secondarySystemGroupedBackground`, la liste groupée peint
 * `systemGroupedBackground`.
 */
function elevationFaults(surface: string): string[] {
  const code = stripComments(surface);
  const faults: string[] = [];
  if (!/raised\s*\?\s*\.secondarySystemGroupedBackground\b/.test(code)) {
    faults.push("IOSSurface.swift : cardFill(raised: true) ne rend pas .secondarySystemGroupedBackground");
  }
  const grouped = memberBody(code, "struct IOSGroupedListSurface");
  if (!grouped.includes(".systemGroupedBackground")) {
    faults.push("IOSSurface.swift : iosGroupedList() ne peint pas .systemGroupedBackground");
  }
  return faults;
}

/**
 * AC-8 : le kanban iPad (`regularBoard` de Pipelines) pose ses cartes élevées
 * sur le fond groupé, sans panneau entre les deux.
 */
function boardElevationFaults(pipelines: string): string[] {
  const code = stripComments(pipelines);
  const faults: string[] = [];
  const board = memberBody(code, "func regularBoard");
  if (!board) return ["PipelinesScreen.swift : `regularBoard` est introuvable"];
  if (!board.includes(".systemGroupedBackground")) faults.push("PipelinesScreen.swift : regularBoard ne pose pas le fond .systemGroupedBackground");
  if (!board.includes(".iosCard(raised: true)")) faults.push("PipelinesScreen.swift : regularBoard ne pose pas de carte élevée .iosCard(raised: true)");
  if (code.includes(".iosPanel()")) faults.push("PipelinesScreen.swift : .iosPanel() entre les cartes et le fond");
  return faults;
}

const DESIGN = path.join(ROOT, "omp-console", "ios", "DESIGN.md");

/** La règle de l'ancienne recette, retirée (S-1 C-5, S-9). */
const NO_LIST_RULE = /aucune\s+`?List/;

/** Le texte de la section `## Surfaces (S-1)` de DESIGN.md, ou "". */
function surfacesSection(design: string): string {
  const start = design.search(/^## Surfaces \(S-1\)/m);
  if (start === -1) return "";
  const next = design.slice(start + 1).search(/^## /m);
  return next === -1 ? design.slice(start) : design.slice(start, start + 1 + next);
}

/**
 * AC-9 : DESIGN.md n'interdit plus `List` et décrit les surfaces groupées et la
 * carte élevée (S-9). La résolution de chaque marqueur `[test:]`/`[capture:]`/
 * `[garde:]` est celle de design-ios/AC-9.
 */
function designFaults(design: string): string[] {
  const faults: string[] = [];
  // La règle d'avant courait sur deux lignes (« aucune » puis « `List` ») : le
  // motif se cherche dans le texte entier.
  const rule = NO_LIST_RULE.exec(design);
  if (rule) faults.push(`DESIGN.md l.${design.slice(0, rule.index).split("\n").length} : la recette interdit encore List`);
  const surfaces = surfacesSection(design);
  if (!surfaces) return [...faults, "DESIGN.md : section « ## Surfaces (S-1) » absente"];
  for (const token of ["List", ".insetGrouped", "iosGroupedList()", "iosCard(raised: true)", "systemGroupedBackground", "secondarySystemGroupedBackground"]) {
    if (!surfaces.includes(token)) faults.push(`DESIGN.md, Surfaces (S-1) : « ${token} » absent`);
  }
  return faults;
}

/**
 * AC-1 : chaque constat « toujours vrai » de l'audit HIG du 2026-10-10 (S-1) est
 * résorbé, et le constat écarté C-3a ne revient pas.
 */
function auditFaults(files: { surface: string; design: string; app: (name: string) => string }): string[] {
  const faults: string[] = [];
  // C-1 : la carte élevée se distingue du fond groupé — ni ce fond lui-même, ni le
  // tertiaire, qui lui est égal en clair (#F2F2F7, D-6).
  const raised = /raised\s*\?\s*\.(\w+)/.exec(stripComments(files.surface))?.[1];
  if (raised === undefined || raised === "systemGroupedBackground" || raised === "tertiarySystemGroupedBackground") {
    faults.push(`C-1 : cardFill(raised: true) rend ${raised ?? "?"}, égal au fond groupé`);
  }
  // C-2, C-3b : ni l'écran Projet ni les Statistiques ne s'étirent sans défiler.
  for (const name of ["IOSProjectScreen.swift", "IOSStatsScreen.swift"]) {
    if (/maxHeight:\s*\.infinity/.test(stripComments(files.app(name)))) faults.push(`C-2/C-3b : ${name} étire son contenu (maxHeight: .infinity)`);
  }
  // C-3a (écarté) : « Statistiques » n'est pas répété dans le contenu.
  if (/Text\(\s*ConsoleSection\.stats\.title\s*\)/.test(stripComments(files.app("IOSStatsScreen.swift")))) {
    faults.push("C-3a : IOSStatsScreen.swift répète « Statistiques » dans le contenu");
  }
  // C-4 : aucun filet tracé à la main dans Sessions, Mémoire et la feuille Souvenir.
  for (const name of ["IOSSessionsScreen.swift", "IOSMemoryScreen.swift", "IOSMemoryDetailView.swift"]) {
    const dividers = count(stripComments(files.app(name)), "Divider()");
    if (dividers > 0) faults.push(`C-4 : ${name} trace ${dividers} Divider()`);
  }
  // C-5 : DESIGN.md n'interdit plus List.
  if (NO_LIST_RULE.test(files.design)) faults.push("C-5 : DESIGN.md interdit encore List");
  return faults;
}

/** Plante une faute : le remplacement DOIT changer le source. */
function plant(source: string, change: (s: string) => string): string {
  const after = change(source);
  assert.notEqual(after, source, "la faute plantée n'a rien changé");
  return after;
}

test("ios-listes-groupees-natives/AC-2 : Sessions, Mémoire (Liste), Statistiques, Accueil, Projet et Pipelines (iPhone) sont des List groupées, sans filet ni panneau", () => {
  for (const name of [...LIST_SCREENS, ...LIST_COMPONENTS]) {
    assert.deepEqual(listScreenFaults(name, appSource(name)), [], name);
  }

  // Faute plantée (c) : un `Divider()` réinséré dans la liste ⇒ rouge, pour CHAQUE écran.
  for (const name of LIST_SCREENS) {
    const planted = plant(appSource(name), (s) => s.replace(/\bList \{/, "List {\n            Divider()"));
    assert.ok(listScreenFaults(name, planted).some((f) => f.includes("Divider()")), `${name} : un Divider() doit rougir`);
  }
  // … et dans chaque section du plan et des PR.
  for (const name of LIST_COMPONENTS) {
    const planted = plant(appSource(name), (s) => s.replace("Section {", "Section {\n            Divider()"));
    assert.ok(listScreenFaults(name, planted).some((f) => f.includes("Divider()")), `${name} : un Divider() doit rougir`);
  }

  // Une rangée du plan ou une PR redevenue carte ⇒ rouge.
  for (const name of LIST_COMPONENTS) {
    const planted = plant(appSource(name), (s) => s.replace(".buttonStyle(.borderless)", ".iosCard()\n        .buttonStyle(.borderless)"));
    assert.ok(listScreenFaults(name, planted).some((f) => f.includes(".iosCard(")), `${name} : une carte doit rougir`);
  }

  // Une carte de Pipelines remise dans la liste compacte ⇒ rouge.
  const pipelines = "PipelinesScreen.swift";
  const compactCard = plant(appSource(pipelines), (s) => s.replace("cardContent(card, showsRepo: showsRepo)\n                        .buttonStyle(.borderless)", "cardContent(card, showsRepo: showsRepo)\n                        .iosCard(raised: true)\n                        .buttonStyle(.borderless)"));
  assert.ok(listScreenFaults(pipelines, compactCard).some((f) => f.includes("hors de `func regularBoard`")), "une carte dans la liste compacte doit rougir");
});

test("ios-listes-groupees-natives/AC-10 : un panneau ou un ScrollView remis autour d'un écran en liste fait rougir la garde", () => {
  for (const name of LIST_SCREENS) {
    // Faute plantée (a) : la liste groupée redevient un panneau ⇒ rouge.
    const panel = plant(appSource(name), (s) => s.replace(".iosGroupedList()", ".iosPanel()"));
    assert.ok(listScreenFaults(name, panel).length > 0, `${name} : .iosGroupedList() → .iosPanel() doit rougir`);

    // Faute plantée (b) : un défilement autour de la List ⇒ rouge.
    const scroll = plant(appSource(name), (s) => s.replace(/\bList \{/, "ScrollView(.vertical) {\n            List {"));
    assert.ok(listScreenFaults(name, scroll).some((f) => f.includes("ScrollView(")), `${name} : un ScrollView doit rougir`);
  }

  // Faute plantée (d) : un panneau dans la branche LISTE de la Mémoire ⇒ rouge.
  const memory = "IOSMemoryScreen.swift";
  const listPanel = plant(appSource(memory), (s) => s.replace(".iosGroupedList()", ".iosGroupedList()\n            .iosPanel()"));
  assert.ok(listScreenFaults(memory, listPanel).some((f) => f.includes(".iosPanel() ×2")), "un panneau autour de la liste Mémoire doit rougir");

  // Un panneau autour du plan du Projet ⇒ rouge.
  const plan = "IOSProjectPlanView.swift";
  const planPanel = plant(appSource(plan), (s) => s.replace(".buttonStyle(.borderless)", ".iosPanel()\n        .buttonStyle(.borderless)"));
  assert.ok(listScreenFaults(plan, planPanel).some((f) => f.includes(".iosPanel()")), "un panneau dans le plan doit rougir");

  // Un défilement remis autour de la liste compacte de Pipelines, hors du kanban iPad ⇒ rouge.
  const pipelines = "PipelinesScreen.swift";
  const compactScroll = plant(appSource(pipelines), (s) => s.replace("list { lanes(rows, showsRepo: showsRepo) }", "ScrollView(.vertical) { list { lanes(rows, showsRepo: showsRepo) } }"));
  assert.ok(listScreenFaults(pipelines, compactScroll).some((f) => f.includes("ScrollView( ×1 hors de")), "un ScrollView hors du kanban iPad doit rougir");

  // Un panneau remis autour d'une feuille réécrite (S-7) ⇒ rouge.
  for (const name of GROUPED_SHEETS) {
    const sheetPanel = plant(appSource(name), (s) => s.replace(".formStyle(.grouped)", ".formStyle(.grouped)\n            .iosPanel()"));
    assert.ok(sheetFaults(name, sheetPanel).some((f) => f.includes(".iosPanel()")), `${name} : un panneau autour du formulaire doit rougir`);
  }
});

test("ios-listes-groupees-natives/AC-5 : un seul titre par écran en liste et par feuille, celui de la barre de navigation", () => {
  for (const name of [...LIST_SCREENS, ...GROUPED_SHEETS]) {
    assert.deepEqual(titleFaults(name, appSource(name)), [], name);
  }

  // Faute plantée : « Statistiques » répété dans le contenu ⇒ rouge.
  const stats = "IOSStatsScreen.swift";
  const repeated = plant(appSource(stats), (s) => s.replace("List {", "List {\n            Text(ConsoleSection.stats.title)"));
  assert.ok(titleFaults(stats, repeated).some((f) => f.includes("répété")), "un second titre doit rougir");

  // Faute plantée : un second `.navigationTitle(` ⇒ rouge.
  const twice = plant(appSource(stats), (s) => s.replace(".iosGroupedList()", ".iosGroupedList()\n        .navigationTitle(ConsoleSection.stats.title)"));
  assert.ok(titleFaults(stats, twice).some((f) => f.includes("×2")), "deux titres de navigation doivent rougir");

  // Faute plantée : l'en-tête du Projet retombe sur « Projet » quand la conduite n'a pas de nom ⇒ rouge.
  const project = "IOSProjectScreen.swift";
  const fallback = plant(appSource(project), (s) => s.replace("model.conduite?.name ?? model.draft?.name\n", "model.conduite?.name ?? model.draft?.name ?? ProjectViewText.windowTitle\n"));
  assert.ok(titleFaults(project, fallback).some((f) => f.includes("windowTitle")), "le repli sur « Projet » doit rougir");

  // Faute plantée : « Accueil » répété en tête du tableau de bord ⇒ rouge.
  const home = "HomeView.swift";
  const homeTitle = plant(appSource(home), (s) => s.replace("List {", "List {\n                Text(ConsoleSection.home.title)"));
  assert.ok(titleFaults(home, homeTitle).some((f) => f.includes("répété")), "un second titre d'Accueil doit rougir");

  // Faute plantée : « OMP vous demande » remis en tête du dialogue ⇒ rouge.
  const dialog = "IOSProjectDialogSheet.swift";
  const dialogTitle = plant(appSource(dialog), (s) => s.replace("Form {", "Form {\n                Text(SessionConsoleText.dialogTitle)"));
  assert.ok(titleFaults(dialog, dialogTitle).some((f) => f.includes("répété")), "le titre du dialogue répété doit rougir");

  // Faute plantée : le titre « Pipelines » répété dans la fiche de carte ⇒ rouge.
  const cardSheet = "PipelinesCardSheet.swift";
  const cardTitle = plant(appSource(cardSheet), (s) => s.replace("Form {", "Form {\n                    Text(ConsoleSection.kanban.title)"));
  assert.ok(titleFaults(cardSheet, cardTitle).some((f) => f.includes("répété")), "le titre de la fiche répété doit rougir");
});

test("ios-listes-groupees-natives/AC-4 : en AX-XL, les rangées des écrans en liste et des feuilles grandissent avec le texte", () => {
  for (const name of [...LIST_SCREENS, ...LIST_COMPONENTS, ...GROUPED_SHEETS]) {
    assert.deepEqual(dynamicTypeFaults(name, appSource(name)), [], name);
  }

  // Faute plantée : une hauteur fixe sur une rangée Sessions ⇒ rouge.
  const sessions = "IOSSessionsScreen.swift";
  const fixed = plant(appSource(sessions), (s) => s.replace(".buttonStyle(.plain)", ".buttonStyle(.plain)\n                    .frame(height: 44)"));
  assert.ok(dynamicTypeFaults(sessions, fixed).some((f) => f.includes(".frame(height:")), "une hauteur fixe doit rougir");

  // Faute plantée : un libellé du plan plafonné à une ligne ⇒ rouge.
  const plan = "IOSProjectPlanView.swift";
  const capped = plant(appSource(plan), (s) => s.replace("Text(row.slug)", "Text(row.slug)\n                    .lineLimit(1)"));
  assert.ok(dynamicTypeFaults(plan, capped).some((f) => f.includes("lineLimit(")), "un libellé tronqué doit rougir");

  // La hauteur mesurée de l'en-tête de visionneuse est admise, une hauteur fixe à côté non ⇒ rouge.
  const viewer = "IOSSessionViewerSheet.swift";
  const viewerFixed = plant(appSource(viewer), (s) => s.replace(".frame(height: headerHeight)", ".frame(height: headerHeight)\n                .frame(height: 120)"));
  assert.ok(dynamicTypeFaults(viewer, viewerFixed).some((f) => f.includes(".frame(height: ×1")), "une hauteur fixe dans la visionneuse doit rougir");

  // Faute plantée : la question du dialogue plafonnée à une ligne ⇒ rouge.
  const dialog = "IOSProjectDialogSheet.swift";
  const dialogCapped = plant(appSource(dialog), (s) => s.replace(".accessibilityIdentifier(ProjectAccessibility.dialogQuestion)", ".lineLimit(1)\n            .accessibilityIdentifier(ProjectAccessibility.dialogQuestion)"));
  assert.ok(dynamicTypeFaults(dialog, dialogCapped).some((f) => f.includes("lineLimit(")), "une question tronquée doit rougir");
});

test("ios-listes-groupees-natives/AC-3 : les feuilles ouvertes depuis Sessions, Mémoire, Pipelines et Projet sont des formulaires groupés natifs, sans panneau imbriqué", () => {
  for (const name of [...GROUPED_SHEETS, ...FORM_SHEETS]) {
    assert.deepEqual(sheetFaults(name, appSource(name)), [], name);
  }

  // Faute plantée : le formulaire redevient un défilement maison dans un panneau ⇒ rouge, pour CHAQUE feuille.
  for (const name of [...GROUPED_SHEETS, ...FORM_SHEETS]) {
    const planted = plant(appSource(name), (s) => s.replace("Form {", "ScrollView { VStack {").replace(".navigationTitle(", ".iosPanel()\n            .navigationTitle("));
    const faults = sheetFaults(name, planted);
    assert.ok(faults.some((f) => f.includes("ScrollView")), `${name} : un ScrollView doit rougir`);
    assert.ok(faults.some((f) => f.includes(".iosPanel()")), `${name} : un panneau doit rougir`);
  }

  // Faute plantée : l'en-tête de la visionneuse redevient une carte ⇒ rouge.
  const viewer = "IOSSessionViewerSheet.swift";
  const card = plant(appSource(viewer), (s) => s.replace(".frame(maxWidth: .infinity, alignment: .leading)\n    }", ".frame(maxWidth: .infinity, alignment: .leading)\n        .iosCard()\n    }"));
  assert.ok(sheetFaults(viewer, card).some((f) => f.includes(".iosCard(")), "une carte dans l'en-tête doit rougir");

  // Faute plantée : un filet tracé à la main dans la feuille Souvenir ⇒ rouge.
  const memory = "IOSMemoryDetailView.swift";
  const divider = plant(appSource(memory), (s) => s.replace("Text(verbatim: Self.text(row))", "Divider()\n                    Text(verbatim: Self.text(row))"));
  assert.ok(sheetFaults(memory, divider).some((f) => f.includes("Divider()")), "un Divider() dans la feuille Souvenir doit rougir");

  // Faute plantée : le style groupé retiré d'une feuille réécrite ⇒ rouge.
  const dialog = "IOSProjectDialogSheet.swift";
  const ungrouped = plant(appSource(dialog), (s) => s.replace(".formStyle(.grouped)\n", ""));
  assert.ok(sheetFaults(dialog, ungrouped).some((f) => f.includes(".formStyle(.grouped)")), "un Form sans style groupé doit rougir");
});

test("ios-listes-groupees-natives/AC-6 : l'écran Projet est une List défilable, une section par étape du plan", () => {
  const project = "IOSProjectScreen.swift";
  const projectFaults = (source: string): string[] => {
    const code = stripComments(source);
    const faults: string[] = [];
    if (!code.includes(".iosGroupedList()") || !/\bList\s*\{/.test(code)) faults.push(`${project} : pas de List groupée`);
    if (code.includes("ScrollView(")) faults.push(`${project} : ScrollView(`);
    if (/maxHeight:\s*\.infinity/.test(code)) faults.push(`${project} : maxHeight: .infinity, le contenu est coupé`);
    return faults;
  };
  assert.deepEqual(projectFaults(appSource(project)), []);

  // Chaque étape est une section de la liste : la dernière se lit au défilement.
  const plan = stripComments(appSource("IOSProjectPlanView.swift"));
  assert.match(plan, /ForEach\(sections[^)]*\)\s*\{\s*section in\s*Section\s*\{\s*DisclosureGroup\(isExpanded:/);

  // Faute plantée : le panneau étiré d'avant, sans défilement ⇒ rouge.
  const stretched = plant(appSource(project), (s) => s.replace(".iosGroupedList()", ".iosGroupedList()\n        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)"));
  assert.ok(projectFaults(stretched).some((f) => f.includes("maxHeight")), "un panneau étiré doit rougir");
});

test("ios-listes-groupees-natives/AC-7 : les cartes « À vous » sont élevées sur le fond groupé, le reste de l'Accueil en liste", () => {
  const surface = fs.readFileSync(path.join(APP, "Design", "IOSSurface.swift"), "utf8");
  assert.deepEqual(elevationFaults(surface), []);

  const home = "HomeView.swift";
  const code = stripComments(appSource(home));
  assert.equal(count(memberBody(code, "func attentionCard"), ".iosCard(raised: true)"), 1, "la carte « À vous » est élevée");
  assert.deepEqual(listScreenFaults(home, appSource(home)), []);

  // Faute plantée : la carte élevée retombe sur le fond tertiaire, égal au fond groupé en clair ⇒ rouge.
  const flat = plant(surface, (s) => s.replace("raised ? .secondarySystemGroupedBackground", "raised ? .tertiarySystemGroupedBackground"));
  assert.ok(elevationFaults(flat).some((f) => f.includes("cardFill")), "un fond tertiaire doit rougir");

  // Faute plantée : la carte « À vous » perd son élévation ⇒ rouge.
  const plain = plant(appSource(home), (s) => s.replace(".iosCard(raised: true)", ".iosCard()"));
  assert.ok(listScreenFaults(home, plain).some((f) => f.includes("sans raised: true")), "une carte non élevée doit rougir");

  // Faute plantée : une rangée de l'Accueil redevient une carte ⇒ rouge.
  const rowCard = plant(appSource(home), (s) => s.replace("row(card).id(card.id)", "row(card).id(card.id).iosCard(raised: true)"));
  assert.ok(listScreenFaults(home, rowCard).some((f) => f.includes("hors de")), "une carte hors « À vous » doit rougir");
});

test("ios-listes-groupees-natives/AC-8 : les cartes du kanban iPad sont élevées sur le fond groupé, en clair comme en sombre", () => {
  const surface = fs.readFileSync(path.join(APP, "Design", "IOSSurface.swift"), "utf8");
  const pipelines = "PipelinesScreen.swift";
  assert.deepEqual(elevationFaults(surface), []);
  assert.deepEqual(boardElevationFaults(appSource(pipelines)), []);
  assert.deepEqual(listScreenFaults(pipelines, appSource(pipelines)), []);

  // Faute plantée : la carte élevée retombe sur le fond tertiaire, égal au fond groupé en clair ⇒ rouge.
  const flat = plant(surface, (s) => s.replace("raised ? .secondarySystemGroupedBackground", "raised ? .tertiarySystemGroupedBackground"));
  assert.ok(elevationFaults(flat).some((f) => f.includes("cardFill")), "un fond tertiaire doit rougir");

  // Faute plantée : le kanban perd le fond groupé ⇒ rouge.
  const noBackground = plant(appSource(pipelines), (s) => s.replace("Color(uiColor: .systemGroupedBackground)", "Color(uiColor: .systemBackground)"));
  assert.ok(boardElevationFaults(noBackground).some((f) => f.includes("fond")), "un kanban sans fond groupé doit rougir");

  // Faute plantée : une carte du kanban perd son élévation ⇒ rouge.
  const plain = plant(appSource(pipelines), (s) => s.replace(".iosCard(raised: true)", ".iosCard()"));
  assert.ok(listScreenFaults(pipelines, plain).some((f) => f.includes("sans raised: true")), "une carte non élevée doit rougir");

  // Faute plantée : le panneau d'avant remis autour du kanban ⇒ rouge.
  const panel = plant(appSource(pipelines), (s) => s.replace(".padding(endMargin)", ".iosPanel()"));
  assert.ok(boardElevationFaults(panel).some((f) => f.includes(".iosPanel()")), "un panneau entre cartes et fond doit rougir");
});

test("ios-listes-groupees-natives/AC-1 : les constats de l'audit HIG restés vrais sont résorbés, le constat écarté ne revient pas", () => {
  const surface = fs.readFileSync(path.join(APP, "Design", "IOSSurface.swift"), "utf8");
  const real = { surface, design: fs.readFileSync(DESIGN, "utf8"), app: appSource };
  assert.deepEqual(auditFaults(real), []);
  const replacing = (file: string, source: string) => ({ ...real, app: (name: string) => (name === file ? source : appSource(name)) });

  // Faute plantée (C-4) : un `Divider()` réinséré dans Sessions ⇒ rouge.
  const sessions = "IOSSessionsScreen.swift";
  const divider = plant(appSource(sessions), (s) => s.replace(/\bList \{/, "List {\n            Divider()"));
  assert.ok(auditFaults(replacing(sessions, divider)).some((f) => f.startsWith(`C-4 : ${sessions}`)), "un Divider() dans Sessions doit rougir");

  // Faute plantée (C-1) : la carte élevée retombe sur le fond tertiaire, égal au fond groupé en clair ⇒ rouge.
  const flat = plant(surface, (s) => s.replace("raised ? .secondarySystemGroupedBackground", "raised ? .tertiarySystemGroupedBackground"));
  assert.ok(auditFaults({ ...real, surface: flat }).some((f) => f.startsWith("C-1")), "une carte élevée égale au fond doit rougir");

  // Faute plantée (C-2) : l'écran Projet redevient un bloc étiré ⇒ rouge.
  const project = "IOSProjectScreen.swift";
  const stretched = plant(appSource(project), (s) => s.replace(".iosGroupedList()", ".iosGroupedList()\n        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)"));
  assert.ok(auditFaults(replacing(project, stretched)).some((f) => f.startsWith("C-2/C-3b")), "un Projet étiré doit rougir");

  // Faute plantée (C-3a) : « Statistiques » répété dans le contenu ⇒ rouge.
  const stats = "IOSStatsScreen.swift";
  const repeated = plant(appSource(stats), (s) => s.replace("List {", "List {\n            Text(ConsoleSection.stats.title)"));
  assert.ok(auditFaults(replacing(stats, repeated)).some((f) => f.startsWith("C-3a")), "un second titre doit rougir");
});

test("ios-listes-groupees-natives/AC-9 : DESIGN.md n'interdit plus List et décrit les listes groupées et la carte élevée", () => {
  const design = fs.readFileSync(DESIGN, "utf8");
  assert.deepEqual(designFaults(design), []);

  // Faute plantée : la règle d'avant réinsérée, sur deux lignes comme elle l'était ⇒ rouge.
  const anchor = "- Un bandeau est une surface de CONTENU";
  const oldRule = plant(design, (s) => s.replace(anchor, "- Un seul défilement VERTICAL par écran : Pipelines, Sessions et Mémoire (Liste)\n  posent leur panneau dans un `ScrollView(.vertical)` et n'emploient aucune\n  `List`. `[capture: iphone-kanban-light]`\n" + anchor));
  assert.ok(designFaults(oldRule).some((f) => f.includes("interdit encore List")), "« n'emploient aucune `List` » doit rougir");

  // Faute plantée : la section Surfaces ne nomme plus le style groupé ⇒ rouge.
  const unstyled = plant(design, (s) => s.replace("de style `.insetGrouped`", "de style natif"));
  assert.ok(designFaults(unstyled).some((f) => f.includes(".insetGrouped")), "une recette sans .insetGrouped doit rougir");

  // Faute plantée : la carte élevée retirée de la section Surfaces ⇒ rouge.
  const unraised = plant(design, (s) => s.replace("`iosCard(raised: true)` : fond", "`iosCard()` : fond"));
  assert.ok(designFaults(unraised).some((f) => f.includes("iosCard(raised: true)")), "une recette sans carte élevée doit rougir");
});

const RECIPE = path.join(ROOT, "scripts", "recette", "ios-listes-groupees-recette.sh");

/** Les jetons qu'une recette de captures privée, signée et avant/après doit porter (S-10). */
const RECIPE_TOKENS = [
  "simctl create",
  "simctl delete",
  "zz-listes-tel",
  "zz-listes-tab",
  "CODE_SIGN_IDENTITY=-",
  "codesign -dv",
  "--avant",
  "content_size",
  "accessibility-extra-large",
  "appearance",
];

/** Les 12 jeux d'arguments de lancement de la matrice (S-10) : 6 sections, 6 feuilles. */
const RECIPE_LAUNCHES = [
  ["home", "-home.recipe", "dashboard"],
  ["sessions", "-sessions.recipe", "longue"],
  ["memory", "-memoire.recipe", "clavier"],
  ["kanban", "-pipelines.board", "pleine"],
  ["project", "-projet.recipe", "plan"],
  ["stats", "-stats.recipe", "pleine"],
  ["sessions", "-sessions.recipe", "visionneuse"],
  ["memory", "-memoire.recipe", "liste"],
  ["kanban", "-pipelines.recipe", "fiche"],
  ["kanban", "-pipelines.recipe", "vide"],
  ["project", "-projet.recipe", "lancement"],
  ["project", "-projet.recipe", "dialogue"],
].map(([section, flag, value]) => `("-section", "${section}", "${flag}", "${value}")`);

/** Ce qui volerait le focus du Mac, toucherait l'app Mac de l'utilisateur ou fusionnerait la PR. */
const RECIPE_FORBIDDEN = ["open -a", "OMP Console", "osascript", "run-console.sh", "gh pr merge"];

/**
 * AC-11 : la recette de captures crée puis supprime ses simulateurs privés,
 * compile une app signée, couvre la matrice avant/après en clair, sombre et
 * AX-XL, exécute les contrôles d'AC-2 à AC-8, et ne touche ni au focus du Mac,
 * ni à l'app Mac, ni à la fusion de la PR.
 */
function recipeScriptFaults(script: string): string[] {
  const faults: string[] = [];
  const code = stripHashComments(script);
  for (const token of [...RECIPE_TOKENS, ...RECIPE_LAUNCHES]) {
    if (!code.includes(token)) faults.push(`recette : jeton absent hors commentaire « ${token} »`);
  }
  for (const n of [2, 4, 5, 6, 7, 8]) {
    if (!new RegExp(`\\bAC-${n}\\b`).test(script)) faults.push(`recette : aucune ligne AC-${n}`);
  }
  for (const token of RECIPE_FORBIDDEN) {
    if (script.includes(token)) faults.push(`recette : « ${token} » interdit`);
  }
  if (code.includes("Simulator.app")) faults.push("recette : Simulator.app hors commentaire");
  return faults;
}

test("ios-listes-groupees-natives/AC-11 : la recette de captures avant/après tourne sur des simulateurs privés supprimés, sans voler le focus ni fusionner", () => {
  const script = fs.readFileSync(RECIPE, "utf8");
  assert.deepEqual(recipeScriptFaults(script), []);

  // Faute plantée : la recette ne supprime plus ses simulateurs ⇒ rouge.
  const kept = plant(script, (s) => s.replaceAll("simctl delete", "simctl shutdown"));
  assert.ok(recipeScriptFaults(kept).some((f) => f.includes("simctl delete")), "des simulateurs conservés doivent rougir");

  // Faute plantée : la construction n'est plus signée ⇒ rouge.
  const unsigned = plant(script, (s) => s.replace("CODE_SIGN_IDENTITY=- ", ""));
  assert.ok(recipeScriptFaults(unsigned).some((f) => f.includes("CODE_SIGN_IDENTITY=-")), "une app non signée doit rougir");

  // Faute plantée : AX-XL retiré de la matrice ⇒ rouge.
  const noAx = plant(script, (s) => s.replaceAll("accessibility-extra-large", "large"));
  assert.ok(recipeScriptFaults(noAx).some((f) => f.includes("accessibility-extra-large")), "une matrice sans AX-XL doit rougir");

  // Faute plantée : une feuille sort de la matrice ⇒ rouge.
  const noSheet = plant(script, (s) => s.replace('("-section", "project", "-projet.recipe", "dialogue")', '("-section", "project")'));
  assert.ok(recipeScriptFaults(noSheet).some((f) => f.includes("dialogue")), "une feuille absente doit rougir");

  // Faute plantée : le Simulateur ouvert au premier plan, l'app Mac relancée, la PR fusionnée ⇒ rouge.
  for (const intrusion of ['open -a Simulator --args -CurrentDeviceUDID "$iphone"', 'xcrun simctl boot "$udid" && open "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"', "bash scripts/run-console.sh", "gh pr merge --squash"]) {
    const intrusive = plant(script, (s) => s.replace("trap cleanup EXIT", `trap cleanup EXIT\n${intrusion}`));
    assert.ok(recipeScriptFaults(intrusive).length > 0, `« ${intrusion} » doit rougir`);
  }

  // Simulator.app cité en commentaire reste admis (le script explique ce qu'il ne fait pas).
  assert.equal(recipeScriptFaults(script.replace("trap cleanup EXIT", "# Simulator.app n'est jamais lancé.\ntrap cleanup EXIT")).length, 0);
});
