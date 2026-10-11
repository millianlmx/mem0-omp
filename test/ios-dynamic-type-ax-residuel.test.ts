// Les GARDES TEXTUELLES de la feature `ios-dynamic-type-ax-residuel` : un test par
// critère `ios-dynamic-type-ax-residuel/AC-<n>`, et c'est le SEUL fichier qui
// porte ce slug (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source ; chaque faute est plantée EN MÉMOIRE :
// aucune copie du dépôt, aucun SwiftUI rendu. La preuve visuelle (rangées qui
// s'empilent, texte qui grandit jusqu'à accessibility-extra-extra-extra-large)
// relève des tests Swift `IOSDynamicTypeAXTests` et de la recette de captures.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");

/** Les sources Swift de l'app iOS, chemin relatif → texte, sous-dossiers compris. */
function appSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of fs.readdirSync(APP, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".swift")) continue;
    const file = path.join(entry.parentPath, entry.name);
    sources.set(path.relative(APP, file), fs.readFileSync(file, "utf8"));
  }
  return sources;
}

/** Un plafond de taille de texte : `.dynamicTypeSize(` suivi d'une borne `...` ou `..<` (S-2). */
const CAP = /\.dynamicTypeSize\([^)]*\.\.[.<]/;
/** Les constantes de plafond supprimées par S-2 : aucun symbole de ce nom ne revient. */
const CAP_NAMES = ["rowTextMaximumSize", "rowButtonMaximumSize"];

/** Les fautes de plafond, une par fichier et par motif trouvé. */
function capFaults(sources: Map<string, string>): string[] {
  const faults: string[] = [];
  for (const [name, source] of sources) {
    const cap = source.match(CAP);
    if (cap) faults.push(`${name} : plafond de taille de texte « ${cap[0]} »`);
    for (const symbol of CAP_NAMES) {
      if (source.includes(symbol)) faults.push(`${name} : la constante de plafond ${symbol} est revenue`);
    }
  }
  return faults;
}

test("ios-dynamic-type-ax-residuel/AC-2 : aucun plafond de taille de texte dans l'app iOS", () => {
  const sources = appSources();
  assert.ok(sources.has("HomeView.swift") && sources.has(path.join("Design", "IOSAdaptiveRow.swift")), "les sources de l'app doivent être lues, sous-dossiers compris");
  assert.deepEqual(capFaults(sources), [], "l'arbre réel doit être sain");

  const planted = (name: string, change: (source: string) => string) => {
    const copy = new Map(sources);
    const source = copy.get(name);
    assert.ok(source !== undefined, `${name} introuvable`);
    const next = change(source);
    assert.notEqual(next, source, `la faute n'a pas pu être plantée dans ${name}`);
    copy.set(name, next);
    return capFaults(copy);
  };
  const anchor = "        .padding(.vertical, rowPadding)";
  assert.ok(
    planted("IOSSessionsScreen.swift", (s) => s.replace(anchor, `        .dynamicTypeSize(...DynamicTypeSize.accessibility3)\n${anchor}`)).length > 0,
    "un plafond `...accessibility3` doit faire rougir la garde",
  );
  assert.ok(
    planted("IOSSessionsScreen.swift", (s) => s.replace(anchor, `        .dynamicTypeSize(.large ..< .accessibility4)\n${anchor}`)).length > 0,
    "un plafond `..<` doit faire rougir la garde",
  );
  assert.ok(
    planted("IOSHomeContent.swift", (s) => `${s}\nextension IOSHomeContent { static let rowButtonMaximumSize: DynamicTypeSize = .accessibility3 }\n`).length > 0,
    "la constante rowButtonMaximumSize doit faire rougir la garde",
  );
  assert.deepEqual(
    planted("IOSSessionsScreen.swift", (s) => s.replace(anchor, `        .dynamicTypeSize(.accessibility2)\n${anchor}`)),
    [],
    "une taille fixe sans borne n'est pas un plafond",
  );
});

const DESIGN = path.join(ROOT, "omp-console", "ios", "DESIGN.md");
/** Ce que DESIGN.md ne dit plus (S-10) : un nom de borne `accessibility1..5` ou « borné(e) à `…accessibility ». */
const DESIGN_CAP_WORDS = [
  ...[1, 2, 3, 4, 5].map((n) => `\`accessibility${n}\``),
  "borné à `.accessibility",
  "bornée à `.accessibility",
  "borné à `accessibility",
  "bornée à `accessibility",
];

/** Les fautes de DESIGN.md : une par sous-chaîne interdite trouvée, avec sa ligne. */
function designCapFaults(design: string): string[] {
  const lines = design.split("\n");
  const faults: string[] = [];
  for (const word of DESIGN_CAP_WORDS) {
    const at = lines.findIndex((line) => line.includes(word));
    if (at >= 0) faults.push(`DESIGN.md:${at + 1} décrit un plafond de taille de texte « ${word} »`);
  }
  return faults;
}

