// Les GARDES TEXTUELLES de la feature `ios-finitions-composants` : un test par
// critère gardé `ios-finitions-composants/AC-<n>`, et c'est le SEUL fichier qui
// porte ce slug (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source de l'app iOS ; chaque faute est plantée EN
// MÉMOIRE (`source.replace(…)`) : aucune copie du dépôt, aucun SwiftUI rendu. Le
// fichier ne lit ni le contrat ni l'historique git. La preuve visuelle (coche,
// champ qui grandit) est la recette de captures de la feature.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");

/**
 * Le source débarrassé de ses commentaires `//` et `/* … *\/` (copié de
 * test/ios-listes-groupees-natives.test.ts : aucun helper partagé n'existe) — un
 * exemple cité dans un commentaire n'est pas du code.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inBlock = false;
  while (i < source.length) {
    if (inBlock) {
      if (source.startsWith("*/", i)) {
        inBlock = false;
        i += 2;
      } else i += 1;
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
    out += source[i];
    i += 1;
  }
  return out;
}

/** Le source d'un fichier de l'app, tel qu'écrit (les fautes s'y plantent). */
function appSource(name: string): string {
  return fs.readFileSync(path.join(APP, name), "utf8");
}

/** Les sources `.swift` de l'app, sous-dossiers compris : chemin relatif → texte. */
function appSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of fs.readdirSync(APP, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".swift")) continue;
    const file = path.join(entry.parentPath, entry.name);
    sources.set(path.relative(APP, file), fs.readFileSync(file, "utf8"));
  }
  return sources;
}

/** Le nombre d'occurrences d'un motif littéral. */
const count = (source: string, needle: string) => source.split(needle).length - 1;

