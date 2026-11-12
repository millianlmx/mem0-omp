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

const SOURCES_REL = path.join("omp-console", "Sources");

/** Chaque `.swift` des sources Swift sous `root` (coque Mac et vues partagées), sans commentaires, par chemin relatif à `root`. */
function sources(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const [rel, source] of swiftSources(path.join(root, SOURCES_REL), root))
    files.set(rel, stripFullLineComments(source));
  return files;
}

/** Le source sans commentaires de `rel` (relatif à `omp-console/Sources`). */
function source(all: Map<string, string>, rel: string): string {
  return all.get(path.join(SOURCES_REL, rel)) ?? "";
}

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Une copie jetable des sources Swift, à muter. */
function copyMac(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "mac-finitions-hig-")));
  dirs.push(dir);
  fs.cpSync(path.join(ROOT, SOURCES_REL), path.join(dir, SOURCES_REL), { recursive: true });
  return dir;
}

function mutate(root: string, rel: string, change: (source: string) => string): void {
  const file = path.join(root, SOURCES_REL, rel);
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

const MEMORY_VIEW = path.join("OMPConsole", "Memory", "MemoryView.swift");

/** AC-3 : « Sommaire » porte `rectangle.stack`, et la bascule « Liste » un autre symbole. */
function memorySymbolFaults(root: string): string[] {
  const source = sources(root).get(path.join(SOURCES_REL, MEMORY_VIEW)) ?? "";
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

const ROOT_VIEW = path.join("OMPConsole", "OS", "OSRootView.swift");
const SYSTEM_SCREENS = path.join("OMPConsole", "OS", "OSSystemScreens.swift");
const SYSTEM_HUB = path.join("ConsoleUI", "OS", "OSSystemHub.swift");

/**
 * AC-5 : les commandes du serveur ne se répètent sur aucun écran : « Actualiser »
 * est la commande de menu ⌘R (`RefreshCommands`, nourrie par la racine de l'OS via
 * `\.harnessRefresh`), et la feuille du serveur s'ouvre de la tuile Système › Serveur
 * (ou de ⌘K), jamais d'un bouton `server.refresh`/`server.open` dans un écran.
 */
function serverToolbarFaults(root: string): string[] {
  const all = sources(root);
  const faults: string[] = [];
  const app = source(all, path.join("OMPConsole", "OMPConsoleApp.swift"));
  const commands = block(app, /struct RefreshCommands: Commands \{/, "\n}\n");
  if (
    commands === undefined ||
    !commands.includes("@FocusedValue(\\.harnessRefresh)") ||
    !commands.includes('.keyboardShortcut("r", modifiers: .command)')
  )
    faults.push("RefreshCommands ne porte pas « Actualiser » ⌘R, nourri par \\.harnessRefresh");
  if (!source(all, ROOT_VIEW).includes(".focusedSceneValue(\\.harnessRefresh,"))
    faults.push("OSRootView ne publie pas sa relecture pour ⌘R (\\.harnessRefresh)");
  if (!/if destination == \.server \{\s*drafts\.serverSheetShown = true/.test(source(all, SYSTEM_SCREENS)))
    faults.push("la tuile Système › Serveur n'ouvre pas la feuille du serveur");
  for (const marker of ['"server.refresh"', '"server.open"']) {
    let inScreens = 0;
    for (const text of all.values()) inScreens += text.split(marker).length - 1;
    if (inScreens !== 0) faults.push(`${marker} apparaît ${inScreens} fois dans les écrans`);
  }
  return faults;
}

test("mac-finitions-hig/AC-5 : Pilotage — « Actualiser » est la commande ⌘R et le serveur s'ouvre de Système › Serveur, jamais d'un écran", () => {
  assert.deepEqual(serverToolbarFaults(ROOT), []);

  // Faute plantée : un bouton « Serveur » recopié dans un écran du hub ⇒ rouge.
  const copy = copyMac();
  mutate(copy, SYSTEM_SCREENS, (s) =>
    s.replace(
      '.accessibilityIdentifier("vigie.harness")',
      '.accessibilityIdentifier("vigie.harness")\n                .toolbar { Button("x") {}.accessibilityIdentifier("server.open") }',
    ),
  );
  assert.ok(
    serverToolbarFaults(copy).some((f) => f.includes('"server.open"')),
    "un bouton server.open dans un écran doit rougir",
  );
});

/** Le porteur décoratif du hub Système : le symbole de chaque tuile, que son titre annonce. */
const DECORATIVE: { rel: string; marker: string }[] = [
  { rel: SYSTEM_HUB, marker: "Image(systemName: destination.symbol)" },
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

/** AC-7 : chaque symbole décoratif du hub porte `.accessibilityHidden(true)` avant la fin de son expression. */
function decorativeFaults(root: string): string[] {
  const all = sources(root);
  const faults: string[] = [];
  for (const { rel, marker } of DECORATIVE) {
    const text = source(all, rel);
    const at = text.indexOf(marker);
    if (at < 0) faults.push(`${marker} introuvable dans ${rel}`);
    else if (!trailingModifiers(text, at).includes(".accessibilityHidden(true)"))
      faults.push(`${marker} sans .accessibilityHidden(true)`);
  }
  return faults;
}

test("mac-finitions-hig/AC-7 : hub Système — les symboles décoratifs des tuiles sont muets pour VoiceOver, leurs titres restent annoncés", () => {
  assert.deepEqual(decorativeFaults(ROOT), []);

  // Faute plantée : le symbole d'une tuile perd le modificateur ⇒ rouge.
  const copy = copyMac();
  mutate(copy, SYSTEM_HUB, (s) =>
    s.replace(
      /(Image\(systemName: destination\.symbol\)(?:\n\s*\.(?!accessibilityHidden)[^\n]*)*)\n\s*\.accessibilityHidden\(true\)/,
      "$1",
    ),
  );
  assert.deepEqual(decorativeFaults(copy), ["Image(systemName: destination.symbol) sans .accessibilityHidden(true)"]);
});