test("ios-dynamic-type-ax-residuel/AC-14 : DESIGN.md ne décrit plus aucun plafond de taille de texte", () => {
  const design = fs.readFileSync(DESIGN, "utf8");
  assert.deepEqual(designCapFaults(design), [], "le DESIGN.md réel doit être sain");

  const anchor = "aux tailles d'accessibilité.\n  `[test: memoryRowContextSplitsIntoSegments]`";
  assert.ok(design.includes(anchor), "l'ancre de plantation (puce Mémoire) doit exister");
  const planted = design.replace(anchor, "aux tailles d'accessibilité, bornés à `accessibility3`.\n  `[test: memoryRowContextSplitsIntoSegments]`");
  assert.ok(designCapFaults(planted).length > 0, "« bornés à `accessibility3` » doit faire rougir la garde");
  assert.ok(
    designCapFaults(design.replace(anchor, "aux tailles d'accessibilité, texte bornée à `.accessibility4`.\n  `[test: memoryRowContextSplitsIntoSegments]`")).length > 0,
    "« bornée à `.accessibility4` » doit faire rougir la garde",
  );
  assert.deepEqual(
    designCapFaults("- Aucune taille de texte n'est plafonnée jusqu'à `accessibility-extra-extra-extra-large`.\n"),
    [],
    "un nom de taille de simctl n'est pas un plafond",
  );
});

const RECIPE = path.join(ROOT, "scripts", "ios-dynamic-type-recette.sh");

/** Ce que la recette avant/après doit porter HORS commentaires (S-9). */
const RECIPE_TOKENS = [
  "simctl create",
  "simctl delete",
  "zz-dtax-tel",
  "zz-dtax-tab",
  "CODE_SIGN_IDENTITY=-",
  "codesign -dv",
  "--avant",
  "content_size",
  "accessibility-extra-large",
  "accessibility-extra-extra-extra-large",
  "erreur",
];
/** Les contrôles automatiques dont la recette écrit une ligne `AC-<n>` (S-9) : le littéral `"AC-<n>"` qui l'émet. */
const RECIPE_CHECKS = [3, 4, 6, 10, 11];
/** Ce qui volerait le focus du Mac, toucherait l'app Mac de l'utilisateur ou fusionnerait la PR : refusé partout, commentaires compris. */
const RECIPE_FORBIDDEN = ["open -a", "OMP Console", "osascript", "run-console.sh", "gh pr merge"];

/** Le script sans ses commentaires `#` de ligne ni de fin de ligne (shell et Python). */
function stripHashComments(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/\s#\s.*$/, ""))
    .join("\n");
}

/** Les fautes de la recette : jeton ou contrôle absent hors commentaires, intrusion sur le Mac. */
function recipeScriptFaults(script: string): string[] {
  const faults: string[] = [];
  const code = stripHashComments(script);
  for (const token of RECIPE_TOKENS) {
    if (!code.includes(token)) faults.push(`recette : jeton absent hors commentaire « ${token} »`);
  }
  for (const n of RECIPE_CHECKS) {
    if (!code.includes(`"AC-${n}"`)) faults.push(`recette : aucune ligne AC-${n} émise hors commentaire`);
  }
  for (const token of RECIPE_FORBIDDEN) {
    if (script.includes(token)) faults.push(`recette : « ${token} » interdit`);
  }
  if (code.includes("Simulator.app")) faults.push("recette : Simulator.app hors commentaire");
  return faults;
}

test("ios-dynamic-type-ax-residuel/AC-13 : la recette avant/après tourne sur des simulateurs privés et ne touche pas au Mac", () => {
  const script = fs.readFileSync(RECIPE, "utf8");
  assert.deepEqual(recipeScriptFaults(script), [], "la recette réelle doit être saine");

  const plant = (change: (s: string) => string) => {
    const next = change(script);
    assert.notEqual(next, script, "la faute n'a pas pu être plantée");
    return recipeScriptFaults(next);
  };
  // Témoin négatif de S-9 : le Simulateur ouvert au premier plan ⇒ rouge.
  assert.ok(
    plant((s) => s.replace("trap cleanup EXIT", 'trap cleanup EXIT\nopen -a Simulator --args -CurrentDeviceUDID "$iphone"')).some((f) => f.includes("open -a")),
    "« open -a » doit faire rougir la garde",
  );
  // Une intrusion citée en commentaire reste refusée (le mot ne doit même pas y figurer).
  assert.ok(plant((s) => s.replace("trap cleanup EXIT", "# gh pr merge --squash\ntrap cleanup EXIT")).length > 0, "« gh pr merge » en commentaire doit rougir");
  // Simulateurs conservés ⇒ rouge.
  assert.ok(plant((s) => s.replaceAll("simctl delete", "simctl shutdown")).some((f) => f.includes("simctl delete")), "des simulateurs conservés doivent rougir");
  // AX-XXXL retiré de la matrice ⇒ rouge.
  assert.ok(
    plant((s) => s.replaceAll("accessibility-extra-extra-extra-large", "accessibility-extra-large")).some((f) => f.includes("accessibility-extra-extra-extra-large")),
    "une matrice sans AX-XXXL doit rougir",
  );
  // Un contrôle automatique présent seulement en commentaire ⇒ rouge.
  assert.ok(plant((s) => s.replaceAll('"AC-11"', '"AC-12"')).some((f) => f.includes("AC-11")), "un contrôle AC-11 retiré doit rougir");
  // Simulator.app cité en commentaire reste admis ; hors commentaire, il rougit.
  assert.deepEqual(plant((s) => s.replace("trap cleanup EXIT", "# Simulator.app n'est jamais lancé.\ntrap cleanup EXIT")), []);
  assert.ok(
    plant((s) => s.replace("trap cleanup EXIT", 'trap cleanup EXIT\nopen "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"')).some((f) => f.includes("Simulator.app")),
    "Simulator.app hors commentaire doit rougir",
  );
});
