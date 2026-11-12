// Les GARDES TEXTUELLES de la feature `ios-finitions-composants` : un test par
// critère gardé `ios-finitions-composants/AC-<n>`, et c'est le SEUL fichier qui
// porte ce slug (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source de l'app iOS ; chaque faute est plantée EN
// MÉMOIRE (`source.replace(…)`) : aucune copie du dépôt, aucun SwiftUI rendu. Le
// fichier ne lit ni le contrat ni l'historique git.
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { memberBody, stripComments, swiftSources } from "../support/swift-source.ts";

const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");

/** Le nombre d'occurrences d'un motif littéral. */
const count = (source: string, needle: string) => source.split(needle).length - 1;

/** Plante une faute : le remplacement DOIT changer le source. */
function plant(source: string, change: (s: string) => string): string {
  const after = change(source);
  assert.notEqual(after, source, "la faute plantée n'a rien changé");
  return after;
}

/** Les caractères de coche interdits comme marque de sélection (U+2713, U+2714). */
const CHECK_CHARACTERS = ["\u2713", "\u2714"];

/**
 * AC-2 : aucune source de l'app ne contient « ✓ » ni « ✔ » hors commentaire, et la
 * marque de sélection n'a plus de constante texte : un choix se retient par un
 * contrôle système, qui dessine sa marque et annonce son état.
 */
function checkCharacterFaults(sources: Map<string, string>): string[] {
  const faults: string[] = [];
  for (const [name, source] of sources) {
    const code = stripComments(source);
    for (const mark of CHECK_CHARACTERS) {
      const n = count(code, mark);
      if (n > 0) faults.push(`${name} : « ${mark} » ×${n} hors commentaire, la coche est le symbole système`);
    }
    if (count(code, "selectedMark") > 0) faults.push(`${name} : selectedMark reparaît, la marque texte est supprimée`);
  }
  return faults;
}

test("ios-finitions-composants/AC-2 : aucun « ✓ » dans l'app iOS, un choix se retient par un contrôle système", () => {
  const sources = swiftSources(APP);
  assert.deepEqual(checkCharacterFaults(sources), []);

  // Faute plantée : une coche redevient le caractère « ✓ » ⇒ rouge.
  const name = "IOSSystemScreens.swift";
  const typed = plant(sources.get(name)!, (s) => s.replace("content()\n", 'Text("✓")\n            content()\n'));
  assert.ok(
    checkCharacterFaults(new Map([[name, typed]])).some((f) => f.includes("✓")),
    "un « ✓ » dans le code doit rougir",
  );

  // Un « ✓ » cité en commentaire n'est pas du code ⇒ vert.
  const commented = plant(sources.get(name)!, (s) => `// La coche n'est plus le caractère « ✓ ».\n${s}`);
  assert.deepEqual(checkCharacterFaults(new Map([[name, commented]])), []);
});

const STATS = "IOSSystemScreens.swift";
const DURATIONS = ["ConsoleFormat.duration(", "PipelineServerText.duration", "PipelineServerText.stepLine("];
const MONOSPACED = ".monospacedDigit()";

/** Le texte qui va de `at` à la première ligne réduite à `}` (incluse), ou à la fin. */
function untilClosingLine(code: string, at: number): string {
  const rest = code.slice(at);
  const closing = /\n[ \t]*\}[ \t]*(?=\n|$)/.exec(rest);
  return closing ? rest.slice(0, closing.index + closing[0].length) : rest;
}

/**
 * AC-6 : toute durée rendue applique `.monospacedDigit()` sur son `Text` : chaque
 * occurrence d'un formateur de durée est sur la ligne d'un `Text(`, et
 * `.monospacedDigit()` suit avant la première ligne `}`.
 */
function durationFaults(sources: Map<string, string>): string[] {
  const faults = new Set<string>();
  for (const [file, source] of sources) {
    const code = stripComments(source);
    for (const token of DURATIONS) {
      for (let at = code.indexOf(token); at >= 0; at = code.indexOf(token, at + 1)) {
        const lineStart = code.lastIndexOf("\n", at) + 1;
        const line = code.slice(lineStart, at);
        const textAt = line.lastIndexOf("Text(");
        if (textAt < 0 || !untilClosingLine(code, lineStart + textAt).includes(MONOSPACED))
          faults.add(`durée rendue hors garde : ${file}`);
      }
    }
  }
  return [...faults];
}

/** Retire le premier `.monospacedDigit()` qui suit `anchor` (faute plantée). */
function dropMonospaced(source: string, anchor: string): string {
  return plant(source, (s) => {
    const at = s.indexOf(anchor);
    const mark = s.indexOf(MONOSPACED, at);
    if (at < 0 || mark < 0) return s;
    return s.slice(0, mark) + s.slice(mark + MONOSPACED.length);
  });
}

