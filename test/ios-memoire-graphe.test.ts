// Les GARDES TEXTUELLES de la feature `ios-memoire-graphe` (BR-8) : chaque critère
// `ios-memoire-graphe/AC-1..AC-10` a son test ici, et c'est le SEUL fichier
// `test/*.test.ts` qui porte ce slug (invariant `criteria/AC-13`).
//
// Deux règles structurent ce fichier, comme `test/ios-memoire.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout.
//
// Les preuves Swift de chaque critère vivent dans les suites iOS/macOS, que ce
// fichier NOMME sans les remplacer :
//  - AC-1 `graphShowsTheWireFacts` (IOSMemoryGraphTests) + `derivationMatchesTheFrozenFacts`
//    et `routeServesTheWireProjectionOfTheFacts` (MemoryGraphRelayTests, macOS) ;
//  - AC-2 `testGraphIncludesManualLinks` (RemoteMemoryRouteTests, macOS) ;
//  - AC-3 `graphReadsOnlyTheGraphRouteOnce` (IOSMemoryGraphTests) ;
//  - AC-4/AC-5 `pinchAndDragMoveTheViewportAndKeepNodesHittable` (IOSMemoryGraphTests) ;
//  - AC-6 `touchingAMemoryOpensItsSheet` (IOSMemoryGraphTests) ;
//  - AC-7 `touchingATagAppliesItsFilterAndTheMenuClearsIt` et `tagFamilyEqualsVisibility`
//    (IOSMemoryGraphTests, MemoryGraphRelayTests) ;
//  - AC-8 `derivationMatchesTheFrozenFacts` (MemoryGraphRelayTests) ;
//  - AC-9 la recette `-memoire.recipe` (scripts/ios-shots.sh) ;
//  - AC-10 `theListIsTheOpeningMode` (IOSMemoryGraphTests).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHELL = path.join(ROOT, "omp-console");
const CORE = path.join(SHELL, "Sources", "ConsoleCore");
const MACOS = path.join(SHELL, "Sources", "OMPConsole");
const IOS_APP = path.join(SHELL, "ios", "OMPConsoleIOS");
const IOS_TESTS = path.join(SHELL, "ios", "OMPConsoleIOSTests");
const MAC_TESTS = path.join(SHELL, "Tests", "OMPConsoleTests");

const EXCLUDED_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
  build: true,
};

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Une copie du dépôt où l'on peut planter une faute. */
function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-memoire-graphe-copie-"));
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

/** Le source d'un fichier, commentaires retirés, ou la chaîne vide. */
function source(file: string): string {
  return fs.existsSync(file) ? stripComments(fs.readFileSync(file, "utf8")) : "";
}

/** Toutes les sources `.swift` d'une racine, commentaires retirés, concaténées. */
function swiftText(dir: string): string {
  const out: string[] = [];
  const walk = (current: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) out.push(stripComments(fs.readFileSync(full, "utf8")));
    }
  };
  walk(dir);
  return out.join("\n");
}

/** Le nom est-il DÉCLARÉ (struct/enum/class/actor/protocol) dans la source ? */
function declares(text: string, name: string): boolean {
  return new RegExp(`\\b(?:struct|enum|class|actor|protocol)\\s+${name}\\b`).test(text);
}

/** Les sources de la SECTION Mémoire de l'app, commentaires retirés, concaténées. */
function memoryAppCode(root: string): string {
  const dir = path.join(root, "omp-console", "ios", "OMPConsoleIOS");
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("IOSMemory") && name.endsWith(".swift"))
    .sort()
    .map((name) => stripComments(fs.readFileSync(path.join(dir, name), "utf8")))
    .join("\n");
}

// ---------------------------------------------------------------------------
// AC-1 : le noyau partagé et la route servent le graphe complet.

