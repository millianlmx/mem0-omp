// Feature deploiement-continu : le serveur déployé suit les releases du harness et dit
// quel commit tourne. Le job de release avance la branche `deploy` (test/outillage/
// release.test.ts) ; ici, ce que la machine en fait : `harness.sh up --ref deploy` met
// le clone sur cette branche avant de construire, et `build-commit` nomme au build le
// commit de l'image (argument, `.git` du contexte, ou tag de la version prouvé par
// ses arbres quand Portainer a supprimé le `.git`). Les scripts tournent pour de vrai,
// sur des dépôts git jetables ; seul le moteur de conteneurs est doublé.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { GIT_ENV } from "../support/git.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const BOX = path.join(ROOT, "omp-harness", "deploy", "container");

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} : ${result.stderr}`);
  return result.stdout.trim();
}

function commitAll(cwd: string, message: string): string {
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", message], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

/** `build-commit <contexte>` : sa sortie (le commit, ou rien), son code et ses messages. */
function buildCommit(ctx: string, env: Record<string, string> = {}) {
  const result = spawnSync("sh", [path.join(BOX, "build-commit"), ctx], {
    encoding: "utf8",
    env: { ...GIT_ENV, OMP_HARNESS_COMMIT: "", OMP_HARNESS_SOURCE_REPO: "", ...env },
  });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr };
}

test("deploiement-continu/AC-1 : build-commit nomme le commit construit — l'argument, sinon le .git du contexte (référence libre, packed-refs ou tête détachée), sinon le tag de la version seulement si ses arbres sont ceux du contexte ; jamais un faux commit ni un build en échec", () => {
  // Un dépôt source : le harness (avec un exécutable, un .gitignore imbriqué et le module
  // NixOS que .dockerignore exclut), la mémoire, et un dossier hors de l'image.
  const src = tmpdir("deploiement-continu-src-");
  git(["init", "-q", "-b", "main"], src);
  fs.mkdirSync(path.join(src, "omp-harness", "deploy", "nixos"), { recursive: true });
  fs.mkdirSync(path.join(src, "omp-mem0-memory"));
  fs.mkdirSync(path.join(src, "omp-console"));
  fs.writeFileSync(
    path.join(src, "omp-harness", "package.json"),
    '{\n  "name": "omp-harness",\n  "version": "1.2.3"\n}\n',
  );
  fs.writeFileSync(path.join(src, "omp-harness", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(src, "omp-harness", ".gitignore"), "*.log\n");
  fs.writeFileSync(path.join(src, "omp-harness", "deploy", "nixos", "module.nix"), "{ }\n");
  fs.writeFileSync(path.join(src, "omp-mem0-memory", "index.ts"), "export {};\n");
  fs.writeFileSync(path.join(src, "omp-console", "App.swift"), "// app\n");
  const tagged = commitAll(src, "feat(harness): une release");
  git(["tag", "-a", "omp-harness-v1.2.3", "-m", "omp-harness 1.2.3"], src);
  const remote = path.join(tmpdir("deploiement-continu-remote-"), "origin.git");
  git(["clone", "-q", "--bare", src, remote], src);
  const repo = `file://${remote}`;

  // Le contexte de build tel que Portainer le laisse : l'arbre, sans .git, réduit par .dockerignore.
  const ctx = tmpdir("deploiement-continu-ctx-");
  fs.cpSync(path.join(src, "omp-harness"), path.join(ctx, "omp-harness"), { recursive: true });
  fs.cpSync(path.join(src, "omp-mem0-memory"), path.join(ctx, "omp-mem0-memory"), { recursive: true });
  fs.rmSync(path.join(ctx, "omp-harness", "deploy", "nixos"), { recursive: true });

  assert.deepEqual(buildCommit(ctx, { OMP_HARNESS_SOURCE_REPO: repo }).out, tagged, "le tag, prouvé par les arbres");
  const other = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(buildCommit(ctx, { OMP_HARNESS_COMMIT: other.toUpperCase(), OMP_HARNESS_SOURCE_REPO: repo }).out, other);
  const garbage = buildCommit(ctx, { OMP_HARNESS_COMMIT: "abc1234" });
  assert.deepEqual([garbage.status, garbage.out], [0, ""]);
  assert.match(garbage.err, /OMP_HARNESS_COMMIT ignoré/);
  assert.equal(buildCommit(ctx).out, "", "sans argument, sans .git ni dépôt source : inconnu");

  // Un fichier de plus que le tag (des commits non publiés sur main) : jamais le commit du tag.
  fs.appendFileSync(path.join(ctx, "omp-mem0-memory", "index.ts"), "// pas encore publié\n");
  const unpublished = buildCommit(ctx, { OMP_HARNESS_SOURCE_REPO: repo });
  assert.deepEqual([unpublished.status, unpublished.out], [0, ""]);
  assert.match(unpublished.err, /n'est pas l'arbre de omp-harness-v1\.2\.3/);
  // Une version sans tag, un dépôt injoignable : inconnu, build vert.
  const absent = buildCommit(ctx, { OMP_HARNESS_SOURCE_REPO: `file://${remote}-absent` });
  assert.deepEqual([absent.status, absent.out], [0, ""]);
  fs.writeFileSync(path.join(ctx, "omp-harness", "package.json"), '{\n  "version": "9.9.9"\n}\n');
  const untagged = buildCommit(ctx, { OMP_HARNESS_SOURCE_REPO: repo });
  assert.deepEqual([untagged.status, untagged.out], [0, ""]);
  assert.match(untagged.err, /omp-harness-v9\.9\.9 introuvable/);

  // Le .git d'un clone : référence libre, packed-refs, tête détachée — devant le tag.
  const dot = path.join(ctx, ".git");
  fs.mkdirSync(path.join(dot, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(dot, "HEAD"), "ref: refs/heads/deploy\n");
  fs.writeFileSync(path.join(dot, "refs", "heads", "deploy"), `${other}\n`);
  assert.equal(buildCommit(ctx, { OMP_HARNESS_SOURCE_REPO: repo }).out, other);
  fs.rmSync(path.join(dot, "refs", "heads", "deploy"));
  fs.writeFileSync(path.join(dot, "packed-refs"), `# pack-refs with: peeled\n${tagged} refs/heads/deploy\n`);
  assert.equal(buildCommit(ctx).out, tagged);
  fs.writeFileSync(path.join(dot, "HEAD"), `${other}\n`);
  assert.equal(buildCommit(ctx).out, other);
});

