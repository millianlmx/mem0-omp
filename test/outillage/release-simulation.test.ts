// Tests de la simulation de release (S-1 → S-5) : le job de CI qui rejoue la
// release d'une PR sur une copie jetable, et le statut requis qui la porte.
//
// Trois règles structurent ce fichier :
//  1. la copie jetable du dépôt est l'arbre de la PR tel que git le voit (aucun
//     fichier ignoré du poste) et n'emporte que les fichiers de test de
//     `KEPT_TESTS` : le moteur lance `check.sh` pour de vrai sur l'arbre simulé,
//     et ce qu'on prouve ici c'est que cette copie est jugée par le VRAI gate —
//     pas qu'on rejoue toute la suite depuis un test qui rejoue la suite ;
//  2. les scénarios sont construits UNE fois, avant le premier test, et seulement
//     au premier niveau (`MEM0_CHECK_DEPTH === 0`) : lancés depuis la copie d'un
//     autre test, ils se rappelleraient eux-mêmes ;
//  3. ils se construisent EN MÊME TEMPS : chacun vit dans ses propres dossiers
//     jetables, donc leurs `check.sh` se chevauchent au lieu de s'additionner.
//
// Toutes les preuves de bout en bout tournent dans un dépôt JETABLE avec un remote
// nu LOCAL : le moteur lit les tags du remote (`git ls-remote --tags origin`),
// donc l'`origin` réel — injoignable depuis le poste — ne peut pas servir.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { bumpVersion, insertChangelog, maxVersion, utcDate, versionTag } from "../../scripts/release.ts";
import { GIT_ENV } from "../support/git.ts";
import { ROOT, childEnv, linkPinnedTypescript, tmpdir } from "../support/repo.ts";
import { spawnAsync, type Run } from "../support/spawn.ts";

