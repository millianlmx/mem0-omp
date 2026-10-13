// Tests de `scripts/check.sh` : le script est ce qui décide qu'un dépôt est
// publiable, donc ses contrôles doivent être éprouvés comme du code.
//
// Trois règles structurent ce fichier :
//  1. Tout ce qui doit ÉCHOUER (import de valeur, version divergente, commande
//     fantôme, extension qui ne se transpile pas) est planté dans une COPIE
//     TEMPORAIRE du dépôt — jamais dans l'arbre réel, qui doit rester publiable.
//     `test/outillage/check.test.ts` n'y est jamais recopié (../support/repo.ts) :
//     le contrôle `── Tests` d'un check.sh complet y relancerait la suite, qui
//     recopierait la copie sans fin.
//  2. Chaque injection de faute ne lance QUE la section dont elle observe le
//     message (`check.sh --sections=<id>`) : un check.sh complet par copie coûtait
//     ≈ 8 s pour un verdict porté par une seule section. Un seul test (check/AC-14,
//     la commande fantôme) garde un check.sh SANS option, pour prouver qu'une
//     section rouge fait échouer le script entier.
//  3. Les vérifications qui portent sur l'arbre réel (sections vertes, les deux
//     extensions transpilées) ne s'exécutent qu'au premier niveau : lancées depuis
//     la suite qu'elles déclenchent, elles se rappelleraient elles-mêmes.
//     `MEM0_CHECK_DEPTH` compte ces niveaux.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, copyRepo as copyRepoAs, tmpdir } from "../support/repo.ts";
import { SONDE_ACTIONSDATA, SWIFT_CONST_VALUES_SNIPPET, writeXcodeDoubles } from "../support/swift-app-doubles.ts";

const CATALOGS = [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"];

/** Profondeur d'imbrication : 0 = `node --test test/outillage/check.test.ts` à la main. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

/** Un `bash scripts/check.sh` dans une copie relance la suite : on le lui dit. */
// `MEM0_OMP_SKIP_SWIFT_APP=1` évite qu'une copie jetable paie une compilation
// Swift complète (≈ 35 s) alors qu'elle vérifie une AUTRE section. Les deux tests
// qui éprouvent la section « App Swift » neutralisent la variable (valeur vide).
// `MEM0_OMP_SKIP_IOS=1` fait de même pour la section « App iOS » (BR-3) : sans
// elle, chaque copie paierait un `xcodebuild` là où Xcode est utilisable.
const NESTED_ENV = {
  ...process.env,
  MEM0_CHECK_DEPTH: String(DEPTH + 1),
  MEM0_OMP_SKIP_SWIFT_APP: "1",
  MEM0_OMP_SKIP_IOS: "1",
  // La section Rust (cargo, contrat boîte noire contre mem0-rs) démarre de vrais
  // serveurs : aucune copie jetable ne la relance, la racine l'exécute.
  MEM0_OMP_SKIP_RUST: "1",
};

/**
 * Une copie ÉLAGUÉE à un seul fichier de test : la section `── Types`
 * type-checke tout `test/**`, `── Tests` relance chaque fichier gardé, et aucune
 * autre section ne lit les fichiers de test — les recopier ne ferait qu'allonger
 * la copie, le type-check et la suite imbriquée.
 */
function copyRepo(): string {
  return copyRepoAs("check-copie-", { keepTest: (rel) => rel === "test/memoire/dedupe.test.ts" });
}

const output = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

/**
 * `bash scripts/check.sh --sections=<sections>` dans `cwd` ; `sections: null`
 * lance le script SANS option (toutes les sections).
 */
function runCheck(cwd: string, sections: string | null, env: Record<string, string> = {}) {
  return spawnSync("bash", ["scripts/check.sh", ...(sections === null ? [] : [`--sections=${sections}`])], {
    cwd,
    encoding: "utf8",
    env: { ...NESTED_ENV, ...env },
    timeout: 600_000,
  });
}

const executable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

type CatalogEntry = { name: string; commands?: string[]; version?: string };
type Catalog = { metadata?: { version?: string }; plugins: CatalogEntry[] };

/** Applique la MÊME mutation aux deux catalogues, qui doivent rester identiques. */
function editCatalogs(dir: string, mutate: (cat: Catalog) => void): void {
  for (const rel of CATALOGS) {
    const full = path.join(dir, rel);
    const cat = JSON.parse(fs.readFileSync(full, "utf8")) as Catalog;
    mutate(cat);
    fs.writeFileSync(full, `${JSON.stringify(cat, null, 2)}\n`);
  }
}

function entryOf(cat: Catalog, name: string): CatalogEntry {
  const entry = cat.plugins.find((p) => p.name === name);
  assert.ok(entry, `entrée ${name} absente du catalogue`);
  return entry;
}

test("check/AC-10 : un import de valeur depuis @oh-my-pi fait échouer check.sh en nommant le fichier", () => {
  const dir = copyRepo();
  const target = path.join(dir, "omp-mem0-req/extension.ts");
  const source = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, `import { x } from "@oh-my-pi/pi-coding-agent";\n${source}`);

  const bad = runCheck(dir, "extension");
  assert.notEqual(bad.status, 0, output(bad));
  // Message exact du contrat, fichier et ligne compris : la ligne de `pass`
  // (« aucun import de valeur… ») contiendrait le même motif sans le préfixe.
  assert.ok(
    output(bad).includes(
      "✗ import de valeur depuis @oh-my-pi/* — omp-mem0-req/extension.ts:1 ; " +
        "préfère 'import type', effacé à la compilation",
    ),
    output(bad),
  );

  // Le même import écrit en `import type` ne déclenche pas le contrôle : la
  // section reste verte sur ce point, sa ligne de `pass` le dit.
  const typed = copyRepo();
  const typedTarget = path.join(typed, "omp-mem0-req/extension.ts");
  fs.writeFileSync(
    typedTarget,
    `import type { x } from "@oh-my-pi/pi-coding-agent";\n${fs.readFileSync(typedTarget, "utf8")}`,
  );
  const clean = runCheck(typed, "extension");
  assert.ok(!output(clean).includes("✗ import de valeur depuis @oh-my-pi/*"), output(clean));
  assert.ok(
    output(clean).includes("✓ aucun import de valeur depuis @oh-my-pi/* (2 plugins contrôlés)"),
    output(clean),
  );
});

