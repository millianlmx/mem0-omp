// Tests du moteur de release (scripts/release.ts) : les règles de décision, le
// rendu du changelog et du corps de release sont PURS (aucun git, aucun réseau) ;
// le bout en bout tourne dans un dépôt JETABLE avec un remote bare local et un
// faux `gh` en tête de PATH — jamais contre GitHub, jamais contre ce dépôt.
//
// Trois règles structurent ce fichier :
//  1. la copie jetable ÉCARTE les gros fichiers de test et ceux qui se
//     recopieraient (test/check.test.ts, ce fichier, test/smoke.test.ts) : le
//     moteur lance `check.sh` pour de vrai, et ce qu'on prouve ici c'est que le
//     bump laisse check.sh vert, pas qu'on rejoue 19 s de suite. Les sections
//     catalogue/versions/plugins, elles, tournent sur le RÉSULTAT bumpé ;
//  2. les trois scénarios (patch, docs, majeur) démarrent EN PARALLÈLE au
//     chargement du module, et seulement au premier niveau (`MEM0_CHECK_DEPTH`) :
//     lancés depuis la copie d'un autre test, ils se rappelleraient eux-mêmes ;
//  3. aucune version de l'arbre n'est FIGÉE : le job de release lance `check.sh`
//     APRÈS avoir écrit le bump, donc cette suite tourne aussi sur un arbre où
//     `omp-mem0-memory` vaut déjà la cible du run précédent. Les attendus sont
//     DÉRIVÉS de l'arbre (`VERSIONS`) — sinon le scénario `patch` calcule
//     `2.9.8 → 2.9.9` là où les assertions attendent `2.9.8`, `check.sh` sort 1
//     après écriture et aucune release n'est jamais publiée (mesuré le 2026-09-24).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  breakingText,
  bumpVersion,
  compareVersions,
  insertChangelog,
  levelOf,
  maxLevel,
  maxVersion,
  parseCommits,
  planRelease,
  renderReleaseBody,
  repoFromRemote,
  type Commit,
  type Planned,
  type Plugin,
} from "../scripts/release.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CATALOGS = [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"];
/** Profondeur d'imbrication : 0 = `node --test test/release.test.ts` à la main. */
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");

const tmpDirs: string[] = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

/** Environnement git des dépôts jetables : aucune config de la machine. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} : ${result.stderr}`);
  return result.stdout ?? "";
}

/** git contre le remote nu (lecture de `main` telle qu'elle y est publiée). */
function remoteGit(remote: string, args: string[]): string {
  return git([`--git-dir=${remote}`, ...args], path.dirname(remote));
}

// ---------------------------------------------------------------------------
// Règles pures
// ---------------------------------------------------------------------------

test("niveaux : `!`, footer de rupture, type, casse — et rien pour le reste", () => {
  assert.equal(levelOf("feat(a): x", ""), "minor");
  assert.equal(levelOf("FIX: x", ""), "patch", "la casse du type est tolérée (CC §15)");
  assert.equal(levelOf("fix(a)!: x", ""), "major");
  assert.equal(levelOf("chore(ci): x", ""), null);
  assert.equal(levelOf("docs: x", ""), null);
  assert.equal(levelOf("refactor: x", ""), null);
  assert.equal(levelOf("pas conventionnel du tout", ""), null);
  assert.equal(levelOf("fix: x", "corps\n\nBREAKING CHANGE: plus rien ne marche"), "major");
  assert.equal(levelOf("chore: x", "corps\n\nBREAKING-CHANGE: synonyme"), "major");
  assert.equal(
    levelOf("feat: x", "corps\n\nbreaking change: minuscules"),
    "minor",
    "un footer en minuscules n'est pas un footer de rupture (CC §12)",
  );
  assert.equal(
    levelOf("feat: x", "BREAKING CHANGE: au milieu du corps\n\ncorps"),
    "minor",
    "les footers vivent dans le dernier paragraphe (CC §8-10)",
  );
  assert.equal(breakingText("corps\n\nBREAKING CHANGE: ligne 1\nligne 2"), "ligne 1 ligne 2");
  assert.equal(breakingText("feat: x"), null);
  assert.equal(maxLevel(["patch", "minor", "patch"]), "minor");
  assert.equal(maxLevel(["patch", "major", "minor"]), "major");
});

