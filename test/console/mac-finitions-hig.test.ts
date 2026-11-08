// Les GARDES TEXTUELLES de la feature `mac-finitions-hig` : un test par critère
// `mac-finitions-hig/AC-<n>` prouvé par le source, et c'est le SEUL fichier qui
// porte ce slug (invariant `criteria/AC-13`).
//
// AC-1 est prouvé par `omp-console/Tests/OMPConsoleTests/MainMenuSeparatorsTests.swift`
// (Swift Testing) et par la lecture AX des menus d'une instance de recette
// (`omp-console/build/mac-finitions-hig/{avant,apres}/menus.txt`). Ce fichier éprouve
// le source sans compiler de Swift : tout ce qui doit ÉCHOUER se plante dans une
// COPIE JETABLE de la coque Mac.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { stripFullLineComments, swiftSources } from "../support/swift-source.ts";

const MAC_REL = path.join("omp-console", "Sources", "OMPConsole");

/** Chaque `.swift` de la coque Mac sous `root`, sans commentaires, par chemin relatif à `root`. */
function sources(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const [rel, source] of swiftSources(path.join(root, MAC_REL), root))
    files.set(rel, stripFullLineComments(source));
  return files;
}

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Une copie jetable de la coque Mac (sources seulement), à muter. */
function copyMac(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "mac-finitions-hig-")));
  dirs.push(dir);
  fs.cpSync(path.join(ROOT, MAC_REL), path.join(dir, MAC_REL), { recursive: true });
  return dir;
}

function mutate(root: string, rel: string, change: (source: string) => string): void {
  const file = path.join(root, MAC_REL, rel);
  const before = fs.readFileSync(file, "utf8");
  const after = change(before);
  assert.notEqual(after, before, `la faute plantée n'a rien changé dans ${rel}`);
  fs.writeFileSync(file, after);
}

/** Le corps d'un bloc ouvert par `opener` jusqu'à la première ligne `closer` (indentation comprise). */
function block(source: string, opener: RegExp, closer: string): string | undefined {
  const start = source.search(opener);
  if (start < 0) return undefined;
  const end = source.indexOf(closer, start);
  return end < 0 ? undefined : source.slice(start, end + closer.length);
}

const MEMORY_VIEW = path.join("Memory", "MemoryView.swift");

/** AC-3 : « Sommaire » porte `rectangle.stack`, et la bascule « Liste » un autre symbole. */
function memorySymbolFaults(root: string): string[] {
  const source = sources(root).get(path.join(MAC_REL, MEMORY_VIEW)) ?? "";
  const summary = /Label\(\s*MemoryText\.summaryButton\s*,\s*systemImage:\s*"([^"]+)"/.exec(source)?.[1];
  const list = /graph\.shown\s*\?\s*MemoryText\.listButton[\s\S]*?systemImage:\s*graph\.shown\s*\?\s*"([^"]+)"/.exec(
    source,
  )?.[1];
  const faults: string[] = [];
  if (summary !== "rectangle.stack")
    faults.push(`« Sommaire » porte ${summary ?? "aucun symbole"}, attendu rectangle.stack`);
  if (list === undefined) faults.push("symbole de « Liste » introuvable");
  else if (list === summary) faults.push(`« Liste » et « Sommaire » partagent ${list}`);
  return faults;
}

test("mac-finitions-hig/AC-3 : Mémoire — « Liste » et « Sommaire » ont deux symboles distincts", () => {
  assert.deepEqual(memorySymbolFaults(ROOT), []);

  // Faute plantée : « Sommaire » repris par `list.bullet` ⇒ rouge.
  const copy = copyMac();
  mutate(copy, MEMORY_VIEW, (s) => s.replace('systemImage: "rectangle.stack"', 'systemImage: "list.bullet"'));
  assert.ok(memorySymbolFaults(copy).length > 0, "« Sommaire » en list.bullet doit rougir");
});

const HARNESS_VIEWS = path.join("Server", "HarnessSectionViews.swift");

/**
 * AC-5 : les commandes du serveur ne se répètent dans aucune section : « Actualiser »
 * est la commande de menu ⌘R (`RefreshCommands`, nourrie par la section affichée via
 * `\.harnessRefresh`), et la feuille du serveur s'ouvre depuis le pied de la barre
 * latérale (`server.open`, une seule fois) — ou depuis Système › Serveur.
 */
