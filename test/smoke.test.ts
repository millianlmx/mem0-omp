// Tests du harnais « plugins réels » (scripts/plugin-smoke.ts) : le harnais est
// ce qui décide qu'un plugin répond vraiment, donc il est éprouvé comme du code —
// sur une copie MUTÉE il doit rougir en nommant la panne, et la CI doit en faire
// un échec de job.
//
// Deux règles structurent ce fichier :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE temporaire du dépôt,
//     jamais dans l'arbre réel (qui doit rester publiable) ; les copies écartent
//     les fichiers de test qui se recopieraient et les gros, parce que ce qu'on
//     prouve ici c'est le verdict de check.sh, pas la suite entière ;
//  2. les copies ne tournent qu'au premier niveau (`MEM0_CHECK_DEPTH`) : lancées
//     depuis la copie d'un autre test, elles se rappelleraient elles-mêmes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Profondeur d'imbrication : 0 = `node --test test/smoke.test.ts` à la main. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");
/** Posée par la CI : un prérequis manquant est alors un ÉCHEC, jamais un skip. */
const REQUIRE_SMOKE = process.env.MEM0_OMP_REQUIRE_SMOKE === "1";

const tmpDirs: string[] = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

/** La MÊME cascade de résolution d'hôte que le harnais (et scripts/typecheck.sh). */
function hostRoot(): string | null {
  const home = process.env.HOME ?? os.homedir();
  const candidates = [
    process.env.MEM0_OMP_HOST_MODULES ?? "",
    path.join(ROOT, "node_modules"),
    path.join(process.env.BUN_INSTALL ?? path.join(home, ".bun"), "install", "global", "node_modules"),
  ].filter((dir) => dir !== "");
  return (
    candidates.find((dir) => fs.existsSync(path.join(dir, "@oh-my-pi", "pi-coding-agent", "src", "index.ts"))) ??
    null
  );
}

const HAS_BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).status === 0;
const HOST = hostRoot();

/** Sans Bun ou sans hôte, on l'annonce — sauf en CI, où l'absence est un échec. */
function prereq(t: { skip: (reason: string) => void }): boolean {
  const reason = !HAS_BUN ? "bun absent" : HOST === null ? "hôte OMP introuvable" : "";
  if (reason === "") return true;
  if (REQUIRE_SMOKE) assert.fail(`${reason} — MEM0_OMP_REQUIRE_SMOKE=1 : prérequis manquant`);
  t.skip(`${reason} — harnais « plugins réels » non vérifié`);
  return false;
}

const output = (result: { stdout?: string | null; stderr?: string | null }) =>
  `${result.stdout ?? ""}${result.stderr ?? ""}`;

function harness(cwd: string) {
  return spawnSync("bun", ["scripts/plugin-smoke.ts"], { cwd, encoding: "utf8", timeout: 300_000 });
}

function runCheck(cwd: string) {
  return spawnSync("bash", ["scripts/check.sh"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MEM0_CHECK_DEPTH: String(DEPTH + 1) },
    timeout: 900_000,
  });
}

// Ce qui n'a rien à faire dans une copie : l'historique, les dépendances, la
// racine de types jetable, le stockage vectoriel, les fichiers de test qui se
// recopieraient, et les gros (le harnais n'a pas à rejouer la suite entière).
const DROPPED_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
};
const DROPPED_TESTS: Record<string, true> = {
  "check.test.ts": true,
  "release.test.ts": true,
  "smoke.test.ts": true,
  "sessions.test.ts": true,
  "panneau.test.ts": true,
  "worktree.test.ts": true,
  "tail.test.ts": true,
  "transcript.test.ts": true,
  "conversation.test.ts": true,
  "conversation-ask.test.ts": true,
  "lot.test.ts": true,
  "lot-ask.test.ts": true,
  "pipelines.test.ts": true,
  "join.test.ts": true,
  "handlers.test.ts": true,
  "components.test.ts": true,
  "plugin-handlers.test.ts": true,
  "pipeline-state.test.ts": true,
  "fixchain.test.ts": true,
  "fixpanel.test.ts": true,
  "fixruns.test.ts": true,
  "fixview.test.ts": true,
};