test("semver : `0.15.0` + major ⇒ `1.0.0`, et la plus grande version du catalogue", () => {
  assert.equal(bumpVersion("0.15.0", "major"), "1.0.0");
  assert.equal(bumpVersion("2.9.7", "minor"), "2.10.0");
  assert.equal(bumpVersion("2.9.7", "patch"), "2.9.8");
  assert.equal(bumpVersion("1.0.0", "patch"), "1.0.1");
  assert.throws(() => bumpVersion("v1.2", "patch"), /non semver/);
  assert.equal(maxVersion(["2.9.8", "0.15.0"]), "2.9.8");
  assert.equal(maxVersion(["0.9.9", "0.15.0"]), "0.15.0", "comparaison numérique, pas lexicale");
  assert.equal(maxVersion([]), null);
  assert.equal(compareVersions("0.15.0", "0.9.0"), 1);
  assert.equal(compareVersions("2.9.7", "2.9.7"), 0);
  // Assemblé, jamais littéral : test/docs.test.ts cherche les fichiers qui citent
  // une URL de dépôt, et ce fichier de test ne doit pas en faire partie.
  const HOST = ["github", "com"].join(".");
  assert.equal(repoFromRemote(`git@${HOST}:millianlmx/mem0-omp.git`), "millianlmx/mem0-omp");
  assert.equal(repoFromRemote(`https://${HOST}/millianlmx/mem0-omp.git`), "millianlmx/mem0-omp");
  assert.equal(repoFromRemote(`https://${HOST}/millianlmx/mem0-omp`), "millianlmx/mem0-omp");
});

test("plan : attribution par fichiers, niveau maximum, plan vide", () => {
  const sha = (c: string) => c.repeat(40);
  // L'ordre de la plage est celui de `git log` : du plus récent au plus ancien.
  const commits: Commit[] = [
    {
      sha: sha("b"),
      subject: "feat(memory): deux",
      body: "",
      files: ["omp-mem0-memory/recall.ts", "omp-mem0-req/seeds.ts"],
    },
    { sha: sha("a"), subject: "fix(memory): un", body: "", files: ["omp-mem0-memory/state.ts"] },
    { sha: sha("c"), subject: "docs: trois", body: "", files: ["README.md"] },
  ];
  const plugins: Plugin[] = [
    { name: "omp-mem0-memory", dir: "omp-mem0-memory", version: "2.9.7", previousTag: "omp-mem0-memory-v2.9.6" },
    { name: "omp-mem0-req", dir: "omp-mem0-req", version: "0.15.0", previousTag: null },
  ];

  const plan = planRelease(commits, plugins);
  assert.deepEqual(plan.unchanged, []);
  assert.deepEqual(
    plan.planned.map((p) => [p.name, p.level, p.from, p.to]),
    [
      ["omp-mem0-memory", "minor", "2.9.7", "2.10.0"],
      ["omp-mem0-req", "minor", "0.15.0", "0.16.0"],
    ],
  );
  // Un commit qui touche plusieurs plugins compte pour chacun d'eux.
  assert.equal(plan.planned[0]?.changes.length, 2);
  assert.equal(plan.planned[1]?.changes.length, 1);
  assert.equal(plan.planned[0]?.tag, "omp-mem0-memory-v2.10.0");
  // Les changements portent le sha court et le sujet, du plus récent au plus ancien.
  assert.deepEqual(plan.planned[0]?.changes.map((c) => c.sha), ["bbbbbbb", "aaaaaaa"]);

  // Un commit qui ne touche aucun fichier de plugin ne qualifie rien.
  const docsOnly = planRelease(commits.filter((c) => c.subject.startsWith("docs")), plugins);
  assert.deepEqual(docsOnly.planned, []);
  assert.deepEqual(docsOnly.unchanged, ["omp-mem0-memory", "omp-mem0-req"]);
  assert.equal(docsOnly.planned.length, 0);
});

test("analyse du log : corps multi-lignes et fichiers, séparateur non ambigu", () => {
  // Forme RÉELLE de `git log --no-merges --name-only
  // --format='%x1e%H%x1f%s%x1f%b%x1d'` : le corps garde ses lignes vides, et
  // c'est le `%x1d` qui sépare le corps de la liste de fichiers.
  const raw = [
    `\u001e${"1".repeat(40)}\u001ffix(memory)!: sujet\u001fcorps ligne 1\nligne 2\n\nBREAKING CHANGE: la casse\nsuite\u001d`,
    "",
    "omp-mem0-memory/state.ts",
    "README.md",
    `\u001e${"2".repeat(40)}\u001ffeat(req): autre\u001f\u001d`,
    "",
    "omp-mem0-req/seeds.ts",
    "",
  ].join("\n");

  const commits = parseCommits(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0]?.subject, "fix(memory)!: sujet");
  assert.deepEqual(commits[0]?.files, ["omp-mem0-memory/state.ts", "README.md"]);
  assert.equal(breakingText(commits[0]?.body ?? ""), "la casse suite");
  assert.equal(levelOf(commits[0]?.subject ?? "", commits[0]?.body ?? ""), "major");
  assert.equal(commits[1]?.body, "");
  assert.deepEqual(commits[1]?.files, ["omp-mem0-req/seeds.ts"]);
  assert.deepEqual(parseCommits(""), [], "une plage vide n'est pas une erreur");
});

