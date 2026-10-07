// Les GARDES TEXTUELLES de la coque iOS (coque-ios) : le projet Xcode, les
// sections dérivées du noyau partagé, la navigation, l'écran d'attente, la
// section « App iOS » de check.sh, le script de captures, la documentation et le
// périmètre (ni réseau, ni magasin, ni badge, ni Terminal ni Fichiers).
//
// Deux règles structurent ce fichier, comme `test/console-core.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel ne s'exécutent qu'au premier
//     niveau (`MEM0_CHECK_DEPTH` compte les niveaux : `check.sh` relance la suite
//     dans chaque copie).
//
// INVARIANT DE NOMMAGE : l'invariant `criteria/AC-13` exige qu'un slug de feature
// vive dans UN SEUL fichier de test, et qu'un id désigne UN SEUL test. TOUS les
// critères de `coque-ios` vivent donc ICI, un test par critère.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHELL = path.join(ROOT, "omp-console");
const IOS = path.join(SHELL, "ios");
const IOS_APP = path.join(IOS, "OMPConsoleIOS");

/** Profondeur d'imbrication : 0 = `node --test test/coque-ios.test.ts`. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

/** Hors de l'arbre réel (copie jetable ou suite relancée par `check.sh`). */
const IN_COPY = DEPTH > 0 || process.env.MEM0_OMP_SKIP_SWIFT_APP === "1" || process.env.MEM0_OMP_SKIP_IOS === "1";

// Ce qui n'a rien à faire dans une copie : l'historique, les dépendances, les
// racines de build et de types jetables, le stockage vectoriel local. Les
// racines de build Swift (`--scratch-path .build-<quoi>`) sont reconnues par
// PRÉFIXE : un scratch inconnu pèse des centaines de Mo.
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

/** Un dossier temporaire suivi, retiré en fin de suite. */
function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Une copie du dépôt où l'on peut planter une faute. Elle garde
 * `test/coque-ios.test.ts` (le test d'AC-10 le relancerait), mais jamais
 * `test/check.test.ts`, qui recopierait la copie.
 */
function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "coque-copie-"));
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

const output = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

/** Un `bash scripts/check.sh` dans une copie : la suite imbriquée le sait. */
function runCheck(cwd: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["scripts/check.sh"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      MEM0_CHECK_DEPTH: String(DEPTH + 1),
      MEM0_OMP_SKIP_SWIFT_APP: "1",
      MEM0_OMP_SKIP_IOS: "1",
      ...env,
    },
    timeout: 900_000,
  });
}

/** Une doublure d'exécutable dans un dossier temporaire, en tête de `PATH`. */
function stubBin(prefix: string): { bin: string; log: string } {
  const bin = tmpdir(prefix);
  const log = path.join(bin, "appels.log");
  return { bin, log };
}

function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

/**
 * Le source débarrassé de ses commentaires `//` et `/* … *\/` : un exemple cité
 * dans un en-tête n'est pas un import, ni une URL citée dans une explication un
 * appel réseau.
 */
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

/** Le source d'un fichier, commentaires retirés. */
function code(file: string): string {
  return stripComments(fs.readFileSync(file, "utf8"));
}

