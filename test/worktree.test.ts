// Tests de l'isolation par worktree : /req ouvre chaque feature dans son propre
// worktree git (branche feat/<slug>), la mémoire mem0 reste celle du DÉPÔT, et un
// worktree dont la branche est poussée et l'arbre propre est retiré au maillon
// suivant — la branche restant locale.
//
// Tout passe par un dépôt git RÉEL (créé sous le dossier temporaire) et par le
// runner injecté : les décisions de nettoyage reposent sur des sorties git
// véritables (`worktree list --porcelain`, `status --porcelain`, refs distantes),
// pas sur des simulations. « Poussée » est simulé par une ref distante locale
// (`update-ref refs/remotes/origin/…`) : aucun réseau, aucun push.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  branchFor,
  buildSweepMessage,
  contractPathFor,
  createFeatureWorktree,
  gitfileTarget,
  linkGate,
  parseWorktreeList,
  PIPELINE_GIT_SUBCOMMANDS,
  primaryRootOf,
  reapDecision,
  remoteShas,
  resolveFeatureRoot,
  sweepFeatureWorktrees,
  toSlug,
  worktreePathFor,
  worktreesBaseDir,
  type GitResult,
  type GitRunner,
} from "../omp-mem0-req/extension.ts";
import { gitfilePrimaryRoot, projectId, resolveRoot } from "../omp-mem0-memory/extension.ts";

// ---------------------------------------------------------------------------
// Dépôt git réel sous dossier temporaire
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

