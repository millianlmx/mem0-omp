// Les GARDES TEXTUELLES de la feature `contrat-ios-markdown-brut` (BR-3) : chaque
// critère `contrat-ios-markdown-brut/AC-1..AC-4` a son test ici, et c'est le SEUL
// fichier `test/*.test.ts` qui porte ce slug (invariant `criteria/AC-13`).
//
// Même structure que `test/ios-souvenir-markdown-altere.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE de
//     `omp-console/ios/` et `scripts/` (jamais l'arbre réel) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout, CI comprise.
//
// Ces gardes ne rendent rien : le comportement est prouvé par la suite Swift
// `IOSContractMarkdownTests` (`scripts/ios-build.sh`) et par la recette idb
// `scripts/ios-contrat-recette.sh`, dont elles tiennent les sondes à jour.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Les seuls dossiers copiés : l'app iOS et les scripts de recette. */
const COPIED = [path.join("omp-console", "ios"), "scripts"];

const EXCLUDED_DIRS: Record<string, true> = { build: true, node_modules: true };

/** Le nom de la feature et les sondes de `scripts/ios-contrat-recette.sh` (fixture `IOSHomeRecipeText.swift`). */
const LONG_SLUG = "chaines-ui-mac-et-ios-alignees-sur-les-conventions-apple";
const S1_HEADING = "S-1 — Rendu des sections par blocs";
const LIST_ITEM = "Chaque bloc du corps est un élément d'accessibilité distinct.";
const CODE_PARAGRAPH = "La fonction IOSHomeContent.contractBlocks(_:) retire la ligne de titre de la section.";
/** Le paragraphe tel qu'écrit dans la fixture : le code en ligne garde ses accents graves. */
const CODE_PARAGRAPH_SOURCE = "La fonction `IOSHomeContent.contractBlocks(_:)` retire la ligne de titre de la section.";

const SLUG_TEXT = "Text(verbatim: IOSHomeContent.contractSlug(card))";
const FIXED_SIZE = ".fixedSize(horizontal: false, vertical: true)";
const BLOCKS_DECLARATION = "static func contractBlocks(_ section: ContractSection) -> [MarkdownBlock]?";

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Une copie de l'app iOS et des scripts où l'on peut planter une faute. */
function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "contrat-ios-markdown-brut-copie-"));
  dirs.push(dir);
  for (const rel of COPIED) {
    const from = path.join(ROOT, rel);
    fs.cpSync(from, path.join(dir, rel), {
      recursive: true,
      filter: (src) =>
        !path
          .relative(from, src)
          .split(path.sep)
          .some((segment) => EXCLUDED_DIRS[segment] === true || segment.startsWith(".build")),
    });
  }
  return dir;
}

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Le source d'un fichier, ou la chaîne vide s'il est absent. */
function source(file: string): string {
  return fs.existsSync(file) ? code(file) : "";
}

/** Le chemin d'un fichier de l'app iOS. */
function appPath(root: string, name: string): string {
  return path.join(root, "omp-console", "ios", "OMPConsoleIOS", name);
}

/** La source d'un fichier de l'app iOS (vide s'il est absent). */
function appFile(root: string, name: string): string {
  return source(appPath(root, name));
}

const SHEET = "HomeContractSheet.swift";

