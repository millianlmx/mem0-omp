// Les GARDES TEXTUELLES de la feature `ios-statistiques-et-graphe-accessibles` : un
// test par critère `ios-statistiques-et-graphe-accessibles/AC-<n>`, et c'est le SEUL
// fichier qui porte ce slug (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source de l'app, de DESIGN.md et de la recette ;
// chaque faute est plantée EN MÉMOIRE (`source.replace(…)`) : aucune copie du dépôt,
// aucun SwiftUI rendu. Le comportement (barres, descripteurs, éléments VoiceOver,
// étiquettes décollées, palette résolue) est prouvé par les tests Swift
// d'OMPConsoleIOSTests ; la preuve visuelle est la recette de captures
// `scripts/ios-statistiques-graphe-recette.sh`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");
const TESTS = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOSTests");

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

/** Tous les `.swift` sous `dir`, chemins relatifs à `dir`. */
function swiftFiles(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((rel) => rel.endsWith(".swift")).sort();
}

// MARK: - Statistiques (S-2, S-3)

const CHARTS = "IOSStatsCharts.swift";
const STATS_SCREEN = "IOSStatsScreen.swift";
const BOARD_HEAD = "private var boardState";
const CHART_SECTIONS = "IOSStatsChartSections(";

/** Ce que le fichier des graphiques doit porter hors commentaire (S-2). */
const CHART_TOKENS = [
  "import Charts",
  "BarMark(",
  "StatsPresentation.durationChartTitle",
  "StatsPresentation.tokensChartTitle",
  "@ScaledMetric",
  ".foregroundStyle(by:",
];

/** AC-2 : deux graphiques Swift Charts, montés en tête du tableau, avant les sections des features. */
function chartsFaults(charts: string, screen: string): string[] {
  const faults: string[] = [];
  const code = stripComments(charts);
  for (const token of CHART_TOKENS) {
    if (!code.includes(token)) faults.push(`${CHARTS} : jeton absent « ${token} »`);
  }
  const board = memberBody(stripComments(screen), BOARD_HEAD);
  const mount = board.indexOf(CHART_SECTIONS);
  const features = board.indexOf("ForEach(payload.features");
  if (mount < 0) faults.push(`${STATS_SCREEN} : boardState ne monte pas ${CHART_SECTIONS}`);
  if (features < 0) faults.push(`${STATS_SCREEN} : boardState n'a plus le ForEach des features`);
  if (mount >= 0 && features >= 0 && mount > features) {
    faults.push(`${STATS_SCREEN} : les graphiques sont montés après les sections des features`);
  }
  return faults;
}

/** AC-3 : chaque graphique porte son descripteur d'accessibilité. */
function descriptorFaults(charts: string): string[] {
  const code = stripComments(charts);
  return ["duration", "tokens"]
    .filter((kind) => !code.includes(`.accessibilityChartDescriptor(IOSStatsChartDescriptor(kind: .${kind}`))
    .map((kind) => `${CHARTS} : le graphique .${kind} n'a pas de .accessibilityChartDescriptor`);
}

/** AC-4 : les graphiques ne sont montés que dans l'état tableau, jamais dans l'état vide ni ailleurs. */
function mountFaults(files: Map<string, string>): string[] {
  const faults: string[] = [];
  let total = 0;
  for (const [name, source] of files) {
    const n = count(stripComments(source), CHART_SECTIONS);
    total += n;
    if (n > 0 && name !== STATS_SCREEN) faults.push(`${name} : ${CHART_SECTIONS} monté hors de l'écran Statistiques`);
  }
  const screen = stripComments(files.get(STATS_SCREEN) ?? "");
  const inBoard = count(memberBody(screen, BOARD_HEAD), CHART_SECTIONS);
  if (inBoard !== 1) faults.push(`${STATS_SCREEN} : boardState monte ${inBoard} fois ${CHART_SECTIONS} (attendu 1)`);
  const inScreen = count(screen, CHART_SECTIONS);
  if (inScreen !== inBoard) faults.push(`${STATS_SCREEN} : ${CHART_SECTIONS} monté hors de boardState (${inScreen - inBoard} fois)`);
  if (total === 0) faults.push(`${CHART_SECTIONS} n'est monté nulle part`);
  return faults;
}

/** Les sources de l'app par chemin relatif (les fautes d'AC-4 s'y plantent). */
function appSources(): Map<string, string> {
  return new Map(swiftFiles(APP).map((rel) => [rel, appSource(rel)]));
}

