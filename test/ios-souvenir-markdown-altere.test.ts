// Les GARDES TEXTUELLES de la feature `ios-souvenir-markdown-altere` (BR-2) : chaque
// critère `ios-souvenir-markdown-altere/AC-1..AC-4` a son test ici, et c'est le SEUL
// fichier `test/*.test.ts` qui porte ce slug (invariant `criteria/AC-13`).
//
// Même structure que `test/ios-memoire.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout, CI comprise.
//
// Ces gardes ne rendent rien : le comportement est prouvé par la suite Swift
// `IOSMemoryVerbatimTests` (`scripts/ios-build.sh`), dont elles exigent l'existence.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXCLUDED_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
  build: true,
};

/** Les jetons qu'aucune vue de la section Mémoire iOS ne doit contenir (S-1). */
const FORBIDDEN = ["IOSMarkdownView(", "MarkdownDocument", "AttributedString", "MemoryText.title("];

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Une copie du dépôt où l'on peut planter une faute. */
function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-souvenir-markdown-altere-copie-"));
  dirs.push(dir);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((segment) => EXCLUDED_DIRS[segment] === true || segment.startsWith(".build"))) {
        return false;
      }
      if (rel === path.join("test", "check.test.ts")) return false;
      return true;
    },
  });
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

/** La source d'un fichier de l'app iOS (vide s'il est absent). */
function appFile(root: string, name: string): string {
  return source(path.join(root, "omp-console", "ios", "OMPConsoleIOS", name));
}

/** Le chemin d'un fichier de l'app iOS. */
function appPath(root: string, name: string): string {
  return path.join(root, "omp-console", "ios", "OMPConsoleIOS", name);
}

/** Les sources Swift de la SECTION Mémoire de l'app, commentaires retirés. */
function memoryAppCode(root: string = ROOT): string {
  const appDir = path.join(root, "omp-console", "ios", "OMPConsoleIOS");
  const files = fs
    .readdirSync(appDir)
    .filter((name) => name.startsWith("IOSMemory") && name.endsWith(".swift"))
    .sort();
  assert.ok(files.length > 0, "aucune source de la section Mémoire dans l'app iOS");
  return files.map((name) => code(path.join(appDir, name))).join("\n");
}

