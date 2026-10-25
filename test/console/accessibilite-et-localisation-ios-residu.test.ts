// Les GARDES TEXTUELLES de la feature `accessibilite-et-localisation-ios-residu` :
// c'est le SEUL fichier `test/*.test.ts` qui porte ce slug.
//
// Chaque garde lit les sources de l'app iOS (commentaires retirés) et rend une
// liste de fautes, vide sur le dépôt ; une faute PLANTÉE en mémoire (texte modifié,
// rien n'est écrit dans le dépôt) doit la faire rougir. Ce sont des gardes de FORME :
// ce que l'écran rend (cadres AX ≥ 44 × 44, identifiants uniques, éléments collés au
// bord) se prouve au simulateur par la recette idb des six sections
// (`scripts/recette/ios-recette-ui.sh`).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, tmpdir } from "../support/repo.ts";
import { declaredTexts, stripComments } from "../support/swift-source.ts";

const APP = path.join("omp-console", "ios", "OMPConsoleIOS");
const CORE = path.join("omp-console", "Sources", "ConsoleCore");

const HARNESS = path.join(APP, "IOSHarnessScreens.swift");
const MEMORY = path.join(APP, "IOSMemoryScreen.swift");
const GRAPH = path.join(APP, "IOSMemoryGraphView.swift");
const PIPELINE_TEXT = path.join(CORE, "Design", "PipelineServerText.swift");
const EXCEPTIONS = path.join("scripts", "recette", "ios-recette-ui-exceptions.json");
const ANALYSEUR = path.join(ROOT, "scripts", "recette", "ios-recette-ui-analyse.py");
const PBXPROJ = path.join("omp-console", "ios", "OMPConsoleIOS.xcodeproj", "project.pbxproj");
const INFO_PLIST = path.join("omp-console", "ios", "OMPConsoleIOS-Info.plist");
const ROOT_VIEW = path.join(APP, "RootView.swift");
const SHELL_TEXT = path.join(APP, "IOSShellText.swift");
const CONNECTION_STATE = path.join(APP, "Design", "IOSConnectionStateView.swift");

/** Les fichiers lus par les gardes, chemin relatif → texte. */
type Sources = Map<string, string>;