test("check/AC-14 : une commande déclarée au catalogue sans registerCommand fait échouer check.sh", () => {
  const dir = copyRepo();
  editCatalogs(dir, (cat) => {
    const entry = entryOf(cat, "omp-mem0-req");
    entry.commands = [...(entry.commands ?? []), "commande-fantome"];
  });
  // Le SEUL check.sh sans option du fichier (règle 2 de l'en-tête) : une section
  // rouge (`── Plugins`) fait échouer le script entier, pas seulement sa section.
  const ghost = runCheck(dir, null);
  assert.notEqual(ghost.status, 0, output(ghost));
  assert.ok(
    output(ghost).includes(
      "omp-mem0-req : commande déclarée sans registerCommand : commande-fantome",
    ),
    output(ghost),
  );

  // Sens inverse : la commande reste déclarée, mais cesse d'être enregistrée.
  const orphan = copyRepo();
  const extension = path.join(orphan, "omp-mem0-req/extension.ts");
  const source = fs.readFileSync(extension, "utf8");
  const renamed = source.replace(
    /pi\.registerCommand\(\s*"pipelines"/,
    'pi.registerCommand("panneau-detache"',
  );
  assert.notEqual(renamed, source, "registerCommand(\"pipelines\") introuvable dans omp-mem0-req");
  fs.writeFileSync(extension, renamed);

  const missing = runCheck(orphan, "plugins");
  assert.notEqual(missing.status, 0, output(missing));
  assert.ok(
    output(missing).includes("omp-mem0-req : commande déclarée sans registerCommand : pipelines"),
    output(missing),
  );
});

test("check/AC-15 : une version d'entrée ou de metadata divergente fait échouer check.sh", () => {
  // Les versions attendues sont LUES sur l'arbre, jamais écrites en dur : un bump
  // de version ne doit pas transformer ce test en test de régression du chiffre.
  const pkgVersion = JSON.parse(
    fs.readFileSync(path.join(ROOT, "omp-mem0-memory", "package.json"), "utf8"),
  ).version as string;
  const catalogMeta = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".omp-plugin", "marketplace.json"), "utf8"),
  ).metadata.version as string;
  const bogus = "9.9.8";

  const diverged = copyRepo();
  editCatalogs(diverged, (cat) => {
    entryOf(cat, "omp-mem0-memory").version = bogus;
  });
  const entryOut = runCheck(diverged, "versions");
  assert.notEqual(entryOut.status, 0, output(entryOut));
  assert.ok(
    output(entryOut).includes(`omp-mem0-memory : version d'entrée ${bogus} ≠ package.json ${pkgVersion}`),
    output(entryOut),
  );

  const orphanMeta = copyRepo();
  editCatalogs(orphanMeta, (cat) => {
    if (!cat.metadata) cat.metadata = {};
    cat.metadata.version = "9.9.9";
  });
  const metaOut = runCheck(orphanMeta, "versions");
  assert.notEqual(metaOut.status, 0, output(metaOut));
  assert.ok(output(metaOut).includes("metadata.version 9.9.9"), output(metaOut));

  // L'état publié de la branche passe : c'est l'autre moitié du critère.
  if (DEPTH === 0) {
    const real = runCheck(ROOT, "versions");
    assert.equal(real.status, 0, output(real));
    assert.ok(output(real).includes(`metadata.version ${catalogMeta} nomme une version publiée`), output(real));
  }
});

test("check/AC-16 : les deux extensions sont transpilées, omp-mem0-req comprise", (t) => {
  const npx = spawnSync("bash", ["-c", "command -v npx"], { encoding: "utf8" });
  if (npx.status !== 0) {
    t.skip("npx absent — transpilation non vérifiée");
    return;
  }

  const dir = copyRepo();
  const target = path.join(dir, "omp-mem0-req/extension.ts");
  fs.writeFileSync(target, `const x = ;\n${fs.readFileSync(target, "utf8")}`);
  const broken = runCheck(dir, "extension");
  assert.notEqual(broken.status, 0, output(broken));
  assert.ok(
    output(broken).includes("omp-mem0-req/extension.ts ne se transpile pas"),
    output(broken),
  );

  if (DEPTH === 0) {
    const real = runCheck(ROOT, "extension");
    assert.ok(output(real).includes("les 2 extensions se transpilent"), output(real));
  }
});

test("check/AC-17 : la CI exerce check.sh sur macOS et Ubuntu", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/check.yml"), "utf8");

  // Job `check` : Ubuntu seul, toutes les sections (check.sh sans option).
  const matrix = /matrix:\s*\n\s*os:\s*\[([^\]]*)\]/.exec(workflow);
  assert.ok(matrix, `matrice \`os\` absente du workflow :\n${workflow}`);
  const systems = matrix[1].split(",").map((s) => s.trim());
  assert.deepEqual(systems, ["ubuntu-latest"]);
  assert.match(workflow, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  assert.match(workflow, /run: \.\/scripts\/check\.sh\s*$/m);

  // macOS : jobs parallèles qui lancent check.sh par sections, et leur agrégateur.
  assert.match(workflow, /^ {4}name: check \(macos-latest\)$/m);
  const macosJobs = workflow
    .split(/^ {2}(?=[A-Za-z0-9_-]+:$)/m)
    .filter((job) => /^ {4}runs-on: macos-latest$/m.test(job));
  assert.ok(
    macosJobs.some((job) => job.includes("./scripts/check.sh --sections=")),
    `aucun job macos-latest ne lance ./scripts/check.sh --sections= :\n${workflow}`,
  );
});

