// La GARDE TEXTUELLE du câblage iOS de la feature `lenteurs-et-timeouts-du-chargement-sur-i` :
// un seul test, `…/AC-168`, et c'est le SEUL fichier qui porte ce slug (invariant `criteria/AC-13`).
//
// Les tests Swift (ChargementParalleleTests) appellent `readShell` et `phaseChanged` à la main ;
// cette garde fixe que l'app iOS les appelle bien : l'ouverture et « tirer pour actualiser » passent
// par `readShell`, `RootView` ne relit plus rien, les flux partagés suivent la phase de l'APP (un seul
// appel, posé sur la scène) et chaque fenêtre ne pilote que son pouls. Fonctions pures sur le texte
// source, commentaires retirés ; chaque faute est plantée EN MÉMOIRE (`source.replace(…)`).
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { braceBlock, memberBody, stripComments, swiftSources } from "../support/swift-source.ts";

const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");
const ROOT_VIEW = "RootView.swift";
const SHELL = "IOSOSRootView.swift";
const APP_FILE = "OMPConsoleIOSApp.swift";

const count = (source: string, needle: string) => source.split(needle).length - 1;

/** Le corps `{ … }` du premier `.onChange(of: scenePhase)` du code, ou "". */
function phaseBody(code: string): string {
  const at = code.indexOf(".onChange(of: scenePhase)");
  return at < 0 ? "" : braceBlock(code, code.indexOf("{", at));
}

/** Le retrait de la première ligne qui commence par `head` (après espaces), ou -1. */
function indentOfLine(code: string, head: string): number {
  const line = code.split("\n").find((l) => l.trimStart().startsWith(head));
  return line === undefined ? -1 : line.length - line.trimStart().length;
}

function wiringFaults(all: Map<string, string>): string[] {
  const faults: string[] = [];
  const code = (name: string) => stripComments(all.get(name) ?? "");

  // RootView ne relit plus rien : ni phase, ni lectures liées à l'adresse.
  const root = code(ROOT_VIEW);
  if (root.includes("scenePhase")) faults.push(`${ROOT_VIEW} : scenePhase (la phase de l'app se lit dans l'App)`);
  if (root.includes(".task(id: server.address)"))
    faults.push(`${ROOT_VIEW} : .task(id: server.address) (les lectures sont celles de load())`);

  // Le chargement initial : readShell(.opening), rien d'autre à attendre.
  const shell = code(SHELL);
  const load = memberBody(shell, "private func load()");
  if (!load.includes("await server.readShell(.opening)"))
    faults.push(`${SHELL} : load() sans « await server.readShell(.opening) »`);
  if (count(load, "await") !== 1)
    faults.push(`${SHELL} : load() attend ${count(load, "await")} fois (attendu 1, readShell)`);

  // Tirer pour actualiser : readShell(.refreshing) en parallèle de la boîte.
  const reload = memberBody(shell, "private func reload()");
  if (!reload.includes("server.readShell(.refreshing)"))
    faults.push(`${SHELL} : reload() sans « server.readShell(.refreshing) »`);
  if (!reload.includes("await server.refresh()")) faults.push(`${SHELL} : reload() sans « await server.refresh() »`);
  const others = reload.replace("await server.refresh()", "").replace(/await shell\b/, "");
  if (/\bawait\b/.test(others))
    faults.push(`${SHELL} : reload() attend autre chose que la boîte et la lecture de la coque`);

  // La fenêtre ne pilote que son pouls.
  const window = phaseBody(shell);
  if (!window.includes("workspace.pulse.phaseChanged("))
    faults.push(`${SHELL} : .onChange(of: scenePhase) sans workspace.pulse.phaseChanged(`);
  for (const forbidden of ["lifecycle", "suspendStreams", "readShell", "refresh"]) {
    if (window.includes(forbidden))
      faults.push(`${SHELL} : .onChange(of: scenePhase) de la fenêtre touche « ${forbidden} »`);
  }

  // L'App : la phase agrégée, sur la scène (même retrait que `.commands`), un seul appel.
  const app = code(APP_FILE);
  if (!app.includes("@Environment(\\.scenePhase)")) faults.push(`${APP_FILE} : @Environment(\\.scenePhase) absent`);
  if (!/@State private var lifecycle = HarnessAppLifecycle\(\)/.test(app))
    faults.push(`${APP_FILE} : HarnessAppLifecycle() non tenu en @State`);
  const sceneIndent = indentOfLine(app, ".onChange(of: scenePhase)");
  const commandsIndent = indentOfLine(app, ".commands");
  if (sceneIndent < 0 || sceneIndent !== commandsIndent)
    faults.push(`${APP_FILE} : .onChange(of: scenePhase) pas au retrait de .commands (modificateur de la scène)`);
  if (!phaseBody(app).includes("lifecycle.phaseChanged("))
    faults.push(`${APP_FILE} : .onChange(of: scenePhase) n'appelle pas lifecycle.phaseChanged(`);

  // Dans toute l'app : un seul appel au cycle de vie, jamais de coupure des flux à la main.
  const whole = [...all.keys()].map(code).join("\n");
  if (count(whole, "lifecycle.phaseChanged(") !== 1)
    faults.push(`lifecycle.phaseChanged( apparaît ${count(whole, "lifecycle.phaseChanged(")} fois (attendu 1)`);
  if (whole.includes("suspendStreams")) faults.push("suspendStreams appelé depuis l'app iOS");
  return faults;
}

