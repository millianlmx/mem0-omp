// Les GARDES TEXTUELLES de la feature `ios-gestes-et-retours-natifs` : un test par
// critère `ios-gestes-et-retours-natifs/AC-<n>`, et c'est le SEUL fichier qui porte
// ce slug (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source de l'app iOS et de DESIGN.md ; chaque faute
// est plantée EN MÉMOIRE (`source.replace(…)`) : aucune copie du dépôt, aucun
// SwiftUI rendu. Les écrans de pilotage sont ceux du serveur de pipelines
// (`IOSHarnessScreens.swift`), la Mémoire est celle du Mac.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { braceBlock, memberBody, stripComments, swiftSources } from "../support/swift-source.ts";

const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");
const DESIGN = path.join(ROOT, "omp-console", "ios", "DESIGN.md");
const SLUG = "ios-gestes-et-retours-natifs";

/** Le source d'un fichier de l'app, tel qu'écrit (les fautes s'y plantent). */
function appSource(name: string): string {
  return fs.readFileSync(path.join(APP, name), "utf8");
}

/** Une copie des sources où `name` est remplacé par `source` (faute plantée). */
function withFile(sources: Map<string, string>, name: string, source: string): Map<string, string> {
  return new Map(sources).set(name, source);
}

/** Le nombre d'occurrences d'un motif littéral. */
const count = (source: string, needle: string) => source.split(needle).length - 1;

/** Les blocs `{ … }` ouverts par chaque occurrence de `head` (`head` finit par `{`). */
function blocksOf(code: string, head: string): string[] {
  const out: string[] = [];
  for (let at = code.indexOf(head); at >= 0; at = code.indexOf(head, at + head.length)) {
    out.push(braceBlock(code, at + head.length - 1));
  }
  return out;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * La chaîne de modificateurs de la vue qui porte la ligne de `anchor` : les
 * lignes AU MÊME RETRAIT, en remontant jusqu'à l'ouverture de la vue (`Button {`)
 * et en descendant jusqu'à la fin de l'expression. Les lignes plus retirées (le
 * libellé, le corps d'un `.contextMenu { … }`) et les lignes vides (un
 * commentaire retiré en laisse) sont sautées ; une ligne moins retirée ou une
 * ligne qui n'est ni un modificateur (`.`) ni une fermeture (`}`/`)`) ni un
 * commentaire termine la chaîne. "" si `anchor` manque.
 */
function chainAround(source: string, anchor: string, after = 0): string {
  const at = source.indexOf(anchor, after);
  if (at < 0) return "";
  const lines = source.split("\n");
  const row = source.slice(0, at).split("\n").length - 1;
  const indent = indentOf(lines[row]);
  const continues = (line: string) => /^(\.|\}|\)|\/\/)/.test(line.trimStart());
  const chain = [lines[row]];
  for (let i = row - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) < indent) break;
    if (indentOf(line) > indent) continue;
    if (!continues(line)) break;
    chain.unshift(line);
  }
  for (let i = row + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) < indent) break;
    if (indentOf(line) > indent) continue;
    if (!continues(line)) break;
    chain.push(line);
  }
  return chain.join("\n");
}

/** Plante une faute : le remplacement DOIT changer le source. */
function plant(source: string, change: (s: string) => string): string {
  const after = change(source);
  assert.notEqual(after, source, "la faute plantée n'a rien changé");
  return after;
}

// MARK: - AC-2, AC-4 : tirer pour actualiser, barres sans ↻

/** Chaque `ToolbarItem(…) { … }` du source, sans commentaires. */
function toolbarItems(code: string): string[] {
  const out: string[] = [];
  for (let at = code.indexOf("ToolbarItem("); at >= 0; at = code.indexOf("ToolbarItem(", at + 1)) {
    out.push(braceBlock(code, code.indexOf("{", at)));
  }
  return out;
}

/** Aucun bouton ↻ (`arrow.clockwise`) dans une `ToolbarItem` de l'écran. */
function toolbarRefreshFaults(name: string, source: string): string[] {
  return toolbarItems(stripComments(source))
    .filter((item) => item.includes("arrow.clockwise"))
    .map(() => `${name} : un bouton ↻ (arrow.clockwise) dans une ToolbarItem`);
}

