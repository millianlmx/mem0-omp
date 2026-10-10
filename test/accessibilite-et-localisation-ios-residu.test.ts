// Les GARDES TEXTUELLES de la feature `accessibilite-et-localisation-ios-residu` :
// c'est le SEUL fichier `test/*.test.ts` qui porte ce slug.
//
// Chaque garde lit les sources de l'app iOS (commentaires retirés) et rend une
// liste de fautes, vide sur le dépôt ; une faute PLANTÉE en mémoire (texte modifié,
// rien n'est écrit dans le dépôt) doit la faire rougir. Ce sont des gardes de FORME :
// ce que l'écran rend (éléments `Image` absents de `idb ui describe-all`, cadres AX
// ≥ 44 × 44, identifiants uniques) se prouve au simulateur par
// `scripts/ios-accessibilite-localisation-recette.sh` et par la recette des 8 surfaces.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = path.join("omp-console", "ios", "OMPConsoleIOS");
const CORE = path.join("omp-console", "Sources", "ConsoleCore");

const HOME_VIEW = path.join(APP, "HomeView.swift");
const WELCOME = path.join(APP, "HomeWelcomeSheet.swift");
const PIPELINES = path.join(APP, "PipelinesScreen.swift");
const CARD_SHEET = path.join(APP, "PipelinesCardSheet.swift");
const CARD_RECIPE = path.join(APP, "PipelinesCardRecipe.swift");
const PIPELINES_TEXT = path.join(APP, "PipelinesText.swift");
const PLAN = path.join(APP, "IOSProjectPlanView.swift");
const PROJECT = path.join(APP, "IOSProjectScreen.swift");
const SECTION_VIEW = path.join(APP, "IOSSectionView.swift");
const MEMORY = path.join(APP, "IOSMemoryScreen.swift");
const GRAPH = path.join(APP, "IOSMemoryGraphView.swift");
const KANBAN_TEXT = path.join(CORE, "Kanban", "KanbanText.swift");
const NEW_FEATURE_TEXT = path.join(CORE, "Kanban", "NewFeatureText.swift");
const EXCEPTIONS = path.join("scripts", "ios-recette-ui-exceptions.json");
const ANALYSEUR = path.join(ROOT, "scripts", "ios-recette-ui-analyse.py");
const PBXPROJ = path.join("omp-console", "ios", "OMPConsoleIOS.xcodeproj", "project.pbxproj");
const INFO_PLIST = path.join("omp-console", "ios", "OMPConsoleIOS-Info.plist");
const ROOT_VIEW = path.join(APP, "RootView.swift");
const HOME_TEXT = path.join(APP, "IOSHomeText.swift");