test("check/AC-18 : le type-check de omp-mem0-req contre les types de l'hôte est sans erreur", (t) => {
  const script = path.join(ROOT, "scripts/typecheck.sh");
  if (!fs.existsSync(script)) {
    t.skip("scripts/typecheck.sh absent — type-check non vérifié");
    return;
  }

  const run = spawnSync("bash", ["scripts/typecheck.sh"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 900_000,
  });
  const out = output(run);
  // Le type-check n'a de sens que si les types de l'hôte sont là : le script le
  // dit et sort 0, on ne prétend donc pas avoir vérifié quoi que ce soit.
  if (out.includes("types de l'hôte absents")) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.equal(run.status, 0, out);
  assert.ok(!out.includes("error TS"), out);
});

// ---------------------------------------------------------------------------
// S-1 à S-4 (AC-1, AC-2, AC-3, AC-4, AC-6, AC-7) — la couverture du type-check
// ---------------------------------------------------------------------------
//
// Chaque test plante une erreur de type VALIDE À L'EXÉCUTION (`const q: number =
// "boom"`) dans une copie JETABLE : `--experimental-strip-types` efface les
// annotations, donc seule la section `── Types` de check.sh rougit (cf. `##
// Documentation`, « Node.js 26.7.0 »). Chaque copie ne lance donc que cette
// section (`--sections=types`), élaguée à un seul fichier de test.

/** Sans les types de l'hôte, `typecheck.sh` l'annonce et sort 0 : aucune preuve. */
const HOST_TYPES_ABSENT = "types de l'hôte absents";

const hostTypesAbsent = (out: string): boolean => out.includes(HOST_TYPES_ABSENT);

test("check/AC-1 : une erreur de type dans un module de omp-mem0-memory fait échouer check.sh en nommant le fichier", (t) => {
  const dir = copyRepo();
  const target = path.join(dir, "omp-mem0-memory/brief.ts");
  fs.writeFileSync(target, `const q: number = "boom";\n${fs.readFileSync(target, "utf8")}`);

  const bad = runCheck(dir, "types");
  if (hostTypesAbsent(output(bad))) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.notEqual(bad.status, 0, output(bad));
  assert.ok(output(bad).includes("✗ type-check : "), output(bad));
  assert.ok(output(bad).includes("omp-mem0-memory/brief.ts("), output(bad));
  assert.ok(output(bad).includes("error TS2322"), output(bad));
});

test("check/AC-2 : une erreur de type dans un fichier de test fait échouer check.sh en nommant le fichier", (t) => {
  const dir = copyRepo();
  const target = path.join(dir, "test/memoire/dedupe.test.ts");
  fs.writeFileSync(target, `const q: number = "boom";\n${fs.readFileSync(target, "utf8")}`);

  const bad = runCheck(dir, "types");
  if (hostTypesAbsent(output(bad))) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.notEqual(bad.status, 0, output(bad));
  assert.ok(output(bad).includes("test/memoire/dedupe.test.ts("), output(bad));
  assert.ok(output(bad).includes("error TS2322"), output(bad));
});

test("check/AC-3 : un .ts neuf des deux arbres est type-checké sans retouche de configuration", (t) => {
  const dir = copyRepo();
  fs.writeFileSync(path.join(dir, "omp-mem0-memory/zz-neuf.ts"), `export const q: number = "boom";\n`);
  fs.writeFileSync(path.join(dir, "test/zz-neuf.ts"), `export const q: number = "boom";\n`);

  // Les deux chemins sont exigés : le second prouve que le programme des tests
  // tourne MALGRÉ l'échec du premier (aucun court-circuit entre les deux).
  const bad = runCheck(dir, "types");
  if (hostTypesAbsent(output(bad))) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.notEqual(bad.status, 0, output(bad));
  assert.ok(output(bad).includes("omp-mem0-memory/zz-neuf.ts("), output(bad));
  assert.ok(output(bad).includes("test/zz-neuf.ts("), output(bad));
});

test("check/AC-4 : le type-check tourne en strict (valeur possiblement nulle refusée)", (t) => {
  const dir = copyRepo();
  const target = path.join(dir, "omp-mem0-memory/brief.ts");
  fs.writeFileSync(
    target,
    `const s: string | null = null;\nexport const n = s.length;\n${fs.readFileSync(target, "utf8")}`,
  );

  // Sonde de `strictNullChecks` : sans `strict`, `s.length` passerait. L'autre
  // moitié d'AC-4 (« arbre non modifié, 0 erreur ») est portée par check/AC-18.
  const bad = runCheck(dir, "types");
  if (hostTypesAbsent(output(bad))) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.notEqual(bad.status, 0, output(bad));
  assert.ok(output(bad).includes("omp-mem0-memory/brief.ts("), output(bad));
  assert.ok(output(bad).includes("error TS18047"), output(bad));
});

