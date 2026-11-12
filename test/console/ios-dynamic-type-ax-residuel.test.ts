// Les GARDES TEXTUELLES de la feature `ios-dynamic-type-ax-residuel` : un test par
// critère `ios-dynamic-type-ax-residuel/AC-<n>`, et c'est le SEUL fichier qui
// porte ce slug (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source ; chaque faute est plantée EN MÉMOIRE :
// aucune copie du dépôt, aucun SwiftUI rendu. La preuve visuelle (rangées qui
// s'empilent, texte qui grandit jusqu'à accessibility-extra-extra-extra-large)
// relève des tests Swift `IOSDynamicTypeAXTests` et des captures `-ax` de
// `scripts/recette/ios-shots.sh`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { swiftSources } from "../support/swift-source.ts";

const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");

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
  const sources = swiftSources(APP);
  assert.ok(
    sources.has("IOSSystemScreens.swift") && sources.has(path.join("Design", "IOSAdaptiveRow.swift")),
    "les sources de l'app doivent être lues, sous-dossiers compris",
  );
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
  const anchor = "        .accessibilityElement(children: .contain)";
  assert.ok(
    planted("IOSSystemScreens.swift", (s) =>
      s.replace(anchor, `        .dynamicTypeSize(...DynamicTypeSize.accessibility3)\n${anchor}`),
    ).length > 0,
    "un plafond `...accessibility3` doit faire rougir la garde",
  );
  assert.ok(
    planted("IOSSystemScreens.swift", (s) =>
      s.replace(anchor, `        .dynamicTypeSize(.large ..< .accessibility4)\n${anchor}`),
    ).length > 0,
    "un plafond `..<` doit faire rougir la garde",
  );
  assert.ok(
    planted(
      "Design/IOSMetrics.swift",
      (s) => `${s}\nextension IOSMetrics { static let rowButtonMaximumSize: DynamicTypeSize = .accessibility3 }\n`,
    ).length > 0,
    "la constante rowButtonMaximumSize doit faire rougir la garde",
  );
  assert.deepEqual(
    planted("IOSSystemScreens.swift", (s) => s.replace(anchor, `        .dynamicTypeSize(.accessibility2)\n${anchor}`)),
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
  const planted = design.replace(
    anchor,
    "aux tailles d'accessibilité, bornés à `accessibility3`.\n  `[test: memoryRowContextSplitsIntoSegments]`",
  );
  assert.ok(designCapFaults(planted).length > 0, "« bornés à `accessibility3` » doit faire rougir la garde");
  assert.ok(
    designCapFaults(
      design.replace(
        anchor,
        "aux tailles d'accessibilité, texte bornée à `.accessibility4`.\n  `[test: memoryRowContextSplitsIntoSegments]`",
      ),
    ).length > 0,
    "« bornée à `.accessibility4` » doit faire rougir la garde",
  );
  assert.deepEqual(
    designCapFaults("- Aucune taille de texte n'est plafonnée jusqu'à `accessibility-extra-extra-extra-large`.\n"),
    [],
    "un nom de taille de simctl n'est pas un plafond",
  );
});