test("ios-finitions-composants/AC-6 : toute durée de l'app iOS s'affiche en chiffres à chasse fixe (.monospacedDigit())", () => {
  const sources = swiftSources(APP);
  assert.deepEqual(durationFaults(sources), []);

  // Fautes plantées : chacun des rendus des Statistiques perd `.monospacedDigit()` ⇒ rouge.
  for (const anchor of ["PipelineServerText.duration", "PipelineServerText.stepLine("]) {
    assert.ok(sources.get(STATS)?.includes(anchor), `${STATS} doit rendre ${anchor}`);
    const lost = new Map(sources).set(STATS, dropMonospaced(sources.get(STATS)!, anchor));
    assert.deepEqual(
      durationFaults(lost),
      [`durée rendue hors garde : ${STATS}`],
      `${anchor} sans chasse fixe doit rougir`,
    );
  }

  // Faute plantée : une durée nue dans un source fictif ⇒ rouge.
  const bare = new Map(sources).set(
    "Fictive.swift",
    "struct Fictive: View {\n    var body: some View {\n        Text(ConsoleFormat.duration(ms: 0))\n    }\n}\n",
  );
  assert.deepEqual(durationFaults(bare), ["durée rendue hors garde : Fictive.swift"]);

  // Faute plantée : une durée passée en valeur texte d'un LabeledContent ⇒ rouge.
  const labelled = new Map(sources).set(
    "Fictive.swift",
    "struct Fictive: View {\n    var body: some View {\n        LabeledContent(t, value: PipelineServerText.duration(1))\n    }\n}\n",
  );
  assert.deepEqual(durationFaults(labelled), ["durée rendue hors garde : Fictive.swift"]);
});

/** Le sélecteur partagé Mac/iOS (cible ConsoleUI), compilé dans l'app iOS. */
const PICKER = "LaunchViews.swift";
const REPO_PICKER = "Picker(PipelineServerText.repoLabel, selection: Binding(";

/**
 * AC-8 : le dépôt d'un lancement se choisit dans un `Picker` natif ; chaque dépôt
 * montre son nom et le porte en tag ; aucun `Menu` reconstruit ni chevron.
 */
function repoPickerFaults(sources: Map<string, string>): string[] {
  const view = memberBody(stripComments(sources.get(PICKER) ?? ""), "public struct RepoPicker");
  if (view === "") return [`${PICKER} : RepoPicker introuvable`];
  const faults: string[] = [];
  if (view.includes("Menu {"))
    faults.push(`${PICKER} : un Menu reconstruit subsiste, le sélecteur est le Picker natif`);
  if (!view.includes(REPO_PICKER)) faults.push(`${PICKER} : ${REPO_PICKER} absent`);
  if (!/Text\(repo\.name\)\s*\.tag\(repo\.name\)/.test(view)) {
    faults.push(`${PICKER} : chaque dépôt doit être Text(repo.name).tag(repo.name)`);
  }
  for (const [name, source] of sources) {
    if (stripComments(source).includes("repoMenuSymbol"))
      faults.push(`${name} : repoMenuSymbol subsiste, le chevron du Menu est supprimé`);
  }
  return faults;
}

test("ios-finitions-composants/AC-8 : un lancement choisit son dépôt dans un Picker natif, tagué par le nom du dépôt", () => {
  const sources = new Map([
    ...swiftSources(APP),
    ...swiftSources(path.join(ROOT, "omp-console", "Sources", "ConsoleUI")),
  ]);
  assert.ok(sources.has(PICKER), "les écrans du serveur doivent être lus");
  assert.deepEqual(repoPickerFaults(sources), []);
  const view = sources.get(PICKER)!;
  const withView = (source: string) => new Map(sources).set(PICKER, source);

  // Faute plantée : le Picker redevient un Menu ⇒ rouge.
  const menu = plant(view, (s) => s.replace(REPO_PICKER, "Menu { Binding("));
  assert.deepEqual(
    repoPickerFaults(withView(menu)).filter((f) => f.includes("Menu") || f.includes("absent")).length,
    2,
  );

  // Faute plantée : le tag porte autre chose que le nom ⇒ rouge.
  const labelled = plant(view, (s) => s.replace(".tag(repo.name)", ".tag(repo.scope)"));
  assert.ok(
    repoPickerFaults(withView(labelled)).some((f) => f.includes("tag(repo.name)")),
    "un tag faux doit rougir",
  );

  // Faute plantée : le chevron du Menu revient ⇒ rouge.
  const chevron = new Map(sources).set(
    "IOSShellText.swift",
    `${sources.get("IOSShellText.swift")}\nlet repoMenuSymbol = "chevron.up.chevron.down"\n`,
  );
  assert.ok(
    repoPickerFaults(chevron).some((f) => f.startsWith("IOSShellText.swift : repoMenuSymbol")),
    "un repoMenuSymbol rendu doit rougir",
  );

  // Un « Menu { » cité en commentaire n'est pas du code ⇒ vert.
  assert.deepEqual(repoPickerFaults(withView(`// L'ancien sélecteur était un Menu { … }.\n${view}`)), []);
});