test("check/AC-5 : la CI fournit les types de l'hôte et une racine déclarée inutilisable échoue", () => {
  // (a) Les deux jobs de la matrice exportent les types et exécutent check.sh :
  // une erreur de type ne peut donc pas passer pour un « types absents ».
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/check.yml"), "utf8");
  assert.ok(workflow.includes("MEM0_OMP_HOST_TYPES="), workflow);
  assert.ok(workflow.includes("./scripts/check.sh"), workflow);

  // (b) Une racine DÉCLARÉE fait autorité : inutilisable, elle échoue en la
  // nommant, sans retomber sur une autre racine ni sur la ligne de dégradation.
  const empty = tmpdir("host-types-vide-");
  const run = spawnSync("bash", ["scripts/typecheck.sh"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, MEM0_OMP_HOST_TYPES: empty },
  });
  const out = output(run);
  assert.notEqual(run.status, 0, out);
  assert.ok(out.includes("MEM0_OMP_HOST_TYPES"), out);
  assert.ok(!out.includes(HOST_TYPES_ABSENT), out);
});

test("check/AC-6 : un fichier de test peut utiliser une API ES2024 (Promise.withResolvers)", (t) => {
  const dir = copyRepo();
  const target = path.join(dir, "test/memoire/dedupe.test.ts");
  fs.writeFileSync(
    target,
    `export const pr = Promise.withResolvers<void>();\nconst bad: number = "boom";\n${fs.readFileSync(target, "utf8")}`,
  );

  // La seule erreur rapportée est l'erreur délibérée : le programme des tests est
  // bien en lib ES2024, donc `withResolvers` n'y est PAS signalé (S-4).
  const bad = runCheck(dir, "types");
  if (hostTypesAbsent(output(bad))) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.notEqual(bad.status, 0, output(bad));
  assert.ok(output(bad).includes("test/memoire/dedupe.test.ts("), output(bad));
  assert.ok(output(bad).includes("error TS2322"), output(bad));
  assert.ok(!output(bad).includes("withResolvers"), output(bad));
});

test("check/AC-7 : une API ES2024 dans un module de plugin fait échouer check.sh", (t) => {
  const dir = copyRepo();
  for (const rel of ["omp-mem0-req/store.ts", "omp-mem0-memory/dedupe.ts"]) {
    const target = path.join(dir, rel);
    fs.writeFileSync(target, `export const pr = Promise.withResolvers<void>();\n${fs.readFileSync(target, "utf8")}`);
  }

  // Les deux plugins sont nommés : la frontière ES2023 est portée par le niveau de
  // lib du programme des sources, pas par un scan de motif (S-4).
  const bad = runCheck(dir, "types");
  if (hostTypesAbsent(output(bad))) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.notEqual(bad.status, 0, output(bad));
  assert.ok(output(bad).includes("omp-mem0-req/store.ts("), output(bad));
  assert.ok(output(bad).includes("omp-mem0-memory/dedupe.ts("), output(bad));
  assert.ok(output(bad).includes("error TS2550"), output(bad));
});

/** Dossier de doublures : chaque binaire y est un script bash, jamais le vrai. */
function stubBin(prefix: string): { bin: string; log: string } {
  const bin = path.join(tmpdir(prefix), "bin");
  fs.mkdirSync(bin);
  const log = path.join(path.dirname(bin), "journal.txt");
  return { bin, log };
}

function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

// AC-1 exige un vrai toolchain : la doublure de la section `── App Swift` (AC-5)
// ne prouve pas que le paquet compile. Le test est donc joué sur le VRAI swift,
// et sauté dans une copie jetable ou hors macOS.
//
// Seule la compilation DEBUG est jouée ici : la release est déjà prouvée par la
// section `── App Swift` elle-même (scripts/swift-app.sh lance
// `swift test -c release`, qui compile le paquet entier en release), donc par
// `check.sh` sur le poste et par le job CI macos-app-swift. La recompiler ici
// coûtait ≈ 40 s par passage pour une preuve déjà acquise.
test("socle-app-swift/AC-1 : le paquet omp-console compile en debug (la release est prouvée par la section « App Swift » et le job CI macos-app-swift)", (t) => {
  // L'AC-1 est écrit POUR macOS : la coque SwiftUI/Combine ne compile pas
  // ailleurs. La garde est la PLATEFORME, pas la présence de `swift` — les
  // runners ubuntu-latest embarquent un toolchain Swift, et s'y fier faisait
  // rougir la CI (« no such module 'Combine' »).
  if (process.platform !== "darwin") {
    t.skip("macOS seul — la coque SwiftUI ne compile pas ailleurs");
    return;
  }
  if (process.env.MEM0_OMP_SKIP_SWIFT_APP === "1") {
    t.skip("copie jetable — la compilation réelle est vérifiée à la racine");
    return;
  }
  if (spawnSync("swift", ["--version"], { encoding: "utf8" }).status !== 0) {
    t.skip("swift absent — SwiftPM non vérifié");
    return;
  }
  const pkg = path.join(ROOT, "omp-console");
  // Scratch PERSISTANT et DÉDIÉ (`.build-node`, ignoré par git, jamais recopié :
  // préfixe `.build`) : une relance ne recompile que ce qui a changé. Il n'est
  // partagé avec aucun autre outil — `.build-tests` reçoit les `swift test` du
  // README, et un `swift build` préalable dans le dossier d'un `swift test` le
  // corrompt (« plugin for module 'TestingMacros' not found », swift-app.sh).
  const scratch = path.join(pkg, ".build-node");
  const r = spawnSync("swift", ["build", "--scratch-path", scratch], {
    cwd: pkg,
    encoding: "utf8",
    timeout: 600_000,
  });
  assert.equal(r.status, 0, `swift build : ${output(r)}`);
});

