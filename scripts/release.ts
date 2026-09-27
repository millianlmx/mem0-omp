#!/usr/bin/env node
// Moteur de release (S-1/S-4/S-5) : à la fusion d'une PR sur `main`, décide du
// bump de chaque plugin touché d'après les commits conventionnels, rattrape les
// versions jamais publiées, écrit les versions et `CHANGELOG.md`, puis publie
// par une PR de bot auto-mergée : branche `release/<after>` → PR → attente des
// statuts requis → fusion squash → tags → releases GitHub. Le tout idempotent.
//
// Lancé par `.github/workflows/release.yml` :
//   node --experimental-strip-types scripts/release.ts --before <sha> --after <sha>
// et utilisable à la main avec `--dry-run` (calcule et imprime, n'écrit rien).
//
// Lancé par `.github/workflows/release-simulation.yml` (S-1) :
//   node --experimental-strip-types scripts/release.ts --simulate --main HEAD \
//     --before <sha> --after <sha>
// `--simulate` écrit sur SON arbre (l'arbre de la PR simulée, dans une copie
// jetable — scripts/release-simulation.sh) puis prouve la release avec
// `check.sh` ; il ne committe, ne pousse, ne tague et n'ouvre jamais de PR. Le
// verdict est celui de la release ENTIÈRE : un plan inexploitable sort avant
// `check.sh`, un `check.sh` rouge est nommé comme tel. `--main` désigne la
// référence qui joue le rôle de `main` dans le plan — elle n'a aucun effet sur
// la publication, qui reste sur `origin/main`.
//
// Le fichier est importable : les fonctions pures (analyse des commits, plan,
// historique des versions, bump semver, rendu du changelog et du corps de
// release) sont testées sans réseau ni git par test/release.test.ts. Rien ne
// s'exécute à l'import.
//
// PIÈGES MESURÉS (2026-09-24 → 2026-09-27, git 2.5x, gh 2.x) :
//  * `git log --grep` SANS pathspec : avec `-- .`, le commit de release (vide)
//    est exclu et la garde d'idempotence ne trouve jamais rien ;
//  * RIEN ne pousse `refs/heads/main` : la protection de branche exige deux
//    statuts qu'un commit neuf n'a pas encore, donc un push direct rend
//    `remote: error: GH006: Protected branch update failed for refs/heads/main.`
//    Le seul chemin vers main est la fusion de la PR de release (G-1) ;
//  * `git tag -a` en a besoin AUSSI : l'identité doit être posée sur le tag
//    annoté autant que sur le commit (sinon `empty ident name` sur ubuntu) ;
//  * `gh pr merge --auto` est proscrit : le réglage `allow_auto_merge` du dépôt
//    vaut `false`, la fusion doit être faite explicitement ;
//  * `gh release create --verify-tag` : sans lui, `gh` crée le tag depuis la
//    branche par défaut ; le tag doit donc être poussé AVANT ;
//  * `GITHUB_TOKEN` ne peut pas tenir ce rôle : les événements qu'il crée ne
//    déclenchent aucun run, donc la PR de release n'aurait jamais ses statuts
//    requis et resterait « Expected » pour toujours ⇒ jeton dédié ;
//  * le format de `git log --name-only` est ambigu si on parse naïvement (le
//    corps peut contenir des lignes vides) : d'où le terminateur `%x1d` posé
//    dans le format, qui sépare le corps de la liste de fichiers.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type Level = "major" | "minor" | "patch";

/** Un commit de la plage, tel que l'analyse le rend (fichiers compris). */
export type Commit = { sha: string; subject: string; body: string; files: string[] };

/** Un changement tel qu'il apparaît dans le changelog et la note de release. */
export type Change = { sha: string; subject: string; level: Level | null; breaking: string | null };

/** Une version d'un plugin, telle qu'elle apparaît dans l'historique de `main`. */
export type VersionEntry = { sha: string; version: string; date: string };

/**
 * Une version à publier : un bump décidé par ce job, ou un rattrapage d'une
 * version historique jamais publiée (B-4). Les deux finissent en tag + release.
 */
export type Release = {
  kind: "bump" | "rattrapage";
  name: string;
  dir: string;
  /** Version précédente, `null` pour la première version d'un plugin. */
  from: string | null;
  version: string;
  tag: string;
  /** Commit que portera le tag : celui de la fusion pour un bump. */
  commit: string | null;
  /** Date `AAAA-MM-JJ` (UTC) — du commit d'apparition, ou de l'événement (G-3). */
  date: string;
  level: Level;
  changes: Change[];
  breaking: Change[];
  previousTag: string | null;
};

/** L'historique d'un plugin, plus les changements attendus pour chaque version. */
export type PluginHistory = {
  name: string;
  dir: string;
  /** Première apparition de chaque version, ordre chronologique (la dernière est courante). */
  history: VersionEntry[];
  /** `ranges[i]` : changements qui ont mené à `history[i]` (même index). */
  ranges: Change[][];
  /** Changements depuis la version courante jusqu'à `origin/main` (le bump). */
  sinceCurrent: Change[];
};

export type Plan = {
  /** Toutes les versions à publier, dans l'ordre des tags (S-1). */
  releases: Release[];
  /** Ordre d'insertion dans `CHANGELOG.md`, la plus récente d'abord (S-4). */
  journal: Release[];
  /** Plugins sans rien à publier (`· <plugin> : inchangé`). */
  unchanged: string[];
  /** Plugins dont la version cible est déjà taguée (garde 2 de S-5). */
  alreadyPublished: Array<{ name: string; tag: string }>;
};

const LEVELS: Record<Level, number> = { patch: 1, minor: 2, major: 3 };

/** Sujet conventionnel : `type(scope)!: …` — le `!` porte la rupture (CC §13). */
const SUBJECT = /^([A-Za-z]+)(\([^)]*\))?(!)?:/;