// Identité et config figées : le résultat ne doit pas dépendre du ~/.gitconfig du
// poste. `spawnSync` direct (jamais le Bash tool d'OMP, qui intercepte
// `git worktree add` pour cloner).
function git(args: string[], cwd: string): GitResult {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(cwd, ".gitconfig-absent"),
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const run: GitRunner = async (args, cwd) => git(args, cwd);

function mkRepo(extra: Record<string, string> = {}): string {
  const dir = mktmp("wt-repo-");
  git(["init", "-q", "-b", "main"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# dépôt de test\n");
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), content);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

const headOf = (dir: string) => git(["rev-parse", "HEAD"], dir).stdout.trim();

// ---------------------------------------------------------------------------
// AC-1 / AC-2 — isolation de /req et parallélisme
// ---------------------------------------------------------------------------

test("worktree/AC-1 : /req crée un worktree dédié et laisse le dépôt principal intact", async () => {
  const root = mkRepo();
  const base = mktmp("wt-base-");
  const originBranch = git(["branch", "--show-current"], root).stdout.trim();

  const created = await createFeatureWorktree({ run, primaryRoot: root, slug: "iso-worktree", baseDir: base });
  assert.ok(created.ok, "la création aboutit");
  assert.equal(created.branch, "feat/iso-worktree");
  assert.equal(created.path, worktreePathFor(base, root, "iso-worktree"));

  // Worktree lié standard : `.git` FICHIER, branches, répertoire
  assert.ok(fs.existsSync(created.path), "le répertoire du worktree existe");
  assert.ok(fs.statSync(path.join(created.path, ".git")).isFile(), "`.git` est un fichier (gitfile)");
  assert.match(fs.readFileSync(path.join(created.path, ".git"), "utf8"), /\.git[\\/]worktrees[\\/]/);
  assert.equal(git(["branch", "--show-current"], created.path).stdout.trim(), "feat/iso-worktree");
  assert.equal(headOf(created.path), headOf(root), "branche créée depuis HEAD");

  // Dépôt principal intact : ni fichier modifié, ni branche changée
  assert.equal(git(["status", "--porcelain"], root).stdout, "");
  assert.equal(git(["branch", "--show-current"], root).stdout.trim(), originBranch);

  // Le contrat de la feature vit dans le worktree (cwd de la session), pas ailleurs
  assert.equal(contractPathFor(created.path), path.join(created.path, ".omp", "pipeline", "contract.md"));
  assert.ok(contractPathFor(created.path).startsWith(created.path + path.sep));

  // Et la session ouverte là est reconnue comme vivant dans un worktree de feature
  assert.equal(resolveFeatureRoot(created.path).primary, root);
  assert.equal(resolveFeatureRoot(root).primary, undefined, "le dépôt principal n'est pas un worktree");
});

test("worktree/AC-2 : deux features en parallèle ne partagent ni chemin, ni branche, ni contrat", async () => {
  const root = mkRepo();
  const base = mktmp("wt-base-");

  const pathA = worktreePathFor(base, root, "alpha");
  const pathB = worktreePathFor(base, root, "beta");
  assert.notEqual(pathA, pathB, "deux features, deux chemins");
  assert.ok(!pathA.startsWith(pathB + path.sep) && !pathB.startsWith(pathA + path.sep), "aucun n'est préfixe");
  assert.notEqual(branchFor("alpha"), branchFor("beta"), "deux features, deux branches");
  assert.equal(pathA, worktreePathFor(base, root, "alpha"), "chemin stable pour un même couple base/racine");

  const a = await createFeatureWorktree({ run, primaryRoot: root, slug: "alpha", baseDir: base });
  const b = await createFeatureWorktree({ run, primaryRoot: root, slug: "beta", baseDir: base });
  assert.ok(a.ok && b.ok);

  const listed = parseWorktreeList(git(["worktree", "list", "--porcelain"], root).stdout);
  const paths = listed.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length, "entrées distinctes dans `worktree list`");
  assert.ok(paths.includes(a.path) && paths.includes(b.path), "les deux worktrees coexistent");
  assert.equal(listed.find((entry) => entry.path === a.path)?.branch, "feat/alpha");
  assert.equal(listed.find((entry) => entry.path === b.path)?.branch, "feat/beta");
  assert.notEqual(contractPathFor(a.path), contractPathFor(b.path), "deux contrats distincts");
});

test("S-1 : une branche déjà prise (locale ou distante) refuse la création, sans rien créer", async () => {
  const root = mkRepo();
  const base = mktmp("wt-base-");
  assert.equal(git(["branch", "feat/prise"], root).code, 0);

  const local = await createFeatureWorktree({ run, primaryRoot: root, slug: "prise", baseDir: base });
  assert.equal(local.ok, false);
  assert.ok(!fs.existsSync(worktreePathFor(base, root, "prise")), "rien n'est créé sur le disque");

  // Connue d'un remote seulement : refusée aussi (aucun réseau : ref locale)
  git(["update-ref", "refs/remotes/origin/feat/ailleurs", headOf(root)], root);
  const remote = await createFeatureWorktree({ run, primaryRoot: root, slug: "ailleurs", baseDir: base });
  assert.equal(remote.ok, false);
  assert.ok(!fs.existsSync(worktreePathFor(base, root, "ailleurs")));
  assert.equal(parseWorktreeList(git(["worktree", "list", "--porcelain"], root).stdout).length, 1);
});

// ---------------------------------------------------------------------------
// AC-3 — une seule mémoire mem0 par dépôt, worktrees compris
// ---------------------------------------------------------------------------

test("worktree/AC-3 : worktree et dépôt principal partagent le même scope mem0", async () => {
  const root = mkRepo({ "package.json": JSON.stringify({ name: "acme-ac3" }) });
  const base = mktmp("wt-base-");
  const wt = await createFeatureWorktree({ run, primaryRoot: root, slug: "memoire", baseDir: base });
  assert.ok(wt.ok);

  const saved = process.env.MEM0_PROJECT_ID;
  delete process.env.MEM0_PROJECT_ID;
  try {
    assert.equal(projectId(wt.path), projectId(root), "un seul scope pour le dépôt et ses worktrees");
    assert.equal(projectId(wt.path), "acme-ac3", "l'identité reste celle du manifeste du dépôt");

    // La racine résolue depuis le worktree EST le dépôt principal : c'est elle que
    // ciblent le brief, le bloc AGENTS.md et /mem0-init.
    const fromWt = resolveRoot(wt.path);
    assert.equal(fromWt.dir, root);
    assert.ok(!`${fromWt.dir}${path.sep}`.startsWith(wt.path + path.sep), "aucune écriture dans l'arbre de la feature");
    assert.equal(fromWt.isRepo, true);

    // Le gitfile du worktree est bien reconnu (sinon le brief partirait dans le worktree)
    assert.equal(gitfilePrimaryRoot(fs.readFileSync(path.join(wt.path, ".git"), "utf8")), root);
  } finally {
    if (saved === undefined) delete process.env.MEM0_PROJECT_ID;
    else process.env.MEM0_PROJECT_ID = saved;
  }
});

test("un .git de sous-module n'est pas pris pour un worktree", () => {
  assert.equal(gitfilePrimaryRoot("gitdir: /x/repo/.git/modules/sub"), null);
  assert.equal(gitfilePrimaryRoot("gitdir: /x/repo/.git/modules/sub\n"), null);
  assert.equal(gitfilePrimaryRoot("pas un gitfile\n"), null);

  // Et depuis un vrai sous-module, la racine reste celle du sous-module
  const root = mkRepo();
  const sub = mkRepo();
  const added = git(
    ["-c", "protocol.file.allow=always", "submodule", "add", sub, "sub"],
    root,
  );
  assert.equal(added.code, 0, `submodule add : ${added.stderr}`);
  git(["commit", "-q", "-m", "sub"], root);
  const subRepo = path.join(root, "sub");
  assert.ok(fs.statSync(path.join(subRepo, ".git")).isFile(), "un sous-module a lui aussi un .git fichier");
  assert.equal(resolveRoot(subRepo).dir, subRepo, "racine = sous-module, pas le dépôt englobant");
});

// ---------------------------------------------------------------------------
// AC-4 / AC-5 / AC-6 / AC-7 — balayage
// ---------------------------------------------------------------------------

test("worktree/AC-4 : un worktree poussé et propre est retiré, la branche reste", async () => {
  const root = mkRepo();
  const base = mktmp("wt-base-");
  const wt = await createFeatureWorktree({ run, primaryRoot: root, slug: "poussee", baseDir: base });
  assert.ok(wt.ok);
  assert.equal(git(["update-ref", "refs/remotes/origin/feat/poussee", headOf(wt.path)], root).code, 0);

  const result = await sweepFeatureWorktrees({ run, baseDir: base, currentCwd: root, repoRoot: root });
  assert.deepEqual(result.removed, [{ path: wt.path, branch: "feat/poussee" }]);
  assert.deepEqual(result.kept, []);
  assert.ok(!fs.existsSync(wt.path), "le répertoire du worktree est retiré");
  assert.match(git(["branch", "--list", "feat/poussee"], root).stdout, /feat\/poussee/, "la branche est conservée");
});

test("worktree/AC-5 : un worktree sale ou non poussé est conservé et le blocage est signalé", async () => {
  const root = mkRepo();
  const base = mktmp("wt-base-");
  const dirty = await createFeatureWorktree({ run, primaryRoot: root, slug: "sale", baseDir: base });
  const clean = await createFeatureWorktree({ run, primaryRoot: root, slug: "propre", baseDir: base });
  assert.ok(dirty.ok && clean.ok);
  fs.writeFileSync(path.join(dirty.path, "brouillon.txt"), "non commité\n");

  const result = await sweepFeatureWorktrees({ run, baseDir: base, currentCwd: root, repoRoot: root });
  assert.deepEqual(result.removed, [], "rien n'est retiré");
  const reasons = new Map(result.kept.map((entry) => [entry.path, entry.reason]));
  assert.equal(reasons.get(dirty.path), "modifications non commitées");
  assert.equal(reasons.get(clean.path), "branche non poussée");
  assert.ok(fs.existsSync(dirty.path) && fs.existsSync(clean.path), "les deux répertoires existent encore");

  const message = buildSweepMessage(result);
  assert.ok(message.includes(dirty.path) && message.includes(clean.path));
  assert.match(message, /\[pipeline\] worktree conservé : /);
  assert.match(message, /modifications non commitées\./);
  assert.match(message, /branche non poussée\./);
  assert.equal(buildSweepMessage({ removed: [], kept: [] }), "", "rien à signaler ⇒ aucun message");
});

test("worktree/AC-6 : seul le worktree de la feature poussée est retiré", async () => {
  const root = mkRepo();
  const base = mktmp("wt-base-");
  const done = await createFeatureWorktree({ run, primaryRoot: root, slug: "finie", baseDir: base });
  const wip = await createFeatureWorktree({ run, primaryRoot: root, slug: "encours", baseDir: base });
  assert.ok(done.ok && wip.ok);
  git(["update-ref", "refs/remotes/origin/feat/finie", headOf(done.path)], root);
  fs.writeFileSync(path.join(wip.path, "wip.txt"), "en cours\n");

  const result = await sweepFeatureWorktrees({ run, baseDir: base, currentCwd: root, repoRoot: root });
  assert.deepEqual(result.removed, [{ path: done.path, branch: "feat/finie" }]);
  assert.deepEqual(result.kept, [{ path: wip.path, reason: "modifications non commitées" }]);
  assert.ok(!fs.existsSync(done.path), "le worktree de la feature poussée est retiré");
  assert.ok(fs.existsSync(wip.path), "celui de l'autre feature est intact");

  const message = buildSweepMessage(result);
  assert.ok(message.includes(`worktree retiré : ${done.path}`));
  assert.ok(message.includes(`worktree conservé : ${wip.path}`));
});

test("worktree/AC-7 : le balayage ne pousse rien et conserve le worktree après un cycle clos", async () => {
  const root = mkRepo();
  const base = mktmp("wt-base-");
  // `.omp/` ignoré (comme au dépôt réel) : le contrat ne salit pas l'arbre
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), ".omp/\n");
  const wt = await createFeatureWorktree({ run, primaryRoot: root, slug: "cycle", baseDir: base });
  assert.ok(wt.ok);
  const contract = contractPathFor(wt.path);
  fs.mkdirSync(path.dirname(contract), { recursive: true });
  fs.writeFileSync(contract, "# Contrat\n\n## Besoins\n\n- B-1 : …\n\n## Revue\n\nSTATUT : approuvé\n");
  assert.match(fs.readFileSync(contract, "utf8"), /## Revue/);

  // Cycle clos, branche jamais poussée : le worktree reste — y compris au maillon suivant
  const result = await sweepFeatureWorktrees({ run, baseDir: base, currentCwd: root, repoRoot: root });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept, [{ path: wt.path, reason: "branche non poussée" }]);
  assert.ok(fs.existsSync(wt.path), "le worktree est toujours présent");
  assert.equal(git(["status", "--porcelain"], wt.path).stdout, "", "un contrat ignoré ne salit pas le worktree");

  const decision = reapDecision({
    path: wt.path,
    branch: "feat/cycle",
    head: headOf(wt.path),
    status: "",
    remoteRefs: "",
    baseDir: base,
    currentCwd: root,
    exists: true,
  });
  assert.deepEqual(decision, { remove: false, reason: "branche non poussée" });

  // Le vocabulaire git du BALAYAGE reste en lecture seule. Le push d'une feature
  // appartient au maillon de livraison du lot (couvert par les tests du lot), pas
  // à cette liste.
  for (const forbidden of ["push", "fetch", "pull"]) {
    assert.ok(!PIPELINE_GIT_SUBCOMMANDS.includes(forbidden), `${forbidden} hors du vocabulaire git du balayage`);
  }
});