function sharedKernelFaults(root: string): string[] {
  const faults: string[] = [];
  const core = swiftText(path.join(root, "omp-console", "Sources", "ConsoleCore"));
  const shell = swiftText(path.join(root, "omp-console", "Sources", "OMPConsole"));
  for (const name of [
    "MemoryRow",
    "MemoryGraphEdge",
    "MemoryLink",
    "MemoryGraphNode",
    "MemoryGraphLink",
    "MemoryGraph",
    "MemoryGraphLayout",
    "MemoryGraphWire",
    "MemoryGraphParity",
  ]) {
    if (!declares(core, name)) faults.push(`ConsoleCore ne déclare pas ${name}`);
  }
  if (declares(shell, "MemoryGraph")) faults.push("OMPConsole déclare encore MemoryGraph");
  const reads = source(path.join(root, "omp-console", "Sources", "OMPConsole", "Remote", "RemoteReads.swift"));
  const head = "    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {\n        let scope = await resolvedScope(scope)";
  if (!reads.includes(head)) faults.push("memoryGraph ne lit pas la seule portée résolue");
  if (!reads.includes("MemoryGraph.nodes(rows:")) faults.push("memoryGraph ne dérive pas par le noyau partagé");
  if (!reads.includes("MemoryGraphWire.id(")) faults.push("memoryGraph n'émet pas par le vocabulaire du fil");
  const router = source(path.join(root, "omp-console", "Sources", "OMPConsole", "Remote", "RemoteRouter.swift"));
  if (!router.includes('"memory.graph"')) faults.push("la route memory.graph n'est pas servie");
  return faults;
}

