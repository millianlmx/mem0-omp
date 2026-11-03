// Feature harness-repos : `main.ts --add-repo <url>` (derrière `harness.sh add`)
// déclare un dépôt sans éditer la configuration — clone nu, écriture éprouvée à
// blanc, commandes de test devinées — et répond par un code que le script traduit
// en geste : 3 lecture refusée, 4 écriture refusée (la clé de déploiement à poser).
// Chaque dépôt a sa clé SSH (`~/.ssh/repos/<nom>`), seule offerte au distant.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../omp-harness/config.ts";
import { Git, remoteEnv } from "../../omp-harness/git.ts";
import { execProcess, type Exec } from "../../omp-harness/proc.ts";
import { addRepo, detectTests, repoName, type KeyGen } from "../../omp-harness/repos.ts";
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

/** Un git qui note l'environnement de chaque appel, par sous-commande. */
function recordingGit(file: string): { git: Git; calls: { args: string[]; ssh: string | undefined }[] } {
  const calls: { args: string[]; ssh: string | undefined }[] = [];
  const exec: Exec = (command, args, options) => {
    calls.push({ args, ssh: options?.env?.GIT_SSH_COMMAND });
    return execProcess(command, args, options);
  };
  return { git: new Git(exec, loadConfig(file).git), calls };
}

/** Le double de ssh-keygen : écrit la paire demandée et compte ses appels. */
function fakeKeygen(): { keygen: KeyGen; made: string[][] } {
  const made: string[][] = [];
  const keygen: KeyGen = async (args) => {
    made.push(args);
    const key = args[args.indexOf("-f") + 1] as string;
    fs.writeFileSync(key, "PRIVEE\n", { mode: 0o600 });
    fs.writeFileSync(`${key}.pub`, `ssh-ed25519 AAAAFAKE ${args[args.indexOf("-C") + 1]}\n`);
  };
  return { keygen, made };
}

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
  const home = path.join(root, "home");
  const { keygen, made } = fakeKeygen();
  const { git: recorded, calls } = recordingGit(file);
  const result = await addRepo(file, loadConfig(file), recorded, remote, { keygen, home });
  assert.equal(result.code, 0, result.message);
  const key = path.join(home, ".ssh", "repos", "produit");
  assert.equal(made.length, 1);
  assert.equal(made[0]?.[made[0].indexOf("-f") + 1], key);
  assert.equal(fs.statSync(path.dirname(key)).mode & 0o777, 0o700);
  for (const verb of ["ls-remote", "clone", "push"]) {
    const call = calls.find((c) => c.args.includes(verb));
    assert.ok(call?.ssh?.includes(`-i '${key}'`), `${verb} n'offre que la clé du dépôt`);
  }
  assert.match(result.message, /produit ajouté — tests : « npm test »/);

  const config = loadConfig(file);
  assert.deepEqual(
    config.repos.map((repo) => repo.name),
    ["produit"],
    "l'exemple « mon-produit » a disparu",
  );
  const repo = config.repos[0];
  assert.equal(repo?.sshKey, key);
  assert.equal(repo?.path, path.join(root, "repos", "produit"));
  assert.equal(repo?.mainBranch, "main");
  assert.equal(repo?.tests.touched, "npm run -s test:touched -- {files}", "le package.json de main est lu");
  const written = JSON.parse(fs.readFileSync(file, "utf8")).repos[0];
  assert.equal(written.tests.pattern, "**/*.test.{ts,js}");
  assert.deepEqual(written.checks, { lint: "npm run -s lint" });
  assert.equal(git(repo?.path as string, "rev-parse", "--is-bare-repository").trim(), "true");
  assert.equal(git(remote, "branch", "--list", "omp-harness-check").trim(), "", "l'essai d'écriture est à blanc");

  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(await addRepo(file, loadConfig(file), gitOf(file), remote, { keygen, home }), {
    code: 0,
    message: "produit est déjà déclaré",
  });
  assert.equal(fs.readFileSync(file, "utf8"), before);

  // Une clé déjà là (redéclaration après suppression de l'entrée) est reprise, pas regénérée.
  fs.writeFileSync(file, `${JSON.stringify({ ...JSON.parse(before), repos: [] }, null, 2)}\n`);
  assert.equal((await addRepo(file, loadConfig(file), gitOf(file), remote, { keygen, home })).code, 0);
  assert.equal(made.length, 1);
  assert.equal(loadConfig(file).repos[0]?.sshKey, key);
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
      { encoding: "utf8", env: { ...process.env, HOME: path.join(root, "home") } },
    );

  // Le vrai ssh-keygen crée la clé du dépôt ; l'échec montre sa clé publique.
  const unreadable = run(path.join(root, "absent.git"));
  assert.equal(unreadable.status, 3, unreadable.stderr);
  assert.match(unreadable.stdout, /^✗ lecture refusée sur /);
  const pub = fs.readFileSync(path.join(root, "home", ".ssh", "repos", "absent.pub"), "utf8").trim();
  assert.ok(unreadable.stdout.includes(pub), "la clé publique du dépôt est affichée");

  // Un clone déjà là dont le distant refuse les poussées (le cas d'une clé en lecture seule).
  const clone = path.join(root, "repos", "produit");
  git(root, "clone", "-q", "--bare", remote, clone);
  git(clone, "config", "remote.origin.receivepack", "false");
  const home = path.join(root, "home");
  const readOnly = await addRepo(file, loadConfig(file), gitOf(file), remote, { keygen: fakeKeygen().keygen, home });
  assert.equal(readOnly.code, 4);
  assert.match(readOnly.message, /^écriture refusée sur /);
  assert.ok(readOnly.message.includes("ssh-ed25519 AAAAFAKE omp-harness:produit"));
  assert.equal(fs.readFileSync(file, "utf8"), before);

  assert.equal(
    (await addRepo(file, loadConfig(file), gitOf(file), remote, { name: "../x", keygen: fakeKeygen().keygen, home }))
      .code,
    1,
    "un nom qui sortirait de repos/ est refusé",
  );
});

test("harness-repos/AC-5 : la clé d'un dépôt est seule offerte, citée pour le shell ; sans clé, l'identité du service", () => {
  assert.deepEqual(remoteEnv({ sshKey: null }), {});
  const home = tmpdir("harness-repos-home-");
  const env = { HOME: home, GIT_SSH_COMMAND: "ssh -i /service/id_ed25519" };
  const plain = remoteEnv({ sshKey: "/k/a b" }, env).GIT_SSH_COMMAND ?? "";
  assert.ok(plain.startsWith("ssh -i '/k/a b' "));
  assert.ok(!plain.includes("/service/"), "la clé du service n'est pas reprise");
  assert.match(plain, /-o IdentitiesOnly=yes/);
  assert.ok(plain.includes(`UserKnownHostsFile='${path.join(home, ".ssh", "known_hosts")}'`));
  assert.ok(!plain.includes(" -F "));
  fs.mkdirSync(path.join(home, ".ssh"));
  fs.writeFileSync(path.join(home, ".ssh", "config"), "");
  assert.ok(remoteEnv({ sshKey: "/k/a" }, env).GIT_SSH_COMMAND?.includes(`-F '${path.join(home, ".ssh", "config")}'`));
});