/** Le bloc `{ … }` dont l'accolade ouvrante est à `open` (accolades équilibrées). */
function block(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/** Le corps `{ … }` du membre qui suit la première occurrence de `head`, ou "". */
function memberBody(code: string, head: string): string {
  const at = code.indexOf(head);
  return at < 0 ? "" : block(code, code.indexOf("{", at));
}

/** Plante une faute : le remplacement DOIT changer le source. */
function plant(source: string, change: (s: string) => string): string {
  const after = change(source);
  assert.notEqual(after, source, "la faute plantée n'a rien changé");
  return after;
}

const DIALOG = "IOSProjectDialogSheet.swift";
const METRICS = path.join("Design", "IOSMetrics.swift");

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
 * AC-2 : l'option choisie d'« OMP vous demande » porte la coche SF Symbol, masquée
 * à VoiceOver ; l'état reste annoncé par le trait « sélectionné ».
 */
function dialogCheckmarkFaults(source: string): string[] {
  const options = memberBody(stripComments(source), "private var selectForm");
  const faults: string[] = [];
  if (options === "") return [`${DIALOG} : selectForm introuvable`];
  if (!/Image\(systemName: IOSHomeText\.selectedSymbol\)(?:\s*\.\w+\([^()]*\))*?\s*\.accessibilityHidden\(true\)/.test(options)) {
    faults.push(`${DIALOG} : l'option choisie doit porter Image(systemName: IOSHomeText.selectedSymbol) masquée par .accessibilityHidden(true)`);
  }
  if (!options.includes(".accessibilityAddTraits(selectedIndex == index ? .isSelected : [])")) {
    faults.push(`${DIALOG} : l'option perd le trait .isSelected, VoiceOver n'annonce plus le choix`);
  }
  return faults;
}

/**
 * AC-5 : la réponse libre est un champ vertical borné en LIGNES par
 * `IOSMetrics.dialogAnswerLines`, plus jamais un `TextEditor` figé à 240 pt.
 */
function editorFieldFaults(source: string): string[] {
  const code = stripComments(source);
  const faults: string[] = [];
  // Le texte du `case .editor:` du `form`, jusqu'au cas suivant (c'est le dernier).
  const form = memberBody(code, "private var form");
  const at = form.indexOf("case .editor:");
  const rest = at < 0 ? "" : form.slice(at + "case .editor:".length);
  const next = rest.search(/\bcase \./);
  const editor = next < 0 ? rest : rest.slice(0, next);
  if (!/TextField\([^\n]*axis:\s*\.vertical\)\s*\.lineLimit\(IOSMetrics\.dialogAnswerLines\)/.test(editor)) {
    faults.push(`${DIALOG} : case .editor doit rendre TextField(…, axis: .vertical).lineLimit(IOSMetrics.dialogAnswerLines)`);
  }
  if (!editor.includes(".accessibilityIdentifier(ProjectAccessibility.dialogInput)")) {
    faults.push(`${DIALOG} : case .editor perd l'identifiant ProjectAccessibility.dialogInput`);
  }
  if (count(code, "TextEditor(") > 0) faults.push(`${DIALOG} : TextEditor( reparaît, sa hauteur ne suit pas le texte`);
  if (count(code, "minHeight: 240") > 0) faults.push(`${DIALOG} : minHeight: 240 reparaît, le champ part court`);
  return faults;
}

/** AC-5 : la plage de lignes du champ part à 3 lignes au plus et laisse grandir. */
function answerLinesFaults(metrics: string): string[] {
  const match = /static let dialogAnswerLines: ClosedRange<Int> = (\d+)\.\.\.(\d+)/.exec(stripComments(metrics));
  if (!match) return ["IOSMetrics.swift : static let dialogAnswerLines: ClosedRange<Int> = a...b absent"];
  const [low, high] = [Number(match[1]), Number(match[2])];
  return low <= 3 && 3 < high ? [] : [`IOSMetrics.swift : dialogAnswerLines = ${low}...${high}, attendu a ≤ 3 < b`];
}

test("ios-finitions-composants/AC-2 : « OMP vous demande » coche l'option choisie du symbole système, aucun « ✓ » dans l'app iOS", () => {
  const sources = appSources();
  assert.ok(sources.has(DIALOG), "la feuille du dialogue doit être lue");
  assert.deepEqual(checkCharacterFaults(sources), []);
  assert.deepEqual(dialogCheckmarkFaults(appSource(DIALOG)), []);

  // Faute plantée : la coche redevient le caractère « ✓ » ⇒ rouge.
  const typed = plant(appSource(DIALOG), (s) => s.replace("Image(systemName: IOSHomeText.selectedSymbol)", 'Text("✓")'));
  assert.ok(checkCharacterFaults(new Map([[DIALOG, typed]])).some((f) => f.includes("✓")), "un « ✓ » dans le code doit rougir");
  assert.ok(dialogCheckmarkFaults(typed).some((f) => f.includes("selectedSymbol")), "la coche texte doit rougir");

  // Faute plantée : la coche n'est plus masquée à VoiceOver ⇒ rouge.
  const spoken = plant(appSource(DIALOG), (s) => s.replace(/(IOSHomeText\.selectedSymbol\)[\s\S]*?)\s*\.accessibilityHidden\(true\)/, "$1"));
  assert.ok(dialogCheckmarkFaults(spoken).some((f) => f.includes("accessibilityHidden")), "une coche lue par VoiceOver doit rougir");

  // Faute plantée : le trait « sélectionné » disparaît ⇒ rouge.
  const silent = plant(appSource(DIALOG), (s) => s.replace(".accessibilityAddTraits(selectedIndex == index ? .isSelected : [])", ""));
  assert.ok(dialogCheckmarkFaults(silent).some((f) => f.includes(".isSelected")), "un choix non annoncé doit rougir");

  // Un « ✓ » cité en commentaire n'est pas du code ⇒ vert.
  const commented = plant(appSource(DIALOG), (s) => `// La coche n'est plus le caractère « ✓ ».\n${s}`);
  assert.deepEqual(checkCharacterFaults(new Map([[DIALOG, commented]])), []);
});