/** Toutes les sources Swift d'une racine, chemins absolus, ordre stable. */
function swiftFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".swift")) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** Tous les fichiers d'une racine, chemins absolus, ordre stable. */
function allFiles(dir: string, exclude: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (exclude(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** Les sources de l'APP iOS (la cible compilée), commentaires retirés. */
function appSources(root: string): { file: string; code: string }[] {
  return swiftFiles(path.join(root, "omp-console", "ios", "OMPConsoleIOS")).map((file) => ({ file, code: code(file) }));
}

/** Les sources Swift de TOUTE la coque iOS (app ET tests). */
function allIOSSources(root: string): { file: string; code: string }[] {
  return swiftFiles(path.join(root, "omp-console", "ios")).map((file) => ({ file, code: code(file) }));
}

/**
 * Le libellé d'attente que la coque iOS portait (coque-ios) et que design-ios a
 * RETIRÉ : sa réapparition, où que ce soit, est une régression.
 */
const RETIRED_WAITING = "Cet écran arrive dans un prochain segment.";

/**
 * Les dix-huit chaînes littérales interdites dans les sources de l'APP iOS : les
 * neuf `rawValue` et les neuf libellés. Recopiées ICI (jamais dans le code de
 * l'app) : c'est la garde d'AC-2.
 */
const SECTION_LITERALS = [
  "home",
  "kanban",
  "project",
  "session",
  "terminal",
  "sessions",
  "files",
  "memory",
  "stats",
  "Accueil",
  "Pipelines",
  "Projet",
  "Session OMP",
  "Terminal",
  "Sessions",
  "Fichiers",
  "Mémoire",
  "Statistiques",
];

/** Les jetons interdits dans les sources de l'app iOS (S-8). */
const FORBIDDEN_TOKENS = [
  "URLSession",
  "URLRequest",
  "NWConnection",
  "import Network",
  "http://",
  "https://",
  "UserDefaults",
  "SwiftData",
  "CoreData",
  "NSPersistentContainer",
  "FileManager",
  "PipelineStore",
  "StoreSnapshot",
  "StoreReader",
  "StoreWatcher",
  "StoreHub",
  "StatusBadge",
  "StatusPill",
  "AlertsModel",
  "AlertLedger",
];

/** Les cibles DECLAREES par le `.pbxproj`, chacune avec ses groupes synchronisés. */
type RawTarget = { id: string; groups: string[] };

/** Les cibles déclarées par un `project.pbxproj` : id et groupes synchronisés. */
function nativeTargets(pbxproj: string): RawTarget[] {
  const out: RawTarget[] = [];
  const blocks = pbxproj.split("/* Begin PBXNativeTarget section */")[1]?.split("/* End PBXNativeTarget section */")[0] ?? "";
  const pattern = /([0-9A-F]{24})\s*\/\*[^*]*\*\/\s*=\s*\{([\s\S]*?)\n\t\t\};/g;
  for (const match of blocks.matchAll(pattern)) {
    const body = match[2];
    const groups = /fileSystemSynchronizedGroups\s*=\s*\(([\s\S]*?)\);/.exec(body)?.[1] ?? "";
    out.push({
      id: match[1],
      groups: [...groups.matchAll(/([0-9A-F]{24})/g)].map((m) => m[1]),
    });
  }
  return out;
}

/** Les manques du projet Xcode (S-1, AC-1). Vide quand tout est là. */
function pbxprojFaults(root: string): string[] {
  const file = path.join(root, "omp-console", "ios", "OMPConsoleIOS.xcodeproj", "project.pbxproj");
  if (!fs.existsSync(file)) return ["project.pbxproj absent"];
  const text = fs.readFileSync(file, "utf8");
  const faults: string[] = [];

  const version = Number(/objectVersion\s*=\s*(\d+)\s*;/.exec(text)?.[1] ?? "0");
  if (version < 77) faults.push(`objectVersion ${version} < 77 (dossiers synchronisés)`);

  const syncSection = text.split("/* Begin PBXFileSystemSynchronizedRootGroup section */")[1]?.split("/* End PBXFileSystemSynchronizedRootGroup section */")[0] ?? "";
  const groupIds = new Map<string, string>();
  const groupPattern = /([0-9A-F]{24})\s*\/\*[^*]*\*\/\s*=\s*\{\s*isa = PBXFileSystemSynchronizedRootGroup;[\s\S]*?path = ([A-Za-z0-9_]+);/g;
  for (const match of syncSection.matchAll(groupPattern)) groupIds.set(match[1], match[2]);
  for (const expected of ["OMPConsoleIOS", "OMPConsoleIOSTests"]) {
    if (![...groupIds.values()].includes(expected)) faults.push(`groupe synchronisé ${expected} absent`);
  }

  const targets = nativeTargets(text);
  if (targets.length !== 2) faults.push(`${targets.length} cibles natives (2 attendues)`);
  for (const [id, name] of groupIds) {
    const owner = targets.find((t) => t.groups.includes(id));
    if (owner === undefined) faults.push(`groupe synchronisé ${name} rattaché à aucune cible`);
  }

  const references = text.split("/* Begin PBXFileReference section */")[1]?.split("/* End PBXFileReference section */")[0] ?? "";
  if (/path = [^;]*\.swift;/.test(references)) faults.push("un PBXFileReference pointe un .swift (le dossier doit être synchronisé)");

  for (const section of ["PBXSourcesBuildPhase"]) {
    const body = text.split(`/* Begin ${section} section */`)[1]?.split(`/* End ${section} section */`)[0] ?? "";
    const phases = body.match(/isa = PBXSourcesBuildPhase;[\s\S]*?runOnlyForDeploymentPostprocessing = 0;/g) ?? [];
    if (phases.length !== 2) faults.push(`${phases.length} phases ${section} (2 attendues)`);
    for (const phase of phases) {
      if (!/files = \(\s*\)/.test(phase)) faults.push(`une phase ${section} liste des fichiers (files non vide)`);
    }
  }

  if (!/XCLocalSwiftPackageReference;[\s\S]*?relativePath = \.\.;/.test(text)) faults.push("XCLocalSwiftPackageReference relativePath = .. absent");
  const packageRef = text.split("/* Begin PBXProject section */")[1]?.split("/* End PBXProject section */")[0] ?? "";
  if (!/packageReferences\s*=\s*\([\s\S]*?[0-9A-F]{24}/.test(packageRef)) faults.push("packageReferences vide");

  if (!/XCSwiftPackageProductDependency;[\s\S]*?productName = ConsoleCore;/.test(text)) faults.push("XCSwiftPackageProductDependency ConsoleCore absent");
  for (const target of targets) {
    const body = text.slice(text.indexOf(`\n\t\t${target.id} /*`));
    const dependencies = /packageProductDependencies\s*=\s*\(([\s\S]*?)\);/.exec(body)?.[1] ?? "";
    if (dependencies.trim() === "") faults.push(`une cible ne dépend pas de ConsoleCore`);
  }

  const required: [RegExp, string][] = [
    [/IPHONEOS_DEPLOYMENT_TARGET = 26\.0;/, "IPHONEOS_DEPLOYMENT_TARGET = 26.0"],
    [/TARGETED_DEVICE_FAMILY = "1,2";/, 'TARGETED_DEVICE_FAMILY = "1,2"'],
    [/SDKROOT = iphoneos;/, "SDKROOT = iphoneos"],
    [/PRODUCT_BUNDLE_IDENTIFIER = com\.omp\.console\.ios;/, "PRODUCT_BUNDLE_IDENTIFIER = com.omp.console.ios"],
    [/PRODUCT_BUNDLE_IDENTIFIER = com\.omp\.console\.ios\.tests;/, "PRODUCT_BUNDLE_IDENTIFIER = com.omp.console.ios.tests"],
    [/GENERATE_INFOPLIST_FILE = YES;/, "GENERATE_INFOPLIST_FILE = YES"],
    [/INFOPLIST_KEY_UILaunchScreen_Generation = YES;/, "INFOPLIST_KEY_UILaunchScreen_Generation = YES"],
  ];
  for (const [pattern, label] of required) {
    if (!pattern.test(text)) faults.push(`${label} absent`);
  }

  const scheme = path.join(root, "omp-console", "ios", "OMPConsoleIOS.xcodeproj", "xcshareddata", "xcschemes", "OMPConsoleIOS.xcscheme");
  if (!fs.existsSync(scheme)) faults.push("schéma partagé absent");
  else if (!/TestableReference/.test(fs.readFileSync(scheme, "utf8"))) faults.push("schéma sans TestAction testable");

  const manifest = fs.readFileSync(path.join(root, "omp-console", "Package.swift"), "utf8");
  if (!/\.iOS\(\.v26\)/.test(manifest)) faults.push("Package.swift ne déclare pas .iOS(.v26)");

  return faults;
}

/** Les manques de la dérivation des sections (S-2, AC-2). Vide quand tout est là. */
function sectionFaults(root: string): string[] {
  const faults: string[] = [];
  const sources = appSources(root);
  for (const { file, code: text } of sources) {
    for (const literal of SECTION_LITERALS) {
      if (text.includes(`"${literal}"`)) {
        faults.push(`${path.relative(root, file)} : littéral de section « ${literal} »`);
      }
    }
  }
  const all = sources.map((s) => s.code).join("\n");
  if (!all.includes("ConsoleSection.allCases")) faults.push("ConsoleSection.allCases absent des sources iOS");
  const declarations = all.match(/static let all\b/g) ?? [];
  if (declarations.length !== 1) faults.push(`${declarations.length} déclarations de IOSSection.all (1 attendue)`);
  if (!/static let all: \[ConsoleSection\] = ConsoleSection\.allCases\.filter/.test(all)) {
    faults.push("IOSSection.all n'est pas dérivé de ConsoleSection.allCases");
  }
  return faults;
}

/** Les manques de la navigation (S-3, AC-3). */
function navigationFaults(root: string): string[] {
  const faults: string[] = [];
  const all = appSources(root).map((s) => s.code).join("\n");
  if (!all.includes("NavigationSplitView")) faults.push("NavigationSplitView absent");
  if (all.includes("TabView")) faults.push("TabView présent (barre d'onglets interdite)");
  return faults;
}

/** Les manques des sept écrans et de l'argument de lancement (coque-ios/AC-4). */
function waitingFaults(root: string): string[] {
  const faults: string[] = [];
  const appDir = path.join(root, "omp-console", "ios", "OMPConsoleIOS");
  if (!fs.existsSync(path.join(appDir, "IOSSectionView.swift"))) faults.push("IOSSectionView.swift absent");
  if (fs.existsSync(path.join(appDir, "SectionPlaceholderView.swift"))) {
    faults.push("SectionPlaceholderView.swift toujours présent (l'écran d'attente a été remplacé)");
  }

  const shell = path.join(root, "omp-console");
  // Tout `swift build/test --scratch-path .build-<quoi>` crée une racine de build
  // dont les liens internes (`release`, `debug`) ne sont pas des fichiers : le
  // filtre se fait par PRÉFIXE, sinon un scratch inconnu (`.build-review`, …)
  // fait rougir cette garde sur une lecture de dossier (EISDIR).
  let occurrences = 0;
  for (const file of allFiles(shell, (rel) =>
    rel.split(path.sep).some((segment) => segment === "build" || segment.startsWith(".build")),
  )) {
    occurrences += fs.readFileSync(file, "utf8").split(RETIRED_WAITING).length - 1;
  }
  if (occurrences !== 0) {
    faults.push(`le libellé d'attente retiré apparaît ${occurrences} fois sous omp-console/ (0 attendue)`);
  }

  const app = appSources(root).map((s) => s.code).join("\n");
  if (!app.includes("ProcessInfo")) faults.push("ProcessInfo (argument de lancement) absent");
  if (app.includes("UserDefaults")) faults.push("UserDefaults présent (magasin local interdit)");
  return faults;
}

/** Les manques du script de captures (S-6, AC-6). */
function shotsFaults(root: string): string[] {
  const file = path.join(root, "scripts", "ios-shots.sh");
  if (!fs.existsSync(file)) return ["scripts/ios-shots.sh absent"];
  const text = fs.readFileSync(file, "utf8");
  const faults: string[] = [];
  for (const token of ["bootstatus", "install", "launch", "screenshot", "ios-build.sh"]) {
    if (!text.includes(token)) faults.push(`ios-shots.sh ne contient pas « ${token} »`);
  }
  if (!text.includes("omp-console/build/")) faults.push("ios-shots.sh n'écrit pas sous omp-console/build/");
  for (const literal of SECTION_LITERALS) {
    if (text.includes(`"${literal}"`) || text.includes(`'${literal}'`)) {
      faults.push(`ios-shots.sh : littéral de section « ${literal} »`);
    }
  }
  return faults;
}

/** Les manques de la documentation (S-7, AC-7). */
function docFaults(root: string): string[] {
  const faults: string[] = [];
  const readme = path.join(root, "omp-console", "README.md");
  const text = fs.readFileSync(readme, "utf8");
  if (!text.includes("## Coque iOS")) faults.push("section `## Coque iOS` absente");
  for (const token of [
    "xcodebuild -license accept",
    "open omp-console/ios/OMPConsoleIOS.xcodeproj",
    "scripts/ios-build.sh",
    "scripts/ios-shots.sh",
    "DEVELOPER_DIR",
    "-section",
    "omp-console/build/ios-shots/",
  ]) {
    if (!text.includes(token)) faults.push(`README console : « ${token} » absent`);
  }
  for (const token of ["appareil", "signature", "compte", "Mode développeur"]) {
    if (!text.includes(token)) faults.push(`README console : « ${token} » absent de la procédure d'appareil`);
  }
  const rootReadme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  if (!rootReadme.includes("omp-console/ios/")) faults.push("README racine ne cite pas omp-console/ios/");
  return faults;
}

/** Les manques du périmètre (S-8, AC-8). */
function tokenFaults(root: string): string[] {
  const faults: string[] = [];
  const sources = allIOSSources(root);
  for (const { file, code: text } of sources) {
    for (const token of FORBIDDEN_TOKENS) {
      if (text.includes(token)) faults.push(`${path.relative(root, file)} : jeton interdit « ${token} »`);
    }
    const declarations = text.match(/\b(?:struct|enum|class|actor|protocol)\s+(\w+)/g) ?? [];
    for (const declaration of declarations) {
      if (/Terminal|Files/.test(declaration)) faults.push(`${path.relative(root, file)} : déclaration « ${declaration} »`);
    }
  }
  const app = appSources(root).map((s) => s.code).join("\n");
  for (const excluded of [".terminal", ".files"]) {
    const count = app.split(excluded).length - 1;
    if (count !== 1) faults.push(`${count} occurrence(s) de ${excluded} dans les sources de l'app (1 attendue : le filtre)`);
  }
  return faults;
}

/** `xcodebuild` est-il utilisable (licence acceptée) sur ce poste ? */
function xcodebuildUsable(): boolean {
  const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
  const probe = spawnSync("xcodebuild", ["-showsdks"], {
    encoding: "utf8",
    env: { ...process.env, DEVELOPER_DIR: developerDir },
  });
  return probe.status === 0 && (probe.stdout ?? "").trim() !== "";
}

// AC-1 : le projet Xcode, son format de dossiers synchronisés et son câblage sur
// ConsoleCore. La garde textuelle tourne partout ; la compilation réelle d'un
// fichier neuf n'est tentée que sur macOS, hors copie, avec Xcode utilisable.
test("coque-ios/AC-1 : le .pbxproj est un projet à dossiers synchronisés câblé sur ConsoleCore", () => {
  assert.deepEqual(pbxprojFaults(ROOT), [], "l'arbre réel doit être sain");

  // Faute plantée : le format des dossiers synchronisés est ce qui fait qu'un
  // fichier neuf est compilé sans toucher au projet.
  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS.xcodeproj", "project.pbxproj");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("objectVersion = 77;", "objectVersion = 70;"));
  assert.ok(pbxprojFaults(copy).some((f) => f.includes("objectVersion")), "objectVersion 70 doit faire rougir la garde");

  // Preuve réelle (S-1) : un .swift neuf dans le dossier de l'app est compilé
  // sans qu'aucune ligne du .xcodeproj n'ait changé.
  if (process.platform === "darwin" && !IN_COPY && xcodebuildUsable()) {
    const built = copyRepo();
    const marker = path.join(built, "omp-console", "ios", "OMPConsoleIOS", "NouvelleSection.swift");
    fs.writeFileSync(marker, "import ConsoleCore\n\nlet nouvelleSection: ConsoleSection = .home\n");
    const before = fs.readFileSync(path.join(built, "omp-console", "ios", "OMPConsoleIOS.xcodeproj", "project.pbxproj"), "utf8");
    const run = spawnSync("bash", ["scripts/ios-build.sh", "--no-tests"], { cwd: built, encoding: "utf8", timeout: 900_000 });
    assert.equal(run.status, 0, output(run));
    assert.equal(
      fs.readFileSync(path.join(built, "omp-console", "ios", "OMPConsoleIOS.xcodeproj", "project.pbxproj"), "utf8"),
      before,
      "le .pbxproj ne doit pas avoir changé",
    );
  }
});

test("coque-ios/AC-2 : les sources de l'app ne recopient ni liste, ni libellé, ni rawValue de section", () => {
  assert.deepEqual(sectionFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  fs.writeFileSync(
    path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "SecondeListe.swift"),
    'let sections = ["home", "kanban"]\n',
  );
  const faults = sectionFaults(copy);
  assert.ok(faults.length > 0, "une seconde liste doit faire rougir la garde");
  assert.ok(faults.some((f) => f.includes("SecondeListe.swift")), `la garde doit nommer le fichier fautif : ${faults.join(" | ")}`);
});

test("coque-ios/AC-3 : une seule navigation adaptative, sans barre d'onglets", () => {
  assert.deepEqual(navigationFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  fs.writeFileSync(path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "Onglets.swift"), "struct Onglets: View { var body: some View { TabView { } } }\n");
  assert.ok(navigationFaults(copy).some((f) => f.includes("TabView")), "un TabView doit faire rougir la garde");
});

test("coque-ios/AC-4 : les sept écrans réels remplacent l'écran d'attente et l'argument de lancement reste lu", () => {
  assert.deepEqual(waitingFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  fs.writeFileSync(
    path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "SectionPlaceholderView.swift"),
    "let écranDAttente = 0\n",
  );
  assert.ok(
    waitingFaults(copy).some((f) => f.includes("SectionPlaceholderView")),
    "un écran d'attente qui revient doit faire rougir la garde",
  );

  const replant = copyRepo();
  fs.writeFileSync(
    path.join(replant, "omp-console", "ios", "OMPConsoleIOS", "Double.swift"),
    `let double = "${RETIRED_WAITING}"\n`,
  );
  assert.ok(waitingFaults(replant).some((f) => f.includes("retiré")), "le libellé retiré doit faire rougir la garde");
});

test("coque-ios/AC-5 : la section « App iOS » annonce « non exécuté » sans rougir, et durcit en CI", (t) => {
  const copy = copyRepo();
  const check = fs.readFileSync(path.join(copy, "scripts", "check.sh"), "utf8");
  const swiftSection = check.indexOf("── App Swift");
  const iosSection = check.indexOf("── App iOS");
  assert.ok(iosSection > 0, "la section « App iOS » est absente de check.sh");
  assert.ok(iosSection > swiftSection, "la section « App iOS » doit suivre « App Swift »");
  assert.ok(check.includes("MEM0_OMP_SKIP_IOS"), "check.sh ne connaît pas MEM0_OMP_SKIP_IOS");

  if (IN_COPY) {
    t.skip("copie jetable — la section réelle est éprouvée à la racine");
    return;
  }

  // Hors macOS, la section annonce « non exécuté », n'affiche AUCUNE ✓ et
  // n'appelle JAMAIS `xcodebuild` (le journal de la doublure reste vide).
  const { bin, log } = stubBin("ios-linux-");
  stub(bin, "uname", "printf 'Linux\\n'");
  stub(bin, "xcodebuild", `printf '%s\\n' "$*" >> '${log}'`);
  const idle = runCheck(copyRepo(), {
    PATH: `${bin}:${process.env.PATH}`,
    MEM0_OMP_SKIP_IOS: "",
    // La CI macOS pose MEM0_OMP_REQUIRE_IOS=1 pour TOUTE la suite : sans la
    // neutraliser ici, la copie « Linux » hériterait du durcissement et la
    // section rougirait — ce que ce cas ne teste pas.
    MEM0_OMP_REQUIRE_IOS: "",
  });
  const idleOut = output(idle);
  assert.equal(idle.status, 0, idleOut);
  assert.ok(idleOut.includes("── App iOS"), idleOut);
  assert.ok(idleOut.includes("non exécuté"), idleOut);
  assert.ok(!idleOut.includes("✓ App iOS"), `aucune ✓ ne doit être affichée : ${idleOut}`);
  assert.ok(!fs.existsSync(log) || fs.readFileSync(log, "utf8") === "", "xcodebuild ne doit jamais être appelé hors macOS");

  // La même absence, durcie par la variable de la CI macOS : c'est un échec.
  const strict = runCheck(copyRepo(), {
    PATH: `${bin}:${process.env.PATH}`,
    MEM0_OMP_SKIP_IOS: "",
    MEM0_OMP_REQUIRE_IOS: "1",
  });
  assert.notEqual(strict.status, 0, output(strict));
  assert.ok(output(strict).includes("✗ App iOS"), output(strict));
});

test("coque-ios/AC-6 : le script de captures réalise les cinq gestes et écrit un chemin ignoré par git", () => {
  assert.deepEqual(shotsFaults(ROOT), [], "l'arbre réel doit être sain");
  assert.ok(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").includes("omp-console/build/"), "omp-console/build/ doit être ignoré par git");

  const copy = copyRepo();
  const target = path.join(copy, "scripts", "ios-shots.sh");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replaceAll("bootstatus", "attente"));
  assert.ok(shotsFaults(copy).some((f) => f.includes("bootstatus")), "un geste manquant doit faire rougir la garde");
});

test("coque-ios/AC-7 : la documentation donne le simulateur et la procédure d'appareil réel", () => {
  assert.deepEqual(docFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const target = path.join(copy, "omp-console", "README.md");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("## Coque iOS", "## Coque"));
  assert.ok(docFaults(copy).some((f) => f.includes("## Coque iOS")), "une section absente doit faire rougir la garde");
});

test("coque-ios/AC-8 : aucun réseau, aucun magasin, aucun badge, ni Terminal ni Fichiers", () => {
  assert.deepEqual(tokenFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  fs.writeFileSync(
    path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "Reseau.swift"),
    'import Foundation\nlet session = URLSession.shared\n',
  );
  const faults = tokenFaults(copy);
  assert.ok(faults.length > 0, "un appel réseau doit faire rougir la garde");
  assert.ok(faults.some((f) => f.includes("URLSession")), `la garde doit nommer le jeton : ${faults.join(" | ")}`);
});