const CATALOGS = [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"];
const WORKFLOW = ".github/workflows/release-simulation.yml";
const SCRIPT = "scripts/release-simulation.sh";
/** Profondeur d'imbrication : 0 = `node --test test/outillage/release-simulation.test.ts`. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

type Catalog = {
  name: string;
  metadata?: { version?: string; [key: string]: unknown };
  plugins: Array<{ name: string; source?: unknown; version?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

function readJson<T>(dir: string, rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8")) as T;
}

const CATALOG = readJson<Catalog>(ROOT, CATALOGS[0]);
/** Les plugins LOCAUX du catalogue, dans son ordre : c'est l'ordre du moteur. */
const PLUGINS = CATALOG.plugins
  .filter((entry) => typeof entry.source === "string" && String(entry.source).startsWith("./"))
  .map((entry) => ({ name: entry.name, dir: String(entry.source).slice(2) }));

const MEMORY = PLUGINS[0] as { name: string; dir: string };
const REQ = PLUGINS[1] as { name: string; dir: string };

/** La version de l'arbre, DÉRIVÉE (jamais figée) : la suite tourne aussi sur un
 * arbre déjà bumpé par un run précédent. */
function versionIn(dir: string, rel: string): string {
  return readJson<{ version: string }>(dir, rel).version;
}

const PATCH_TARGET = bumpVersion(versionIn(ROOT, `${MEMORY.dir}/package.json`), "patch");
const FIX_SUBJECT = `fix(${MEMORY.name}): le rappel ne perd plus un souvenir sans score`;

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} : ${result.stderr}`);
  return result.stdout ?? "";
}

/** git contre le remote nu : lecture de l'état RÉELLEMENT publié. */
function remoteGit(remote: string, args: string[]): string {
  return git([`--git-dir=${remote}`, ...args], path.dirname(remote));
}

/**
 * Sortie complète d'un enfant. Les enfants passent par `spawnAsync`
 * (test/support/spawn.ts) : les scénarios se construisent ensemble (règle 3).
 * Leur `env` vient toujours de `childEnv` (test/support/repo.ts) : sans
 * NODE_TEST_CONTEXT, sinon le `node --test` de la section « ── Tests » de
 * `check.sh` sortirait 0 « skipping running files » SANS exécuter un seul
 * fichier — vert sans avoir rien prouvé, et AC-1 serait invérifiable.
 */
const output = (run: Run) => `${run.stdout}${run.stderr}`;

// ---------------------------------------------------------------------------
// Le dépôt de fixture
// ---------------------------------------------------------------------------

/**
 * Les SEULS fichiers de test de l'arbre que la copie emporte, en chemins
 * `test/<domaine>/<nom>.test.ts`. La suite imbriquée tourne pour de vrai, et ce
 * qu'elle doit prouver ici tient en deux fichiers :
 *  - test/outillage/docs.test.ts, un vrai test du dépôt qui lit ce que la release
 *    écrit (les deux catalogues, le package.json de chaque plugin) et PUBLISHING.md,
 *    sans dépendre de l'arbre réel ni de la profondeur : « ✓ tests unitaires »
 *    est alors un verdict rendu sur l'arbre écrit ;
 *  - le test couplé du scénario « coupled » (test/outillage/couplage-version.test.ts),
 *    écrit par le scénario lui-même APRÈS la copie : aucun filtre ne l'écarte,
 *    et c'est lui que la simulation doit nommer en tombant.
 * Une liste BLANCHE, jamais une liste d'exclusions : avec une liste noire, chaque
 * nouveau fichier de test lourd (cargo, serveurs, `check.sh` imbriqué) ralentissait
 * la simulation en silence, et ceux qui lisent l'arbre réel la faisaient rougir.
 */
const KEPT_TESTS: Record<string, true> = { "test/outillage/docs.test.ts": true };

/**
 * L'arbre de la PR tel que git le voit : fichiers suivis et non suivis NON
 * ignorés (`git ls-files -co --exclude-standard`), moins ceux qui n'existent plus
 * sur le disque et les fichiers de test hors `KEPT_TESTS`. Un fichier ignoré du
 * poste (`.omp/pipeline/contract.md`, un `__pycache__`, `node_modules`, les
 * scratchs Swift et Rust) n'entre donc jamais dans la copie : il n'est pas dans
 * la PR, et la suite imbriquée le prendrait pour une faute de l'arbre — une copie
 * par `fs.cpSync` y faisait rougir context-optimization-architecture/AC-20 et
 * mem0-stack-bascule-rust/AC-4, donc AC-1, AC-2 et AC-4 ici.
 */
function copyRepo(dir: string): void {
  // La configuration git du poste, pas GIT_ENV : ses exclusions globales font
  // partie de ce que « ignoré » veut dire ici.
  const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files a échoué : ${listed.stderr}`);
  for (const rel of listed.stdout.split("\0")) {
    if (rel === "") continue;
    if (rel.startsWith("test/") && rel.endsWith(".test.ts") && KEPT_TESTS[rel] !== true) continue;
    const source = path.join(ROOT, rel);
    if (fs.statSync(source, { throwIfNoEntry: false })?.isFile() !== true) continue;
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  // `.typecheck/` est ignoré, donc hors de la liste : le TypeScript épinglé de
  // ROOT est relié (la garde `git status --porcelain` de la simulation l'ignore).
  linkPinnedTypescript(dir);
}

/** Le hook du remote nu : refuser tout push sur `refs/heads/main`, comme la
 * protection de branche du vrai dépôt. La simulation ne pousse JAMAIS : ce hook
 * est la preuve que l'écriture distante n'a pas eu lieu. */
function writePreReceive(remote: string): void {
  const hook = [
    "#!/usr/bin/env bash",
    "while read -r old new ref; do",
    '  if [ "$ref" = "refs/heads/main" ]; then',
    '    echo "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2',
    "    exit 1",
    "  fi",
    "done",
    "exit 0",
    "",
  ].join("\n");
  const file = path.join(remote, "hooks", "pre-receive");
  fs.writeFileSync(file, hook);
  fs.chmodSync(file, 0o755);
}

/**
 * Un faux `gh` qui JOURNALISE tout appel et échoue : la simulation ne doit jamais
 * l'atteindre (aucune PR, aucune release). Un journal non vide est donc un échec,
 * pas un détail de mise en œuvre.
 */
function writeFakeGh(bin: string): void {
  const script = [
    "#!/usr/bin/env bash",
    'printf \'%s\\n\' "$*" >> "$GH_JOURNAL"',
    'echo "gh ne doit jamais être appelé par la simulation" >&2',
    "exit 1",
    "",
  ].join("\n");
  const file = path.join(bin, "gh");
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}