test("ios-finitions-composants/AC-5 : la réponse libre d'« OMP vous demande » part à 3 lignes, grandit jusqu'à 8 puis défile", () => {
  assert.deepEqual(editorFieldFaults(appSource(DIALOG)), []);
  assert.deepEqual(answerLinesFaults(appSource(METRICS)), []);

  // Faute plantée : le TextEditor figé à 240 pt revient ⇒ rouge.
  const frozen = plant(appSource(DIALOG), (s) =>
    s.replace(
      'TextField(dialog.placeholder ?? "", text: $text, axis: .vertical)\n                .lineLimit(IOSMetrics.dialogAnswerLines)',
      "TextEditor(text: $text)\n                .frame(minHeight: 240)",
    ),
  );
  const frozenFaults = editorFieldFaults(frozen);
  assert.ok(frozenFaults.some((f) => f.includes("TextEditor(")), "un TextEditor doit rougir");
  assert.ok(frozenFaults.some((f) => f.includes("minHeight: 240")), "une hauteur de 240 pt doit rougir");

  // Faute plantée : le champ vertical perd sa plage de lignes ⇒ rouge.
  const unbounded = plant(appSource(DIALOG), (s) => s.replace("\n                .lineLimit(IOSMetrics.dialogAnswerLines)", ""));
  assert.ok(editorFieldFaults(unbounded).some((f) => f.includes("lineLimit")), "un champ sans plage de lignes doit rougir");

  // Faute plantée : la plage part à 8 lignes, le champ ne grandit plus ⇒ rouge.
  const tall = plant(appSource(METRICS), (s) => s.replace("dialogAnswerLines: ClosedRange<Int> = 3...8", "dialogAnswerLines: ClosedRange<Int> = 8...8"));
  assert.deepEqual(answerLinesFaults(tall), ["IOSMetrics.swift : dialogAnswerLines = 8...8, attendu a ≤ 3 < b"]);
});

const STATS_SCREEN = "IOSStatsScreen.swift";
const STATS_CONTENT = "IOSStatsContent.swift";
const DURATION_CALL = "ConsoleFormat.duration(";
const STATS_VALUE = "Text(card(model.elapsedMs(at:";
const MONOSPACED = ".monospacedDigit()";

/** Le texte qui va de `at` à la première ligne réduite à `}` (incluse), ou à la fin. */
function untilClosingLine(code: string, at: number): string {
  const rest = code.slice(at);
  const closing = /\n[ \t]*\}[ \t]*(?=\n|$)/.exec(rest);
  return closing ? rest.slice(0, closing.index + closing[0].length) : rest;
}

/**
 * AC-6 : toute durée rendue applique `.monospacedDigit()` sur son `Text`. Une
 * occurrence de `ConsoleFormat.duration(` est soit (a) dans IOSStatsContent.swift,
 * dont les valeurs ne sont rendues que par `cardSection`, soit (b) l'argument d'un
 * `Text(` suivi de `.monospacedDigit()` avant la première ligne `}` ; et (c) le
 * `Text` des valeurs de Statistiques porte `.monospacedDigit()`.
 */
function durationFaults(sources: Map<string, string>): string[] {
  const faults = new Set<string>();
  for (const [file, source] of sources) {
    if (file === STATS_CONTENT) continue;
    const code = stripComments(source);
    for (let at = code.indexOf(DURATION_CALL); at >= 0; at = code.indexOf(DURATION_CALL, at + 1)) {
      // Une durée lue par VoiceOver dans le descripteur d'un graphique n'est pas
      // dessinée : la chasse fixe ne la concerne pas (IOSStatsCharts).
      if (/valueDescriptionProvider:\s*\{\s*$/.test(code.slice(Math.max(0, at - 60), at))) continue;
      const inText = code.slice(at - "Text(".length, at) === "Text(";
      if (!inText || !untilClosingLine(code, at).includes(MONOSPACED)) faults.add(`durée rendue hors garde : ${file}`);
    }
  }
  const stats = stripComments(sources.get(STATS_SCREEN) ?? "");
  const value = stats.indexOf(STATS_VALUE);
  if (value < 0 || !untilClosingLine(stats, value).includes(MONOSPACED)) faults.add(`durée rendue hors garde : ${STATS_SCREEN}`);
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
  const sources = appSources();
  assert.deepEqual(durationFaults(sources), []);

  // Fautes plantées : chacun des 4 rendus perd `.monospacedDigit()` ⇒ rouge.
  const sites: Array<[string, string]> = [
    ["HomeView.swift", DURATION_CALL],
    ["PipelinesScreen.swift", DURATION_CALL],
    ["PipelinesCardSheet.swift", DURATION_CALL],
    [STATS_SCREEN, STATS_VALUE],
  ];
  for (const [file, anchor] of sites) {
    assert.ok(sources.has(file), `${file} doit être lu`);
    const lost = new Map(sources).set(file, dropMonospaced(sources.get(file)!, anchor));
    assert.deepEqual(durationFaults(lost), [`durée rendue hors garde : ${file}`], `${file} sans chasse fixe doit rougir`);
  }

  // Faute plantée : une durée nue dans un source fictif ⇒ rouge.
  const bare = new Map(sources).set(
    "Fictive.swift",
    "struct Fictive: View {\n    var body: some View {\n        Text(ConsoleFormat.duration(ms: 0))\n    }\n}\n",
  );
  assert.deepEqual(durationFaults(bare), ["durée rendue hors garde : Fictive.swift"]);
});