function copyRepo(prefix: string): string {
  const dir = mktmp(prefix);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((segment) => DROPPED_DIRS[segment] === true)) return false;
      const parts = rel.split(path.sep);
      if (parts[0] === "test" && parts.length === 2 && DROPPED_TESTS[parts[1] ?? ""] === true) return false;
      return true;
    },
  });
  return dir;
}

/** Renomme un `registerCommand("…")` du plugin, où qu'il vive dans son dossier. */
function renameCommand(dir: string, plugin: string, from: string, to: string): void {
  const pluginDir = path.join(dir, plugin);
  const file = fs
    .readdirSync(pluginDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(pluginDir, name))
    .find((candidate) => fs.readFileSync(candidate, "utf8").includes(`registerCommand("${from}"`));
  assert.ok(file, `registerCommand("${from}") introuvable dans ${plugin}`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`registerCommand("${from}"`, `registerCommand("${to}"`));
}

type Outcome = { dir: string; harness: { code: number; out: string }; check: { code: number; out: string } };

function mutate(prefix: string, apply: (dir: string) => void): Outcome {
  const dir = copyRepo(prefix);
  apply(dir);
  const run = harness(dir);
  const check = runCheck(dir);
  return {
    dir,
    harness: { code: run.status ?? 1, out: output(run) },
    check: { code: check.status ?? 1, out: output(check) },
  };
}

// Les copies tournent ENSEMBLE : deux mutations et une copie saine, chacune avec
// son check.sh, tiennent en quelques secondes au lieu de la somme.
const OUTCOMES: Record<"commande" | "chargement" | "saine", Promise<Outcome>> | null =
  DEPTH === 0
    ? {
        commande: (async () =>
          mutate("smoke-commande-", (dir) => renameCommand(dir, "omp-mem0-memory", "mem0-status", "mem0-statut")))(),
        chargement: (async () =>
          mutate("smoke-chargement-", (dir) => {
            const file = path.join(dir, "omp-mem0-memory/extension.ts");
            fs.writeFileSync(file, `throw new Error("panne de chargement simulée");\n${fs.readFileSync(file, "utf8")}`);
          }))(),
        saine: (async () =>
          mutate("smoke-saine-", () => {
            // Aucune mutation : la copie saine sert de témoin à check.sh.
          }))(),
      }
    : null;

/** Les contextes de statut exigés par la protection de `main` (PUBLISHING.md). */
function requiredContexts(): string[] {
  const doc = fs.readFileSync(path.join(ROOT, "PUBLISHING.md"), "utf8");
  const body = /"required_status_checks":\{[^}]*"contexts":\[([^\]]*)\]/.exec(doc);
  assert.ok(body, "corps de protection de branche absent de PUBLISHING.md");
  return (body[1] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry !== "");
}

/** Les noms affichés des jobs de `check.yml` : `<id> (<os de la matrice>)`. */
function workflowContexts(): string[] {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/check.yml"), "utf8");
  const jobs = workflow.split(/^jobs:\s*$/m)[1] ?? "";
  const id = /^ {2}([A-Za-z0-9_-]+):$/m.exec(jobs);
  const matrix = /os:\s*\[([^\]]*)\]/.exec(jobs);
  assert.ok(id && matrix, `job ou matrice introuvable dans check.yml :\n${jobs}`);
  return (matrix[1] ?? "")
    .split(",")
    .map((system) => `${id[1]} (${system.trim()})`);
}

