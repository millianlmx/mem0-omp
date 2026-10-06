// Tests du moteur de release (scripts/release.ts) : les règles de décision, le
// plan, l'historique des versions et les rendus sont PURS (aucun git, aucun
// réseau) ; le bout en bout tourne dans un dépôt JETABLE avec un remote nu local,
// un hook `pre-receive` qui refuse `refs/heads/main` (le rôle du refus GH006 de
// la protection de branche) et un faux `gh` qui réalise une VRAIE fusion squash —
// jamais contre GitHub, jamais contre ce dépôt.
//
// Trois règles structurent ce fichier :
//  1. la copie jetable ÉCARTE les gros fichiers de test et ceux qui se
//     recopieraient (test/check.test.ts, ce fichier, test/bump-guard.test.ts,
//     test/smoke.test.ts…) : le moteur lance `check.sh` pour de vrai, et ce qu'on
//     prouve ici c'est que ses écritures laissent check.sh vert, pas qu'on rejoue
//     toute la suite ;
//  2. les scénarios sont construits UNE fois, au chargement du module et
//     seulement au premier niveau (`MEM0_CHECK_DEPTH === 0`) : lancés depuis la
//     copie d'un autre test, ils se rappelleraient eux-mêmes ;
//  3. aucune version de l'arbre n'est FIGÉE : le job de release lance `check.sh`
//     APRÈS avoir écrit le bump, donc cette suite tourne aussi sur un arbre où un
//     plugin vaut déjà la cible du run précédent. Les attendus sont DÉRIVÉS de
//     l'arbre (`VERSIONS`), sinon le scénario de correctif calcule une version que
//     ses assertions n'attendent pas, `check.sh` sort 1 après écriture, et aucune
//     release n'est jamais publiée (mesuré le 2026-09-24).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  backlogOf,
  breakingText,
  bumpVersion,
  changesBetween,
  compareVersions,
  historyOf,
  insertChangelog,
  levelOf,
  maxLevel,
  maxVersion,
  parseCommits,
  planOf,
  renderChangelogEntry,
  renderReleaseBody,
  repoFromRemote,
  utcDate,
  versionTag,
  type Change,
  type PluginHistory,
  type Release,
  type VersionEntry,
} from "../scripts/release.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CATALOGS = [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"];
// Assemblé, jamais littéral : test/docs.test.ts calcule la liste des fichiers du
// dépôt qui citent une URL de dépôt, et ce fichier ne doit pas en faire partie (il
// serait alors à citer dans PUBLISHING.md § Avant de pousser).
const HOST = ["github", "com"].join(".");
const REPO = "millianlmx/mem0-omp";
const WORKFLOW = ".github/workflows/release.yml";
/** Date de fusion du faux `gh` : fixe, pour que les scénarios soient rejouables. */
const MERGE_DATE = "2026-09-27T12:00:00+00:00";
/** Profondeur d'imbrication : 0 = `node --test test/release.test.ts` à la main. */
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
  .filter((entry) => typeof entry.source === "string" && entry.source.startsWith("./"))
  .map((entry) => ({ name: entry.name, dir: String(entry.source).slice(2) }));

const MEMORY = PLUGINS[0] as { name: string; dir: string };
const REQ = PLUGINS[1] as { name: string; dir: string };

function entryVersionOf(dir: string, catalog: string, name: string): string {
  const entry = readJson<Catalog>(dir, catalog).plugins.find((plugin) => plugin.name === name);
  assert.ok(entry, `${name} absent de ${catalog}`);
  return entry.version ?? "";
}

function versionIn(dir: string, rel: string): string {
  return readJson<{ version: string }>(dir, rel).version;
}

type TreeVersions = { pkg: string; entry: string; patch: string; minor: string; major: string };

function versionsOf(plugin: { name: string; dir: string }): TreeVersions {
  const pkg = versionIn(ROOT, `${plugin.dir}/package.json`);
  return {
    pkg,
    entry: entryVersionOf(ROOT, CATALOGS[0], plugin.name),
    patch: bumpVersion(pkg, "patch"),
    minor: bumpVersion(pkg, "minor"),
    major: bumpVersion(pkg, "major"),
  };
}

const VERSIONS: Record<string, TreeVersions> = {
  [MEMORY.name]: versionsOf(MEMORY),
  [REQ.name]: versionsOf(REQ),
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

/**
 * Config globale du MOTEUR (pas des dépôts jetables) : `useConfigOnly` interdit à
 * git de DEVINER une identité — sans lui, il retombe sur le GECOS du compte, ce
 * qui rendait une commande sans `-c user.*` verte sur macOS et rouge sur ubuntu
 * (mesuré le 2026-09-24 : `git tag -a` sans identité, six critères rouges sur
 * ubuntu, verts sur macOS). Une identité oubliée rougit donc sur les deux OS.
 */
const ENGINE_GIT_CONFIG = path.join(mktmp("release-git-conf-"), "global.conf");
fs.writeFileSync(ENGINE_GIT_CONFIG, "[user]\n\tuseConfigOnly = true\n");

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} : ${result.stderr}`);
  return result.stdout ?? "";
}

/** git contre le remote nu : lecture de l'état RÉELLEMENT publié. */
function remoteGit(remote: string, args: string[]): string {
  return git([`--git-dir=${remote}`, ...args], path.dirname(remote));
}

const output = (run: SpawnSyncReturns<string>) => `${run.stdout ?? ""}${run.stderr ?? ""}`;

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
  // une URL de dépôt, et ce fichier ne doit pas en faire partie.
  assert.equal(repoFromRemote(`git@${HOST}:millianlmx/mem0-omp.git`), REPO);
  assert.equal(repoFromRemote(`https://${HOST}/millianlmx/mem0-omp.git`), REPO);
  assert.equal(repoFromRemote(`https://${HOST}/millianlmx/mem0-omp`), REPO);
});

test("dates : `AAAA-MM-JJ` en UTC, depuis le git et jamais depuis l'horloge (G-3)", () => {
  assert.equal(utcDate("2026-09-27T23:30:00+02:00"), "2026-09-27", "convertie en UTC");
  assert.equal(utcDate("2026-09-27T22:30:00-05:00"), "2026-09-28");
  assert.throws(() => utcDate("hier"), /date illisible/);
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

  // L'attribution est par sous-dossier du plugin, jamais par nom de fichier.
  assert.deepEqual(
    changesBetween(commits, "omp-mem0-memory").map((change) => change.sha),
    ["1".repeat(7)],
  );
  assert.deepEqual(changesBetween(commits, "docs"), []);
});

test("historique : première apparition de chaque version, dans l'ordre chronologique", () => {
  // Cas RÉEL du dépôt : l'ordre chronologique n'est PAS l'ordre semver (0.1.0 est
  // apparu après 2.2.0, régression de version racontée dans le README).
  const rows: VersionEntry[] = [
    { sha: "a".repeat(40), version: "2.2.0", date: "2025-01-01" },
    { sha: "b".repeat(40), version: "0.1.0", date: "2025-01-02" },
    { sha: "c".repeat(40), version: "0.2.0", date: "2025-01-03" },
    { sha: "d".repeat(40), version: "2.3.0", date: "2025-01-04" },
    { sha: "e".repeat(40), version: "2.3.0", date: "2025-01-05" },
  ];
  const history = historyOf(rows);
  assert.deepEqual(
    history.map((entry) => entry.version),
    ["2.2.0", "0.1.0", "0.2.0", "2.3.0"],
    "première apparition, ordre chronologique conservé",
  );
  assert.equal(history[history.length - 1]?.version, "2.3.0", "la dernière est la version courante");
  assert.deepEqual(historyOf([]), [], "un historique vide ne produit aucune entrée");

  const existing = new Set([versionTag("omp-mem0-memory", "2.2.0"), versionTag("omp-mem0-memory", "2.3.0")]);
  assert.deepEqual(
    backlogOf("omp-mem0-memory", history, existing).map((entry) => entry.version),
    ["0.1.0", "0.2.0"],
    "une version déjà taguée n'est jamais republiée",
  );
});

