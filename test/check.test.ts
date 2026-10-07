// Tests de `scripts/check.sh` : le script est ce qui décide qu'un dépôt est
// publiable, donc ses contrôles doivent être éprouvés comme du code.
//
// Deux règles structurent ce fichier :
//  1. Tout ce qui doit ÉCHOUER (import de valeur, version divergente, commande
//     fantôme, extension qui ne se transpile pas) est planté dans une COPIE
//     TEMPORAIRE du dépôt — jamais dans l'arbre réel, qui doit rester publiable.
//     Le contrôle `── Tests` de `check.sh` relance toute la suite dans la copie :
//     `test/check.test.ts` y est retiré, sinon il recopierait la copie et le
//     contrôle récurserait sans fin. Les copies servent à observer les messages
//     d'échec et le code de sortie, pas à juger la suite imbriquée.
//  2. Les vérifications qui portent sur l'arbre réel (`check.sh` vert, les deux
//     extensions transpilées) ne s'exécutent qu'au premier niveau : lancées depuis
//     la suite qu'elles déclenchent, elles se rappelleraient elles-mêmes.
//     `MEM0_CHECK_DEPTH` compte ces niveaux.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CATALOGS = [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"];

/** Profondeur d'imbrication : 0 = `node --test test/check.test.ts` à la main. */
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
};

// Ce qui n'a rien à faire dans une copie : l'historique, les dépendances, la
// racine de types jetable, le stockage vectoriel local (des dizaines de Mo) et
// le fichier de test qui recopierait la copie. Les racines de build Swift
// (`swift build --scratch-path .build-<quoi>`) sont reconnues par PRÉFIXE : un
// scratch inconnu pèse des centaines de Mo et ne doit jamais être recopié.
const EXCLUDED_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
  build: true,
};
const RECURSIVE_FILE = path.join("test", "check.test.ts");

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function copyRepo(onlyTest?: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "check-copie-"));
  dirs.push(dir);
  // Une copie ÉLAGUÉE ne garde qu'un fichier de test : `check.sh` y relance la
  // suite, et les tests d'injection de type n'observent que la section `── Types`
  // (patron de test/release.test.ts : ≈ 3 s au lieu de ≈ 33 s en pleine fidélité).
  const only = onlyTest === undefined ? null : path.join("test", onlyTest);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((segment) => EXCLUDED_DIRS[segment] === true || segment.startsWith(".build"))) {
        return false;
      }
      if (rel === RECURSIVE_FILE) return false;
      if (only !== null && rel.startsWith(`test${path.sep}`) && rel !== only) return false;
      return true;
    },
  });
  return dir;
}

const output = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

function runCheck(cwd: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["scripts/check.sh"], {
    cwd,
    encoding: "utf8",
    env: { ...NESTED_ENV, ...env },
    timeout: 600_000,
  });
}

/** Un `bash scripts/mem0-http-test.sh …`, même convention d'environnement. */
function runHttpScript(args: string[], cwd: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["scripts/mem0-http-test.sh", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...NESTED_ENV, ...env },
    timeout: 600_000,
  });
}

/** Dossier temporaire suivi, retiré en fin de suite comme les copies du dépôt. */
function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  dirs.push(dir);
  return dir;
}

/** Doublure d'interpréteur du test d'API : un script bash, jamais un vrai Python. */
function stubInterpreter(body: string): string {
  const file = path.join(tmpdir("mem0-http-doublure-"), "python");
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
}