type Edit = { file: string; content?: string; append?: string };
/** Les édits peuvent dépendre de l'arbre : certains lisent l'état du dépôt au
 * moment de l'étape (le sha du commit précédent, par exemple). */
type Step = { subject: string; body?: string; edits: Edit[] | ((dir: string) => Edit[]) };

type Repo = {
  dir: string;
  remote: string;
  bin: string;
  journal: string;
  /** HEAD de la fixture : c'est l'état « fusionné dans main » que le script simule. */
  head: string;
  commits: Array<{ subject: string; sha: string }>;
};

/**
 * Un dépôt jetable prêt à simuler : copie de l'arbre, remote nu local avec son
 * hook, faux `gh`, tags des versions COURANTES poussés (sans quoi le rattrapage
 * brouille le plan), puis les commits du scénario.
 */
function makeRepo(kind: string, steps: Step[], prepare?: (dir: string) => void): Repo {
  const dir = tmpdir(`release-sim-${kind}-`);
  copyRepo(dir);
  // Le scénario part de l'état « rien n'a jamais été publié » : le journal d'une
  // publication ANTÉRIEURE de l'arbre ne doit pas s'y inviter.
  fs.rmSync(path.join(dir, "CHANGELOG.md"), { force: true });
  const remote = path.join(tmpdir(`release-sim-${kind}-remote-`), "origin.git");
  const bin = tmpdir(`release-sim-${kind}-bin-`);
  const journal = path.join(tmpdir(`release-sim-${kind}-journal-`), "gh.log");
  git(["init", "-q", "--bare", remote], dir);
  writeFakeGh(bin);
  fs.writeFileSync(journal, "");

  git(["init", "-q", "-b", "main"], dir);
  prepare?.(dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "chore: base du scénario"], dir);
  for (const plugin of PLUGINS) {
    const tag = versionTag(plugin.name, versionIn(dir, `${plugin.dir}/package.json`));
    git(["tag", "-a", tag, "-m", tag], dir);
  }
  git(["remote", "add", "origin", remote], dir);
  git(["push", "-q", "origin", "main", "--tags"], dir);

  const commits: Array<{ subject: string; sha: string }> = [];
  for (const step of steps) {
    const edits = typeof step.edits === "function" ? step.edits(dir) : step.edits;
    for (const edit of edits) {
      const target = path.join(dir, edit.file);
      fs.writeFileSync(target, edit.content ?? `${fs.readFileSync(target, "utf8")}${edit.append ?? ""}`);
      git(["add", "--", edit.file], dir);
    }
    const message = ["commit", "-q", "-m", step.subject];
    if (step.body) message.push("-m", step.body);
    git(message, dir);
    commits.push({ subject: step.subject, sha: git(["rev-parse", "--short", "HEAD"], dir).trim() });
  }
  git(["push", "-q", "origin", "main"], dir);
  // Le hook n'est posé qu'APRÈS l'amorçage : la mise en place du scénario doit
  // pouvoir pousser `main`, la simulation jamais.
  writePreReceive(remote);
  return { dir, remote, bin, journal, head: git(["rev-parse", "HEAD"], dir).trim(), commits };
}

/** Les variables communes aux `check.sh` de la fixture. */
const CHECK_ENV = {
  // La copie relance `check.sh`, donc la suite : on le lui dit, pour qu'un
  // fichier de test gaté sur la profondeur ne se rejoue pas là-bas.
  MEM0_CHECK_DEPTH: String(DEPTH + 1),
  // Et la section « App Swift » y compilerait pour de vrai sans rien prouver de
  // la release simulée — la section « App iOS » de même.
  MEM0_OMP_SKIP_SWIFT_APP: "1",
  MEM0_OMP_SKIP_IOS: "1",
  // La section Rust (cargo, contrat contre mem0-rs) n'a rien à faire ici.
  MEM0_OMP_SKIP_RUST: "1",
};

/**
 * `bash scripts/release-simulation.sh` dans la fixture : copie jetable, moteur de
 * la copie, verdict rendu tel quel. C'est la commande EXACTE du job de CI.
 */
function runSimulation(repo: Repo): Promise<Run> {
  return spawnAsync("bash", [SCRIPT], {
    cwd: repo.dir,
    timeout: 900_000,
    env: childEnv({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      ...CHECK_ENV,
      GH_JOURNAL: repo.journal,
      PATH: `${repo.bin}:${process.env.PATH ?? ""}`,
    }),
  });
}

