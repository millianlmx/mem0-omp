// Les GARDES TEXTUELLES de la feature `ios-listes-groupees-natives` : un test par
// critère `ios-listes-groupees-natives/AC-<n>`, et c'est le SEUL fichier qui porte
// ce slug (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source des écrans ; chaque faute est plantée EN
// MÉMOIRE (`source.replace(…)`) : aucune copie du dépôt, aucun SwiftUI rendu. Les
// écrans de pilotage partagent le cadre `IOSHarnessScreen` (IOSHarnessScreens.swift).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { braceBlock, memberBody, stripComments } from "../support/swift-source.ts";

const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");

/** Le source d'un fichier de l'app, tel qu'écrit (les fautes s'y plantent). */
function appSource(name: string): string {
  return fs.readFileSync(path.join(APP, name), "utf8");
}

/** Le nombre d'occurrences d'un motif littéral. */
const count = (source: string, needle: string) => source.split(needle).length - 1;

/** Les écrans rendus en liste groupée (S-3, S-4, S-5, S-6) : le cadre commun des
 *  cinq écrans du serveur, et la Mémoire. */
const LIST_SCREENS = ["IOSHarnessScreens.swift", "IOSMemoryScreen.swift"];

/** Le bloc de la branche `if graph.shown {` de `var surface` (Mémoire), ou "". */
function graphBranch(code: string): string {
  const surface = code.indexOf("var surface");
  const branch = surface < 0 ? -1 : code.indexOf("if graph.shown {", surface);
  return branch < 0 ? "" : braceBlock(code, code.indexOf("{", branch));
}

/**
 * AC-2 / AC-10 : l'écran est une `List` groupée native — aucun panneau, aucune
 * carte, aucun filet tracé à la main, aucun défilement autour. Seul le mode
 * Graphe de la Mémoire garde son panneau et sa carte de légende, dans la branche
 * `if graph.shown {` et la vue du graphe.
 */