test("changelog : entrées insérées après le titre, la plus récente d'abord", () => {
  const first = insertChangelog(null, ["## omp-mem0-memory 2.9.8 — 2026-09-24\n\n- un (aaaaaaa)"]);
  assert.equal(first, "# Journal des versions\n\n## omp-mem0-memory 2.9.8 — 2026-09-24\n\n- un (aaaaaaa)\n");

  const second = insertChangelog(first, ["## omp-mem0-req 0.15.1 — 2026-09-25\n\n- deux (bbbbbbb)"]);
  assert.ok(second.startsWith("# Journal des versions\n\n## omp-mem0-req 0.15.1"), second);
  assert.ok(second.indexOf("0.15.1") < second.indexOf("2.9.8"), "la plus récente passe en tête");
  assert.equal(second.split("# Journal des versions").length, 2, "un seul titre");
  assert.ok(second.endsWith("\n"), "le fichier finit par un saut de ligne");
});

/** Un plan minimal, pour exercer le rendu sans git. */
function fixturePlan(level: Planned["level"], breaking: string | null): Planned {
  const change: Change = {
    sha: "aaaaaaa",
    subject: "feat(memory): le brief change",
    level,
    breaking,
  };
  const to = level === "major" ? "3.0.0" : "2.9.8";
  return {
    name: "omp-mem0-memory",
    dir: "omp-mem0-memory",
    level,
    from: "2.9.7",
    to,
    tag: `omp-mem0-memory-v${to}`,
    changes: [change],
    // Un bump majeur a, par définition, au moins un commit de rupture : c'est ce
    // commit-là que la section « Ce qui casse » liste.
    breaking: level === "major" ? [change] : [],
    previousTag: "omp-mem0-memory-v2.9.6",
  };
}

test("corps de release : gabarit exact, rupture AVANT l'installation, première version", () => {
  const options = { ownerRepo: "millianlmx/mem0-omp", marketplace: "mem0-omp" };
  const minor = renderReleaseBody([fixturePlan("minor", null)], options);
  assert.ok(minor.includes("Changements depuis omp-mem0-memory-v2.9.6 :"), minor);
  assert.ok(!minor.includes("Ce qui casse"), minor);
  assert.ok(minor.indexOf("### Installation") < minor.indexOf("### Mise à jour"), minor);
  assert.equal(minor, [
    "## omp-mem0-memory 2.9.8",
    "",
    "Changements depuis omp-mem0-memory-v2.9.6 :",
    "- feat(memory): le brief change (aaaaaaa)",
    "",
    "### Installation",
    "/marketplace add millianlmx/mem0-omp",
    "/marketplace install omp-mem0-memory@mem0-omp",
    "",
    "### Mise à jour",
    "/marketplace update mem0-omp",
    "/marketplace upgrade omp-mem0-memory@mem0-omp",
    "",
  ].join("\n"));

  // Un commit `!` sans footer donne le sujet seul.
  const bare = renderReleaseBody([fixturePlan("major", null)], options);
  assert.ok(bare.includes("### Ce qui casse / quoi faire"), bare);
  assert.ok(bare.includes("- feat(memory): le brief change\n"), bare);

  // Sans tag précédent, la ligne change de forme.
  const first = renderReleaseBody([{ ...fixturePlan("patch", null), previousTag: null }], options);
  assert.ok(first.includes("Changements (première version publiée) :"), first);
});

// ---------------------------------------------------------------------------
// Bout en bout : dépôt jetable, remote bare local, faux `gh`
// ---------------------------------------------------------------------------

type Kind = "patch" | "docs" | "major" | "tagged";