test("socle-app-swift/AC-6 : hors macOS la section « App Swift » dit « non exécuté » sans ✓ ni appel à swift", () => {
  const { bin, log } = stubBin("app-swift-linux-");
  stub(bin, "uname", "printf 'Linux\\n'");
  // La doublure journalise : le journal doit rester VIDE (le script sort avant
  // tout appel à swift), c'est ce qui prouve qu'aucune compilation n'a eu lieu.
  stub(bin, "swift", `printf '%s\\n' "$*" >> '${log}'`);

  const run = runCheck(copyRepo(), "app-swift", {
    PATH: `${bin}:${process.env.PATH}`,
    MEM0_OMP_SKIP_SWIFT_APP: "",
  });
  const out = output(run);
  assert.equal(run.status, 0, out);
  assert.ok(out.includes("non exécuté"), out);
  assert.ok(!out.includes("✓ App Swift"), out);
  assert.ok(!fs.existsSync(log), `swift ne doit jamais être appelé : ${fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""}`);
});

test("socle-app-swift/AC-5 : sur macOS la section compile, teste et assemble le bundle .app", () => {
  const { bin, log } = stubBin("app-swift-darwin-");

  stub(bin, "uname", "printf 'Darwin\\n'");
  // La doublure swift journalise ses arguments : elle fabrique le binaire factice
  // dans le dossier de build du test, et répond à `--show-bin-path` (interrogé par
  // le script sur un dossier jetable) par le suffixe rendu par SwiftPM. Avec
  // `-emit-const-values`, elle écrit aussi les valeurs constantes que lit
  // l'extraction App Intents (bundle-mac-sans-metadonnees-app-intents, S-2).
  stub(
    bin,
    "swift",
    `printf '%s\\n' "$*" >> '${log}'
scratch=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--scratch-path" ]; then scratch="$a"; fi
  prev="$a"
done
${SWIFT_CONST_VALUES_SNIPPET}
case "$*" in
  *--show-bin-path*)
    printf '%s\\n' "$scratch/out/Products/Release"
    ;;
  test*)
    mkdir -p "$scratch/out/Products/Release"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$scratch/out/Products/Release/OMPConsole"
    chmod +x "$scratch/out/Products/Release/OMPConsole"
    ;;
esac`,
  );
  stub(bin, "codesign", "exit 0");
  // Le binaire factice n'est pas un Mach-O : la doublure `otool` rend la commande
  // LC_BUILD_VERSION qu'un vrai binaire porte (vérification de la version minimale
  // du bundle assemblé, omp-console-redesign S-2).
  stub(bin, "otool", "printf '      cmd LC_BUILD_VERSION\\n  cmdsize 32\\n platform 1\\n    minos 26.0\\n      sdk 26.5\\n'");
  // Le bundle embarque le service mémoire mem0-rs (omp-console-sans-podman S-1) :
  // la doublure cargo pose un exécutable là où le vrai l'écrit, la doublure lipo
  // le déclare arm64 — aucune compilation Rust réelle dans une copie jetable.
  stub(
    bin,
    "cargo",
    `target="\${CARGO_TARGET_DIR:-mem0-stack/mem0-rs/target}"
mkdir -p "$target/release"
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$target/release/mem0-rs"
chmod +x "$target/release/mem0-rs"`,
  );
  stub(bin, "lipo", "printf 'arm64\\n'");
  // L'outillage Xcode (processeur de métadonnées App Intents, version, SDK) :
  // doublé, jamais le vrai, pour que la section tourne aussi hors macOS.
  writeXcodeDoubles(bin);

  const copy = copyRepo();
  const run = runCheck(copy, "app-swift", {
    PATH: `${bin}:${process.env.PATH}`,
    MEM0_OMP_SKIP_SWIFT_APP: "",
  });
  const out = output(run);
  assert.equal(run.status, 0, out);
  assert.ok(out.includes("✓ App Swift"), out);

  const bundle = path.join(copy, "omp-console", "build", "OMP Console.app");
  const plist = path.join(bundle, "Contents", "Info.plist");
  const binary = path.join(bundle, "Contents", "MacOS", "OMPConsole");
  assert.ok(fs.existsSync(plist), out);
  assert.ok(executable(binary), out);
  assert.ok(fs.existsSync(path.join(bundle, "Contents", "Resources")), out);
  assert.ok(fs.readFileSync(plist, "utf8").includes("com.omp.console"), out);

  // Le journal prouve l'ordre : `swift test -c release` d'abord (une compilation
  // release préalable dans le même dossier corromprait la résolution des macros
  // de test), puis la lecture du dossier de sortie.
  const logged = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.match(logged[0] ?? "", /^test -c release\b/, logged.join(" | "));
  assert.ok(logged.some((line) => line.includes("--show-bin-path")), logged.join(" | "));
});

test("socle-app-swift/AC-7 : le README de la coque documente les quatre gestes et le README racine y renvoie", () => {
  // L'invariant criteria/AC-13 exige qu'un slug de feature vive dans UN SEUL
  // fichier de test : ce test vit donc ici, avec les autres `socle-app-swift`.
  const shell = fs.readFileSync(path.join(ROOT, "omp-console", "README.md"), "utf8");

  // Les quatre gestes exigés par B-4 : builder, tester, assembler, ouvrir.
  assert.ok(shell.includes("swift build"), "omp-console/README.md : « swift build » absent");
  assert.ok(shell.includes("swift test"), "omp-console/README.md : « swift test » absent");
  assert.ok(shell.includes("scripts/swift-app.sh"), "omp-console/README.md : le script d'assemblage absent");
  assert.ok(shell.includes("open "), "omp-console/README.md : la commande d'ouverture absente");
  assert.ok(
    shell.includes("omp-console/build/OMP Console.app"),
    "omp-console/README.md : le chemin du bundle produit est absent",
  );

  // Le README racine cite la coque dans son arborescence et renvoie à son document.
  const rootReadme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const tree = rootReadme.split("\n```").find((block) => block.includes("racine = marketplace OMP"));
  assert.ok(tree !== undefined, "arborescence absente du README");
  assert.ok(tree.includes("omp-console/"), "README : omp-console/ absent de l'arborescence");
  assert.ok(rootReadme.includes("omp-console/README.md"), "README : aucun renvoi vers omp-console/README.md");
});

