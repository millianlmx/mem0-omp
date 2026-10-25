// Garde de la feature `localisation-apps` : les apps OMP Console (Mac, iOS et son
// widget) s'affichent en anglais sur un appareil réglé en anglais, en français
// sinon. C'est le SEUL fichier de test qui porte ce slug (invariant `criteria/AC-13`).
//
// Le mécanisme (omp-console/Sources/ConsoleCore/Design/L10n.swift) : un texte se lit
// par `L10n.text("<phrase française>")` ou `L10n.format("<phrase à trous>", …)` ; la
// clé est la phrase française, la traduction vit dans UNE table anglaise,
// `ConsoleCore/Resources/en.lproj/Localizable.strings`. Ces gardes prouvent ce que
// le compilateur ne voit pas : que chaque clé des sources a sa traduction (AC-1),
// que la table est bien formée (AC-2), qu'aucun texte visible d'un `*Text.swift`
// n'échappe à `L10n` (AC-3), que les apps se DÉCLARENT localisées (AC-4), que le
// bundle Mac embarque la table (AC-5) et que les tests iOS tournent en français
// (AC-6). Ce que rend Foundation (la table lue, la langue choisie) se prouve en Swift
// Testing : `omp-console/Tests/OMPConsoleTests/LocalisationTests.swift` et
// `omp-console/ios/OMPConsoleIOSTests/IOSLocalisationTests.swift`.
//
// Chaque test vérifie d'abord l'arbre réel, puis plante une faute EN MÉMOIRE (ou
// dans une copie jetable) et vérifie que la garde la voit.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { INTERPOLATION_MARK, stripComments, swiftSourceTree, swiftTextUnits } from "../support/swift-source.ts";
import { RESOURCE_STRINGS_REL, montageAppIntents } from "../support/swift-app-doubles.ts";
import { montageIosBuild } from "../support/ios-build-doubles.ts";

const TABLE = "omp-console/Sources/ConsoleCore/Resources/en.lproj/Localizable.strings";
const L10N = "omp-console/Sources/ConsoleCore/Design/L10n.swift";
const PACKAGE = "omp-console/Package.swift";
const MAC_PLIST = "omp-console/Bundle/Info.plist";
const MAC_INFOPLIST_STRINGS = "omp-console/Bundle/en.lproj/InfoPlist.strings";
const PBXPROJ = "omp-console/ios/OMPConsoleIOS.xcodeproj/project.pbxproj";
const IOS_PLIST = "omp-console/ios/OMPConsoleIOS-Info.plist";
const WIDGET_PLIST = "omp-console/ios/OMPConsoleWidgets-Info.plist";
const SCHEME = "omp-console/ios/OMPConsoleIOS.xcodeproj/xcshareddata/xcschemes/OMPConsoleIOS.xcscheme";

/** Les sources des apps (les suites de tests Swift exclues : leurs clés ne sont pas des textes de l'app). */
const ROOTS = [
  "omp-console/Sources/ConsoleCore",
  "omp-console/Sources/ConsoleClient",
  "omp-console/Sources/OMPConsole",
  "omp-console/ios/OMPConsoleIOS",
  "omp-console/ios/OMPConsoleWidgets",
] as const;

const NBSP = " ";
const NNBSP = " ";
const HAS_LETTER = /[A-Za-zÀ-ÿ]/;

// ── La table `.strings` ────────────────────────────────────────────────────────

type Table = { entries: Map<string, string>; faults: string[] };

/**
 * Lit une table `.strings` au format texte d'Apple : des entrées `"clé" = "valeur";`,
 * des commentaires `/* … *\/` et `//`, les échappements `\"`, `\\`, `\n`, `\t` et
 * `\Uxxxx`. Rend les entrées (la première d'une clé l'emporte) et les fautes de forme.
 */
