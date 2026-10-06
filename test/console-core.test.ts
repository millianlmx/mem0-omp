// Les gardes TEXTUELLES du noyau partagé `ConsoleCore` : ce que le paquet déclare,
// ce qu'il contient, ce qu'il n'importe pas — sans toolchain Swift pour l'essentiel.
//
// Deux règles structurent ce fichier, comme `test/check.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel ne s'exécutent qu'au premier
//     niveau (`MEM0_CHECK_DEPTH` compte les niveaux : `check.sh` relance la suite
//     dans chaque copie).
//
// INVARIANT DE NOMMAGE : l'invariant `criteria/AC-13` exige qu'un slug de feature
// vive dans UN SEUL fichier de test. TOUS les critères de `noyau-partage-console`
// vivent donc ICI (AC-7 et AC-9 comprises), et aucun dans `check.test.ts`.
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
const CORE_SOURCES = path.join(SHELL, "Sources", "ConsoleCore");
const SHELL_SOURCES = path.join(SHELL, "Sources", "OMPConsole");

/** Profondeur d'imbrication : 0 = `node --test test/console-core.test.ts`. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

/** Hors de l'arbre réel (copie jetable ou suite relancée par `check.sh`). */
const IN_COPY = DEPTH > 0 || process.env.MEM0_OMP_SKIP_SWIFT_APP === "1";

// Ce qui n'a rien à faire dans une copie : l'historique, les dépendances, les
// racines de build et de types jetables, le stockage vectoriel local.
const EXCLUDED_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
  ".build": true,
  ".build-app": true,
  ".build-run": true,
  ".build-tests": true,
  ".build-core": true,
  ".build-ios": true,
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
 * `test/console-core.test.ts` (le test d'AC-10 le relance), mais jamais
 * `test/check.test.ts`, qui recopierait la copie.
 */
function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "noyau-copie-"));
  dirs.push(dir);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((segment) => EXCLUDED_DIRS[segment] === true)) return false;
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
    env: { ...process.env, MEM0_CHECK_DEPTH: String(DEPTH + 1), MEM0_OMP_SKIP_SWIFT_APP: "1", MEM0_OMP_SKIP_IOS: "1", ...env },
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

/**
 * Le source débarrassé de ses commentaires `//` et `/* … *\/`.
 *
 * Un exemple cité dans un en-tête (« un `import AppKit` ferait rougir ») n'est pas
 * un import, et une URL citée dans une explication n'est pas un chemin de route :
 * toutes les gardes de contenu passent par ici.
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

type DeclaredTarget = { name: string; factory: string; dependencies: string[] };

const FACTORY = /\.(target|executableTarget|testTarget|binaryTarget|systemLibrary|plugin)\s*\(/g;

/** La parenthèse fermante de celle qui s'ouvre à `open`, ou -1. */
function matchingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Les cibles DÉCLARÉES par un manifeste SwiftPM : fabrique, nom, dépendances.
 *
 * Le manifeste est lu en texte, jamais en JSON (`swift package describe` exige un
 * toolchain) : un commentaire du manifeste qui cite un nom de cible ne compte donc
 * pas, puisque les commentaires sont retirés avant l'analyse.
 */
function declaredTargets(pkgPath: string): DeclaredTarget[] {
  const source = stripComments(fs.readFileSync(pkgPath, "utf8"));
  const out: DeclaredTarget[] = [];
  for (const match of source.matchAll(FACTORY)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingParen(source, open);
    if (close === -1) continue;
    const args = source.slice(open + 1, close);
    const name = /name:\s*"([^"]+)"/.exec(args)?.[1];
    if (name === undefined) continue;
    const dependencies = /dependencies:\s*\[([^\]]*)\]/.exec(args)?.[1] ?? "";
    out.push({
      name,
      factory: match[1],
      dependencies: [...dependencies.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    });
  }
  return out;
}

/**
 * Les cibles déclarées par `omp-console/Package.swift` que `omp-console/README.md`
 * ne CITE pas. Rend `[]` quand tout est documenté.
 */
function undocumentedTargets(root: string): string[] {
  const targets = declaredTargets(path.join(root, "omp-console", "Package.swift"));
  const readme = fs.readFileSync(path.join(root, "omp-console", "README.md"), "utf8");
  return targets.filter((t) => !readme.includes(t.name)).map((t) => t.name);
}

/** Le nom d'un type est-il DÉCLARÉ (pas seulement étendu) dans `dir` ? */
function declaresType(dir: string, name: string): boolean {
  const pattern = new RegExp(`\\b(?:enum|struct|class|actor|protocol)\\s+${name}\\b`);
  return swiftFiles(dir).some((file) => pattern.test(code(file)));
}