function fixtureRelease(level: Release["level"], breaking: string | null): Release {
  const change: Change = { sha: "aaaaaaa", subject: "feat(memory): le brief change", level, breaking };
  const version = level === "major" ? "3.0.0" : "2.9.8";
  return {
    kind: "bump",
    name: "omp-mem0-memory",
    dir: "omp-mem0-memory",
    from: "2.9.7",
    version,
    tag: `omp-mem0-memory-v${version}`,
    commit: null,
    date: "2026-09-27",
    level,
    changes: [change],
    // Un bump majeur a, par définition, au moins un commit de rupture : c'est ce
    // commit-là que la section « Ce qui casse » liste.
    breaking: level === "major" ? [change] : [],
    previousTag: "omp-mem0-memory-v2.9.6",
  };
}

test("changelog : entrées insérées après le titre, la plus récente d'abord, sans doublon", () => {
  const older = renderChangelogEntry({
    ...fixtureRelease("patch", null),
    version: "2.9.8",
    date: "2026-09-24",
    changes: [{ sha: "aaaaaaa", subject: "un", level: "patch", breaking: null }],
  });
  const newer = renderChangelogEntry({
    ...fixtureRelease("patch", null),
    version: "2.9.9",
    date: "2026-09-25",
    changes: [{ sha: "bbbbbbb", subject: "deux", level: "patch", breaking: null }],
  });
  assert.equal(older, "## omp-mem0-memory 2.9.8 — 2026-09-24\n\n- un (aaaaaaa)");

  const first = insertChangelog(null, [older]);
  assert.equal(first, "# Journal des versions\n\n## omp-mem0-memory 2.9.8 — 2026-09-24\n\n- un (aaaaaaa)\n");

  const second = insertChangelog(first, [newer]);
  assert.ok(second.startsWith("# Journal des versions\n\n## omp-mem0-memory 2.9.9"), second);
  assert.ok(second.indexOf("2.9.9") < second.indexOf("2.9.8"), "la plus récente passe en tête");
  assert.equal(second.split("# Journal des versions").length, 2, "un seul titre");
  assert.ok(second.endsWith("\n"), "le fichier finit par un saut de ligne");
  assert.equal(insertChangelog(second, [newer]), second, "un rejeu ne duplique pas l'entrée");

  // L'idempotence se juge sur le TITRE, pas sur la date : un run qui republie des
  // tags manquants ne réécrit pas une entrée déjà là.
  const otherDate = renderChangelogEntry({
    ...fixtureRelease("patch", null),
    version: "2.9.9",
    date: "2026-12-31",
    changes: [{ sha: "bbbbbbb", subject: "deux", level: "patch", breaking: null }],
  });
  assert.equal(insertChangelog(second, [otherDate]), second);
});

test("corps de release : gabarit exact, rupture AVANT l'installation, première version", () => {
  const options = { ownerRepo: REPO, marketplace: "mem0-omp" };
  const minor = renderReleaseBody([fixtureRelease("minor", null)], options);
  assert.ok(minor.includes("Changements depuis omp-mem0-memory-v2.9.6 :"), minor);
  assert.ok(!minor.includes("Ce qui casse"), minor);
  assert.ok(minor.indexOf("### Installation") < minor.indexOf("### Mise à jour"), minor);
  assert.equal(
    minor,
    [
      "## omp-mem0-memory 2.9.8",
      "",
      "Changements depuis omp-mem0-memory-v2.9.6 :",
      "- feat(memory): le brief change (aaaaaaa)",
      "",
      "### Installation",
      `/marketplace add ${REPO}`,
      "/marketplace install omp-mem0-memory@mem0-omp",
      "",
      "### Mise à jour",
      "/marketplace update mem0-omp",
      "/marketplace upgrade omp-mem0-memory@mem0-omp",
      "",
    ].join("\n"),
  );

  // Un commit `!` sans footer donne le sujet seul.
  const bare = renderReleaseBody([fixtureRelease("major", null)], options);
  assert.ok(bare.includes("### Ce qui casse / quoi faire"), bare);
  assert.ok(bare.includes("- feat(memory): le brief change\n"), bare);
  assert.ok(!renderReleaseBody([fixtureRelease("patch", null)], options).includes("Ce qui casse"));

  // Sans tag précédent, la ligne change de forme.
  const first = renderReleaseBody([{ ...fixtureRelease("patch", null), previousTag: null }], options);
  assert.ok(first.includes("Changements (première version publiée) :"), first);
});

/** Un historique de plugin monté à la main : le plan se teste sans git. */
function historyFixture(name: string, dir: string, versions: Array<[string, string]>): PluginHistory {
  const changes: Change[] = [{ sha: "aaaaaaa", subject: "fix: un", level: "patch", breaking: null }];
  const history = versions.map(([version, sha]) => ({ sha, version, date: "2026-01-01" }));
  return { name, dir, history, ranges: history.map(() => changes), sinceCurrent: [] };
}

test("plan : rattrapage + bump, ordres de publication et de journal, gardes d'idempotence", () => {
  const memory = historyFixture(MEMORY.name, MEMORY.dir, [
    ["0.1.0", "a".repeat(40)],
    ["0.2.0", "b".repeat(40)],
    ["0.3.0", "c".repeat(40)],
  ]);
  const req = historyFixture(REQ.name, REQ.dir, [["0.18.0", "d".repeat(40)]]);
  // Seul le tag de la PREMIÈRE version de mémoire existe : le rattrapage a donc
  // 0.2.0, 0.3.0 et la 0.18.0 de req à publier.
  const tags = new Set([versionTag(MEMORY.name, "0.1.0")]);

  const plan = planOf([memory, req], tags, "2026-09-27", false);
  // Publication : l'ordre du catalogue, et pour chaque plugin son rattrapage dans
  // l'ordre chronologique — le taguée est sautée, celle de req ne l'est pas.
  assert.deepEqual(
    plan.releases.map((release) => [release.name, release.version, release.kind]),
    [
      [MEMORY.name, "0.2.0", "rattrapage"],
      [MEMORY.name, "0.3.0", "rattrapage"],
      [REQ.name, "0.18.0", "rattrapage"],
    ],
  );
  assert.equal(plan.releases[0]?.previousTag, versionTag(MEMORY.name, "0.1.0"));
  assert.equal(plan.releases[1]?.previousTag, versionTag(MEMORY.name, "0.2.0"));
  assert.equal(plan.releases[2]?.previousTag, null, "première version publiée de omp-mem0-req");
  assert.equal(plan.releases[0]?.commit, "b".repeat(40), "un rattrapage est tagué sur son commit d'apparition");
  assert.equal(plan.releases[0]?.date, "2026-01-01");
  assert.deepEqual(
    plan.journal.map((release) => release.version),
    ["0.3.0", "0.2.0", "0.18.0"],
    "le journal va du plus récent au plus ancien",
  );

  // Un bump entre au plan, tagué sur la fusion, à la fin de son plugin.
  const bumped = planOf(
    [
      {
        ...memory,
        sinceCurrent: [{ sha: "e".repeat(40), subject: "feat: deux", level: "minor", breaking: null }],
      },
      req,
    ],
    tags,
    "2026-09-27",
    false,
  );
  assert.deepEqual(
    bumped.releases.map((release) => [release.name, release.version, release.kind]),
    [
      [MEMORY.name, "0.2.0", "rattrapage"],
      [MEMORY.name, "0.3.0", "rattrapage"],
      [MEMORY.name, "0.4.0", "bump"],
      [REQ.name, "0.18.0", "rattrapage"],
    ],
  );
  const bump = bumped.releases[2];
  assert.equal(bump?.commit, null, "le commit de fusion n'est connu qu'après la fusion");
  assert.equal(bump?.previousTag, versionTag(MEMORY.name, "0.3.0"));
  assert.equal(bump?.date, "2026-09-27");
  assert.deepEqual(bumped.journal.map((release) => release.version), ["0.4.0", "0.3.0", "0.2.0", "0.18.0"]);
  assert.deepEqual(bumped.unchanged, [REQ.name], "req n'a aucun commit depuis sa version courante");

  // Garde 1 : l'événement est déjà publié — plus de bump, mais le rattrapage reste.
  const published = planOf([memory, req], tags, "2026-09-27", true);
  assert.deepEqual(
    published.releases.map((release) => release.kind),
    ["rattrapage", "rattrapage", "rattrapage"],
  );

  // Garde 2 : le tag de la version CIBLE existe déjà.
  const target = bumpVersion("0.3.0", "minor");
  const already = planOf(
    [
      {
        ...memory,
        sinceCurrent: [{ sha: "e".repeat(40), subject: "feat: deux", level: "minor", breaking: null }],
      },
    ],
    new Set([versionTag(MEMORY.name, target)]),
    "2026-09-27",
    false,
  );
  assert.deepEqual(already.alreadyPublished, [{ name: MEMORY.name, tag: versionTag(MEMORY.name, target) }]);
  assert.equal(already.releases.filter((release) => release.kind === "bump").length, 0);

  // Aucun commit qualifiant : le plugin est inchangé, jamais bumpé.
  const untouched = planOf(
    [historyFixture(MEMORY.name, MEMORY.dir, [["0.1.0", "a".repeat(40)]])],
    new Set([versionTag(MEMORY.name, "0.1.0")]),
    "2026-09-27",
    false,
  );
  assert.deepEqual(untouched.unchanged, [MEMORY.name]);
  assert.deepEqual(untouched.releases, []);
});

