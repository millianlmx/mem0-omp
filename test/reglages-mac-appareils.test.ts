// Gardes textuelles de la feature `reglages-mac-appareils` (S-1, S-5) : la
// structure Mac que `swift test` ne peut pas observer — la scène `Settings`, son
// onglet unique « Appareils », l'unicité de son hôte, le menu « Appairage… » en
// `SettingsLink`, et la disparition de la feuille modale « Appairage ».
//
// Règles :
//  1. les sources sont lues commentaires retirés (un commentaire ne prouve rien) ;
//  2. chaque test plante sa faute dans une COPIE EN MÉMOIRE du source et vérifie
//     que la garde rougit — une garde qui ne discrimine pas ne prouve rien ;
//  3. `test/criteria.test.ts` (criteria/AC-13) : un id qualifié = un seul test, un
//     slug = un seul fichier node ; ce fichier est le seul de `test/` à porter le
//     slug `reglages-mac-appareils`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MACOS = path.join(ROOT, "omp-console", "Sources", "OMPConsole");
const APP = "OMPConsoleApp.swift";
const SETTINGS_VIEW = path.join("Settings", "ConsoleSettingsView.swift");
const DEVICES_SETTINGS = path.join("Remote", "DevicesSettingsView.swift");
const MAIN_SHEET = path.join("Home", "MainSheet.swift");

/** Les sources Swift de l'app Mac, chemin relatif à `Sources/OMPConsole` → texte brut. */
type Sources = Record<string, string>;

function macSources(): Sources {
  const out: Sources = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) out[path.relative(MACOS, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(MACOS);
  return out;
}

/** Une copie en mémoire des sources où `file` est réécrit par `plant`. */
function planted(sources: Sources, file: string, plant: (source: string) => string): Sources {
  const original = sources[file];
  assert.ok(original !== undefined, `${file} absent`);
  const changed = plant(original);
  assert.notEqual(changed, original, "la faute plantée doit s'appliquer");
  return { ...sources, [file]: changed };
}

/** Le source débarrassé de ses commentaires `//` et `/* … *\/` (les chaînes sont gardées). */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inBlock = false;
  let inString = false;
  while (i < source.length) {
    if (inBlock) {
      if (source.startsWith("*/", i)) {
        inBlock = false;
        i += 2;
      } else i += 1;
      continue;
    }
    if (inString) {
      if (source[i] === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (source[i] === '"' || source[i] === "\n") inString = false;
      out += source[i];
      i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (source.startsWith("/*", i)) {
      inBlock = true;
      i += 2;
      continue;
    }
    if (source[i] === '"') inString = true;
    out += source[i];
    i += 1;
  }
  return out;
}

/** Le texte compris entre l'accolade ouvrante d'indice `open` et sa fermante, ou null. */
function braceBody(source: string, open: number): { body: string; start: number; end: number } | null {
  if (source[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open + 1, i), start: open + 1, end: i };
    }
  }
  return null;
}

/** Le bloc `{ … }` qui suit la première occurrence de `pattern`, ou null. */
function blockAfter(source: string, pattern: RegExp): { body: string; start: number; end: number } | null {
  const match = pattern.exec(source);
  if (!match) return null;
  const open = source.indexOf("{", match.index + match[0].length - 1);
  return open === -1 ? null : braceBody(source, open);
}

/** La valeur littérale de `static let <name> = "…"`, ou null. */
function literal(source: string, name: string): string | null {
  const match = new RegExp(`static let ${name} = "((?:[^"\\\\]|\\\\.)*)"`).exec(source);
  return match ? match[1] : null;
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(new RegExp(pattern.source, "g"))].length;
}

/** Les sources commentaires retirés. */
function code(sources: Sources, file: string): string {
  return stripComments(sources[file] ?? "");
}

