// Feature harness-repos : `main.ts --add-repo <url>` (derrière `harness.sh add`)
// déclare un dépôt sans éditer la configuration — clone nu, écriture éprouvée à
// blanc, commandes de test devinées — et répond par un code que le script traduit
// en geste : 3 lecture refusée, 4 écriture refusée (la clé de déploiement à poser).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../omp-harness/config.ts";
import { Git } from "../../omp-harness/git.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { addRepo, detectTests, repoName } from "../../omp-harness/repos.ts";
import { git, harnessRepo } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const MAIN = path.join(import.meta.dirname, "..", "..", "omp-harness", "main.ts");

/** Une installation vide (le gabarit du conteneur) et un distant nu avec un package.json. */
function install(): { root: string; file: string; remote: string } {
  const root = tmpdir("harness-repos-");
  const file = path.join(root, "config.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        dataDir: path.join(root, "state"),
        worktreesDir: path.join(root, "worktrees"),
        tokenFile: path.join(root, "state", "token"),
        models: { standard: [{ provider: "anthropic", model: "m" }] },
        repos: [
          { name: "mon-produit", path: path.join(root, "repos", "mon-produit"), tests: { touched: "x", full: "x" } },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const source = harnessRepo("harness-repos-src-");
  git(source, "checkout", "-q", "main");
  fs.writeFileSync(path.join(source, "package.json"), '{ "scripts": { "test:touched": "bash t.sh", "lint": "x" } }\n');
  git(source, "add", "package.json");
  git(source, "commit", "-q", "-m", "package");
  const remote = path.join(tmpdir("harness-repos-remote-"), "produit.git");
  git(source, "clone", "-q", "--bare", source, remote);
  return { root, file, remote };
}

const gitOf = (file: string) => new Git(execProcess, loadConfig(file).git);

test("harness-repos/AC-1 : les commandes de test et l'image viennent des manifestes, le nom vient de l'URL", () => {
  assert.deepEqual(detectTests(["package.json", "pnpm-lock.yaml"]), {
    touched: "pnpm test -- {files}",
    full: "pnpm test",
    pattern: "**/*.test.{ts,js}",
    checks: {},
    testImage: null,
  });
  assert.equal(detectTests(["package.json"]).full, "npm test");
  assert.equal(detectTests(["Cargo.toml"]).testImage, "docker.io/library/rust:1-bookworm");
  assert.equal(detectTests(["go.mod"]).full, "go test ./...");
  assert.equal(detectTests(["pyproject.toml"]).full, "python -m pytest");
  assert.deepEqual(detectTests(["README.md"]), {
    touched: "true {files}",
    full: "true",
    pattern: null,
    checks: {},
    testImage: null,
  });
  assert.equal(repoName("git@github.com:moi/mon-produit.git"), "mon-produit");
  assert.equal(repoName("https://gitlab.com/moi/outil/"), "outil");
});

test("harness-repos/AC-4 : un package.json avec test:touched donne la commande touched, le glob suit test/, lint et typecheck deviennent des checks", () => {
  const manifest = JSON.stringify({
    scripts: {
      test: "x",
      "test:touched": "bash scripts/test-touched.sh",
      lint: "bash scripts/lint.sh",
      typecheck: "tsc",
    },
  });
  assert.deepEqual(detectTests(["package.json", "test"], manifest), {
    touched: "npm run -s test:touched -- {files}",
    full: "npm test",
    pattern: "test/**/*.test.ts",
    checks: { lint: "npm run -s lint", typecheck: "npm run -s typecheck" },
    testImage: null,
  });
  // Sans test:touched : `<runner> test -- {files}` ; un seul check ; un manifeste illisible vaut aucun script.
  const only = detectTests(["package.json", "yarn.lock"], JSON.stringify({ scripts: { lint: "eslint ." } }));
  assert.equal(only.touched, "yarn test -- {files}");
  assert.deepEqual(only.checks, { lint: "yarn run -s lint" });
  assert.deepEqual(detectTests(["package.json"], "{ pas du json").checks, {});
  assert.equal(
    detectTests(["package.json"], JSON.stringify({ scripts: { "test:touched": 3 } })).touched,
    "npm test -- {files}",
  );
});

test("harness-repos/AC-2 : un dépôt joignable est cloné, éprouvé et déclaré à la place de l'exemple ; le redéclarer ne change rien", async () => {
  const { root, file, remote } = install();
  const result = await addRepo(file, loadConfig(file), gitOf(file), remote);
  assert.equal(result.code, 0, result.message);
  assert.match(result.message, /produit ajouté — tests : « npm test »/);

  const config = loadConfig(file);
  assert.deepEqual(
    config.repos.map((repo) => repo.name),
    ["produit"],
    "l'exemple « mon-produit » a disparu",
  );
  const repo = config.repos[0];
  assert.equal(repo?.path, path.join(root, "repos", "produit"));
  assert.equal(repo?.mainBranch, "main");
  assert.equal(repo?.tests.touched, "npm run -s test:touched -- {files}", "le package.json de main est lu");
  const written = JSON.parse(fs.readFileSync(file, "utf8")).repos[0];
  assert.equal(written.tests.pattern, "**/*.test.{ts,js}");
  assert.deepEqual(written.checks, { lint: "npm run -s lint" });
  assert.equal(git(repo?.path as string, "rev-parse", "--is-bare-repository").trim(), "true");
  assert.equal(git(remote, "branch", "--list", "omp-harness-check").trim(), "", "l'essai d'écriture est à blanc");

  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(await addRepo(file, loadConfig(file), gitOf(file), remote), {
    code: 0,
    message: "produit est déjà déclaré",
  });
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("harness-repos/AC-3 : lecture refusée → code 3, écriture refusée → code 4, et la configuration reste intacte", async () => {
  const { root, file, remote } = install();
  const before = fs.readFileSync(file, "utf8");
  const run = (url: string) =>
    spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        MAIN,
        "--config",
        file,
        "--add-repo",
        url,
      ],
      { encoding: "utf8" },
    );

  const unreadable = run(path.join(root, "absent.git"));
  assert.equal(unreadable.status, 3, unreadable.stderr);
  assert.match(unreadable.stdout, /^✗ lecture refusée sur /);

  // Un clone déjà là dont le distant refuse les poussées (le cas d'une clé en lecture seule).
  const clone = path.join(root, "repos", "produit");
  git(root, "clone", "-q", "--bare", remote, clone);
  git(clone, "config", "remote.origin.receivepack", "false");
  const readOnly = await addRepo(file, loadConfig(file), gitOf(file), remote);
  assert.equal(readOnly.code, 4);
  assert.match(readOnly.message, /^écriture refusée sur /);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  assert.equal(
    (await addRepo(file, loadConfig(file), gitOf(file), remote, "../x")).code,
    1,
    "un nom qui sortirait de repos/ est refusé",
  );
});
