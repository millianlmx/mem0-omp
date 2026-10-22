// Les GARDES TEXTUELLES de la feature `ios-finitions-composants` : un test par
// critère gardé `ios-finitions-composants/AC-<n>`, et c'est le SEUL fichier qui
// porte ce slug (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source de l'app iOS ; chaque faute est plantée EN
// MÉMOIRE (`source.replace(…)`) : aucune copie du dépôt, aucun SwiftUI rendu. Le
// fichier ne lit ni le contrat ni l'historique git. La preuve visuelle (coche) est
// la recette de captures de la feature.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { memberBody, stripComments, stripHashComments, swiftSources } from "../support/swift-source.ts";

const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");

/** Le source d'un fichier de l'app, tel qu'écrit (les fautes s'y plantent). */
function appSource(name: string): string {
  return fs.readFileSync(path.join(APP, name), "utf8");
}

/** Le nombre d'occurrences d'un motif littéral. */
const count = (source: string, needle: string) => source.split(needle).length - 1;

/** Plante une faute : le remplacement DOIT changer le source. */
function plant(source: string, change: (s: string) => string): string {
  const after = change(source);
  assert.notEqual(after, source, "la faute plantée n'a rien changé");
  return after;
}

const AUDITS = "IOSHarnessScreens.swift";

/** Les caractères de coche interdits comme marque de sélection (U+2713, U+2714). */
const CHECK_CHARACTERS = ["\u2713", "\u2714"];

/**
 * AC-2 : aucune source de l'app ne contient « ✓ » ni « ✔ » hors commentaire, et
 * la marque de sélection n'a plus de constante texte.
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

/**
 * AC-2 : une proposition d'audit retenue porte la coche SF Symbol
 * (`IOSShellText.pickedSymbol`) ; l'état reste annoncé par le trait « sélectionné ».
 */
function pickCheckmarkFaults(source: string): string[] {
  const rows = memberBody(stripComments(source), "private func auditRows");
  if (rows === "") return [`${AUDITS} : auditRows introuvable`];
  const faults: string[] = [];
  if (
    !/Image\(systemName: drafts\.isPicked\(audit, index\) \? IOSShellText\.pickedSymbol : IOSShellText\.unpickedSymbol\)/.test(
      rows,
    )
  ) {
    faults.push(`${AUDITS} : la proposition retenue doit porter Image(systemName: … IOSShellText.pickedSymbol …)`);
  }
  if (!rows.includes(".accessibilityAddTraits(drafts.isPicked(audit, index) ? .isSelected : [])")) {
    faults.push(`${AUDITS} : la proposition perd le trait .isSelected, VoiceOver n'annonce plus le choix`);
  }
  return faults;
}

test("ios-finitions-composants/AC-2 : une proposition d'audit retenue porte la coche du symbole système, aucun « ✓ » dans l'app iOS", () => {
  const sources = swiftSources(APP);
  assert.ok(sources.has(AUDITS), "les écrans du serveur doivent être lus");
  assert.deepEqual(checkCharacterFaults(sources), []);
  assert.deepEqual(pickCheckmarkFaults(appSource(AUDITS)), []);

  // Faute plantée : la coche redevient le caractère « ✓ » ⇒ rouge.
  const typed = plant(appSource(AUDITS), (s) =>
    s.replace(
      "Image(systemName: drafts.isPicked(audit, index) ? IOSShellText.pickedSymbol : IOSShellText.unpickedSymbol)",
      'Text("✓")',
    ),
  );
  assert.ok(
    checkCharacterFaults(new Map([[AUDITS, typed]])).some((f) => f.includes("✓")),
    "un « ✓ » dans le code doit rougir",
  );
  assert.ok(
    pickCheckmarkFaults(typed).some((f) => f.includes("pickedSymbol")),
    "la coche texte doit rougir",
  );

  // Faute plantée : le trait « sélectionné » disparaît ⇒ rouge.
  const silent = plant(appSource(AUDITS), (s) =>
    s.replace(".accessibilityAddTraits(drafts.isPicked(audit, index) ? .isSelected : [])", ""),
  );
  assert.ok(
    pickCheckmarkFaults(silent).some((f) => f.includes(".isSelected")),
    "un choix non annoncé doit rougir",
  );

  // Un « ✓ » cité en commentaire n'est pas du code ⇒ vert.
  const commented = plant(appSource(AUDITS), (s) => `// La coche n'est plus le caractère « ✓ ».\n${s}`);
  assert.deepEqual(checkCharacterFaults(new Map([[AUDITS, commented]])), []);
});

const STATS = "IOSHarnessScreens.swift";
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

const PICKER = "IOSHarnessScreens.swift";
const REPO_PICKER = "Picker(PipelineServerText.repoLabel, selection: Binding(";

/**
 * AC-8 : le dépôt d'un lancement se choisit dans un `Picker` natif ; chaque dépôt
 * montre son nom et le porte en tag ; aucun `Menu` reconstruit ni chevron.
 */