const HARNESS = "IOSHarnessScreens.swift";
const MEMORY_PULL = ".refreshable { await model.refresh() }";

/**
 * AC-2 (S-2) : le cadre commun des écrans du serveur et la liste de la Mémoire se
 * tirent ; le graphe ne se tire pas ; aucun ↻ de barre ni identifiant de ↻ ne survit.
 */
function pullFaults(files: { harness: string; memory: string; all: Map<string, string> }): string[] {
  const faults: string[] = [];
  const harness = stripComments(files.harness);
  const frame = memberBody(harness, "struct IOSHarnessScreen<");
  const pulls = blocksOf(frame, ".refreshable {");
  // Le geste relit par `reload()`, que ⌘R partage : c'est elle qui relit le serveur.
  const reload = memberBody(frame, "private func reload()");
  if (pulls.length !== 1 || !pulls[0].includes("await reload()") || !reload.includes("await server.refresh()")) {
    faults.push(`${HARNESS} : le cadre IOSHarnessScreen sans « .refreshable { await reload() } » qui relit le serveur`);
  }
  if (count(harness, ".refreshable") !== 1) faults.push(`${HARNESS} : ${count(harness, ".refreshable")} .refreshable (attendu 1, le cadre commun)`);

  const memory = stripComments(files.memory);
  if (count(memberBody(memory, "private var surface"), MEMORY_PULL) !== 1) faults.push(`IOSMemoryScreen.swift : la liste de surface sans « ${MEMORY_PULL} »`);
  if (count(memory, ".refreshable") !== 1) faults.push(`IOSMemoryScreen.swift : ${count(memory, ".refreshable")} .refreshable (attendu 1, la liste seule)`);

  faults.push(...toolbarRefreshFaults(HARNESS, files.harness), ...toolbarRefreshFaults("IOSMemoryScreen.swift", files.memory));
  for (const [name, source] of files.all) {
    const code = stripComments(source);
    for (const id of ["PipelinesAccessibility.refresh", "IOSMemoryAccessibility.refresh"]) {
      if (new RegExp(`${id.replace(".", "\\.")}\\b`).test(code)) faults.push(`${name} : identifiant de ↻ ${id} encore cité`);
    }
  }
  return faults;
}

/** AC-4 (S-2) : la Mémoire déclare exactement deux ToolbarItem (« Sommaire », bascule). */
function memoryBarFaults(memory: string): string[] {
  const faults: string[] = [];
  const items = toolbarItems(stripComments(memory));
  if (items.length !== 2) faults.push(`IOSMemoryScreen.swift : ${items.length} ToolbarItem (attendu 2 ; + l'antenne de RootView = 3)`);
  if (!items.some((item) => item.includes("summaryButton"))) faults.push("IOSMemoryScreen.swift : « Sommaire » absent de la barre");
  if (!items.some((item) => item.includes("IOSMemoryAccessibility.graphToggle"))) faults.push("IOSMemoryScreen.swift : bascule Graphe/Liste absente de la barre");
  faults.push(...toolbarRefreshFaults("IOSMemoryScreen.swift", memory));
  return faults;
}

/** AC-4 : l'antenne Connexion de RootView reste UN seul bouton de barre. */
function antennaFaults(root: string): string[] {
  const n = toolbarItems(memberBody(stripComments(root), "var connectionToolbarItem")).length;
  return n === 1 ? [] : [`RootView.swift : connectionToolbarItem porte ${n} ToolbarItem (attendu 1)`];
}

// MARK: - AC-5 : menus contextuels

/**
 * AC-5 (S-4) : la rangée de la Mémoire rend `IOSContextMenuItems` nourri par
 * `IOSContextMenu.<surface>` ; la rangée d'une feature du serveur n'offre que
 * l'arrêt, destructif et confirmé (`drafts.stopRequest`), jamais exécuté du menu.
 */