/** La faute plantée doit changer le source, sinon elle ne prouve rien. */
function plant(source: string, change: (s: string) => string): string {
  const after = change(source);
  assert.notEqual(after, source, "la faute plantée n'a rien changé");
  return after;
}

test("lenteurs-et-timeouts-du-chargement-sur-i/AC-168 : l'app iOS lit par readShell et suit la phase de l'app pour ses flux, celle de la fenêtre pour son pouls", () => {
  const all = swiftSources(APP);
  assert.deepEqual(wiringFaults(all), []);

  const red = (name: string, change: (s: string) => string, needle: string) => {
    const faults = wiringFaults(new Map(all).set(name, plant(all.get(name)!, change)));
    assert.ok(
      faults.some((f) => f.includes(needle)),
      `${needle} doit rougir : ${JSON.stringify(faults)}`,
    );
  };

  // `.task(id: server.address)` remis dans RootView.
  red(
    ROOT_VIEW,
    (s) => s.replace(".task {", ".task(id: server.address) { await server.workstation.refresh() }\n        .task {"),
    ".task(id: server.address)",
  );

  // Une lecture en série ajoutée à load().
  red(
    SHELL,
    (s) =>
      s.replace(
        "await server.readShell(.opening)",
        "await server.readShell(.opening)\n        await workstation.load()",
      ),
    "load() attend",
  );

  // readShell(.opening) retiré de load().
  red(
    SHELL,
    (s) => s.replace("await server.readShell(.opening)", "await server.refreshCatalog()"),
    "sans « await server.readShell(.opening) »",
  );

  // readShell(.refreshing) retiré de reload().
  red(
    SHELL,
    (s) =>
      s.replace(
        "async let shell: Void = server.readShell(.refreshing)",
        "async let shell: Void = server.refreshCatalog()",
      ),
    "sans « server.readShell(.refreshing) »",
  );

  // L'appel au cycle de vie déplacé dans la fenêtre.
  red(
    SHELL,
    (s) =>
      s.replace(
        "workspace.pulse.phaseChanged(to: HarnessAppPhase(phase))",
        "lifecycle.phaseChanged(to: HarnessAppPhase(phase), harness: server)",
      ),
    "touche « lifecycle »",
  );

  // Le .onChange de l'App indenté dans le contenu de la fenêtre.
  red(
    APP_FILE,
    (s) => s.replace(/\n {8}\.onChange\(of: scenePhase\)/, "\n            .onChange(of: scenePhase)"),
    "pas au retrait de .commands",
  );
});
