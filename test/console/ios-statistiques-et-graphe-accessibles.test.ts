// Les GARDES TEXTUELLES de la feature `ios-statistiques-et-graphe-accessibles` : un
// test par critère `ios-statistiques-et-graphe-accessibles/AC-<n>`, et c'est le SEUL
// fichier qui porte ce slug (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source de l'app, de DESIGN.md et de la recette ;
// chaque faute est plantée EN MÉMOIRE (`source.replace(…)`) : aucune copie du dépôt,
// aucun SwiftUI rendu. Le comportement (barres, descripteurs, éléments VoiceOver,
// étiquettes décollées, palette résolue) est prouvé par les tests Swift
// d'OMPConsoleIOSTests ; la preuve visuelle est la recette de captures
// `scripts/recette/ios-statistiques-graphe-recette.sh`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { stripComments, stripHashComments, swiftFiles, swiftSources } from "../support/swift-source.ts";

const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");
const TESTS = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOSTests");

/** Le source d'un fichier de l'app, tel qu'écrit (les fautes s'y plantent). */
function appSource(name: string): string {
  return fs.readFileSync(path.join(APP, name), "utf8");
}

/** Plante une faute : le remplacement DOIT changer le source. */
function plant(source: string, change: (s: string) => string): string {
  const after = change(source);
  assert.notEqual(after, source, "la faute plantée n'a rien changé");
  return after;
}

// MARK: - Statistiques (S-2, S-3)
//
// AC-2, AC-3 et AC-4 gardaient les graphiques Swift Charts des Statistiques, que
// l'app calculait sur le magasin du Mac. Les Statistiques viennent désormais du
// serveur de pipelines, en liste groupée de valeurs (`IOSHarnessStatsScreen`) :
// plus aucun graphique, donc plus de descripteur ni de graphique vide à garder.

// MARK: - Graphe de la Mémoire (S-4, S-5, S-6)

const GRAPH_VIEW = "IOSMemoryGraphView.swift";

/** AC-5 : le canevas expose un élément par nœud affiché, activable, avec les titres liés. */
const VOICEOVER_TOKENS = [
  ".accessibilityChildren",
  "accessibilityElements(size:",
  ".accessibilityAction",
  ".accessibilityCustomContent(",
];

function voiceOverFaults(view: string): string[] {
  const code = stripComments(view);
  return VOICEOVER_TOKENS.filter((token) => !code.includes(token)).map(
    (token) => `${GRAPH_VIEW} : jeton absent « ${token} »`,
  );
}

/** AC-9 : le canevas peint la scène DÉCOLLÉE, jamais les textes bruts. */
function declutterFaults(view: string): string[] {
  return stripComments(view).includes("IOSMemoryGraphLabels.declutter(")
    ? []
    : [`${GRAPH_VIEW} : le dessin n'appelle plus IOSMemoryGraphLabels.declutter(`];
}

test("ios-statistiques-et-graphe-accessibles/AC-5 : le graphe expose à VoiceOver un élément par souvenir et par nœud-étiquette, et non plus un seul élément pour tout le canevas", () => {
  const view = appSource(GRAPH_VIEW);
  assert.deepEqual(voiceOverFaults(view), []);

  // Faute plantée : le canevas redevient un élément unique ⇒ rouge.
  const opaque = plant(view, (s) =>
    s.replace(".accessibilityChildren {", ".accessibilityElement(children: .ignore).background {"),
  );
  assert.deepEqual(voiceOverFaults(opaque), [`${GRAPH_VIEW} : jeton absent « .accessibilityChildren »`]);

  // Faute plantée : les titres liés ne sont plus offerts ⇒ rouge.
  const mute = plant(view, (s) => s.replace("base.accessibilityCustomContent(", "base.accessibilityHint("));
  assert.ok(
    voiceOverFaults(mute).some((f) => f.includes("accessibilityCustomContent")),
    "des titres liés absents doivent rougir",
  );
});

test("ios-statistiques-et-graphe-accessibles/AC-9 : les étiquettes du graphe sont décollées avant d'être peintes", () => {
  const view = appSource(GRAPH_VIEW);
  assert.deepEqual(declutterFaults(view), []);

  // Faute plantée : le décollage retiré ⇒ rouge.
  const raw = plant(view, (s) => s.replace("IOSMemoryGraphLabels.declutter(", "IOSMemoryGraphLabels.keepAll("));
  assert.equal(declutterFaults(raw).length, 1);
});

// MARK: - Palette (S-4)