const executable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Le venv par défaut du script : `${XDG_CACHE_HOME:-$HOME/.cache}/mem0-omp/mem0-http-venv`. */
function defaultVenv(): string {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cache, "mem0-omp", "mem0-http-venv");
}

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

  const bad = runCheck(dir);
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

  // Le même import écrit en `import type` ne déclenche pas le contrôle. La copie
  // peut échouer pour une autre raison : on n'assert que l'absence du message.
  const typed = copyRepo();
  const typedTarget = path.join(typed, "omp-mem0-req/extension.ts");
  fs.writeFileSync(
    typedTarget,
    `import type { x } from "@oh-my-pi/pi-coding-agent";\n${fs.readFileSync(typedTarget, "utf8")}`,
  );
  const clean = runCheck(typed);
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
  const ghost = runCheck(dir);
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

  const missing = runCheck(orphan);
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
  const entryOut = runCheck(diverged);
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
  const metaOut = runCheck(orphanMeta);
  assert.notEqual(metaOut.status, 0, output(metaOut));
  assert.ok(output(metaOut).includes("metadata.version 9.9.9"), output(metaOut));

  // L'état publié de la branche passe : c'est l'autre moitié du critère.
  if (DEPTH === 0) {
    const real = runCheck(ROOT);
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
  const broken = runCheck(dir);
  assert.notEqual(broken.status, 0, output(broken));
  assert.ok(
    output(broken).includes("omp-mem0-req/extension.ts ne se transpile pas"),
    output(broken),
  );

  if (DEPTH === 0) {
    const real = runCheck(ROOT);
    assert.ok(output(real).includes("les 2 extensions se transpilent"), output(real));
  }
});

test("check/AC-17 : la CI exerce check.sh sur macOS et Ubuntu", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/check.yml"), "utf8");

  const matrix = /matrix:\s*\n\s*os:\s*\[([^\]]*)\]/.exec(workflow);
  assert.ok(matrix, `matrice \`os\` absente du workflow :\n${workflow}`);
  const systems = matrix[1].split(",").map((s) => s.trim());
  assert.ok(systems.includes("macos-latest"), `macos-latest absent de la matrice : ${systems.join(", ")}`);
  assert.ok(systems.includes("ubuntu-latest"), `ubuntu-latest absent de la matrice : ${systems.join(", ")}`);

  assert.match(workflow, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  assert.ok(workflow.includes("./scripts/check.sh"), workflow);
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
// Le test d'API mem0-http (S-1..S-4). Le dossier de feature `mem0-http-hors-ci`
// tient ses quatre critères ici, et nulle part ailleurs.
// ---------------------------------------------------------------------------

test("mem0-http-hors-ci/AC-2 : les exigences testées viennent du Dockerfile, sans seconde liste", () => {
  // La plage attendue est LUE dans le Dockerfile, jamais écrite ici : une montée
  // de version ne doit pas transformer ce cas en régression de chiffre.
  const dockerfile = fs.readFileSync(path.join(ROOT, "mem0-stack/mem0-http/Dockerfile"), "utf8");
  const declared = /"mem0ai[^"]*"/.exec(dockerfile);
  assert.ok(declared, `plage mem0ai absente du Dockerfile :\n${dockerfile}`);
  const range = declared[0].slice(1, -1);

  const base = runHttpScript(["--requirements"], ROOT);
  assert.equal(base.status, 0, output(base));
  const lines = output(base).trim().split("\n");
  assert.equal(lines[0], range, output(base));
  for (const dep of ["fastapi", "httpx", "uvicorn[standard]"]) {
    assert.ok(lines.includes(dep), `exigence ${dep} absente de --requirements : ${lines.join(" ")}`);
  }

  // Muter la déclaration du Dockerfile dans une copie change ce que le script
  // teste — extraction et plan de préparation — sans toucher une autre liste.
  const dir = copyRepo();
  const dockerfileInCopy = path.join(dir, "mem0-stack", "mem0-http", "Dockerfile");
  const source = fs.readFileSync(dockerfileInCopy, "utf8");
  const mutated = source.replace(/"mem0ai[^"]*"/, '"mem0ai>=2.0.20,<2.0.21"');
  assert.notEqual(mutated, source, "plage mem0ai introuvable dans la copie du Dockerfile");
  fs.writeFileSync(dockerfileInCopy, mutated);

  const venv = path.join(tmpdir("mem0-http-venv-"), "venv");
  const reqs = runHttpScript(["--requirements"], dir);
  assert.equal(reqs.status, 0, output(reqs));
  assert.ok(output(reqs).includes("mem0ai>=2.0.20,<2.0.21"), output(reqs));
  assert.ok(!output(reqs).includes(range), output(reqs));

  const dry = runHttpScript(["--prepare", "--dry-run"], dir, { MEM0_HTTP_VENV: venv });
  assert.equal(dry.status, 0, output(dry));
  assert.ok(output(dry).includes("mem0ai>=2.0.20,<2.0.21"), output(dry));
  assert.ok(!output(dry).includes(range), output(dry));
});

