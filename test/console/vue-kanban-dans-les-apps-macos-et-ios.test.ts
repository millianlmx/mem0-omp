// Les GARDES TEXTUELLES de la feature `vue-kanban-dans-les-apps-macos-et-ios` (le Tableau des fils
// dans les apps macOS et iOS) : un test par critère `vue-kanban-dans-les-apps-macos-et-ios/AC-<n>`,
// et c'est le SEUL fichier qui porte ce slug (invariant `criteria/AC-13`).
//
// Les tests Swift (`OSBoardTests`, `IOSOSBoardTests`, `ConsoleSobrietyTests`) prouvent la logique
// pure ; ces gardes fixent ce que le runner Linux peut lire : le tableau est câblé dans les deux
// coques, il ne lit rien du serveur, ne porte aucun glisser-déposer, lit ses cartes comme un seul
// élément VoiceOver, et les recettes de capture l'ouvrent. Fonctions pures sur le texte source,
// commentaires retirés ; chaque faute est plantée EN MÉMOIRE : aucune copie du dépôt.
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { braceBlock, memberBody, readIfExists, stripComments, stripHashComments } from "../support/swift-source.ts";

const CONSOLE = path.join(ROOT, "omp-console");
const VIEW_FILE = path.join(CONSOLE, "Sources", "ConsoleUI", "OS", "OSBoardView.swift");
const LIST_FILE = path.join(CONSOLE, "Sources", "ConsoleUI", "OS", "OSThreadList.swift");
const MAC_ROOT_FILE = path.join(CONSOLE, "Sources", "OMPConsole", "OS", "OSRootView.swift");
const PAGE_FILE = path.join(CONSOLE, "ios", "OMPConsoleIOS", "IOSOSBoardPage.swift");
const IOS_ROOT_FILE = path.join(CONSOLE, "ios", "OMPConsoleIOS", "IOSOSRootView.swift");
const MAC_SHOTS_FILE = path.join(ROOT, "scripts", "recette", "os-shots.sh");
const IOS_SHOTS_FILE = path.join(ROOT, "scripts", "recette", "os-ios-shots.sh");

const swift = (file: string) => stripComments(readIfExists(file));
const shell = (file: string) => stripHashComments(readIfExists(file));

/** La faute plantée doit changer le source, sinon elle ne prouve rien. */
function plant(source: string, from: string | RegExp, to: string): string {
  const after = source.replace(from, to);
  assert.notEqual(after, source, `la faute plantée n'a rien changé (${String(from)})`);
  return after;
}

const squeeze = (code: string) => code.replace(/\s+/g, "");

// ---------------------------------------------------------------- AC-12 : aucune lecture