function serverToolbarFaults(root: string): string[] {
  const all = sources(root);
  const faults: string[] = [];
  const app = all.get(path.join(MAC_REL, "OMPConsoleApp.swift")) ?? "";
  const commands = block(app, /struct RefreshCommands: Commands \{/, "\n}\n");
  if (
    commands === undefined ||
    !commands.includes("@FocusedValue(\\.harnessRefresh)") ||
    !commands.includes('.keyboardShortcut("r", modifiers: .command)')
  )
    faults.push("RefreshCommands ne porte pas « Actualiser » ⌘R, nourri par \\.harnessRefresh");
  const frame = all.get(path.join(MAC_REL, HARNESS_VIEWS)) ?? "";
  if (!frame.includes(".focusedSceneValue(\\.harnessRefresh,"))
    faults.push("HarnessSection ne publie pas sa relecture pour ⌘R (\\.harnessRefresh)");
  for (const marker of ['"server.refresh"', '"server.open"']) {
    let inSections = 0;
    for (const [rel, text] of all)
      if (rel.startsWith(path.join(MAC_REL, "Server"))) inSections += text.split(marker).length - 1;
    if (inSections !== 0) faults.push(`${marker} apparaît ${inSections} fois dans les vues du serveur`);
  }
  const sidebar = all.get(path.join(MAC_REL, "ConsoleRootView.swift")) ?? "";
  const opens = sidebar.split('"server.open"').length - 1;
  if (opens !== 1) faults.push(`"server.open" apparaît ${opens} fois dans la barre latérale (attendu 1, son pied)`);
  return faults;
}

test("mac-finitions-hig/AC-5 : Pilotage — « Actualiser » est la commande ⌘R et le serveur s'ouvre du pied de la barre latérale, jamais d'une section", () => {
  assert.deepEqual(serverToolbarFaults(ROOT), []);

  // Faute plantée : le bouton « Serveur » recopié dans la barre d'une section ⇒ rouge.
  const copy = copyMac();
  mutate(copy, HARNESS_VIEWS, (s) =>
    s.replace(
      ".focusedSceneValue(\\.harnessRefresh,",
      '.toolbar { Button("x") {}.accessibilityIdentifier("server.open") }\n        .focusedSceneValue(\\.harnessRefresh,',
    ),
  );
  assert.ok(
    serverToolbarFaults(copy).some((f) => f.includes('"server.open"')),
    "un bouton server.open dans une section doit rougir",
  );
});

/** Le porteur décoratif de l'Accueil (S-6 R1) : le symbole de l'appel à relier le serveur. */
const DECORATIVE: { rel: string; marker: string; container?: string }[] = [
  { rel: HARNESS_VIEWS, marker: 'Image(systemName: "server.rack")' },
];

/** Les lignes de modificateurs (`.xxx`) qui suivent la ligne de `end` (fin de l'expression porteuse). */
function trailingModifiers(source: string, end: number): string {
  const lines = source.slice(end).split("\n").slice(1);
  const modifiers: string[] = [];
  for (const line of lines) {
    if (!line.trimStart().startsWith(".")) break;
    modifiers.push(line.trim());
  }
  return modifiers.join("\n");
}

/** La fin (index du `}` fermant) du bloc `opener` le plus proche avant `at`. */
function enclosingBlockEnd(source: string, opener: string, at: number): number | undefined {
  const start = source.lastIndexOf(opener, at);
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start + opener.length - 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i;
  }
  return undefined;
}

/** AC-7 : chaque symbole décoratif de l'Accueil porte `.accessibilityHidden(true)` avant la fin de son expression. */
function decorativeFaults(root: string): string[] {
  const all = sources(root);
  const faults: string[] = [];
  for (const { rel, marker, container } of DECORATIVE) {
    const source = all.get(path.join(MAC_REL, rel)) ?? "";
    const at = source.indexOf(marker);
    if (at < 0) {
      faults.push(`${marker} introuvable dans ${rel}`);
      continue;
    }
    const end = container === undefined ? at : enclosingBlockEnd(source, container, at);
    if (end === undefined) {
      faults.push(`${container} autour de ${marker} introuvable`);
      continue;
    }
    if (!trailingModifiers(source, end).includes(".accessibilityHidden(true)")) {
      faults.push(`${container ?? marker} sans .accessibilityHidden(true)`);
    }
  }
  return faults;
}

test("mac-finitions-hig/AC-7 : Accueil Mac — les symboles décoratifs sont muets pour VoiceOver, leurs textes restent annoncés", () => {
  assert.deepEqual(decorativeFaults(ROOT), []);

  // Faute plantée : le symbole de l'appel à relier perd le modificateur ⇒ rouge.
  const copy = copyMac();
  mutate(copy, HARNESS_VIEWS, (s) =>
    s.replace(
      /(Image\(systemName: "server\.rack"\)\n\s*\.font\(\.largeTitle\)\n\s*\.foregroundStyle\(\.secondary\))\n\s*\.accessibilityHidden\(true\)/,
      "$1",
    ),
  );
  assert.deepEqual(decorativeFaults(copy), ['Image(systemName: "server.rack") sans .accessibilityHidden(true)']);
});