// ---------------------------------------------------------------------------
// Bout en bout : dépôt jetable, remote nu local, faux `gh`
// ---------------------------------------------------------------------------

/** Ce qui n'a rien à faire dans la copie jetable : l'historique, les dépendances,
 * la racine de types jetable, le stockage vectoriel local, et les fichiers de test
 * qui se recopieraient ou rejoueraient la même chose. */
const DROPPED_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
  // Artefacts Swift (≈ 400 Mo de .build) : rien à faire dans une copie, et la
  // section « App Swift » y est neutralisée par MEM0_OMP_SKIP_SWIFT_APP (voir
  // runEngine) pour ne pas y relancer une compilation.
  ".build": true,
  ".build-app": true,
  ".build-run": true,
  ".build-tests": true,
  ".build-ios": true,
  build: true,
};
const DROPPED_TESTS: Record<string, true> = {
  "check.test.ts": true,
  "release.test.ts": true,
  "release-simulation.test.ts": true,
  "bump-guard.test.ts": true,
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

/**
 * Le hook du remote nu : refuser TOUT push sur `refs/heads/main`, comme la
 * protection de branche du vrai dépôt (le refus s'écrit mot pour mot
 * `remote: error: GH006: Protected branch update failed for refs/heads/main.`).
 * C'est ce qui rend G-1 vérifiable : un moteur qui pousserait `main` échouerait
 * ici, et le test le verrait.
 */
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
 * Un faux `gh` : aucun réseau, mais l'appel et le corps EXACT de la note sont
 * conservés — et la fusion squash est RÉELLE : un commit neuf sur `main` du
 * remote, dont l'arbre est celui de la branche poussée et le parent le main
 * courant.
 */
function writeFakeGh(bin: string): void {
  const script = [
    "#!/usr/bin/env bash",
    "# Faux `gh` du harnais (voir test/release.test.ts) : journalise, simule la PR",
    "# (list/create/view/merge) et la création de release. `pr merge` fabrique un",
    "# vrai commit de fusion squash sur refs/heads/main du remote nu.",
    "set -uo pipefail",
    "journal_args=\"${*//$'\\n'/ }\"",
    'printf \'%s\\n\' "$journal_args" >> "$GH_JOURNAL"',
    'remote=(--git-dir="$GH_REMOTE")',
    'command="${1:-}"; sub="${2:-}"',
    'case "$command $sub" in',
    '  "pr list")',
    '    if [ -f "$GH_STATE/number" ]; then printf \'[{"number":%s}]\\n\' "$(cat "$GH_STATE/number")"; else printf \'[]\\n\'; fi',
    "    ;;",
    '  "pr create")',
    '    prev=""',
    '    for arg in "$@"; do',
    '      if [ "$prev" = "--head" ]; then printf \'%s\' "$arg" > "$GH_STATE/head"; fi',
    '      prev="$arg"',
    "    done",
    '    printf \'1\' > "$GH_STATE/number"',
    '    printf \'https://%s/%s/pull/1\\n\' "$GH_HOST" "$GH_REPO"',
    "    ;;",
    '  "pr view")',
    '    number="${3:-1}"',
    '    state="$(cat "$GH_STATE/merge-state" 2>/dev/null || printf \'CLEAN\')"',
    '    merged="$(cat "$GH_STATE/merge-sha" 2>/dev/null || printf \'\')"',
    '    printf \'{"number":%s,"state":"OPEN","mergeStateStatus":"%s","mergeCommit":{"oid":"%s"},"url":"https://%s/%s/pull/%s"}\\n\' \\',
    '      "$number" "$state" "$merged" "$GH_HOST" "$GH_REPO" "$number"',
    "    ;;",
    '  "pr merge")',
    '    subject=""; body=""; match=""; prev=""',
    '    for arg in "$@"; do',
    '      case "$prev" in',
    '        --subject) subject="$arg" ;;',
    '        --body) body="$arg" ;;',
    '        --match-head-commit) match="$arg" ;;',
    "      esac",
    '      prev="$arg"',
    "    done",
    '    head="$(cat "$GH_STATE/head")"',
    '    branch_sha="$(git "${remote[@]}" rev-parse "refs/heads/$head" 2>/dev/null || printf \'\')"',
    '    if [ -z "$branch_sha" ]; then printf \'branche %s introuvable sur le remote\\n\' "$head" >&2; exit 1; fi',
    '    if [ "$match" != "$branch_sha" ]; then printf \'la tete de %s a bouge\\n\' "$head" >&2; exit 1; fi',
    '    tree="$(git "${remote[@]}" rev-parse "refs/heads/$head^{tree}")"',
    '    parent="$(git "${remote[@]}" rev-parse refs/heads/main)"',
    "    export GIT_AUTHOR_NAME=bot GIT_AUTHOR_EMAIL=bot@example.test",
    "    export GIT_COMMITTER_NAME=bot GIT_COMMITTER_EMAIL=bot@example.test",
    '    export GIT_AUTHOR_DATE="$GH_MERGE_DATE" GIT_COMMITTER_DATE="$GH_MERGE_DATE"',
    '    merged="$(git "${remote[@]}" commit-tree "$tree" -p "$parent" -m "$subject" -m "$body")"',
    '    git "${remote[@]}" update-ref refs/heads/main "$merged"',
    '    printf \'%s\' "$merged" > "$GH_STATE/merge-sha"',
    '    printf \'merged %s\\n\' "$merged"',
    "    ;;",
    '  "release create")',
    '    tag="${3:-}"',
    '    notes=""; prev=""',
    '    for arg in "$@"; do',
    '      if [ "$prev" = "--notes-file" ]; then notes="$arg"; fi',
    '      prev="$arg"',
    "    done",
    '    if [ -n "$notes" ] && [ -n "$tag" ]; then cp "$notes" "$GH_JOURNAL.$tag"; fi',
    "    # `--verify-tag` : le tag doit DEJA exister sur le remote, sinon `gh` en",
    "    # creerait un depuis la branche par defaut.",
    '    if ! git "${remote[@]}" rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then',
    '      printf \'tag %s absent du remote (--verify-tag)\\n\' "$tag" >&2',
    "      exit 1",
    "    fi",
    '    printf \'https://%s/%s/releases/tag/%s\\n\' "$GH_HOST" "$GH_REPO" "$tag"',
    "    ;;",
    "  *)",
    '    printf \'sous-commande gh non simulee : %s %s\\n\' "$command" "$sub" >&2',
    "    exit 1",
    "    ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n");
  const file = path.join(bin, "gh");
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}

type Edit = { file: string; content?: string; append?: string };
type Step = { subject: string; body?: string; edits: Edit[] };

type Repo = {
  dir: string;
  remote: string;
  bin: string;
  state: string;
  journal: string;
  before: string;
  after: string;
  commits: Array<{ subject: string; sha: string }>;
  changelogBefore: string | null;
};

type Snapshot = {
  changelog: string | null;
  tags: string[];
  heads: string[];
  main: string;
  head: string;
  version: string;
  journal: string;
};

function changelogState(dir: string): string | null {
  const file = path.join(dir, "CHANGELOG.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function snapshot(repo: Repo): Snapshot {
  return {
    changelog: changelogState(repo.dir),
    tags: remoteTags(repo.remote),
    heads: remoteHeads(repo.remote),
    main: remoteGit(repo.remote, ["rev-parse", "main"]).trim(),
    head: git(["rev-parse", "HEAD"], repo.dir).trim(),
    version: versionIn(repo.dir, `${MEMORY.dir}/package.json`),
    journal: fs.readFileSync(repo.journal, "utf8"),
  };
}

/**
 * Un dépôt jetable prêt pour un scénario : copie de l'arbre, remote nu avec son
 * hook, faux `gh`, puis les commits du scénario. `tagCurrent` pose les tags des
 * versions COURANTES sur le commit de base : sans lui, le rattrapage a du travail.
 */
function makeRepo(kind: string, steps: Step[], options: { tagCurrent?: boolean } = {}): Repo {
  const dir = mktmp(`release-${kind}-`);
  copyRepo(dir);
  // Le scénario part de l'état « rien n'a jamais été publié » (celui de B-4) : le
  // journal d'une publication ANTÉRIEURE de l'arbre ne doit pas s'y inviter. Sans
  // ça, un run de release (qui lance `check.sh` après avoir écrit `CHANGELOG.md`)
  // ferait sauter les entrées déjà titrées, et les scénarios dépendraient de
  // l'état de publication du dépôt au lieu de leurs propres commits.
  fs.rmSync(path.join(dir, "CHANGELOG.md"), { force: true });
  const remote = path.join(mktmp(`release-${kind}-remote-`), "origin.git");
  const bin = mktmp(`release-${kind}-bin-`);
  const state = mktmp(`release-${kind}-state-`);
  const journal = path.join(mktmp(`release-${kind}-journal-`), "gh.log");
  git(["init", "-q", "--bare", remote], dir);
  writeFakeGh(bin);
  fs.writeFileSync(journal, "");

  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "chore: base du scénario"], dir);
  if (options.tagCurrent !== false) {
    for (const plugin of PLUGINS) {
      const tag = versionTag(plugin.name, versionIn(dir, `${plugin.dir}/package.json`));
      git(["tag", "-a", tag, "-m", tag], dir);
    }
  }
  git(["remote", "add", "origin", remote], dir);
  git(["push", "-q", "origin", "main", "--tags"], dir);

  const before = git(["rev-parse", "HEAD"], dir).trim();
  const commits: Array<{ subject: string; sha: string }> = [];
  for (const step of steps) {
    for (const edit of step.edits) {
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
  // pouvoir pousser `main`, mais le MOTEUR, lui, ne le pourra jamais.
  writePreReceive(remote);
  const after = git(["rev-parse", "HEAD"], dir).trim();
  return { dir, remote, bin, state, journal, before, after, commits, changelogBefore: changelogState(dir) };
}

/**
 * Le moteur, DANS la copie jetable, avec le faux `gh` en tête de PATH, la config
 * git qui interdit l'identité devinée, et le jeton dédié — sauf demande contraire.
 */
function runEngine(
  repo: Repo,
  options: {
    before?: string;
    after?: string;
    extra?: string[];
    ghToken?: string | null;
    releaseToken?: string | null;
  } = {},
): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: ENGINE_GIT_CONFIG,
    GH_JOURNAL: repo.journal,
    GH_STATE: repo.state,
    GH_REMOTE: repo.remote,
    GH_HOST: HOST,
    GH_REPO: REPO,
    GH_MERGE_DATE: MERGE_DATE,
    PATH: `${repo.bin}:${process.env.PATH ?? ""}`,
    // Le moteur lance `check.sh` sur la copie : la section « App Swift » y
    // compilerait pour de vrai (~ 40 s) sans rien prouver de la release, et la
    // section « App iOS » de même.
    MEM0_OMP_SKIP_SWIFT_APP: "1",
    MEM0_OMP_SKIP_IOS: "1",
  };
  delete env.GH_TOKEN;
  delete env.RELEASE_TOKEN;
  const ghToken = options.ghToken === undefined ? "jeton-de-test" : options.ghToken;
  const releaseToken = options.releaseToken === undefined ? "jeton-de-test" : options.releaseToken;
  if (ghToken !== null) env.GH_TOKEN = ghToken;
  if (releaseToken !== null) env.RELEASE_TOKEN = releaseToken;

  return spawnSync(
    "node",
    [
      "--experimental-strip-types",
      "scripts/release.ts",
      "--before",
      options.before ?? repo.before,
      "--after",
      options.after ?? repo.after,
      "--repo",
      REPO,
      ...(options.extra ?? []),
    ],
    { cwd: repo.dir, encoding: "utf8", env, timeout: 900_000 },
  );
}