/** Ce que le tableau ne doit jamais faire : lancer une lecture ; il range les fils qu'on lui passe. */
function boardFaults(view: string, page: string): string[] {
  const faults: string[] = [];
  if (view.trim() === "") faults.push("OSBoardView.swift : absent");
  for (const [name, pattern] of [
    [".task", /\.task\b/],
    [".onAppear", /\.onAppear\b/],
    [".refreshable", /\.refreshable\b/],
    ["await server.", /await\s+server\./],
    [".refresh()", /\.refresh\(\)/],
  ] as const) {
    if (pattern.test(view)) faults.push(`OSBoardView.swift : ${name}`);
  }
  if (!/let threads: \[OSThread\]/.test(view)) faults.push("OSBoardView.swift : sans « let threads: [OSThread] »");

  if (page.trim() === "") faults.push("IOSOSBoardPage.swift : absent");
  for (const [name, pattern] of [
    [".task", /\.task\b/],
    [".onAppear", /\.onAppear\b/],
    [".onChange(", /\.onChange\(/],
    [".onReceive(", /\.onReceive\(/],
    ["await server.", /await\s+server\./],
    [".refresh()", /\.refresh\(\)/],
  ] as const) {
    if (pattern.test(page)) faults.push(`IOSOSBoardPage.swift : ${name}`);
  }
  return faults;
}

test("vue-kanban-dans-les-apps-macos-et-ios/AC-12 : ouvrir le tableau ne lance aucune lecture", () => {
  const view = swift(VIEW_FILE);
  const page = swift(PAGE_FILE);
  assert.deepEqual(boardFaults(view, page), []);

  const inView = (from: string | RegExp, to: string) => boardFaults(plant(view, from, to), page);
  const inPage = (from: string | RegExp, to: string) => boardFaults(view, plant(page, from, to));
  const viewAnchor = ".consoleID(\"os.board\")";
  const pageAnchor = ".accessibilityElement(children: .contain)";
  const has = (faults: string[], needle: string) => faults.some((f) => f.includes(needle));

  assert.ok(has(inView(viewAnchor, `${viewAnchor}\n.task { }`), ".task"));
  assert.ok(has(inView(viewAnchor, `${viewAnchor}\n.onAppear { }`), ".onAppear"));
  assert.ok(has(inView(viewAnchor, `${viewAnchor}\n.refreshable { }`), ".refreshable"));
  assert.ok(has(inView(viewAnchor, `${viewAnchor}\n.onAppear { await server.load() }`), "await server."));
  assert.ok(has(inView(viewAnchor, `${viewAnchor}\n.onAppear { drafts.refresh() }`), ".refresh()"));
  assert.ok(
    has(inView("let threads: [OSThread]", "@State private var threads: [OSThread] = []"), "let threads: [OSThread]"),
  );
  assert.ok(has(boardFaults("", page), "absent"));

  assert.ok(has(inPage(pageAnchor, `${pageAnchor}\n.task { await reload() }`), ".task"));
  assert.ok(has(inPage(pageAnchor, `${pageAnchor}\n.onAppear { Task { await server.refresh() } }`), ".onAppear"));
  assert.ok(has(inPage(pageAnchor, `${pageAnchor}\n.onChange(of: loaded) { Task { await reload() } }`), ".onChange("));
  assert.ok(
    has(inPage(pageAnchor, `${pageAnchor}\n.onReceive(server.$failure) { _ in Task { await reload() } }`), ".onReceive("),
  );
  assert.ok(has(boardFaults(view, ""), "absent"));
  // `.refreshable { await reload() }` et l'action ⌘R de la page restent permis.
  assert.deepEqual(boardFaults(view, page), []);
});

// ---------------------------------------------------------------- AC-10 : lecture seule

const DRAG = [".draggable(", ".dropDestination(", ".onDrag(", ".onDrop(", ".contextMenu"];

function dragFaults(source: string): string[] {
  if (source.trim() === "") return ["OSBoardView.swift : absent"];
  return DRAG.filter((token) => source.includes(token)).map((token) => `OSBoardView.swift : ${token}`);
}

test("vue-kanban-dans-les-apps-macos-et-ios/AC-10 : le tableau ne porte aucun geste d'écriture", () => {
  const view = swift(VIEW_FILE);
  assert.deepEqual(dragFaults(view), []);
  const anchor = ".consoleID(\"os.board\")";
  for (const token of DRAG) {
    const faults = dragFaults(plant(view, anchor, `${anchor}\n${token}`));
    assert.ok(
      faults.some((f) => f.includes(token)),
      `${token} doit rougir : ${JSON.stringify(faults)}`,
    );
  }
  assert.ok(dragFaults("").length > 0);
});

// ---------------------------------------------------------------- AC-20 : une carte, un élément VoiceOver

function voiceOverFaults(source: string): string[] {
  const at = source.indexOf("struct OSBoardCard");
  if (at < 0) return ["OSBoardView.swift : struct OSBoardCard absente"];
  const card = braceBlock(source, source.indexOf("{", at));
  const faults: string[] = [];
  if (!card.includes(".accessibilityElement(children: .ignore)"))
    faults.push("OSBoardCard : sans .accessibilityElement(children: .ignore)");
  if (!card.includes(".accessibilityLabel(OSBoard.cardLabel("))
    faults.push("OSBoardCard : sans .accessibilityLabel(OSBoard.cardLabel(");
  return faults;
}

test("vue-kanban-dans-les-apps-macos-et-ios/AC-20 : une carte est un seul élément VoiceOver", () => {
  const view = swift(VIEW_FILE);
  assert.deepEqual(voiceOverFaults(view), []);
  const cardAt = view.indexOf("struct OSBoardCard");
  const head = view.slice(0, cardAt);
  const card = view.slice(cardAt);
  const noGroup = head + plant(card, ".accessibilityElement(children: .ignore)", "");
  assert.ok(voiceOverFaults(noGroup).some((f) => f.includes("children: .ignore")));
  const noLabel = head + plant(card, ".accessibilityLabel(OSBoard.cardLabel(thread))", "");
  assert.ok(voiceOverFaults(noLabel).some((f) => f.includes("cardLabel")));
  assert.ok(voiceOverFaults("").length > 0);
});

// ---------------------------------------------------------------- AC-1 : l'entrée de la barre latérale

function sidebarFaults(list: string, root: string): string[] {
  const faults: string[] = [];
  const board = list.indexOf(".tag(OSWorkspace.board)");
  const system = list.indexOf(".tag(OSWorkspace.system)");
  if (board < 0) faults.push("OSThreadList.swift : sans .tag(OSWorkspace.board)");
  else if (system < 0 || board < system) faults.push("OSThreadList.swift : Tableau avant Système (ou Système absent)");
  const branch = root.indexOf("workspace.selection == OSWorkspace.board");
  const view = root.indexOf("OSBoardView(");
  if (branch < 0 || view < branch) faults.push("OSRootView.swift : OSBoardView( hors de la branche du Tableau");
  return faults;
}

test("vue-kanban-dans-les-apps-macos-et-ios/AC-1 : « Tableau » ferme les entrées fixes et montre le tableau", () => {
  const list = swift(LIST_FILE);
  const root = swift(MAC_ROOT_FILE);
  assert.deepEqual(sidebarFaults(list, root), []);

  // L'entrée remontée avant Système.
  const moved = list
    .replace(/\s*Label\(OSText\.board[^\n]*\n\s*\.tag\(OSWorkspace\.board\)/, "")
    .replace("Label(OSSystemText.title", "Label(OSText.board, systemImage: \"x\").tag(OSWorkspace.board)\nLabel(OSSystemText.title");
  assert.notEqual(moved, list);
  assert.ok(sidebarFaults(moved, root).some((f) => f.includes("avant Système")));

  // La branche retirée.
  const unbranched = plant(root, "workspace.selection == OSWorkspace.board", "workspace.selection == OSWorkspace.knowledge");
  assert.ok(sidebarFaults(list, unbranched).some((f) => f.includes("OSBoardView(")));
  assert.ok(sidebarFaults("", root).length > 0);
});

// ---------------------------------------------------------------- AC-13 : la même portée que la liste

const SCOPE = squeeze("threads: OSThreadScope.threads(threads, spaceId: workspace.spaceId, place: workspace.place,");

/** Le premier `threads:` qui suit `opener` : les fils restreints par l'espace et le lieu, comme la liste. */
function scopeFault(source: string, opener: string, name: string): string | null {
  const flat = squeeze(source);
  const at = flat.indexOf(squeeze(opener));
  if (at < 0) return `${name} : ${opener} absent`;
  const arg = flat.indexOf("threads:", at);
  if (arg < 0 || !flat.startsWith(SCOPE, arg)) return `${name} : threads: sans OSThreadScope.threads(…spaceId, place)`;
  return null;
}

function scopeFaults(mac: string, ios: string): string[] {
  return [
    scopeFault(mac, "OSBoardView(", "OSRootView.swift"),
    scopeFault(ios, "IOSOSBoardPage(", "IOSOSRootView.swift"),
  ].filter((fault): fault is string => fault !== null);
}

test("vue-kanban-dans-les-apps-macos-et-ios/AC-13 : le tableau reçoit les fils restreints comme la liste", () => {
  const mac = swift(MAC_ROOT_FILE);
  const ios = swift(IOS_ROOT_FILE);
  assert.deepEqual(scopeFaults(mac, ios), []);

  const macRaw = plant(mac, /OSBoardView\(\s*threads: OSThreadScope\.threads\(threads,/, "OSBoardView(threads: threads, x: OSThreadScope.threads(threads,");
  assert.ok(scopeFaults(macRaw, ios).some((f) => f.startsWith("OSRootView.swift")));
  const iosRaw = plant(ios, /threads: OSThreadScope\.threads\(threads, spaceId: workspace\.spaceId, place: workspace\.place, spaces: spaces\.spaces\),\s*loaded: loaded/, "threads: threads, loaded: loaded");
  assert.ok(scopeFaults(mac, iosRaw).some((f) => f.startsWith("IOSOSRootView.swift")));
  assert.ok(scopeFaults(plant(mac, "OSBoardView(", "OSBoardViewX("), ios).length > 0);
  assert.ok(scopeFaults(mac, plant(ios, "IOSOSBoardPage(", "IOSOSBoardPageX(")).length > 0);
});

// ---------------------------------------------------------------- AC-25 : le tableau attend le regroupement

const OPENING = ["await server.readShell(.opening)", "await threadStore.settled()", "loaded = true"];

/** `readShell(.opening)`, puis `settled()`, puis `loaded = true`, dans cet ordre. */
function orderFault(body: string, name: string): string | null {
  let from = 0;
  for (const step of OPENING) {
    const at = body.indexOf(step, from);
    if (at < 0) return `${name} : « ${step} » absent ou hors d'ordre`;
    from = at + step.length;
  }
  return null;
}

function openingFaults(mac: string, ios: string): string[] {
  const macTask = memberBody(mac, ".task(id: server.address)");
  return [
    orderFault(macTask, "OSRootView.swift"),
    orderFault(memberBody(ios, "private func load()"), "IOSOSRootView.swift load()"),
  ].filter((fault): fault is string => fault !== null);
}

test("vue-kanban-dans-les-apps-macos-et-ios/AC-25 : loaded est posé après readShell puis settled()", () => {
  const mac = swift(MAC_ROOT_FILE);
  const ios = swift(IOS_ROOT_FILE);
  assert.deepEqual(openingFaults(mac, ios), []);

  const swap = (source: string) =>
    plant(source, /await threadStore\.settled\(\)(\s*)loaded = true/, "loaded = true$1await threadStore.settled()");
  assert.ok(openingFaults(swap(mac), ios).some((f) => f.startsWith("OSRootView.swift")));
  assert.ok(openingFaults(mac, swap(ios)).some((f) => f.startsWith("IOSOSRootView.swift")));

  const without = (source: string) => plant(source, /\n\s*await threadStore\.settled\(\)/, "");
  assert.ok(openingFaults(without(mac), ios).some((f) => f.startsWith("OSRootView.swift")));
  assert.ok(openingFaults(mac, without(ios)).some((f) => f.startsWith("IOSOSRootView.swift")));
  assert.ok(openingFaults("", ios).length > 0);
});

// ---------------------------------------------------------------- AC-23 : les recettes de capture

const MAC_SHOT = 'shot tableau "OMP_CONSOLE_OS_VIEW=board"';
const IOS_TOKENS = [
  "-os.board",
  "tableau-ax",
  "accessibility-extra-extra-extra-large",
  '"24"',
  'if [ "$width" -ge "$height" ]',
];

function recipeFaults(mac: string, ios: string): string[] {
  const faults: string[] = [];
  if (!mac.includes(MAC_SHOT)) faults.push(`os-shots.sh : sans « ${MAC_SHOT} »`);
  for (const token of IOS_TOKENS) {
    if (!ios.includes(token)) faults.push(`os-ios-shots.sh : sans « ${token} »`);
  }
  for (const [name, source] of [
    ["os-shots.sh", mac],
    ["os-ios-shots.sh", ios],
  ] as const) {
    if (/["']kanban["']/.test(source)) faults.push(`${name} : littéral « kanban » (garde coque-ios)`);
  }
  return faults;
}

test("vue-kanban-dans-les-apps-macos-et-ios/AC-23 : les recettes capturent le tableau, à deux tailles de texte", () => {
  const mac = shell(MAC_SHOTS_FILE);
  const ios = shell(IOS_SHOTS_FILE);
  assert.deepEqual(recipeFaults(mac, ios), []);

  assert.ok(recipeFaults(plant(mac, MAC_SHOT, "shot tableau"), ios).some((f) => f.startsWith("os-shots.sh")));
  for (const token of IOS_TOKENS) {
    const faults = recipeFaults(mac, ios.split(token).join(""));
    assert.ok(
      faults.some((f) => f.includes(token)),
      `${token} doit rougir : ${JSON.stringify(faults)}`,
    );
  }
  assert.ok(recipeFaults(mac, `${ios}\nshot x y "kanban"`).some((f) => f.includes("kanban")));
  assert.ok(recipeFaults(mac, `${ios}\nshot x y 'kanban'`).some((f) => f.includes("kanban")));
});