test("mem0-http-hors-ci/AC-4 : la section annonce « non exécuté » sans ✓ trompeur et propage l'échec", () => {
  // (a) Aucun interpréteur : le venv est un chemin INEXISTANT. Un `MEM0_HTTP_VENV`
  // vide retomberait sur le venv par défaut, c'est-à-dire celui que l'étape
  // `--prepare` de la CI vient de construire — la garde ne serait pas exercée.
  const absent = path.join(tmpdir("mem0-http-absent-"), "venv");
  const noEnv = { MEM0_HTTP_VENV: absent, MEM0_HTTP_PYTHON: "", MEM0_OMP_REQUIRE_HTTP_API: "" };

  const idle = runCheck(copyRepo(), noEnv);
  assert.equal(idle.status, 0, output(idle));
  assert.ok(output(idle).includes("non exécuté"), output(idle));
  assert.ok(!output(idle).includes("✓ API mem0-http"), output(idle));

  // (b) La même absence, durcie par la variable de la CI : c'est un échec.
  const strict = runCheck(copyRepo(), { ...noEnv, MEM0_OMP_REQUIRE_HTTP_API: "1" });
  assert.notEqual(strict.status, 0, output(strict));
  assert.ok(output(strict).includes("✗"), output(strict));

  // (c) Doublure silencieuse : la section est verte, et le test a bien été lancé
  // depuis mem0-stack/mem0-http, avec `test_api.py` pour seul argument.
  const log = path.join(tmpdir("mem0-http-journal-"), "journal.txt");
  const silent = stubInterpreter(`printf 'cwd=%s\\nargv=%s\\n' "$PWD" "$*" > '${log}'\nexit 0\n`);
  const copy = copyRepo();
  const ok = runCheck(copy, { MEM0_HTTP_PYTHON: silent });
  assert.equal(ok.status, 0, output(ok));
  assert.ok(output(ok).includes("✓ API mem0-http : test_api.py conforme"), output(ok));
  const logged = fs.readFileSync(log, "utf8");
  const parsed = /^cwd=(.*)\nargv=(.*)\n$/.exec(logged);
  assert.ok(parsed, `journal d'invocation inattendu : ${logged}`);
  assert.equal(
    fs.realpathSync(parsed[1]),
    fs.realpathSync(path.join(copy, "mem0-stack", "mem0-http")),
    logged,
  );
  assert.equal(parsed[2], "test_api.py", logged);

  // (d) Doublure qui échoue : sa sortie est recopiée telle quelle (c'est elle qui
  // nomme la route fautive) et check.sh rougit.
  const failing = stubInterpreter("echo 'FAIL  /memory/x1  [200]'\nexit 1\n");
  const bad = runCheck(copyRepo(), { MEM0_HTTP_PYTHON: failing });
  assert.notEqual(bad.status, 0, output(bad));
  assert.ok(output(bad).includes("FAIL  /memory/x1  [200]"), output(bad));
});

test("mem0-http-hors-ci/AC-3 : une rupture d'API de mem0 rend check.sh rouge en nommant la route", (t) => {
  // L'interpréteur du test : celui de l'environnement, sinon le venv par défaut.
  // Aucun des deux ⇒ on le dit et on ne prétend rien avoir vérifié.
  const override = process.env.MEM0_HTTP_PYTHON ?? "";
  const usable = (override !== "" && executable(override)) || executable(path.join(defaultVenv(), "bin", "python"));
  if (!usable) {
    t.skip("environnement du test d'API mem0-http absent — prépare-le : bash scripts/mem0-http-test.sh --prepare");
    return;
  }

  // L'arbre sain d'abord : c'est l'autre moitié du critère (le vert côté sain).
  const healthy = runCheck(copyRepo());
  assert.equal(healthy.status, 0, output(healthy));
  assert.ok(output(healthy).includes("✓ API mem0-http : test_api.py conforme"), output(healthy));

  // Puis la rupture : `delete` appelé sous un nom de mot-clé que la vraie
  // signature de mem0 refuse. StubMemory._record lie les arguments à cette
  // signature, donc l'appel échoue exactement comme il échouerait en production.
  const dir = copyRepo();
  const server = path.join(dir, "mem0-stack", "mem0-http", "http_server.py");
  const source = fs.readFileSync(server, "utf8");
  const mutated = source.replace("m.delete(memory_id=memory_id)", "m.delete(id=memory_id)");
  assert.notEqual(mutated, source, "appel m.delete(memory_id=…) introuvable dans http_server.py");
  fs.writeFileSync(server, mutated);

  const broken = runCheck(dir);
  assert.notEqual(broken.status, 0, output(broken));
  const text = output(broken);
  for (const needle of ["test_api.py", "delete_memory", "/memory/x1"]) {
    assert.ok(text.includes(needle), `${needle} absent de la sortie de check.sh :\n${text}`);
  }
});