/** Les commits de chaque scénario : fichier touché, sujet, corps. */
const SCRIPT: Record<Kind, Array<{ file: string; subject: string; body?: string }>> = {
  patch: [
    {
      file: "omp-mem0-memory/state.ts",
      subject: "fix(memory): le rappel ne perd plus un souvenir sans score",
    },
  ],
  docs: [{ file: "README.md", subject: "docs: précise la section installation" }],
  major: [
    { file: "omp-mem0-req/seeds.ts", subject: "feat(req): les specs figées portent leur date" },
    {
      file: "omp-mem0-memory/brief.ts",
      subject: "feat(memory)!: le brief change de format",
      body: "BREAKING CHANGE: le brief v3 n'est plus lu, relance /mem0-brief",
    },
  ],
  // Même plage que `patch`, mais le tag de la version cible existe DÉJÀ sur le
  // remote : la garde par tag doit retirer le plugin du plan.
  tagged: [
    {
      file: "omp-mem0-memory/state.ts",
      subject: "fix(memory): le rappel ne perd plus un souvenir sans score",
    },
  ],
};

/** État du changelog : `null` quand le fichier n'existe pas (un état, pas rien). */
type ChangelogState = string | null;

function changelogState(dir: string): ChangelogState {
  const file = path.join(dir, "CHANGELOG.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/**
 * Les versions RÉELLES de l'arbre et les cibles qui en découlent — JAMAIS des
 * littéraux : le job de release lance `check.sh` APRÈS avoir écrit le bump, donc
 * cette suite tourne aussi sur un arbre déjà bumpé. Des littéraux y faisaient
 * attendre `2.9.8` à un moteur qui calculait `2.9.8 → 2.9.9`, `check.sh` sortait 1
 * après écriture (« rien n'est committé ») et aucune release n'était publiée.
 */
type TreeVersions = {
  /** `version` du package.json — la base que le moteur lit sur `origin/main`. */
  pkg: string;
  /** `version` de l'entrée de catalogue (que check.sh tient alignée sur pkg). */
  entry: string;
  /** Version de la release PRÉCÉDENTE que le scénario pose en tag. */
  previous: string;
  patch: string;
  minor: string;
  major: string;
};

function versionsOf(dir: string): TreeVersions {
  const pkg = versionOf(ROOT, `${dir}/package.json`);
  const [major = 0, minor = 0, patch = 0] = pkg.split(".").map(Number);
  // Strictement inférieure à `pkg`, pour que `git describe` la rende comme tag
  // précédent — et jamais égale à la CIBLE, sinon la garde par tag retirerait le
  // plugin du plan. (0.0.0 n'a pas d'antécédent : on plante alors la version.)
  const previous =
    patch > 0
      ? `${major}.${minor}.${patch - 1}`
      : minor > 0
        ? `${major}.${minor - 1}.0`
        : major > 0
          ? `${major - 1}.0.0`
          : pkg;
  return {
    pkg,
    entry: entryVersion(ROOT, CATALOGS[0], dir),
    previous,
    patch: bumpVersion(pkg, "patch"),
    minor: bumpVersion(pkg, "minor"),
    major: bumpVersion(pkg, "major"),
  };
}

const VERSIONS = { memory: versionsOf("omp-mem0-memory"), req: versionsOf("omp-mem0-req") };
/** Les tags de release PRÉCÉDENTE posés dans chaque dépôt jetable. */
const PREVIOUS_TAGS = [
  `omp-mem0-memory-v${VERSIONS.memory.previous}`,
  `omp-mem0-req-v${VERSIONS.req.previous}`,
];

type Scenario = {
  dir: string;
  remote: string;
  before: string;
  after: string;
  commits: Array<{ subject: string; sha: string }>;
  code: number;
  stdout: string;
  stderr: string;
  journal: string;
  bin: string;
  /** Le changelog AVANT le moteur : un plan vide doit le laisser tel quel. */
  changelogBefore: ChangelogState;
};

// Ce qui n'a rien à faire dans la copie jetable : l'historique, les dépendances,
// la racine de types jetable, le stockage vectoriel local, les fichiers de test
// qui se recopieraient, et les gros (le harnais prouve le bump, pas la suite).
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

function copyRepo(dir: string): void {
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
}

/** Un faux `gh` : journalise l'appel, recopie le corps de la note, réussit. */
function writeFakeGh(bin: string): void {
  const script = [
    "#!/usr/bin/env bash",
    "# Faux `gh` du harnais : aucun réseau, mais l'appel et le corps EXACT sont",
    "# conservés — c'est ce que la release aurait publié.",
    'notes=""',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "--notes-file" ]; then notes="$arg"; fi',
    '  prev="$arg"',
    "done",
    'printf \'%s\\n\' "$*" >> "$GH_JOURNAL"',
    'if [ -n "$notes" ] && [ -n "${3:-}" ]; then cp "$notes" "$GH_JOURNAL.$3"; fi',
    "exit 0",
    "",
  ].join("\n");
  const file = path.join(bin, "gh");
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}

async function buildScenario(kind: Kind): Promise<Scenario> {
  const dir = mktmp(`release-${kind}-`);
  copyRepo(dir);
  const remote = path.join(mktmp(`release-${kind}-remote-`), "origin.git");
  git(["init", "-q", "--bare", remote], dir);

  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "chore: base du scénario"], dir);
  // Releases PRÉCÉDENTES : les tags des versions juste AVANT celles de l'arbre
  // (dérivées, cf. VERSIONS) — plus anciennes que la cible, sinon la garde
  // d'idempotence par tag retirerait le plugin du plan.
  for (const tag of PREVIOUS_TAGS) git(["tag", "-a", tag, "-m", tag.replace("-v", " ")], dir);
  git(["remote", "add", "origin", remote], dir);
  git(["push", "-q", "origin", "main", "--tags"], dir);

  const before = git(["rev-parse", "HEAD"], dir).trim();
  const commits: Array<{ subject: string; sha: string }> = [];
  for (const step of SCRIPT[kind]) {
    fs.appendFileSync(
      path.join(dir, step.file),
      step.file.endsWith(".md") ? "\n<!-- scénario de test -->\n" : `\n// ${step.subject}\n`,
    );
    git(["add", "--", step.file], dir);
    const message = ["commit", "-q", "-m", step.subject];
    if (step.body) message.push("-m", step.body);
    git(message, dir);
    commits.push({ subject: step.subject, sha: git(["rev-parse", "--short", "HEAD"], dir).trim() });
  }
  git(["push", "-q", "origin", "main"], dir);
  const after = git(["rev-parse", "HEAD"], dir).trim();
  if (kind === "tagged") {
    // Le tag de la version CIBLE (dérivée de l'arbre) existe déjà : c'est la
    // seconde garde d'idempotence.
    const tag = `omp-mem0-memory-v${VERSIONS.memory.patch}`;
    git(["tag", "-a", tag, "-m", tag.replace("-v", " ")], dir);
    git(["push", "-q", "origin", tag], dir);
  }

  const bin = mktmp(`release-${kind}-bin-`);
  const journal = path.join(mktmp(`release-${kind}-journal-`), "gh.log");
  fs.writeFileSync(journal, "");
  writeFakeGh(bin);
  // L'état AVANT le moteur : un plan vide doit le laisser tel quel, que le
  // changelog soit absent (aucune release encore publiée) ou déjà rempli par une
  // release — `main` le porte dès la première publication.
  const changelogBefore = changelogState(dir);
  const result = runEngine(dir, before, after, bin, journal);

  return {
    dir,
    remote,
    before,
    after,
    commits,
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    journal,
    bin,
    changelogBefore,
  };
}