function parseStrings(text: string): Table {
  const entries = new Map<string, string>();
  const faults: string[] = [];
  let i = 0;
  const skip = (): void => {
    while (i < text.length) {
      if (/\s/.test(text[i] ?? "")) i += 1;
      else if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        i = end === -1 ? text.length : end + 2;
      } else if (text.startsWith("//", i)) {
        const end = text.indexOf("\n", i);
        i = end === -1 ? text.length : end + 1;
      } else return;
    }
  };
  const quoted = (): string | null => {
    if (text[i] !== '"') return null;
    i += 1;
    let out = "";
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\n") faults.push(`saut de ligne brut dans une chaîne (octet ${i})`);
      if (text[i] === "\\") {
        const c = text[i + 1];
        if (c === "n") out += "\n";
        else if (c === "t") out += "\t";
        else if (c === '"' || c === "\\") out += c;
        else if ((c === "U" || c === "u") && /^[0-9A-Fa-f]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        } else faults.push(`échappement inconnu \\${c ?? ""} (octet ${i})`);
        i += 2;
        continue;
      }
      out += text[i];
      i += 1;
    }
    if (i >= text.length) {
      faults.push("chaîne non fermée");
      return null;
    }
    i += 1;
    return out;
  };
  for (;;) {
    skip();
    if (i >= text.length) break;
    const key = quoted();
    if (key === null) {
      faults.push(`entrée illisible (octet ${i})`);
      break;
    }
    skip();
    if (text[i] !== "=") {
      faults.push(`« = » attendu après « ${key} »`);
      break;
    }
    i += 1;
    skip();
    const value = quoted();
    if (value === null) {
      faults.push(`valeur illisible pour « ${key} »`);
      break;
    }
    skip();
    if (text[i] !== ";") {
      faults.push(`« ; » attendu après la valeur de « ${key} »`);
      break;
    }
    i += 1;
    if (entries.has(key)) faults.push(`clé en double : « ${key} »`);
    else entries.set(key, value);
  }
  return { entries, faults };
}

/** Les trous d'une phrase, dans l'ordre des arguments : `1:@`, `2:lld`… (`%%` n'en est pas un). */
function holes(text: string): string[] {
  const out: string[] = [];
  let implicit = 0;
  for (const m of text.matchAll(/%(?:(\d+)\$)?(@|lld|%)/g)) {
    if (m[2] === "%") continue;
    const position = m[1] === undefined ? ++implicit : Number(m[1]);
    out.push(`${position}:${m[2]}`);
  }
  return out.sort();
}

/** Vrai si la phrase porte un `%` qui n'est ni `%@`, ni `%lld`, ni `%%` (positionnels compris). */
function strayPercent(text: string): boolean {
  return text.replace(/%(?:\d+\$)?(?:@|lld)|%%/g, "").includes("%");
}

// ── Les clés des sources ───────────────────────────────────────────────────────

type Use = { file: string; line: number; key: string; call: "text" | "format"; interpolated: boolean };

/** Chaque appel `L10n.text("…")` / `L10n.format("…", …)` des sources, clé résolue. */
function keyUses(sources: Map<string, string>): Use[] {
  const uses: Use[] = [];
  for (const [file, source] of sources) {
    if (file === L10N) continue;
    for (const unit of swiftTextUnits(source)) {
      if (unit.localized === null) continue;
      uses.push({
        file,
        line: unit.line,
        key: unit.text,
        call: unit.localized,
        interpolated: unit.text.includes(INTERPOLATION_MARK),
      });
    }
  }
  return uses;
}

const show = (text: string): string => text.replaceAll("\n", "\\n");

/** AC-1 : chaque clé des sources a sa traduction, chaque entrée de la table sert. */
function coverageFaults(sources: Map<string, string>, table: string): string[] {
  const { entries } = parseStrings(table);
  const uses = keyUses(sources);
  const faults: string[] = [];
  if (uses.length === 0) faults.push("aucun appel L10n dans les sources : la garde ne lit plus rien");
  const used = new Set<string>();
  for (const use of uses) {
    used.add(use.key);
    if (use.interpolated) faults.push(`${use.file}:${use.line} : clé interpolée « ${show(use.key)} »`);
    else if (!entries.has(use.key))
      faults.push(`${use.file}:${use.line} : « ${show(use.key)} » sans traduction anglaise`);
  }
  for (const key of entries.keys()) {
    if (!used.has(key)) faults.push(`${TABLE} : entrée orpheline « ${show(key)} »`);
  }
  return faults;
}