// ---------------------------------------------------------------------------
// Unités pures : contrôles dans l'ordre, raisons exactes
// ---------------------------------------------------------------------------

test("reapDecision : l'ordre des contrôles place le nettoyage avant tout retrait", () => {
  const baseDir = "/base";
  const base = { path: "/base/repo/x", branch: "feat/x", head: "abc", status: "", remoteRefs: "origin/feat/x abc", baseDir, exists: true };
  const ok = reapDecision({ ...base, currentCwd: "/ailleurs" });
  assert.deepEqual(ok, { remove: true });

  const cases: Array<[Record<string, unknown>, string]> = [
    [{ path: "/tmp/hors-base" }, "hors du répertoire des worktrees de feature"],
    [{ baseDir: "/tmp/autre-base" }, "hors du répertoire des worktrees de feature"],
    [{ currentCwd: "/base/repo/x" }, "worktree de la session courante"],
    [{ currentCwd: "/base/repo/x/sous-dossier" }, "worktree de la session courante"],
    [{ exists: false }, "worktree introuvable sur le disque"],
    [{ branch: undefined }, "HEAD détaché"],
    [{ status: "?? brouillon.txt\n" }, "modifications non commitées"],
    [{ remoteRefs: "origin/feat/autre def" }, "branche non poussée"],
  ];
  for (const [override, reason] of cases) {
    const decision = reapDecision({ ...base, currentCwd: "/ailleurs", ...override });
    assert.deepEqual(decision, { remove: false, reason }, `attendu « ${reason} »`);
  }

  // Un fichier ignoré n'apparaît pas dans `status --porcelain` : le contrat de la
  // feature ne bloque donc jamais son propre nettoyage.
  assert.deepEqual(reapDecision({ ...base, currentCwd: "/ailleurs", status: "" }), { remove: true });
});