/**
 * Le moteur, DANS la copie jetable, avec le faux `gh` en tête de PATH et sans la
 * config git de la machine : ni GITHUB_REPOSITORY ni remote devinés (`--repo`).
 */
function runEngine(dir: string, before: string, after: string, bin: string, journal: string) {
  return spawnSync(
    "node",
    [
      "--experimental-strip-types",
      "scripts/release.ts",
      "--before",
      before,
      "--after",
      after,
      "--repo",
      "millianlmx/mem0-omp",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GH_TOKEN: "jeton-de-test",
        GH_JOURNAL: journal,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      timeout: 900_000,
    },
  );
}

// Les scénarios démarrent ensemble : quatre `check.sh` complets tiennent en
// quelques secondes au lieu de la somme, et chaque test ne réclame que le sien.
const SCENARIOS: Record<Kind, Promise<Scenario>> | null =
  DEPTH === 0
    ? {
        patch: buildScenario("patch"),
        docs: buildScenario("docs"),
        major: buildScenario("major"),
        tagged: buildScenario("tagged"),
      }
    : null;

async function scenario(kind: Kind, t: { skip: (reason: string) => void }): Promise<Scenario> {
  if (SCENARIOS === null) {
    t.skip("copie imbriquée — scénario de bout en bout non rejoué");
    return await new Promise<never>(() => undefined);
  }
  return await SCENARIOS[kind];
}

const output = (s: Scenario) => `${s.stdout}${s.stderr}`;