/** Les appels reçus par le faux `gh`, avec le corps de note de chacun. */
function readCalls(journal: string): Array<{ args: string; tag: string; notes: string }> {
  return fs
    .readFileSync(journal, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((args) => {
      const tag = /^release create (\S+)/.exec(args)?.[1] ?? "";
      const notesFile = `${journal}.${tag}`;
      return { args, tag, notes: tag !== "" && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8") : "" };
    });
}

/** Les créations de release seulement : le journal porte aussi les appels de PR. */
function releaseCalls(journal: string) {
  return readCalls(journal).filter((call) => call.tag !== "");
}

function remoteTags(remote: string): string[] {
  return remoteGit(remote, ["tag", "-l"]).trim().split("\n").filter((tag) => tag !== "").sort();
}

function remoteHeads(remote: string): string[] {
  return remoteGit(remote, ["for-each-ref", "--format=%(refname)", "refs/heads"])
    .trim()
    .split("\n")
    .filter((ref) => ref !== "")
    .sort();
}

/** La date d'un commit telle que le moteur la calcule (G-3 : jamais l'horloge). */
function commitDate(repo: Repo, sha: string): string {
  return utcDate(git(["show", "-s", "--format=%aI", sha], repo.dir).trim());
}

function remoteSha(repo: Repo, ref: string): string {
  return remoteGit(repo.remote, ["rev-parse", `${ref}^{commit}`]).trim();
}

const PATCH_STEPS: Step[] = [
  {
    subject: "fix(memory): le rappel ne perd plus un souvenir sans score",
    edits: [{ file: `${MEMORY.dir}/state.ts`, append: "\n// scénario de test\n" }],
  },
];

const DOCS_STEPS: Step[] = [
  { subject: "docs: précise la section installation", edits: [{ file: "README.md", append: "\n<!-- scénario -->\n" }] },
];

const MAJOR_STEPS: Step[] = [
  {
    subject: "feat(req): les specs figées portent leur date",
    edits: [{ file: `${REQ.dir}/seeds.ts`, append: "\n// scénario\n" }],
  },
  {
    subject: "feat(memory)!: le brief change de format",
    body: "BREAKING CHANGE: le brief v3 n'est plus lu, relance /mem0-brief",
    edits: [{ file: `${MEMORY.dir}/brief.ts`, append: "\n// scénario\n" }],
  },
];

/**
 * Le rattrapage : trois versions de `memory` et une de `req` sans aucun tag. Les
 * deux dernières étapes réalignent les catalogues sur la tête, sinon `check.sh`
 * (lancé par le moteur APRÈS ses écritures) refuserait l'arbre.
 */
function buildBacklogSteps(): Step[] {
  const first = VERSIONS[MEMORY.name]?.patch ?? "0.0.1";
  const second = VERSIONS[MEMORY.name]?.minor ?? "0.1.0";
  const pkg = readJson<Record<string, unknown>>(ROOT, `${MEMORY.dir}/package.json`);
  const aligned = readJson<Catalog>(ROOT, CATALOGS[0]);
  for (const entry of aligned.plugins) {
    if (entry.name === MEMORY.name) entry.version = second;
  }
  aligned.metadata = {
    ...(aligned.metadata ?? {}),
    version: maxVersion([second, VERSIONS[REQ.name]?.entry ?? "0.0.0"]) ?? second,
  };
  const serialized = `${JSON.stringify(aligned, null, 2)}\n`;
  return [
    {
      subject: "chore(memory): prepare une version jamais publiee",
      edits: [{ file: `${MEMORY.dir}/package.json`, content: `${JSON.stringify({ ...pkg, version: first }, null, 2)}\n` }],
    },
    {
      subject: "chore(memory): prepare une seconde version jamais publiee",
      edits: [{ file: `${MEMORY.dir}/package.json`, content: `${JSON.stringify({ ...pkg, version: second }, null, 2)}\n` }],
    },
    { subject: "docs: aligne le catalogue", edits: [{ file: CATALOGS[0], content: serialized }] },
    { subject: "docs: aligne le catalogue claude", edits: [{ file: CATALOGS[1], content: serialized }] },
  ];
}

type Built = { repo: Repo; run: SpawnSyncReturns<string> };
type BacklogBuilt = Built & { dry: SpawnSyncReturns<string>; before: Snapshot; after: Snapshot };
type BlockedBuilt = {
  repo: Repo;
  first: SpawnSyncReturns<string>;
  /** L'état du remote après le run bloqué, avant la reprise. */
  blocked: Snapshot;
  second: SpawnSyncReturns<string>;
};
type NoTokenBuilt = { repo: Repo; run: SpawnSyncReturns<string>; before: Snapshot };

function buildSimple(kind: string, steps: Step[], options: { tagCurrent?: boolean } = {}): Built {
  const repo = makeRepo(kind, steps, options);
  return { repo, run: runEngine(repo) };
}

/** Le scénario de rattrapage : `--dry-run` d'abord (rien ne bouge), puis pour de vrai. */
function buildBacklog(kind: string): BacklogBuilt {
  const repo = makeRepo(kind, buildBacklogSteps(), { tagCurrent: false });
  const before = snapshot(repo);
  const dry = runEngine(repo, { extra: ["--dry-run"] });
  const after = snapshot(repo);
  return { repo, dry, before, after, run: runEngine(repo) };
}

/** Le scénario bloqué : le premier run échoue sur le statut requis, le second reprend. */
function buildBlocked(kind: string): BlockedBuilt {
  const repo = makeRepo(kind, PATCH_STEPS);
  fs.writeFileSync(path.join(repo.state, "merge-state"), "BLOCKED");
  const first = runEngine(repo, { extra: ["--merge-timeout", "1"] });
  const blocked = snapshot(repo);
  fs.writeFileSync(path.join(repo.state, "merge-state"), "CLEAN");
  return { repo, first, blocked, second: runEngine(repo) };
}

/** Le scénario sans jeton : `RELEASE_TOKEN` absent alors que `GH_TOKEN` est posé. */
function buildNoToken(kind: string): NoTokenBuilt {
  const repo = makeRepo(kind, PATCH_STEPS);
  const before = snapshot(repo);
  return { repo, run: runEngine(repo, { releaseToken: null }), before };
}

function buildTagged(kind: string): Built {
  const repo = makeRepo(kind, PATCH_STEPS);
  const tag = versionTag(MEMORY.name, VERSIONS[MEMORY.name]?.patch ?? "");
  git(["tag", "-a", tag, "-m", tag], repo.dir);
  git(["push", "-q", "origin", tag], repo.dir);
  return { repo, run: runEngine(repo) };
}

// Les scénarios sont construits au chargement du module, une seule fois : chaque
// test ne réclame que le sien, et les copies imbriquées (`MEM0_CHECK_DEPTH` ≠ 0)
// n'en construisent aucun — sinon elles se rappelleraient elles-mêmes.
type ScenarioSet = {
  patch: Built;
  docs: Built;
  major: Built;
  tagged: Built;
  backlog: BacklogBuilt;
  blocked: BlockedBuilt;
  noToken: NoTokenBuilt;
  /** Dépôt vierge pour les cas d'arguments de `--simulate` : aucun run de moteur. */
  argCases: Repo;
};

const SCENARIOS: ScenarioSet | null =
  DEPTH === 0
    ? {
        patch: buildSimple("patch", PATCH_STEPS),
        docs: buildSimple("docs", DOCS_STEPS),
        major: buildSimple("major", MAJOR_STEPS),
        tagged: buildTagged("tagged"),
        backlog: buildBacklog("backlog"),
        blocked: buildBlocked("blocked"),
        noToken: buildNoToken("token"),
        argCases: makeRepo("args", PATCH_STEPS),
      }
    : null;

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
// Le workflow : le jeton dédié et la garde d'entrée
// ---------------------------------------------------------------------------

/** Le bloc `run: |` d'une étape nommée, dé-indenté — exécutable tel quel. */
function workflowStepScript(yaml: string, name: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `étape « ${name} » absente de ${WORKFLOW}`);
  const runIndex = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  assert.notEqual(runIndex, -1, `étape « ${name} » sans bloc run`);
  const body: string[] = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return `${body.join("\n").trimEnd()}\n`;
}

test("release/AC-2 : la publication n'utilise que le jeton dédié, et reprend une PR existante", (t) => {
  const yaml = fs.readFileSync(path.join(ROOT, WORKFLOW), "utf8");

  // (1) Le workflow : une seule identité, et la garde AVANT le checkout.
  assert.ok(yaml.includes("token: ${{ secrets.RELEASE_TOKEN }}"), "le checkout porte le jeton dédié");
  assert.ok(yaml.includes("GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}"), "gh reçoit le jeton dédié");
  assert.ok(yaml.includes("RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}"));
  assert.ok(!yaml.includes("secrets.GITHUB_TOKEN"), "aucun repli sur le jeton du dépôt");
  assert.ok(yaml.includes("permissions:\n  contents: read"), "moindre privilège");
  assert.ok(yaml.includes("queue: max"), "un merge intermédiaire ne perd plus son run");
  assert.ok(yaml.includes("fetch-depth: 0"), "l'historique complet est nécessaire au plan");
  const guardIndex = yaml.indexOf("- name: Vérifier le jeton de release");
  const checkoutIndex = yaml.indexOf("uses: actions/checkout@v4");
  assert.ok(guardIndex !== -1 && guardIndex < checkoutIndex, "la garde précède le checkout");

  // (2) La garde, exécutée pour de vrai : sans jeton, le job s'arrête avec le
  // message que PUBLISHING.md § Jeton de release annonce mot pour mot.
  const script = workflowStepScript(yaml, "Vérifier le jeton de release");
  const without = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, RELEASE_TOKEN: "" },
  });
  assert.notEqual(without.status, 0, "le job doit échouer sans jeton");
  assert.ok(
    output(without).includes(
      "secret RELEASE_TOKEN absent — le job de release ne peut pas publier. Crée-le (PUBLISHING.md, § Jeton de release), puis relance cette exécution.",
    ),
    output(without),
  );
  const withToken = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, RELEASE_TOKEN: "jeton-de-test" },
  });
  assert.equal(withToken.status, 0, output(withToken));

  // (3) Une PR bloquée par les statuts requis n'est pas perdue : le run suivant
  // réutilise la MÊME PR (même branche) et fusionne dès qu'elle est fusionnable.
  const blocked = scenario(SCENARIOS?.blocked, t);
  if (blocked === null) return;
  const { repo, first, blocked: held, second } = blocked;
  assert.notEqual(first.status, 0, output(first));
  assert.ok(
    output(first).includes(
      `✗ PR #1 non fusionnable après 1 s (dernier état : BLOCKED) : https://${HOST}/${REPO}/pull/1`,
    ),
    output(first),
  );
  assert.equal(held.main, repo.after, "aucun commit avant la fusion");
  const baseTags = PLUGINS.map((plugin) => versionTag(plugin.name, VERSIONS[plugin.name]?.pkg ?? "")).sort();
  assert.deepEqual(held.tags, baseTags, "aucun tag nouveau : les tags viennent APRÈS la fusion");
  assert.ok(!held.tags.includes(versionTag(MEMORY.name, VERSIONS[MEMORY.name]?.patch ?? "")), "le bump n'est pas tagué");
  assert.ok(held.heads.includes(`refs/heads/release/${repo.after}`), "la branche de release est poussée");

  assert.equal(second.status, 0, output(second));
  assert.ok(output(second).includes(`· PR de release réutilisée : https://${HOST}/${REPO}/pull/1`), output(second));
  const calls = readCalls(repo.journal);
  assert.equal(calls.filter((call) => call.args.startsWith("pr create")).length, 1, "une seule PR ouverte");
  assert.ok(calls.some((call) => call.args.startsWith("pr merge")), "la fusion a lieu au second run");
  assert.deepEqual(
    remoteGit(repo.remote, ["log", "-1", "--format=%P", "main"]).trim().split(" "),
    [repo.after],
    "un seul parent : la fusion squash",
  );
  const target = versionTag(MEMORY.name, VERSIONS[MEMORY.name]?.patch ?? "");
  assert.equal(remoteSha(repo, `refs/tags/${target}`), remoteSha(repo, "main"), "le tag du bump pointe sur la fusion");
});