const NEW_FEATURE = "NewFeatureSheetView.swift";
const PIPELINES_TEXT = "PipelinesText.swift";
const REPO_PICKER = "Picker(NewFeatureText.repo, selection: $repo)";

/**
 * AC-8 : le dépôt de « Nouvelle feature » se choisit dans un `Picker` natif. L'invite
 * « Choisir un dépôt » est étiquetée `""` et inactive ; chaque dépôt montre son libellé
 * et porte sa racine en tag ; le `Menu` reconstruit et son chevron ont disparu.
 */
function repoPickerFaults(sources: Map<string, string>): string[] {
  const view = stripComments(sources.get(NEW_FEATURE) ?? "");
  if (view === "") return [`${NEW_FEATURE} : introuvable`];
  const faults: string[] = [];
  if (view.includes("Menu {")) faults.push(`${NEW_FEATURE} : un Menu reconstruit subsiste, le sélecteur est le Picker natif`);
  if (!view.includes(REPO_PICKER)) faults.push(`${NEW_FEATURE} : ${REPO_PICKER} absent`);
  if (!/Text\(NewFeatureText\.repoPrompt\)\s*(?:\.tag\(""\)\s*\.selectionDisabled\(\)|\.selectionDisabled\(\)\s*\.tag\(""\))/.test(view)) {
    faults.push(`${NEW_FEATURE} : l'invite doit être Text(NewFeatureText.repoPrompt).tag("").selectionDisabled()`);
  }
  if (!/Text\(verbatim: choice\.label\)\s*\.tag\(choice\.root\)/.test(view)) {
    faults.push(`${NEW_FEATURE} : chaque dépôt doit être Text(verbatim: choice.label).tag(choice.root)`);
  }
  for (const [name, source] of sources) {
    if (stripComments(source).includes("repoMenuSymbol")) faults.push(`${name} : repoMenuSymbol subsiste, le chevron du Menu est supprimé`);
  }
  return faults;
}