const PALETTE = path.join("Design", "IOSDataPalette.swift");
const HSB = ["Color(hue:", "UIColor(hue:", "saturation:"];

/** AC-10 : aucune teinte HSB fixe dans l'app ; la palette ne cite que des couleurs système adaptatives. */
function paletteFaults(files: Map<string, string>): string[] {
  const faults: string[] = [];
  for (const [name, source] of files) {
    const code = stripComments(source);
    for (const token of HSB) {
      if (code.includes(token)) faults.push(`${name} : teinte HSB fixe « ${token} »`);
    }
  }
  const palette = stripComments(files.get(PALETTE) ?? "");
  const values = [...palette.matchAll(/static let \w+: (?:UIColor|\[UIColor\]) = (\[[^\]]*\]|[^\n]+)/g)].map(
    (m) => m[1],
  );
  if (values.length < 4)
    faults.push(`${PALETTE} : ${values.length} couleur(s) déclarée(s), attendu les trois séries et les portées`);
  for (const value of values) {
    const members = [...value.matchAll(/\.(\w+)/g)].map((m) => m[1]);
    if (members.length === 0 || value.includes("("))
      faults.push(`${PALETTE} : couleur non système « ${value.trim()} »`);
    for (const member of members) {
      if (!/^system[A-Z]/.test(member)) faults.push(`${PALETTE} : couleur non système « .${member} »`);
    }
  }
  if (!stripComments(files.get(GRAPH_VIEW) ?? "").includes("IOSDataPalette.scope(hue:")) {
    faults.push(`${GRAPH_VIEW} : les portées ne sont plus teintées par IOSDataPalette.scope(hue:)`);
  }
  return faults;
}

test("ios-statistiques-et-graphe-accessibles/AC-10 : aucune teinte HSB fixe dans l'app iOS, la palette ne cite que des couleurs système", () => {
  const sources = swiftSources(APP);
  assert.deepEqual(paletteFaults(sources), []);

  // Faute plantée : `Color(hue:` réintroduit dans le canevas ⇒ rouge.
  const hsb = new Map(sources);
  hsb.set(
    GRAPH_VIEW,
    plant(sources.get(GRAPH_VIEW)!, (s) =>
      s.replace("Color(uiColor: IOSDataPalette.scope(hue: hue))", "Color(hue: hue, saturation: 0.8, brightness: 0.7)"),
    ),
  );
  assert.ok(
    paletteFaults(hsb).some((f) => f.includes("« Color(hue: »")),
    "un Color(hue: doit rougir",
  );

  // Faute plantée : une couleur fixe dans la palette ⇒ rouge.
  const fixed = new Map(sources);
  fixed.set(
    PALETTE,
    plant(sources.get(PALETTE)!, (s) => s.replace("= .systemBlue", "= UIColor(red: 0, green: 0.4, blue: 1, alpha: 1)")),
  );
  assert.ok(
    paletteFaults(fixed).some((f) => f.includes("couleur non système")),
    "une couleur RVB fixe doit rougir",
  );

  // Faute plantée : une couleur non système parmi les portées ⇒ rouge.
  const plain = new Map(sources);
  plain.set(
    PALETTE,
    plant(sources.get(PALETTE)!, (s) => s.replace(".systemBrown]", ".brown]")),
  );
  assert.ok(
    paletteFaults(plain).some((f) => f.includes("« .brown »")),
    "une couleur non adaptative doit rougir",
  );
});

// MARK: - Recette de captures (S-8)

const RECIPE = path.join(ROOT, "scripts", "recette", "ios-statistiques-graphe-recette.sh");

/** Les jetons qu'une recette de captures privée, signée et avant/après doit porter hors commentaire (S-8). */
const RECIPE_TOKENS = [
  "simctl create",
  "simctl delete",
  "zz-statgraphe-tel",
  "zz-statgraphe-tab",
  "CODE_SIGN_IDENTITY=-",
  "codesign -dv",
  "--avant",
  "appearance",
  "increase_contrast",
];

/** Les 4 jeux d'arguments de lancement (S-8), en tuples Python littéraux. */
const RECIPE_LAUNCHES = [
  ["stats", "-stats.recipe", "pleine"],
  ["stats", "-stats.recipe", "vide"],
  ["memory", "-memoire.recipe", "graphe"],
  ["memory", "-memoire.recipe", "zoom"],
].map(([section, flag, value]) => `("-section", "${section}", "${flag}", "${value}")`);

