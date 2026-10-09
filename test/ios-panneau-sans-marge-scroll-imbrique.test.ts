// Les GARDES TEXTUELLES de la feature `ios-panneau-sans-marge-scroll-imbrique` :
// un test par critère `ios-panneau-sans-marge-scroll-imbrique/AC-<n>`, et c'est le
// SEUL fichier qui porte ce slug (invariant `criteria/AC-13`).
//
// Preuve VISUELLE d'AC-1 et d'AC-5 : les captures simulateur de
// `omp-console/build/ios-panneau/` (dont `ipad-sessions-liste.png` : une seule
// marge de 24 pt autour du panneau sur iPad). Ce fichier éprouve le CÂBLAGE sans
// rendre de SwiftUI : tout ce qui doit ÉCHOUER se plante dans une COPIE JETABLE de
// la coque iOS.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const IOS_REL = path.join("omp-console", "ios", "OMPConsoleIOS");
const IOS_APP = path.join(ROOT, IOS_REL);

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function strip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function code(root: string, rel: string): string {
  const file = path.join(root, IOS_REL, rel);
  return fs.existsSync(file) ? strip(fs.readFileSync(file, "utf8")) : "";
}

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Une copie jetable de la coque iOS (sources seulement), à muter. */
function copyIOS(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "ios-panneau-")));
  dirs.push(dir);
  const target = path.join(dir, IOS_REL);
  fs.cpSync(IOS_APP, target, { recursive: true });
  return dir;
}

function mutate(root: string, rel: string, change: (source: string) => string): void {
  const file = path.join(root, IOS_REL, rel);
  const before = fs.readFileSync(file, "utf8");
  const after = change(before);
  assert.notEqual(after, before, `la faute plantée n'a rien changé dans ${rel}`);
  fs.writeFileSync(file, after);
}

const OUTER = ".padding(IOSMetrics.margin(sizeClass))";
const INNER = ".padding(IOSMetrics.margin(sizeClass) * scale)";

/** AC-1 : le panneau porte une marge extérieure fixe, après son filet. */
function marginFaults(root: string): string[] {
  const faults: string[] = [];
  const surface = code(root, "Design/IOSSurface.swift");
  const body = surface.match(/struct IOSPanelSurface: ViewModifier \{[\s\S]*?\n\}\n/)?.[0] ?? "";
  if (body === "") return ["IOSPanelSurface introuvable dans Design/IOSSurface.swift"];
  if (!body.includes(INNER)) faults.push("le rembourrage intérieur `margin * scale` a disparu");
  const stroke = body.indexOf("strokeBorder(");
  if (stroke < 0) faults.push("le filet `strokeBorder(` a disparu");
  if (body.indexOf(OUTER, Math.max(stroke, 0)) < 0) {
    faults.push("la marge extérieure `.padding(IOSMetrics.margin(sizeClass))` ne suit pas le filet");
  }
  return faults;
}

/** AC-5 : aucun appelant n'ajoute une marge à la suite de `.iosPanel()`. */
function doubleMarginFaults(root: string): string[] {
  const faults: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift") && /\.iosPanel\(\)\s*\.padding\(/.test(strip(fs.readFileSync(full, "utf8")))) {
        faults.push(`${path.relative(root, full)} : .iosPanel() suivi de .padding( — marge doublée`);
      }
    }
  };
  walk(path.join(root, IOS_REL));
  return faults;
}

test("ios-panneau-sans-marge-scroll-imbrique/AC-1 : le panneau porte une marge extérieure fixe après son filet", () => {
  assert.deepEqual(marginFaults(ROOT), []);

  // Faute plantée : retirer la marge extérieure ⇒ rouge (l'intérieure ne suffit pas).
  const copy = copyIOS();
  mutate(copy, "Design/IOSSurface.swift", (s) => s.replace(`            ${OUTER}\n`, ""));
  assert.ok(marginFaults(copy).some((f) => f.includes("marge extérieure")), "sans marge extérieure, la garde doit rougir");
});

test("ios-panneau-sans-marge-scroll-imbrique/AC-5 : aucun appelant n'ajoute de marge après .iosPanel()", () => {
  assert.deepEqual(doubleMarginFaults(ROOT), []);

  // Faute plantée : remettre le padding après `.iosPanel()` dans HomeWelcomeSheet ⇒ rouge.
  const copy = copyIOS();
  mutate(copy, "HomeWelcomeSheet.swift", (s) => s.replace(".iosPanel()\n", `.iosPanel()\n                ${OUTER}\n`));
  const faults = doubleMarginFaults(copy);
  assert.ok(faults.some((f) => f.includes("HomeWelcomeSheet.swift")), "un double padding doit rougir");
});

const SCREENS = ["PipelinesScreen.swift", "IOSSessionsScreen.swift", "IOSMemoryScreen.swift"];