/**
 * Dernier paragraphe du corps : c'est là que vivent les footers (CC §8-10), donc
 * une ligne `BREAKING CHANGE:` au milieu du corps n'est pas un footer.
 */
function footerBlock(body: string): string {
  const blocks = body.trim().split(/\n[ \t]*\n/);
  return blocks.length === 0 ? "" : blocks[blocks.length - 1] ?? "";
}

/** Texte du footer de rupture, aplati sur une ligne ; null si absent. */
export function breakingText(body: string): string | null {
  const block = footerBlock(body);
  // Le texte court jusqu'à la fin du paragraphe de footers, pas jusqu'à la fin
  // de la ligne : un footer multi-lignes se lit d'un bloc, puis s'aplatit.
  const marker = /^BREAKING[ -]CHANGE(?::|\s+#)[ \t]*/m.exec(block);
  if (!marker) return null;
  return block.slice(marker.index + marker[0].length).replace(/\s+/g, " ").trim();
}

/**
 * Niveau d'un commit : `major` si `!` avant le `:` ou footer de rupture, sinon
 * `minor` pour `feat`, `patch` pour `fix`, et **rien** pour tout le reste
 * (docs, chore, ci, refactor, perf, test, build, style, sujet non conventionnel).
 */
export function levelOf(subject: string, body: string): Level | null {
  const match = SUBJECT.exec(subject);
  if (!match) return null;
  if (match[3] === "!") return "major";
  if (breakingText(body) !== null) return "major";
  const type = (match[1] ?? "").toLowerCase();
  if (type === "feat") return "minor";
  if (type === "fix") return "patch";
  return null;
}

export function maxLevel(levels: Level[]): Level {
  return levels.reduce<Level>((best, level) => (LEVELS[level] > LEVELS[best] ? level : best), "patch");
}

/** Bump semver strict : `major` remet les deux suivants à 0, `minor` le dernier. */
export function bumpVersion(version: string, level: Level): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) throw new Error(`version non semver : ${version}`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split(".").map((n) => Number(n));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    const [left, right] = [x[i] ?? 0, y[i] ?? 0];
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** La plus grande version (comparaison semver), ou null sur une liste vide. */
export function maxVersion(versions: string[]): string | null {
  return versions.reduce<string | null>(
    (best, version) => (best === null || compareVersions(version, best) > 0 ? version : best),
    null,
  );
}

/** `AAAA-MM-JJ` en UTC depuis une date ISO 8601 : les dates viennent du git, jamais de l'horloge (G-3). */
export function utcDate(iso: string): string {
  const parsed = new Date(iso.trim());
  if (Number.isNaN(parsed.getTime())) throw new Error(`date illisible : ${iso}`);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Analyse d'un `git log --no-merges --name-only
 * --format='%x1e%H%x1f%s%x1f%b%x1d' <plage>`.
 *
 * `%x1d` est indispensable : sans lui, la liste de fichiers suivrait le corps
 * sans séparateur non ambigu (un corps peut contenir des lignes vides).
 */
export function parseCommits(raw: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of raw.split("\u001e")) {
    if (record.trim() === "") continue;
    const [sha = "", subject = "", rest = ""] = record.split("\u001f");
    const [body = "", listing = ""] = rest.split("\u001d");
    const files = listing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    commits.push({ sha: sha.trim(), subject: subject.trim(), body: body.trim(), files });
  }
  return commits;
}

/** Les commits qui touchent au moins un fichier du plugin (tout le sous-dossier). */
export function commitsTouching(commits: Commit[], dir: string): Commit[] {
  const prefix = `${dir}/`;
  return commits.filter((commit) => commit.files.some((file) => file.startsWith(prefix)));
}

/** Un commit tel qu'il apparaît dans le changelog et la note (sujet sur une ligne). */
function asChange(commit: Commit): Change {
  return {
    sha: commit.sha.slice(0, 7),
    subject: commit.subject.split("\n")[0]?.trim() ?? "",
    level: levelOf(commit.subject, commit.body),
    breaking: breakingText(commit.body),
  };
}

/** Les changements d'un plugin dans une liste de commits, du plus récent au plus ancien. */
export function changesBetween(commits: Commit[], dir: string): Change[] {
  return commitsTouching(commits, dir).map(asChange);
}

/**
 * Historique d'un plugin : la PREMIÈRE apparition de chaque version, dans
 * l'ordre chronologique des commits — donc pas l'ordre semver (`0.1.0` peut
 * apparaître après `2.2.0`, cf. la régression de version du README).
 */
export function historyOf(rows: VersionEntry[]): VersionEntry[] {
  const seen = new Set<string>();
  const history: VersionEntry[] = [];
  for (const row of rows) {
    if (row.version === "" || seen.has(row.version)) continue;
    seen.add(row.version);
    history.push(row);
  }
  return history;
}

/** Le tag d'une version : `<plugin>-v<version>`. */
export function versionTag(name: string, version: string): string {
  return `${name}-v${version}`;
}

/** Les versions de `history` dont le tag n'existe pas encore sur le remote (S-4). */
export function backlogOf(
  name: string,
  history: VersionEntry[],
  existingTags: ReadonlySet<string>,
): VersionEntry[] {
  return history.filter((entry) => !existingTags.has(versionTag(name, entry.version)));
}

/**
 * Plan complet :
 *  - **rattrapage** : chaque version d'historique dont le tag manque sur le
 *    remote obtient une release (B-4) ;
 *  - **bump** : la version suivante de chaque plugin touché depuis l'apparition
 *    de sa version courante — donc jamais rejoué ni perdu (convergence, S-5).
 *
 * `published` (trailer de l'événement, garde 1) retire le bump du plan sans
 * toucher au rattrapage : des tags manquants restent publiables.
 */
export function planOf(
  plugins: PluginHistory[],
  existingTags: ReadonlySet<string>,
  eventDate: string,
  published: boolean,
): Plan {
  const releases: Release[] = [];
  const journalBumps: Release[] = [];
  const journalBackfills: Release[] = [];
  const unchanged: string[] = [];
  const alreadyPublished: Array<{ name: string; tag: string }> = [];

  for (const plugin of plugins) {
    // Rattrapage : une entrée par version sans tag distant (garde 3 de S-5).
    const backfills: Release[] = [];
    for (const entry of backlogOf(plugin.name, plugin.history, existingTags)) {
      const index = plugin.history.indexOf(entry);
      const previous = plugin.history[index - 1];
      const changes = plugin.ranges[index] ?? [];
      backfills.push({
        kind: "rattrapage",
        name: plugin.name,
        dir: plugin.dir,
        from: previous?.version ?? null,
        version: entry.version,
        tag: versionTag(plugin.name, entry.version),
        commit: entry.sha,
        date: entry.date,
        level: maxLevel(
          changes.map((change) => change.level).filter((level): level is Level => level !== null),
        ),
        changes,
        breaking: changes.filter((change) => change.level === "major"),
        previousTag: previous === undefined ? null : versionTag(plugin.name, previous.version),
      });
    }
    releases.push(...backfills);
    // Journal : le plus récent d'abord, donc le rattrapage à l'envers.
    journalBackfills.push(...[...backfills].reverse());

    const current = plugin.history[plugin.history.length - 1];
    if (current === undefined) {
      unchanged.push(plugin.name);
      continue;
    }
    // Garde 1 : l'événement est déjà publié, son bump aussi — on ne le rejoue pas.
    if (published) continue;
    const levels = plugin.sinceCurrent
      .map((change) => change.level)
      .filter((level): level is Level => level !== null);
    if (levels.length === 0) {
      unchanged.push(plugin.name);
      continue;
    }
    const level = maxLevel(levels);
    const tag = versionTag(plugin.name, bumpVersion(current.version, level));
    // Garde 2 : le tag de la version CIBLE existe déjà — le bump est déjà sorti.
    if (existingTags.has(tag)) {
      alreadyPublished.push({ name: plugin.name, tag });
      continue;
    }
    const bump: Release = {
      kind: "bump",
      name: plugin.name,
      dir: plugin.dir,
      from: current.version,
      version: bumpVersion(current.version, level),
      tag,
      // Le commit de fusion n'est connu qu'après la fusion : il est posé là-bas.
      commit: null,
      date: eventDate,
      level,
      changes: plugin.sinceCurrent,
      breaking: plugin.sinceCurrent.filter((change) => change.level === "major"),
      previousTag: versionTag(plugin.name, current.version),
    };
    releases.push(bump);
    journalBumps.push(bump);
  }

  return {
    releases,
    journal: [...journalBumps, ...journalBackfills],
    unchanged,
    alreadyPublished,
  };
}

/** Entrée de CHANGELOG : titre daté (UTC) puis un item par commit. */
export function renderChangelogEntry(release: Release): string {
  const items = release.changes.map((change) => `- ${change.subject} (${change.sha})`);
  return [`## ${release.name} ${release.version} — ${release.date}`, "", ...items].join("\n");
}

/**
 * Clé d'idempotence d'une entrée : son titre sans la date. Un run qui republie
 * des tags manquants ne doit pas dupliquer une entrée déjà écrite (S-4).
 */
function changelogKey(entry: string): string {
  const title = entry.split("\n")[0] ?? "";
  const dash = title.indexOf(" —");
  return dash === -1 ? title : title.slice(0, dash);
}

/**
 * Insère les entrées juste après le titre, la plus récente d'abord. Le fichier
 * est créé avec son titre s'il n'existe pas encore ; une version déjà titrée est
 * ignorée, et rien de neuf rend le contenu inchangé.
 */
export function insertChangelog(existing: string | null, entries: string[]): string {
  const previous = (existing ?? "").trim();
  const fresh = entries.filter((entry) => !previous.includes(changelogKey(entry)));
  if (fresh.length === 0) return existing ?? "";
  const joined = fresh.join("\n\n");
  const lines = previous.split("\n");
  const titleIndex = lines.findIndex((line) => line.startsWith("# "));
  const title = titleIndex === -1 ? "# Journal des versions" : (lines[titleIndex] ?? "# Journal des versions");
  const rest = (titleIndex === -1 ? lines : lines.slice(titleIndex + 1)).join("\n").trim();
  return rest === "" ? `${title}\n\n${joined}\n` : `${title}\n\n${joined}\n\n${rest}\n`;
}

/**
 * Corps d'une release : une section par version, dans l'ordre fourni. La section
 * « Ce qui casse / quoi faire » n'apparaît QUE pour un bump majeur, et toujours
 * AVANT l'installation.
 */
export function renderReleaseBody(
  releases: Release[],
  options: { ownerRepo: string; marketplace: string },
): string {
  const sections = releases.map((release) => {
    const heading = release.previousTag
      ? `Changements depuis ${release.previousTag} :`
      : "Changements (première version publiée) :";
    const lines = [
      `## ${release.name} ${release.version}`,
      "",
      heading,
      ...release.changes.map((change) => `- ${change.subject} (${change.sha})`),
      "",
    ];
    if (release.level === "major") {
      lines.push("### Ce qui casse / quoi faire", "");
      for (const change of release.breaking) {
        lines.push(`- ${change.subject}${change.breaking ? ` — ${change.breaking}` : ""}`);
      }
      lines.push("");
    }
    lines.push(
      "### Installation",
      `/marketplace add ${options.ownerRepo}`,
      `/marketplace install ${release.name}@${options.marketplace}`,
      "",
      "### Mise à jour",
      `/marketplace update ${options.marketplace}`,
      `/marketplace upgrade ${release.name}@${options.marketplace}`,
    );
    return lines.join("\n");
  });
  return `${sections.join("\n\n")}\n`;
}

/** `owner/repo` depuis une URL de remote (SSH ou HTTPS), null si non reconnue. */
export function repoFromRemote(url: string): string | null {
  const match = /(?:[:/])([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Exécution : git, gh, check.sh
// ---------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOGS = [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"];
const CHANGELOG_FILE = "CHANGELOG.md";

/**
 * Identité d'auteur des commits et des tags. Posée PAR LA COMMANDE (`-c user.*`) :
 * le runner n'a pas forcément de config git, et les DEUX commandes qui exigent une
 * identité la portent (le commit et le tag annoté).
 */
const IDENTITY = [
  "-c",
  "user.name=github-actions[bot]",
  "-c",
  "user.email=41898282+github-actions[bot]@users.noreply.github.com",
];

const GIT_LOG_FORMAT = "--format=%x1e%H%x1f%s%x1f%b%x1d";

type Run = { code: number; stdout: string; stderr: string; missing: boolean };

/** Un seul passage par commande : chaque échec est nommé par l'appelant. */
function run(command: string, args: string[], options: { env?: Record<string, string> } = {}): Run {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  // Un binaire absent ne lève pas : `spawnSync` rend un `error` (ENOENT) qu'il
  // faut lire, sinon `gh` manquant passerait pour un échec de commande.
  const failure = result.error;
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    missing: failure !== undefined && "code" in failure && failure.code === "ENOENT",
  };
}

/** git doit réussir : une plage inexploitable ne doit jamais passer pour un succès. */
function git(args: string[], options: { env?: Record<string, string> } = {}): Run {
  const result = run("git", args, options);
  if (result.code !== 0 || result.missing) {
    throw new Error(`git ${args.join(" ")} : ${result.stderr.trim() || "échec sans message"}`);
  }
  return result;
}

function gitQuiet(args: string[]): Run {
  return run("git", args);
}

/** Un appel `gh` : un binaire absent est nommé, jamais confondu avec un échec de commande. */
function ghCall(args: string[], what: string): string | null {
  const result = run("gh", args);
  if (result.missing) {
    console.error("✗ gh indisponible (GH_TOKEN ?)");
    return null;
  }
  if (result.code !== 0) {
    console.error(`✗ ${what} : ${result.stderr.trim() || "échec sans message"}`);
    return null;
  }
  return result.stdout;
}

type Args = {
  before: string;
  after: string;
  dryRun: boolean;
  /** Mode simulation (S-1) : écrit sur son arbre puis prouve, ne publie jamais. */
  simulate: boolean;
  /** Référence qui joue le rôle de `main` dans le plan ; la publication reste sur `origin/main`. */
  main: string;
  repo: string | null;
  mergeTimeout: number;
};

function parseArgs(argv: string[]): Args {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  const timeout = value("--merge-timeout");
  return {
    before: value("--before") ?? "",
    after: value("--after") ?? "",
    dryRun: argv.includes("--dry-run"),
    simulate: argv.includes("--simulate"),
    main: value("--main") ?? "origin/main",
    repo: value("--repo"),
    mergeTimeout: timeout === null ? 1200 : Number(timeout),
  };
}

/** Catalogue lu dans l'arbre (après `git checkout -B release/<after> origin/main`). */
type Catalog = {
  name: string;
  metadata?: { version?: string };
  plugins: Array<{ name: string; source: unknown; version?: string }>;
};

function readCatalog(file: string): Catalog {
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  const parsed = JSON.parse(raw) as Catalog;
  if (!Array.isArray(parsed.plugins)) throw new Error(`${file} : tableau plugins absent`);
  return parsed;
}

/** Version d'un plugin lue sur `main` — jamais dans l'arbre de travail. */
function versionOnMain(dir: string, main: string): string {
  const show = git(["show", `${main}:${dir}/package.json`]);
  const pkg = JSON.parse(show.stdout) as { version?: string };
  if (typeof pkg.version !== "string") throw new Error(`${dir}/package.json sur ${main} : version absente`);
  return pkg.version;
}

/** Un plugin est local quand sa source commence par `./`. */
function localPlugins(catalog: Catalog): Array<{ name: string; dir: string }> {
  const out: Array<{ name: string; dir: string }> = [];
  for (const entry of catalog.plugins) {
    const source = entry.source;
    if (typeof source !== "string" || !source.startsWith("./")) continue;
    out.push({ name: entry.name, dir: source.slice(2) });
  }
  return out;
}

/** Les tags présents sur le remote (`git ls-remote --tags`). */
function remoteTags(): Set<string> {
  const tags = new Set<string>();
  for (const line of git(["ls-remote", "--tags", "origin"]).stdout.split("\n")) {
    const ref = line.split("\t")[1]?.trim() ?? "";
    if (ref.startsWith("refs/tags/")) tags.add(ref.slice("refs/tags/".length).replace(/\^\{\}$/, ""));
  }
  return tags;
}

/** Les commits non-merge d'une plage, du plus récent au plus ancien. */
function commitsIn(range: string[]): Commit[] {
  return parseCommits(git(["log", "--no-merges", "--name-only", GIT_LOG_FORMAT, ...range]).stdout);
}

/**
 * L'historique d'un plugin, reconstruit depuis la référence `main` du plan
 * (`origin/main` en publication, `HEAD` en simulation, S-1) : chaque commit qui
 * touche son `package.json`, dans l'ordre chronologique, et la version qu'il y
 * porte. La dernière entrée est la version courante, c'est elle qui ancre le
 * bump (convergence : jamais la seule plage `before..after`).
 */
function historyOfPlugin(plugin: { name: string; dir: string }, main: string): PluginHistory {
  const listing = git([
    "log",
    "--reverse",
    "--no-merges",
    "--format=%H%x1f%aI",
    main,
    "--",
    `${plugin.dir}/package.json`,
  ]);
  const rows: VersionEntry[] = [];
  for (const line of listing.stdout.split("\n")) {
    const [sha = "", iso = ""] = line.trim().split("\u001f");
    if (sha === "") continue;
    const show = gitQuiet(["show", `${sha}:${plugin.dir}/package.json`]);
    if (show.code !== 0) continue;
    const pkg = JSON.parse(show.stdout) as { version?: string };
    if (typeof pkg.version !== "string") continue;
    rows.push({ sha, version: pkg.version, date: utcDate(iso) });
  }
  const history = historyOf(rows);
  if (history.length === 0) {
    // Historique absent (clone superficiel) : la version courante reste la seule
    // entrée connue — et un `package.json` manquant échoue ici nommément (G-6).
    const head = git(["rev-parse", main]).stdout.trim();
    history.push({
      sha: head,
      version: versionOnMain(plugin.dir, main),
      date: utcDate(git(["show", "-s", "--format=%aI", head]).stdout),
    });
  }

  // Les changements qui ont mené à chaque version : `(c_{i-1}, c_i]`, et toute
  // l'ascendance pour la première (S-4).
  const ranges = history.map((entry, index) => {
    const previous = history[index - 1];
    const range = previous === undefined ? [entry.sha] : [`${previous.sha}..${entry.sha}`];
    return changesBetween(commitsIn(range), plugin.dir);
  });
  const current = history[history.length - 1];
  const sinceCurrent =
    current === undefined ? [] : changesBetween(commitsIn([`${current.sha}..${main}`]), plugin.dir);

  return { name: plugin.name, dir: plugin.dir, history, ranges, sinceCurrent };
}

/** Une ligne par plugin du catalogue, dans son ordre (S-1). */
function printPlan(plugins: Array<{ name: string }>, plan: Plan, published: boolean): void {
  const backfills = new Map<string, Release[]>();
  const bumps = new Map<string, Release>();
  for (const release of plan.releases) {
    if (release.kind === "bump") bumps.set(release.name, release);
    else backfills.set(release.name, [...(backfills.get(release.name) ?? []), release]);
  }
  const already = new Map(plan.alreadyPublished.map((entry) => [entry.name, entry.tag]));
  for (const plugin of plugins) {
    for (const release of backfills.get(plugin.name) ?? []) {
      console.log(`⟲ ${release.name} : rattrapage ${release.version} (${release.changes.length} commit(s))`);
    }
    const bump = bumps.get(plugin.name);
    const tag = already.get(plugin.name);
    if (tag !== undefined) console.log(`· ${plugin.name} : déjà publié (tag ${tag})`);
    else if (bump !== undefined) {
      console.log(
        `✓ ${bump.name} : ${bump.level} ${bump.from} → ${bump.version} (${bump.changes.length} commit(s))`,
      );
    } else if (!published) console.log(`· ${plugin.name} : inchangé (aucun fichier touché)`);
  }
  if (plan.releases.length > 0) {
    const backfilled = plan.releases.filter((release) => release.kind === "rattrapage").length;
    console.log(
      `→ ${plan.releases.length} version(s) à publier : ${backfilled} rattrapage, ${plan.releases.length - backfilled} bump`,
    );
  }
}

/** Titre de la PR et sujet de la fusion : les versions bumpées, ou le journal seul. */
function mergeTitle(plan: Plan): string {
  const bumped = plan.releases.filter((release) => release.kind === "bump");
  const label = bumped.length > 0 ? bumped.map((release) => `${release.name} ${release.version}`).join(", ") : "journal des versions";
  return `chore(release): ${label}`;
}

/** Corps du commit de branche, de la PR et de la fusion : le même partout (S-1). */
function mergeBody(plan: Plan, after: string): string {
  const lines = [`Release-Event: ${after}`];
  for (const release of plan.releases) {
    lines.push(`${release.kind === "bump" ? "Released" : "Backfill"}: ${release.name} ${release.version}`);
  }
  return lines.join("\n");
}

/** Écritures du bump : package.json des plugins, les DEUX catalogues (identiques). */
function writeBumpedVersions(plan: Plan, catalog: Catalog): string[] {
  const written: string[] = [];
  for (const release of plan.releases.filter((release) => release.kind === "bump")) {
    const file = path.join(ROOT, release.dir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    pkg.version = release.version;
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    written.push(`${release.dir}/package.json`);
  }

  const bumped = new Map(plan.releases.filter((release) => release.kind === "bump").map((release) => [release.name, release.version]));
  for (const entry of catalog.plugins) {
    const target = bumped.get(entry.name);
    if (target !== undefined) entry.version = target;
  }
  // `metadata.version` doit NOMMER une version publiée (invariant de check.sh) :
  // la plus grande des versions d'entrée, comparaison semver.
  const meta = maxVersion(
    catalog.plugins.map((entry) => entry.version).filter((v): v is string => typeof v === "string"),
  );
  if (meta !== null) catalog.metadata = { ...catalog.metadata, version: meta };

  // Les deux catalogues sont écrits depuis la MÊME sérialisation : ils doivent
  // rester identiques octet pour octet (check.sh le vérifie).
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  for (const file of CATALOGS) {
    fs.writeFileSync(path.join(ROOT, file), serialized);
    written.push(file);
  }
  return written;
}

/**
 * Écritures de la release : `package.json` des plugins bumpés (ordre du
 * catalogue), les DEUX catalogues (identiques octet pour octet) et `CHANGELOG.md`
 * quand son contenu change. Source UNIQUE des deux chemins — `publish()` et
 * `--simulate` — donc la simulation prouve EXACTEMENT ce que le job publierait.
 * `written` porte les chemins écrits, dans cet ordre.
 */
function writeReleaseFiles(
  plan: Plan,
  catalog: Catalog,
  existingChangelog: string | null,
): { written: string[]; changelog: string } {
  const changelog = insertChangelog(existingChangelog, plan.journal.map(renderChangelogEntry));
  const written: string[] = [];
  // Un rattrapage n'écrit rien : la version et l'entrée de journal existent déjà
  // sur la référence ; seuls les tags manquent.
  if (plan.releases.some((release) => release.kind === "bump")) {
    written.push(...writeBumpedVersions(plan, catalog));
  }
  if (changelog !== (existingChangelog ?? "")) {
    fs.writeFileSync(path.join(ROOT, CHANGELOG_FILE), changelog);
    written.push(CHANGELOG_FILE);
  }
  return { written, changelog };
}

/** Le numéro de la PR ouverte d'une branche, `""` s'il n'y en a pas. */
function prNumberOf(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    const parsed = JSON.parse(trimmed) as Array<{ number?: number }> | { number?: number };
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return typeof first?.number === "number" ? String(first.number) : "";
  } catch {
    // `--jq '.[0].number // ""'` rend le nombre nu : on l'accepte aussi.
    return /^\d+$/.test(trimmed) ? trimmed : "";
  }
}

/** La PR ouverte de la branche, réutilisée si elle existe déjà (relance). */
async function openPullRequest(
  branch: string,
  title: string,
  body: string,
  ownerRepo: string,
): Promise<string | null> {
  const listed = ghCall(
    ["pr", "list", "--repo", ownerRepo, "--head", branch, "--state", "open", "--json", "number"],
    `gh pr list --head ${branch}`,
  );
  if (listed === null) return null;
  const existing = prNumberOf(listed);
  if (existing !== "") {
    const viewed = ghCall(["pr", "view", existing, "--repo", ownerRepo, "--json", "url"], `gh pr view ${existing}`);
    if (viewed === null) return null;
    let url = "";
    try {
      url = ((JSON.parse(viewed) as { url?: string }).url ?? "").trim();
    } catch {
      url = viewed.trim();
    }
    if (url === "") {
      console.error(`✗ URL de la PR #${existing} introuvable : ${viewed.trim() || "(vide)"}`);
      return null;
    }
    console.log(`· PR de release réutilisée : ${url}`);
    return existing;
  }

  const created = ghCall(
    ["pr", "create", "--repo", ownerRepo, "--base", "main", "--head", branch, "--title", title, "--body", body],
    `gh pr create --head ${branch}`,
  );
  if (created === null) return null;
  const number = /(\d+)\/?$/.exec(created.trim())?.[1] ?? "";
  if (number === "") {
    console.error(`✗ numéro de PR introuvable dans la réponse de gh : ${created.trim() || "(vide)"}`);
    return null;
  }
  console.log(`· PR de release ouverte : ${created.trim()}`);
  return number;
}

/** Les états de `mergeStateStatus` qui autorisent la fusion (Doc-3). */
const MERGEABLE = new Set(["CLEAN", "UNSTABLE", "HAS_HOOKS"]);

/**
 * Attend que les statuts requis aient passé. Un statut inconnu ne fait jamais
 * fusionner : on attend le budget, puis on échoue en le nommant. `DIRTY` (conflit)
 * échoue immédiatement.
 */
async function waitMergeable(number: string, ownerRepo: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout * 1000;
  let last = { status: "UNKNOWN", url: "" };
  for (;;) {
    const view = run("gh", ["pr", "view", number, "--repo", ownerRepo, "--json", "state,mergeStateStatus,mergeCommit,url"]);
    if (view.missing) {
      console.error("✗ gh indisponible (GH_TOKEN ?)");
      return false;
    }
    if (view.code !== 0) {
      console.error(`✗ gh pr view ${number} : ${view.stderr.trim() || "échec sans message"}`);
      return false;
    }
    try {
      const parsed = JSON.parse(view.stdout) as { mergeStateStatus?: string; url?: string };
      last = { status: parsed.mergeStateStatus ?? "INCONNU", url: parsed.url ?? "" };
    } catch {
      console.error(`✗ gh pr view ${number} : réponse illisible (${view.stdout.trim() || "vide"})`);
      return false;
    }
    if (MERGEABLE.has(last.status)) return true;
    if (last.status === "DIRTY") {
      console.error(`✗ PR #${number} en conflit (DIRTY) : ${last.url}`);
      return false;
    }
    if (Date.now() >= deadline) {
      console.error(`✗ PR #${number} non fusionnable après ${timeout} s (dernier état : ${last.status}) : ${last.url}`);
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10_000, Math.max(0, deadline - Date.now()))));
  }
}

/** Fusionne en squash et rend le sha du commit de fusion. */
async function mergePullRequest(
  number: string,
  ownerRepo: string,
  head: string,
  title: string,
  body: string,
): Promise<string | null> {
  // `--auto` est proscrit : `allow_auto_merge` vaut `false` sur ce dépôt.
  const merged = ghCall(
    ["pr", "merge", number, "--repo", ownerRepo, "--squash", "--subject", title, "--body", body, "--match-head-commit", head],
    `gh pr merge ${number}`,
  );
  if (merged === null) return null;

  const view = ghCall(["pr", "view", number, "--repo", ownerRepo, "--json", "mergeCommit"], `gh pr view ${number}`);
  if (view === null) return null;
  let sha = "";
  try {
    sha = ((JSON.parse(view) as { mergeCommit?: { oid?: string } | null }).mergeCommit?.oid ?? "").trim();
  } catch {
    sha = "";
  }
  if (sha === "") {
    console.error(`✗ commit de fusion introuvable pour la PR #${number}`);
    return null;
  }
  return sha;
}

/**
 * Publie le plan : une branche de release, sa PR, sa fusion par le bot, puis les
 * tags et les releases. Ordre imposé, jamais inversé : **commit → fusion → tags
 * → releases** (S-1). Rien n'est poussé sur `refs/heads/main` (G-1).
 */
async function publish(
  plan: Plan,
  args: Args,
  ownerRepo: string,
  catalog: Catalog,
  eventIso: string,
): Promise<number> {
  const title = mergeTitle(plan);
  const body = mergeBody(plan, args.after);
  const branch = `release/${args.after}`;

  // Les écritures partent de origin/main et vivent sur la branche de release.
  git(["checkout", "-B", branch, "origin/main"]);
  const changelogFile = path.join(ROOT, CHANGELOG_FILE);
  const existing = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, "utf8") : null;
  // Le catalogue est RELU après le checkout : le plan a lu l'arbre d'avant, les
  // écritures partent de origin/main.
  const { written } = writeReleaseFiles(plan, readCatalog(CATALOGS[0]), existing);

  let mergeSha: string | null = null;
  if (written.length > 0) {
    const check = run("bash", ["scripts/check.sh"]);
    if (check.code !== 0) {
      const output = `${check.stdout}${check.stderr}`.trim();
      if (output !== "") console.error(output);
      console.error("✗ check.sh rouge après écriture — rien n'est committé");
      return 1;
    }

    // Dates figées sur celles de l'événement : un rejeu produit le MÊME sha, donc
    // un push sans effet (G-3).
    const dates = { GIT_AUTHOR_DATE: eventIso, GIT_COMMITTER_DATE: eventIso };
    git(["add", "--", ...written]);
    git([...IDENTITY, "commit", "-m", title, "-m", body], { env: dates });
    const head = git(["rev-parse", "HEAD"]).stdout.trim();

    const pushed = run("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);
    if (pushed.code !== 0) {
      console.error(
        `✗ git push origin HEAD:refs/heads/${branch} : ${pushed.stderr.trim() || "échec sans message"}`,
      );
      return 1;
    }

    const number = await openPullRequest(branch, title, body, ownerRepo);
    if (number === null) return 1;
    if (!(await waitMergeable(number, ownerRepo, args.mergeTimeout))) return 1;
    mergeSha = await mergePullRequest(number, ownerRepo, head, title, body);
    if (mergeSha === null) return 1;

    git(["fetch", "--force", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    // Invariant : l'arbre fusionné doit être EXACTEMENT celui qui a passé check.sh.
    const mergedTree = git(["rev-parse", "origin/main^{tree}"]).stdout.trim();
    const validatedTree = git(["rev-parse", `${branch}^{tree}`]).stdout.trim();
    if (mergedTree !== validatedTree) {
      console.error(`✗ l'arbre fusionné (${mergedTree}) n'est pas l'arbre validé (${validatedTree})`);
      return 1;
    }
  } else {
    // Rien à écrire (rejeu après fusion, tags manquants) : ni branche, ni PR à
    // ouvrir — mais l'état de main est relu avant de taguer.
    git(["fetch", "--force", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  }

  // Tous les tags D'ABORD, en une seule poussée, puis les releases (S-1).
  const tagRefs: string[] = [];
  for (const release of plan.releases) {
    const target = release.kind === "bump" ? mergeSha : release.commit;
    if (target === null) {
      console.error(`✗ commit de publication introuvable pour ${release.tag}`);
      return 1;
    }
    git([...IDENTITY, "tag", "-a", release.tag, "-m", `${release.name} ${release.version}`, target], {
      env: { GIT_COMMITTER_DATE: eventIso },
    });
    tagRefs.push(`refs/tags/${release.tag}`);
  }
  const tagPush = run("git", ["push", "origin", ...tagRefs]);
  if (tagPush.code !== 0) {
    console.error(`✗ git push origin ${tagRefs.join(" ")} : ${tagPush.stderr.trim() || "échec sans message"}`);
    return 1;
  }

  for (const release of plan.releases) {
    const notes = path.join(fs.realpathSync(os.tmpdir()), `release-${release.tag}-${process.pid}.md`);
    fs.writeFileSync(notes, renderReleaseBody([release], { ownerRepo, marketplace: catalog.name }));
    // --verify-tag : le tag est créé et poussé plus haut, `gh` ne doit pas en
    // créer un second depuis la branche par défaut.
    const result = run("gh", [
      "release",
      "create",
      release.tag,
      "--verify-tag",
      "--title",
      `${release.name} ${release.version}`,
      "--notes-file",
      notes,
    ]);
    fs.rmSync(notes, { force: true });
    if (result.missing) {
      console.error("✗ gh indisponible (GH_TOKEN ?)");
      return 1;
    }
    if (result.code !== 0) {
      console.error(`✗ gh release create ${release.tag} : ${result.stderr.trim() || "échec sans message"}`);
      return 1;
    }
    console.log(`  → ${release.name} ${release.version} publié (tag ${release.tag})`);
  }

  if (written.length > 0) {
    const deleted = run("git", ["push", "origin", "--delete", branch]);
    if (deleted.code !== 0) {
      console.log(
        `· branche ${branch} non supprimée (${deleted.stderr.trim() || "échec sans message"}) — à nettoyer à la main`,
      );
    }
  }
  return 0;
}

/**
 * Simulation (S-1) : écrit l'arbre de la release puis PROUVE que le job de
 * publication l'accepterait, avec `check.sh` tel quel. Rien n'est committé,
 * poussé, tagué ni ouvert — et l'écriture passe par `writeReleaseFiles`, donc la
 * simulation prouve exactement ce que `publish()` écrirait.
 *
 * Verdict de la release ENTIÈRE : un plan inexploitable ou une écriture fautive
 * sortent AVANT `check.sh` (le message de l'étape fautive est celui du moteur),
 * un `check.sh` rouge est nommé comme tel.
 */
function simulate(plan: Plan, catalog: Catalog): number {
  // Un arbre sale rendrait le verdict inexploitable : impossible de distinguer un
  // rouge de la release d'un rouge des modifications locales. L'appelant utilise
  // donc une copie jetable (scripts/release-simulation.sh).
  if (gitQuiet(["status", "--porcelain"]).stdout.trim() !== "") {
    console.error(
      "✗ --simulate exige un arbre propre (git status) : simule dans une copie jetable (scripts/release-simulation.sh)",
    );
    return 1;
  }

  const changelogFile = path.join(ROOT, CHANGELOG_FILE);
  const existing = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, "utf8") : null;
  const { written } = writeReleaseFiles(plan, catalog, existing);
  if (written.length === 0) {
    console.log("· aucune écriture : l'arbre simulé est déjà l'arbre de release");
  } else {
    console.log(`· écrit : ${written.join(", ")}`);
  }

  // `check.sh` est lancé TEL QUEL : la simulation doit voir ce que verrait la
  // release, ni plus (pas de gate plus strict) ni moins.
  const check = run("bash", ["scripts/check.sh"]);
  if (check.code !== 0) {
    const checkOutput = `${check.stdout}${check.stderr}`.trim();
    if (checkOutput !== "") console.error(checkOutput);
    console.error("✗ check.sh rouge sur l'arbre de release simulé — la release échouerait ici");
    return 1;
  }
  console.log("✓ release simulée : check.sh vert sur l'arbre écrit");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.simulate && args.dryRun) {
    console.error("✗ --simulate et --dry-run sont incompatibles (--dry-run n'écrit rien)");
    return 1;
  }
  const range = `${args.before}..${args.after}`;
  if (args.before === "" || args.after === "") {
    console.error(`✗ plage ${range} inexploitable : --before et --after sont requis`);
    return 1;
  }
  if (/^0+$/.test(args.before)) {
    console.error(`✗ plage ${range} inexploitable : before est nul (première poussée de la branche)`);
    return 1;
  }
  if (!Number.isFinite(args.mergeTimeout) || args.mergeTimeout <= 0) {
    console.error(`✗ --merge-timeout invalide : ${args.mergeTimeout}`);
    return 1;
  }
  if (gitQuiet(["merge-base", "--is-ancestor", args.before, args.after]).code !== 0) {
    console.error(`✗ plage ${range} inexploitable : before n'est pas un ancêtre de after`);
    return 1;
  }

  // Résolu avant toute écriture : sans lui, aucune note de release n'est rendue.
  // La simulation n'en a pas besoin — elle ne rend aucune note, et se passe donc
  // aussi du remote (S-1).
  let ownerRepo = "";
  if (!args.simulate) {
    ownerRepo =
      args.repo ?? process.env.GITHUB_REPOSITORY ?? repoFromRemote(git(["remote", "get-url", "origin"]).stdout) ?? "";
    if (ownerRepo === "") {
      console.error("✗ dépôt introuvable (--repo, GITHUB_REPOSITORY ou remote origin)");
      return 1;
    }
  }

  let catalog: Catalog;
  try {
    catalog = readCatalog(CATALOGS[0]);
  } catch (error) {
    console.error(`✗ catalogue illisible : ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // S-2 : le jeton dédié est la SEULE identité de publication. `GH_TOKEN` posé ne
  // suffit pas (aucun repli sur le `GITHUB_TOKEN` du dépôt), et ni `--dry-run` ni
  // `--simulate` n'ont besoin de jeton : ils n'écrivent rien de distant.
  if (!args.dryRun && !args.simulate && (process.env.RELEASE_TOKEN ?? "") === "") {
    console.error("✗ RELEASE_TOKEN absent — le job de release ne peut pas publier (PUBLISHING.md, § Jeton de release)");
    return 1;
  }
  if (!args.dryRun && !args.simulate && (process.env.GH_TOKEN ?? "") === "") {
    console.error("✗ gh indisponible (GH_TOKEN ?)");
    return 1;
  }

  const plugins = localPlugins(catalog);
  if (plugins.length === 0) {
    console.log("· catalogue sans plugin local");
    return 0;
  }

  let eventIso: string;
  let eventDate: string;
  try {
    eventIso = git(["show", "-s", "--format=%aI", args.after]).stdout.trim();
    eventDate = utcDate(eventIso);
  } catch (error) {
    console.error(`✗ date de l'événement illisible : ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const existingTags = remoteTags();

  // Idempotence (1) : le trailer du commit de release marque l'événement publié.
  // --grep SANS pathspec : avec `-- .`, le commit de release (vide) est exclu.
  const published =
    git(["log", "--fixed-strings", `--grep=Release-Event: ${args.after}`, "--format=%H", "-n", "1", args.main]).stdout.trim() !==
    "";
  if (published) console.log("· merge déjà publié");

  let histories: PluginHistory[];
  try {
    histories = plugins.map((plugin) => historyOfPlugin(plugin, args.main));
  } catch (error) {
    console.error(`✗ historique illisible : ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const plan = planOf(histories, existingTags, eventDate, published);
  printPlan(plugins, plan, published);
  // La simulation s'exécute MÊME quand le plan est vide : c'est le cas de la PR
  // de release, dont l'arbre bumpé doit passer `check.sh` (S-1, AC-4).
  if (args.simulate) return simulate(plan, catalog);
  if (plan.releases.length === 0) return 0;
  // `--dry-run` : le plan est imprimé, rien n'est écrit, rien n'est poussé.
  if (args.dryRun) return 0;

  return await publish(plan, args, ownerRepo, catalog, eventIso);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
