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

const ROOT = path.resolve(import.meta.dirname, "..");
const MAC_REL = path.join("omp-console", "Sources", "OMPConsole");

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function strip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Chaque `.swift` de la coque Mac sous `root`, sans commentaires, par chemin relatif. */
function sources(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) files.set(path.relative(root, full), strip(fs.readFileSync(full, "utf8")));
    }
  };
  walk(path.join(root, MAC_REL));
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

/** Ce qui ferait apparaître « Réglages… » ou ⌘, dans le menu OMP Console. */
const SETTINGS_MARKERS: [RegExp, string][] = [
  [/\bSettings\s*\{/, "scène `Settings {`"],
  [/\bSettings\s*\(/, "scène `Settings(`"],
  [/keyboardShortcut\(\s*","/, "raccourci `keyboardShortcut(\",\")`"],
  [/\.appSettings\b/, "groupe de commandes `.appSettings`"],
];

/** AC-2 : la coque Mac ne crée ni scène Réglages ni commande ⌘,. */
function settingsFaults(root: string): string[] {
  const faults: string[] = [];
  for (const [rel, source] of sources(root)) {
    for (const [marker, label] of SETTINGS_MARKERS) {
      if (marker.test(source)) faults.push(`${rel} : ${label}`);
    }
  }
  return faults;
}

test("mac-finitions-hig/AC-2 : ni scène Réglages ni ⌘, — le menu OMP Console reste celui de la base", () => {
  assert.deepEqual(settingsFaults(ROOT), []);

  // Faute plantée : une scène `Settings` ajoutée à l'app ⇒ rouge.
  const copy = copyMac();
  mutate(copy, "OMPConsoleApp.swift", (s) => s.replace(/(var body: some Scene \{\n)/, "$1        Settings { EmptyView() }\n"));
  assert.ok(
    settingsFaults(copy).some((f) => f.startsWith(path.join(MAC_REL, "OMPConsoleApp.swift"))),
    "une scène Settings doit rougir",
  );
});

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
  const list = /graph\.shown\s*\?\s*MemoryText\.listButton[\s\S]*?systemImage:\s*graph\.shown\s*\?\s*"([^"]+)"/.exec(source)?.[1];
  const faults: string[] = [];
  if (summary !== "rectangle.stack") faults.push(`« Sommaire » porte ${summary ?? "aucun symbole"}, attendu rectangle.stack`);
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

const SESSION_VIEW = "SessionConsoleView.swift";

/** AC-4 : `session.status` sur la seule pilule de la barre, `session.statusNotice` sur l'avis. */
function sessionStatusFaults(root: string): string[] {
  const faults: string[] = [];
  const status = 'accessibilityIdentifier("session.status")';
  const notice = 'accessibilityIdentifier("session.statusNotice")';
  const all = sources(root);
  const statusTotal = [...all.values()].reduce((n, s) => n + s.split(status).length - 1, 0);
  const noticeTotal = [...all.values()].reduce((n, s) => n + s.split(notice).length - 1, 0);
  if (statusTotal !== 1) faults.push(`session.status posé ${statusTotal} fois`);
  if (noticeTotal !== 1) faults.push(`session.statusNotice posé ${noticeTotal} fois`);
  const toolbar = block(all.get(path.join(MAC_REL, SESSION_VIEW)) ?? "", /var toolbarContent\b/, "\n    }\n");
  if (!toolbar?.includes(status)) faults.push("session.status absent de SessionConsoleView.toolbarContent");
  return faults;
}

test("mac-finitions-hig/AC-4 : Session OMP — `session.status` désigne la seule pilule, l'avis a son propre identifiant", () => {
  assert.deepEqual(sessionStatusFaults(ROOT), []);

  // Faute plantée : l'avis reprend l'ancien identifiant ⇒ rouge.
  const copy = copyMac();
  mutate(copy, SESSION_VIEW, (s) => s.replace('"session.statusNotice"', '"session.status"'));
  assert.ok(sessionStatusFaults(copy).length > 0, "deux éléments session.status doivent rougir");
});

const PROJECT_VIEW = path.join("Project", "ProjectConsoleView.swift");

/** AC-5 : les commandes de Projet vivent dans la barre d'outils, plus dans l'en-tête. */
function projectToolbarFaults(root: string): string[] {
  const source = sources(root).get(path.join(MAC_REL, PROJECT_VIEW)) ?? "";
  const faults: string[] = [];
  const header = block(source, /struct ProjectHeaderView\b/, "\n}\n");
  const toolbar = block(source, /var toolbarContent\b/, "\n    }\n");
  if (header === undefined) faults.push("ProjectHeaderView introuvable");
  if (toolbar === undefined) faults.push("ProjectConsoleView.toolbarContent introuvable");
  const commands = ['"projet.details"', '"projet.close"', '"projet.sessionStatus"'];
  for (const marker of [...commands, "StatusPill("]) {
    if (header?.includes(marker)) faults.push(`l'en-tête porte encore ${marker}`);
  }
  for (const marker of [...commands, "technicalShown.toggle()", "isStopConfirmationPresented = true"]) {
    if (toolbar !== undefined && !toolbar.includes(marker)) faults.push(`la barre d'outils ne porte pas ${marker}`);
  }
  if (!/\.toolbar\s*\{\s*toolbarContent\s*\}/.test(source)) faults.push("`.toolbar { toolbarContent }` absent");
  return faults;
}

test("mac-finitions-hig/AC-5 : Projet — les commandes sont dans la barre d'outils de la fenêtre, plus dans l'en-tête", () => {
  assert.deepEqual(projectToolbarFaults(ROOT), []);

  // Faute plantée : le bouton « Détails techniques » recopié dans l'en-tête ⇒ rouge.
  const copy = copyMac();
  mutate(copy, PROJECT_VIEW, (s) =>
    s.replace(
      '.accessibilityIdentifier("projet.repo")',
      '.accessibilityIdentifier("projet.repo")\n                    Button { model.technicalShown.toggle() } label: { Text("i") }\n                        .accessibilityIdentifier("projet.details")',
    ),
  );
  assert.ok(
    projectToolbarFaults(copy).some((f) => f.includes('"projet.details"')),
    "un bouton projet.details dans l'en-tête doit rougir",
  );
});

const HOME_VIEW = path.join("Home", "HomeView.swift");
const WELCOME_SHEET = path.join("Home", "WelcomeSheet.swift");

/** Les cinq porteurs décoratifs de S-6 R1 : fichier, repère, et le conteneur qui porte le modificateur. */
const DECORATIVE: { rel: string; marker: string; container?: string }[] = [
  { rel: HOME_VIEW, marker: "Image(systemName: style.symbol)", container: "ZStack {" },
  { rel: HOME_VIEW, marker: "Image(systemName: PhaseText.symbol(card.phase))" },
  { rel: HOME_VIEW, marker: 'Image(systemName: "arrow.triangle.pull")' },
  { rel: HOME_VIEW, marker: 'Image(systemName: "bell.slash")' },
  { rel: WELCOME_SHEET, marker: "Image(systemName: promise.symbol)" },
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

  // Faute plantée : le bandeau de notifications perd le modificateur ⇒ rouge.
  const copy = copyMac();
  mutate(copy, HOME_VIEW, (s) =>
    s.replace(
      /(Image\(systemName: "bell\.slash"\)\n\s*\.foregroundStyle\(\.secondary\))\n\s*\.accessibilityHidden\(true\)/,
      "$1",
    ),
  );
  assert.deepEqual(decorativeFaults(copy), ['Image(systemName: "bell.slash") sans .accessibilityHidden(true)']);
});