/** Les sources du dépôt (commentaires retirés pour le Swift, texte brut pour le JSON, le pbxproj et le plist). */
function repoSources(): Sources {
  const files = [HARNESS, MEMORY, GRAPH, PIPELINE_TEXT, ROOT_VIEW, SHELL_TEXT, CONNECTION_STATE];
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

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── AC-1 : symboles décoratifs muets (S-1) ─────────────────────────────────────

const DECORATIVE: Array<[string, string]> = [[HARNESS, "Image(systemName: IOSShellText.serverSymbol)"]];

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

/** Les boutons à symbole : le `Label` français, puis l'identifiant du contrôle. */
const MEANINGFUL: Array<{ name: string; label: string; anchor: string }> = [
  {
    name: "Serveur",
    label: "Label(PipelineServerText.open, systemImage: IOSShellText.serverSymbol)",
    anchor: '.accessibilityIdentifier("ios.server.open")',
  },
];

function meaningfulFaults(sources: Sources): string[] {
  const faults: string[] = [];
  const screen = get(sources, HARNESS);
  for (const { name, label, anchor } of MEANINGFUL) {
    if (!new RegExp(`${escapeRegex(label)}\\s*\\}\\s*${escapeRegex(anchor)}`).test(screen)) {
      faults.push(`IOSHarnessScreens : le bouton ${anchor} n'a plus ${label} pour libellé (${name})`);
    }
  }
  if (!screen.includes("Label(PipelineServerText.addFeature, systemImage: IOSShellText.addSymbol)")) {
    faults.push(
      "IOSHarnessScreens : « Ajouter une feature » n'a plus Label(PipelineServerText.addFeature, systemImage: IOSShellText.addSymbol) pour libellé",
    );
  }
  // La clé de `L10n.text` est le libellé français (localisation-apps) : il est lu
  // sous ses deux formes, littéral nu ou localisé.
  const words = declaredTexts(get(sources, PIPELINE_TEXT));
  if (words.get("open") !== "Serveur") faults.push("PipelineServerText.open n'est plus « Serveur »");
  if (words.get("addFeature") !== "Ajouter une feature")
    faults.push("PipelineServerText.addFeature n'est plus « Ajouter une feature »");
  return faults;
}

// ── AC-3 : identifiants de conteneur non propagés (S-3) ────────────────────────

const CONTAINERS: Array<[string, string]> = [
  [HARNESS, '.accessibilityIdentifier("ios.screen." + section.rawValue)'],
  [MEMORY, ".accessibilityIdentifier(IOSMemoryAccessibility.screen)"],
];

interface ExceptionEntry {
  regle: string;
  element: string;
}

function containerFaults(sources: Sources): string[] {
  const faults: string[] = [];
  for (const [rel, id] of CONTAINERS) {
    const pattern = new RegExp(`\\.accessibilityElement\\(children: \\.contain\\)\\s*${escapeRegex(id)}`);
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
  {
    name: "Se connecter",
    file: CONNECTION_STATE,
    label: "Text(IOSConnectionStateText.connect)",
    anchor: ".accessibilityIdentifier(IOSConnectionStateAccessibility.connect)",
  },
  {
    name: "Réessayer (Mémoire)",
    file: MEMORY,
    label: "Label(MemoryText.retry,",
    anchor: ".accessibilityIdentifier(IOSMemoryAccessibility.retry)",
  },
  {
    name: "Réessayer (page suivante)",
    file: MEMORY,
    label: "Label(MemoryText.retry,",
    anchor: ".accessibilityIdentifier(IOSMemoryAccessibility.moreRetry)",
  },
  {
    name: "Réessayer (graphe)",
    file: GRAPH,
    label: "Label(MemoryText.retry,",
    anchor: ".accessibilityIdentifier(IOSMemoryAccessibility.retry)",
  },
  {
    name: "Menu d'étiquettes du graphe",
    file: GRAPH,
    label: "Label(MemoryText.tagMenu,",
    anchor: ".accessibilityIdentifier(IOSMemoryAccessibility.graphTagMenu)",
  },
];

/** Le cadre de 44 pt du libellé : carré minimal, ou ligne pleine largeur d'au moins 44 pt de haut. */
const SHAPE = String.raw`[^{}]*?\.frame\((?:minWidth: IOSMetrics\.minimumTarget, minHeight: IOSMetrics\.minimumTarget|maxWidth: \.infinity, minHeight: IOSMetrics\.minimumTarget, alignment: \.leading)\)\s*\.contentShape\(Rectangle\(\)\)\s*\}`;

/** Les entrées d'exception que S-4 interdit désormais. */
const PROTECTED_S4: ExceptionEntry[] = [
  { regle: "cible-44", element: "id:ios.connexion.connect" },
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
    const labelAt = target.opens ? text.indexOf(target.label, anchorAt) : text.lastIndexOf(target.label, anchorAt);
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
    const shape = new RegExp(`^${escapeRegex(target.label)}${SHAPE}`).exec(segment);
    if (shape === null) {
      faults.push(
        `${target.name} : le libellé doit porter .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget) (ou une ligne .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)) puis .contentShape(Rectangle())`,
      );
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
    if (entry.regle === "cible-44" && PROTECTED_S4.some((p) => p.element === entry.element)) {
      faults.push(`${EXCEPTIONS} : une exception cible-44 subsiste sur ${entry.element}`);
    }
  }
  return faults;
}

/** Valide une liste d'exceptions par l'analyseur réel (`--valider-seulement`). */
function validate(entries: ExceptionEntry[]): { status: number | null; stderr: string } {
  const file = path.join(tmpdir("acces-loc-exceptions-"), "exceptions.json");
  const full = entries.map((e) => ({
    surface: "home",
    apparence: "clair",
    taille: "defaut",
    source: "ax",
    justification: "garde accessibilite-et-localisation-ios-residu",
    ...e,
  }));
  fs.writeFileSync(file, JSON.stringify(full));
  const r = spawnSync("python3", [ANALYSEUR, "analyser", "--exceptions", file, "--valider-seulement"], {
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("accessibilite-et-localisation-ios-residu/AC-1 : le symbole décoratif des écrans du serveur est masqué à VoiceOver", () => {
  const sources = repoSources();
  assert.deepEqual(decorativeFaults(sources), []);
  const planted = plant(
    sources,
    HARNESS,
    /(Image\(systemName: IOSShellText\.serverSymbol\)[\s\S]*?)\.accessibilityHidden\(true\)/,
    "$1",
  );
  assert.ok(
    decorativeFaults(planted).some((f) => f.includes("serverSymbol")),
    "un symbole décoratif lu par VoiceOver doit faire rougir la garde",
  );
});

test("accessibilite-et-localisation-ios-residu/AC-2 : « Serveur » et « Ajouter une feature » gardent leur libellé français, jamais le nom du symbole", () => {
  const sources = repoSources();
  assert.deepEqual(meaningfulFaults(sources), []);
  const icon = plant(
    sources,
    HARNESS,
    "Label(PipelineServerText.open, systemImage: IOSShellText.serverSymbol)",
    "Image(systemName: IOSShellText.serverSymbol)",
  );
  assert.ok(
    meaningfulFaults(icon).some((f) => f.includes("ios.server.open")),
    "un symbole nu sur « Serveur » doit faire rougir la garde",
  );
  const add = plant(
    sources,
    HARNESS,
    "Label(PipelineServerText.addFeature, systemImage: IOSShellText.addSymbol)",
    "Image(systemName: IOSShellText.addSymbol)",
  );
  assert.ok(
    meaningfulFaults(add).some((f) => f.includes("Ajouter une feature")),
    "un symbole nu sur « Ajouter une feature » doit faire rougir la garde",
  );
});

test("accessibilite-et-localisation-ios-residu/AC-3 : les identifiants d'écran du serveur et de la Mémoire ne se propagent plus à leurs enfants", () => {
  const sources = repoSources();
  assert.deepEqual(containerFaults(sources), []);
  const planted = plant(
    sources,
    HARNESS,
    /\.accessibilityElement\(children: \.contain\)(\s*\.accessibilityIdentifier\("ios\.screen\." \+ section\.rawValue\))/,
    "$1",
  );
  assert.ok(
    containerFaults(planted).some((f) => f.includes("ios.screen.")),
    "un écran du serveur sans .contain doit faire rougir la garde",
  );
  const memory = plant(
    sources,
    MEMORY,
    /\.accessibilityElement\(children: \.contain\)(\s*\.accessibilityIdentifier\(IOSMemoryAccessibility\.screen\))/,
    "$1",
  );
  assert.ok(
    containerFaults(memory).some((f) => f.includes("IOSMemoryAccessibility.screen")),
    "un écran Mémoire sans .contain doit faire rougir la garde",
  );
  const excepted = plant(sources, EXCEPTIONS, /^\[/, '[{"regle": "id-duplique", "element": "id:ios.memoire.screen"},');
  assert.ok(
    containerFaults(excepted).some((f) => f.includes("id:ios.memoire.screen")),
    "une exception sur ios.memoire.screen doit faire rougir la garde",
  );
});

test("accessibilite-et-localisation-ios-residu/AC-5 : Se connecter, Réessayer et le menu d'étiquettes portent une cible de 44 pt sur leur libellé", () => {
  const sources = repoSources();
  assert.deepEqual(targetFaults(sources), []);

  // La forme posée HORS du libellé (sur le Button) n'agrandit pas le cadre AX : refusée.
  const outside = plant(
    sources,
    CONNECTION_STATE,
    /Text\(IOSConnectionStateText\.connect\)\s*\.frame\(minWidth: IOSMetrics\.minimumTarget, minHeight: IOSMetrics\.minimumTarget\)\s*\.contentShape\(Rectangle\(\)\)\s*\}/,
    "Text(IOSConnectionStateText.connect)\n        }\n        .frame(minHeight: IOSMetrics.minimumTarget)",
  );
  assert.ok(
    targetFaults(outside).some((f) => f.startsWith("Se connecter")),
    "une cible posée sur le Button doit faire rougir la garde",
  );
  const menu = plant(
    sources,
    GRAPH,
    /(Label\(MemoryText\.tagMenu, systemImage: "tag"\)\s*\.frame\([^)]*\))\s*\.contentShape\(Rectangle\(\)\)/,
    "$1",
  );
  assert.ok(
    targetFaults(menu).some((f) => f.startsWith("Menu d'étiquettes")),
    "un menu sans forme de toucher doit faire rougir la garde",
  );
  const excepted = plant(sources, EXCEPTIONS, /^\[/, '[{"regle": "cible-44", "element": "id:ios.memoire.retry"},');
  assert.ok(
    targetFaults(excepted).some((f) => f.includes("id:ios.memoire.retry")),
    "une exception sur Réessayer doit faire rougir la garde",
  );

  // L'analyseur refuse désormais d'excepter un contrôle de S-4.
  for (const entry of PROTECTED_S4) {
    const r = validate([{ regle: "cible-44", element: "id:ios.server.open" }, entry]);
    assert.equal(r.status, 2, JSON.stringify(entry));
    assert.match(r.stderr, /^exception 2 interdite/, JSON.stringify(entry));
  }
  assert.equal(
    validate([{ regle: "cible-44", element: "id:ios.server.open" }]).status,
    0,
    "un voisin légitime reste permis",
  );
});

// ── AC-6 : retiré ──────────────────────────────────────────────────────────────
// L'app iOS n'est plus « française seulement » : elle est localisée en anglais
// (feature localisation-apps). Ses régions, ses CFBundleLocalizations et sa table
// anglaise sont gardés par `test/console/localisation-apps.test.ts`.

// ── AC-7 : nom « OMP Console » sous l'icône (S-6) ──────────────────────────────

const DISPLAY_NAME = 'INFOPLIST_KEY_CFBundleDisplayName = "OMP Console";';

/** Les blocs `XCBuildConfiguration` : nom (Debug/Release), bundle, réglages. */
function buildConfigurations(pbxproj: string): Array<{ name: string; bundle: string; body: string }> {
  const section =
    pbxproj.split("/* Begin XCBuildConfiguration section */")[1]?.split("/* End XCBuildConfiguration section */")[0] ??
    "";
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
  if (
    app
      .map((c) => c.name)
      .sort()
      .join(",") !== "Debug,Release"
  ) {
    faults.push(`la cible app doit avoir un bloc Debug et un bloc Release (lu : ${app.map((c) => c.name).join(", ")})`);
  }
  for (const config of configs) {
    const has = config.body.includes(DISPLAY_NAME);
    const isApp = config.bundle === "com.omp.console.ios";
    if (isApp && !has) faults.push(`bloc ${config.name} de la cible app sans ${DISPLAY_NAME}`);
    if (!isApp && has)
      faults.push(`bloc ${config.name} (${config.bundle || "projet"}) porte ${DISPLAY_NAME} hors de la cible app`);
  }
  return faults;
}

test("accessibilite-et-localisation-ios-residu/AC-7 : l'icône est légendée « OMP Console » par CFBundleDisplayName, Debug et Release de la cible app", () => {
  const sources = repoSources();
  assert.deepEqual(displayNameFaults(sources), []);

  const missing = plant(sources, PBXPROJ, `\t\t\t\t${DISPLAY_NAME}\n`, "");
  assert.ok(
    displayNameFaults(missing).some((f) => f.includes("sans")),
    "un bloc app sans nom affiché doit faire rougir la garde",
  );
  const tests = plant(
    sources,
    PBXPROJ,
    "PRODUCT_BUNDLE_IDENTIFIER = com.omp.console.ios.tests;",
    `PRODUCT_BUNDLE_IDENTIFIER = com.omp.console.ios.tests;\n\t\t\t\t${DISPLAY_NAME}`,
  );
  assert.ok(
    displayNameFaults(tests).some((f) => f.includes("hors de la cible app")),
    "le nom affiché dans la cible de tests doit faire rougir la garde",
  );
  const renamed = plant(sources, PBXPROJ, DISPLAY_NAME, 'INFOPLIST_KEY_CFBundleDisplayName = "OMPConsoleIOS";');
  assert.ok(displayNameFaults(renamed).length > 0, "un autre nom affiché doit faire rougir la garde");
});

// ── AC-8 / AC-9 : barre latérale titrée, rangées « Plus » aux chevrons du système (S-7) ──
// Depuis `ios-navigation-onglets-adaptables`, la racine est une barre d'onglets
// adaptable : le titre « OMP Console » vit dans l'en-tête de la barre latérale de
// l'iPad, et les seules rangées poussées par la racine sont celles de « Plus ».

/** Le bloc `{ … }` qui suit `marker` dans `text` (accolades équilibrées), ou null. */
function block(text: string, marker: string): string | null {
  const at = text.indexOf(marker);
  if (at === -1) return null;
  const open = text.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

const ROOT_TITLE = 'static let rootTitle = "OMP Console"';
const SIDEBAR_HEADER = ".tabViewSidebarHeader {";
const TITLE_TEXT = "Text(IOSShellText.rootTitle)";

function rootTitleFaults(sources: Sources): string[] {
  const faults: string[] = [];
  if (!get(sources, SHELL_TEXT).includes(ROOT_TITLE)) faults.push(`IOSShellText.swift ne déclare pas ${ROOT_TITLE}`);
  const root = get(sources, ROOT_VIEW);
  const titles = root.split(TITLE_TEXT).length - 1;
  if (titles !== 1) faults.push(`RootView.swift pose ${TITLE_TEXT} ${titles} fois (attendu : 1)`);
  const header = block(root, SIDEBAR_HEADER);
  if (header === null)
    return [...faults, `RootView.swift : l'en-tête de barre latérale ${SIDEBAR_HEADER} est introuvable`];
  if (!header.includes(TITLE_TEXT)) faults.push(`${TITLE_TEXT} n'est pas dans l'en-tête ${SIDEBAR_HEADER}`);
  return faults;
}

/** La rangée de « Plus » : un lien système qui enveloppe le `Label` de la section, identifié `ios.plus.<raw>`. */
const ROW = new RegExp(
  [
    String.raw`NavigationLink\(value: section\) \{`,
    String.raw`Label\(section\.title, systemImage: IOSSection\.systemImage\(of: section\)\)`,
    String.raw`\}`,
    String.raw`\.accessibilityIdentifier\("ios\.plus\." \+ section\.rawValue\)`,
  ].join(String.raw`\s*`),
);

function chevronFaults(sources: Sources): string[] {
  const faults: string[] = [];
  const root = get(sources, ROOT_VIEW);
  const plus = block(root, "var plusList");
  if (plus === null) return ["RootView.swift : la liste « Plus » (`var plusList`) est introuvable"];
  if (!plus.includes("NavigationLink(value: section)"))
    faults.push("la liste « Plus » n'enveloppe pas ses rangées dans NavigationLink(value: section)");
  else if (!ROW.test(plus))
    faults.push(
      "la rangée de « Plus » n'a pas la forme NavigationLink { Label } .accessibilityIdentifier(ios.plus.<raw>)",
    );
  if (/chevron/i.test(root)) faults.push("RootView.swift dessine un chevron à la main : c'est le système qui les rend");
  return faults;
}

test("accessibilite-et-localisation-ios-residu/AC-8 : la barre latérale de l'iPad porte le titre « OMP Console »", () => {
  const sources = repoSources();
  assert.deepEqual(rootTitleFaults(sources), []);

  const removed = plant(sources, ROOT_VIEW, TITLE_TEXT, "Text(IOSShellText.plusTitle)");
  assert.ok(
    rootTitleFaults(removed).some((f) => f.includes("fois")),
    "un titre retiré doit faire rougir la garde",
  );
  const renamed = plant(sources, SHELL_TEXT, ROOT_TITLE, 'static let rootTitle = "OMPConsoleIOS"');
  assert.ok(
    rootTitleFaults(renamed).some((f) => f.startsWith("IOSShellText.swift")),
    "un autre titre doit faire rougir la garde",
  );
  const elsewhere = plant(
    plant(
      sources,
      ROOT_VIEW,
      /(\.tabViewSidebarHeader \{\s*)Text\(IOSShellText\.rootTitle\)/,
      "$1Text(IOSShellText.plusTitle)",
    ),
    ROOT_VIEW,
    ".navigationTitle(IOSShellText.plusTitle)",
    `.navigationTitle(IOSShellText.plusTitle)\n        .overlay { ${TITLE_TEXT} }`,
  );
  assert.ok(
    rootTitleFaults(elsewhere).some((f) => f.includes("en-tête")),
    "un titre posé hors de l'en-tête de la barre latérale doit faire rougir la garde",
  );
});

test("accessibilite-et-localisation-ios-residu/AC-9 : les rangées de « Plus » sont des NavigationLink sans chevron dessiné", () => {
  const sources = repoSources();
  assert.deepEqual(chevronFaults(sources), []);

  const bare = plant(sources, ROOT_VIEW, /NavigationLink\(value: section\) \{\s*(Label\([^\n]*\))\s*\}/, "$1");
  assert.ok(
    chevronFaults(bare).some((f) => f.includes("n'enveloppe pas")),
    "une rangée sans lien doit faire rougir la garde",
  );
  const oldId = plant(sources, ROOT_VIEW, '"ios.plus." + section.rawValue', '"ios.section." + section.rawValue');
  assert.ok(
    chevronFaults(oldId).some((f) => f.includes("forme")),
    "une rangée à l'identifiant de l'ancienne liste racine doit faire rougir la garde",
  );
  const drawn = plant(
    sources,
    ROOT_VIEW,
    /(Label\(section\.title, systemImage: IOSSection\.systemImage\(of: section\)\))/,
    '$1\nImage(systemName: "chevron.right")',
  );
  assert.ok(
    chevronFaults(drawn).some((f) => f.includes("à la main")),
    "un chevron dessiné à la main doit faire rougir la garde",
  );
});