function menuFaults(all: Map<string, string>): string[] {
  const faults: string[] = [];
  const memory = stripComments(all.get("IOSMemoryScreen.swift") ?? "");
  const memoryMenus = blocksOf(memberBody(memory, "func rowsSection"), ".contextMenu {");
  if (memoryMenus.length !== 1 || count(memory, ".contextMenu") !== 1) {
    faults.push(`IOSMemoryScreen.swift : ${count(memory, ".contextMenu")} .contextMenu (attendu 1, dans func rowsSection)`);
  }
  for (const menu of memoryMenus) {
    if (!menu.includes("IOSContextMenuItems(") || !menu.includes("IOSContextMenu.")) {
      faults.push("IOSMemoryScreen.swift : un .contextMenu ne rend pas IOSContextMenuItems(actions: IOSContextMenu.…)");
    }
  }
  const harness = stripComments(all.get(HARNESS) ?? "");
  const runMenus = blocksOf(memberBody(harness, "struct IOSHarnessRunRow"), ".contextMenu {");
  if (runMenus.length !== 1 || count(harness, ".contextMenu") !== 1) {
    faults.push(`${HARNESS} : ${count(harness, ".contextMenu")} .contextMenu (attendu 1, dans struct IOSHarnessRunRow)`);
  }
  for (const menu of runMenus) {
    if (!/role: \.destructive\) \{ drafts\.stopRequest = run \}/.test(menu)) faults.push(`${HARNESS} : le menu d'une feature ne demande pas l'arrêt confirmé (drafts.stopRequest)`);
    if (menu.includes("server.")) faults.push(`${HARNESS} : le menu d'une feature agit sur le serveur sans confirmation`);
  }
  return faults;
}

/** Aucune action par balayage dans l'app (B-3 : hors périmètre). */
function swipeFaults(all: Map<string, string>): string[] {
  return [...all].filter(([, source]) => stripComments(source).includes(".swipeActions")).map(([name]) => `${name} : .swipeActions`);
}

// MARK: - AC-9, AC-10, AC-11, AC-12

/** Les surfaces de texte sélectionnable (S-6), une pose chacune : les specs à
 *  valider de l'Accueil et la fiche d'un souvenir. */
const SELECTABLE = [HARNESS, "IOSMemoryDetailView.swift"];

/** AC-9 (S-6) : `.textSelection(.enabled)` une fois par surface, nulle part ailleurs. */
function selectionFaults(all: Map<string, string>): string[] {
  const faults: string[] = [];
  for (const [name, source] of all) {
    const n = count(stripComments(source), ".textSelection(.enabled)");
    const expected = SELECTABLE.includes(name) ? 1 : 0;
    if (n !== expected) faults.push(`${name} : ${n} .textSelection(.enabled) (attendu ${expected})`);
  }
  const detail = stripComments(all.get("IOSMemoryDetailView.swift") ?? "");
  if (!chainAround(detail, ".textSelection(.enabled)").includes(".formStyle(.grouped)")) {
    faults.push("IOSMemoryDetailView.swift : .textSelection(.enabled) n'est pas posé sur le Form");
  }
  return faults;
}

/** Les éléments touchables qui portent le survol (S-7) : fichier, ancre, membre. Les
 *  rangées des écrans du serveur sont des rangées de List : le survol est celui du système. */
const HOVER_HOSTS: { name: string; anchor: string; scope?: string }[] = [
  { name: "IOSMemoryScreen.swift", anchor: ".accessibilityIdentifier(IOSMemoryAccessibility.row(row.id))" },
];

/** AC-10 (S-7) : chaque élément listé porte `.iosHoverEffect()`, qui est le survol système. */
function hoverFaults(all: Map<string, string>): string[] {
  const faults: string[] = [];
  for (const { name, anchor, scope } of HOVER_HOSTS) {
    const code = stripComments(all.get(name) ?? "");
    const chain = chainAround(code, anchor, scope ? code.indexOf(scope) : 0);
    if (!chain) faults.push(`${name} : ancre ${anchor} introuvable`);
    else if (!chain.includes(".iosHoverEffect()")) faults.push(`${name} : ${anchor} sans .iosHoverEffect()`);
  }
  const modifier = memberBody(stripComments(all.get(path.join("Design", "IOSSurface.swift")) ?? ""), "func iosHoverEffect()");
  if (!modifier.includes(".hoverEffect(.highlight)")) faults.push("IOSSurface.swift : iosHoverEffect() ne pose pas .hoverEffect(.highlight)");
  if (!modifier.includes("contentShape(.hoverEffect, .rect(cornerRadius: IOSSurface.cardRadius))")) faults.push("IOSSurface.swift : iosHoverEffect() sans forme de carte");
  return faults;
}