test("ios-finitions-composants/AC-8 : « Nouvelle feature » choisit son dépôt dans un Picker natif, invite inactive, racine lancée", () => {
  const sources = appSources();
  assert.ok(sources.has(NEW_FEATURE), "la feuille Nouvelle feature doit être lue");
  assert.ok(sources.has(PIPELINES_TEXT), "le vocabulaire Pipelines doit être lu");
  assert.deepEqual(repoPickerFaults(sources), []);
  const view = sources.get(NEW_FEATURE)!;
  const withSheet = (source: string) => new Map(sources).set(NEW_FEATURE, source);

  // Faute plantée : le Picker redevient un Menu ⇒ rouge.
  const menu = plant(view, (s) => s.replace(`${REPO_PICKER} {`, "Menu {"));
  assert.deepEqual(repoPickerFaults(withSheet(menu)).filter((f) => f.includes("Menu") || f.includes("absent")).length, 2);

  // Faute plantée : l'invite devient choisissable ⇒ rouge.
  const choosable = plant(view, (s) => s.replace(".selectionDisabled()", ""));
  assert.ok(repoPickerFaults(withSheet(choosable)).some((f) => f.includes("l'invite")), "une invite choisissable doit rougir");

  // Faute plantée : l'invite perd son tag "" (la rangée s'afficherait vide) ⇒ rouge.
  const untagged = plant(view, (s) => s.replace('.tag("")', ""));
  assert.ok(repoPickerFaults(withSheet(untagged)).some((f) => f.includes("l'invite")), "une invite sans tag doit rougir");

  // Faute plantée : le tag porte le libellé, pas la racine ⇒ rouge.
  const labelled = plant(view, (s) => s.replace(".tag(choice.root)", ".tag(choice.label)"));
  assert.ok(repoPickerFaults(withSheet(labelled)).some((f) => f.includes("choice.root")), "un libellé lancé comme dépôt doit rougir");

  // Faute plantée : le chevron du Menu revient dans le vocabulaire ⇒ rouge.
  const chevron = plant(sources.get(PIPELINES_TEXT)!, (s) =>
    s.replace("static let newFeatureSheetId", 'static let repoMenuSymbol = "chevron.up.chevron.down"\n    static let newFeatureSheetId'),
  );
  assert.ok(
    repoPickerFaults(new Map(sources).set(PIPELINES_TEXT, chevron)).some((f) => f.startsWith(`${PIPELINES_TEXT} : repoMenuSymbol`)),
    "un repoMenuSymbol rendu doit rougir",
  );

  // Un « Menu { » cité en commentaire n'est pas du code ⇒ vert.
  assert.deepEqual(repoPickerFaults(withSheet(`// L'ancien sélecteur était un Menu { … }.\n${view}`)), []);
});

const RECIPE = path.join(ROOT, "scripts", "ios-finitions-composants-recette.sh");

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

/** Le script sans ses commentaires `#` de ligne ni de fin de ligne (shell et Python). */
function stripHashComments(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/\s#\s.*$/, ""))
    .join("\n");
}

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
  assert.ok(recipeScriptFaults(kept).some((f) => f.includes("simctl delete")), "des simulateurs conservés doivent rougir");

  // Faute plantée : la construction n'est plus signée ⇒ rouge.
  const unsigned = plant(script, (s) => s.replace("CODE_SIGN_IDENTITY=- ", ""));
  assert.ok(recipeScriptFaults(unsigned).some((f) => f.includes("CODE_SIGN_IDENTITY=-")), "une app non signée doit rougir");

  // Faute plantée : l'avant n'est plus greffé du crochet `saisie` ⇒ rouge.
  const ungrafted = plant(script, (s) => s.replace('  "omp-console/ios/OMPConsoleIOS/IOSLaunchRecipeText.swift"\n', ""));
  assert.ok(recipeScriptFaults(ungrafted).some((f) => f.includes("IOSLaunchRecipeText.swift")), "un avant sans greffe doit rougir");

  // Faute plantée : la saisie sort de la matrice ⇒ rouge.
  const noEditor = plant(script, (s) => s.replace('("-section", "project", "-projet.recipe", "saisie")', '("-section", "project")'));
  assert.ok(recipeScriptFaults(noEditor).some((f) => f.includes("saisie")), "une saisie absente doit rougir");

  // Faute plantée : le Simulateur ouvert au premier plan, l'app Mac relancée, la PR fusionnée ⇒ rouge.
  for (const intrusion of ['open -a Simulator --args -CurrentDeviceUDID "$iphone"', 'xcrun simctl boot "$udid" && open "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"', "bash scripts/run-console.sh", "gh pr merge --squash"]) {
    const intrusive = plant(script, (s) => s.replace("trap cleanup EXIT", `trap cleanup EXIT\n${intrusion}`));
    assert.ok(recipeScriptFaults(intrusive).length > 0, `« ${intrusion} » doit rougir`);
  }

  // Simulator.app cité en commentaire reste admis (le script explique ce qu'il ne fait pas).
  assert.equal(recipeScriptFaults(script.replace("trap cleanup EXIT", "# Simulator.app n'est jamais lancé.\ntrap cleanup EXIT")).length, 0);
});