test("ios-statistiques-et-graphe-accessibles/AC-2 : deux graphiques Swift Charts « Durée par feature » et « Tokens par feature » en tête du tableau, au-dessus des sections inchangées", () => {
  const charts = appSource(CHARTS);
  const screen = appSource(STATS_SCREEN);
  assert.deepEqual(chartsFaults(charts, screen), []);

  // Faute plantée : les graphiques passent sous les sections des features ⇒ rouge.
  const after = plant(screen, (s) =>
    s
      .replace(/\n\s*IOSStatsChartSections\(payload: payload, elapsedMs: model\.elapsedMs\(at:\)\)/, "")
      .replace(
        "cardSection(identifier: StatsAccessibility.total)",
        "IOSStatsChartSections(payload: payload, elapsedMs: model.elapsedMs(at:))\n            cardSection(identifier: StatsAccessibility.total)",
      ),
  );
  assert.ok(chartsFaults(charts, after).some((f) => f.includes("après les sections")), "des graphiques sous les sections doivent rougir");

  // Faute plantée : la hauteur ne suit plus Dynamic Type ⇒ rouge.
  const fixed = plant(charts, (s) => s.replaceAll("@ScaledMetric(relativeTo: .body) ", ""));
  assert.ok(chartsFaults(fixed, screen).some((f) => f.includes("@ScaledMetric")), "une hauteur figée doit rougir");

  // Faute plantée : plus de Swift Charts ⇒ rouge.
  const noCharts = plant(charts, (s) => s.replace("import Charts", "import SwiftUI"));
  assert.ok(chartsFaults(noCharts, screen).some((f) => f.includes("import Charts")), "un graphique sans Swift Charts doit rougir");
});

