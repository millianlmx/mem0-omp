// Feature omp-host-epingle : `npm run setup` prépare aussi l'hôte OMP que la CI
// installe (versions lues dans l'`env:` de check.yml), une fois par machine dans le
// cache. Le type-check et la section « Plugins réels » de check.sh le trouvent
// sans variable : un poste juge contre le même hôte que la CI, au lieu de dire
// « types de l'hôte absents » ou « hôte OMP introuvable ».
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { prerequisAbsent } from "../support/prerequis.ts";
import { ROOT, childEnv, copyRepo, tmpdir } from "../support/repo.ts";

const WORKFLOW = fs.readFileSync(path.join(ROOT, ".github", "workflows", "check.yml"), "utf8");
const HOST_VERSION = /^ {2}OMP_HOST_VERSION: "([^"]+)"$/m.exec(WORKFLOW)?.[1];
const TYPES_NODE = /^ {2}OMP_HOST_TYPES_NODE: "([^"]+)"$/m.exec(WORKFLOW)?.[1];
const HOST_DIR = `omp-host-${HOST_VERSION}-types-node-${TYPES_NODE}`;

/**
 * Un environnement sans aucun hôte connu : ni variable de la CI, ni bun ou npm
 * global (HOME et BUN_INSTALL vides), le cache désigné par `cache`.
 */
function bareEnv(cache: string): NodeJS.ProcessEnv {
  const home = tmpdir("omp-host-home-");
  const env = childEnv({ HOME: home, XDG_CACHE_HOME: cache, BUN_INSTALL: path.join(home, ".bun") });
  delete env.MEM0_OMP_HOST_TYPES;
  delete env.MEM0_OMP_HOST_MODULES;
  // npm root -g sous un préfixe vide : aucun @oh-my-pi global.
  env.npm_config_prefix = path.join(home, "npm-global");
  return env;
}

/** Le node_modules d'un vrai hôte de cette machine (CI ou cache préparé), ou null. */
function realHost(): string | null {
  for (const candidate of [process.env.MEM0_OMP_HOST_TYPES, process.env.MEM0_OMP_HOST_MODULES]) {
    if (candidate && fs.existsSync(path.join(candidate, "@oh-my-pi", "pi-coding-agent", "src", "index.ts"))) {
      return candidate;
    }
  }
  const pinned = spawnSync("bash", [path.join(ROOT, "scripts", "omp-host.sh"), "--path"], { encoding: "utf8" });
  return pinned.status === 0 ? pinned.stdout.trim() : null;
}

/** Un cache où l'hôte épinglé est « préparé » : marque posée, node_modules relié à `modules`. */
function preparedCache(modules: string): string {
  const cache = tmpdir("omp-host-cache-");
  const dir = path.join(cache, "mem0-omp", HOST_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(modules, path.join(dir, "node_modules"), "dir");
  fs.writeFileSync(path.join(dir, ".prepare-ok"), "");
  return cache;
}

function hostPath(env: NodeJS.ProcessEnv, root = ROOT) {
  return spawnSync("bash", [path.join(root, "scripts", "omp-host.sh"), "--path"], { encoding: "utf8", env });
}

test("omp-host-epingle/AC-1 : `npm run setup` prépare l'hôte, dont les versions sont celles de l'env: de check.yml", () => {
  assert.ok(HOST_VERSION && TYPES_NODE, "OMP_HOST_VERSION et OMP_HOST_TYPES_NODE déclarés dans l'env: de check.yml");
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.ok(manifest.scripts.setup?.split(" && ").includes("bash scripts/omp-host.sh --prepare"));

  // Le dossier attendu dépend des deux versions : changer celle de check.yml change l'hôte cherché.
  const fake = tmpdir("omp-host-modules-");
  fs.mkdirSync(path.join(fake, "@oh-my-pi", "pi-coding-agent", "src"), { recursive: true });
  fs.writeFileSync(path.join(fake, "@oh-my-pi", "pi-coding-agent", "src", "index.ts"), "");
  const cache = preparedCache(fake);
  const found = hostPath(bareEnv(cache));
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout.trim(), path.join(cache, "mem0-omp", HOST_DIR, "node_modules"));

  const copy = copyRepo("omp-host-version-");
  const workflow = path.join(copy, ".github", "workflows", "check.yml");
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, "utf8").replace(/^ {2}OMP_HOST_VERSION: "[^"]+"$/m, '  OMP_HOST_VERSION: "0.0.0"'),
  );
  const other = hostPath(bareEnv(cache), copy);
  assert.equal(other.status, 1, "une autre version de check.yml ne retrouve pas l'hôte préparé pour la précédente");
  assert.equal(other.stdout, "");
});

test("omp-host-epingle/AC-2 : une installation interrompue (sans marque) n'est jamais prise pour un hôte préparé", () => {
  const fake = tmpdir("omp-host-modules-");
  fs.mkdirSync(path.join(fake, "@oh-my-pi", "pi-coding-agent", "src"), { recursive: true });
  fs.writeFileSync(path.join(fake, "@oh-my-pi", "pi-coding-agent", "src", "index.ts"), "");
  const cache = preparedCache(fake);
  fs.rmSync(path.join(cache, "mem0-omp", HOST_DIR, ".prepare-ok"));
  const result = hostPath(bareEnv(cache));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("omp-host-epingle/AC-3 : sans variable de la CI, le type-check tourne contre l'hôte préparé au lieu de se dire non vérifié", (t) => {
  const host = realHost();
  if (!host) {
    prerequisAbsent(
      t,
      "hôte OMP épinglé",
      "type-check contre l'hôte préparé non éprouvé — bash scripts/omp-host.sh --prepare",
    );
    return;
  }
  const copy = copyRepo("omp-host-types-", { keepTest: () => false });
  const env = bareEnv(preparedCache(host));
  const result = spawnSync("bash", ["scripts/typecheck.sh"], { cwd: copy, encoding: "utf8", env });
  const out = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(out, /types de l'hôte absents/);
  assert.match(out, /· tsc : /);
  assert.equal(result.status, 0, out);
  assert.equal(fs.realpathSync(path.join(copy, ".typecheck", "node_modules")), fs.realpathSync(host));
});

test("omp-host-epingle/AC-4 : sans variable de la CI, la section « Plugins réels » charge les plugins dans l'hôte préparé", (t) => {
  const host = realHost();
  if (!host) {
    prerequisAbsent(t, "hôte OMP épinglé", "section Plugins réels non éprouvée — bash scripts/omp-host.sh --prepare");
    return;
  }
  if (spawnSync("bun", ["--version"]).status !== 0) {
    prerequisAbsent(t, "bun", "section Plugins réels non éprouvée");
    return;
  }
  const env = bareEnv(preparedCache(host));
  // bun reste joignable : seul son dossier d'installation globale est masqué.
  env.PATH = process.env.PATH;
  const result = spawnSync("bash", ["scripts/check.sh", "--sections=smoke"], { cwd: ROOT, encoding: "utf8", env });
  const out = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(out, /hôte OMP introuvable/);
  assert.match(out, /✓ les 2 plugins se chargent et répondent dans un vrai OMP/);
  assert.equal(result.status, 0, out);
});