type Snapshot = {
  status: string;
  remoteRefs: string[];
  localTags: string[];
  journal: string;
  worktrees: number;
};

/** Tout ce que la simulation ne doit PAS avoir touché (S-4). */
function snapshot(repo: Repo): Snapshot {
  return {
    status: git(["status", "--porcelain"], repo.dir).trim(),
    remoteRefs: remoteGit(repo.remote, ["for-each-ref", "--format=%(refname) %(objectname)"])
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .sort(),
    localTags: git(["tag", "--list"], repo.dir).trim().split("\n").filter((tag) => tag !== "").sort(),
    journal: fs.readFileSync(repo.journal, "utf8"),
    worktrees: git(["worktree", "list", "--porcelain"], repo.dir)
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length,
  };
}

// ---------------------------------------------------------------------------
// Les scénarios
// ---------------------------------------------------------------------------

const PATCH_STEPS: Step[] = [
  { subject: FIX_SUBJECT, edits: [{ file: `${MEMORY.dir}/state.ts`, append: "\n// scénario de test\n" }] },
];

/**
 * Le test de la PR qui FIGE la version courante du plugin touché : vert sur la
 * tête de la PR (la version n'a pas encore bougé), rouge après le bump — c'est
 * exactement le couplage qu'un gate de PR doit attraper avant la fusion.
 */
function couplingTest(version: string): string {
  return [
    "// Fixture de la simulation de release : ce test FIGE en dur la version du",
    "// plugin, donc la release (qui la bumpe) le fait tomber.",
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import * as fs from "node:fs";',
    'import * as path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const ROOT = fileURLToPath(new URL("../..", import.meta.url));',
    "",
    'test("le plugin fige sa version", () => {',
    `  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, ${JSON.stringify(`${MEMORY.dir}/package.json`)}), "utf8"));`,
    `  assert.equal(pkg.version, ${JSON.stringify(version)});`,
    "});",
    "",
  ].join("\n");
}

const COUPLING_STEPS: Step[] = [
  {
    subject: FIX_SUBJECT,
    edits: [
      { file: `${MEMORY.dir}/state.ts`, append: "\n// scénario de test\n" },
      { file: "test/outillage/couplage-version.test.ts", content: couplingTest(versionIn(ROOT, `${MEMORY.dir}/package.json`)) },
    ],
  },
];

/**
 * Le commit de release tel que `scripts/release.ts` l'écrit : `package.json` du
 * plugin bumpé, les deux catalogues (`metadata.version` = la plus grande version)
 * et l'entrée de `CHANGELOG.md`. C'est l'état de la PR de release du bot, dont le
 * tag n'existe pas encore.
 */
function releaseStep(): Step {
  const target = PATCH_TARGET;
  return {
    subject: `chore(release): ${MEMORY.name} ${target}`,
    edits: (dir) => {
      const pkg = readJson<Record<string, unknown>>(dir, `${MEMORY.dir}/package.json`);
      const catalog = readJson<Catalog>(dir, CATALOGS[0]);
      for (const entry of catalog.plugins) {
        if (entry.name === MEMORY.name) entry.version = target;
      }
      catalog.metadata = {
        ...(catalog.metadata ?? {}),
        version:
          maxVersion(
            catalog.plugins.map((entry) => entry.version).filter((v): v is string => typeof v === "string"),
          ) ?? target,
      };
      const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
      const fix = git(["rev-parse", "--short", "HEAD"], dir).trim();
      const date = utcDate(git(["show", "-s", "--format=%aI", "HEAD"], dir).trim());
      const changelog = insertChangelog(null, [
        [`## ${MEMORY.name} ${target} — ${date}`, "", `- ${FIX_SUBJECT} (${fix})`].join("\n"),
      ]);
      return [
        { file: `${MEMORY.dir}/package.json`, content: `${JSON.stringify({ ...pkg, version: target }, null, 2)}\n` },
        { file: CATALOGS[0], content: serialized },
        { file: CATALOGS[1], content: serialized },
        { file: "CHANGELOG.md", content: changelog },
      ];
    },
  };
}

