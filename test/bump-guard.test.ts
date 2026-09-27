// Tests de `scripts/no-manual-bump.sh` : la garde qui interdit à une PR de monter
// une version à la main (le bump appartient au job de release). Chaque cas tourne
// dans un dépôt JETABLE qui contient le script et les porteurs de version RÉELS du
// catalogue — le script `cd` dans la racine de SON dépôt, donc c'est bien la copie
// qui est jugée, jamais l'arbre de travail.
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
const GUARD = "scripts/no-manual-bump.sh";
const SUFFIX =
  "le bump appartient au job de release : retire ce changement de la PR (PUBLISHING.md, § Mettre à jour)";

type Catalog = {
  metadata?: { version?: string; [key: string]: unknown };
  plugins: Array<{ name: string; source?: unknown; version?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

function readJson<T>(dir: string, rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8")) as T;
}

/** Les plugins LOCAUX du catalogue : les porteurs de version du dépôt. */
const PLUGINS = readJson<Catalog>(ROOT, CATALOGS[0]).plugins
  .filter((entry) => typeof entry.source === "string" && entry.source.startsWith("./"))
  .map((entry) => ({ name: entry.name, dir: String(entry.source).slice(2) }));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const tmpDirs: string[] = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} : ${result.stderr}`);
  return result.stdout ?? "";
}

const output = (run: SpawnSyncReturns<string>) => `${run.stdout ?? ""}${run.stderr ?? ""}`;

/** Un dépôt jetable avec la garde et les porteurs de version réels du catalogue. */
function makeRepo(): string {
  const dir = mktmp("bump-guard-");
  const files = [GUARD, ...CATALOGS, ...PLUGINS.map((plugin) => `${plugin.dir}/package.json`)];
  for (const rel of files) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), target);
  }
  fs.chmodSync(path.join(dir, GUARD), 0o755);
  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "chore: base de la PR"], dir);
  return dir;
}

function runGuard(dir: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("bash", [GUARD, ...args], { cwd: dir, encoding: "utf8", env: GIT_ENV, timeout: 120_000 });
}

/** Les deux catalogues, écrits depuis la MÊME sérialisation (ils doivent rester identiques). */
function editCatalogs(dir: string, mutate: (catalog: Catalog) => void): void {
  const catalog = readJson<Catalog>(dir, CATALOGS[0]);
  mutate(catalog);
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  for (const rel of CATALOGS) fs.writeFileSync(path.join(dir, rel), serialized);
}

function commitAll(dir: string, subject: string, body?: string): string {
  git(["add", "-A"], dir);
  const message = ["commit", "-q", "-m", subject];
  if (body) message.push("-m", body);
  git(message, dir);
  return git(["rev-parse", "HEAD"], dir).trim();
}

/** Une branche de PR par-dessus `main`, puis la garde évaluée sur cette plage. */
function withPullRequest(dir: string, change: () => void, subject = "fix: quelque chose"): SpawnSyncReturns<string> {
  const base = git(["rev-parse", "HEAD"], dir).trim();
  git(["checkout", "-q", "-b", "pr"], dir);
  change();
  commitAll(dir, subject);
  return runGuard(dir, ["--base", base]);
}

test("guard/AC-3 : un bump de version dans une PR échoue en nommant le fichier et les deux valeurs", () => {
  const dir = makeRepo();
  const memory = PLUGINS[0] as { name: string; dir: string };
  const rel = `${memory.dir}/package.json`;
  const before = readJson<{ version: string }>(dir, rel).version;
  const after = `${Number(before.split(".")[0])}.${Number(before.split(".")[1])}.${Number(before.split(".")[2]) + 1}`;

  const run = withPullRequest(dir, () => {
    const pkg = readJson<Record<string, unknown>>(dir, rel);
    pkg.version = after;
    fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(pkg, null, 2)}\n`);
  });

  assert.equal(run.status, 1, output(run));
  assert.ok(
    output(run).includes(`  ✗ ${rel} : version modifiée à la main (${before} → ${after}) — ${SUFFIX}`),
    output(run),
  );
});