// ── bundle-mac-sans-metadonnees-app-intents : contrôle post-assemblage ──────
//
// Ces tests exécutent le VRAI scripts/swift-app.sh dans une copie jetable réduite
// à ce qu'il lit (le script, omp-console/Bundle, omp-console/Sources/OMPConsole),
// avec des doublures pour chaque outil externe, outillage Xcode compris
// (test/support/swift-app-doubles.ts). Aucun outil Apple réel n'est requis : ils
// tournent aussi sous ubuntu (doublure `uname`). Le PATH ne garde que les dossiers
// système, pour qu'aucun swift, cargo ou xcrun installé ne masque une doublure.

const META_ACTIONS_REL = path.join("Contents", "Resources", "Metadata.appintents", "extract.actionsdata");
const META_OK =
  "  ✓ métadonnées App Intents embarquées (Contents/Resources/Metadata.appintents : OpenConsoleIntent, « Ouvre ${applicationName} »)";

type AssemblageAppIntents = {
  status: number | null;
  stderr: string;
  sortie: string;
  /** Lignes du journal commun aux doublures, remis à zéro avant chaque lancement. */
  lignes: string[];
};

/** Copie réduite + doublures + PATH restreint, comme omp-console-sans-podman/AC-1. */
function montageAppIntents(): {
  copie: string;
  bundle: string;
  lancer: (args: string[], env?: Record<string, string>) => AssemblageAppIntents;
  planterAncienBundle: () => void;
} {
  const copie = tmpdir("app-intents-copie-");
  fs.mkdirSync(path.join(copie, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "swift-app.sh"), path.join(copie, "scripts", "swift-app.sh"));
  fs.cpSync(path.join(ROOT, "omp-console", "Bundle"), path.join(copie, "omp-console", "Bundle"), { recursive: true });
  fs.cpSync(path.join(ROOT, "omp-console", "Sources", "OMPConsole"), path.join(copie, "omp-console", "Sources", "OMPConsole"), {
    recursive: true,
  });

  const { bin, log } = stubBin("app-intents-outils-");
  stub(bin, "uname", "printf 'Darwin\\n'");
  // swift : journalise son argv, écrit les valeurs constantes quand l'argv porte
  // `-emit-const-values`, et pose un binaire OMPConsole là où le vrai l'écrit.
  stub(
    bin,
    "swift",
    `printf 'swift %s\\n' "$*" >> '${log}'
scratch=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--scratch-path" ]; then scratch="$a"; fi
  prev="$a"
done
${SWIFT_CONST_VALUES_SNIPPET}
case "$*" in
  *--show-bin-path*)
    printf '%s\\n' "$scratch/out/Products/Release"
    ;;
  test*|build*)
    mkdir -p "$scratch/out/Products/Release"
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "$scratch/out/Products/Release/OMPConsole"
    chmod +x "$scratch/out/Products/Release/OMPConsole"
    ;;
esac`,
  );
  stub(
    bin,
    "cargo",
    `target="\${CARGO_TARGET_DIR:-mem0-stack/mem0-rs/target}"
mkdir -p "$target/release"
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$target/release/mem0-rs"
chmod +x "$target/release/mem0-rs"`,
  );
  stub(bin, "lipo", "printf 'arm64\\n'");
  stub(bin, "otool", "printf '      cmd LC_BUILD_VERSION\\n  cmdsize 32\\n platform 1\\n    minos 26.0\\n      sdk 26.5\\n'");
  // codesign : journalise son argv et dit si, AU MOMENT de l'appel, la cible porte
  // déjà Metadata.appintents (preuve de la recopie avant la signature).
  stub(
    bin,
    "codesign",
    `cible="\${@: -1}"
meta=non
[ -f "$cible/${META_ACTIONS_REL}" ] && meta=oui
printf 'codesign %s meta=%s\\n' "$*" "$meta" >> '${log}'`,
  );
  writeXcodeDoubles(bin);

  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const cle of ["CARGO_TARGET_DIR", "FAUX_XCODE", "FAUX_APPINTENTS", "DEVELOPER_DIR"]) delete base[cle];
  const bundle = path.join(copie, "omp-console", "build", "OMP Console.app");

  const lancer = (args: string[], env: Record<string, string> = {}): AssemblageAppIntents => {
    fs.rmSync(log, { force: true });
    const r = spawnSync("bash", ["scripts/swift-app.sh", ...args], {
      cwd: copie,
      encoding: "utf8",
      env: { ...base, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, ...env },
      timeout: 120_000,
    });
    const lignes = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    return { status: r.status, stderr: r.stderr ?? "", sortie: output(r), lignes };
  };

  const planterAncienBundle = () => {
    fs.mkdirSync(path.join(bundle, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), "<plist/>\n");
  };

  return { copie, bundle, lancer, planterAncienBundle };
}

/** Les lignes `codesign` du journal dont la cible (dernier argument) est le bundle lui-même. */
const signaturesDuBundle = (lignes: string[], bundle: string): string[] =>
  lignes.filter((l) => l.startsWith("codesign ") && l.replace(/ meta=(oui|non)$/, "").endsWith(` ${bundle}`));