/** La version non semver du plugin touché, dans `package.json` ET dans l'entrée
 * de catalogue, avec `metadata.version` pointant l'AUTRE plugin : l'arbre reste
 * publiable (check.sh vert), seul le bump est impossible. */
function prepareNonSemver(dir: string): void {
  const pkg = readJson<Record<string, unknown>>(dir, `${MEMORY.dir}/package.json`);
  const reqVersion = versionIn(dir, `${REQ.dir}/package.json`);
  const aligned = readJson<Catalog>(dir, CATALOGS[0]);
  for (const entry of aligned.plugins) {
    if (entry.name === MEMORY.name) entry.version = "1.2";
  }
  aligned.metadata = { ...(aligned.metadata ?? {}), version: reqVersion };
  const serialized = `${JSON.stringify(aligned, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, `${MEMORY.dir}/package.json`), `${JSON.stringify({ ...pkg, version: "1.2" }, null, 2)}\n`);
  for (const catalog of CATALOGS) fs.writeFileSync(path.join(dir, catalog), serialized);
}

type Simulated = { repo: Repo; before: Snapshot; run: Run; after: Snapshot };

async function simulate(kind: string, steps: Step[], prepare?: (dir: string) => void): Promise<Simulated> {
  const repo = makeRepo(kind, steps, prepare);
  const before = snapshot(repo);
  const run = await runSimulation(repo);
  return { repo, before, run, after: snapshot(repo) };
}

type Coupled = Simulated & { check: Run };

/**
 * Le scénario « arbre sale » : une modification non commitée, comme celle qu'un
 * humain laisse derrière lui. Les DEUX gardes (le script avant toute copie, le
 * moteur pour un appel direct) doivent refuser sans rien écrire.
 */
function buildDirty(): Repo {
  const repo = makeRepo("dirty", PATCH_STEPS);
  const readme = path.join(repo.dir, "README.md");
  fs.writeFileSync(readme, `${fs.readFileSync(readme, "utf8")}\n<!-- modification non commitée -->\n`);
  return repo;
}

/** Le scénario couplé : `check.sh` est VERT avant la simulation (le couplage est
 * invisible), et la simulation le fait tomber en écrivant le bump. */
async function buildCoupled(): Promise<Coupled> {
  const repo = makeRepo("coupled", COUPLING_STEPS);
  // `bash scripts/check.sh` dans la fixture : le gate du dépôt, tel quel — cette
  // forme sans option classe le fichier dans `test-files.sh --scope=outillage`.
  const check = await spawnAsync("bash", ["scripts/check.sh"], {
    cwd: repo.dir,
    timeout: 900_000,
    env: childEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...CHECK_ENV }),
  });
  const before = snapshot(repo);
  const run = await runSimulation(repo);
  return { repo, check, before, run, after: snapshot(repo) };
}

type ScenarioSet = {
  green: Simulated;
  coupled: Coupled;
  released: Simulated;
  nonSemver: Simulated;
  dirty: Repo;
};

/** Les scénarios, construits ENSEMBLE (règle 3) : chaque `makeRepo` prépare sa
 * fixture, puis les `check.sh` de tous tournent en même temps. */
async function buildScenarios(): Promise<ScenarioSet> {
  const [green, coupled, released, nonSemver] = await Promise.all([
    simulate("green", PATCH_STEPS),
    buildCoupled(),
    simulate("released", [...PATCH_STEPS, releaseStep()]),
    simulate("nonsemver", PATCH_STEPS, prepareNonSemver),
  ]);
  return { green, coupled, released, nonSemver, dirty: buildDirty() };
}

// Construits une seule fois, avant le premier test : chaque test ne réclame que
// le sien, et les copies imbriquées (`MEM0_CHECK_DEPTH` ≠ 0) n'en construisent
// aucun — sinon elles se rappelleraient elles-mêmes. Un hook `before` de la
// racine, jamais un `await` de premier niveau : un test déclaré au-dessus
// tournerait pendant l'attente, et à sa fin le hook `after` de
// test/support/repo.ts supprimerait les fixtures encore en construction (mesuré
// le 2026-10-12 dans test/outillage/release.test.ts).
let SCENARIOS: ScenarioSet | null = null;
test.before(async () => {
  if (DEPTH === 0) SCENARIOS = await buildScenarios();
});

type Skipper = { skip: (reason: string) => void };

/** Le scénario du test, ou un saut annoncé quand la suite tourne dans une copie. */
function scenario<T>(value: T | undefined, t: Skipper): T | null {
  if (value === undefined) {
    t.skip("copie imbriquée — scénario de bout en bout non rejoué");
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// S-1/S-2 : le verdict de la simulation
// ---------------------------------------------------------------------------

test("release-simulation/AC-2 : une PR sans couplage de version sort verte, bump écrit et check.sh vert", (t) => {
  const built = scenario(SCENARIOS?.green, t);
  if (built === null) return;
  const { repo, run } = built;
  assert.equal(run.status, 0, output(run));

  // Le plan a bien vu le bump de la PR, sur la référence simulée (`--main HEAD`).
  assert.ok(
    output(run).includes(
      `✓ ${MEMORY.name} : patch ${versionIn(repo.dir, `${MEMORY.dir}/package.json`)} → ${PATCH_TARGET} (1 commit(s))`,
    ),
    output(run),
  );
  assert.ok(output(run).includes(`· ${REQ.name} : inchangé (aucun fichier touché)`), output(run));

  // S-2 : la copie jetable est annoncée, le moteur de la copie a ÉCRIT l'arbre de
  // release, et c'est le vrai `check.sh` qui a rendu le verdict.
  assert.ok(output(run).includes("· copie jetable : "), output(run));
  assert.ok(
    output(run).includes(
      `· écrit : ${MEMORY.dir}/package.json, ${CATALOGS[0]}, ${CATALOGS[1]}, CHANGELOG.md`,
    ),
    output(run),
  );
  assert.ok(output(run).includes("✓ release simulée : check.sh vert sur l'arbre écrit"), output(run));
});

test("release-simulation/AC-1 : une PR qui fige une version en dur fait échouer la simulation en nommant le test", (t) => {
  const built = scenario(SCENARIOS?.coupled, t);
  if (built === null) return;
  const { check, run } = built;

  // Le couplage est INVISIBLE sur la tête de la PR : c'est la release qui le fait
  // tomber, donc aucun gate antérieur ne l'aurait vu.
  assert.equal(check.status, 0, output(check));
  assert.ok(output(check).includes("Dépôt prêt à publier."), output(check));
  // Le gate du dépôt a bien exécuté la suite : sans cela, « vert » ne prouve rien.
  assert.ok(output(check).includes("✓ tests unitaires"), output(check));

  // La simulation écrit le bump, puis `check.sh` tombe sur le test couplé.
  assert.notEqual(run.status, 0, output(run));
  assert.ok(output(run).includes(`· écrit : ${MEMORY.dir}/package.json`), output(run));
  assert.ok(output(run).includes("le plugin fige sa version"), output(run));
  assert.ok(output(run).includes("not ok"), output(run));
  assert.ok(
    output(run).includes("✗ check.sh rouge sur l'arbre de release simulé — la release échouerait ici"),
    output(run),
  );
  assert.ok(!output(run).includes("✓ release simulée"), output(run));
});

test("release-simulation/AC-4 : la PR de release (arbre déjà bumpé) sort verte, sans fausse écriture", (t) => {
  const built = scenario(SCENARIOS?.released, t);
  if (built === null) return;
  const { repo, run } = built;
  assert.equal(run.status, 0, output(run));

  // Toutes les versions de l'arbre sont déjà publiées/taguées côté plan : rien à
  // écrire, mais `check.sh` est quand même le verdict.
  assert.ok(output(run).includes("· aucune écriture : l'arbre simulé est déjà l'arbre de release"), output(run));
  assert.ok(!output(run).includes("· écrit :"), output(run));
  assert.ok(output(run).includes("✓ release simulée : check.sh vert sur l'arbre écrit"), output(run));

  // La fixture porte bien la release : version bumpée dans l'arbre de la PR.
  assert.equal(versionIn(repo.dir, `${MEMORY.dir}/package.json`), PATCH_TARGET);
});

test("release-simulation/AC-5 : un échec avant check.sh sort en échec, et check.sh n'est jamais lancé", (t) => {
  const built = scenario(SCENARIOS?.nonSemver, t);
  if (built === null) return;
  const { run } = built;

  // L'arbre non semver est PUBLIABLE (versions alignées, metadata valide) : seul
  // le bump de la release est impossible, et `check.sh` n'est jamais atteint.
  assert.ok(!output(run).includes("Dépôt prêt à publier."), "check.sh ne doit pas avoir été lancé");
  assert.ok(!output(run).includes("── "), "aucune section de check.sh ne doit apparaître");
  assert.notEqual(run.status, 0, output(run));
  assert.ok(output(run).trim().endsWith("✗ version non semver : 1.2"), output(run));
  assert.ok(!output(run).includes("✓ release simulée"), output(run));
});

// ---------------------------------------------------------------------------
// S-2 : les préconditions
// ---------------------------------------------------------------------------

test("release-simulation/S-2 : un arbre sale est refusé avant toute copie et toute écriture", async (t) => {
  const repo = scenario(SCENARIOS?.dirty, t);
  if (repo === null) return;
  assert.notEqual(snapshot(repo).status, "", "la fixture doit être sale");

  // (1) Le script refuse AVANT de créer la copie jetable.
  const script = await runSimulation(repo);
  assert.equal(script.status, 1, output(script));
  assert.ok(
    output(script).includes(
      "✗ arbre de travail sale : committe ou remets tes modifications avant de simuler la release",
    ),
    output(script),
  );
  assert.ok(!output(script).includes("· copie jetable : "), output(script));
  assert.equal(snapshot(repo).worktrees, 1, "aucune copie n'a été créée");

  // (2) Le moteur refuse lui aussi l'appel direct (appel à la main) : le plan et
  // l'écriture exigent de savoir ce qui vient de la release et ce qui vient de
  // l'arbre.
  const engine = await spawnAsync(
    "node",
    [
      "--experimental-strip-types",
      "scripts/release.ts",
      "--simulate",
      "--before",
      git(["rev-parse", "HEAD^"], repo.dir).trim(),
      "--after",
      repo.head,
    ],
    {
      cwd: repo.dir,
      timeout: 900_000,
      env: childEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GH_JOURNAL: repo.journal }),
    },
  );
  assert.equal(engine.status, 1, output(engine));
  assert.ok(
    output(engine).includes(
      "✗ --simulate exige un arbre propre (git status) : simule dans une copie jetable (scripts/release-simulation.sh)",
    ),
    output(engine),
  );
  assert.equal(fs.existsSync(path.join(repo.dir, "CHANGELOG.md")), false, "aucune écriture de journal");
  assert.equal(
    versionIn(repo.dir, `${MEMORY.dir}/package.json`),
    versionIn(ROOT, `${MEMORY.dir}/package.json`),
    "aucune écriture de version",
  );
});

// ---------------------------------------------------------------------------
// S-4 : la simulation n'a aucun effet hors de sa copie
// ---------------------------------------------------------------------------

test("release-simulation/AC-3 : rien n'est écrit, poussé, tagué ni ouvert hors de la copie", (t) => {
  const green = scenario(SCENARIOS?.green, t);
  if (green === null) return;
  const coupled = scenario(SCENARIOS?.coupled, t);
  if (coupled === null) return;

  for (const built of [green, coupled]) {
    const { before, after, run } = built;
    assert.match(
      before.status + after.status,
      /^$/,
      `l'arbre de la PR doit rester propre (vert comme rouge) :\n${output(run)}`,
    );
    assert.deepEqual(after.remoteRefs, before.remoteRefs, "aucune ref distante n'a bougé (heads et tags)");
    assert.deepEqual(after.localTags, before.localTags, "aucun tag local n'a été créé");
    assert.equal(before.worktrees, 1, "un seul worktree avant la simulation");
    assert.equal(after.worktrees, 1, "la copie jetable est supprimée, même quand la simulation échoue");
    assert.equal(after.journal, "", "la simulation n'appelle jamais gh (aucune PR, aucune release)");
    assert.ok(output(run).includes("· copie jetable : "), output(run));
    assert.ok(!output(run).includes("GH006"), `la simulation ne pousse rien :\n${output(run)}`);
  }
});