/** Les fichiers lus par les gardes, chemin relatif → texte. */
type Sources = Map<string, string>;

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let inBlock = false;
  while (i < text.length) {
    if (inBlock) {
      if (text.startsWith("*/", i)) {
        inBlock = false;
        i += 2;
      } else i += 1;
      continue;
    }
    if (text.startsWith("//", i)) {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline;
      continue;
    }
    if (text.startsWith("/*", i)) {
      inBlock = true;
      i += 2;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** Les sources du dépôt (commentaires retirés pour le Swift, texte brut pour le JSON, le pbxproj et le plist). */
function repoSources(): Sources {
  const files = [
    HOME_VIEW, WELCOME, PIPELINES, CARD_SHEET, CARD_RECIPE, PIPELINES_TEXT, PLAN, PROJECT,
    SECTION_VIEW, MEMORY, GRAPH, KANBAN_TEXT, NEW_FEATURE_TEXT, ROOT_VIEW, HOME_TEXT,
  ];
  const sources: Sources = new Map();
  for (const rel of files) sources.set(rel, stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8")));
  for (const rel of [EXCEPTIONS, PBXPROJ, INFO_PLIST]) sources.set(rel, fs.readFileSync(path.join(ROOT, rel), "utf8"));
  return sources;
}

function get(sources: Sources, rel: string): string {
  const text = sources.get(rel);
  assert.ok(text !== undefined, `source non chargée : ${rel}`);
  return text;
}

/** Une copie des sources où `from` est remplacé par `to` dans `rel` ; la faute doit exister. */
function plant(sources: Sources, rel: string, from: string | RegExp, to: string): Sources {
  const before = get(sources, rel);
  const after = before.replace(from, to);
  assert.notEqual(after, before, `la faute ne peut pas être plantée : « ${String(from)} » est absent de ${rel}`);
  const copy = new Map(sources);
  copy.set(rel, after);
  return copy;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── AC-1 : symboles décoratifs muets (S-1) ─────────────────────────────────────

const DECORATIVE: Array<[string, string]> = [
  [HOME_VIEW, "Image(systemName: IOSHomeText.natureSymbol(attention.nature))"],
  [WELCOME, "Image(systemName: promise.symbol)"],
  [PIPELINES, "Image(systemName: row.lane.symbol)"],
];

function decorativeFaults(sources: Sources): string[] {
  const faults: string[] = [];
  for (const [rel, image] of DECORATIVE) {
    const text = get(sources, rel);
    const at = text.indexOf(image);
    if (at === -1) {
      faults.push(`${rel} : ${image} est introuvable`);
      continue;
    }
    const following = text.slice(at).split("\n").slice(1, 4).join("\n");
    if (!following.includes(".accessibilityHidden(true)")) {
      faults.push(`${rel} : ${image} n'est pas suivi de .accessibilityHidden(true) à moins de 4 lignes`);
    }
  }
  return faults;
}

// ── AC-2 : symboles porteurs de sens libellés en français (S-2) ────────────────

function meaningfulFaults(sources: Sources): string[] {
  const faults: string[] = [];
  const screen = get(sources, PIPELINES);
  const start = screen.indexOf("private var refreshButton");
  const end = start === -1 ? -1 : screen.indexOf(".accessibilityIdentifier(PipelinesAccessibility.refresh)", start);
  if (start === -1 || end === -1) {
    faults.push("PipelinesScreen.refreshButton ou son identifiant pipelines.refresh est introuvable");
  } else if (!screen.slice(start, end).includes(".accessibilityLabel(KanbanText.refresh)")) {
    faults.push("PipelinesScreen.refreshButton : .accessibilityLabel(KanbanText.refresh) manque sur le Button");
  }
  if (!/Label\(NewFeatureText\.command, systemImage: "plus"\)\s*\}\s*\.accessibilityIdentifier\(PipelinesAccessibility\.newFeature\)/.test(screen)) {
    faults.push("PipelinesScreen : le bouton pipelines.newFeature n'a plus Label(NewFeatureText.command, systemImage: \"plus\") pour libellé");
  }
  if (!get(sources, KANBAN_TEXT).includes('public static let refresh = "Rafraîchir"')) {
    faults.push("KanbanText.refresh n'est plus « Rafraîchir »");
  }
  if (!get(sources, NEW_FEATURE_TEXT).includes('public static let command = "Nouvelle feature\u2026"')) {
    faults.push("NewFeatureText.command n'est plus « Nouvelle feature… » (ellipse U+2026)");
  }
  return faults;
}

// ── AC-3 : identifiants de conteneur non propagés (S-3) ────────────────────────

const CONTAINERS: Array<[string, string]> = [
  [PIPELINES, ".accessibilityIdentifier(PipelinesAccessibility.screen)"],
  [MEMORY, ".accessibilityIdentifier(IOSMemoryAccessibility.screen)"],
  [PROJECT, ".accessibilityIdentifier(ProjectAccessibility.screen)"],
  [SECTION_VIEW, '.accessibilityIdentifier("ios.screen." + section.rawValue)'],
];

interface ExceptionEntry {
  regle: string;
  element: string;
}

function containerFaults(sources: Sources): string[] {
  const faults: string[] = [];
  for (const [rel, id] of CONTAINERS) {
    const pattern = new RegExp(`\\.accessibilityElement\\(children: \\.contain\\)\\s*${escape(id)}`);
    if (!pattern.test(get(sources, rel))) {
      faults.push(`${rel} : .accessibilityElement(children: .contain) doit précéder immédiatement ${id}`);
    }
  }
  for (const entry of JSON.parse(get(sources, EXCEPTIONS)) as ExceptionEntry[]) {
    if (entry.element === "id:ios.memoire.screen") {
      faults.push(`${EXCEPTIONS} : une exception ${entry.regle} subsiste sur id:ios.memoire.screen`);
    }
  }
  return faults;
}

// ── AC-4 : un identifiant par carte, crochet `ardoise` (S-3) ───────────────────

function cardFaults(sources: Sources): string[] {
  const faults: string[] = [];
  if (!get(sources, PIPELINES_TEXT).includes('static let recipeArdoise = "ardoise"')) {
    faults.push('PipelinesText.recipeArdoise = "ardoise" manque');
  }
  const recipe = get(sources, CARD_RECIPE);
  if (!recipe.includes("case PipelinesText.recipeArdoise: return .ardoise")) {
    faults.push("PipelinesCardRecipe.named ne reconnaît pas `ardoise`");
  }
  if (!/var card: KanbanCard\? \{ self == \.ardoise \? nil : Self\.fixtureCard \}/.test(recipe)) {
    faults.push("PipelinesCardRecipe.card doit être nil pour `ardoise` (aucune fiche ne s'ouvre)");
  }
  const screen = get(sources, PIPELINES);
  if (!screen.includes("board: cardRecipe?.forcedBoard ?? PipelinesModel.boardState(of: client, nowMs: Self.nowMs)")) {
    faults.push("PipelinesScreen.screenState n'utilise pas l'ardoise de fixture du crochet `ardoise`");
  }
  if (!/if cardRecipe\.forcedBoard != nil \{[^}]*cardRecipe\.announce\(\)/.test(screen)) {
    faults.push("PipelinesScreen.onAppear n'annonce pas le crochet `ardoise` (signal pipelines-recipe-ready)");
  }
  if (!/Button \{ sheet = \.card\(card\.id\) \} label: \{\s*cardLabel\(card, showsRepo: showsRepo\)\s*\}\s*\.buttonStyle\(\.plain\)\s*\.accessibilityIdentifier\(PipelinesAccessibility\.card\(card\.id\)\)/.test(screen)) {
    faults.push("PipelinesScreen.cardButton : le corps de carte ne porte plus .accessibilityIdentifier(PipelinesAccessibility.card(card.id))");
  }
  const text = get(sources, PIPELINES_TEXT);
  if (!text.includes('static func card(_ id: String) -> String { "pipelines.card.\\(id)" }')) {
    faults.push("PipelinesAccessibility.card ne rend plus pipelines.card.<id>, distinct de pipelines.lane.<voie>");
  }
  return faults;
}

// ── AC-5 : cibles de 44 pt portées par le libellé (S-4) ────────────────────────

interface Target {
  name: string;
  file: string;
  /** Le début du libellé, tel qu'écrit dans le source. */
  label: string;
  /** L'identifiant qui clôt l'expression du contrôle, ou l'ouverture d'un `Link`. */
  anchor: string;
  /** Vrai quand `anchor` est l'ouverture du contrôle (le libellé suit), faux quand c'est son identifiant (le libellé précède). */
  opens?: boolean;
}

const TARGETS: Target[] = [
  { name: "Se connecter", file: HOME_VIEW, label: "Text(IOSHomeText.connect)", anchor: ".accessibilityIdentifier(IOSHomeAccessibility.connect)" },
  { name: "Ouvrir la PR (Accueil)", file: HOME_VIEW, label: "Text(HomeText.openPR)", anchor: ".accessibilityIdentifier(IOSHomeAccessibility.deliveredOpen(card.id))" },
  { name: "Ouvrir la PR (carte Pipelines)", file: PIPELINES, label: "Text(HomeText.openPR)", anchor: ".accessibilityIdentifier(PipelinesAccessibility.gesture(HomeText.openPR, card.id))" },
  { name: "Ouvrir la PR (fiche de carte)", file: CARD_SHEET, label: "Text(HomeText.openPR)", anchor: ".accessibilityIdentifier(PipelinesAccessibility.gesture(HomeText.openPR, card.id))" },
  { name: "Ouvrir la PR (plan Projet)", file: PLAN, label: "Text(ProjectViewText.prOpen)", anchor: "Link(destination: link) {", opens: true },
  { name: "Réessayer (Mémoire)", file: MEMORY, label: "Label(MemoryText.retry,", anchor: ".accessibilityIdentifier(IOSMemoryAccessibility.retry)" },
  { name: "Réessayer (page suivante)", file: MEMORY, label: "Label(MemoryText.retry,", anchor: ".accessibilityIdentifier(IOSMemoryAccessibility.moreRetry)" },
  { name: "Réessayer (graphe)", file: GRAPH, label: "Label(MemoryText.retry,", anchor: ".accessibilityIdentifier(IOSMemoryAccessibility.retry)" },
  { name: "Menu d'étiquettes du graphe", file: GRAPH, label: "Label(MemoryText.tagMenu,", anchor: ".accessibilityIdentifier(IOSMemoryAccessibility.graphTagMenu)" },
];

const SHAPE = String.raw`[^{}]*?\.frame\(minWidth: IOSMetrics\.minimumTarget, minHeight: IOSMetrics\.minimumTarget\)\s*\.contentShape\(Rectangle\(\)\)\s*\}`;

/** Les entrées d'exception que S-4 interdit désormais. */
const PROTECTED_S4: ExceptionEntry[] = [
  { regle: "cible-44", element: "id:ios.home.delivered.open.feature:ade5316c34182862:terminee" },
  { regle: "cible-44", element: "id:ios.home.connect" },
  { regle: "cible-44", element: "id:ios.memoire.retry" },
  { regle: "cible-44", element: "id:ios.memoire.graphe.etiquette" },
  { regle: "id-duplique", element: "id:ios.memoire.screen" },
];

function targetFaults(sources: Sources): string[] {
  const faults: string[] = [];
  for (const target of TARGETS) {
    const text = get(sources, target.file);
    const anchorAt = text.indexOf(target.anchor);
    if (anchorAt === -1 || text.indexOf(target.anchor, anchorAt + 1) !== -1) {
      faults.push(`${target.name} : ${target.anchor} doit apparaître exactement une fois dans ${target.file}`);
      continue;
    }
    const labelAt = target.opens
      ? text.indexOf(target.label, anchorAt)
      : text.lastIndexOf(target.label, anchorAt);
    if (labelAt === -1) {
      faults.push(`${target.name} : le libellé ${target.label} est introuvable près de ${target.anchor}`);
      continue;
    }
    // DANS son label : le libellé ouvre la fermeture `label: { … }` d'un Button/Menu, ou celle d'un Link.
    if (!/(label:\s*\{|Link\(destination: link\)\s*\{)\s*$/.test(text.slice(0, labelAt))) {
      faults.push(`${target.name} : ${target.label} n'est pas le libellé d'un Button, d'un Menu ou d'un Link`);
      continue;
    }
    const segment = target.opens ? text.slice(labelAt) : text.slice(labelAt, anchorAt);
    const shape = new RegExp(`^${escape(target.label)}${SHAPE}`).exec(segment);
    if (shape === null) {
      faults.push(`${target.name} : le libellé doit porter .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget) puis .contentShape(Rectangle())`);
      continue;
    }
    if (!target.opens) {
      const outside = segment.slice(shape[0].length);
      if (outside.includes(".frame(") || outside.includes(".contentShape(")) {
        faults.push(`${target.name} : un cadre ou une forme de toucher est posé sur le contrôle, hors de son libellé`);
      }
    }
  }
  for (const entry of JSON.parse(get(sources, EXCEPTIONS)) as ExceptionEntry[]) {
    if (entry.regle === "cible-44" && /^id:ios\.home\.delivered\.open\..+$/.test(entry.element)) {
      faults.push(`${EXCEPTIONS} : une exception cible-44 subsiste sur ${entry.element}`);
    }
  }
  return faults;
}

/** Valide une liste d'exceptions par l'analyseur réel (`--valider-seulement`). */
function validate(entries: ExceptionEntry[]): { status: number | null; stderr: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acces-loc-exceptions-"));
  try {
    const file = path.join(dir, "exceptions.json");
    const full = entries.map((e) => ({
      surface: "home",
      apparence: "clair",
      taille: "defaut",
      source: "ax",
      justification: "garde accessibilite-et-localisation-ios-residu",
      ...e,
    }));
    fs.writeFileSync(file, JSON.stringify(full));
    const r = spawnSync("python3", [ANALYSEUR, "analyser", "--exceptions", file, "--valider-seulement"], { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("accessibilite-et-localisation-ios-residu/AC-1 : les symboles décoratifs de l'Accueil, de la Bienvenue et des Pipelines sont masqués à VoiceOver", () => {
  const sources = repoSources();
  assert.deepEqual(decorativeFaults(sources), []);
  const planted = plant(sources, WELCOME, /(Image\(systemName: promise\.symbol\)[\s\S]*?)\.accessibilityHidden\(true\)/, "$1");
  assert.ok(decorativeFaults(planted).some((f) => f.includes("promise.symbol")), "un symbole de promesse lu par VoiceOver doit faire rougir la garde");
  const lane = plant(sources, PIPELINES, /(Image\(systemName: row\.lane\.symbol\)[\s\S]*?)\.accessibilityHidden\(true\)/, "$1");
  assert.ok(decorativeFaults(lane).some((f) => f.includes("row.lane.symbol")), "un symbole de voie lu par VoiceOver doit faire rougir la garde");
});

test("accessibilite-et-localisation-ios-residu/AC-2 : Rafraîchir et Nouvelle feature… gardent leur libellé français, jamais le nom du symbole", () => {
  const sources = repoSources();
  assert.deepEqual(meaningfulFaults(sources), []);
  const planted = plant(sources, PIPELINES, ".accessibilityLabel(KanbanText.refresh)", "");
  assert.ok(meaningfulFaults(planted).some((f) => f.includes("refreshButton")), "un Rafraîchir sans libellé doit faire rougir la garde");
  const icon = plant(sources, PIPELINES, 'Label(NewFeatureText.command, systemImage: "plus")', 'Image(systemName: "plus")');
  assert.ok(meaningfulFaults(icon).some((f) => f.includes("pipelines.newFeature")), "un symbole nu sur Nouvelle feature… doit faire rougir la garde");
});

test("accessibilite-et-localisation-ios-residu/AC-3 : les identifiants d'écran Pipelines, Mémoire et Projet ne se propagent plus à leurs enfants", () => {
  const sources = repoSources();
  assert.deepEqual(containerFaults(sources), []);
  const planted = plant(
    sources,
    PIPELINES,
    /\.accessibilityElement\(children: \.contain\)(\s*\.accessibilityIdentifier\(PipelinesAccessibility\.screen\))/,
    "$1",
  );
  assert.ok(containerFaults(planted).some((f) => f.includes("PipelinesAccessibility.screen")), "un écran Pipelines sans .contain doit faire rougir la garde");
  const memory = plant(
    sources,
    MEMORY,
    /\.accessibilityElement\(children: \.contain\)(\s*\.accessibilityIdentifier\(IOSMemoryAccessibility\.screen\))/,
    "$1",
  );
  assert.ok(containerFaults(memory).some((f) => f.includes("IOSMemoryAccessibility.screen")), "un écran Mémoire sans .contain doit faire rougir la garde");
  const excepted = plant(sources, EXCEPTIONS, /^\[/, '[{"regle": "id-duplique", "element": "id:ios.memoire.screen"},');
  assert.ok(containerFaults(excepted).some((f) => f.includes("id:ios.memoire.screen")), "une exception sur ios.memoire.screen doit faire rougir la garde");
});

test("accessibilite-et-localisation-ios-residu/AC-4 : chaque carte de Pipelines porte son identifiant propre, et le crochet ardoise les montre sans appairage", () => {
  const sources = repoSources();
  assert.deepEqual(cardFaults(sources), []);
  const planted = plant(sources, CARD_RECIPE, "case PipelinesText.recipeArdoise: return .ardoise", "");
  assert.ok(cardFaults(planted).some((f) => f.includes("ardoise")), "un crochet ardoise non reconnu doit faire rougir la garde");
  const shared = plant(
    sources,
    PIPELINES,
    ".accessibilityIdentifier(PipelinesAccessibility.card(card.id))",
    ".accessibilityIdentifier(PipelinesAccessibility.lane(card.id))",
  );
  assert.ok(cardFaults(shared).some((f) => f.includes("corps de carte")), "un corps de carte sans identifiant propre doit faire rougir la garde");
});

test("accessibilite-et-localisation-ios-residu/AC-5 : Ouvrir la PR, Se connecter, Réessayer et le menu d'étiquettes portent une cible de 44 pt sur leur libellé", () => {
  const sources = repoSources();
  assert.deepEqual(targetFaults(sources), []);

  // La forme posée HORS du libellé (sur le Button) n'agrandit pas le cadre AX : refusée.
  const outside = plant(
    sources,
    HOME_VIEW,
    /Text\(IOSHomeText\.connect\)\s*\.frame\(minWidth: IOSMetrics\.minimumTarget, minHeight: IOSMetrics\.minimumTarget\)\s*\.contentShape\(Rectangle\(\)\)\s*\}/,
    "Text(IOSHomeText.connect)\n                }\n                .frame(minHeight: IOSMetrics.minimumTarget)",
  );
  assert.ok(targetFaults(outside).some((f) => f.startsWith("Se connecter")), "une cible posée sur le Button doit faire rougir la garde");
  const menu = plant(sources, GRAPH, /(Label\(MemoryText\.tagMenu, systemImage: "tag"\)\s*\.frame\([^)]*\))\s*\.contentShape\(Rectangle\(\)\)/, "$1");
  assert.ok(targetFaults(menu).some((f) => f.startsWith("Menu d'étiquettes")), "un menu sans forme de toucher doit faire rougir la garde");
  const excepted = plant(
    sources,
    EXCEPTIONS,
    /^\[/,
    '[{"regle": "cible-44", "element": "id:ios.home.delivered.open.feature:ade5316c34182862:terminee"},',
  );
  assert.ok(targetFaults(excepted).some((f) => f.includes("ios.home.delivered.open")), "une exception sur Ouvrir la PR doit faire rougir la garde");

  // L'analyseur refuse désormais d'excepter un contrôle de S-4.
  for (const entry of PROTECTED_S4) {
    const r = validate([{ regle: "cible-44", element: "id:ios.home.root" }, entry]);
    assert.equal(r.status, 2, JSON.stringify(entry));
    assert.match(r.stderr, /^exception 2 interdite/, JSON.stringify(entry));
  }
  assert.equal(validate([{ regle: "cible-44", element: "id:ios.home.root" }]).status, 0, "un voisin légitime reste permis");
});

// ── AC-6 : app française seulement (S-5) ───────────────────────────────────────

/** Les `.lproj`, `.xcstrings` et `.strings` sous `omp-console/ios`, chemins relatifs. */
function localizationArtifacts(): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (/\.(lproj|xcstrings|strings)$/.test(entry.name)) found.push(child);
      else if (entry.isDirectory()) walk(child);
    }
  };
  walk(path.join("omp-console", "ios"));
  return found;
}

function languageFaults(sources: Sources, artifacts: string[]): string[] {
  const faults: string[] = [];
  const pbxproj = get(sources, PBXPROJ);
  const regions = [...pbxproj.matchAll(/^\s*developmentRegion = ([^;]+);$/gm)].map((m) => m[1]);
  if (regions.length !== 1 || regions[0] !== "fr") {
    faults.push(`developmentRegion doit valoir fr une seule fois (lu : ${regions.join(", ") || "absent"})`);
  }
  const known = pbxproj.match(/^\s*knownRegions = \(([^)]*)\);$/m);
  const knownList = known ? known[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (knownList.join(",") !== "fr,Base") faults.push(`knownRegions doit valoir (fr, Base) (lu : ${knownList.join(", ") || "absent"})`);
  if (/CFBundleLocalizations/.test(pbxproj) || /CFBundleLocalizations/.test(get(sources, INFO_PLIST))) {
    faults.push("CFBundleLocalizations ne doit pas être déclaré");
  }
  for (const artifact of artifacts) faults.push(`fichier de localisation interdit : ${artifact}`);
  return faults;
}

test("accessibilite-et-localisation-ios-residu/AC-6 : l'app iOS est française seulement (developmentRegion fr, aucune région en)", () => {
  const sources = repoSources();
  const artifacts = localizationArtifacts();
  assert.deepEqual(languageFaults(sources, artifacts), []);

  const english = plant(sources, PBXPROJ, "developmentRegion = fr;", "developmentRegion = en;");
  assert.ok(languageFaults(english, artifacts).some((f) => f.startsWith("developmentRegion")), "developmentRegion en doit faire rougir la garde");
  const known = plant(sources, PBXPROJ, /(knownRegions = \(\s*)fr,/, "$1en,\n\t\t\t\tfr,");
  assert.ok(languageFaults(known, artifacts).some((f) => f.startsWith("knownRegions")), "une région en doit faire rougir la garde");
  const plist = plant(sources, INFO_PLIST, "<dict>", "<dict>\n\t<key>CFBundleLocalizations</key>\n\t<array><string>en</string></array>");
  assert.ok(languageFaults(plist, artifacts).some((f) => f.includes("CFBundleLocalizations")), "CFBundleLocalizations doit faire rougir la garde");
  assert.ok(
    languageFaults(sources, [path.join(APP, "en.lproj")]).some((f) => f.includes("en.lproj")),
    "un .lproj doit faire rougir la garde",
  );
});

// ── AC-7 : nom « OMP Console » sous l'icône (S-6) ──────────────────────────────

const DISPLAY_NAME = 'INFOPLIST_KEY_CFBundleDisplayName = "OMP Console";';

/** Les blocs `XCBuildConfiguration` : nom (Debug/Release), bundle, réglages. */
function buildConfigurations(pbxproj: string): Array<{ name: string; bundle: string; body: string }> {
  const section = pbxproj.split("/* Begin XCBuildConfiguration section */")[1]?.split("/* End XCBuildConfiguration section */")[0] ?? "";
  const out: Array<{ name: string; bundle: string; body: string }> = [];
  for (const match of section.matchAll(/[0-9A-F]{24} \/\*[^*]*\*\/ = \{([\s\S]*?)\n\t\t\};/g)) {
    const body = match[1];
    out.push({
      name: body.match(/^\s*name = ([^;]+);$/m)?.[1] ?? "?",
      bundle: body.match(/^\s*PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);$/m)?.[1] ?? "",
      body,
    });
  }
  return out;
}

function displayNameFaults(sources: Sources): string[] {
  const faults: string[] = [];
  const pbxproj = get(sources, PBXPROJ);
  const total = pbxproj.split(DISPLAY_NAME).length - 1;
  if (total !== 2) faults.push(`${DISPLAY_NAME} doit apparaître exactement 2 fois (lu : ${total})`);
  const configs = buildConfigurations(pbxproj);
  const app = configs.filter((c) => c.bundle === "com.omp.console.ios");
  if (app.map((c) => c.name).sort().join(",") !== "Debug,Release") {
    faults.push(`la cible app doit avoir un bloc Debug et un bloc Release (lu : ${app.map((c) => c.name).join(", ")})`);
  }
  for (const config of configs) {
    const has = config.body.includes(DISPLAY_NAME);
    const isApp = config.bundle === "com.omp.console.ios";
    if (isApp && !has) faults.push(`bloc ${config.name} de la cible app sans ${DISPLAY_NAME}`);
    if (!isApp && has) faults.push(`bloc ${config.name} (${config.bundle || "projet"}) porte ${DISPLAY_NAME} hors de la cible app`);
  }
  return faults;
}

test("accessibilite-et-localisation-ios-residu/AC-7 : l'icône est légendée « OMP Console » par CFBundleDisplayName, Debug et Release de la cible app", () => {
  const sources = repoSources();
  assert.deepEqual(displayNameFaults(sources), []);

  const missing = plant(sources, PBXPROJ, `\t\t\t\t${DISPLAY_NAME}\n`, "");
  assert.ok(displayNameFaults(missing).some((f) => f.includes("sans")), "un bloc app sans nom affiché doit faire rougir la garde");
  const tests = plant(
    sources,
    PBXPROJ,
    "PRODUCT_BUNDLE_IDENTIFIER = com.omp.console.ios.tests;",
    `PRODUCT_BUNDLE_IDENTIFIER = com.omp.console.ios.tests;\n\t\t\t\t${DISPLAY_NAME}`,
  );
  assert.ok(displayNameFaults(tests).some((f) => f.includes("hors de la cible app")), "le nom affiché dans la cible de tests doit faire rougir la garde");
  const renamed = plant(sources, PBXPROJ, DISPLAY_NAME, 'INFOPLIST_KEY_CFBundleDisplayName = "OMPConsoleIOS";');
  assert.ok(displayNameFaults(renamed).length > 0, "un autre nom affiché doit faire rougir la garde");
});

// ── AC-8 / AC-9 : liste racine titrée, chevrons du système (S-7) ───────────────

/** Le segment barre latérale de `RootView` : du `NavigationSplitView {` au `} detail: {`. */
function sidebarSegment(sources: Sources): string | null {
  const root = get(sources, ROOT_VIEW);
  const start = root.indexOf("NavigationSplitView {");
  const end = root.indexOf("} detail: {");
  return start === -1 || end === -1 || end < start ? null : root.slice(start, end);
}

const ROOT_TITLE = 'static let rootTitle = "OMP Console"';
const NAVIGATION_TITLE = ".navigationTitle(IOSHomeText.rootTitle)";

function rootTitleFaults(sources: Sources): string[] {
  const faults: string[] = [];
  if (!get(sources, HOME_TEXT).includes(ROOT_TITLE)) faults.push(`IOSHomeText.swift ne déclare pas ${ROOT_TITLE}`);
  const sidebar = sidebarSegment(sources);
  if (sidebar === null) return [...faults, "RootView.swift : le segment barre latérale est introuvable"];
  const titles = sidebar.split(NAVIGATION_TITLE).length - 1;
  if (titles !== 1) faults.push(`la barre latérale pose ${NAVIGATION_TITLE} ${titles} fois (attendu : 1)`);
  if (!/\n\s*\}\s*\.navigationTitle\(IOSHomeText\.rootTitle\)/.test(sidebar)) {
    faults.push(`${NAVIGATION_TITLE} n'est pas posé sur la List, juste après sa fermeture`);
  }
  return faults;
}

/**
 * La rangée : le lien enveloppe le `Label` et son `.badge` ; `.tag` puis la chaîne AX
 * de #100, dans cet ordre, suivent le lien.
 */
const ROW = new RegExp(
  [
    String.raw`NavigationLink\(value: section\) \{`,
    String.raw`Label\(section\.title, systemImage: IOSSection\.systemImage\(of: section\)\)`,
    String.raw`\.badge\(badge\)`,
    String.raw`\}`,
    String.raw`\.tag\(section\)`,
    String.raw`\.accessibilityElement\(children: \.ignore\)`,
    String.raw`\.accessibilityLabel\(IOSHomeText\.sectionRowLabel\(section\.title, badge: badge\)\)`,
    String.raw`\.accessibilityAddTraits\(\.isButton\)`,
    String.raw`\.accessibilityIdentifier\("ios\.section\." \+ section\.rawValue\)`,
  ].join(String.raw`\s*`),
);

function chevronFaults(sources: Sources): string[] {
  const faults: string[] = [];
  const sidebar = sidebarSegment(sources);
  if (sidebar === null) return ["RootView.swift : le segment barre latérale est introuvable"];
  if (!sidebar.includes("NavigationLink(value: section)")) faults.push("la barre latérale n'enveloppe pas ses rangées dans NavigationLink(value: section)");
  else if (!ROW.test(sidebar)) faults.push("la rangée n'a pas la forme NavigationLink { Label.badge } .tag + chaîne AX ios.section.<raw>");
  if (/chevron/i.test(get(sources, ROOT_VIEW))) faults.push("RootView.swift dessine un chevron à la main : c'est le système qui les rend");
  return faults;
}

test("accessibilite-et-localisation-ios-residu/AC-8 : la liste racine porte le titre de navigation « OMP Console » (IOSHomeText.rootTitle)", () => {
  const sources = repoSources();
  assert.deepEqual(rootTitleFaults(sources), []);

  const removed = plant(sources, ROOT_VIEW, NAVIGATION_TITLE, "");
  assert.ok(rootTitleFaults(removed).some((f) => f.includes("fois")), "un titre retiré doit faire rougir la garde");
  const renamed = plant(sources, HOME_TEXT, ROOT_TITLE, 'static let rootTitle = "OMPConsoleIOS"');
  assert.ok(rootTitleFaults(renamed).some((f) => f.startsWith("IOSHomeText.swift")), "un autre titre doit faire rougir la garde");
  const onDetail = plant(
    plant(sources, ROOT_VIEW, NAVIGATION_TITLE, ""),
    ROOT_VIEW,
    "} detail: {",
    `} detail: {\n            EmptyView()${NAVIGATION_TITLE}`,
  );
  assert.ok(rootTitleFaults(onDetail).length > 0, "un titre posé sur le détail et non sur la barre latérale doit faire rougir la garde");
});

test("accessibilite-et-localisation-ios-residu/AC-9 : chaque rangée est un NavigationLink(value: section), chevrons rendus par le système et aucun dessiné à la main", () => {
  const sources = repoSources();
  assert.deepEqual(chevronFaults(sources), []);

  const bare = plant(sources, ROOT_VIEW, /NavigationLink\(value: section\) \{\s*(Label\([^\n]*\))\s*(\.badge\(badge\))\s*\}/, "$1\n$2");
  assert.ok(chevronFaults(bare).some((f) => f.includes("n'enveloppe pas")), "une rangée sans lien doit faire rougir la garde");
  const tagInside = plant(sources, ROOT_VIEW, /(\.badge\(badge\))(\s*\})\s*\.tag\(section\)/, "$1\n.tag(section)$2");
  assert.ok(chevronFaults(tagInside).some((f) => f.includes("forme")), "un .tag posé dans le lien doit faire rougir la garde");
  const drawn = plant(sources, ROOT_VIEW, ".badge(badge)", '.badge(badge)\nImage(systemName: "chevron.right")');
  assert.ok(chevronFaults(drawn).some((f) => f.includes("à la main")), "un chevron dessiné à la main doit faire rougir la garde");
});
