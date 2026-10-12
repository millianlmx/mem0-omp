// Les GARDES TEXTUELLES de la feature `ios-gestes-et-retours-natifs` : un test par
// critère `ios-gestes-et-retours-natifs/AC-<n>`, et c'est le SEUL fichier qui porte
// ce slug (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source de l'app iOS, du client et de DESIGN.md ;
// chaque faute est plantée EN MÉMOIRE (`source.replace(…)`) : aucune copie du
// dépôt, aucun SwiftUI rendu. Les preuves de comportement sont les tests Swift
// `OMPConsoleIOSTests/IOSGestesNatifsTests.swift` ; la preuve visuelle (tirage,
// menus, sélection, arbre d'accessibilité) est la recette de captures
// `scripts/recette/ios-gestes-retours-recette.sh`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { braceBlock, memberBody, stripComments, stripHashComments, swiftSources } from "../support/swift-source.ts";

const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");
const CLIENT = path.join(ROOT, "omp-console", "Sources", "ConsoleClient", "ConsoleClientModel.swift");
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

const PIPELINES_PULL = ".refreshable { await PipelinesModel.refresh(client) }";
const MEMORY_PULL = ".refreshable { await model.refresh() }";

/**
 * AC-2 (S-2) : la liste de Pipelines (iPhone et états) et son kanban iPad, et la
 * liste de la Mémoire se tirent ; le graphe ne se tire pas ; aucun ↻ de barre ni
 * identifiant de ↻ ne survit.
 */
