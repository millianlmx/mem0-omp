// Les GARDES TEXTUELLES de la feature `parite-mac-des-correctifs-ios` : c'est le
// SEUL fichier test/*.test.ts qui porte ce slug (invariant `criteria/AC-13`).
//
// Les preuves de COMPORTEMENT vivent dans les suites Swift de parité
// (`omp-console/Tests/OMPConsoleTests/PariteMacTests.swift` et
// `omp-console/ios/OMPConsoleIOSTests/IOSPariteMacTests.swift`), qui épinglent
// les mêmes libellés des deux côtés. Ce fichier garde l'invariant de S-7 : plus
// aucun « req+specs » ni « impl+review » visible, c'est-à-dire dans aucun
// littéral de chaîne Swift des sources de la coque macOS, de ConsoleCore, de
// ConsoleClient et de l'app iOS. Les commentaires et les clés JSON
// (`modelReqSpecs`, `modelImplReview`) sont hors invariant.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Les arbres balayés : toutes les sources Swift livrées des deux apps. */
const TREES = ["omp-console/Sources", "omp-console/ios/OMPConsoleIOS"];

/** Les anciens libellés de groupe, interdits dans tout texte visible. */
const FORBIDDEN = ["req+specs", "impl+review"];

/** Les fichiers .swift d'un arbre, récursivement. */
function swiftFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(full);
    return entry.name.endsWith(".swift") ? [full] : [];
  });
}

/**
 * Les littéraux de chaîne d'un source Swift : `"…"`, `"""…"""` et les formes
 * brutes `#"…"#`, interpolations comprises (une chaîne imbriquée dans une
 * interpolation est un littéral à part). Les commentaires `//`, `///` et
 * `/* … *\/` sont sautés.
 */
function swiftLiterals(src: string): string[] {
  const literals: string[] = [];
  /** Lit une chaîne qui commence à `i` (sur ses `#` éventuels) ; rend la fin. */
  function readString(start: number): number {
    let hashes = 0;
    let j = start;
    while (src[j] === "#") {
      hashes++;
      j++;
    }
    const multi = src.startsWith('"""', j);
    const open = multi ? 3 : 1;
    const close = (multi ? '"""' : '"') + "#".repeat(hashes);
    const escape = "\\" + "#".repeat(hashes);
    j += open;
    let text = "";
    while (j < src.length) {
      if (src.startsWith(close, j)) {
        literals.push(text);
        return j + close.length;
      }
      if (src.startsWith(escape, j)) {
        const after = j + escape.length;
        if (src[after] === "(") {
          j = readCode(after + 1, ")");
          continue;
        }
        text += src.slice(j, after + 1);
        j = after + 1;
        continue;
      }
      if (!multi && src[j] === "\n") break;
      text += src[j];
      j++;
    }
    literals.push(text);
    return j;
  }

  /** Lit du code jusqu'à `stop` au même niveau d'imbrication (ou la fin). */
  function readCode(start: number, stop: string | null): number {
    let j = start;
    let depth = 0;
    while (j < src.length) {
      const c = src[j];
      if (src.startsWith("//", j)) {
        const end = src.indexOf("\n", j);
        j = end === -1 ? src.length : end;
        continue;
      }
      if (src.startsWith("/*", j)) {
        const end = src.indexOf("*/", j + 2);
        j = end === -1 ? src.length : end + 2;
        continue;
      }
      if (c === '"' || (c === "#" && /^#+"/.test(src.slice(j, j + 8)))) {
        j = readString(j);
        continue;
      }
      if (stop !== null) {
        if (c === "(") depth++;
        else if (c === ")") {
          if (depth === 0) return j + 1;
          depth--;
        }
      }
      j++;
    }
    return j;
  }

  readCode(0, null);
  return literals;
}

/** Les littéraux fautifs d'un ensemble de sources : `chemin : « littéral »`. */
function literalFaults(files: { rel: string; src: string }[]): string[] {
  return files.flatMap(({ rel, src }) =>
    swiftLiterals(src)
      .filter((literal) => FORBIDDEN.some((word) => literal.includes(word)))
      .map((literal) => `${rel} : « ${literal} »`),
  );
}

function treeSources(root: string): { rel: string; src: string }[] {
  return TREES.flatMap((tree) => swiftFiles(path.join(root, tree))).map((file) => ({
    rel: path.relative(root, file),
    src: fs.readFileSync(file, "utf8"),
  }));
}

test("parite-mac-des-correctifs-ios/AC-8 : aucun littéral Swift des deux apps ne contient « req+specs » ni « impl+review »", () => {
  const sources = treeSources(ROOT);
  assert.ok(sources.length > 100, `les deux arbres doivent être balayés (${sources.length} fichiers)`);
  assert.deepEqual(literalFaults(sources), [], "aucun texte visible ne porte l'ancien libellé de groupe");

  // La garde rougit sur un libellé planté, et seulement sur un littéral.
  const planted = [
    { rel: "a.swift", src: 'let label = "req+specs"\n' },
    { rel: "b.swift", src: 'let line = "\\(KanbanText.modelDefault) impl+review"\n' },
    { rel: "c.swift", src: 'let raw = #"modèle "req+specs""#\n' },
    { rel: "d.swift", src: 'let text = """\n  Modèle impl+review\n  """\n' },
    { rel: "e.swift", src: 'let nested = "\\(flag ? "req+specs" : "x")"\n' },
  ];
  assert.deepEqual(
    literalFaults(planted).map((fault) => fault.split(" : ")[0]),
    ["a.swift", "b.swift", "c.swift", "d.swift", "e.swift"],
    "chaque forme de littéral portant l'ancien libellé fait rougir la garde",
  );
  const allowed = [
    { rel: "f.swift", src: "// le groupe req+specs\n/// impl+review\nlet x = 1 /* req+specs */\n" },
    { rel: "g.swift", src: 'let url = "https://example.org" // req+specs\nlet key = "modelReqSpecs"\n' },
  ];
  assert.deepEqual(literalFaults(allowed), [], "commentaires et clés JSON restent permis");
});