/** AC-2 : la table se lit, chaque valeur est une vraie phrase anglaise aux mêmes trous que sa clé. */
function tableFaults(sources: Map<string, string>, table: string): string[] {
  const { entries, faults: parse } = parseStrings(table);
  const faults = parse.map((f) => `${TABLE} : ${f}`);
  if (entries.size === 0) faults.push(`${TABLE} : table vide`);
  const calls = new Map<string, Set<string>>();
  for (const use of keyUses(sources)) {
    if (!calls.has(use.key)) calls.set(use.key, new Set());
    calls.get(use.key)?.add(use.call);
  }
  for (const [key, value] of entries) {
    const at = `${TABLE} « ${show(key)} »`;
    if (value.trim() === "") faults.push(`${at} : traduction vide`);
    if (holes(key).join(",") !== holes(value).join(","))
      faults.push(
        `${at} : trous ${holes(key).join(",") || "aucun"} ≠ ${holes(value).join(",") || "aucun"} dans « ${show(value)} »`,
      );
    if (strayPercent(key) || strayPercent(value)) faults.push(`${at} : « % » nu (écrire %% ou %@, %lld)`);
    if (value.includes(NBSP) || value.includes(NNBSP) || /[«»]/.test(value))
      faults.push(`${at} : typographie française dans la traduction « ${show(value)} »`);
    const kinds = calls.get(key) ?? new Set<string>();
    if (kinds.has("text") && holes(key).length > 0)
      faults.push(`${at} : trou dans une clé de L10n.text, jamais rempli`);
    if (kinds.has("format") && holes(key).length === 0) faults.push(`${at} : L10n.format sans trou (L10n.text suffit)`);
  }
  return faults;
}

// ── AC-3 : aucun texte visible d'un *Text.swift n'échappe à L10n ──────────────

/** Les racines des fichiers de vocabulaire (celles de la garde typographique). */
const TEXT_ROOTS = ROOTS.slice(0, 4);

/** Une déclaration en tête de ligne : `func`, `let` ou `var`, modificateurs compris. */
const DECLARATION =
  /^\s*(?:(?:public|private|fileprivate|internal|static|nonisolated|override|@MainActor)\s+)*(?:func|let|var)\s+([A-Za-z_]\w*)/;

/** Le nom de la déclaration la plus proche au-dessus de la ligne `line` (incluse). */
function scopeOf(lines: string[], line: number): string | null {
  for (let k = line - 1; k >= 0; k -= 1) {
    const m = DECLARATION.exec(lines[k] ?? "");
    if (m) return m[1] ?? null;
  }
  return null;
}

/**
 * Un littéral alphabétique d'un `*Text.swift` laissé hors de `L10n`, sans être un
 * identifiant. Restent permis sans entrée : un identifiant d'accessibilité ou un
 * drapeau de lancement (`ios.…`, `-…`), un symbole SF (constante ou fonction
 * `…Symbol`, `systemImage`), un drapeau de recette (`…Recipe…`) et le détail
 * technique d'un diagnostic copiable (`…Diagnostic`), joint tel quel à un signalement.
 */
const GENERIC = /Symbol$|^systemImage$|Recipe|Diagnostic$/;

/** Les textes laissés en français à dessein, chacun nommé par son fichier et sa déclaration (ou son littéral). */
type Untranslated = { file: string; reason: string } & ({ name: string } | { literal: string });