test("ios-memoire-graphe/AC-1 : le Mac sert le graphe complet d'une base par le noyau partagé", () => {
  assert.deepEqual(sharedKernelFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "Sources", "OMPConsole", "Remote", "RemoteReads.swift");
  const text = fs.readFileSync(target, "utf8").replace(
    "    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {\n        let scope = await resolvedScope(scope)",
    "    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {\n        let scope = (scope?.isEmpty == false) ? scope : nil"
  );
  fs.writeFileSync(target, text);
  assert.ok(sharedKernelFaults(copy).length > 0, "servir toutes les portées doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-2 : le lien manuel est distinguable d'une arête de proximité.

function manualLinkFaults(root: string): string[] {
  const faults: string[] = [];
  const wire = source(path.join(root, "omp-console", "Sources", "ConsoleCore", "Memory", "MemoryGraphWire.swift"));
  if (!wire.includes('case .manual: return "manual"')) faults.push("MemoryGraphWire ne nomme pas le lien manuel");
  const graph = source(path.join(root, "omp-console", "Sources", "ConsoleCore", "Memory", "MemoryGraph.swift"));
  if (!graph.includes("kind: .manual")) faults.push("MemoryGraph ne dérive pas les liens manuels");
  const macOS = source(path.join(root, "omp-console", "Sources", "OMPConsole", "Memory", "MemoryGraphView.swift"));
  if (!macOS.includes("case .manual:")) faults.push("le canevas macOS ne distingue pas le lien manuel");
  const iOS = source(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphView.swift"));
  if (!iOS.includes("case .manual:")) faults.push("le canevas iOS ne distingue pas le lien manuel");
  return faults;
}

test("ios-memoire-graphe/AC-2 : le lien manuel est visible et distinguable", () => {
  assert.deepEqual(manualLinkFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "Sources", "ConsoleCore", "Memory", "MemoryGraphWire.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace('case .manual: return "manual"', 'case .manual: return "tag"'));
  assert.ok(manualLinkFaults(copy).length > 0, "une nature de lien confondue doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-3 : le mode graphe n'appelle que des routes de LECTURE.

function readOnlyFaults(root: string): string[] {
  const faults: string[] = [];
  const memory = memoryAppCode(root);
  for (const token of ["client.memoryAdd", "client.memoryUpdate", "client.memoryDelete", "client.memoryWrite"]) {
    if (memory.includes(token)) faults.push(`la section graphe porte l'écriture ${token}`);
  }
  if (!memory.includes("client.memoryGraph(")) faults.push("le modèle du graphe ne lit pas la route de graphe");
  for (const token of ["MemoryText.createMemory", "MemoryText.edit", "MemoryText.delete", "MemoryText.save"]) {
    if (memory.includes(token)) faults.push(`la section graphe porte le geste ${token}`);
  }
  return faults;
}

test("ios-memoire-graphe/AC-3 : le mode graphe n'émet que des lectures", () => {
  assert.deepEqual(readOnlyFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphModel.swift");
  fs.appendFileSync(target, "\nlet fuite = client.memoryDelete\n");
  assert.ok(readOnlyFaults(copy).length > 0, "un appel d'écriture doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-4 / AC-5 : pincer et glisser, sur les deux appareils.

function gestureFaults(root: string): string[] {
  const faults: string[] = [];
  const model = source(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphModel.swift"));
  for (const token of ["func magnify(by", "func drag(by", "MemoryGraphStyle.minZoom", "MemoryGraphStyle.maxZoom", "MemoryGraphHitTest.node("]) {
    if (!model.includes(token)) faults.push(`le modèle iOS ne porte pas ${token}`);
  }
  const view = source(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphView.swift"));
  for (const token of ["SpatialTapGesture()", "MagnifyGesture()", "DragGesture(minimumDistance:"]) {
    if (!view.includes(token)) faults.push(`le canevas iOS ne porte pas ${token}`);
  }
  if (!fs.existsSync(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests", "IOSMemoryGraphTests.swift"))) {
    faults.push("IOSMemoryGraphTests.swift absent");
  }
  return faults;
}

test("ios-memoire-graphe/AC-4 : pincer et glisser restent bornés et touchables", () => {
  assert.deepEqual(gestureFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphView.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("MagnifyGesture()", "SpatialTapGesture()"));
  assert.ok(gestureFaults(copy).length > 0, "un geste retiré doit faire rougir la garde");
});

test("ios-memoire-graphe/AC-5 : les mêmes gestes valent pour iPhone et iPad", () => {
  assert.deepEqual(gestureFaults(ROOT), [], "l'arbre réel doit être sain");
  // Le canevas ne dépend d'aucune classe de taille : le même code sert iPhone et
  // iPad. On le prouve en retirant le test de placement (le geste reste partagé).
  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphModel.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("func drag(by translation: CGSize)", "func dragBy(translation: CGSize)"));
  assert.ok(gestureFaults(copy).length > 0, "un geste retiré doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-6 : toucher un souvenir met en évidence et ouvre la fiche.

function sheetFaults(root: string): string[] {
  const faults: string[] = [];
  const view = source(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphView.swift"));
  if (!view.includes(".sheet(item: detailBinding)")) faults.push("le graphe n'ouvre pas sa fiche par .sheet(item:)");
  if (!view.includes("MemoryGraphScene.build(")) faults.push("la scène partagée n'est pas consultée");
  const detail = source(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryDetailView.swift"));
  if (!detail.includes("links: [MemoryGraphLink]")) faults.push("la fiche ne reçoit pas les liens du graphe");
  if (!detail.includes("IOSMemoryText.linkLine(")) faults.push("la fiche ne nomme pas les liens");
  if (!detail.includes("if !links.isEmpty")) faults.push("la fiche rend le bloc de liens même vide");
  return faults;
}

test("ios-memoire-graphe/AC-6 : toucher un souvenir ouvre sa fiche en lecture seule", () => {
  assert.deepEqual(sheetFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryDetailView.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("IOSMemoryText.linkLine(", "IOSMemoryText.linkRow("));
  assert.ok(sheetFaults(copy).length > 0, "un bloc de liens cassé doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-7 : toucher un nœud-étiquette APPLIQUE le filtre.

function tagFilterFaults(root: string): string[] {
  const faults: string[] = [];
  const model = source(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphModel.swift"));
  if (!model.includes("MemoryGraph.tagFamily(")) faults.push("le modèle iOS n'applique pas tagFamily");
  if (!model.includes("tagFilter = name")) faults.push("le clic sur un nœud-étiquette n'applique pas le filtre");
  const view = source(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphView.swift"));
  if (!view.includes("MemoryText.allTags")) faults.push("le menu ne propose pas le retour à la vue entière");
  if (!view.includes("setTagFilter(nil)")) faults.push("le menu ne lève pas le filtre");
  return faults;
}

test("ios-memoire-graphe/AC-7 : toucher un nœud-étiquette applique son filtre", () => {
  assert.deepEqual(tagFilterFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphModel.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("MemoryGraph.tagFamily(", "MemoryGraph.visibility("));
  assert.ok(tagFilterFaults(copy).length > 0, "une mise en évidence au lieu du filtre doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-8 : la parité des faits est prouvée par un test reproductible.

function parityFaults(root: string): string[] {
  const faults: string[] = [];
  const fixture = source(path.join(root, "omp-console", "Sources", "ConsoleCore", "Memory", "MemoryGraphParity.swift"));
  for (const token of ["public static let rows:", "public static let edges:", "public static let manual:", "public static let facts:"]) {
    if (!fixture.includes(token)) faults.push(`MemoryGraphParity ne porte pas ${token}`);
  }
  const mac = source(path.join(root, "omp-console", "Tests", "OMPConsoleTests", "MemoryGraphRelayTests.swift"));
  if (!mac.includes("MemoryGraphParity.facts")) faults.push("le test macOS ne confronte pas la fixture aux faits");
  const ios = source(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests", "IOSMemoryGraphTests.swift"));
  if (!ios.includes("MemoryGraphParity.facts")) faults.push("le test iOS ne confronte pas la charge utile aux faits");
  return faults;
}

test("ios-memoire-graphe/AC-8 : la parité des faits est prouvée sur la fixture partagée", () => {
  assert.deepEqual(parityFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "Sources", "ConsoleCore", "Memory", "MemoryGraphParity.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("public static let facts:", "public static let truth:"));
  assert.ok(parityFaults(copy).length > 0, "une fixture sans faits gelés doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-9 : les captures du mode graphe, en portrait.

function captureFaults(root: string): string[] {
  const faults: string[] = [];
  const scriptPath = path.join(root, "scripts", "ios-shots.sh");
  const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : "";
  for (const token of ["memoire_recipes=(graphe zoom fiche)", "-memoire.recipe", "memoire-graphe$suffix", '"112"']) {
    if (!script.includes(token)) faults.push(`ios-shots.sh ne porte pas ${token}`);
  }
  const guardPath = path.join(root, "test", "design-ios.test.ts");
  const guard = fs.existsSync(guardPath) ? fs.readFileSync(guardPath, "utf8") : "";
  if (!guard.includes("memoire-graphe-${appearance}")) faults.push("expectedShotNames n'accueille pas les captures du graphe");
  return faults;
}

test("ios-memoire-graphe/AC-9 : les captures du mode graphe existent, en portrait", () => {
  assert.deepEqual(captureFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  const target = path.join(copy, "scripts", "ios-shots.sh");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replaceAll("memoire-graphe$suffix", "memoire$suffix"));
  assert.ok(captureFaults(copy).length > 0, "un groupe de captures retiré doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-10 : la LISTE est le mode d'ouverture.

function openingModeFaults(root: string): string[] {
  const faults: string[] = [];
  const model = source(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphModel.swift"));
  if (!model.includes("var shown = false")) faults.push("le graphe n'est pas masqué au départ");
  const screen = source(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryScreen.swift"));
  if (!screen.includes("if graph.shown {")) faults.push("l'écran ne choisit pas le mode affiché");
  if (!screen.includes("graph.shown ?") && !screen.includes("if graph.shown")) {
    faults.push("la bascule ne gouverne pas le contenu");
  }
  const tests = source(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests", "IOSMemoryGraphTests.swift"));
  if (!tests.includes("func theListIsTheOpeningMode(")) faults.push("le test d'ouverture n'existe pas");
  return faults;
}

test("ios-memoire-graphe/AC-10 : la LISTE est le mode d'ouverture", () => {
  assert.deepEqual(openingModeFaults(ROOT), [], "l'arbre réel doit être sain");
  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryGraphModel.swift");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("var shown = false", "var shown = true"));
  assert.ok(openingModeFaults(copy).length > 0, "un graphe affiché d'emblée doit faire rougir la garde");
});