// ---------------------------------------------------------------------------
// S-3/S-5 : le job et le statut requis
// ---------------------------------------------------------------------------

/** L'identifiant du premier job déclaré sous `jobs:`. */
function jobName(yaml: string): string {
  const lines = yaml.split("\n");
  const jobsAt = lines.findIndex((line) => line.trim() === "jobs:");
  assert.notEqual(jobsAt, -1, "bloc `jobs:` absent du workflow");
  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index] ?? "");
    if (match) return match[1] ?? "";
  }
  assert.fail("aucun job déclaré dans le workflow");
}

/**
 * La liste des statuts requis de `PUBLISHING.md` : la prose de § « Blocage du
 * merge » et le tableau `contexts` de la commande de protection, lus dans le
 * document — aucune valeur n'est réécrite ici.
 */
function requiredStatuses(doc: string): { prose: string; contexts: string[] } {
  const start = doc.indexOf("**Blocage du merge**");
  assert.notEqual(start, -1, "§ Blocage du merge absent de PUBLISHING.md");
  const open = doc.indexOf("```bash", start);
  assert.notEqual(open, -1, "commande de protection de branche absente de PUBLISHING.md");
  const close = doc.indexOf("```", open + 7);
  assert.notEqual(close, -1, "bloc de commande non fermé");
  const json = /--input - <<'JSON'\n([\s\S]*?)\nJSON/.exec(doc.slice(open, close));
  assert.ok(json?.[1], "JSON de la commande de protection absent");
  const parsed = JSON.parse(json[1]) as { required_status_checks?: { contexts?: string[] } };
  return { prose: doc.slice(start, open), contexts: parsed.required_status_checks?.contexts ?? [] };
}