test("bundle-mac-sans-metadonnees-app-intents/AC-4 : des métadonnées absentes, privées de l'intent sonde ou de son App Shortcut, ou une extraction en échec font sortir l'assemblage en 1 avec la cause nommée, sans bundle", () => {
  const { bundle, lancer, planterAncienBundle } = montageAppIntents();
  const scenarios: { mode: string; attendus: string[] }[] = [
    {
      mode: "absent",
      attendus: [
        "✗ Metadata.appintents absent du bundle : Contents/Resources/Metadata.appintents/extract.actionsdata manque (l'extraction App Intents n'a rien produit)",
      ],
    },
    {
      mode: "sans-sonde",
      attendus: ["✗ intent sonde absent de Metadata.appintents : OpenConsoleIntent introuvable dans extract.actionsdata"],
    },
    {
      mode: "sans-raccourci",
      attendus: [
        "✗ App Shortcut de l'intent sonde absent de Metadata.appintents : phrase « Ouvre ${applicationName} » introuvable dans extract.actionsdata",
      ],
    },
    {
      mode: "echec",
      attendus: [
        "✗ extraction des métadonnées App Intents échouée (appintentsmetadataprocessor, code 255)",
        "Sources/OMPConsole/Intents/OpenConsoleIntent.swift:20: error: Every App Shortcut utterance should contain '${applicationName}'",
      ],
    },
  ];

  for (const { mode, attendus } of scenarios) {
    // Un bundle d'un assemblage antérieur ne doit pas survivre à l'échec.
    planterAncienBundle();
    const r = lancer([], { FAUX_APPINTENTS: mode });
    assert.equal(r.status, 1, `[${mode}] ${r.sortie}`);
    for (const attendu of attendus) assert.ok(r.stderr.includes(attendu), `[${mode}] message absent : ${attendu}\n${r.sortie}`);
    assert.ok(!r.sortie.includes(META_OK), `[${mode}] ✓ des métadonnées affiché malgré l'échec\n${r.sortie}`);
    assert.ok(!fs.existsSync(bundle), `[${mode}] un bundle a survécu à l'échec : ${bundle}`);
    assert.deepEqual(signaturesDuBundle(r.lignes, bundle), [], `[${mode}] le bundle a été signé malgré l'échec`);
  }
});

test("bundle-mac-sans-metadonnees-app-intents/AC-5 : sans processeur de métadonnées App Intents, l'assemblage complet comme --no-tests échoue en 1 avant toute compilation et retire le bundle", () => {
  const { bundle, lancer, planterAncienBundle } = montageAppIntents();
  const e1 =
    "✗ outillage Xcode introuvable : appintentsmetadataprocessor (xcrun --find appintentsmetadataprocessor) — installe Xcode puis sélectionne-le (sudo xcode-select -s /Applications/Xcode.app/Contents/Developer) ou pose DEVELOPER_DIR";

  for (const args of [[], ["--no-tests"]]) {
    const voie = args.length === 0 ? "complet" : "--no-tests";
    planterAncienBundle();
    const r = lancer(args, { FAUX_XCODE: "absent" });
    assert.equal(r.status, 1, `[${voie}] ${r.sortie}`);
    assert.ok(r.stderr.includes(e1), `[${voie}] message E-1 absent\n${r.sortie}`);
    assert.ok(!fs.existsSync(bundle), `[${voie}] l'ancien bundle a survécu : ${bundle}`);
    const compilations = r.lignes.filter((l) => l.startsWith("swift test") || l.startsWith("swift build"));
    assert.deepEqual(compilations, [], `[${voie}] swift a été lancé malgré l'outillage Xcode absent`);
  }
});

test("bundle-mac-sans-metadonnees-app-intents/AC-6 : dans l'état livré, complet comme --no-tests, Metadata.appintents est recopié dans Contents/Resources avant la signature du bundle", () => {
  const { copie, bundle, lancer } = montageAppIntents();

  for (const [args, scratch] of [
    [[], ".build-app"],
    [["--no-tests"], ".build-run"],
  ] as const) {
    const voie = args.length === 0 ? "complet" : "--no-tests";
    const r = lancer([...args]);
    assert.equal(r.status, 0, `[${voie}] ${r.sortie}`);
    assert.ok(r.sortie.includes(META_OK), `[${voie}] ligne ✓ des métadonnées absente\n${r.sortie}`);

    const actions = path.join(bundle, META_ACTIONS_REL);
    assert.ok(fs.existsSync(actions), `[${voie}] ${actions} absent`);
    assert.equal(fs.readFileSync(actions, "utf8"), SONDE_ACTIONSDATA, `[${voie}] extract.actionsdata n'est pas la copie exacte du processeur`);

    assert.ok(
      r.lignes.includes(`codesign --force --sign - ${bundle} meta=oui`),
      `[${voie}] le bundle n'est pas signé APRÈS la recopie : ${r.lignes.join(" | ")}`,
    );
    const binaire = `--binary-file ${path.join(copie, "omp-console", scratch, "out", "Products", "Release", "OMPConsole")}`;
    assert.ok(
      r.lignes.some((l) => l.startsWith("aimp ") && l.includes("--module-name OMPConsole") && l.includes(binaire)),
      `[${voie}] processeur non lancé sur le binaire ${scratch} : ${r.lignes.join(" | ")}`,
    );
  }
});

const VOCAL_OK =
  "  ✓ intents vocaux embarqués (MacPendingIntent « Qu’est-ce qui m’attend dans ${applicationName} », MacAnswerIntent « Réponds dans ${applicationName} »)";