/** Le bloc `{ … }` dont l'accolade ouvrante est à `open` (accolades équilibrées). */
function block(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/** Le nombre d'occurrences d'un motif littéral. */
const count = (source: string, needle: string) => source.split(needle).length - 1;

/** AC-2 : un seul défilement vertical par écran, aucune `List`, panneau DANS le défilement. */
function scrollFaults(root: string): string[] {
  const faults: string[] = [];
  for (const name of SCREENS) {
    const source = code(root, name);
    if (source === "") {
      faults.push(`${name} introuvable`);
      continue;
    }
    if (/\bList\s*[({]/.test(source)) faults.push(`${name} : une List réintroduit un défilement imbriqué`);
    const vertical = count(source, "ScrollView(.vertical)");
    if (vertical !== 1) faults.push(`${name} : ScrollView(.vertical) ×${vertical}, attendu 1`);
    const horizontal = count(source, "ScrollView(.horizontal)");
    const wanted = name === "PipelinesScreen.swift" ? 1 : 0;
    if (horizontal !== wanted) faults.push(`${name} : ScrollView(.horizontal) ×${horizontal}, attendu ${wanted}`);
    if (count(source, "ScrollView(") !== vertical + horizontal) faults.push(`${name} : un ScrollView( d'un autre axe`);
    // Le panneau est le contenu du défilement : `.iosPanel()` tombe DANS son bloc.
    const at = source.indexOf("ScrollView(.vertical)");
    const open = at < 0 ? -1 : source.indexOf("{", at);
    if (open < 0 || !block(source, open).includes(".iosPanel()")) {
      faults.push(`${name} : .iosPanel() n'est pas dans le bloc du ScrollView(.vertical)`);
    }
  }
  return faults;
}

/** AC-3 : aucune hauteur imposée au panneau ni à ses listes — il suit son contenu. */
function heightFaults(root: string): string[] {
  const faults: string[] = [];
  for (const rel of [...SCREENS, "Design/IOSSurface.swift"]) {
    if (/maxHeight:\s*\.infinity/.test(code(root, rel))) faults.push(`${rel} : maxHeight: .infinity impose une hauteur`);
  }
  return faults;
}

/** AC-4 : le graphe reste hors de tout défilement, et garde ses gestes. */
function graphFaults(root: string): string[] {
  const faults: string[] = [];
  if (code(root, "IOSMemoryGraphView.swift").includes("ScrollView")) faults.push("IOSMemoryGraphView contient un ScrollView");
  const canvas = code(root, "IOSMemoryGraphView.swift");
  if (!canvas.includes("MagnifyGesture()")) faults.push("le canevas a perdu MagnifyGesture()");
  if (!canvas.includes("DragGesture(")) faults.push("le canevas a perdu DragGesture(");

  const screen = code(root, "IOSMemoryScreen.swift");
  const surface = screen.indexOf("var surface");
  const branch = surface < 0 ? -1 : screen.indexOf("if graph.shown {", surface);
  if (branch < 0) return [...faults, "IOSMemoryScreen : la propriété `surface` n'a pas de branche `if graph.shown {`"];
  const graphOpen = screen.indexOf("{", branch);
  const graphBlock = block(screen, graphOpen);
  if (!graphBlock.includes(".iosPanel()")) faults.push("la branche graphe ne rend pas .iosPanel()");
  if (graphBlock.includes("ScrollView")) faults.push("la branche graphe est dans un ScrollView");
  const rest = screen.slice(graphOpen + graphBlock.length);
  const elseAt = rest.search(/^\s*else\s*\{/);
  if (elseAt < 0) return [...faults, "la branche `else` de la surface est introuvable"];
  if (!block(rest, rest.indexOf("{", elseAt)).includes("ScrollView(.vertical)")) {
    faults.push("la branche liste n'est pas dans ScrollView(.vertical)");
  }
  return faults;
}

test("ios-panneau-sans-marge-scroll-imbrique/AC-2 : un seul défilement vertical, le panneau défile d'un bloc", () => {
  assert.deepEqual(scrollFaults(ROOT), []);

  // Faute plantée 1 : une `List` dans Sessions ⇒ rouge.
  const sessions = copyIOS();
  mutate(sessions, "IOSSessionsScreen.swift", (s) => s.replace("LazyVStack(", "List {} ; LazyVStack("));
  assert.ok(scrollFaults(sessions).some((f) => f.includes("IOSSessionsScreen") && f.includes("List")), "une List doit rougir");

  // Faute plantée 2 : `ScrollView(.vertical)` dans `boardContent` de Pipelines ⇒ rouge.
  const pipelines = copyIOS();
  mutate(pipelines, "PipelinesScreen.swift", (s) => s.replace("ScrollView(.horizontal)", "ScrollView(.vertical)"));
  assert.ok(scrollFaults(pipelines).some((f) => f.includes("PipelinesScreen") && f.includes("×2")), "un second défilement vertical doit rougir");
});

test("ios-panneau-sans-marge-scroll-imbrique/AC-3 : le panneau n'a aucune hauteur imposée", () => {
  assert.deepEqual(heightFaults(ROOT), []);

  // Faute plantée : `maxHeight: .infinity` dans `rowsList` ⇒ rouge.
  const copy = copyIOS();
  mutate(copy, "IOSMemoryScreen.swift", (s) => s.replace(/(LazyVStack\(alignment: \.leading, spacing: 0\) \{[\s\S]*?\n\s*\}\n)/, "$1.frame(maxWidth: .infinity, maxHeight: .infinity)\n"));
  assert.ok(heightFaults(copy).some((f) => f.includes("IOSMemoryScreen")), "une hauteur imposée doit rougir");
});

test("ios-panneau-sans-marge-scroll-imbrique/AC-4 : le graphe reste hors défilement et garde ses gestes", () => {
  assert.deepEqual(graphFaults(ROOT), []);

  // Faute plantée : envelopper la branche graphe dans un `ScrollView(.vertical)` ⇒ rouge.
  const copy = copyIOS();
  mutate(copy, "IOSMemoryScreen.swift", (s) => s.replace("if graph.shown {\n            stack.iosPanel()", "if graph.shown {\n            ScrollView(.vertical) { stack.iosPanel() }"));
  assert.ok(graphFaults(copy).some((f) => f.includes("branche graphe")), "un ScrollView autour du graphe doit rougir");
});