// ---------------------------------------------------------------------------
// Le bout en bout
// ---------------------------------------------------------------------------

test("release/AC-1 : le commit de release atteint main par une PR auto-mergée, sans push direct", (t) => {
  const built = scenario(SCENARIOS?.patch, t);
  if (built === null) return;
  const { repo, run } = built;
  assert.equal(run.status, 0, output(run));

  // Le remote refuse `refs/heads/main` : l'absence de GH006 dans la sortie prouve
  // que le moteur n'a jamais tenté d'y pousser (G-1).
  assert.ok(!output(run).includes("GH006"), output(run));
  assert.notEqual(remoteGit(repo.remote, ["rev-parse", "main"]).trim(), repo.after, "main a avancé");

  const target = VERSIONS[MEMORY.name]?.patch ?? "";
  assert.equal(
    remoteGit(repo.remote, ["log", "-1", "--format=%s", "main"]).trim(),
    `chore(release): ${MEMORY.name} ${target}`,
  );
  const message = remoteGit(repo.remote, ["log", "-1", "--format=%B", "main"]);
  assert.ok(message.includes(`Release-Event: ${repo.after}`), message);
  assert.ok(message.includes(`Released: ${MEMORY.name} ${target}`), message);
  assert.deepEqual(
    remoteGit(repo.remote, ["log", "-1", "--format=%P", "main"]).trim().split(" "),
    [repo.after],
    "un seul commit de plus sur main, dont le parent est main d'avant",
  );

  // La PR a été ouverte PUIS fusionnée, en squash, sur la tête poussée.
  const calls = readCalls(repo.journal);
  const created = calls.findIndex((call) => call.args.startsWith("pr create"));
  const merged = calls.findIndex((call) => call.args.startsWith("pr merge"));
  assert.ok(created !== -1 && merged !== -1 && created < merged, `journal : ${repo.journal}`);
  assert.ok(calls[merged]?.args.includes(" --squash"), calls[merged]?.args ?? "");
  assert.ok(calls[merged]?.args.includes("--match-head-commit"), calls[merged]?.args ?? "");
  assert.ok(!calls.some((call) => call.args.includes("--auto")), "`--auto` est proscrit (allow_auto_merge = false)");
  assert.ok(!output(run).includes("non supprimée"), "la branche de release est nettoyée");
  assert.ok(
    remoteHeads(repo.remote).every((head) => !head.startsWith("refs/heads/release/")),
    remoteHeads(repo.remote).join(", "),
  );

  // G-2 : l'identité du commit ET du tag annoté est posée par la commande — un
  // `git tag -a` sans identité échoue sur un runner sans config git (mesuré le
  // 2026-09-24), et le tag doit porter le bot, pas le compte du runner.
  assert.equal(
    git(["log", "-1", "--format=%an <%ae>", `release/${repo.after}`], repo.dir).trim(),
    "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
  );
  const tagRef = `refs/tags/${versionTag(MEMORY.name, target)}`;
  assert.equal(remoteGit(repo.remote, ["for-each-ref", "--format=%(taggername)", tagRef]).trim(), "github-actions[bot]");
  assert.ok(
    remoteGit(repo.remote, ["for-each-ref", "--format=%(taggeremail)", tagRef]).includes("41898282+github-actions[bot]"),
    remoteGit(repo.remote, ["for-each-ref", "--format=%(taggeremail)", tagRef]),
  );
  assert.equal(
    remoteGit(repo.remote, ["for-each-ref", "--format=%(taggerdate:iso-strict)", tagRef]).trim(),
    git(["show", "-s", "--format=%aI", repo.after], repo.dir).trim(),
    "la date du tagueur est celle de l'événement (G-3 : jamais l'horloge)",
  );
});