/** Les manques communs à chaque critère : la suite Swift porte bien son titre. */
function swiftProofFaults(root: string, ac: number): string[] {
  const tests = source(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests", "IOSContractMarkdownTests.swift"));
  return tests.includes(`"contrat-ios-markdown-brut/AC-${ac} `)
    ? []
    : [`IOSContractMarkdownTests ne porte pas le titre contrat-ios-markdown-brut/AC-${ac}`];
}

/** Remplace `from` par `to` dans un fichier de la copie (commentaires retirés). */
function plant(file: string, from: string | RegExp, to: string): void {
  const original = code(file);
  const planted = original.replace(from, to);
  assert.notEqual(planted, original, "la faute n'a pas pu être plantée");
  fs.writeFileSync(file, planted);
}

// ---------------------------------------------------------------------------
// AC-1 : le corps est rendu en Markdown, les messages sans syntaxe brute.

/** Les manques du rendu Markdown de la feuille (AC-1). */
function markdownFaults(root: string): string[] {
  const faults: string[] = [];
  const view = appFile(root, SHEET);
  if (!view.includes("IOSMarkdownView(blocks:")) faults.push("la feuille ne rend pas IOSMarkdownView(blocks:)");
  if (view.split("Text(verbatim:").length !== 2 || !view.includes(SLUG_TEXT)) {
    faults.push(`le seul Text(verbatim:) de la feuille doit être ${SLUG_TEXT}`);
  }
  if (view.includes("ContractText.sectionMissing(")) faults.push("la feuille affiche ContractText.sectionMissing(");

  const fixture = appFile(root, "IOSHomeRecipeText.swift");
  // Le script est lu tel quel : ses globs (`/*.png`) tromperaient le retrait des commentaires.
  const recipePath = path.join(root, "scripts", "ios-contrat-recette.sh");
  const recipe = fs.existsSync(recipePath) ? fs.readFileSync(recipePath, "utf8") : "";
  for (const [probe, written] of [
    [LONG_SLUG, LONG_SLUG],
    [S1_HEADING, S1_HEADING],
    [LIST_ITEM, LIST_ITEM],
    [CODE_PARAGRAPH, CODE_PARAGRAPH_SOURCE],
  ] as const) {
    if (!fixture.includes(written)) faults.push(`IOSHomeRecipeText ne porte pas la sonde « ${written} »`);
    if (!recipe.includes(probe)) faults.push(`ios-contrat-recette.sh ne sonde pas « ${probe} »`);
  }
  faults.push(...swiftProofFaults(root, 1));
  return faults;
}

test("contrat-ios-markdown-brut/AC-1 : la feuille Contrat rend chaque section en Markdown, sans syntaxe brute", () => {
  assert.deepEqual(markdownFaults(ROOT), []);

  const copy = copyRepo();
  plant(appPath(copy, SHEET), "IOSMarkdownView(blocks: sectionBlocks)", "Text(verbatim: text)");
  assert.ok(markdownFaults(copy).length > 0, "un corps rendu en texte brut doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-2 : un élément d'accessibilité par bloc, jamais un texte par section.

/** Les manques du découpage d'accessibilité (AC-2). */
function accessibilityFaults(root: string): string[] {
  const faults: string[] = [];
  const view = appFile(root, SHEET);
  if (view === "") return [`${SHEET} est absent`];
  for (const merged of [".accessibilityElement(children: .combine)", ".accessibilityElement(children: .ignore)"]) {
    if (view.includes(merged)) faults.push(`la feuille fusionne ses blocs : ${merged}`);
  }
  faults.push(...swiftProofFaults(root, 2));
  return faults;
}

test("contrat-ios-markdown-brut/AC-2 : le corps d'une section reste un élément d'accessibilité par bloc", () => {
  assert.deepEqual(accessibilityFaults(ROOT), []);

  const copy = copyRepo();
  plant(
    appPath(copy, SHEET),
    "IOSMarkdownView(blocks: sectionBlocks)",
    "IOSMarkdownView(blocks: sectionBlocks)\n                    .accessibilityElement(children: .combine)",
  );
  assert.ok(accessibilityFaults(copy).length > 0, "des blocs fusionnés doivent faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-3 : la ligne « ## Titre » est retirée avant le parseur.

/** Les manques du titre unique (AC-3). */
function headingFaults(root: string): string[] {
  const faults: string[] = [];
  const view = appFile(root, SHEET);
  if (view.includes("MarkdownDocument.blocks(")) faults.push("la feuille appelle MarkdownDocument.blocks( directement");
  if (!view.includes("IOSHomeContent.contractBlocks(")) faults.push("la feuille n'appelle pas IOSHomeContent.contractBlocks(");
  if (!appFile(root, "IOSHomeContent.swift").includes(BLOCKS_DECLARATION)) {
    faults.push(`IOSHomeContent ne déclare pas ${BLOCKS_DECLARATION}`);
  }
  faults.push(...swiftProofFaults(root, 3));
  return faults;
}

test("contrat-ios-markdown-brut/AC-3 : le corps d'une section passe par contractBlocks, qui retire « ## Titre »", () => {
  assert.deepEqual(headingFaults(ROOT), []);

  const copy = copyRepo();
  plant(appPath(copy, SHEET), "IOSHomeContent.contractBlocks(section)", 'MarkdownDocument.blocks(section.text ?? "")');
  assert.ok(headingFaults(copy).length > 0, "un corps parsé avec sa ligne de titre doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-4 : barre « Contrat » en ligne, nom complet de la feature jamais tronqué.

/** Les manques du titre en ligne et du nom complet (AC-4). */
function titleFaults(root: string): string[] {
  const faults: string[] = [];
  const view = appFile(root, SHEET);
  if (!view.includes(".navigationBarTitleDisplayMode(.inline)")) faults.push("la barre n'est pas en ligne");
  if (!view.includes(".navigationTitle(IOSHomeText.contractNavigationTitle)")) {
    faults.push("la barre ne dit pas IOSHomeText.contractNavigationTitle");
  }
  if (view.includes("ContractText.title(")) faults.push("la feuille garde ContractText.title(");
  const start = view.indexOf(SLUG_TEXT);
  if (start < 0) {
    faults.push(`la feuille n'affiche pas ${SLUG_TEXT}`);
  } else {
    const after = view.slice(start + SLUG_TEXT.length);
    const next = after.indexOf("Text(");
    const modifiers = next < 0 ? after : after.slice(0, next);
    if (!modifiers.includes(FIXED_SIZE)) faults.push(`le nom de la feature n'a pas ${FIXED_SIZE}`);
  }
  for (const bound of ["lineLimit(", "truncationMode("]) {
    if (view.includes(bound)) faults.push(`la feuille borne ses lignes : ${bound}`);
  }
  faults.push(...swiftProofFaults(root, 4));
  return faults;
}

test("contrat-ios-markdown-brut/AC-4 : la barre est en ligne et le nom complet de la feature passe à la ligne", () => {
  assert.deepEqual(titleFaults(ROOT), []);

  const inline = copyRepo();
  plant(appPath(inline, SHEET), /\n\s*\.navigationBarTitleDisplayMode\(\.inline\)/, "");
  assert.ok(titleFaults(inline).length > 0, "une barre en grand titre doit faire rougir la garde");

  const truncated = copyRepo();
  plant(
    appPath(truncated, SHEET),
    /(Text\(verbatim: IOSHomeContent\.contractSlug\(card\)\)[\s\S]*?)\n\s*\.fixedSize\(horizontal: false, vertical: true\)/,
    "$1",
  );
  assert.ok(titleFaults(truncated).length > 0, "un nom de feature sans fixedSize doit faire rougir la garde");
});