test("parseWorktreeList / remoteShas : formats réels de git", () => {
  const porcelain = [
    "worktree /Users/m/repo",
    "HEAD 3edfb8960f0e0f2e1b1a1c1d1e1f202122232425",
    "branch refs/heads/main",
    "",
    "worktree /Users/m/base/repo-abc1234/feat-a",
    "HEAD aaaa111122223333444455556666777788889999",
    "branch refs/heads/feat/a",
    "",
    "worktree /Users/m/base/repo-abc1234/detache",
    "HEAD bbbb111122223333444455556666777788889999",
    "detached",
    "",
  ].join("\n");

  const entries = parseWorktreeList(porcelain);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { path: "/Users/m/repo", head: "3edfb8960f0e0f2e1b1a1c1d1e1f202122232425", branch: "main" });
  assert.equal(entries[1].branch, "feat/a");
  assert.equal(entries[2].branch, undefined, "detached ⇒ pas de branche");
  assert.deepEqual(parseWorktreeList(""), []);

  const refs = "origin/main 3edfb8960f0e0f2e1b1a1c1d1e1f202122232425\norigin/feat/a aaaa111122223333444455556666777788889999\n";
  assert.deepEqual(remoteShas(refs, "feat/a"), ["aaaa111122223333444455556666777788889999"]);
  assert.deepEqual(remoteShas(refs, "feat/b"), []);
  assert.deepEqual(remoteShas("", "feat/a"), []);
  // Une branche dont le nom est un suffixe d'une autre ne compte pas
  assert.deepEqual(remoteShas("origin/feat/ab aaaa111122223333444455556666777788889999\n", "feat/b"), []);
});