test("release/AC-3 : la version publiée est exactement celle calculée par le job", (t) => {
  const built = scenario(SCENARIOS?.patch, t);
  if (built === null) return;
  const { repo, run } = built;
  const memory = VERSIONS[MEMORY.name];
  const req = VERSIONS[REQ.name];
  const target = memory?.patch ?? "";
  assert.equal(run.status, 0, output(run));

  // Le niveau vient des commits conventionnels (`fix` ⇒ patch), le plugin non
  // touché ne bouge pas, et un seul bump est calculé : aucun double bump.
  assert.ok(run.stdout.includes(`✓ ${MEMORY.name} : patch ${memory?.pkg} → ${target} (1 commit(s))`), output(run));
  assert.ok(run.stdout.includes(`· ${REQ.name} : inchangé (aucun fichier touché)`), output(run));
  assert.ok(run.stdout.includes("→ 1 version(s) à publier : 0 rattrapage, 1 bump"), output(run));

  // La PR ne portait aucun fichier de version : c'est le job qui les a écrits.
  assert.equal(versionIn(repo.dir, `${MEMORY.dir}/package.json`), target);
  assert.equal(versionIn(repo.dir, `${REQ.dir}/package.json`), req?.pkg, "le plugin non touché ne bouge pas");
  for (const catalog of CATALOGS) {
    assert.equal(entryVersionOf(repo.dir, catalog, MEMORY.name), target, catalog);
    assert.equal(entryVersionOf(repo.dir, catalog, REQ.name), req?.entry, catalog);
  }
  const metadata = maxVersion([target, req?.entry ?? "0.0.0"]);
  assert.equal(readJson<Catalog>(repo.dir, CATALOGS[0]).metadata?.version, metadata, "metadata.version nomme une version publiée");
  assert.equal(remoteGit(repo.remote, ["show", `main:${MEMORY.dir}/package.json`]).includes(target), true);
});