/** Une copie jetable n'ayant que le manifeste et le README à confronter. */
function docOnlyCopy(): string {
  const dir = tmpdir("noyau-doc-");
  fs.mkdirSync(path.join(dir, "omp-console"), { recursive: true });
  for (const name of ["Package.swift", "README.md"]) {
    fs.copyFileSync(path.join(SHELL, name), path.join(dir, "omp-console", name));
  }
  return dir;
}

const SWIFT_SOURCES = path.join("Sources", "ConsoleCore");
const SHELL_SOURCES_REL = path.join("Sources", "OMPConsole");

/** Les vingt symboles déplacés de S-1/S-3 (type, ou fichier pour StoreModels/StoreRuns). */
const MOVED: string[] = [
  "PipelineStore",
  "StoreModels",
  "StoreSnapshot",
  "StoreRuns",
  "ConsoleSection",
  "ConsoleSectionGroup",
  "ConsoleTone",
  "ConsoleStatus",
  "PhaseText",
  "ConsoleFormat",
  "HomeText",
  "KanbanText",
  "ProjectViewText",
  "SessionConsoleText",
  "ConversationText",
  "MemoryText",
  "StatsPresentation",
  "ContractText",
  "SetupText",
];

/** Les cinq symboles qui RESTENT dans la coque (S-1). */
const SHELL_ONLY: string[] = ["StoreReader", "StoreWatcher", "StoreHub", "FilesText", "TerminalViewText"];