function listScreenFaults(name: string, source: string): string[] {
  const code = stripComments(source);
  const faults: string[] = [];
  if (!code.includes(".iosGroupedList()")) faults.push(`${name} : aucune liste groupée .iosGroupedList()`);
  if (!/\bList\s*[({]/.test(code)) faults.push(`${name} : aucune List`);
  if (/\.listStyle\(/.test(code))
    faults.push(`${name} : .listStyle( posé à la main, la surface groupée est .iosGroupedList()`);
  const dividers = count(code, "Divider()");
  if (dividers > 0) faults.push(`${name} : Divider() ×${dividers}, le système trace les séparateurs`);
  const scrolls = count(code, "ScrollView(");
  if (scrolls > 0) faults.push(`${name} : ScrollView( ×${scrolls}, la List est le seul défilement`);
  const cards = count(code, ".iosCard(");
  if (cards > 0) faults.push(`${name} : .iosCard( ×${cards}, une rangée n'est pas une carte`);
  const panels = count(code, ".iosPanel()");
  if (name === "IOSMemoryScreen.swift") {
    if (panels !== 1) faults.push(`${name} : .iosPanel() ×${panels}, attendu 1 (mode Graphe)`);
    if (!graphBranch(code).includes(".iosPanel()"))
      faults.push(`${name} : .iosPanel() hors de la branche \`if graph.shown {\``);
  } else if (panels > 0) {
    faults.push(`${name} : .iosPanel() ×${panels}, aucun panneau autour d'une liste`);
  }
  return faults;
}

/** Les feuilles en formulaire groupé natif (S-7) : la fiche d'un souvenir, la
 *  feuille du serveur, les feuilles de refus et de renversement du serveur, et
 *  celle du refus d'un envoi du Poste (dont l'écran, rendu dans le cadre commun
 *  des écrans du serveur, ne porte lui non plus ni panneau, ni carte, ni filet). */
const GROUPED_SHEETS = [
  "IOSMemoryDetailView.swift",
  "IOSServerSheet.swift",
  "IOSHarnessScreens.swift",
  "IOSWorkstationScreen.swift",
];

/**
 * AC-3 : une feuille de la Mémoire ou du serveur est un `Form` groupé natif —
 * aucun panneau, aucune carte, aucun filet tracé à la main, aucun défilement
 * maison autour des rangées. Chaque `Form {` porte `.formStyle(.grouped)`.
 */
function sheetFaults(name: string, source: string): string[] {
  const code = stripComments(source);
  const faults: string[] = [];
  const forms = count(code, "Form {");
  if (forms === 0) faults.push(`${name} : aucun Form {`);
  if (count(code, ".formStyle(.grouped)") !== forms)
    faults.push(`${name} : ${forms} Form { pour ${count(code, ".formStyle(.grouped)")} .formStyle(.grouped)`);
  for (const token of [".iosPanel()", ".iosCard(", "Divider()"]) {
    const n = count(code, token);
    if (n > 0) faults.push(`${name} : ${token} ×${n}, la feuille est un formulaire groupé`);
  }
  const scrolls = code.match(/\bScrollView\s*[({]/g)?.length ?? 0;
  if (scrolls > 0) faults.push(`${name} : ScrollView ×${scrolls}, le Form est le seul défilement`);
  return faults;
}

/** Les titres de barre attendus par fichier : un par écran et par feuille. */
const TITLES: Record<string, number> = {
  "IOSHarnessScreens.swift": 3,
  "IOSMemoryScreen.swift": 1,
  "IOSMemoryDetailView.swift": 1,
  "IOSServerSheet.swift": 1,
  "IOSWorkstationScreen.swift": 1,
};

/**
 * AC-5 : un seul titre, celui de la barre de navigation (S-8) — un pour le cadre
 * des écrans du serveur, un par feuille ; le titre de section n'est jamais répété
 * dans le contenu.
 */
function titleFaults(name: string, source: string): string[] {
  const code = stripComments(source);
  const faults: string[] = [];
  const titles = count(code, ".navigationTitle(");
  if (titles !== TITLES[name]) faults.push(`${name} : .navigationTitle( ×${titles}, attendu ${TITLES[name]}`);
  if (/Text\(\s*(ConsoleSection\.\w+|section)\.title\s*\)/.test(code))
    faults.push(`${name} : le titre de section est répété dans le contenu`);
  if (
    name === "IOSHarnessScreens.swift" &&
    count(memberBody(code, "struct IOSHarnessScreen<"), ".navigationTitle(section.title)") !== 1
  ) {
    faults.push(`${name} : le cadre IOSHarnessScreen ne porte pas .navigationTitle(section.title)`);
  }
  return faults;
}

/**
 * AC-4 : les rangées grandissent avec le texte — aucune hauteur fixe ni plafond,
 * aucun libellé plafonné en lignes, sauf l'extrait de souvenir borné par
 * `IOSMetrics.memoryRowLines` (T-3).
 */
function dynamicTypeFaults(name: string, source: string): string[] {
  const code = stripComments(source);
  const faults: string[] = [];
  for (const token of [".frame(height:", ".frame(maxHeight:", ".fixedSize(horizontal: false, vertical: false)"]) {
    const n = count(code, token);
    if (n > 0) faults.push(`${name} : ${token} ×${n}, la rangée doit suivre le texte`);
  }
  const limits = count(code, "lineLimit(");
  const allowed = name === "IOSMemoryScreen.swift" ? count(code, "lineLimit(IOSMetrics.memoryRowLines(") : 0;
  if (limits !== allowed) faults.push(`${name} : lineLimit( ×${limits - allowed} hors de l'extrait de souvenir`);
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
 * AC-9 : DESIGN.md n'interdit plus `List` et décrit les surfaces groupées (S-9). La résolution de chaque marqueur `[test:]`/`[capture:]`/
 * `[garde:]` est celle de design-ios/AC-9.
 */
function designFaults(design: string): string[] {
  const faults: string[] = [];
  // La règle d'avant courait sur deux lignes (« aucune » puis « `List` ») : le
  // motif se cherche dans le texte entier.
  const rule = NO_LIST_RULE.exec(design);
  if (rule)
    faults.push(`DESIGN.md l.${design.slice(0, rule.index).split("\n").length} : la recette interdit encore List`);
  const surfaces = surfacesSection(design);
  if (!surfaces) return [...faults, "DESIGN.md : section « ## Surfaces (S-1) » absente"];
  for (const token of ["List", ".insetGrouped", "iosGroupedList()", "systemGroupedBackground"]) {
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
  // C-2, C-3b : la liste des écrans du serveur n'est pas étirée sans défiler.
  const frame = memberBody(stripComments(files.app("IOSHarnessScreens.swift")), "struct IOSHarnessScreen<");
  const list = frame.slice(frame.indexOf("List {"), frame.indexOf(".refreshable"));
  if (/maxHeight:\s*\.infinity/.test(list))
    faults.push("C-2/C-3b : la liste des écrans du serveur étire son contenu (maxHeight: .infinity)");
  // C-3a (écarté) : le titre de section n'est pas répété dans le contenu.
  if (
    /Text\(\s*(ConsoleSection\.stats|section)\.title\s*\)/.test(stripComments(files.app("IOSHarnessScreens.swift")))
  ) {
    faults.push("C-3a : IOSHarnessScreens.swift répète le titre de section dans le contenu");
  }
  // C-4 : aucun filet tracé à la main dans la Mémoire et la feuille Souvenir.
  for (const name of ["IOSMemoryScreen.swift", "IOSMemoryDetailView.swift"]) {
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

test("ios-listes-groupees-natives/AC-2 : les écrans du serveur et la Mémoire (Liste) sont des List groupées, sans filet ni panneau", () => {
  for (const name of LIST_SCREENS) {
    assert.deepEqual(listScreenFaults(name, appSource(name)), [], name);
  }

  // Faute plantée (c) : un `Divider()` réinséré dans la liste ⇒ rouge, pour CHAQUE écran.
  for (const name of LIST_SCREENS) {
    const planted = plant(appSource(name), (s) => s.replace(/\bList \{/, "List {\n            Divider()"));
    assert.ok(
      listScreenFaults(name, planted).some((f) => f.includes("Divider()")),
      `${name} : un Divider() doit rougir`,
    );
  }

  // Une rangée de feature redevenue carte ⇒ rouge.
  const harness = "IOSHarnessScreens.swift";
  const card = plant(appSource(harness), (s) =>
    s.replace(
      ".accessibilityElement(children: .combine)",
      ".iosCard()\n        .accessibilityElement(children: .combine)",
    ),
  );
  assert.ok(
    listScreenFaults(harness, card).some((f) => f.includes(".iosCard(")),
    "une carte doit rougir",
  );

  // Le style de liste posé à la main, sans la surface groupée partagée ⇒ rouge.
  const style = plant(appSource(harness), (s) => s.replace(".iosGroupedList()", ".listStyle(.insetGrouped)"));
  assert.ok(listScreenFaults(harness, style).length > 0, "un .listStyle à la main doit rougir");
});

test("ios-listes-groupees-natives/AC-10 : un panneau ou un ScrollView remis autour d'un écran en liste fait rougir la garde", () => {
  for (const name of LIST_SCREENS) {
    // Faute plantée (a) : la liste groupée redevient un panneau ⇒ rouge.
    const panel = plant(appSource(name), (s) => s.replace(".iosGroupedList()", ".iosPanel()"));
    assert.ok(listScreenFaults(name, panel).length > 0, `${name} : .iosGroupedList() → .iosPanel() doit rougir`);

    // Faute plantée (b) : un défilement autour de la List ⇒ rouge.
    const scroll = plant(appSource(name), (s) => s.replace(/\bList \{/, "ScrollView(.vertical) {\n            List {"));
    assert.ok(
      listScreenFaults(name, scroll).some((f) => f.includes("ScrollView(")),
      `${name} : un ScrollView doit rougir`,
    );
  }

  // Faute plantée (d) : un panneau dans la branche LISTE de la Mémoire ⇒ rouge.
  const memory = "IOSMemoryScreen.swift";
  const listPanel = plant(appSource(memory), (s) =>
    s.replace(".iosGroupedList()", ".iosGroupedList()\n            .iosPanel()"),
  );
  assert.ok(
    listScreenFaults(memory, listPanel).some((f) => f.includes(".iosPanel() ×2")),
    "un panneau autour de la liste Mémoire doit rougir",
  );

  // Un panneau remis autour d'une feuille (S-7) ⇒ rouge.
  for (const name of GROUPED_SHEETS) {
    const sheetPanel = plant(appSource(name), (s) =>
      s.replace(".formStyle(.grouped)", ".formStyle(.grouped)\n            .iosPanel()"),
    );
    assert.ok(
      sheetFaults(name, sheetPanel).some((f) => f.includes(".iosPanel()")),
      `${name} : un panneau autour du formulaire doit rougir`,
    );
  }
});

test("ios-listes-groupees-natives/AC-5 : un seul titre par écran en liste et par feuille, celui de la barre de navigation", () => {
  for (const name of Object.keys(TITLES)) {
    assert.deepEqual(titleFaults(name, appSource(name)), [], name);
  }

  // Faute plantée : le titre de section répété dans le contenu ⇒ rouge.
  const harness = "IOSHarnessScreens.swift";
  const repeated = plant(appSource(harness), (s) =>
    s.replace("content()\n", "Text(section.title)\n                    content()\n"),
  );
  assert.ok(
    titleFaults(harness, repeated).some((f) => f.includes("répété")),
    "un second titre doit rougir",
  );

  // Faute plantée : un second `.navigationTitle(` ⇒ rouge.
  const twice = plant(appSource(harness), (s) =>
    s.replace(".iosGroupedList()", ".iosGroupedList()\n                .navigationTitle(section.title)"),
  );
  assert.ok(
    titleFaults(harness, twice).some((f) => f.includes("×4")),
    "deux titres de navigation doivent rougir",
  );

  // Faute plantée : la feuille Souvenir sans titre de barre ⇒ rouge.
  const detail = "IOSMemoryDetailView.swift";
  const untitled = plant(appSource(detail), (s) => s.replace(".navigationTitle(IOSMemoryText.detailTitle)", ""));
  assert.ok(
    titleFaults(detail, untitled).some((f) => f.includes("×0")),
    "une feuille sans titre doit rougir",
  );
});

test("ios-listes-groupees-natives/AC-4 : en AX-XL, les rangées des écrans en liste et des feuilles grandissent avec le texte", () => {
  for (const name of [...LIST_SCREENS, ...GROUPED_SHEETS]) {
    assert.deepEqual(dynamicTypeFaults(name, appSource(name)), [], name);
  }

  // Faute plantée : une hauteur fixe sur une rangée de feature ⇒ rouge.
  const harness = "IOSHarnessScreens.swift";
  const fixed = plant(appSource(harness), (s) =>
    s.replace(
      ".accessibilityElement(children: .combine)",
      ".frame(height: 44)\n        .accessibilityElement(children: .combine)",
    ),
  );
  assert.ok(
    dynamicTypeFaults(harness, fixed).some((f) => f.includes(".frame(height:")),
    "une hauteur fixe doit rougir",
  );

  // Faute plantée : le titre d'une feature plafonné à une ligne ⇒ rouge.
  const capped = plant(appSource(harness), (s) =>
    s.replace("Text(run.title)\n", "Text(run.title)\n                .lineLimit(1)\n"),
  );
  assert.ok(
    dynamicTypeFaults(harness, capped).some((f) => f.includes("lineLimit(")),
    "un libellé tronqué doit rougir",
  );
});

test("ios-listes-groupees-natives/AC-3 : les feuilles de la Mémoire et du serveur sont des formulaires groupés natifs, sans panneau imbriqué", () => {
  for (const name of GROUPED_SHEETS) {
    assert.deepEqual(sheetFaults(name, appSource(name)), [], name);
  }

  // Faute plantée : le formulaire redevient un défilement maison dans un panneau ⇒ rouge, pour CHAQUE feuille.
  for (const name of GROUPED_SHEETS) {
    const planted = plant(appSource(name), (s) =>
      s.replace("Form {", "ScrollView { VStack {").replace(".formStyle(.grouped)", ".iosPanel()"),
    );
    const faults = sheetFaults(name, planted);
    assert.ok(
      faults.some((f) => f.includes("ScrollView")),
      `${name} : un ScrollView doit rougir`,
    );
    assert.ok(
      faults.some((f) => f.includes(".iosPanel()")),
      `${name} : un panneau doit rougir`,
    );
  }

  // Faute plantée : un filet tracé à la main dans la feuille Souvenir ⇒ rouge.
  const memory = "IOSMemoryDetailView.swift";
  const divider = plant(appSource(memory), (s) =>
    s.replace("Text(verbatim: Self.text(row))", "Divider()\n                    Text(verbatim: Self.text(row))"),
  );
  assert.ok(
    sheetFaults(memory, divider).some((f) => f.includes("Divider()")),
    "un Divider() dans la feuille Souvenir doit rougir",
  );

  // Faute plantée : le style groupé retiré d'une feuille du serveur ⇒ rouge.
  const harness = "IOSHarnessScreens.swift";
  const ungrouped = plant(appSource(harness), (s) => s.replace(".formStyle(.grouped)\n", ""));
  assert.ok(
    sheetFaults(harness, ungrouped).some((f) => f.includes(".formStyle(.grouped)")),
    "un Form sans style groupé doit rougir",
  );
});

test("ios-listes-groupees-natives/AC-1 : les constats de l'audit HIG restés vrais sont résorbés, le constat écarté ne revient pas", () => {
  const surface = fs.readFileSync(path.join(APP, "Design", "IOSSurface.swift"), "utf8");
  const real = { surface, design: fs.readFileSync(DESIGN, "utf8"), app: appSource };
  assert.deepEqual(auditFaults(real), []);
  const replacing = (file: string, source: string) => ({
    ...real,
    app: (name: string) => (name === file ? source : appSource(name)),
  });

  // Faute plantée (C-4) : un `Divider()` réinséré dans la Mémoire ⇒ rouge.
  const memory = "IOSMemoryScreen.swift";
  const divider = plant(appSource(memory), (s) => s.replace(/\bList \{/, "List {\n            Divider()"));
  assert.ok(
    auditFaults(replacing(memory, divider)).some((f) => f.startsWith(`C-4 : ${memory}`)),
    "un Divider() dans la Mémoire doit rougir",
  );

  // Faute plantée (C-1) : la carte élevée retombe sur le fond tertiaire, égal au fond groupé en clair ⇒ rouge.
  const flat = plant(surface, (s) =>
    s.replace("raised ? .secondarySystemGroupedBackground", "raised ? .tertiarySystemGroupedBackground"),
  );
  assert.ok(
    auditFaults({ ...real, surface: flat }).some((f) => f.startsWith("C-1")),
    "une carte élevée égale au fond doit rougir",
  );

  // Faute plantée (C-2) : la liste du serveur redevient un bloc étiré ⇒ rouge.
  const harness = "IOSHarnessScreens.swift";
  const stretched = plant(appSource(harness), (s) =>
    s.replace(
      ".iosGroupedList()",
      ".iosGroupedList()\n                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)",
    ),
  );
  assert.ok(
    auditFaults(replacing(harness, stretched)).some((f) => f.startsWith("C-2/C-3b")),
    "une liste étirée doit rougir",
  );

  // Faute plantée (C-3a) : le titre de section répété dans le contenu ⇒ rouge.
  const repeated = plant(appSource(harness), (s) =>
    s.replace("content()\n", "Text(section.title)\n                    content()\n"),
  );
  assert.ok(
    auditFaults(replacing(harness, repeated)).some((f) => f.startsWith("C-3a")),
    "un second titre doit rougir",
  );
});

test("ios-listes-groupees-natives/AC-9 : DESIGN.md n'interdit plus List et décrit les listes groupées", () => {
  const design = fs.readFileSync(DESIGN, "utf8");
  assert.deepEqual(designFaults(design), []);

  // Faute plantée : la règle d'avant réinsérée, sur deux lignes comme elle l'était ⇒ rouge.
  const anchor = "- Un bandeau est une surface de CONTENU";
  const oldRule = plant(design, (s) =>
    s.replace(
      anchor,
      "- Un seul défilement VERTICAL par écran : Pipelines, Sessions et Mémoire (Liste)\n  posent leur panneau dans un `ScrollView(.vertical)` et n'emploient aucune\n  `List`. `[capture: iphone-kanban-light]`\n" +
        anchor,
    ),
  );
  assert.ok(
    designFaults(oldRule).some((f) => f.includes("interdit encore List")),
    "« n'emploient aucune `List` » doit rougir",
  );

  // Faute plantée : la section Surfaces ne nomme plus le style groupé ⇒ rouge.
  const unstyled = plant(design, (s) => s.replace("de style `.insetGrouped`", "de style natif"));
  assert.ok(
    designFaults(unstyled).some((f) => f.includes(".insetGrouped")),
    "une recette sans .insetGrouped doit rougir",
  );
});