test("ios-statistiques-et-graphe-accessibles/AC-3 : chaque graphique porte un descripteur d'accessibilité (AXChartDescriptor)", () => {
  const charts = appSource(CHARTS);
  assert.deepEqual(descriptorFaults(charts), []);

  // Faute plantée : le descripteur des tokens retiré ⇒ rouge.
  const bare = plant(charts, (s) => s.replace(/\n\s*\.accessibilityChartDescriptor\(IOSStatsChartDescriptor\(kind: \.tokens[^\n]*/, ""));
  assert.deepEqual(descriptorFaults(bare), [`${CHARTS} : le graphique .tokens n'a pas de .accessibilityChartDescriptor`]);
});

test("ios-statistiques-et-graphe-accessibles/AC-4 : aucun graphique hors de l'état tableau, donc jamais un graphique vide", () => {
  const sources = appSources();
  assert.deepEqual(mountFaults(sources), []);

  // Faute plantée : les graphiques montés dans l'état vide ⇒ rouge.
  const empty = new Map(sources);
  empty.set(
    STATS_SCREEN,
    plant(sources.get(STATS_SCREEN)!, (s) =>
      s.replace(
        /(private var emptyState: some View \{\n\s*VStack\(alignment: \.leading, spacing: 8\) \{)/,
        "$1\n            IOSStatsChartSections(payload: model.payload!, elapsedMs: model.elapsedMs(at:))",
      ),
    ),
  );
  assert.ok(mountFaults(empty).some((f) => f.includes("hors de boardState")), "des graphiques dans l'état vide doivent rougir");

  // Faute plantée : les graphiques montés par un autre écran ⇒ rouge.
  const elsewhere = new Map(sources);
  elsewhere.set("IOSStatsContent.swift", `${sources.get("IOSStatsContent.swift")}\nlet stray = IOSStatsChartSections(payload: p, elapsedMs: { _ in 0 })\n`);
  assert.ok(mountFaults(elsewhere).some((f) => f.startsWith("IOSStatsContent.swift")), "des graphiques montés ailleurs doivent rougir");
});

// MARK: - Graphe de la Mémoire (S-4, S-5, S-6)

const GRAPH_VIEW = "IOSMemoryGraphView.swift";

/** AC-5 : le canevas expose un élément par nœud affiché, activable, avec les titres liés. */
const VOICEOVER_TOKENS = [".accessibilityChildren", "accessibilityElements(size:", ".accessibilityAction", ".accessibilityCustomContent("];

function voiceOverFaults(view: string): string[] {
  const code = stripComments(view);
  return VOICEOVER_TOKENS.filter((token) => !code.includes(token)).map((token) => `${GRAPH_VIEW} : jeton absent « ${token} »`);
}

/** AC-9 : le canevas peint la scène DÉCOLLÉE, jamais les textes bruts. */
function declutterFaults(view: string): string[] {
  return stripComments(view).includes("IOSMemoryGraphLabels.declutter(") ? [] : [`${GRAPH_VIEW} : le dessin n'appelle plus IOSMemoryGraphLabels.declutter(`];
}

test("ios-statistiques-et-graphe-accessibles/AC-5 : le graphe expose à VoiceOver un élément par souvenir et par nœud-étiquette, et non plus un seul élément pour tout le canevas", () => {
  const view = appSource(GRAPH_VIEW);
  assert.deepEqual(voiceOverFaults(view), []);

  // Faute plantée : le canevas redevient un élément unique ⇒ rouge.
  const opaque = plant(view, (s) => s.replace(".accessibilityChildren {", ".accessibilityElement(children: .ignore).background {"));
  assert.deepEqual(voiceOverFaults(opaque), [`${GRAPH_VIEW} : jeton absent « .accessibilityChildren »`]);

  // Faute plantée : les titres liés ne sont plus offerts ⇒ rouge.
  const mute = plant(view, (s) => s.replace("base.accessibilityCustomContent(", "base.accessibilityHint("));
  assert.ok(voiceOverFaults(mute).some((f) => f.includes("accessibilityCustomContent")), "des titres liés absents doivent rougir");
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
  const values = [...palette.matchAll(/static let \w+: (?:UIColor|\[UIColor\]) = (\[[^\]]*\]|[^\n]+)/g)].map((m) => m[1]);
  if (values.length < 4) faults.push(`${PALETTE} : ${values.length} couleur(s) déclarée(s), attendu les trois séries et les portées`);
  for (const value of values) {
    const members = [...value.matchAll(/\.(\w+)/g)].map((m) => m[1]);
    if (members.length === 0 || value.includes("(")) faults.push(`${PALETTE} : couleur non système « ${value.trim()} »`);
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
  const sources = appSources();
  assert.deepEqual(paletteFaults(sources), []);

  // Faute plantée : `Color(hue:` réintroduit dans le canevas ⇒ rouge.
  const hsb = new Map(sources);
  hsb.set(GRAPH_VIEW, plant(sources.get(GRAPH_VIEW)!, (s) => s.replace("Color(uiColor: IOSDataPalette.scope(hue: hue))", "Color(hue: hue, saturation: 0.8, brightness: 0.7)")));
  assert.ok(paletteFaults(hsb).some((f) => f.includes("« Color(hue: »")), "un Color(hue: doit rougir");

  // Faute plantée : une couleur fixe dans la palette ⇒ rouge.
  const fixed = new Map(sources);
  fixed.set(PALETTE, plant(sources.get(PALETTE)!, (s) => s.replace("= .systemBlue", "= UIColor(red: 0, green: 0.4, blue: 1, alpha: 1)")));
  assert.ok(paletteFaults(fixed).some((f) => f.includes("couleur non système")), "une couleur RVB fixe doit rougir");

  // Faute plantée : une couleur non système parmi les portées ⇒ rouge.
  const plain = new Map(sources);
  plain.set(PALETTE, plant(sources.get(PALETTE)!, (s) => s.replace(".systemBrown]", ".brown]")));
  assert.ok(paletteFaults(plain).some((f) => f.includes("« .brown »")), "une couleur non adaptative doit rougir");
});

// MARK: - Recette de captures (S-8)

const RECIPE = path.join(ROOT, "scripts", "ios-statistiques-graphe-recette.sh");

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

/** Le script sans ses commentaires `#` de ligne ni de fin de ligne (shell et Python). */
function stripHashComments(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/\s#\s.*$/, ""))
    .join("\n");
}

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
  assert.ok(recipeScriptFaults(kept).some((f) => f.includes("simctl delete")), "des simulateurs conservés doivent rougir");

  // Faute plantée : la construction n'est plus signée ⇒ rouge.
  const unsigned = plant(script, (s) => s.replaceAll("CODE_SIGN_IDENTITY=-", ""));
  assert.ok(recipeScriptFaults(unsigned).some((f) => f.includes("CODE_SIGN_IDENTITY=-")), "une app non signée doit rougir");

  // Faute plantée : le contraste accru sort de la matrice ⇒ rouge.
  const noContrast = plant(script, (s) => s.replaceAll("increase_contrast", "appearance"));
  assert.ok(recipeScriptFaults(noContrast).some((f) => f.includes("increase_contrast")), "une matrice sans contraste accru doit rougir");

  // Faute plantée : le graphe zoomé sort de la matrice ⇒ rouge.
  const noZoom = plant(script, (s) => s.replace('("-section", "memory", "-memoire.recipe", "zoom")', '("-section", "memory")'));
  assert.ok(recipeScriptFaults(noZoom).some((f) => f.includes("zoom")), "un lancement absent doit rougir");

  // Faute plantée : le Simulateur ouvert au premier plan, l'app Mac relancée, la PR fusionnée ⇒ rouge.
  for (const intrusion of ['open -a Simulator --args -CurrentDeviceUDID "$udid"', 'open "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"', "osascript -e 'quit app \"OMP Console\"'", "bash scripts/run-console.sh", "gh pr merge --squash"]) {
    const intrusive = plant(script, (s) => s.replace("trap cleanup EXIT", `trap cleanup EXIT\n${intrusion}`));
    assert.ok(recipeScriptFaults(intrusive).length > 0, `« ${intrusion} » doit rougir`);
  }

  // Simulator.app cité en commentaire reste admis (le script explique ce qu'il ne fait pas).
  assert.deepEqual(recipeScriptFaults(script.replace("trap cleanup EXIT", "# Simulator.app n'est jamais lancé.\ntrap cleanup EXIT")), []);
});

// MARK: - DESIGN.md (S-9)

const DESIGN = path.join(ROOT, "omp-console", "ios", "DESIGN.md");
const GRAPH_SECTION = "## Le mode graphe de la Mémoire (feature `ios-memoire-graphe`)";
const STATS_SECTION = "## La section Statistiques (feature `ios-statistiques`)";

/** Les marqueurs que chaque section doit porter (S-9), chacun prouvé par un test qui existe. */
const DESIGN_MARKERS: Record<string, string[]> = {
  [GRAPH_SECTION]: [
    "[test: paletteAdaptsToAppearanceAndContrast]",
    "[test: voiceOverExposesOneElementPerShownNode]",
    "[test: voiceOverActivatingAMemoryOpensItsSheet]",
    "[test: voiceOverActivatingATagFiltersAndOffersTheWholeGraph]",
    "[test: graphLabelsNeverOverlapAtOpeningScale]",
  ],
  [STATS_SECTION]: [
    "[test: statsChartsFollowTheListedFeatures]",
    "[test: statsChartsDescribeStackedTokens]",
    "[test: statsChartsHideWithoutData]",
    "[garde: ios-statistiques-et-graphe-accessibles/AC-2]",
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
      if (kind === "test" && !new RegExp(`func ${value}\\(`).test(swiftTests)) faults.push(`${marker} : aucun test Swift de ce nom`);
      if (kind === "garde" && !guards.includes(`test("${value} `)) faults.push(`${marker} : aucune garde de ce titre`);
    }
  }
  // La puce d'exception de palette ne prétend plus que le canevas iOS peint en HSB.
  if (/une seule peinture,\s+deux coques/.test(designSection(design, GRAPH_SECTION))) {
    faults.push("DESIGN.md : la puce de palette du graphe décrit encore la teinte HSB partagée");
  }
  // Une ligne vide sépare la section Statistiques de la suivante.
  if (!/\n\n## Sessions /.test(design)) faults.push("DESIGN.md : aucune ligne vide avant « ## Sessions »");
  return faults;
}

test("ios-statistiques-et-graphe-accessibles/AC-12 : DESIGN.md décrit les graphiques, la palette adaptative, VoiceOver et les étiquettes, chaque puce avec son marqueur prouvé", () => {
  const design = fs.readFileSync(DESIGN, "utf8");
  const swiftTests = swiftFiles(TESTS).map((rel) => fs.readFileSync(path.join(TESTS, rel), "utf8")).join("\n");
  const guards = fs.readFileSync(import.meta.filename, "utf8");
  assert.deepEqual(designFaults(design, swiftTests, guards), []);

  // Faute plantée : un marqueur retiré ⇒ rouge.
  const unmarked = plant(design, (s) => s.replace(" `[test: graphLabelsNeverOverlapAtOpeningScale]`", ""));
  assert.deepEqual(designFaults(unmarked, swiftTests, guards), [`DESIGN.md : marqueur absent de « ${GRAPH_SECTION} » : [test: graphLabelsNeverOverlapAtOpeningScale]`]);

  // Faute plantée : un marqueur vers un test Swift disparu ⇒ rouge.
  const orphan = plant(swiftTests, (s) => s.replace("func statsChartsHideWithoutData(", "func statsChartsHidden("));
  assert.deepEqual(designFaults(design, orphan, guards), ["[test: statsChartsHideWithoutData] : aucun test Swift de ce nom"]);

  // Faute plantée : l'ancienne puce de palette HSB revient ⇒ rouge.
  const hsb = plant(design, (s) => s.replace("aucune teinte HSB fixe.", "une seule peinture,\n  deux coques."));
  assert.ok(designFaults(hsb, swiftTests, guards).some((f) => f.includes("teinte HSB partagée")), "l'ancienne puce de palette doit rougir");
});