const UNTRANSLATED: readonly Untranslated[] = [
  ...["stepReq", "stepSpecs", "stepImpl", "stepReview"].map((name) => ({
    file: "omp-console/Sources/ConsoleCore/Design/PipelineServerText.swift",
    name,
    reason: "nom de commande d'une étape (/req, /specs…), le même dans toutes les langues",
  })),
  ...["chainsPrompt", "providerNamePrompt", "providerModelsPrompt"].map((name) => ({
    file: "omp-console/Sources/ConsoleCore/Design/PipelineServerText.swift",
    name,
    reason: "exemple de saisie (identifiants de modèle ou de fournisseur)",
  })),
  {
    file: "omp-console/Sources/ConsoleCore/Design/PipelineServerText.swift",
    name: "providerKind",
    reason: "noms de marque des fournisseurs",
  },
  {
    file: "omp-console/Sources/OMPConsole/Terminal/TerminalViewText.swift",
    name: "ompKind",
    reason: "nom du programme",
  },
  { file: "omp-console/ios/OMPConsoleIOS/IOSShellText.swift", name: "rootTitle", reason: "nom de l'app" },
  ...["title", "description", "appShortcuts"].map((name) => ({
    file: "omp-console/ios/OMPConsoleIOS/IOSSiriText.swift",
    name,
    reason: "App Intents : littéraux extraits au build, figés par scripts/app-intents/attendus.json",
  })),
  {
    file: "omp-console/Sources/OMPConsole/Setup/SetupText.swift",
    literal: "code \\(code)",
    reason: "sujet technique du détail replié (code de sortie)",
  },
  ...["\\(value) s", "\\(value / 60) min", "\\(value / 3600) h \\(value % 3600 / 60) min"].map((literal) => ({
    file: "omp-console/Sources/ConsoleCore/Design/PipelineServerText.swift",
    literal,
    reason: "unités abrégées (s, min, h), les mêmes en anglais",
  })),
  {
    file: "omp-console/Sources/ConsoleCore/Memory/MemoryText.swift",
    name: "decimal",
    reason: "format numérique (%.2f), le séparateur suit la locale",
  },
  {
    file: "omp-console/Sources/ConsoleClient/HarnessFailureText.swift",
    name: "stepKinds",
    reason: "codes d'étape du serveur",
  },
  ...["refreshKey", "searchKey"].map((name) => ({
    file: "omp-console/ios/OMPConsoleIOS/IOSKeyboardText.swift",
    name,
    reason: "touche d'un raccourci clavier",
  })),
];

/** AC-3 : les littéraux alphabétiques des `*Text.swift` hors de `L10n`, moins les identifiants et les exceptions. */
function escapeFaults(sources: Map<string, string>, untranslated: readonly Untranslated[]): string[] {
  const faults: string[] = [];
  const used = new Set<Untranslated>();
  let scanned = 0;
  for (const [file, source] of sources) {
    if (!TEXT_ROOTS.some((base) => file.startsWith(`${base}/`)) || !path.posix.basename(file).endsWith("Text.swift"))
      continue;
    scanned += 1;
    const lines = source.split("\n");
    for (const unit of swiftTextUnits(source)) {
      if (unit.localized !== null) continue;
      const words = unit.text.replaceAll(INTERPOLATION_MARK, "");
      if (!HAS_LETTER.test(words)) continue;
      if (unit.text.startsWith("ios.") || unit.text.startsWith("-")) continue;
      // Un motif de `case` est un code du serveur, jamais un texte affiché.
      const lineText = lines[unit.line - 1] ?? "";
      const at = lineText.indexOf(`"${unit.raw}"`);
      if (at !== -1 && /^\s*case\b[^:]*$/.test(lineText.slice(0, at))) continue;
      const name = unit.constant ?? scopeOf(lines, unit.line);
      if (name !== null && GENERIC.test(name)) continue;
      const exempt = untranslated.filter(
        (u) => u.file === file && (("name" in u && u.name === name) || ("literal" in u && u.literal === unit.raw)),
      );
      if (exempt.length > 0) {
        for (const u of exempt) used.add(u);
        continue;
      }
      faults.push(`${file}:${unit.line} « ${unit.raw} » (${name ?? "hors déclaration"}) : texte visible hors de L10n`);
    }
  }
  if (scanned === 0) faults.push("aucun *Text.swift lu : la garde ne lit plus rien");
  for (const u of untranslated) {
    if (!used.has(u)) faults.push(`${u.file} : exception orpheline ${"name" in u ? u.name : u.literal}`);
  }
  // Une clé est toujours un littéral : l'API n'accepte qu'un `StaticString`.
  const api = stripComments(sources.get(L10N) ?? "");
  for (const signature of ["func text(_ key: StaticString", "func format(_ key: StaticString"]) {
    if (!api.includes(signature)) faults.push(`${L10N} : ${signature} absent (une clé doit être un littéral)`);
  }
  return faults;
}

// ── AC-4 : les apps se déclarent localisées ────────────────────────────────────