test("siri-mac-questions-en-attente/AC-1 : le bundle livré déclare MacPendingIntent et MacAnswerIntent avec leurs phrases françaises en ${applicationName}, sinon l'assemblage sort en 1 sans bundle", () => {
  const { bundle, lancer, planterAncienBundle } = montageAppIntents();

  for (const args of [[], ["--no-tests"]]) {
    const voie = args.length === 0 ? "complet" : "--no-tests";
    const r = lancer(args);
    assert.equal(r.status, 0, `[${voie}] ${r.sortie}`);
    assert.ok(r.sortie.includes(META_OK), `[${voie}] ligne ✓ des métadonnées absente\n${r.sortie}`);
    assert.ok(r.sortie.includes(VOCAL_OK), `[${voie}] ligne ✓ des intents vocaux absente\n${r.sortie}`);
    const actions = fs.readFileSync(path.join(bundle, META_ACTIONS_REL), "utf8");
    for (const marqueur of [
      '"identifier":"MacPendingIntent"',
      '"identifier":"MacAnswerIntent"',
      '"key":"Qu’est-ce qui m’attend dans ${applicationName}"',
      '"key":"Réponds dans ${applicationName}"',
    ]) {
      assert.ok(actions.includes(marqueur), `[${voie}] ${marqueur} absent du bundle : ${actions}`);
    }
  }

  const scenarios: { mode: string; attendu: string }[] = [
    {
      mode: "sans-vocal",
      attendu: "✗ intent vocal absent de Metadata.appintents : MacPendingIntent introuvable dans extract.actionsdata",
    },
    {
      mode: "sans-phrase-vocale",
      attendu:
        "✗ App Shortcut de l'intent vocal MacPendingIntent absent de Metadata.appintents : phrase « Qu’est-ce qui m’attend dans ${applicationName} » introuvable dans extract.actionsdata",
    },
  ];
  for (const { mode, attendu } of scenarios) {
    planterAncienBundle();
    const r = lancer([], { FAUX_APPINTENTS: mode });
    assert.equal(r.status, 1, `[${mode}] ${r.sortie}`);
    assert.ok(r.stderr.includes(attendu), `[${mode}] message absent : ${attendu}\n${r.sortie}`);
    assert.ok(!r.sortie.includes(VOCAL_OK), `[${mode}] ✓ des intents vocaux affiché malgré l'échec\n${r.sortie}`);
    assert.ok(!fs.existsSync(bundle), `[${mode}] un bundle a survécu à l'échec : ${bundle}`);
    assert.deepEqual(signaturesDuBundle(r.lignes, bundle), [], `[${mode}] le bundle a été signé malgré l'échec`);
  }
});

const PILOT_OK =
  "  ✓ intents de pilotage embarqués (MacLaunchPipelineIntent « Lancer une pipeline dans ${applicationName} », MacResumeFeatureIntent « Reprendre une pipeline dans ${applicationName} », MacStopFeatureIntent « Arrêter une pipeline dans ${applicationName} », MacValidateSpecsIntent « Valider les specs dans ${applicationName} », MacAcceptReviewIntent « Accepter la revue dans ${applicationName} »)";

test("siri-mac-pilotage-pipelines/AC-14 : le bundle livré déclare les cinq intents de pilotage avec une phrase française en ${applicationName}, sinon l'assemblage sort en 1 sans bundle", () => {
  const { bundle, lancer, planterAncienBundle } = montageAppIntents();

  for (const args of [[], ["--no-tests"]]) {
    const voie = args.length === 0 ? "complet" : "--no-tests";
    const r = lancer(args);
    assert.equal(r.status, 0, `[${voie}] ${r.sortie}`);
    assert.ok(r.sortie.includes(PILOT_OK), `[${voie}] ligne ✓ des intents de pilotage absente\n${r.sortie}`);
    const actions = fs.readFileSync(path.join(bundle, META_ACTIONS_REL), "utf8");
    for (const marqueur of [
      '"identifier":"MacLaunchPipelineIntent"',
      '"identifier":"MacResumeFeatureIntent"',
      '"identifier":"MacStopFeatureIntent"',
      '"identifier":"MacValidateSpecsIntent"',
      '"identifier":"MacAcceptReviewIntent"',
      '"key":"Lancer une pipeline dans ${applicationName}"',
      '"key":"Reprendre une pipeline dans ${applicationName}"',
      '"key":"Arrêter une pipeline dans ${applicationName}"',
      '"key":"Valider les specs dans ${applicationName}"',
      '"key":"Accepter la revue dans ${applicationName}"',
    ]) {
      assert.ok(actions.includes(marqueur), `[${voie}] ${marqueur} absent du bundle : ${actions}`);
    }
  }

  const scenarios: { mode: string; attendu: string }[] = [
    {
      mode: "sans-pilotage",
      attendu: "✗ intent de pilotage absent de Metadata.appintents : MacLaunchPipelineIntent introuvable dans extract.actionsdata",
    },
    {
      mode: "sans-phrase-pilotage",
      attendu:
        "✗ App Shortcut de l'intent de pilotage MacLaunchPipelineIntent absent de Metadata.appintents : phrase « Lancer une pipeline dans ${applicationName} » introuvable dans extract.actionsdata",
    },
  ];
  for (const { mode, attendu } of scenarios) {
    planterAncienBundle();
    const r = lancer([], { FAUX_APPINTENTS: mode });
    assert.equal(r.status, 1, `[${mode}] ${r.sortie}`);
    assert.ok(r.stderr.includes(attendu), `[${mode}] message absent : ${attendu}\n${r.sortie}`);
    assert.ok(!r.sortie.includes(PILOT_OK), `[${mode}] ✓ des intents de pilotage affiché malgré l'échec\n${r.sortie}`);
    assert.ok(!fs.existsSync(bundle), `[${mode}] un bundle a survécu à l'échec : ${bundle}`);
    assert.deepEqual(signaturesDuBundle(r.lignes, bundle), [], `[${mode}] le bundle a été signé malgré l'échec`);
  }
});