/** Un dépôt distant qui porte les scripts de la pile, sur main et sur deploy (une release de plus). */
function stackRemote() {
  const src = tmpdir("deploiement-continu-pile-");
  git(["init", "-q", "-b", "main"], src);
  fs.cpSync(BOX, path.join(src, "omp-harness", "deploy", "container"), { recursive: true });
  commitAll(src, "chore: la pile");
  git(["checkout", "-q", "-b", "deploy"], src);
  fs.writeFileSync(path.join(src, "RELEASE"), "1\n");
  const release = commitAll(src, "chore(release): omp-harness 1.0.0");
  git(["checkout", "-q", "main"], src);
  const remote = path.join(tmpdir("deploiement-continu-pile-remote-"), "origin.git");
  git(["clone", "-q", "--bare", src, remote], src);
  const clone = path.join(tmpdir("deploiement-continu-clone-"), "mem0-omp");
  git(["clone", "-q", remote, clone], src);
  return { src, remote, clone, release };
}

/** `harness.sh up …` du clone, avec un moteur doublé qui journalise son commit et ses arguments. */
function up(clone: string, args: string[]) {
  const dir = tmpdir("deploiement-continu-up-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const journal = path.join(dir, "engine.log");
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh\nprintf 'COMMIT=%s %s\\n' "\${OMP_HARNESS_COMMIT:-}" "$*" >> ${JSON.stringify(journal)}\nexit 0\n`,
    { mode: 0o755 },
  );
  const root = path.join(dir, "root");
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(path.join(root, "state", "token"), "t\n");
  const result = spawnSync(
    "bash",
    [path.join(clone, "omp-harness", "deploy", "container", "harness.sh"), "up", ...args],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...GIT_ENV,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        OMP_HARNESS_ENGINE: "docker",
        OMP_HARNESS_ROOT: root,
        OMP_HARNESS_SECRETS: path.join(dir, "secrets"),
        OMP_HARNESS_TAILSCALE: "0",
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
    },
  );
  const calls = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").trim().split("\n") : [];
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
}

test("deploiement-continu/AC-2 : `harness.sh up --ref deploy` met le clone sur la branche deploy d'origin (avance rapide) puis construit avec son commit ; une modification locale arrête tout sans rien toucher", () => {
  const { src, clone, release } = stackRemote();
  const first = up(clone, ["--ref", "deploy"]);
  assert.equal(first.status, 0, first.output);
  assert.equal(git(["rev-parse", "HEAD"], clone), release);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], clone), "deploy");
  const build = first.calls.find((call) => / compose .*--profile images build$/.test(call));
  assert.ok(build, first.calls.join("\n"));
  assert.ok(build.startsWith(`COMMIT=${release} `), `le build reçoit le commit du clone : ${build}`);

  // Une release de plus sur deploy : le prochain `up --ref deploy` y avance.
  git(["checkout", "-q", "deploy"], src);
  fs.writeFileSync(path.join(src, "RELEASE"), "2\n");
  const next = commitAll(src, "chore(release): omp-harness 1.1.0");
  git(["push", "-q", git(["remote", "get-url", "origin"], clone), "deploy"], src);
  const second = up(clone, ["--ref", "deploy"]);
  assert.equal(second.status, 0, second.output);
  assert.equal(git(["rev-parse", "HEAD"], clone), next);

  // Un fichier suivi modifié à la main : refus nommé, clone intact, rien de construit.
  fs.appendFileSync(path.join(clone, "RELEASE"), "local\n");
  const dirty = up(clone, ["--ref", "deploy"]);
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.output, /--ref : le clone .* a des modifications locales/);
  assert.equal(git(["rev-parse", "HEAD"], clone), next);
  assert.deepEqual(dirty.calls, [], "aucun appel au moteur");
  git(["checkout", "-q", "--", "RELEASE"], clone);

  // Une branche absente d'origin : refus nommé.
  const absent = up(clone, ["--ref", "nulle-part"]);
  assert.notEqual(absent.status, 0);
  assert.match(absent.output, /--ref : la branche nulle-part est introuvable sur origin/);
});