function pullFaults(files: { pipelines: string; memory: string; model: string; all: Map<string, string> }): string[] {
  const faults: string[] = [];
  const pipelines = stripComments(files.pipelines);
  for (const host of ["func list<", "func regularBoard"]) {
    if (count(memberBody(pipelines, host), PIPELINES_PULL) !== 1) faults.push(`PipelinesScreen.swift : ${host} sans « ${PIPELINES_PULL} »`);
  }
  if (count(pipelines, ".refreshable") !== 2) faults.push(`PipelinesScreen.swift : ${count(pipelines, ".refreshable")} .refreshable (attendu 2)`);

  const memory = stripComments(files.memory);
  if (count(memberBody(memory, "private var surface"), MEMORY_PULL) !== 1) faults.push(`IOSMemoryScreen.swift : la liste de surface sans « ${MEMORY_PULL} »`);
  if (count(memory, ".refreshable") !== 1) faults.push(`IOSMemoryScreen.swift : ${count(memory, ".refreshable")} .refreshable (attendu 1, la liste seule)`);

  const model = stripComments(files.model);
  if (!/static func refresh\(_ client: ConsoleClientModel\) async\b/.test(model)) faults.push("PipelinesModel.swift : static func refresh(_ client:) async absente");
  if (!model.includes("static func canRefresh(connection: ClientState) -> Bool")) faults.push("PipelinesModel.swift : canRefresh(connection:) absente");

  faults.push(...toolbarRefreshFaults("PipelinesScreen.swift", files.pipelines), ...toolbarRefreshFaults("IOSMemoryScreen.swift", files.memory));
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

/** Les surfaces à menu : fichier → nombre de `.contextMenu {` et membre hôte. */
const MENU_HOSTS: Record<string, { menus: number; host: string }> = {
  "PipelinesScreen.swift": { menus: 1, host: "func cardContent" },
  "HomeView.swift": { menus: 5, host: "struct HomeView" },
  "IOSSessionsScreen.swift": { menus: 1, host: "ForEach(day.choices" },
  "IOSMemoryScreen.swift": { menus: 1, host: "func rowsSection" },
};

/**
 * AC-5 (S-4) : chaque surface pose ses `.contextMenu` dans son hôte, et chacun
 * rend `IOSContextMenuItems` nourri par `IOSContextMenu.<surface>` (directement,
 * ou par `rowMenu` pour les rangées de l'Accueil).
 */
function menuFaults(name: string, source: string): string[] {
  const faults: string[] = [];
  const code = stripComments(source);
  const { menus, host } = MENU_HOSTS[name];
  const hosted = blocksOf(memberBody(code, host), ".contextMenu {");
  if (hosted.length !== menus || count(code, ".contextMenu") !== menus) {
    faults.push(`${name} : ${count(code, ".contextMenu")} .contextMenu (attendu ${menus}, dans ${host})`);
  }
  for (const menu of hosted) {
    if (menu.includes("rowMenu(")) continue;
    if (!menu.includes("IOSContextMenuItems(") || !menu.includes("IOSContextMenu.")) {
      faults.push(`${name} : un .contextMenu ne rend pas IOSContextMenuItems(actions: IOSContextMenu.…)`);
    }
  }
  if (hosted.some((menu) => menu.includes("rowMenu("))) {
    const rowMenu = memberBody(code, "func rowMenu");
    if (!rowMenu.includes("IOSContextMenuItems(") || !rowMenu.includes("IOSContextMenu.homeRow(")) {
      faults.push(`${name} : rowMenu ne rend pas IOSContextMenuItems(actions: IOSContextMenu.homeRow(…))`);
    }
  }
  return faults;
}

/** Aucune action par balayage dans l'app (B-3 : hors périmètre). */
function swipeFaults(all: Map<string, string>): string[] {
  return [...all].filter(([, source]) => stripComments(source).includes(".swipeActions")).map(([name]) => `${name} : .swipeActions`);
}

// MARK: - AC-8 : retour haptique à la réponse du Mac

/**
 * AC-8 (S-5) : un seul `.sensoryFeedback(` dans l'app, posé par RootView sur
 * l'issue des commandes ; aucun générateur UIKit.
 */
function feedbackFaults(all: Map<string, string>): string[] {
  const faults: string[] = [];
  const hosts: string[] = [];
  for (const [name, source] of all) {
    const code = stripComments(source);
    for (let i = 0; i < count(code, ".sensoryFeedback("); i++) hosts.push(name);
    if (/UI(Impact|Notification|Selection)FeedbackGenerator/.test(code)) faults.push(`${name} : générateur haptique UIKit`);
  }
  if (hosts.length !== 1 || hosts[0] !== "RootView.swift") faults.push(`.sensoryFeedback( posé par [${hosts.join(", ")}] (attendu : RootView.swift seul)`);
  const root = stripComments(all.get("RootView.swift") ?? "");
  if (!/\.sensoryFeedback\(trigger: client\.commandOutcome\)\s*\{\s*_, outcome in\s*IOSCommandFeedback\.feedback\(for: outcome\)/.test(root)) {
    faults.push("RootView.swift : .sensoryFeedback ne suit pas client.commandOutcome par IOSCommandFeedback.feedback(for:)");
  }
  return faults;
}

/** Les écritures qui ne sont pas des commandes de l'utilisateur (S-5). */
const NON_COMMAND_PATHS = ['ConsoleAPI.Service.basePath + "/pair"', 'ConsoleAPI.Service.basePath + "/devices/self"', '"/v1/pull-request-states/refresh"'];

/**
 * AC-8 (S-5) : dans le client, chaque requête POST/DELETE est l'argument d'un
 * `performCommand(` ou `performGesture(` — sauf l'appairage, l'oubli et la
 * relecture des PR.
 */
function commandRouteFaults(client: string): string[] {
  const faults: string[] = [];
  const code = stripComments(client);
  let commands = 0;
  for (const match of code.matchAll(/ClientHTTPRequest\(\s*method:\s*"(POST|DELETE)",\s*path:\s*([^\n]*)/g)) {
    const routed = code.slice(0, match.index).trimEnd();
    const pathText = match[2];
    const line = code.slice(0, match.index).split("\n").length;
    if (NON_COMMAND_PATHS.some((p) => pathText.startsWith(p))) {
      if (/perform(Command|Gesture)\($/.test(routed)) faults.push(`ConsoleClientModel.swift l.${line} : ${pathText.split(",")[0]} n'est pas une commande`);
      continue;
    }
    commands++;
    if (!/perform(Command|Gesture)\($/.test(routed)) faults.push(`ConsoleClientModel.swift l.${line} : ${match[1]} ${pathText.split(",")[0]} hors de performCommand/performGesture`);
  }
  if (commands < 16) faults.push(`ConsoleClientModel.swift : ${commands} commandes POST/DELETE trouvées (au moins 16 attendues)`);
  return faults;
}

// MARK: - AC-9, AC-10, AC-11, AC-12

/** Les surfaces de texte sélectionnable (S-6), une pose chacune. */
const SELECTABLE = ["IOSSessionViewerSheet.swift", "HomeContractSheet.swift", "IOSMemoryDetailView.swift"];

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

/** Les éléments touchables qui portent le survol (S-7) : fichier, ancre, membre. */
const HOVER_HOSTS: { name: string; anchor: string; scope?: string }[] = [
  { name: "PipelinesScreen.swift", anchor: ".accessibilityIdentifier(PipelinesAccessibility.card(card.id))" },
  { name: "PipelinesScreen.swift", anchor: ".accessibilityAddTraits(.isHeader)", scope: "func laneHeader" },
  { name: "IOSSessionsScreen.swift", anchor: ".accessibilityIdentifier(IOSSessionsAccessibility.row(choice.id))" },
  { name: "IOSMemoryScreen.swift", anchor: ".accessibilityIdentifier(IOSMemoryAccessibility.row(row.id))" },
  { name: "IOSSessionRowView.swift", anchor: ".accessibilityIdentifier(IOSSessionsAccessibility.thinking(row.id))" },
  { name: "IOSSessionRowView.swift", anchor: ".accessibilityIdentifier(IOSSessionsAccessibility.toolCall(row.id))" },
  { name: "IOSSessionRowView.swift", anchor: ".accessibilityIdentifier(IOSSessionsAccessibility.toolResult(row.id))" },
  { name: "IOSSessionRowView.swift", anchor: ".accessibilityIdentifier(IOSSessionsAccessibility.marker(row.id))" },
  { name: "IOSProjectPRView.swift", anchor: ".accessibilityIdentifier(ProjectAccessibility.prRow(index))" },
  { name: "IOSProjectPlanView.swift", anchor: ".buttonStyle(.borderless)", scope: "func feature" },
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

/** AC-11 (S-8) : l'unique défilement animé suit « Réduire les animations ». */
function motionFaults(all: Map<string, string>): string[] {
  const faults: string[] = [];
  const home = stripComments(all.get("HomeView.swift") ?? "");
  if (!home.includes("@Environment(\\.accessibilityReduceMotion) private var reduceMotion")) faults.push("HomeView.swift : accessibilityReduceMotion n'est pas lu");
  if (!home.includes("withAnimation(IOSMotion.scrollAnimation(reduceMotion: reduceMotion))")) faults.push("HomeView.swift : le défilement n'emploie pas IOSMotion.scrollAnimation(reduceMotion:)");
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
  { name: "IOSSectionView.swift", image: "Image(systemName: content.systemImage)", times: 1 },
  { name: "IOSSessionThreadView.swift", image: "Image(systemName: model.state == .waiting ? IOSSessionText.waitingSymbol", times: 1 },
  { name: "IOSSessionRowView.swift", image: "Image(systemName: IOSSessionText.chevron(isThinkingOpen))", times: 1 },
  { name: "IOSSessionRowView.swift", image: "Image(systemName: IOSSessionText.chevron(isOpen))", times: 2 },
  { name: "IOSSessionRowView.swift", image: "Image(systemName: symbol)", times: 1 },
  { name: "HomeAnswerSheet.swift", image: "Image(systemName: IOSHomeText.selectedSymbol)", times: 1 },
];

/** Les bascules du fil dont l'état de pli passe par la valeur AX (S-9). */
const FOLD_TOGGLES = ["thinking", "toolCall", "toolResult", "marker"].map(
  (kind) => `.accessibilityIdentifier(IOSSessionsAccessibility.${kind}(row.id))`,
);

/**
 * AC-12 (S-9) : chaque symbole décoratif est suivi de `.accessibilityHidden(true)`
 * à trois lignes au plus ; l'état qu'il portait est annoncé par la valeur AX
 * (bascules) ou le trait sélectionné (option de « Répondre »).
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
  const rows = stripComments(all.get("IOSSessionRowView.swift") ?? "");
  for (const anchor of FOLD_TOGGLES) {
    if (!/\.accessibilityValue\(\w+ \? KanbanText\.laneUnfolded : KanbanText\.laneFolded\)/.test(chainAround(rows, anchor))) {
      faults.push(`IOSSessionRowView.swift : ${anchor} sans état de pli annoncé`);
    }
  }
  const answer = stripComments(all.get("HomeAnswerSheet.swift") ?? "");
  if (!chainAround(answer, ".accessibilityIdentifier(IOSHomeAccessibility.answerOption(index))").includes(".accessibilityAddTraits(selectedOption == option.label ? .isSelected : [])")) {
    faults.push("HomeAnswerSheet.swift : l'option choisie n'est pas annoncée sélectionnée");
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
  "[test: graphRereadsOnEveryPassWithoutLoading]",
  "[test: refreshCommandIsListedAsActualiser]",
  `[garde: ${SLUG}/AC-4]`,
  "[test: contextMenuOffersOnlyCurrentActions]",
  "[test: copyCopiesPullRequestLinkElseMainText]",
  "[test: commandOutcomeFollowsTheMacResponse]",
  `[garde: ${SLUG}/AC-9]`,
  `[garde: ${SLUG}/AC-10]`,
  "[test: scrollJumpsWhenReduceMotionIsOn]",
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
    if (!summary.join("\n").includes("[test: summaryAvailability]")) faults.push("DESIGN.md, Mémoire : la puce « Sommaire » ne renvoie pas à summaryAvailability");
  }
  for (const stale of ["Rafraîchir", "pipelines.refresh", "ios.memoire.refresh"]) {
    if (design.includes(stale)) faults.push(`DESIGN.md : « ${stale} » encore décrit`);
  }
  return faults;
}

// MARK: - Tests

test("ios-gestes-et-retours-natifs/AC-2 : Pipelines et la liste de la Mémoire se tirent pour actualiser, aucune barre ne porte de ↻", () => {
  const all = swiftSources(APP);
  const files = () => ({
    pipelines: all.get("PipelinesScreen.swift")!,
    memory: all.get("IOSMemoryScreen.swift")!,
    model: all.get("PipelinesModel.swift")!,
    all,
  });
  assert.deepEqual(pullFaults(files()), []);

  // Faute plantée : le kanban iPad perd son tirage ⇒ rouge.
  const board = plant(files().pipelines, (s) => s.replace(`.background(Color(uiColor: .systemGroupedBackground))\n        ${PIPELINES_PULL}`, ".background(Color(uiColor: .systemGroupedBackground))"));
  assert.ok(pullFaults({ ...files(), pipelines: board }).some((f) => f.includes("func regularBoard")), "un kanban sans tirage doit rougir");

  // Faute plantée : la liste de la Mémoire perd son tirage ⇒ rouge.
  const list = plant(files().memory, (s) => s.replace(MEMORY_PULL, ""));
  assert.ok(pullFaults({ ...files(), memory: list }).some((f) => f.includes("IOSMemoryScreen.swift")), "une liste Mémoire sans tirage doit rougir");

  // Faute plantée : un ↻ remis dans la barre de Pipelines ⇒ rouge.
  const bar = plant(files().pipelines, (s) => s.replace("Label(NewFeatureText.command, systemImage: \"plus\")", "Label(NewFeatureText.command, systemImage: \"arrow.clockwise\")"));
  assert.ok(pullFaults({ ...files(), pipelines: bar }).some((f) => f.includes("arrow.clockwise")), "un ↻ de barre doit rougir");

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

test("ios-gestes-et-retours-natifs/AC-5 : cartes Pipelines et Accueil, rangées Sessions et Mémoire ont un menu contextuel natif, sans balayage", () => {
  const all = swiftSources(APP);
  for (const name of Object.keys(MENU_HOSTS)) assert.deepEqual(menuFaults(name, all.get(name)!), [], name);
  assert.deepEqual(swipeFaults(all), []);

  // Faute plantée : le menu de la rangée Sessions retiré ⇒ rouge.
  const sessions = plant(all.get("IOSSessionsScreen.swift")!, (s) => s.replace(".contextMenu {", ".overlay {"));
  assert.ok(menuFaults("IOSSessionsScreen.swift", sessions).length > 0, "une rangée Sessions sans menu doit rougir");

  // Faute plantée : un menu de carte Pipelines qui n'emprunte pas IOSContextMenu ⇒ rouge.
  const pipelines = plant(all.get("PipelinesScreen.swift")!, (s) => s.replace("IOSContextMenuItems(actions: IOSContextMenu.pipelinesCard(", "IOSContextMenuItems(actions: menuActions("));
  assert.ok(menuFaults("PipelinesScreen.swift", pipelines).some((f) => f.includes("IOSContextMenu.")), "un menu hors IOSContextMenu doit rougir");

  // Faute plantée : une rangée de l'Accueil perd son menu ⇒ rouge.
  const home = plant(all.get("HomeView.swift")!, (s) => s.replace(".contextMenu { rowMenu(card, kind: .delivered) }", ""));
  assert.ok(menuFaults("HomeView.swift", home).some((f) => f.includes("4 .contextMenu")), "une rangée de l'Accueil sans menu doit rougir");

  // Faute plantée : une action par balayage ⇒ rouge.
  const swipe = plant(all.get("IOSMemoryScreen.swift")!, (s) => s.replace(".iosHoverEffect()", ".swipeActions { EmptyView() }\n                .iosHoverEffect()"));
  assert.deepEqual(swipeFaults(withFile(all, "IOSMemoryScreen.swift", swipe)), ["IOSMemoryScreen.swift : .swipeActions"]);
});

test("ios-gestes-et-retours-natifs/AC-8 : le retour haptique suit l'issue de chaque commande, posé une seule fois par RootView", () => {
  const all = swiftSources(APP);
  const client = fs.readFileSync(CLIENT, "utf8");
  assert.deepEqual(feedbackFaults(all), []);
  assert.deepEqual(commandRouteFaults(client), []);

  // Faute plantée : un second retour, joué au toucher d'un écran ⇒ rouge.
  const second = plant(all.get("HomeView.swift")!, (s) => s.replace("@Environment(\\.accessibilityReduceMotion) private var reduceMotion", "@Environment(\\.accessibilityReduceMotion) private var reduceMotion\n    var tapFeedback: some View { EmptyView().sensoryFeedback(.success, trigger: 0) }"));
  assert.ok(feedbackFaults(withFile(all, "HomeView.swift", second)).some((f) => f.includes("HomeView.swift")), "un second .sensoryFeedback doit rougir");

  // Faute plantée : une commande qui court-circuite performCommand ⇒ rouge.
  const bypass = plant(client, (s) => s.replace("let payload = try await performCommand(\n            ClientHTTPRequest(method: \"POST\", path: \"/v1/session/stop\")", "let payload = try await perform(\n            ClientHTTPRequest(method: \"POST\", path: \"/v1/session/stop\")"));
  assert.ok(commandRouteFaults(bypass).some((f) => f.includes("/v1/session/stop")), "une commande hors performCommand doit rougir");

  // Faute plantée : la relecture des PR comptée comme commande ⇒ rouge.
  const refresh = plant(client, (s) => s.replace("try await perform(\n            ClientHTTPRequest(method: \"POST\", path: \"/v1/pull-request-states/refresh\")", "try await performCommand(\n            ClientHTTPRequest(method: \"POST\", path: \"/v1/pull-request-states/refresh\")"));
  assert.ok(commandRouteFaults(refresh).some((f) => f.includes("n'est pas une commande")), "une relecture publiée comme commande doit rougir");
});

test("ios-gestes-et-retours-natifs/AC-9 : la visionneuse, le contrat et la fiche d'un souvenir ont un texte sélectionnable", () => {
  const all = swiftSources(APP);
  assert.deepEqual(selectionFaults(all), []);

  // Faute plantée : la fiche d'un souvenir perd sa sélection ⇒ rouge.
  const detail = plant(all.get("IOSMemoryDetailView.swift")!, (s) => s.replace(".textSelection(.enabled)", ""));
  assert.ok(selectionFaults(withFile(all, "IOSMemoryDetailView.swift", detail)).some((f) => f.includes("IOSMemoryDetailView.swift : 0")), "une fiche sans sélection doit rougir");

  // Faute plantée : une seconde pose dans le contrat ⇒ rouge.
  const twice = plant(all.get("HomeContractSheet.swift")!, (s) => s.replace(".textSelection(.enabled)", ".textSelection(.enabled)\n                .textSelection(.enabled)"));
  assert.ok(selectionFaults(withFile(all, "HomeContractSheet.swift", twice)).some((f) => f.includes("HomeContractSheet.swift : 2")), "deux poses doivent rougir");
});

test("ios-gestes-et-retours-natifs/AC-10 : chaque carte et rangée touchable porte le survol natif d'iPad", () => {
  const all = swiftSources(APP);
  assert.deepEqual(hoverFaults(all), []);

  // Faute plantée : la rangée Mémoire perd son survol ⇒ rouge.
  const memory = plant(all.get("IOSMemoryScreen.swift")!, (s) => s.replace(".iosHoverEffect()", ""));
  assert.ok(hoverFaults(withFile(all, "IOSMemoryScreen.swift", memory)).some((f) => f.includes("IOSMemoryAccessibility.row")), "une rangée sans survol doit rougir");

  // Faute plantée : la rangée de plan perd son survol ⇒ rouge.
  const plan = plant(all.get("IOSProjectPlanView.swift")!, (s) => s.replace(".iosHoverEffect()", ""));
  assert.ok(hoverFaults(withFile(all, "IOSProjectPlanView.swift", plan)).some((f) => f.includes("IOSProjectPlanView.swift")), "une rangée de plan sans survol doit rougir");

  // Faute plantée : le modificateur ne pose plus l'effet système ⇒ rouge.
  const surfaceName = path.join("Design", "IOSSurface.swift");
  const surface = plant(all.get(surfaceName)!, (s) => s.replace(".hoverEffect(.highlight)", ".hoverEffect(.lift)"));
  assert.ok(hoverFaults(withFile(all, surfaceName, surface)).some((f) => f.includes(".hoverEffect(.highlight)")), "un autre effet doit rougir");
});

test("ios-gestes-et-retours-natifs/AC-11 : le défilement automatique de l'Accueil suit Réduire les animations", () => {
  const all = swiftSources(APP);
  assert.deepEqual(motionFaults(all), []);

  // Faute plantée : le défilement redevient toujours animé ⇒ rouge.
  const home = plant(all.get("HomeView.swift")!, (s) => s.replace("withAnimation(IOSMotion.scrollAnimation(reduceMotion: reduceMotion))", "withAnimation(.default)"));
  const faults = motionFaults(withFile(all, "HomeView.swift", home));
  assert.ok(faults.some((f) => f.includes("withAnimation hors")), "une animation forcée doit rougir");

  // Faute plantée : une animation nue ailleurs ⇒ rouge.
  const pipelines = plant(all.get("PipelinesScreen.swift")!, (s) => s.replace("unfoldedLanes.formSymmetricDifference([row.lane])", "withAnimation { unfoldedLanes.formSymmetricDifference([row.lane]) }"));
  assert.ok(motionFaults(withFile(all, "PipelinesScreen.swift", pipelines)).some((f) => f.startsWith("PipelinesScreen.swift")), "un withAnimation nu doit rougir");
});

test("ios-gestes-et-retours-natifs/AC-12 : les symboles décoratifs sont masqués à VoiceOver, l'état qu'ils portaient est annoncé", () => {
  const all = swiftSources(APP);
  assert.deepEqual(symbolFaults(all), []);

  // Faute plantée : l'icône d'un état de section redevient lue ⇒ rouge.
  const section = plant(all.get("IOSSectionView.swift")!, (s) => s.replace(".accessibilityHidden(true)", ""));
  assert.ok(symbolFaults(withFile(all, "IOSSectionView.swift", section)).some((f) => f.includes("lu par VoiceOver")), "un symbole lu doit rougir");

  // Faute plantée : une bascule du fil sans état de pli ⇒ rouge.
  const rows = plant(all.get("IOSSessionRowView.swift")!, (s) => s.replace(".accessibilityValue(isThinkingOpen ? KanbanText.laneUnfolded : KanbanText.laneFolded)", ""));
  assert.ok(symbolFaults(withFile(all, "IOSSessionRowView.swift", rows)).some((f) => f.includes("thinking")), "une bascule muette doit rougir");

  // Faute plantée : l'option choisie de « Répondre » n'a plus son trait ⇒ rouge.
  const answer = plant(all.get("HomeAnswerSheet.swift")!, (s) => s.replace(".accessibilityAddTraits(selectedOption == option.label ? .isSelected : [])", ""));
  assert.ok(symbolFaults(withFile(all, "HomeAnswerSheet.swift", answer)).some((f) => f.includes("sélectionnée")), "une option choisie muette doit rougir");
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

// MARK: - AC-14 : recette de captures avant/après

const RECIPE = path.join(ROOT, "scripts", "recette", "ios-gestes-retours-recette.sh");

/** Les jetons qu'une recette privée, signée, avant/après et pilotée par idb doit porter (S-11). */
const RECIPE_TOKENS = [
  "simctl create",
  "simctl delete",
  "zz-gestes-tel",
  "zz-gestes-tab",
  "CODE_SIGN_IDENTITY=-",
  "codesign -dv",
  "--avant",
  "trap cleanup EXIT",
  "preuve.md",
  "describe-point",
  '"idb", "ui", "swipe"',
  '"--duration", LONG_PRESS',
  '"--command", "21"',
];

/** Les lancements de la matrice (BR-7) : crochets de recette existants. */
const RECIPE_LAUNCHES = [
  ["kanban", "-pipelines.board", "marques"],
  ["memory", "-memoire.recipe", "clavier"],
  ["memory", "-memoire.recipe", "graphe"],
  ["home", "-home.recipe", "dashboard"],
  ["sessions", "-sessions.recipe", "liste"],
  ["sessions", "-sessions.recipe", "visionneuse"],
  ["home", "-home.recipe", "contract"],
  ["memory", "-memoire.recipe", "fiche"],
  ["sessions", "-sessions.recipe", "fil-vide"],
  ["home", "-home.recipe", "answer"],
].map(([section, flag, value]) => `("-section", "${section}", "${flag}", "${value}")`);

/** Les critères contrôlés en après, et les constats S-1 re-mesurés en avant (AC-1). */
const RECIPE_CRITERIA = [2, 3, 4, 5, 9, 12, 13];
const RECIPE_CONSTATS = ["1", "2", "3", "4", "6", "7", "10b", "11"];

/** Ce qui volerait le focus du Mac, toucherait l'app Mac de l'utilisateur ou fusionnerait la PR. */
const RECIPE_FORBIDDEN = ["open -a", "OMP Console", "osascript", "run-console.sh", "gh pr merge"];

/**
 * AC-14 (S-11) : la recette crée puis supprime ses simulateurs privés, compile une
 * app signée, pilote l'app par simctl et idb seulement, émet une ligne par
 * critère contrôlé et par constat re-mesuré, et ne touche ni au focus du Mac,
 * ni à l'app Mac, ni à la fusion de la PR (même en commentaire).
 */
function recipeScriptFaults(script: string): string[] {
  const faults: string[] = [];
  const code = stripHashComments(script);
  for (const token of [...RECIPE_TOKENS, ...RECIPE_LAUNCHES]) {
    if (!code.includes(token)) faults.push(`recette : jeton absent hors commentaire « ${token} »`);
  }
  for (const n of RECIPE_CRITERIA) {
    if (!code.includes(`"AC-${n}"`)) faults.push(`recette : aucune ligne AC-${n}`);
  }
  for (const c of RECIPE_CONSTATS) {
    if (!code.includes(`"CONSTAT-${c}"`)) faults.push(`recette : aucune ligne CONSTAT-${c}`);
  }
  for (const token of RECIPE_FORBIDDEN) {
    if (script.includes(token)) faults.push(`recette : « ${token} » interdit`);
  }
  if (code.includes("Simulator.app")) faults.push("recette : Simulator.app hors commentaire");
  return faults;
}

test("ios-gestes-et-retours-natifs/AC-14 : DESIGN.md décrit les gestes et retours natifs, chaque puce marquée, et la recette avant/après tourne sur des simulateurs privés supprimés", () => {
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

  // Faute plantée : le ↻ « Rafraîchir » de Pipelines revient ⇒ rouge.
  const stale = plant(design, (s) => s.replace("« Nouvelle feature… » (`NewFeatureText.command`)", "« Rafraîchir » (`KanbanText.refresh`), « Nouvelle feature… » (`NewFeatureText.command`)"));
  assert.ok(designFaults(stale).some((f) => f.includes("Rafraîchir")), "« Rafraîchir » doit rougir");

  const script = fs.readFileSync(RECIPE, "utf8");
  assert.deepEqual(recipeScriptFaults(script), []);

  // Faute plantée : la recette ne supprime plus ses simulateurs ⇒ rouge.
  const kept = plant(script, (s) => s.replaceAll("simctl delete", "simctl shutdown"));
  assert.ok(recipeScriptFaults(kept).some((f) => f.includes("simctl delete")), "des simulateurs conservés doivent rougir");

  // Faute plantée : la construction n'est plus signée ⇒ rouge.
  const unsigned = plant(script, (s) => s.replace("CODE_SIGN_IDENTITY=- ", ""));
  assert.ok(recipeScriptFaults(unsigned).some((f) => f.includes("CODE_SIGN_IDENTITY=-")), "une app non signée doit rougir");

  // Faute plantée : le contrôle AC-13 disparaît (ne reste qu'en commentaire) ⇒ rouge.
  const noSummary = plant(script, (s) => s.replaceAll('"AC-13"', '"AC-X"') + '\n# "AC-13"\n');
  assert.ok(recipeScriptFaults(noSummary).some((f) => f.includes("AC-13")), "un AC-13 non contrôlé doit rougir");

  // Faute plantée : un menu sort de la matrice ⇒ rouge.
  const noMenu = plant(script, (s) => s.replace('("-section", "sessions", "-sessions.recipe", "liste")', '("-section", "sessions")'));
  assert.ok(recipeScriptFaults(noMenu).some((f) => f.includes("liste")), "une surface absente doit rougir");

  // Faute plantée : le Simulateur au premier plan, l'app Mac relancée, la PR fusionnée ⇒ rouge, même en commentaire.
  for (const intrusion of ['open -a Simulator --args -CurrentDeviceUDID "$iphone"', 'open "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"', "# bash scripts/run-console.sh", "# gh pr merge --squash"]) {
    const intrusive = plant(script, (s) => s.replace("trap cleanup EXIT", `trap cleanup EXIT\n${intrusion}`));
    assert.ok(recipeScriptFaults(intrusive).length > 0, `« ${intrusion} » doit rougir`);
  }

  // Simulator.app cité en commentaire reste admis (le script explique ce qu'il ne fait pas).
  assert.deepEqual(recipeScriptFaults(script.replace("trap cleanup EXIT", "# Simulator.app n'est jamais lancé.\ntrap cleanup EXIT")), []);
});