test("mem0-http-hors-ci/AC-1 : la CI prépare l'environnement du test d'API avant de lancer check.sh", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/check.yml"), "utf8");

  for (const needle of [
    "bash scripts/mem0-http-test.sh --python-version",
    "${{ steps.image_python.outputs.version }}",
    "actions/setup-python@v7",
    "bash scripts/mem0-http-test.sh --prepare",
    'MEM0_OMP_REQUIRE_HTTP_API: "1"',
  ]) {
    assert.ok(workflow.includes(needle), `${needle} absent du workflow :\n${workflow}`);
  }

  // La préparation précède le lancement de check.sh : c'est ce qui rend
  // l'exécution réelle structurelle au lieu d'être déclarative.
  const prepare = workflow.indexOf("bash scripts/mem0-http-test.sh --prepare");
  const check = workflow.indexOf("./scripts/check.sh");
  assert.ok(prepare !== -1 && check !== -1 && prepare < check, workflow);
});

// ---------------------------------------------------------------------------
// S-1 à S-4 (AC-1, AC-2, AC-3, AC-4, AC-6, AC-7) — la couverture du type-check
// ---------------------------------------------------------------------------
//
// Chaque test plante une erreur de type VALIDE À L'EXÉCUTION (`const q: number =
// "boom"`) dans une copie JETABLE : `--experimental-strip-types` efface les
// annotations, donc seule la section `── Types` de check.sh rougit (cf. `##
// Documentation`, « Node.js 26.7.0 »). La copie est ÉLAGUÉE à un seul fichier de
// test — ces contrôles n'observent que le type-check.

/** Sans les types de l'hôte, `typecheck.sh` l'annonce et sort 0 : aucune preuve. */
const HOST_TYPES_ABSENT = "types de l'hôte absents";

const hostTypesAbsent = (out: string): boolean => out.includes(HOST_TYPES_ABSENT);

test("check/AC-1 : une erreur de type dans un module de omp-mem0-memory fait échouer check.sh en nommant le fichier", (t) => {
  const dir = copyRepo("dedupe.test.ts");
  const target = path.join(dir, "omp-mem0-memory/brief.ts");
  fs.writeFileSync(target, `const q: number = "boom";\n${fs.readFileSync(target, "utf8")}`);

  const bad = runCheck(dir);
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
  const dir = copyRepo("dedupe.test.ts");
  const target = path.join(dir, "test/dedupe.test.ts");
  fs.writeFileSync(target, `const q: number = "boom";\n${fs.readFileSync(target, "utf8")}`);

  const bad = runCheck(dir);
  if (hostTypesAbsent(output(bad))) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.notEqual(bad.status, 0, output(bad));
  assert.ok(output(bad).includes("test/dedupe.test.ts("), output(bad));
  assert.ok(output(bad).includes("error TS2322"), output(bad));
});