test("release-simulation/AC-6 : le statut du job est celui que PUBLISHING.md déclare requis", () => {
  // Les assertions de forme portent sur le YAML, pas sur la prose : les
  // commentaires expliquent justement les pièges (`paths:`, jeton, smoke) et
  // nomment donc les chaînes qui ne doivent PAS apparaître dans la configuration.
  const yaml = fs
    .readFileSync(path.join(ROOT, WORKFLOW), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const job = jobName(yaml);
  const doc = fs.readFileSync(path.join(ROOT, "PUBLISHING.md"), "utf8");
  const { prose, contexts } = requiredStatuses(doc);

  // Le contexte est le nom AFFICHÉ du job : sans matrice ni `name:` de job, c'est
  // exactement son identifiant — c'est lui qui doit être dans la liste.
  assert.equal(job, "release-simulation");
  assert.doesNotMatch(yaml, /^ {4}name:/m, "le job ne doit pas porter de `name:` (il changerait le contexte)");
  assert.ok(prose.includes(job), `« ${job} » absent de la liste des statuts requis :\n${prose}`);
  assert.deepEqual(contexts, ["check (ubuntu-latest)", "check (macos-latest)", job]);

  // S-3 : le contrat du workflow, au détail près.
  assert.match(yaml, /^name: release-simulation$/m);
  assert.match(yaml, /^on:\n {2}pull_request:\n {4}branches: \[main\]\n/m);
  assert.doesNotMatch(yaml, /paths:/, "un filtre de chemins laisserait le statut « Pending »");
  assert.doesNotMatch(yaml, /merge_group/, "aucune file de fusion n'exige ce statut");
  assert.doesNotMatch(yaml, /^ {2,}[a-z-]*if:/m, "un job sauté rapporte « Success » : aucun `if:`");
  assert.doesNotMatch(yaml, /matrix/, "un job à matrice changerait le contexte du statut");
  assert.doesNotMatch(yaml, /needs:/, "le job n'attend aucun autre job");
  assert.match(yaml, /permissions:\n {2}contents: read/);
  assert.match(yaml, /cancel-in-progress: true/);
  assert.match(yaml, /timeout-minutes: 30/);
  assert.match(yaml, /uses: actions\/checkout@v4/);
  assert.match(yaml, /fetch-depth: 0/);
  assert.match(yaml, /uses: actions\/setup-node@v4/);
  assert.match(yaml, /node-version: "22"/);
  assert.match(yaml, new RegExp(`^ {8}run: bash ${SCRIPT}$`, "m"));
  // L'environnement est celui du job de release : ni secret, ni gate plus strict.
  assert.doesNotMatch(yaml, /secrets\./);
  assert.doesNotMatch(yaml, /GH_TOKEN|RELEASE_TOKEN|MEM0_OMP_REQUIRE_SMOKE|MEM0_OMP_HOST_/);
});