test("catalogue : une entrée et `metadata.version` montées à la main sont nommées", () => {
  const dir = makeRepo();
  const memory = PLUGINS[0] as { name: string; dir: string };
  const before = readJson<Catalog>(dir, CATALOGS[0]).plugins[0]?.version ?? "";
  const after = "9.9.9";

  const run = withPullRequest(dir, () => {
    editCatalogs(dir, (catalog) => {
      for (const entry of catalog.plugins) {
        if (entry.name === memory.name) entry.version = after;
      }
      catalog.metadata = { ...(catalog.metadata ?? {}), version: after };
    });
  });

  assert.equal(run.status, 1, output(run));
  for (const catalog of CATALOGS) {
    assert.ok(
      output(run).includes(`  ✗ ${catalog} : version de ${memory.name} modifiée à la main (${before} → ${after}) — ${SUFFIX}`),
      output(run),
    );
    assert.ok(
      output(run).includes(`  ✗ ${catalog} : metadata.version modifiée à la main (${before} → ${after}) — ${SUFFIX}`),
      output(run),
    );
  }
});

test("PR de release : le trailer `Release-Event:` exempte les versions écrites par le job", () => {
  const dir = makeRepo();
  const memory = PLUGINS[0] as { name: string; dir: string };
  const rel = `${memory.dir}/package.json`;
  const base = git(["rev-parse", "HEAD"], dir).trim();

  git(["checkout", "-q", "-b", "pr"], dir);
  const pkg = readJson<Record<string, unknown>>(dir, rel);
  pkg.version = "0.0.1";
  fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(pkg, null, 2)}\n`);
  // Le trailer est dans le CORPS du commit, comme celui que le job écrit.
  commitAll(dir, "chore(release): omp-mem0-memory 0.0.1", "Release-Event: 0123456789abcdef");

  const run = runGuard(dir, ["--base", base]);
  assert.equal(run.status, 0, output(run));
  assert.ok(
    output(run).includes("  ✓ PR de release (trailer Release-Event) : les versions sont bumpées par le job"),
    output(run),
  );
});

test("sans porteur de version touché : la garde passe", () => {
  const dir = makeRepo();
  const run = withPullRequest(dir, () => {
    fs.writeFileSync(path.join(dir, "README.md"), "base\n\nune ligne\n");
  });
  assert.equal(run.status, 0, output(run));
  assert.ok(output(run).includes("  ✓ aucune version montée à la main dans la PR"), output(run));

  // Une plage vide (base = tête) passe aussi : il n'y a rien à comparer.
  const empty = runGuard(dir, ["--base", git(["rev-parse", "HEAD"], dir).trim()]);
  assert.equal(empty.status, 0, output(empty));
  assert.ok(output(empty).includes("  ✓ aucune version montée à la main dans la PR"), output(empty));
});

test("base avancée : un bump déjà publié sur `main` ne fait pas échouer la PR", () => {
  const dir = makeRepo();
  const memory = PLUGINS[0] as { name: string; dir: string };
  const rel = `${memory.dir}/package.json`;
  const base = git(["rev-parse", "HEAD"], dir).trim();

  // La PR part de `base` sans toucher aux versions…
  git(["checkout", "-q", "-b", "pr"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "base\n\ndocumentation\n");
  commitAll(dir, "docs: précise l'installation");

  // …mais `main` a reçu, entre-temps, un bump légitime (celui du job de release).
  git(["checkout", "-q", "main"], dir);
  const pkg = readJson<Record<string, unknown>>(dir, rel);
  pkg.version = "7.7.7";
  fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(pkg, null, 2)}\n`);
  const mainTip = commitAll(dir, "chore(release): omp-mem0-memory 7.7.7", "Release-Event: abcdef");

  const run = runGuard(dir, ["--base", mainTip, "--head", "pr"]);
  assert.equal(run.status, 0, output(run));
  assert.ok(output(run).includes("  ✓ aucune version montée à la main dans la PR"), output(run));
  assert.notEqual(mainTip, base, "le scénario a bien avancé main");
});

test("base absente ou introuvable : sortie non nulle, diagnostic nommé", () => {
  const dir = makeRepo();
  const missing = runGuard(dir, []);
  assert.notEqual(missing.status, 0, output(missing));
  assert.ok(output(missing).includes("✗ base introuvable"), output(missing));

  const unknown = runGuard(dir, ["--base", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
  assert.notEqual(unknown.status, 0, output(unknown));
  assert.ok(
    output(unknown).includes("✗ base introuvable : deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
    output(unknown),
  );

  const bogus = runGuard(dir, ["--inconnue", "x"]);
  assert.notEqual(bogus.status, 0, output(bogus));
  assert.ok(output(bogus).includes("✗ option inconnue : --inconnue"), output(bogus));
});