test("check/AC-3 : un .ts neuf des deux arbres est type-checké sans retouche de configuration", (t) => {
  const dir = copyRepo("dedupe.test.ts");
  fs.writeFileSync(path.join(dir, "omp-mem0-memory/zz-neuf.ts"), `export const q: number = "boom";\n`);
  fs.writeFileSync(path.join(dir, "test/zz-neuf.ts"), `export const q: number = "boom";\n`);

  // Les deux chemins sont exigés : le second prouve que le programme des tests
  // tourne MALGRÉ l'échec du premier (aucun court-circuit entre les deux).
  const bad = runCheck(dir);
  if (hostTypesAbsent(output(bad))) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.notEqual(bad.status, 0, output(bad));
  assert.ok(output(bad).includes("omp-mem0-memory/zz-neuf.ts("), output(bad));
  assert.ok(output(bad).includes("test/zz-neuf.ts("), output(bad));
});

test("check/AC-4 : le type-check tourne en strict (valeur possiblement nulle refusée)", (t) => {
  const dir = copyRepo("dedupe.test.ts");
  const target = path.join(dir, "omp-mem0-memory/brief.ts");
  fs.writeFileSync(
    target,
    `const s: string | null = null;\nexport const n = s.length;\n${fs.readFileSync(target, "utf8")}`,
  );

  // Sonde de `strictNullChecks` : sans `strict`, `s.length` passerait. L'autre
  // moitié d'AC-4 (« arbre non modifié, 0 erreur ») est portée par check/AC-18.
  const bad = runCheck(dir);
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
  const empty = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "host-types-vide-"));
  dirs.push(empty);
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
  const dir = copyRepo("dedupe.test.ts");
  const target = path.join(dir, "test/dedupe.test.ts");
  fs.writeFileSync(
    target,
    `export const pr = Promise.withResolvers<void>();\nconst bad: number = "boom";\n${fs.readFileSync(target, "utf8")}`,
  );

  // La seule erreur rapportée est l'erreur délibérée : le programme des tests est
  // bien en lib ES2024, donc `withResolvers` n'y est PAS signalé (S-4).
  const bad = runCheck(dir);
  if (hostTypesAbsent(output(bad))) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.notEqual(bad.status, 0, output(bad));
  assert.ok(output(bad).includes("test/dedupe.test.ts("), output(bad));
  assert.ok(output(bad).includes("error TS2322"), output(bad));
  assert.ok(!output(bad).includes("withResolvers"), output(bad));
});

test("check/AC-7 : une API ES2024 dans un module de plugin fait échouer check.sh", (t) => {
  const dir = copyRepo("dedupe.test.ts");
  for (const rel of ["omp-mem0-req/store.ts", "omp-mem0-memory/dedupe.ts"]) {
    const target = path.join(dir, rel);
    fs.writeFileSync(target, `export const pr = Promise.withResolvers<void>();\n${fs.readFileSync(target, "utf8")}`);
  }

  // Les deux plugins sont nommés : la frontière ES2023 est portée par le niveau de
  // lib du programme des sources, pas par un scan de motif (S-4).
  const bad = runCheck(dir);
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
test("socle-app-swift/AC-1 : le paquet omp-console compile en debug et en release", (t) => {
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
  // Scratch jetable : la compilation du test ne doit pas laisser derrière elle un
  // dossier `.build` partagé avec l'assemblage du bundle.
  const scratch = path.join(tmpdir("omp-console-build-"), ".build");
  for (const args of [["build"], ["build", "-c", "release"]]) {
    const r = spawnSync("swift", [...args, "--scratch-path", scratch], {
      cwd: pkg,
      encoding: "utf8",
      timeout: 600_000,
    });
    assert.equal(r.status, 0, `swift ${args.join(" ")} : ${output(r)}`);
  }
});

test("socle-app-swift/AC-6 : hors macOS la section « App Swift » dit « non exécuté » sans ✓ ni appel à swift", () => {
  const { bin, log } = stubBin("app-swift-linux-");
  stub(bin, "uname", "printf 'Linux\\n'");
  // La doublure journalise : le journal doit rester VIDE (le script sort avant
  // tout appel à swift), c'est ce qui prouve qu'aucune compilation n'a eu lieu.
  stub(bin, "swift", `printf '%s\\n' "$*" >> '${log}'`);

  const run = runCheck(copyRepo(), {
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
  // le script sur un dossier jetable) par le suffixe rendu par SwiftPM.
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

  const copy = copyRepo();
  const run = runCheck(copy, {
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