test("smoke/AC-1 : un plugin qui ne se charge pas ou ne répond pas fait échouer la CI, donc bloque le merge", async (t) => {
  if (!prereq(t)) return;
  if (OUTCOMES === null) {
    t.skip("copie imbriquée — mutations non rejouées");
    return;
  }

  // (1) Une commande déclarée mais absente du runtime.
  const renamed = await OUTCOMES.commande;
  assert.notEqual(renamed.harness.code, 0, renamed.harness.out);
  assert.match(renamed.harness.out, /✗ commandes absentes du runtime : mem0-status/, renamed.harness.out);
  assert.notEqual(renamed.check.code, 0, renamed.check.out);
  assert.ok(
    renamed.check.out.includes("✗ plugins réels — relance : bun scripts/plugin-smoke.ts"),
    renamed.check.out,
  );

  // (2) Un chargement qui échoue.
  const broken = await OUTCOMES.chargement;
  assert.notEqual(broken.harness.code, 0, broken.harness.out);
  assert.match(broken.harness.out, /✗ erreurs de chargement : .*panne de chargement simulée/, broken.harness.out);
  assert.notEqual(broken.check.code, 0, broken.check.out);
  assert.ok(
    broken.check.out.includes("✗ plugins réels — relance : bun scripts/plugin-smoke.ts"),
    broken.check.out,
  );

  // (3) Le job rouge BLOQUE le merge : `main` exige exactement les contextes de
  // statut que `check.yml` produit — un OS renommé dans la matrice débloquerait
  // le merge en silence.
  const required = requiredContexts();
  assert.deepEqual(required, workflowContexts());
  assert.ok(required.includes("check (ubuntu-latest)"), required.join(", "));
  assert.ok(required.includes("check (macos-latest)"), required.join(", "));
});

test("smoke/AC-2 : les deux plugins sont chargés et invoqués dans un vrai OMP, sans conteneur", async (t) => {
  if (!prereq(t)) return;

  const run = harness(ROOT);
  const out = output(run);
  assert.equal(run.status, 0, out);

  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, ".omp-plugin/marketplace.json"), "utf8")) as {
    plugins: Array<{ name: string; commands: string[] }>;
  };
  for (const plugin of catalog.plugins) {
    assert.ok(out.includes(`── ${plugin.name}`), `en-tête absent pour ${plugin.name} :\n${out}`);
    assert.ok(
      out.includes(`✓ chargé par OMP, 2 extension(s), aucune erreur`),
      `chargement réel non constaté pour ${plugin.name} :\n${out}`,
    );
    assert.ok(
      out.includes(`✓ ${plugin.commands.length} commande(s) du catalogue enregistrée(s)`),
      `commandes non vérifiées pour ${plugin.name} :\n${out}`,
    );
  }

  // Une commande ET un outil invoqués, avec le RÉSULTAT observé.
  assert.match(out, /✓ \/mem0-status invoqué — « [^»]*ok=true[^»]* »/, out);
  assert.match(out, /✓ \/req invoqué — « [^»]*nom de feature requis[^»]* »/, out);
  assert.match(out, /✓ mem0_search invoqué — .*\[smoke-2\] souvenir de recherche \(fixture\)/, out);
  // Le service mem0 est un STUB local : aucun conteneur, aucun credential.
  assert.match(out, /✓ le stub mem0 a été appelé \(GET \/health\) sur http:\/\/127\.0\.0\.1:\d+/, out);
  assert.ok(out.trimEnd().endsWith("Tous les plugins répondent."), out);

  // La trace arrive TELLE QUELLE dans les logs du job : check.sh recopie la
  // sortie du harnais, puis verdict. Rejoué seulement au premier niveau : c'est
  // le même chemin de code dans toute copie.
  if (DEPTH === 0) {
    const witness = await OUTCOMES?.saine;
    assert.ok(witness, "copie témoin attendue");
    assert.equal(witness.check.code, 0, witness.check.out);
    assert.ok(witness.check.out.includes("── omp-mem0-memory"), witness.check.out);
    assert.ok(witness.check.out.includes("✓ /mem0-status invoqué"), witness.check.out);
    assert.ok(witness.check.out.includes("Tous les plugins répondent."), witness.check.out);
    assert.ok(
      witness.check.out.includes("✓ les 2 plugins se chargent et répondent dans un vrai OMP"),
      witness.check.out,
    );
  }
});