/** Les sources de la suite Swift de preuve (vide si absente). */
function verbatimTests(root: string): string {
  return source(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests", "IOSMemoryVerbatimTests.swift"));
}

/** Les jetons interdits présents dans le code de la section Mémoire. */
function forbiddenFaults(root: string): string[] {
  const memory = memoryAppCode(root);
  return FORBIDDEN.filter((token) => memory.includes(token)).map(
    (token) => `la section Mémoire iOS contient ${token}`,
  );
}

// ---------------------------------------------------------------------------
// AC-1, AC-2 : le texte affiché est le texte stocké, par `Text(verbatim:)`.

/** Les manques du texte brut (AC-1 et AC-2), `fixture` étant celle du critère `ac`. */
function verbatimFaults(root: string, ac: number, fixture: string): string[] {
  const faults: string[] = [];
  const detail = appFile(root, "IOSMemoryDetailView.swift");
  if (!detail.includes("static func text(_ row: RemoteMemoryRow) -> String")) {
    faults.push("IOSMemoryDetailView ne définit pas text(_:)");
  }
  if (!detail.includes("Text(verbatim: Self.text(row))")) {
    faults.push("la feuille n'affiche pas Text(verbatim: Self.text(row))");
  }
  faults.push(...forbiddenFaults(root));
  const tests = verbatimTests(root);
  if (!tests.includes(`"ios-souvenir-markdown-altere/AC-${ac}`)) {
    faults.push(`IOSMemoryVerbatimTests ne porte pas le titre ios-souvenir-markdown-altere/AC-${ac}`);
  }
  if (!tests.includes(fixture)) faults.push(`IOSMemoryVerbatimTests ne porte pas la fixture d'AC-${ac}`);
  return faults;
}

const AC1_FIXTURE = "lance test/*.test.ts puis vérifie src/*.ts et la suite";
const AC2_FIXTURE = "**gras** et _souligné_ et `code`";

/** Plante la faute commune d'AC-1 et AC-2 : le corps repasse par le rendu Markdown. */
function plantMarkdownBody(copy: string): void {
  const target = appPath(copy, "IOSMemoryDetailView.swift");
  const planted = code(target).replace(
    "Text(verbatim: Self.text(row))",
    "IOSMarkdownView(blocks: MarkdownDocument.blocks(Self.text(row)))",
  );
  assert.notEqual(planted, code(target), "la faute n'a pas pu être plantée");
  fs.writeFileSync(target, planted);
}

test("ios-souvenir-markdown-altere/AC-1 : un souvenir à glob s'affiche tel qu'il est stocké", () => {
  assert.deepEqual(verbatimFaults(ROOT, 1, AC1_FIXTURE), []);

  const copy = copyRepo();
  plantMarkdownBody(copy);
  assert.ok(
    verbatimFaults(copy, 1, AC1_FIXTURE).length > 0,
    "un corps repassé par IOSMarkdownView doit faire rougir la garde",
  );
});

test("ios-souvenir-markdown-altere/AC-2 : les marqueurs Markdown d'un souvenir restent visibles", () => {
  assert.deepEqual(verbatimFaults(ROOT, 2, AC2_FIXTURE), []);

  const copy = copyRepo();
  plantMarkdownBody(copy);
  assert.ok(
    verbatimFaults(copy, 2, AC2_FIXTURE).length > 0,
    "un corps repassé par IOSMarkdownView doit faire rougir la garde",
  );
});

// ---------------------------------------------------------------------------
// AC-3 : liste, fiche et fiche du graphe montrent le même texte brut.

/** Les manques des trois surfaces (AC-3). */
function surfacesFaults(root: string): string[] {
  const faults: string[] = [];
  const screen = appFile(root, "IOSMemoryScreen.swift");
  if (!screen.includes("Text(verbatim: IOSMemoryDetailView.text(row))")) {
    faults.push("la rangée de liste n'affiche pas Text(verbatim: IOSMemoryDetailView.text(row))");
  }
  // L'appel du graphe est écrit sur plusieurs lignes : on tolère les blancs après `(`.
  const mount = /IOSMemoryDetailView\(\s*row:/;
  if (!mount.test(screen)) faults.push("IOSMemoryScreen ne monte pas IOSMemoryDetailView(row:");
  if (!mount.test(appFile(root, "IOSMemoryGraphView.swift"))) {
    faults.push("IOSMemoryGraphView ne monte pas IOSMemoryDetailView(row:");
  }
  faults.push(...forbiddenFaults(root));
  if (!verbatimTests(root).includes('"ios-souvenir-markdown-altere/AC-3')) {
    faults.push("IOSMemoryVerbatimTests ne porte pas le titre ios-souvenir-markdown-altere/AC-3");
  }
  return faults;
}

test("ios-souvenir-markdown-altere/AC-3 : liste, fiche et fiche du graphe montrent le texte stocké", () => {
  assert.deepEqual(surfacesFaults(ROOT), []);

  const copy = copyRepo();
  const target = appPath(copy, "IOSMemoryScreen.swift");
  const planted = code(target).replace("IOSMemoryDetailView.text(row)", "MemoryText.title(row.text)");
  assert.notEqual(planted, code(target), "la faute n'a pas pu être plantée");
  fs.writeFileSync(target, planted);
  assert.ok(surfacesFaults(copy).length > 0, "un titre raccourci dans la liste doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-4 : les contenus non-souvenirs gardent leur rendu Markdown.

/** Les manques du rendu Markdown des autres contenus (AC-4). */
function otherMarkdownFaults(root: string): string[] {
  const faults: string[] = [];
  if (!/case let \.paragraph\(text\):\s*Text\(text\)/.test(appFile(root, "IOSMarkdownView.swift"))) {
    faults.push("IOSMarkdownView ne rend plus un paragraphe par Text(text)");
  }
  for (const caller of ["IOSProjectDialogSheet.swift", "IOSProjectScreen.swift", "IOSSessionRowView.swift"]) {
    if (!appFile(root, caller).includes("IOSMarkdownView(")) faults.push(`${caller} n'emploie plus IOSMarkdownView(`);
  }
  if (!verbatimTests(root).includes('"ios-souvenir-markdown-altere/AC-4')) {
    faults.push("IOSMemoryVerbatimTests ne porte pas le titre ios-souvenir-markdown-altere/AC-4");
  }
  return faults;
}

test("ios-souvenir-markdown-altere/AC-4 : un contenu non-souvenir garde son gras Markdown", () => {
  assert.deepEqual(otherMarkdownFaults(ROOT), []);

  const copy = copyRepo();
  const target = appPath(copy, "IOSProjectScreen.swift");
  const planted = code(target).replace("IOSMarkdownView(blocks: blocks)", 'Text(verbatim: "")');
  assert.notEqual(planted, code(target), "la faute n'a pas pu être plantée");
  fs.writeFileSync(target, planted);
  assert.ok(otherMarkdownFaults(copy).length > 0, "un appelant sans IOSMarkdownView doit faire rougir la garde");
});