/** Les critères contrôlés par la recette, une ligne `AC-n` chacun (S-8). */
const RECIPE_CRITERIA = [2, 4, 5, 8, 9, 11];

/** Ce qui volerait le focus du Mac, toucherait l'app Mac de l'utilisateur ou fusionnerait la PR — interdit partout, commentaires compris. */
const RECIPE_FORBIDDEN = ["open -a", "osascript", "OMP Console", "run-console.sh", "gh pr merge"];

/** AC-11 : simulateurs privés supprimés, app signée, matrice clair/sombre/contraste accru, contrôles AC, aucune intrusion. */
function recipeScriptFaults(script: string): string[] {
  const faults: string[] = [];
  const code = stripHashComments(script);
  for (const token of [...RECIPE_TOKENS, ...RECIPE_LAUNCHES]) {
    if (!code.includes(token)) faults.push(`recette : jeton absent hors commentaire « ${token} »`);
  }
  for (const n of RECIPE_CRITERIA) {
    if (!new RegExp(`\\bAC-${n}\\b`).test(code)) faults.push(`recette : aucune ligne AC-${n}`);
  }
  for (const token of RECIPE_FORBIDDEN) {
    if (script.includes(token)) faults.push(`recette : « ${token} » interdit`);
  }
  if (code.includes("Simulator.app")) faults.push("recette : Simulator.app hors commentaire");
  return faults;
}

test("ios-statistiques-et-graphe-accessibles/AC-11 : la recette avant/après capture clair, sombre et contraste accru sur des simulateurs privés supprimés, sans voler le focus ni fusionner", () => {
  assert.ok(fs.existsSync(RECIPE), `${path.relative(ROOT, RECIPE)} absent (écrit par le lot BR-6)`);
  const script = fs.readFileSync(RECIPE, "utf8");
  assert.deepEqual(recipeScriptFaults(script), []);

  // Faute plantée : la recette ne supprime plus ses simulateurs ⇒ rouge.
  const kept = plant(script, (s) => s.replaceAll("simctl delete", "simctl shutdown"));
  assert.ok(
    recipeScriptFaults(kept).some((f) => f.includes("simctl delete")),
    "des simulateurs conservés doivent rougir",
  );

  // Faute plantée : la construction n'est plus signée ⇒ rouge.
  const unsigned = plant(script, (s) => s.replaceAll("CODE_SIGN_IDENTITY=-", ""));
  assert.ok(
    recipeScriptFaults(unsigned).some((f) => f.includes("CODE_SIGN_IDENTITY=-")),
    "une app non signée doit rougir",
  );

  // Faute plantée : le contraste accru sort de la matrice ⇒ rouge.
  const noContrast = plant(script, (s) => s.replaceAll("increase_contrast", "appearance"));
  assert.ok(
    recipeScriptFaults(noContrast).some((f) => f.includes("increase_contrast")),
    "une matrice sans contraste accru doit rougir",
  );

  // Faute plantée : le graphe zoomé sort de la matrice ⇒ rouge.
  const noZoom = plant(script, (s) =>
    s.replace('("-section", "memory", "-memoire.recipe", "zoom")', '("-section", "memory")'),
  );
  assert.ok(
    recipeScriptFaults(noZoom).some((f) => f.includes("zoom")),
    "un lancement absent doit rougir",
  );

  // Faute plantée : le Simulateur ouvert au premier plan, l'app Mac relancée, la PR fusionnée ⇒ rouge.
  for (const intrusion of [
    'open -a Simulator --args -CurrentDeviceUDID "$udid"',
    'open "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"',
    "osascript -e 'quit app \"OMP Console\"'",
    "bash scripts/run-console.sh",
    "gh pr merge --squash",
  ]) {
    const intrusive = plant(script, (s) => s.replace("trap cleanup EXIT", `trap cleanup EXIT\n${intrusion}`));
    assert.ok(recipeScriptFaults(intrusive).length > 0, `« ${intrusion} » doit rougir`);
  }

  // Simulator.app cité en commentaire reste admis (le script explique ce qu'il ne fait pas).
  assert.deepEqual(
    recipeScriptFaults(script.replace("trap cleanup EXIT", "# Simulator.app n'est jamais lancé.\ntrap cleanup EXIT")),
    [],
  );
});

// MARK: - DESIGN.md (S-9)

const DESIGN = path.join(ROOT, "omp-console", "ios", "DESIGN.md");
const GRAPH_SECTION = "## Le mode graphe de la Mémoire (feature `ios-memoire-graphe`)";