/** Les chaînes du tableau `<key>` d'un plist XML, ou `null` s'il n'y est pas. */
function plistArray(plist: string, key: string): string[] | null {
  const m = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(plist);
  return m ? [...(m[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((s) => s[1] ?? "") : null;
}

function plistString(plist: string, key: string): string | null {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1] ?? null;
}

/** AC-4 : le français reste la langue de développement, l'anglais est déclaré partout où il se choisit. */
function declarationFaults(files: Map<string, string>): string[] {
  const faults: string[] = [];
  const read = (rel: string): string => files.get(rel) ?? "";

  const manifest = stripComments(read(PACKAGE));
  if (!/defaultLocalization:\s*"fr"/.test(manifest)) faults.push(`${PACKAGE} : defaultLocalization "fr" absent`);
  if (!/\.target\(\s*name:\s*"ConsoleCore"[^)]*resources:\s*\[\s*\.process\("Resources"\)\s*\]/.test(manifest))
    faults.push(`${PACKAGE} : la cible ConsoleCore ne déclare pas .process("Resources")`);
  if (!files.has(TABLE)) faults.push(`${TABLE} absente`);

  const mac = read(MAC_PLIST);
  if (plistString(mac, "CFBundleDevelopmentRegion") !== "fr")
    faults.push(`${MAC_PLIST} : CFBundleDevelopmentRegion ≠ fr`);
  for (const [rel, plist] of [
    [MAC_PLIST, mac],
    [IOS_PLIST, read(IOS_PLIST)],
    [WIDGET_PLIST, read(WIDGET_PLIST)],
  ] as const) {
    const localizations = plistArray(plist, "CFBundleLocalizations");
    if (localizations?.join(",") !== "fr,en")
      faults.push(
        `${rel} : CFBundleLocalizations doit valoir (fr, en) (lu : ${localizations?.join(", ") ?? "absent"})`,
      );
  }
  if (!/"NSLocalNetworkUsageDescription"\s*=/.test(read(MAC_INFOPLIST_STRINGS)))
    faults.push(`${MAC_INFOPLIST_STRINGS} : NSLocalNetworkUsageDescription non traduite`);

  const pbxproj = read(PBXPROJ);
  const regions = [...pbxproj.matchAll(/^\s*developmentRegion = ([^;]+);$/gm)].map((m) => m[1]);
  if (regions.join(",") !== "fr")
    faults.push(
      `${PBXPROJ} : developmentRegion doit valoir fr une seule fois (lu : ${regions.join(", ") || "absent"})`,
    );
  const known = /^\s*knownRegions = \(([^)]*)\);$/m.exec(pbxproj)?.[1] ?? "";
  const knownList = known
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (knownList.join(",") !== "fr,en,Base")
    faults.push(`${PBXPROJ} : knownRegions doit valoir (fr, en, Base) (lu : ${knownList.join(", ") || "absent"})`);
  return faults;
}

// ── Arbre réel ─────────────────────────────────────────────────────────────────

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const SOURCES = swiftSourceTree(ROOT, ROOTS);
const TABLE_TEXT = read(TABLE);
const DECLARED = new Map(
  [PACKAGE, MAC_PLIST, MAC_INFOPLIST_STRINGS, PBXPROJ, IOS_PLIST, WIDGET_PLIST, TABLE].map((rel) => [rel, read(rel)]),
);

/** Une copie des sources où `from` (présent) est remplacé par `to` dans `file`. */
function plant(sources: Map<string, string>, file: string, from: string, to: string): Map<string, string> {
  const before = sources.get(file) ?? "";
  assert.ok(before.includes(from), `faute impossible à planter : « ${from} » absent de ${file}`);
  const copy = new Map(sources);
  copy.set(file, before.replace(from, to));
  return copy;
}

const MEMORY_TEXT = "omp-console/Sources/ConsoleCore/Memory/MemoryText.swift";
const MONITORING_TEXT = "omp-console/Sources/ConsoleCore/Design/MonitoringText.swift";

test("localisation-apps/AC-1 : chaque clé L10n des sources a sa traduction anglaise, et chaque entrée de la table sert", () => {
  assert.deepEqual(coverageFaults(SOURCES, TABLE_TEXT), []);
  assert.ok(keyUses(SOURCES).length > 500, "les textes des deux apps passent par L10n");

  const untranslated = plant(
    SOURCES,
    MEMORY_TEXT,
    'L10n.text("Tous les projets")',
    'L10n.text("Tous les projets du monde")',
  );
  const faults = coverageFaults(untranslated, TABLE_TEXT);
  assert.ok(
    faults.some((f) => f.includes("« Tous les projets du monde » sans traduction anglaise")),
    "une clé sans traduction doit faire rougir la garde",
  );
  assert.ok(
    faults.some((f) => f.includes("entrée orpheline « Tous les projets »")),
    "une entrée que plus rien ne lit doit faire rougir la garde",
  );
  const interpolated = plant(SOURCES, MONITORING_TEXT, 'L10n.format("Lu à %@", time)', 'L10n.format("Lu à \\(time)")');
  assert.ok(
    coverageFaults(interpolated, TABLE_TEXT).some((f) => f.includes("clé interpolée")),
    "une clé interpolée doit faire rougir la garde",
  );
});

test("localisation-apps/AC-2 : la table anglaise se lit, sans doublon ni valeur vide, chaque traduction garde les trous de sa clé, sans typographie française", () => {
  assert.deepEqual(tableFaults(SOURCES, TABLE_TEXT), []);

  const lost = TABLE_TEXT.replace('= "Read at %@";', '= "Read at";');
  assert.notEqual(lost, TABLE_TEXT);
  assert.ok(
    tableFaults(SOURCES, lost).some((f) => f.includes("« Lu à %@ »") && f.includes("trous")),
    "un trou perdu doit faire rougir la garde",
  );
  const french = TABLE_TEXT.replace('= "All Projects";', `= "Tous${NBSP}: projets";`);
  assert.ok(
    tableFaults(SOURCES, french).some((f) => f.includes("typographie française")),
    "une valeur à la typographie française doit faire rougir la garde",
  );
  const doubled = `${TABLE_TEXT}"Tous les projets" = "Every Project";\n`;
  assert.ok(
    tableFaults(SOURCES, doubled).some((f) => f.includes("clé en double")),
    "une clé en double doit faire rougir la garde",
  );
  const broken = TABLE_TEXT.replace('= "All Projects";', '= "All Projects"');
  assert.ok(
    tableFaults(SOURCES, broken).some((f) => f.includes("« ; » attendu")),
    "une entrée mal fermée doit faire rougir la garde",
  );
  const empty = TABLE_TEXT.replace('= "All Projects";', '= "";');
  assert.ok(
    tableFaults(SOURCES, empty).some((f) => f.includes("traduction vide")),
    "une traduction vide doit faire rougir la garde",
  );
});

test("localisation-apps/AC-3 : aucun texte visible d'un *Text.swift n'échappe à L10n, hors identifiants et exceptions nommées", () => {
  assert.deepEqual(escapeFaults(SOURCES, UNTRANSLATED), []);

  const bare = plant(SOURCES, MEMORY_TEXT, 'L10n.text("Tous les projets")', '"Tous les projets"');
  assert.ok(
    escapeFaults(bare, UNTRANSLATED).some((f) => f.includes("« Tous les projets » (allProjects)")),
    "un texte rendu nu doit faire rougir la garde",
  );
  assert.ok(
    escapeFaults(SOURCES, [...UNTRANSLATED, { file: MEMORY_TEXT, name: "allProjects", reason: "plantée" }]).some((f) =>
      f.includes("exception orpheline allProjects"),
    ),
    "une exception qui ne couvre rien doit faire rougir la garde",
  );
  const dynamic = plant(SOURCES, L10N, "func text(_ key: StaticString", "func text(_ key: String");
  assert.ok(
    escapeFaults(dynamic, UNTRANSLATED).some((f) => f.includes("StaticString")),
    "une clé non littérale doit faire rougir la garde",
  );
});

test("localisation-apps/AC-4 : le français reste la langue de développement, et l'anglais est déclaré par le paquet, l'app Mac, l'app iOS et son widget", () => {
  assert.deepEqual(declarationFaults(DECLARED), []);

  const set = (rel: string, from: string | RegExp, to: string): Map<string, string> => {
    const before = DECLARED.get(rel) ?? "";
    const after = before.replace(from, to);
    assert.notEqual(after, before, `faute impossible à planter dans ${rel}`);
    return new Map(DECLARED).set(rel, after);
  };
  const cases: Array<[Map<string, string>, string]> = [
    [set(PACKAGE, 'defaultLocalization: "fr",', ""), "defaultLocalization"],
    [set(PACKAGE, 'resources: [.process("Resources")]', "resources: []"), ".process"],
    [set(MAC_PLIST, "<string>en</string>", ""), `${MAC_PLIST} : CFBundleLocalizations`],
    [
      set(IOS_PLIST, /<key>CFBundleLocalizations<\/key>/, "<key>CFBundleAutres</key>"),
      `${IOS_PLIST} : CFBundleLocalizations`,
    ],
    [set(WIDGET_PLIST, "<string>en</string>", ""), `${WIDGET_PLIST} : CFBundleLocalizations`],
    [set(PBXPROJ, /^\t\t\t\ten,\n/m, ""), "knownRegions"],
    [set(PBXPROJ, "developmentRegion = fr;", "developmentRegion = en;"), "developmentRegion"],
    [set(MAC_INFOPLIST_STRINGS, '"NSLocalNetworkUsageDescription"', '"Autre"'), "NSLocalNetworkUsageDescription"],
  ];
  for (const [files, expected] of cases) {
    assert.ok(
      declarationFaults(files).some((f) => f.includes(expected)),
      `la garde doit voir : ${expected}`,
    );
  }
});

test("localisation-apps/AC-5 : swift-app.sh embarque la table anglaise dans Contents/Resources avant la signature, et n'assemble rien sans elle", () => {
  const m = montageAppIntents();
  const ok = m.lancer(["--no-tests"]);
  assert.equal(ok.status, 0, ok.sortie);
  const resources = path.join(m.bundle, "Contents", "Resources");
  assert.ok(fs.existsSync(path.join(resources, RESOURCE_STRINGS_REL)), "table anglaise absente du bundle");
  assert.ok(fs.existsSync(path.join(resources, "en.lproj", "InfoPlist.strings")), "InfoPlist.strings absent du bundle");
  // Le bundle de ressources est signé, PUIS le bundle de l'app, qui le scelle.
  const embedded = path.join(resources, RESOURCE_STRINGS_REL.split("/")[0] ?? "");
  const signNested = ok.lignes.findIndex((l) => l.startsWith(`codesign --force --sign - ${embedded} `));
  const signApp = ok.lignes.findIndex((l) => l.startsWith(`codesign --force --sign - ${m.bundle} `));
  assert.ok(signNested !== -1, `le bundle de ressources n'est pas signé :\n${ok.lignes.join("\n")}`);
  assert.ok(signApp > signNested, "le bundle de l'app doit être signé après le bundle de ressources");

  // Un dossier de build neuf : la compilation doublée n'y rend que le binaire.
  fs.rmSync(path.join(m.copie, "omp-console", ".build-run"), { recursive: true, force: true });
  const missing = m.lancer(["--no-tests"], { FAUX_SANS_RESSOURCES: "1" });
  assert.notEqual(missing.status, 0, "sans bundle de ressources, l'assemblage doit échouer");
  assert.match(missing.sortie, /bundle de ressources introuvable/);
  assert.ok(!fs.existsSync(m.bundle), "aucun bundle ne doit survivre à l'échec");
});

test("localisation-apps/AC-6 : les tests iOS tournent en français, quelle que soit la langue du simulateur", () => {
  const scheme = read(SCHEME);
  const action = /<TestAction\b[^>]*>/.exec(scheme)?.[0] ?? "";
  assert.match(action, /\blanguage = "fr"/, "la TestAction du schéma doit fixer la langue fr");
  assert.match(action, /\bregion = "FR"/, "la TestAction du schéma doit fixer la région FR");

  const m = montageIosBuild();
  const r = m.run([], { FAUX_SIMULATEUR: "UDID-LOCALISATION" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const testLine = fs
    .readFileSync(m.journal, "utf8")
    .split("\n")
    .find((line) => line.startsWith("xcodebuild test "));
  assert.ok(testLine, "xcodebuild test n'a pas été lancé");
  assert.match(testLine, / -testLanguage fr -testRegion FR /);

  const script = path.join(m.root, "scripts", "ios-build.sh");
  fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace("  -testLanguage fr \\\n", ""));
  m.run([], { FAUX_SIMULATEUR: "UDID-LOCALISATION" });
  const without = fs
    .readFileSync(m.journal, "utf8")
    .split("\n")
    .find((line) => line.startsWith("xcodebuild test "));
  assert.ok(without !== undefined && !/-testLanguage fr/.test(without), "le retrait de -testLanguage doit se voir");
});