/** Le corps de `var body: some Scene { … }` de l'app. */
function sceneBody(app: string): { body: string; start: number; end: number } | null {
  return blockAfter(app, /var\s+body\s*:\s*some\s+Scene\s*\{/);
}

// AC-1 : une seule scène `Settings`, hôte de `ConsoleSettingsView`, à onglet unique
// « Appareils » qui contient l'onglet `DevicesSettingsView`.
function settingsSceneFaults(sources: Sources): string[] {
  const faults: string[] = [];
  const app = code(sources, APP);
  const scenes = sceneBody(app);
  if (!scenes) return ["OMPConsoleApp.body (some Scene) introuvable"];
  const settingsCount = count(app, /\bSettings\s*\{/);
  if (settingsCount !== 1) faults.push(`${settingsCount} scène(s) Settings { dans OMPConsoleApp.swift, attendu 1`);
  const settings = blockAfter(scenes.body, /\bSettings\s*\{/);
  if (!settings) faults.push("la scène Settings n'est pas déclarée dans OMPConsoleApp.body");
  else if (!/^ConsoleSettingsView\(remote:\s*\w+\)$/.test(settings.body.trim())) {
    faults.push(`la scène Settings n'héberge pas ConsoleSettingsView seule : « ${settings.body.trim()} »`);
  }

  const view = code(sources, SETTINGS_VIEW);
  const viewStruct = blockAfter(view, /struct\s+ConsoleSettingsView\s*:\s*View\s*\{/);
  if (!viewStruct) return [...faults, "struct ConsoleSettingsView introuvable"];
  const tabViews = count(viewStruct.body, /\bTabView\s*\{/);
  if (tabViews !== 1) faults.push(`${tabViews} TabView dans ConsoleSettingsView, attendu 1`);
  const tabs = count(view, /\bTab\s*\(/);
  if (tabs !== 1) faults.push(`${tabs} Tab( dans ConsoleSettingsView.swift, attendu 1`);
  const tab = /\bTab\s*\(\s*([^,)]+)/.exec(viewStruct.body);
  if (!tab) faults.push("aucun Tab( dans ConsoleSettingsView");
  else {
    if (tab[1].trim() !== "PairingText.devicesTab") faults.push(`l'onglet est libellé ${tab[1].trim()}, attendu PairingText.devicesTab`);
    const tabBody = blockAfter(viewStruct.body.slice(tab.index), /\bTab\s*\([^{]*\{/);
    if (!tabBody || !/\bDevicesSettingsView\s*\(/.test(tabBody.body)) faults.push("l'onglet n'héberge pas DevicesSettingsView");
  }
  const label = literal(code(sources, DEVICES_SETTINGS), "devicesTab");
  if (label !== "Appareils") faults.push(`PairingText.devicesTab vaut ${JSON.stringify(label)}, attendu « Appareils »`);
  return faults;
}

const HOSTED = /\b(ConsoleSettingsView|DevicesSettingsView)\b/;
const HOST_SITE = /\b(ConsoleSettingsView|DevicesSettingsView)\s*\(/g;
const SCENE_OPENERS = /\b(WindowGroup|Window|UtilityWindow|DocumentGroup|MenuBarExtra)\s*\(/g;

// AC-2 : le panneau n'a qu'un hôte, la scène `Settings` (une fenêtre par
// construction) ; aucune autre scène ni `openWindow` ne l'héberge.
function singleHostFaults(sources: Sources): string[] {
  const faults: string[] = [];
  const app = code(sources, APP);
  const scenes = sceneBody(app);
  const settings = scenes ? blockAfter(scenes.body, /\bSettings\s*\{/) : null;
  const settingsRange = settings && scenes ? [scenes.start + settings.start, scenes.start + settings.end] : null;
  const view = code(sources, SETTINGS_VIEW);
  const tabMatch = /\bTab\s*\([^{]*\{/.exec(view);
  const tabBody = tabMatch ? braceBody(view, tabMatch.index + tabMatch[0].length - 1) : null;

  for (const file of Object.keys(sources).sort()) {
    const text = code(sources, file);
    for (const site of text.matchAll(HOST_SITE)) {
      const at = site.index;
      const allowed =
        (file === APP && site[1] === "ConsoleSettingsView" && settingsRange !== null && at >= settingsRange[0] && at < settingsRange[1]) ||
        (file === SETTINGS_VIEW && site[1] === "DevicesSettingsView" && tabBody !== null && at >= tabBody.start && at < tabBody.end);
      if (!allowed) faults.push(`${file} : ${site[1]}( hors de la scène Settings`);
    }
    for (const opener of text.matchAll(SCENE_OPENERS)) {
      const open = text.indexOf("{", opener.index);
      const block = open === -1 ? null : braceBody(text, open);
      if (block && HOSTED.test(block.body)) faults.push(`${file} : ${opener[1]}( héberge le panneau Réglages`);
    }
    if (/\bopenWindow\b/.test(text) && HOSTED.test(text)) faults.push(`${file} : openWindow à côté du panneau Réglages`);
  }
  if (!settings) faults.push("la scène Settings est absente");
  return faults;
}

// AC-10 : « Appairage… » ⌥⌘A est un `SettingsLink` (ouvre ou ramène les Réglages),
// sans feuille ni fenêtre principale ramenée.
function pairingMenuFaults(sources: Sources): string[] {
  const faults: string[] = [];
  const app = code(sources, APP);
  const scenes = sceneBody(app);
  const commands = scenes ? blockAfter(scenes.body, /\.commands\s*\{/) : null;
  if (!commands || !/\bRemoteCommands\(\)/.test(commands.body)) faults.push("RemoteCommands() absent des .commands de la scène");
  const remote = blockAfter(app, /struct\s+RemoteCommands\s*:\s*Commands\s*\{/);
  if (!remote) return [...faults, "struct RemoteCommands introuvable"];
  if (!/CommandGroup\(\s*after:\s*\.appInfo\s*\)/.test(remote.body)) faults.push("RemoteCommands n'est pas dans le menu de l'app (CommandGroup(after: .appInfo))");
  const links = count(remote.body, /\bSettingsLink\b/);
  if (links !== 1) faults.push(`${links} SettingsLink dans RemoteCommands, attendu 1`);
  const link = blockAfter(remote.body, /\bSettingsLink\s*\{/);
  if (!link || link.body.trim() !== "Text(PairingText.menuItem)") faults.push("le SettingsLink n'est pas libellé Text(PairingText.menuItem)");
  const shortcut = /\.keyboardShortcut\(\s*"a"\s*,\s*modifiers:\s*\[([^\]]*)\]\s*\)/.exec(remote.body);
  const modifiers = shortcut ? shortcut[1].split(",").map((m) => m.trim()).sort() : [];
  if (modifiers.join(" ") !== ".command .option") faults.push("raccourci ⌥⌘A absent de RemoteCommands");
  for (const forbidden of ["requestPairingSheet", "MainWindow.reveal", "Button("]) {
    if (remote.body.includes(forbidden)) faults.push(`RemoteCommands appelle encore ${forbidden}`);
  }
  if (/\bremote\b/.test(remote.body)) faults.push("RemoteCommands porte encore une propriété remote");
  const label = literal(code(sources, DEVICES_SETTINGS), "menuItem");
  if (label !== "Appairage…") faults.push(`PairingText.menuItem vaut ${JSON.stringify(label)}, attendu « Appairage… »`);
  return faults;
}

const SHEET_TOKENS: [string, RegExp][] = [
  ["PairingSheet", /PairingSheet/],
  ["sheetShown", /sheetShown/],
  ["requestPairingSheet", /requestPairingSheet/],
  ["case pairing", /\bcase\s+\.?pairing\b/],
  [".pairing:", /\.pairing:/],
  ["pairing.sheet", /pairing\.sheet/],
];

// AC-11 : plus aucune trace de la feuille modale « Appairage » dans l'app Mac.
function sheetGoneFaults(sources: Sources): string[] {
  const faults: string[] = [];
  for (const file of Object.keys(sources).sort()) {
    if (path.basename(file) === "PairingSheet.swift") faults.push(`${file} existe encore`);
    const text = code(sources, file);
    for (const [name, pattern] of SHEET_TOKENS) {
      if (pattern.test(text)) faults.push(`${file} contient ${name}`);
    }
  }
  if (sources[DEVICES_SETTINGS] === undefined) faults.push(`${DEVICES_SETTINGS} absent`);
  return faults;
}

test("reglages-mac-appareils/AC-1 : une seule scène Settings héberge ConsoleSettingsView, à onglet unique « Appareils »", () => {
  const sources = macSources();
  assert.deepEqual(settingsSceneFaults(sources), [], "l'arbre réel doit être sain");

  // Un deuxième onglet rougit.
  const twoTabs = planted(sources, SETTINGS_VIEW, (s) =>
    s.replace("TabView {", 'TabView {\n            Tab("Général", systemImage: "gearshape") { EmptyView() }'),
  );
  assert.ok(settingsSceneFaults(twoTabs).some((f) => f.includes("Tab(")));
  // Une deuxième scène Settings rougit aussi.
  const twoScenes = planted(sources, APP, (s) =>
    s.replace(/(\n        Settings \{\n[^}]*\})/, "$1$1"),
  );
  assert.ok(settingsSceneFaults(twoScenes).some((f) => f.includes("scène(s) Settings")));
});

test("reglages-mac-appareils/AC-2 : le panneau Réglages n'a qu'un hôte, la scène Settings — aucune fenêtre ni openWindow ne l'héberge", () => {
  const sources = macSources();
  assert.deepEqual(singleHostFaults(sources), [], "l'arbre réel doit être sain");

  // Une fenêtre `Window(` qui héberge le panneau rougit.
  const window = planted(sources, APP, (s) =>
    s.replace(
      /(\n        Settings \{\n[^}]*\})/,
      '$1\n        Window("Appareils", id: "devices") {\n            ConsoleSettingsView(remote: remoteModel)\n        }',
    ),
  );
  const faults = singleHostFaults(window);
  assert.ok(faults.some((f) => f.includes("Window( héberge")), faults.join(" | "));
  assert.ok(faults.some((f) => f.includes("hors de la scène Settings")), faults.join(" | "));
});

test("reglages-mac-appareils/AC-10 : « Appairage… » ⌥⌘A est un SettingsLink du menu de l'app, sans feuille ni fenêtre principale ramenée", () => {
  const sources = macSources();
  assert.deepEqual(pairingMenuFaults(sources), [], "l'arbre réel doit être sain");

  // Remettre l'ancien item (fenêtre principale ramenée + feuille demandée) rougit.
  const old = planted(sources, APP, (s) =>
    s.replace(
      /struct RemoteCommands: Commands \{[\s\S]*?\n\}\n/,
      [
        "struct RemoteCommands: Commands {",
        "    @ObservedObject var remote: RemoteServiceModel",
        "    var body: some Commands {",
        "        CommandGroup(after: .appInfo) {",
        "            Button(PairingText.menuItem) {",
        "                MainWindow.reveal()",
        "                remote.requestPairingSheet()",
        "            }",
        '            .keyboardShortcut("a", modifiers: [.command, .option])',
        "        }",
        "    }",
        "}",
        "",
      ].join("\n"),
    ),
  );
  const faults = pairingMenuFaults(old);
  assert.ok(faults.some((f) => f.includes("requestPairingSheet")), faults.join(" | "));
  assert.ok(faults.some((f) => f.includes("SettingsLink")), faults.join(" | "));
});

test("reglages-mac-appareils/AC-11 : plus aucune trace de la feuille modale « Appairage » dans l'app Mac", () => {
  const sources = macSources();
  assert.deepEqual(sheetGoneFaults(sources), [], "l'arbre réel doit être sain");

  // Réintroduire `case pairing` dans MainSheet rougit.
  const back = planted(sources, MAIN_SHEET, (s) => s.replace("    case setup\n", "    case setup\n    case pairing\n"));
  assert.deepEqual(sheetGoneFaults(back), [`${MAIN_SHEET} contient case pairing`]);
});