function repoPickerFaults(sources: Map<string, string>): string[] {
  const view = memberBody(stripComments(sources.get(PICKER) ?? ""), "struct IOSHarnessRepoPicker");
  if (view === "") return [`${PICKER} : IOSHarnessRepoPicker introuvable`];
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
  const sources = swiftSources(APP);
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

const RECIPE = path.join(ROOT, "scripts", "recette", "ios-finitions-composants-recette.sh");

/** Les jetons qu'une recette de captures privée, signée et avant/après doit porter (S-11). */
const RECIPE_TOKENS = [
  "simctl create",
  "simctl delete",
  "zz-finitions-tel",
  "zz-finitions-tab",
  "CODE_SIGN_IDENTITY=-",
  "codesign -dv",
  "--avant",
  "appearance",
  "content_size",
  "IOSLaunchRecipeText.swift",
];

/** Les jeux d'arguments de lancement des cibles 1, 2, 5, 6, 7 et 8 de la matrice (S-11). */
const RECIPE_LAUNCHES = [
  ["project", "-projet.recipe", "dialogue"],
  ["project", "-projet.recipe", "saisie"],
  ["kanban", "-pipelines.recipe", "ardoise"],
  ["kanban", "-pipelines.recipe", "fiche"],
  ["stats", "-stats.recipe", "pleine"],
  ["kanban", "-pipelines.recipe", "vide"],
].map(([section, flag, value]) => `("-section", "${section}", "${flag}", "${value}")`);

/** Ce qui volerait le focus du Mac, toucherait l'app Mac de l'utilisateur ou fusionnerait la PR. */
const RECIPE_FORBIDDEN = ["open -a", "OMP Console", "osascript", "run-console.sh", "gh pr merge"];

/**
 * AC-12 : la recette de captures crée puis supprime ses simulateurs privés,
 * compile une app signée, greffe le crochet `saisie` sur l'avant, couvre les
 * cibles de la matrice, exécute les contrôles d'AC-2, AC-5, AC-6 et AC-8, et ne
 * touche ni au focus du Mac, ni à l'app Mac, ni à la fusion de la PR.
 */
function recipeScriptFaults(script: string): string[] {
  const faults: string[] = [];
  const code = stripHashComments(script);
  for (const token of [...RECIPE_TOKENS, ...RECIPE_LAUNCHES]) {
    if (!code.includes(token)) faults.push(`recette : jeton absent hors commentaire « ${token} »`);
  }
  for (const n of [2, 5, 6, 8]) {
    if (!new RegExp(`\\bAC-${n}\\b`).test(script)) faults.push(`recette : aucune ligne AC-${n}`);
  }
  for (const token of RECIPE_FORBIDDEN) {
    if (script.includes(token)) faults.push(`recette : « ${token} » interdit`);
  }
  if (code.includes("Simulator.app")) faults.push("recette : Simulator.app hors commentaire");
  return faults;
}

test("ios-finitions-composants/AC-12 : la recette de captures avant/après tourne sur des simulateurs privés supprimés, sans voler le focus ni fusionner", () => {
  const script = fs.readFileSync(RECIPE, "utf8");
  assert.deepEqual(recipeScriptFaults(script), []);

  // Faute plantée : la recette ne supprime plus ses simulateurs ⇒ rouge.
  const kept = plant(script, (s) => s.replaceAll("simctl delete", "simctl shutdown"));
  assert.ok(
    recipeScriptFaults(kept).some((f) => f.includes("simctl delete")),
    "des simulateurs conservés doivent rougir",
  );

  // Faute plantée : la construction n'est plus signée ⇒ rouge.
  const unsigned = plant(script, (s) => s.replace("CODE_SIGN_IDENTITY=- ", ""));
  assert.ok(
    recipeScriptFaults(unsigned).some((f) => f.includes("CODE_SIGN_IDENTITY=-")),
    "une app non signée doit rougir",
  );

  // Faute plantée : l'avant n'est plus greffé du crochet `saisie` ⇒ rouge.
  const ungrafted = plant(script, (s) =>
    s.replace('  "omp-console/ios/OMPConsoleIOS/IOSLaunchRecipeText.swift"\n', ""),
  );
  assert.ok(
    recipeScriptFaults(ungrafted).some((f) => f.includes("IOSLaunchRecipeText.swift")),
    "un avant sans greffe doit rougir",
  );

  // Faute plantée : la saisie sort de la matrice ⇒ rouge.
  const noEditor = plant(script, (s) =>
    s.replace('("-section", "project", "-projet.recipe", "saisie")', '("-section", "project")'),
  );
  assert.ok(
    recipeScriptFaults(noEditor).some((f) => f.includes("saisie")),
    "une saisie absente doit rougir",
  );

  // Faute plantée : le Simulateur ouvert au premier plan, l'app Mac relancée, la PR fusionnée ⇒ rouge.
  for (const intrusion of [
    'open -a Simulator --args -CurrentDeviceUDID "$iphone"',
    'xcrun simctl boot "$udid" && open "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"',
    "bash scripts/run-console.sh",
    "gh pr merge --squash",
  ]) {
    const intrusive = plant(script, (s) => s.replace("trap cleanup EXIT", `trap cleanup EXIT\n${intrusion}`));
    assert.ok(recipeScriptFaults(intrusive).length > 0, `« ${intrusion} » doit rougir`);
  }

  // Simulator.app cité en commentaire reste admis (le script explique ce qu'il ne fait pas).
  assert.equal(
    recipeScriptFaults(script.replace("trap cleanup EXIT", "# Simulator.app n'est jamais lancé.\ntrap cleanup EXIT"))
      .length,
    0,
  );
});