test("release/AC-4 : chaque publication écrit une entrée datée dans CHANGELOG.md, sur main", (t) => {
  const built = scenario(SCENARIOS?.patch, t);
  if (built === null) return;
  const { repo, run } = built;
  assert.equal(run.status, 0, output(run));

  const target = VERSIONS[MEMORY.name]?.patch ?? "";
  const [commit] = repo.commits;
  assert.ok(commit, "le scénario porte un commit de feature");
  const heading = `## ${MEMORY.name} ${target} — ${commitDate(repo, repo.after)}`;

  const changelog = fs.readFileSync(path.join(repo.dir, "CHANGELOG.md"), "utf8");
  assert.ok(changelog.startsWith("# Journal des versions\n"), changelog);
  assert.ok(changelog.includes(heading), changelog);
  assert.ok(changelog.includes(`- ${commit.subject} (${commit.sha})`), changelog);

  // Committé par le job : le fichier est dans main, à la racine du dépôt.
  assert.ok(remoteGit(repo.remote, ["show", "main:CHANGELOG.md"]).includes(heading));

  // La release GitHub porte le titre, le tag déjà posé et les changements.
  const call = releaseCalls(repo.journal).find((entry) => entry.tag === versionTag(MEMORY.name, target));
  assert.ok(call, `aucune release pour ${target} : ${repo.journal}`);
  assert.ok(
    call.args.startsWith(`release create ${versionTag(MEMORY.name, target)} --verify-tag --title ${MEMORY.name} ${target}`),
    call.args,
  );
  assert.ok(call.notes.includes(`## ${MEMORY.name} ${target}`), call.notes);
  assert.ok(call.notes.includes(`Changements depuis ${versionTag(MEMORY.name, VERSIONS[MEMORY.name]?.pkg ?? "")} :`), call.notes);
  assert.ok(call.notes.includes(`- ${commit.subject} (${commit.sha})`), call.notes);
});

test("notes de release : commandes d'installation, mise à jour, et rupture d'un bump majeur", (t) => {
  const built = scenario(SCENARIOS?.major, t);
  if (built === null) return;
  const { repo, run } = built;
  assert.equal(run.status, 0, output(run));

  const calls = releaseCalls(repo.journal);
  assert.equal(calls.length, 2, `une release par plugin bumpé : ${repo.journal}`);
  for (const [plugin, version] of [
    [MEMORY.name, VERSIONS[MEMORY.name]?.major],
    [REQ.name, VERSIONS[REQ.name]?.minor],
  ]) {
    const call = calls.find((entry) => entry.tag === `${plugin}-v${version}`);
    assert.ok(call, `release absente pour ${plugin} ${version}`);
    assert.ok(call.notes.includes(`/marketplace add ${REPO}`), call.notes);
    assert.ok(call.notes.includes(`/marketplace install ${plugin}@mem0-omp`), call.notes);
    assert.ok(call.notes.includes("/marketplace update mem0-omp"), call.notes);
    assert.ok(call.notes.includes(`/marketplace upgrade ${plugin}@mem0-omp`), call.notes);
  }

  const major = calls.find((entry) => entry.tag === `${MEMORY.name}-v${VERSIONS[MEMORY.name]?.major}`);
  const minor = calls.find((entry) => entry.tag === `${REQ.name}-v${VERSIONS[REQ.name]?.minor}`);
  assert.ok(major && minor);
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

  // Deux entrées de journal, dans l'ordre du catalogue (le plus récent en tête).
  const changelog = remoteGit(repo.remote, ["show", "main:CHANGELOG.md"]);
  assert.ok(
    changelog.indexOf(`${MEMORY.name} ${VERSIONS[MEMORY.name]?.major}`) <
      changelog.indexOf(`${REQ.name} ${VERSIONS[REQ.name]?.minor}`),
    changelog,
  );
});

test("release/AC-5 : le rattrapage publie chaque version jamais publiée — tag, release, journal", (t) => {
  const built = scenario(SCENARIOS?.backlog, t);
  if (built === null) return;
  const { repo, run } = built;
  assert.equal(run.status, 0, output(run));

  // Aucun tag au départ : les trois versions de `memory` ET celle de `req` sont
  // rattrapées, chacune taguée sur son commit d'apparition, et aucune n'est bumpée.
  const base = repo.before;
  const [firstStep, secondStep] = repo.commits;
  assert.ok(firstStep && secondStep, "le scénario porte ses commits d'historique");
  const expected: Array<{ name: string; version: string; commit: string }> = [
    { name: MEMORY.name, version: VERSIONS[MEMORY.name]?.pkg ?? "", commit: base },
    { name: MEMORY.name, version: VERSIONS[MEMORY.name]?.patch ?? "", commit: firstStep.sha },
    { name: MEMORY.name, version: VERSIONS[MEMORY.name]?.minor ?? "", commit: secondStep.sha },
    { name: REQ.name, version: VERSIONS[REQ.name]?.pkg ?? "", commit: base },
  ];
  const tags = expected.map((entry) => versionTag(entry.name, entry.version));
  assert.deepEqual(remoteTags(repo.remote), [...tags].sort(), "un tag par version jamais publiée");
  assert.ok(run.stdout.includes(`⟲ ${MEMORY.name} : rattrapage ${expected[0]?.version}`), output(run));
  assert.ok(run.stdout.includes("→ 4 version(s) à publier : 4 rattrapage, 0 bump"), output(run));
  assert.ok(run.stdout.includes("· merge déjà publié") === false, "l'événement n'était pas publié");

  const calls = releaseCalls(repo.journal);
  assert.equal(calls.length, expected.length, `une release par version : ${repo.journal}`);
  for (const entry of expected) {
    const tag = versionTag(entry.name, entry.version);
    const call = calls.find((entryCall) => entryCall.tag === tag);
    assert.ok(call, `release absente pour ${tag}`);
    assert.ok(call.args.includes("--verify-tag"), call.args);
    assert.equal(remoteSha(repo, `refs/tags/${tag}`), remoteGit(repo.remote, ["rev-parse", entry.commit]).trim(), tag);
  }
  assert.equal(remoteGit(repo.remote, ["log", "-1", "--format=%s", "main"]).trim(), "chore(release): journal des versions");

  // Une entrée de journal par version : les bumps d'abord (aucun), puis par plugin
  // le rattrapage de la plus récente à la plus ancienne.
  const changelog = remoteGit(repo.remote, ["show", "main:CHANGELOG.md"]);
  const journalOrder = [
    expected[2] as (typeof expected)[number],
    expected[1] as (typeof expected)[number],
    expected[0] as (typeof expected)[number],
    expected[3] as (typeof expected)[number],
  ];
  let cursor = -1;
  for (const entry of journalOrder) {
    const heading = `## ${entry.name} ${entry.version} — ${commitDate(repo, entry.commit)}`;
    const at = changelog.indexOf(heading);
    assert.ok(at !== -1, `${heading} absente de\n${changelog}`);
    assert.ok(at > cursor, `ordre du journal : ${heading}`);
    cursor = at;
  }
});