test("helpers de chemin : nom, base, slug, gitfile", () => {
  assert.equal(toSlug("Isolation Worktree"), "isolation-worktree");
  assert.equal(toSlug("  V2.1_beta!!  "), "v2-1-beta");
  assert.equal(toSlug("----"), null);
  assert.equal(toSlug("   "), null);
  assert.equal(toSlug("x".repeat(60)).length, 40);
  assert.equal(toSlug(`${"y".repeat(39)}-trop`), "y".repeat(39), "la troncature ne laisse pas de tiret de queue");

  const env = (value?: string) => ({ MEM0_PIPELINE_WORKTREES_DIR: value });
  assert.equal(worktreesBaseDir(env("/tmp/wt"), "/home/m"), "/tmp/wt");
  assert.equal(worktreesBaseDir(env("~/wt"), "/home/m"), "/home/m/wt");
  assert.equal(worktreesBaseDir(env("~"), "/home/m"), "/home/m");
  assert.equal(worktreesBaseDir(env("relatif/wt"), "/home/m"), "/home/m/.omp/pipeline-worktrees");
  assert.equal(worktreesBaseDir(env(undefined), "/home/m"), "/home/m/.omp/pipeline-worktrees");

  assert.equal(gitfileTarget("gitdir: /repo/.git/worktrees/x\n"), "/repo/.git/worktrees/x");
  assert.equal(gitfileTarget("pas de gitfile"), null);
  assert.equal(primaryRootOf("/repo/.git/worktrees/x"), "/repo");
  assert.equal(primaryRootOf("/repo/.git/worktrees/x/"), null, "chemin plus profond : pas un gitfile de worktree");
  assert.equal(primaryRootOf("/repo/.git/modules/sub"), null, "sous-module : pas un worktree");
  assert.equal(primaryRootOf("relatif"), null);
});

test("linkGate : worktree, contrat hérité, ou refus explicite", async () => {
  const root = mkRepo();
  const base = mktmp("wt-base-");

  assert.equal(linkGate(root).ok, false, "dépôt principal sans contrat ⇒ refus");
  const refused = linkGate(root);
  assert.ok(!refused.ok);
  assert.match(refused.reason, /n'est pas dans le worktree d'une feature/);
  assert.match(refused.reason, /\/req depuis le dépôt principal/);

  // Contrat hérité du mode sans worktree : la feature déjà ouverte n'est pas bloquée
  fs.mkdirSync(path.join(root, ".omp", "pipeline"), { recursive: true });
  fs.writeFileSync(contractPathFor(root), "# Contrat\n");
  assert.equal(linkGate(root).ok, true);

  const wt = await createFeatureWorktree({ run, primaryRoot: root, slug: "gate", baseDir: base });
  assert.ok(wt.ok);
  assert.equal(linkGate(wt.path).ok, true, "un worktree lié suffit, sans contrat encore écrit");
});