/** AC-11 (S-8) : toute animation déclenchée par l'app passe par IOSMotion, qui suit « Réduire les animations ». */
function motionFaults(all: Map<string, string>): string[] {
  const faults: string[] = [];
  const motion = memberBody(stripComments(all.get(path.join("Design", "IOSMotion.swift")) ?? ""), "static func scrollAnimation");
  if (!motion.includes("reduceMotion ? nil : .default")) faults.push("IOSMotion.swift : scrollAnimation ne coupe pas l'animation sous « Réduire les animations »");
  for (const [name, source] of all) {
    const code = stripComments(source);
    for (const match of code.matchAll(/withAnimation\s*(\(|\{)/g)) {
      if (!code.startsWith("withAnimation(IOSMotion.scrollAnimation(", match.index)) {
        faults.push(`${name} l.${code.slice(0, match.index).split("\n").length} : withAnimation hors d'IOSMotion.scrollAnimation`);
      }
    }
  }
  return faults;
}

/** Les symboles décoratifs de S-9 : fichier → début d'`Image` → occurrences attendues. */
const DECORATIVE: { name: string; image: string; times: number }[] = [
  { name: HARNESS, image: "Image(systemName: IOSShellText.serverSymbol)", times: 1 },
];

/**
 * AC-12 (S-9) : chaque symbole décoratif est suivi de `.accessibilityHidden(true)`
 * à trois lignes au plus ; l'état que porte la coche d'une proposition d'audit est
 * annoncé par le trait sélectionné.
 */
function symbolFaults(all: Map<string, string>): string[] {
  const faults: string[] = [];
  for (const { name, image, times } of DECORATIVE) {
    const code = stripComments(all.get(name) ?? "");
    const lines = code.split("\n");
    let found = 0;
    lines.forEach((line, i) => {
      if (!line.includes(image)) return;
      found++;
      if (!lines.slice(i + 1, i + 4).some((next) => next.includes(".accessibilityHidden(true)"))) {
        faults.push(`${name} l.${i + 1} : ${image} lu par VoiceOver (pas de .accessibilityHidden(true))`);
      }
    });
    if (found !== times) faults.push(`${name} : ${found} × ${image} (attendu ${times})`);
  }
  const harness = stripComments(all.get(HARNESS) ?? "");
  if (!chainAround(harness, ".buttonStyle(.borderless)", harness.indexOf("drafts.togglePick(")).includes(".accessibilityAddTraits(drafts.isPicked(audit, index) ? .isSelected : [])")) {
    faults.push(`${HARNESS} : la proposition retenue n'est pas annoncée sélectionnée`);
  }
  return faults;
}

// MARK: - AC-13 : « Sommaire »

/**
 * AC-13 (S-10) : « Sommaire » est toujours dans la barre et se désactive par
 * `.disabled` système ; ni teinte, ni bulle, ni raison.
 */
function summaryFaults(all: Map<string, string>): string[] {
  const faults: string[] = [];
  const memory = stripComments(all.get("IOSMemoryScreen.swift") ?? "");
  const button = memberBody(memory, "private var summaryButton");
  if (!button) return ["IOSMemoryScreen.swift : summaryButton absent"];
  if (!button.includes(".disabled(!model.summaryAvailable(graphShown: graph.shown))")) faults.push("summaryButton n'est pas désactivé par summaryAvailable");
  for (const token of [".popover", ".tint(", ".foregroundStyle(", ".opacity(", ".accessibilityHint(", ".accessibilityValue("]) {
    if (button.includes(token)) faults.push(`summaryButton porte ${token}`);
  }
  if (!toolbarItems(memory).some((item) => /^\{\s*summaryButton\s*\}$/.test(item))) faults.push("« Sommaire » n'est pas une ToolbarItem inconditionnelle");
  for (const [name, source] of all) {
    if (/summaryUnavailableReason|summaryReason/.test(stripComments(source))) faults.push(`${name} : raison d'indisponibilité de « Sommaire » encore présente`);
  }
  const model = stripComments(all.get("IOSMemoryModel.swift") ?? "");
  if (!/static func summaryAvailable\(graphShown: Bool, isSearching: Bool, isLoading: Bool\) -> Bool/.test(model)) faults.push("IOSMemoryModel.swift : summaryAvailable statique absente");
  return faults;
}

// MARK: - AC-14 : DESIGN.md

const SECTION = "## Gestes et retours natifs";

/** Les marqueurs que la section doit porter (un par règle de S-2 à S-9). */
const SECTION_MARKERS = [
  `[garde: ${SLUG}/AC-2]`,
  `[garde: ${SLUG}/AC-4]`,
  `[garde: ${SLUG}/AC-9]`,
  `[garde: ${SLUG}/AC-10]`,
  `[garde: ${SLUG}/AC-12]`,
];

/** Le texte d'une section `## …` de DESIGN.md, ou "". */
function sectionOf(design: string, heading: string): string {
  const start = design.indexOf(`\n${heading}`);
  if (start === -1) return "";
  const next = design.indexOf("\n## ", start + 1);
  return next === -1 ? design.slice(start + 1) : design.slice(start + 1, next + 1);
}

/** Les puces d'un texte Markdown (première ligne « - », continuations indentées). */
function bullets(text: string): string[][] {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("- ")) {
      if (current) out.push(current);
      current = [line];
    } else if (current && line.startsWith("  ")) current.push(line);
    else {
      if (current) out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * AC-14 (S-11) : DESIGN.md décrit les gestes dans sa section, chaque puce
 * marquée ; « Sommaire » n'a plus de bulle ; plus aucun ↻ « Rafraîchir » iOS.
 * La résolution de chaque marqueur est celle de design-ios/AC-9.
 */
function designFaults(design: string): string[] {
  const faults: string[] = [];
  const section = sectionOf(design, SECTION);
  if (!section) return [`DESIGN.md : section « ${SECTION} » absente`];
  const errors = design.indexOf("\n## Erreurs du Mac");
  if (errors !== -1 && design.indexOf(`\n${SECTION}`) > errors) faults.push(`DESIGN.md : « ${SECTION} » n'est pas avant « ## Erreurs du Mac »`);
  const items = bullets(section);
  if (items.length < SECTION_MARKERS.length) faults.push(`DESIGN.md, ${SECTION} : ${items.length} puces (au moins ${SECTION_MARKERS.length} attendues)`);
  for (const lines of items) {
    if (!/\[(test|capture|garde): [^\]]+\]`?$/.test(lines[lines.length - 1])) faults.push(`DESIGN.md, ${SECTION} : puce sans marqueur « ${lines[0].slice(0, 50)}… »`);
  }
  for (const marker of SECTION_MARKERS) {
    if (!section.includes(marker)) faults.push(`DESIGN.md, ${SECTION} : marqueur ${marker} absent`);
  }
  const summary = bullets(sectionOf(design, "## Mémoire (feature `ios-memoire`)")).find((lines) => lines[0].includes("« Sommaire »"));
  if (!summary) faults.push("DESIGN.md, Mémoire : puce « Sommaire » absente");
  else {
    // « sans teinte ni bulle » est la règle elle-même : seule une bulle AFFIRMÉE rougit.
    if (/(?<!ni )bulle/.test(summary.join("\n"))) faults.push("DESIGN.md, Mémoire : la puce « Sommaire » parle encore d'une bulle");
  }
  for (const stale of ["Rafraîchir", "pipelines.refresh", "ios.memoire.refresh"]) {
    if (design.includes(stale)) faults.push(`DESIGN.md : « ${stale} » encore décrit`);
  }
  return faults;
}

// MARK: - Tests

test("ios-gestes-et-retours-natifs/AC-2 : les écrans du serveur et la liste de la Mémoire se tirent pour actualiser, aucune barre ne porte de ↻", () => {
  const all = swiftSources(APP);
  const files = () => ({ harness: all.get(HARNESS)!, memory: all.get("IOSMemoryScreen.swift")!, all });
  assert.deepEqual(pullFaults(files()), []);

  // Faute plantée : le cadre du serveur perd son tirage ⇒ rouge.
  const frame = plant(files().harness, (s) => s.replace(".refreshable {", ".onAppear {"));
  assert.ok(pullFaults({ ...files(), harness: frame }).some((f) => f.includes("IOSHarnessScreen")), "un écran du serveur sans tirage doit rougir");

  // Faute plantée : la liste de la Mémoire perd son tirage ⇒ rouge.
  const list = plant(files().memory, (s) => s.replace(MEMORY_PULL, ""));
  assert.ok(pullFaults({ ...files(), memory: list }).some((f) => f.includes("IOSMemoryScreen.swift")), "une liste Mémoire sans tirage doit rougir");

  // Faute plantée : un ↻ remis dans la barre du serveur ⇒ rouge.
  const bar = plant(files().harness, (s) => s.replace("Label(PipelineServerText.open, systemImage: IOSShellText.serverSymbol)", "Label(PipelineServerText.open, systemImage: \"arrow.clockwise\")"));
  assert.ok(pullFaults({ ...files(), harness: bar }).some((f) => f.includes("arrow.clockwise")), "un ↻ de barre doit rougir");

  // Faute plantée : l'identifiant du ↻ de la Mémoire revient ⇒ rouge.
  const id = plant(files().memory, (s) => s.replace(".accessibilityIdentifier(IOSMemoryAccessibility.summary)", ".accessibilityIdentifier(IOSMemoryAccessibility.refresh)"));
  const withId = withFile(all, "IOSMemoryScreen.swift", id);
  assert.ok(pullFaults({ ...files(), memory: id, all: withId }).some((f) => f.includes("IOSMemoryAccessibility.refresh")), "l'identifiant du ↻ doit rougir");
});

test("ios-gestes-et-retours-natifs/AC-4 : la barre de la Mémoire porte trois boutons au plus, dans les deux modes", () => {
  const memory = appSource("IOSMemoryScreen.swift");
  assert.deepEqual(memoryBarFaults(memory), []);
  assert.deepEqual(antennaFaults(appSource("RootView.swift")), []);

  // Faute plantée : une troisième ToolbarItem (↻) dans la Mémoire ⇒ rouge.
  const third = plant(memory, (s) => s.replace(
    "ToolbarItem(placement: .topBarTrailing) { summaryButton }",
    "ToolbarItem(placement: .topBarTrailing) { Button { refreshShown() } label: { Image(systemName: \"arrow.clockwise\") } }\n                ToolbarItem(placement: .topBarTrailing) { summaryButton }",
  ));
  const faults = memoryBarFaults(third);
  assert.ok(faults.some((f) => f.includes("3 ToolbarItem")), "trois ToolbarItem doivent rougir");
  assert.ok(faults.some((f) => f.includes("arrow.clockwise")), "un ↻ doit rougir");
});

test("ios-gestes-et-retours-natifs/AC-5 : rangées des features et de la Mémoire ont un menu contextuel natif, sans balayage", () => {
  const all = swiftSources(APP);
  assert.deepEqual(menuFaults(all), []);
  assert.deepEqual(swipeFaults(all), []);

  // Faute plantée : le menu de la rangée Mémoire retiré ⇒ rouge.
  const memory = plant(all.get("IOSMemoryScreen.swift")!, (s) => s.replace(".contextMenu {", ".overlay {"));
  assert.ok(menuFaults(withFile(all, "IOSMemoryScreen.swift", memory)).some((f) => f.startsWith("IOSMemoryScreen.swift")), "une rangée Mémoire sans menu doit rougir");

  // Faute plantée : le menu d'une feature arrête sans confirmation ⇒ rouge.
  const direct = plant(all.get(HARNESS)!, (s) => s.replace("role: .destructive) { drafts.stopRequest = run }", "role: .destructive) { Task { await server.cancel(runId: run.id) } }"));
  assert.ok(menuFaults(withFile(all, HARNESS, direct)).some((f) => f.includes("sans confirmation")), "un arrêt sans confirmation doit rougir");

  // Faute plantée : une action par balayage ⇒ rouge.
  const swipe = plant(all.get("IOSMemoryScreen.swift")!, (s) => s.replace(".iosHoverEffect()", ".swipeActions { EmptyView() }\n                .iosHoverEffect()"));
  assert.deepEqual(swipeFaults(withFile(all, "IOSMemoryScreen.swift", swipe)), ["IOSMemoryScreen.swift : .swipeActions"]);
});

test("ios-gestes-et-retours-natifs/AC-9 : les specs à valider et la fiche d'un souvenir ont un texte sélectionnable", () => {
  const all = swiftSources(APP);
  assert.deepEqual(selectionFaults(all), []);

  // Faute plantée : la fiche d'un souvenir perd sa sélection ⇒ rouge.
  const detail = plant(all.get("IOSMemoryDetailView.swift")!, (s) => s.replace(".textSelection(.enabled)", ""));
  assert.ok(selectionFaults(withFile(all, "IOSMemoryDetailView.swift", detail)).some((f) => f.includes("IOSMemoryDetailView.swift : 0")), "une fiche sans sélection doit rougir");

  // Faute plantée : une seconde pose sur les specs ⇒ rouge.
  const twice = plant(all.get(HARNESS)!, (s) => s.replace(".textSelection(.enabled)", ".textSelection(.enabled)\n                    .textSelection(.enabled)"));
  assert.ok(selectionFaults(withFile(all, HARNESS, twice)).some((f) => f.includes(`${HARNESS} : 2`)), "deux poses doivent rougir");
});

test("ios-gestes-et-retours-natifs/AC-10 : chaque rangée touchable de la Mémoire porte le survol natif d'iPad", () => {
  const all = swiftSources(APP);
  assert.deepEqual(hoverFaults(all), []);

  // Faute plantée : la rangée Mémoire perd son survol ⇒ rouge.
  const memory = plant(all.get("IOSMemoryScreen.swift")!, (s) => s.replace(".iosHoverEffect()", ""));
  assert.ok(hoverFaults(withFile(all, "IOSMemoryScreen.swift", memory)).some((f) => f.includes("IOSMemoryAccessibility.row")), "une rangée sans survol doit rougir");

  // Faute plantée : le modificateur ne pose plus l'effet système ⇒ rouge.
  const surfaceName = path.join("Design", "IOSSurface.swift");
  const surface = plant(all.get(surfaceName)!, (s) => s.replace(".hoverEffect(.highlight)", ".hoverEffect(.lift)"));
  assert.ok(hoverFaults(withFile(all, surfaceName, surface)).some((f) => f.includes(".hoverEffect(.highlight)")), "un autre effet doit rougir");
});

test("ios-gestes-et-retours-natifs/AC-11 : toute animation déclenchée par l'app suit Réduire les animations", () => {
  const all = swiftSources(APP);
  assert.deepEqual(motionFaults(all), []);

  // Faute plantée : une animation nue sur un écran du serveur ⇒ rouge.
  const harness = plant(all.get(HARNESS)!, (s) => s.replace("drafts.addFeature()", "withAnimation { drafts.addFeature() }"));
  assert.ok(motionFaults(withFile(all, HARNESS, harness)).some((f) => f.startsWith(HARNESS)), "un withAnimation nu doit rougir");

  // Faute plantée : IOSMotion anime toujours ⇒ rouge.
  const motionName = path.join("Design", "IOSMotion.swift");
  const motion = plant(all.get(motionName)!, (s) => s.replace("reduceMotion ? nil : .default", ".default"));
  assert.ok(motionFaults(withFile(all, motionName, motion)).some((f) => f.startsWith("IOSMotion.swift")), "une animation forcée doit rougir");
});

test("ios-gestes-et-retours-natifs/AC-12 : les symboles décoratifs sont masqués à VoiceOver, l'état qu'ils portaient est annoncé", () => {
  const all = swiftSources(APP);
  assert.deepEqual(symbolFaults(all), []);

  // Faute plantée : le symbole du serveur non relié redevient lu ⇒ rouge.
  const hidden = plant(all.get(HARNESS)!, (s) => s.replace(".accessibilityHidden(true)", ""));
  assert.ok(symbolFaults(withFile(all, HARNESS, hidden)).some((f) => f.includes("lu par VoiceOver")), "un symbole lu doit rougir");

  // Faute plantée : la proposition retenue n'a plus son trait ⇒ rouge.
  const picked = plant(all.get(HARNESS)!, (s) => s.replace(".accessibilityAddTraits(drafts.isPicked(audit, index) ? .isSelected : [])", ""));
  assert.ok(symbolFaults(withFile(all, HARNESS, picked)).some((f) => f.includes("sélectionnée")), "une proposition retenue muette doit rougir");
});

test("ios-gestes-et-retours-natifs/AC-13 : « Sommaire » est un vrai bouton désactivé, toujours visible, sans teinte ni bulle", () => {
  const all = swiftSources(APP);
  assert.deepEqual(summaryFaults(all), []);

  // Faute plantée : la bulle d'explication revient ⇒ rouge.
  const popover = plant(all.get("IOSMemoryScreen.swift")!, (s) => s.replace(
    ".disabled(!model.summaryAvailable(graphShown: graph.shown))",
    ".popover(isPresented: .constant(false)) { EmptyView() }\n        .tint(Color(uiColor: .tertiaryLabel))",
  ));
  const faults = summaryFaults(withFile(all, "IOSMemoryScreen.swift", popover));
  for (const needle of ["n'est pas désactivé", ".popover", ".tint("]) assert.ok(faults.some((f) => f.includes(needle)), `${needle} doit rougir`);

  // Faute plantée : « Sommaire » masqué hors disponibilité ⇒ rouge.
  const hidden = plant(all.get("IOSMemoryScreen.swift")!, (s) => s.replace("ToolbarItem(placement: .topBarTrailing) { summaryButton }", "ToolbarItem(placement: .topBarTrailing) { if model.canShowSummary { summaryButton } }"));
  assert.ok(summaryFaults(withFile(all, "IOSMemoryScreen.swift", hidden)).some((f) => f.includes("inconditionnelle")), "un « Sommaire » conditionnel doit rougir");
});

test("ios-gestes-et-retours-natifs/AC-14 : DESIGN.md décrit les gestes et retours natifs, chaque puce marquée", () => {
  const design = fs.readFileSync(DESIGN, "utf8");
  assert.deepEqual(designFaults(design), []);

  // Faute plantée : la section disparaît ⇒ rouge.
  const missing = plant(design, (s) => s.replace(`\n${SECTION} (`, "\n## Gestes ("));
  assert.deepEqual(designFaults(missing), [`DESIGN.md : section « ${SECTION} » absente`]);

  // Faute plantée : une puce perd son marqueur ⇒ rouge.
  const unmarked = plant(design, (s) => s.replace(" `[garde: " + SLUG + "/AC-9]`", ""));
  assert.ok(designFaults(unmarked).some((f) => f.includes("puce sans marqueur")), "une puce sans marqueur doit rougir");

  // Faute plantée : la bulle de « Sommaire » revient ⇒ rouge.
  const bubble = plant(design, (s) => s.replace("sans teinte\n  ni bulle.", "et un toucher\n  montre la raison dans une bulle."));
  assert.ok(designFaults(bubble).some((f) => f.includes("bulle")), "la bulle doit rougir");

  // Faute plantée : le ↻ « Rafraîchir » revient ⇒ rouge.
  const stale = `${design}\n- « Rafraîchir » relit l'écran.\n`;
  assert.ok(designFaults(stale).some((f) => f.includes("Rafraîchir")), "« Rafraîchir » doit rougir");
});