function readFile(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

function versionOf(dir: string, rel: string): string {
  return (JSON.parse(readFile(dir, rel)) as { version: string }).version;
}

function entryVersion(dir: string, catalog: string, name: string): string {
  const parsed = JSON.parse(readFile(dir, catalog)) as {
    metadata?: { version?: string };
    plugins: Array<{ name: string; version?: string }>;
  };
  const entry = parsed.plugins.find((plugin) => plugin.name === name);
  assert.ok(entry, `${name} absent de ${catalog}`);
  return entry.version ?? "";
}

function metadataVersion(dir: string, catalog: string): string {
  const parsed = JSON.parse(readFile(dir, catalog)) as { metadata?: { version?: string } };
  return parsed.metadata?.version ?? "";
}

/** Les appels reçus par le faux `gh`, avec le corps de note de chacun. */
function readCalls(journal: string): Array<{ args: string; tag: string; notes: string }> {
  return fs
    .readFileSync(journal, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((args) => {
      const tag = /create (\S+)/.exec(args)?.[1] ?? "";
      const notesFile = `${journal}.${tag}`;
      return { args, tag, notes: fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8") : "" };
    });
}

test("release/AC-3 : un `fix` sur un seul plugin le bump en patch, l'autre ne bouge pas, et check.sh passe", async (t) => {
  const s = await scenario("patch", t);
  const { memory, req } = VERSIONS;
  assert.equal(s.code, 0, output(s));
  assert.ok(s.stdout.includes(`✓ omp-mem0-memory : patch ${memory.pkg} → ${memory.patch} (1 commit(s))`), output(s));
  assert.ok(s.stdout.includes("· omp-mem0-req : inchangé (aucun fichier touché)"), output(s));

  assert.equal(versionOf(s.dir, "omp-mem0-memory/package.json"), memory.patch);
  assert.equal(versionOf(s.dir, "omp-mem0-req/package.json"), req.pkg, "le plugin non touché ne bouge pas");
  for (const catalog of CATALOGS) {
    assert.equal(entryVersion(s.dir, catalog, "omp-mem0-memory"), memory.patch, catalog);
    assert.equal(entryVersion(s.dir, catalog, "omp-mem0-req"), req.entry, catalog);
  }

  // La preuve exigée après écriture : check.sh sur le RÉSULTAT bumpé.
  const check = spawnSync("bash", ["scripts/check.sh"], {
    cwd: s.dir,
    encoding: "utf8",
    env: GIT_ENV,
    timeout: 900_000,
  });
  const out = `${check.stdout ?? ""}${check.stderr ?? ""}`;
  assert.equal(check.status, 0, out);
  assert.ok(out.includes(`✓ omp-mem0-memory : version ${memory.patch} alignée sur le package.json`), out);
  // `metadata.version` = la plus GRANDE version du catalogue après bump.
  const metadata = maxVersion([memory.patch, req.entry]);
  assert.ok(metadata !== null, "catalogue sans version");
  assert.ok(out.includes(`✓ metadata.version ${metadata} nomme une version publiée`), out);
});

test("release/AC-4 : un merge sans fichier de plugin ne change aucune version et ne publie rien", async (t) => {
  const s = await scenario("docs", t);
  const { memory, req } = VERSIONS;
  assert.equal(s.code, 0, output(s));
  assert.ok(s.stdout.includes("· omp-mem0-memory : inchangé (aucun fichier touché)"), output(s));
  assert.ok(s.stdout.includes("· omp-mem0-req : inchangé (aucun fichier touché)"), output(s));

  assert.equal(versionOf(s.dir, "omp-mem0-memory/package.json"), memory.pkg);
  assert.equal(versionOf(s.dir, "omp-mem0-req/package.json"), req.pkg);
  const metadata = maxVersion([memory.entry, req.entry]);
  assert.ok(metadata !== null, "catalogue sans version");
  for (const catalog of CATALOGS) {
    assert.equal(entryVersion(s.dir, catalog, "omp-mem0-memory"), memory.entry, catalog);
    assert.equal(entryVersion(s.dir, catalog, "omp-mem0-req"), req.entry, catalog);
    assert.equal(metadataVersion(s.dir, catalog), metadata, catalog);
  }

  // Le changelog reste INCHANGÉ : absent avant la première release publiée, puis
  // présent sur `main`. Exiger son ABSENCE ferait échouer tout arbre ayant déjà
  // publié, alors qu'aucune écriture n'a eu lieu (mesuré le 2026-09-24).
  assert.equal(changelogState(s.dir), s.changelogBefore, "changelog inchangé");
  assert.equal(fs.readFileSync(s.journal, "utf8").trim(), "", "aucun appel à gh");
  assert.equal(
    remoteGit(s.remote, ["tag", "-l"]).trim().split("\n").sort().join(","),
    [...PREVIOUS_TAGS].sort().join(","),
    "aucun tag nouveau",
  );
  assert.equal(remoteGit(s.remote, ["rev-parse", "main"]).trim(), s.after, "aucun commit de release");
});

test("release/AC-5 : le bump crée un tag et une release, dont la note liste les changements", async (t) => {
  const s = await scenario("patch", t);
  const { memory } = VERSIONS;
  const tag = `omp-mem0-memory-v${memory.patch}`;
  assert.equal(s.code, 0, output(s));

  assert.equal(remoteGit(s.remote, ["tag", "-l", tag]).trim(), tag, "le tag est poussé sur le remote");
  const calls = readCalls(s.journal);
  const call = calls.find((entry) => entry.tag === tag);
  assert.ok(call, `aucune release pour le tag publié : ${s.journal}`);
  assert.ok(
    call.args.startsWith(`release create ${tag} --verify-tag --title omp-mem0-memory ${memory.patch}`),
    `le tag est créé par git, jamais par gh (--verify-tag) : ${call.args}`,
  );

  const [commit] = s.commits;
  assert.ok(commit, "le scénario porte un commit");
  assert.ok(call.notes.includes(`## omp-mem0-memory ${memory.patch}`), call.notes);
  assert.ok(call.notes.includes(`Changements depuis omp-mem0-memory-v${memory.previous} :`), call.notes);
  assert.ok(call.notes.includes(`- ${commit.subject} (${commit.sha})`), call.notes);
});

test("release/AC-6 : CHANGELOG.md porte l'entrée datée, et le commit de release est sur main", async (t) => {
  const s = await scenario("patch", t);
  assert.equal(s.code, 0, output(s));

  const today = new Date().toISOString().slice(0, 10);
  const { memory } = VERSIONS;
  const [commit] = s.commits;
  assert.ok(commit, "le scénario porte un commit");
  const changelog = readFile(s.dir, "CHANGELOG.md");
  assert.ok(changelog.startsWith("# Journal des versions\n"), changelog);
  assert.ok(changelog.includes(`## omp-mem0-memory ${memory.patch} — ${today}`), changelog);
  assert.ok(changelog.includes(`- ${commit.subject} (${commit.sha})`), changelog);

  // Committé PAR le workflow : le fichier est dans `main` sur le remote, et le
  // commit porte le trailer d'idempotence.
  const published = remoteGit(s.remote, ["show", "main:CHANGELOG.md"]);
  assert.ok(published.includes(`## omp-mem0-memory ${memory.patch} — ${today}`), published);
  assert.equal(
    remoteGit(s.remote, ["log", "-1", "--format=%s", "main"]).trim(),
    `chore(release): omp-mem0-memory ${memory.patch}`,
  );
  const message = remoteGit(s.remote, ["log", "-1", "--format=%B", "main"]);
  assert.ok(message.includes(`Release-Event: ${s.after}`), message);
  assert.ok(message.includes(`Released: omp-mem0-memory ${memory.patch}`), message);
});

// S-4 (idempotence) n'a AUCUN critère d'acceptation : ce test la prouve quand
// même, parce qu'un rejeu qui republierait une release est un incident réel.
test("idempotence : un merge déjà publié et un tag déjà posé ne republient rien", async (t) => {
  const patch = await scenario("patch", t);
  const targetTag = `omp-mem0-memory-v${VERSIONS.memory.patch}`;
  assert.equal(patch.code, 0, output(patch));
  const published = remoteGit(patch.remote, ["rev-parse", "main"]).trim();

  // (1) Le trailer `Release-Event: <after>` du commit de release marque la fusion.
  const replay = runEngine(patch.dir, patch.before, patch.after, patch.bin, patch.journal);
  assert.equal(replay.status, 0, `${replay.stdout ?? ""}${replay.stderr ?? ""}`);
  assert.match(replay.stdout ?? "", /· merge déjà publié/);
  assert.equal(readCalls(patch.journal).length, 1, "aucune seconde release");
  assert.equal(remoteGit(patch.remote, ["rev-parse", "main"]).trim(), published, "aucun second commit");
  assert.equal(
    remoteGit(patch.remote, ["tag", "-l"]).trim().split("\n").filter((tag) => tag === targetTag).length,
    1,
    "aucun second tag",
  );

  // (2) Un tag déjà poussé retire le plugin du plan.
  const tagged = await scenario("tagged", t);
  assert.equal(tagged.code, 0, output(tagged));
  assert.ok(tagged.stdout.includes(`· omp-mem0-memory : déjà publié (tag ${targetTag})`), output(tagged));
  assert.ok(!tagged.stdout.includes("✓"), `plan vide attendu :\n${output(tagged)}`);
  assert.equal(fs.readFileSync(tagged.journal, "utf8").trim(), "", "aucune release");
  assert.equal(remoteGit(tagged.remote, ["rev-parse", "main"]).trim(), tagged.after, "aucun commit");
  assert.equal(changelogState(tagged.dir), tagged.changelogBefore, "changelog inchangé");
});

test("release/AC-7 : chaque plugin bumpé porte ses commandes d'installation et de mise à jour", async (t) => {
  const s = await scenario("major", t);
  assert.equal(s.code, 0, output(s));

  const calls = readCalls(s.journal);
  assert.equal(calls.length, 2, `une release par plugin bumpé : ${s.journal}`);
  for (const [plugin, version] of [
    ["omp-mem0-memory", VERSIONS.memory.major],
    ["omp-mem0-req", VERSIONS.req.minor],
  ]) {
    const call = calls.find((entry) => entry.tag === `${plugin}-v${version}`);
    assert.ok(call, `release absente pour ${plugin} ${version}`);
    assert.ok(call.notes.includes("/marketplace add millianlmx/mem0-omp"), call.notes);
    assert.ok(call.notes.includes(`/marketplace install ${plugin}@mem0-omp`), call.notes);
    assert.ok(call.notes.includes("/marketplace update mem0-omp"), call.notes);
    assert.ok(call.notes.includes(`/marketplace upgrade ${plugin}@mem0-omp`), call.notes);
  }

  // Le gabarit pur, pour les deux plugins d'un coup : une section chacun.
  const planned = planRelease(
    [
      { sha: "a".repeat(40), subject: "feat(req): un", body: "", files: ["omp-mem0-req/seeds.ts"] },
      { sha: "b".repeat(40), subject: "feat(memory): deux", body: "", files: ["omp-mem0-memory/brief.ts"] },
    ],
    [
      { name: "omp-mem0-memory", dir: "omp-mem0-memory", version: "2.9.7", previousTag: null },
      { name: "omp-mem0-req", dir: "omp-mem0-req", version: "0.15.0", previousTag: null },
    ],
  ).planned;
  const body = renderReleaseBody(planned, { ownerRepo: "millianlmx/mem0-omp", marketplace: "mem0-omp" });
  assert.ok(body.includes("/marketplace install omp-mem0-memory@mem0-omp"), body);
  assert.ok(body.includes("/marketplace install omp-mem0-req@mem0-omp"), body);
  assert.ok(body.includes("/marketplace upgrade omp-mem0-req@mem0-omp"), body);
  assert.ok(body.indexOf("## omp-mem0-memory") < body.indexOf("## omp-mem0-req"), "ordre du catalogue");
});

test("release/AC-8 : le bump majeur porte « ce qui casse / quoi faire », les autres non", async (t) => {
  const s = await scenario("major", t);
  assert.equal(s.code, 0, output(s));

  const calls = readCalls(s.journal);
  const major = calls.find((entry) => entry.tag === `omp-mem0-memory-v${VERSIONS.memory.major}`);
  const minor = calls.find((entry) => entry.tag === `omp-mem0-req-v${VERSIONS.req.minor}`);
  assert.ok(major && minor, `deux releases attendues : ${s.journal}`);

  assert.ok(major.notes.includes(`## omp-mem0-memory ${VERSIONS.memory.major}`), major.notes);
  assert.ok(major.notes.includes("### Ce qui casse / quoi faire"), major.notes);
  assert.ok(
    major.notes.includes("- feat(memory)!: le brief change de format — le brief v3 n'est plus lu, relance /mem0-brief"),
    major.notes,
  );
  assert.ok(
    major.notes.indexOf("### Ce qui casse / quoi faire") < major.notes.indexOf("### Installation"),
    "la section précède l'installation",
  );
  assert.ok(!minor.notes.includes("Ce qui casse"), `un bump mineur n'a pas la section :\n${minor.notes}`);

  // Le gabarit pur, pour les deux niveaux.
  const options = { ownerRepo: "millianlmx/mem0-omp", marketplace: "mem0-omp" };
  const withBreaking = renderReleaseBody([fixturePlan("major", "tout casse")], options);
  assert.ok(withBreaking.includes("- feat(memory): le brief change — tout casse"), withBreaking);
  assert.ok(!renderReleaseBody([fixturePlan("patch", null)], options).includes("Ce qui casse"));
});