test("noyau-partage-console/AC-1 : ConsoleCore est une cible bibliothèque sans dépendance vers une autre cible du paquet", () => {
  const pkg = path.join(SHELL, "Package.swift");
  const manifest = declaredTargets(pkg);
  const core = manifest.find((t) => t.name === "ConsoleCore");
  assert.ok(core !== undefined, "ConsoleCore n'est pas déclarée dans omp-console/Package.swift");
  assert.equal(core.factory, "target", `ConsoleCore est déclarée par .${core.factory}( — cible régulière (bibliothèque) attendue`);

  const declared = manifest.map((t) => t.name);
  assert.deepEqual(
    core.dependencies.filter((d) => declared.includes(d)),
    [],
    `ConsoleCore dépend d'une autre cible du paquet : ${core.dependencies.join(", ")}`,
  );

  // La coque et ses tests consomment la cible partagée.
  assert.deepEqual(manifest.find((t) => t.name === "OMPConsole")?.dependencies, ["ConsoleCore"]);
  assert.deepEqual(manifest.find((t) => t.name === "OMPConsoleTests")?.dependencies, ["OMPConsole", "ConsoleCore"]);

  // Preuve SwiftPM de D2 : la cible décrite est bien une bibliothèque sans
  // `target_dependencies`. Hors copie, et sur macOS seulement : la garde est la
  // PLATEFORME, pas la présence de `swift` — les runners ubuntu-latest embarquent
  // un toolchain Swift, où le paquet ne compile pas (`StoreModels` importe
  // `Darwin`), et s'y fier faisait rougir la CI (même piège que
  // `socle-app-swift/AC-1`).
  if (IN_COPY || process.platform !== "darwin") return;
  const probe = spawnSync("swift", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return;
  const described = spawnSync("swift", ["package", "describe", "--type", "json"], {
    cwd: SHELL,
    encoding: "utf8",
    timeout: 300_000,
  });
  assert.equal(described.status, 0, `swift package describe : ${output(described)}`);
  const parsed = JSON.parse(described.stdout) as {
    targets: { name: string; type: string; target_dependencies?: string[] }[];
  };
  const entry = parsed.targets.find((t) => t.name === "ConsoleCore");
  assert.ok(entry !== undefined, `ConsoleCore absente de swift package describe : ${described.stdout}`);
  assert.equal(entry.type, "library", `ConsoleCore décrite « ${entry.type} »`);
  assert.deepEqual(entry.target_dependencies ?? [], [], "ConsoleCore déclare une dépendance de cible");
});

test("noyau-partage-console/AC-2 : les sources de ConsoleCore n'importent ni AppKit ni UIKit, et la cible se compile seule", () => {
  const files = swiftFiles(CORE_SOURCES);
  assert.ok(files.length > 0, "Sources/ConsoleCore est vide");
  const forbidden = /^\s*import\s+(AppKit|UIKit|Cocoa)\b/m;
  for (const file of files) {
    assert.ok(
      !forbidden.test(code(file)),
      `${path.relative(ROOT, file)} importe AppKit, UIKit ou Cocoa : ConsoleCore se compile aussi pour iOS`,
    );
  }

  // La cible SEULE, avec les Command Line Tools : la garde est la PLATEFORME, pas
  // la présence de `swift` — les runners ubuntu-latest embarquent un toolchain
  // Swift, où ConsoleCore ne compile pas (`StoreModels` importe `Darwin`) ; la
  // sonde qui s'y fiait rougissait `check (ubuntu-latest)` et `release-simulation`.
  if (IN_COPY) return;
  if (process.platform !== "darwin") {
    console.log("  · hors macOS — compilation de ConsoleCore non vérifiée");
    return;
  }
  if (spawnSync("swift", ["--version"], { encoding: "utf8" }).status !== 0) {
    console.log("  · swift absent — compilation de ConsoleCore non vérifiée");
    return;
  }
  const scratch = tmpdir("noyau-build-");
  const built = spawnSync("swift", ["build", "--target", "ConsoleCore", "--scratch-path", scratch], {
    cwd: SHELL,
    encoding: "utf8",
    timeout: 900_000,
  });
  assert.equal(built.status, 0, `swift build --target ConsoleCore : ${output(built)}`);
});

test("noyau-partage-console/AC-3 : chaque symbole déplacé n'est plus déclaré que dans ConsoleCore", () => {
  for (const name of MOVED) {
    const inCore = declaresType(CORE_SOURCES, name) || swiftFiles(CORE_SOURCES).some((f) => path.basename(f) === `${name}.swift`);
    assert.ok(inCore, `${name} n'est déclaré ni comme type ni comme fichier sous ${SWIFT_SOURCES}`);
    assert.ok(
      !declaresType(SHELL_SOURCES, name),
      `${name} est ENCORE déclaré sous ${SHELL_SOURCES_REL} (une extension y est légitime, une déclaration non)`,
    );
  }
  for (const name of SHELL_ONLY) {
    assert.ok(declaresType(SHELL_SOURCES, name), `${name} devrait rester déclaré sous ${SHELL_SOURCES_REL}`);
    assert.ok(!declaresType(CORE_SOURCES, name), `${name} ne doit pas être déclaré dans ConsoleCore`);
  }
});

test("noyau-partage-console/AC-4 : ConsoleCore porte le socle de l'API distante et aucune charge utile de route", () => {
  assert.ok(declaresType(CORE_SOURCES, "ConsoleAPI"), "ConsoleAPI n'est pas déclaré dans ConsoleCore");
  assert.ok(declaresType(CORE_SOURCES, "ConsoleAPIError"), "ConsoleAPIError n'est pas déclaré dans ConsoleCore");
  assert.ok(!declaresType(SHELL_SOURCES, "ConsoleAPI"), "ConsoleAPI est déclaré deux fois");

  // La version du protocole vit en UN point : un seul littéral dans tout le paquet.
  const versions = swiftFiles(CORE_SOURCES).filter((file) => /\bprotocolVersion\b\s*(?::[^=]*)?=\s*\d/.test(code(file)));
  assert.equal(versions.length, 1, `protocolVersion déclaré ${versions.length} fois : ${versions.join(", ")}`);

  const forbidden: [RegExp, string][] = [
    [/\/memory\//, "un chemin de route /memory/"],
    [/http:\/\//, "une URL http://"],
    [/https:\/\//, "une URL https://"],
    [/\bURLSession\b/, "URLSession"],
    [/\b(?:struct|enum|class|actor)\s+\w*(?:Request|Response)\b/, "un type …Request/…Response"],
  ];
  for (const file of swiftFiles(CORE_SOURCES)) {
    const body = code(file);
    for (const [pattern, label] of forbidden) {
      assert.ok(!pattern.test(body), `${path.relative(ROOT, file)} porte ${label} : ConsoleCore n'est pas le serveur`);
    }
  }
});

test("noyau-partage-console/AC-7 : un import AppKit dans ConsoleCore fait rougir check.sh en nommant le fichier", (t) => {
  if (IN_COPY) {
    t.skip("copie jetable — la garde de check.sh est vérifiée à la racine");
    return;
  }
  const copy = copyRepo();
  const source = path.join(copy, "omp-console", "Sources", "ConsoleCore", "Support", "RealPath.swift");
  assert.ok(fs.existsSync(source), `source de la copie introuvable : ${source}`);
  const lines = fs.readFileSync(source, "utf8").split("\n");
  const anchor = lines.indexOf("import Darwin");
  assert.ok(anchor !== -1, "l'ancre « import Darwin » a disparu de RealPath.swift");
  lines.splice(anchor + 1, 0, "import AppKit");
  fs.writeFileSync(source, lines.join("\n"));
  // Le fautif est le fichier ET la ligne : la ligne de l'import planté, 1-indexée.
  const fault = `la cible partagée ConsoleCore importe AppKit : omp-console/Sources/ConsoleCore/Support/RealPath.swift:${anchor + 2}`;

  const run = runCheck(copy);
  const out = output(run);
  assert.notEqual(run.status, 0, `check.sh devait être rouge :\n${out}`);
  assert.ok(out.includes(fault), `check.sh doit nommer le fichier ET la ligne fautifs (« ${fault} ») :\n${out}`);
});

test("noyau-partage-console/AC-8 : un test purement textuel confronte les cibles du paquet au README de la coque", () => {
  assert.deepEqual(undocumentedTargets(ROOT), [], "une cible du paquet n'est pas citée par omp-console/README.md");

  // Cible fantôme : déclarée au manifeste, absente du README ⇒ échec.
  const ghost = docOnlyCopy();
  const pkg = path.join(ghost, "omp-console", "Package.swift");
  fs.writeFileSync(pkg, fs.readFileSync(pkg, "utf8").replace(
    '.target(name: "ConsoleCore"',
    '.target(name: "CibleFantome", path: "Sources/CibleFantome"),\n        .target(name: "ConsoleCore"',
  ));
  assert.deepEqual(undocumentedTargets(ghost), ["CibleFantome"]);

  // ConsoleCore retirée du README ⇒ échec.
  const dropped = docOnlyCopy();
  const readme = path.join(dropped, "omp-console", "README.md");
  fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replaceAll("ConsoleCore", "Noyau"));
  assert.deepEqual(undocumentedTargets(dropped), ["ConsoleCore"]);
});

test("noyau-partage-console/AC-9 : la section « App Swift » compile et teste le paquet entier, ConsoleCore comprise", () => {
  // Aucune liste de cibles dans les invocations : un `--target`/`--product`
  // restreindrait la compilation et laisserait ConsoleCore hors du verdict.
  const script = path.join(ROOT, "scripts", "swift-app.sh");
  const body = stripComments(fs.readFileSync(script, "utf8"));
  assert.ok(!/--target\b/.test(body), "scripts/swift-app.sh restreint la compilation par --target");
  assert.ok(!/--product\b/.test(body), "scripts/swift-app.sh restreint la compilation par --product");
  assert.match(body, /swift test\b/, "scripts/swift-app.sh ne lance plus swift test");
  assert.match(body, /swift build\b/, "scripts/swift-app.sh ne lance plus swift build");

  // Le paquet déclare ConsoleCore : la compilation sans liste de cibles la couvre.
  assert.ok(
    declaredTargets(path.join(SHELL, "Package.swift")).some((t) => t.name === "ConsoleCore"),
    "ConsoleCore n'est plus déclarée : la compilation du paquet ne la couvrirait plus",
  );
});

test("noyau-partage-console/AC-10 : aucune garde nouvelle n'exige macOS ni un toolchain Swift", (t) => {
  // (1) La section « Noyau partagé » est du python3 pur : ni `swift`, ni `uname`.
  const check = fs.readFileSync(path.join(ROOT, "scripts", "check.sh"), "utf8");
  const [head, tail] = check.split("── Noyau partagé");
  assert.ok(tail !== undefined, "la section « Noyau partagé » a disparu de scripts/check.sh");
  const section = tail.split("── App Swift")[0];
  assert.ok(!/\bswift\b/.test(stripComments(section)), "la garde de portabilité nomme swift");
  assert.ok(!/\buname\b/.test(stripComments(section)), "la garde de portabilité dépend de la plateforme");
  assert.ok(head !== undefined && section.includes("python3"), "la garde de portabilité doit tourner sans toolchain Swift");

  if (IN_COPY) {
    t.skip("copie jetable — la suite sans toolchain est vérifiée à la racine");
    return;
  }

  // (2) Sur un poste où `swift` est INUTILISABLE, la copie reste verte — la
  // doublure journalise, donc un appel à swift se verrait même s'il réussissait.
  const { bin, log } = stubBin("noyau-sans-swift-");
  stub(bin, "uname", "printf 'Linux\\n'");
  stub(bin, "swift", `printf '%s\\n' "$*" >> '${log}'\nexit 127`);

  const copy = copyRepo();
  const run = runCheck(copy, { PATH: `${bin}:${process.env.PATH}`, MEM0_OMP_SKIP_SWIFT_APP: "" });
  const out = output(run);
  assert.equal(run.status, 0, out);
  assert.ok(out.includes("✓ la cible partagée ConsoleCore n'importe ni AppKit ni UIKit"), out);
  assert.ok(!fs.existsSync(log), `swift ne doit jamais être appelé : ${fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""}`);
});