test("release/AC-7 : un rejeu du même événement ne crée ni commit, ni tag, ni release", (t) => {
  const built = scenario(SCENARIOS?.patch, t);
  if (built === null) return;
  const { repo, run } = built;
  assert.equal(run.status, 0, output(run));
  const published = remoteGit(repo.remote, ["rev-parse", "main"]).trim();
  const tags = remoteTags(repo.remote);
  const calls = readCalls(repo.journal).length;

  // Un run ultérieur repart d'un checkout frais : il relit origin/main, où le
  // commit de fusion porte le trailer de l'événement.
  git(["fetch", "--force", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], repo.dir);
  const replay = runEngine(repo);
  assert.equal(replay.status, 0, output(replay));
  assert.ok(replay.stdout.includes("· merge déjà publié"), output(replay));
  assert.ok(!replay.stdout.includes("✓"), `aucun bump rejoué :\n${output(replay)}`);
  assert.equal(remoteGit(repo.remote, ["rev-parse", "main"]).trim(), published, "main inchangée");
  assert.deepEqual(remoteTags(repo.remote), tags, "aucun tag nouveau");
  assert.equal(readCalls(repo.journal).length, calls, "aucun nouvel appel à gh");

  // Le tag de la version cible déjà posé retire le plugin du plan (garde 2).
  const tagged = scenario(SCENARIOS?.tagged, t);
  if (tagged === null) return;
  assert.equal(tagged.run.status, 0, output(tagged.run));
  const target = versionTag(MEMORY.name, VERSIONS[MEMORY.name]?.patch ?? "");
  assert.ok(tagged.run.stdout.includes(`· ${MEMORY.name} : déjà publié (tag ${target})`), output(tagged.run));
  assert.ok(!tagged.run.stdout.includes("✓"), `plan vide attendu :\n${output(tagged.run)}`);
  assert.equal(fs.readFileSync(tagged.repo.journal, "utf8").trim(), "", "aucune release");
  assert.equal(remoteGit(tagged.repo.remote, ["rev-parse", "main"]).trim(), tagged.repo.after, "aucun commit");
  assert.equal(changelogState(tagged.repo.dir), tagged.repo.changelogBefore, "journal inchangé");
});

test("release/AC-8 : le plan complet s'imprime sans rien écrire (--dry-run)", (t) => {
  const built = scenario(SCENARIOS?.backlog, t);
  if (built === null) return;
  const { repo, dry, before, after } = built;
  assert.equal(dry.status, 0, output(dry));

  // Le plan annonce toutes les versions historiques : c'est la preuve exigible
  // avant la fusion, sans le moindre tag ni la moindre release.
  assert.ok(output(dry).includes(`⟲ ${MEMORY.name} : rattrapage ${VERSIONS[MEMORY.name]?.pkg}`), output(dry));
  assert.ok(output(dry).includes(`⟲ ${MEMORY.name} : rattrapage ${VERSIONS[MEMORY.name]?.minor}`), output(dry));
  assert.ok(output(dry).includes("→ 4 version(s) à publier : 4 rattrapage, 0 bump"), output(dry));
  assert.ok(!output(dry).includes("✗"), output(dry));

  assert.deepEqual(after, before, "aucune écriture : journal, versions, branche et tags inchangés");
  assert.equal(after.version, before.version, "aucun bump local");
  assert.equal(after.head, repo.after, "aucun commit local : la branche de release n'est pas créée");
  assert.deepEqual(after.heads, ["refs/heads/main"], "aucune branche de release");
  assert.deepEqual(after.tags, [], "aucun tag");
});

test("plan vide : un merge sans fichier de plugin ne publie rien", (t) => {
  const built = scenario(SCENARIOS?.docs, t);
  if (built === null) return;
  const { repo, run } = built;
  assert.equal(run.status, 0, output(run));
  assert.ok(run.stdout.includes(`· ${MEMORY.name} : inchangé (aucun fichier touché)`), output(run));
  assert.ok(run.stdout.includes(`· ${REQ.name} : inchangé (aucun fichier touché)`), output(run));
  assert.equal(fs.readFileSync(repo.journal, "utf8").trim(), "", "aucun appel à gh");
  assert.equal(remoteGit(repo.remote, ["rev-parse", "main"]).trim(), repo.after, "aucun commit de release");
  assert.deepEqual(
    remoteTags(repo.remote),
    PLUGINS.map((plugin) => versionTag(plugin.name, VERSIONS[plugin.name]?.pkg ?? "")).sort(),
  );
  assert.equal(changelogState(repo.dir), repo.changelogBefore, "journal inchangé");
});

test("release/AC-9 : sans RELEASE_TOKEN, le moteur s'arrête avant toute écriture", (t) => {
  const built = scenario(SCENARIOS?.noToken, t);
  if (built === null) return;
  const { repo, run, before } = built;
  assert.notEqual(run.status, 0, output(run));
  assert.ok(
    output(run).includes(
      "✗ RELEASE_TOKEN absent — le job de release ne peut pas publier (PUBLISHING.md, § Jeton de release)",
    ),
    output(run),
  );
  // `GH_TOKEN` était posé : il ne remplace pas le jeton dédié, et rien n'est écrit.
  assert.equal(changelogState(repo.dir), before.changelog, "aucune écriture de journal");
  assert.equal(versionIn(repo.dir, `${MEMORY.dir}/package.json`), before.version, "aucun bump local");
  assert.equal(fs.readFileSync(repo.journal, "utf8"), "", "aucun appel à gh");
  assert.deepEqual(remoteHeads(repo.remote), before.heads, "aucune branche poussée");
  assert.deepEqual(remoteTags(repo.remote), before.tags, "aucun tag");
  assert.equal(remoteGit(repo.remote, ["rev-parse", "main"]).trim(), repo.after, "aucun commit");
});

test("release/S-1 : `--simulate` refuse `--dry-run` et nomme une `--main` fautive", (t) => {
  const repo = scenario(SCENARIOS?.argCases, t);
  if (repo === null) return;

  // (1) `--simulate` écrit : il est incompatible avec `--dry-run`, qui n'écrit rien.
  const conflict = runEngine(repo, { extra: ["--simulate", "--dry-run"] });
  assert.equal(conflict.status, 1, output(conflict));
  assert.ok(
    output(conflict).includes("✗ --simulate et --dry-run sont incompatibles (--dry-run n'écrit rien)"),
    output(conflict),
  );

  // (2) `--main` désigne la référence qui joue le rôle de `main` dans le plan :
  // une référence inconnue échoue en nommant la commande git fautive.
  const unknown = runEngine(repo, { extra: ["--simulate", "--main", "refs/inconnue"] });
  assert.equal(unknown.status, 1, output(unknown));
  assert.match(output(unknown), /✗ git (log|show)[^:]*: .*refs\/inconnue/, output(unknown));

  // (3) Aucune des deux erreurs n'a écrit, poussé, tagué ni appelé `gh`.
  assert.equal(fs.readFileSync(repo.journal, "utf8"), "", "aucun appel à gh");
  assert.equal(remoteGit(repo.remote, ["rev-parse", "main"]).trim(), repo.after, "main inchangée");
  assert.deepEqual(remoteHeads(repo.remote), ["refs/heads/main"], "aucune branche poussée");
  assert.equal(changelogState(repo.dir), repo.changelogBefore, "aucune écriture locale");
});

test("le remote du harnais refuse tout push sur refs/heads/main (rôle GH006)", () => {
  const dir = mktmp("release-hook-");
  const remote = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  git(["init", "-q", "--bare", remote], dir);
  writePreReceive(remote);
  git(["init", "-q", "-b", "main", "work"], dir);
  fs.writeFileSync(path.join(work, "README.md"), "amorçage\n");
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", "chore: amorçage"], work);
  git(["remote", "add", "origin", remote], work);

  const refused = spawnSync("git", ["push", "origin", "main"], { cwd: work, env: GIT_ENV, encoding: "utf8" });
  assert.notEqual(refused.status, 0, "un push sur main doit être refusé");
  assert.ok(
    output(refused).includes("GH006: Protected branch update failed for refs/heads/main."),
    output(refused),
  );
  assert.deepEqual(
    remoteGit(remote, ["for-each-ref", "--format=%(refname)", "refs/heads"]).trim(),
    "",
    "main n'a pas bougé",
  );
});