/** Les marqueurs que chaque section doit porter (S-9), chacun prouvé par un test qui existe. */
const DESIGN_MARKERS: Record<string, string[]> = {
  [GRAPH_SECTION]: [
    "[test: paletteAdaptsToAppearanceAndContrast]",
    "[test: voiceOverExposesOneElementPerShownNode]",
    "[test: voiceOverActivatingAMemoryOpensItsSheet]",
    "[test: voiceOverActivatingATagFiltersAndOffersTheWholeGraph]",
    "[test: graphLabelsNeverOverlapAtOpeningScale]",
  ],
};

/** Le texte d'une section `## …` de DESIGN.md, jusqu'à la suivante, ou "". */
function designSection(design: string, heading: string): string {
  const at = design.indexOf(`${heading}\n`);
  if (at < 0) return "";
  const next = design.indexOf("\n## ", at + heading.length);
  return design.slice(at, next < 0 ? design.length : next);
}

/** AC-12 : chaque puce neuve ou modifiée porte son marqueur, dans sa section, vers un test qui existe. */
function designFaults(design: string, swiftTests: string, guards: string): string[] {
  const faults: string[] = [];
  for (const [heading, markers] of Object.entries(DESIGN_MARKERS)) {
    const section = designSection(design, heading);
    if (!section) {
      faults.push(`DESIGN.md : section absente « ${heading} »`);
      continue;
    }
    for (const marker of markers) {
      if (!section.includes(marker)) faults.push(`DESIGN.md : marqueur absent de « ${heading} » : ${marker}`);
      const [, kind, value] = marker.match(/^\[(test|garde): (.+)\]$/)!;
      if (kind === "test" && !new RegExp(`func ${value}\\(`).test(swiftTests))
        faults.push(`${marker} : aucun test Swift de ce nom`);
      if (kind === "garde" && !guards.includes(`test("${value} `)) faults.push(`${marker} : aucune garde de ce titre`);
    }
  }
  // La puce d'exception de palette ne prétend plus que le canevas iOS peint en HSB.
  if (/une seule peinture,\s+deux coques/.test(designSection(design, GRAPH_SECTION))) {
    faults.push("DESIGN.md : la puce de palette du graphe décrit encore la teinte HSB partagée");
  }
  // Une ligne vide précède chaque titre de section.
  if (/[^\n]\n## /.test(design)) faults.push("DESIGN.md : un titre de section sans ligne vide avant lui");
  return faults;
}

test("ios-statistiques-et-graphe-accessibles/AC-12 : DESIGN.md décrit la palette adaptative, VoiceOver et les étiquettes du graphe, chaque puce avec son marqueur prouvé", () => {
  const design = fs.readFileSync(DESIGN, "utf8");
  const swiftTests = swiftFiles(TESTS)
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const guards = fs.readFileSync(import.meta.filename, "utf8");
  assert.deepEqual(designFaults(design, swiftTests, guards), []);

  // Faute plantée : un marqueur retiré ⇒ rouge.
  const unmarked = plant(design, (s) => s.replace(" `[test: graphLabelsNeverOverlapAtOpeningScale]`", ""));
  assert.deepEqual(designFaults(unmarked, swiftTests, guards), [
    `DESIGN.md : marqueur absent de « ${GRAPH_SECTION} » : [test: graphLabelsNeverOverlapAtOpeningScale]`,
  ]);

  // Faute plantée : un marqueur vers un test Swift disparu ⇒ rouge.
  const orphan = plant(swiftTests, (s) =>
    s.replace("func graphLabelsNeverOverlapAtOpeningScale(", "func graphLabelsHidden("),
  );
  assert.deepEqual(designFaults(design, orphan, guards), [
    "[test: graphLabelsNeverOverlapAtOpeningScale] : aucun test Swift de ce nom",
  ]);

  // Faute plantée : un titre collé à la puce qui le précède ⇒ rouge.
  const glued = plant(design, (s) => s.replace("\n\n## Le mode graphe", "\n## Le mode graphe"));
  assert.ok(
    designFaults(glued, swiftTests, guards).some((f) => f.includes("ligne vide")),
    "un titre collé doit rougir",
  );

  // Faute plantée : l'ancienne puce de palette HSB revient ⇒ rouge.
  const hsb = plant(design, (s) => s.replace("aucune teinte HSB fixe.", "une seule peinture,\n  deux coques."));
  assert.ok(
    designFaults(hsb, swiftTests, guards).some((f) => f.includes("teinte HSB partagée")),
    "l'ancienne puce de palette doit rougir",
  );
});
