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
const NESTED_ENV = { ...process.env, MEM0_CHECK_DEPTH: String(DEPTH + 1) };

// Ce qui n'a rien à faire dans une copie : l'historique, les dépendances, la
// racine de types jetable, le stockage vectoriel local (des dizaines de Mo) et
// le fichier de test qui recopierait la copie.
const EXCLUDED_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
};
const RECURSIVE_FILE = path.join("test", "check.test.ts");

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "check-copie-"));
  dirs.push(dir);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((segment) => EXCLUDED_DIRS[segment] === true)) return false;
      return rel !== RECURSIVE_FILE;
    },
  });
  return dir;
}

const output = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

function runCheck(cwd: string) {
  return spawnSync("bash", ["scripts/check.sh"], {
    cwd,
    encoding: "utf8",
    env: NESTED_ENV,
    timeout: 600_000,
  });
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
  const diverged = copyRepo();
  editCatalogs(diverged, (cat) => {
    entryOf(cat, "omp-mem0-memory").version = "2.9.7";
  });
  const entryOut = runCheck(diverged);
  assert.notEqual(entryOut.status, 0, output(entryOut));
  assert.ok(
    output(entryOut).includes("omp-mem0-memory : version d'entrée 2.9.7 ≠ package.json 2.9.6"),
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
    assert.ok(output(real).includes("metadata.version 2.9.6 nomme une version publiée"), output(real));
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
