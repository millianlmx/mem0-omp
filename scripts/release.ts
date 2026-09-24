#!/usr/bin/env node
// Moteur de release (S-3/S-4/S-5) : à la fusion d'une PR sur `main`, décide du
// bump de chaque plugin touché d'après les commits conventionnels de la plage,
// applique les écritures, prouve le résultat avec check.sh, puis commit, tag et
// release GitHub — le tout idempotent.
//
// Lancé par `.github/workflows/release.yml` :
//   node --experimental-strip-types scripts/release.ts --before <sha> --after <sha>
// et utilisable à la main avec `--dry-run` (calcule et imprime, n'écrit rien).
//
// Le fichier est importable : les fonctions pures (analyse des commits, plan,
// bump semver, rendu du changelog et du corps de release) sont testées sans
// réseau ni git par test/release.test.ts. Rien ne s'exécute à l'import.
//
// PIÈGES MESURÉS (2026-09-24, git 2.5x, gh 2.x) :
//  * `git log --grep` SANS pathspec : avec `-- .`, le commit de release (vide)
//    est exclu et la garde d'idempotence ne trouve jamais rien ;
//  * les versions sont lues sur `origin/main`, jamais dans l'arbre de travail :
//    c'est ce qui garantit qu'un rejeu du même événement ne double-bump pas ;
//  * le commit de release poussé par GITHUB_TOKEN ne relance AUCUN workflow :
//    c'est pour ça que le job de release lance check.sh lui-même ;
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

/** Un plugin du catalogue, avec la version lue sur `origin/main`. */
export type Plugin = { name: string; dir: string; version: string; previousTag: string | null };

/** Un changement tel qu'il apparaît dans le changelog et la note de release. */
export type Change = { sha: string; subject: string; level: Level | null; breaking: string | null };

/** Ce qui sera écrit et publié pour un plugin. */
export type Planned = {
  name: string;
  dir: string;
  level: Level;
  from: string;
  to: string;
  tag: string;
  changes: Change[];
  breaking: Change[];
  previousTag: string | null;
};

export type Plan = { planned: Planned[]; unchanged: string[] };

const LEVELS: Record<Level, number> = { patch: 1, minor: 2, major: 3 };

/** Sujet conventionnel : `type(scope)!: …` — le `!` porte la rupture (CC §13). */
const SUBJECT = /^([A-Za-z]+)(\([^)]*\))?(!)?:/;

/**
 * Dernier paragraphe du corps : c'est là que vivent les footers (CC §8-10), donc
 * une ligne `BREAKING CHANGE:` au milieu du corps n'est pas un footer.
 */
function footerBlock(body: string): string {
  const blocks = body.trim().split(/\n[ \t]*\n/);
  return blocks.length === 0 ? "" : blocks[blocks.length - 1];
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
  return levels.reduce((best, level) => (LEVELS[level] > LEVELS[best] ? level : best), "patch");
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

/**
 * Analyse d'un `git log --no-merges --name-only
 * --format='%x1e%H%x1f%s%x1f%b%x1d' <before>..<after>`.
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

/**
 * Plan de release : pour chaque plugin du catalogue, son niveau (maximum des
 * niveaux des commits qui le touchent), sa version cible, ses changements ; ou
 * son nom dans `unchanged` quand aucun commit qualifiant ne le touche.
 */
export function planRelease(commits: Commit[], plugins: Plugin[]): Plan {
  const planned: Planned[] = [];
  const unchanged: string[] = [];
  for (const plugin of plugins) {
    const touching = commitsTouching(commits, plugin.dir);
    const changes = touching.map(asChange);
    const levels = changes.map((change) => change.level).filter((level): level is Level => level !== null);
    if (levels.length === 0) {
      unchanged.push(plugin.name);
      continue;
    }
    const level = maxLevel(levels);
    const to = bumpVersion(plugin.version, level);
    planned.push({
      name: plugin.name,
      dir: plugin.dir,
      level,
      from: plugin.version,
      to,
      tag: `${plugin.name}-v${to}`,
      changes,
      breaking: changes.filter((change) => change.level === "major"),
      previousTag: plugin.previousTag,
    });
  }
  return { planned, unchanged };
}

/** Entrée de CHANGELOG d'un plugin : titre daté (UTC) puis un item par commit. */
export function renderChangelogEntry(plugin: Planned, date: string): string {
  const items = plugin.changes.map((change) => `- ${change.subject} (${change.sha})`);
  return [`## ${plugin.name} ${plugin.to} — ${date}`, "", ...items].join("\n");
}

/**
 * Insère les entrées juste après le titre, la plus récente d'abord. Le fichier
 * est créé avec son titre s'il n'existe pas encore.
 */
export function insertChangelog(existing: string | null, entries: string[]): string {
  const fresh = entries.join("\n\n");
  const previous = (existing ?? "").trim();
  if (previous === "") return `# Journal des versions\n\n${fresh}\n`;
  const lines = previous.split("\n");
  const titleIndex = lines.findIndex((line) => line.startsWith("# "));
  const title = titleIndex === -1 ? "# Journal des versions" : lines[titleIndex];
  const rest = (titleIndex === -1 ? lines : lines.slice(titleIndex + 1)).join("\n").trim();
  return rest === "" ? `${title}\n\n${fresh}\n` : `${title}\n\n${fresh}\n\n${rest}\n`;
}

/**
 * Corps d'une release (S-5) : une section par plugin, dans l'ordre du catalogue.
 * La section « Ce qui casse / quoi faire » n'apparaît QUE pour un bump majeur, et
 * toujours AVANT l'installation.
 */
export function renderReleaseBody(
  plugins: Planned[],
  options: { ownerRepo: string; marketplace: string },
): string {
  const sections = plugins.map((plugin) => {
    const heading = plugin.previousTag
      ? `Changements depuis ${plugin.previousTag} :`
      : "Changements (première version publiée) :";
    const lines = [
      `## ${plugin.name} ${plugin.to}`,
      "",
      heading,
      ...plugin.changes.map((change) => `- ${change.subject} (${change.sha})`),
      "",
    ];
    if (plugin.level === "major") {
      lines.push("### Ce qui casse / quoi faire", "");
      for (const change of plugin.breaking) {
        lines.push(`- ${change.subject}${change.breaking ? ` — ${change.breaking}` : ""}`);
      }
      lines.push("");
    }
    lines.push(
      "### Installation",
      `/marketplace add ${options.ownerRepo}`,
      `/marketplace install ${plugin.name}@${options.marketplace}`,
      "",
      "### Mise à jour",
      `/marketplace update ${options.marketplace}`,
      `/marketplace upgrade ${plugin.name}@${options.marketplace}`,
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

type Args = { before: string; after: string; dryRun: boolean; repo: string | null };

function parseArgs(argv: string[]): Args {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  return {
    before: value("--before") ?? "",
    after: value("--after") ?? "",
    dryRun: argv.includes("--dry-run"),
    repo: value("--repo"),
  };
}

/** Catalogue lu dans l'arbre (après `git checkout -B main origin/main`). */
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

/** Version d'un plugin lue sur `origin/main` — jamais dans l'arbre de travail. */
function versionOnMain(dir: string): string {
  const show = git(["show", `origin/main:${dir}/package.json`]);
  const pkg = JSON.parse(show.stdout) as { version?: string };
  if (typeof pkg.version !== "string") throw new Error(`${dir}/package.json sur origin/main : version absente`);
  return pkg.version;
}

/** Un plugin est local quand sa source commence par `./` (S-3 §1). */
function localPlugins(catalog: Catalog): Array<{ name: string; dir: string; version: string }> {
  const out: Array<{ name: string; dir: string; version: string }> = [];
  for (const entry of catalog.plugins) {
    const source = entry.source;
    if (typeof source !== "string" || !source.startsWith("./")) continue;
    const dir = source.slice(2);
    out.push({ name: entry.name, dir, version: versionOnMain(dir) });
  }
  return out;
}

function tagExists(tag: string): boolean {
  return gitQuiet(["ls-remote", "--tags", "origin", tag]).stdout.trim() !== "";
}

function previousTag(name: string): string | null {
  const result = gitQuiet(["describe", "--tags", "--abbrev=0", "--match", `${name}-v*`, "HEAD"]);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

/** Écritures : package.json du plugin, les DEUX catalogues, CHANGELOG.md. */
function writeFiles(plan: Plan, catalog: Catalog): string[] {
  const written: string[] = [];
  for (const plugin of plan.planned) {
    const file = path.join(ROOT, plugin.dir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    pkg.version = plugin.to;
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    written.push(`${plugin.dir}/package.json`);
  }

  const bumped = new Map(plan.planned.map((plugin) => [plugin.name, plugin.to]));
  for (const entry of catalog.plugins) {
    const target = bumped.get(entry.name);
    if (target) entry.version = target;
  }
  // `metadata.version` doit NOMMER une version publiée (invariant de check.sh) :
  // la plus grande des versions d'entrée, comparaison semver.
  const meta = maxVersion(catalog.plugins.map((entry) => entry.version).filter((v): v is string => typeof v === "string"));
  if (meta !== null) catalog.metadata = { ...catalog.metadata, version: meta };

  // Les deux catalogues sont écrits depuis la MÊME sérialisation : ils doivent
  // rester identiques octet pour octet (check.sh le vérifie).
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  for (const file of CATALOGS) {
    fs.writeFileSync(path.join(ROOT, file), serialized);
    written.push(file);
  }

  const changelogFile = path.join(ROOT, "CHANGELOG.md");
  const existing = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, "utf8") : null;
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(changelogFile, insertChangelog(existing, plan.planned.map((plugin) => renderChangelogEntry(plugin, date))));
  written.push("CHANGELOG.md");

  return written;
}

type PublishOptions = { ownerRepo: string; marketplace: string };

/** Un seul commit (même si plusieurs plugins), puis un tag et une release par plugin. */
function commitAndPublish(plan: Plan, after: string, written: string[], options: PublishOptions): number {
  const label = plan.planned.map((plugin) => `${plugin.name} ${plugin.to}`).join(", ");
  const body = [
    `Release-Event: ${after}`,
    ...plan.planned.map((plugin) => `Released: ${plugin.name} ${plugin.to}`),
  ].join("\n");
  // Identité posée par la commande : le runner n'a pas forcément de config git,
  // et les DEUX commandes qui en exigent une la portent (commit et tag annoté).
  const identity = [
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
  ];
  git(["add", "--", ...written]);
  git([...identity, "commit", "-m", `chore(release): ${label}`, "-m", body]);
  git(["push", "origin", "HEAD:refs/heads/main"]);

  // Tags d'abord (ordre imposé : commit → push → tags → releases).
  //
  // `-a` crée un objet tag : git exige une identité de TAGEUR, comme pour le
  // commit — et la devine sinon depuis le compte (`user.useConfigOnly` non posé).
  // Mesuré le 2026-09-24 : sans ces deux `-c`, le job ubuntu (aucune config git
  // globale) rend « Committer identity unknown / empty ident name » et la release
  // s'arrête AVANT tout tag, quand macOS passait — le compte `runner` y a un GECOS
  // qui fournit un nom de repli.
  for (const plugin of plan.planned) {
    git([...identity, "tag", "-a", plugin.tag, "-m", `${plugin.name} ${plugin.to}`, "HEAD"]);
    git(["push", "origin", plugin.tag]);
  }

  if (!process.env.GH_TOKEN) {
    console.error("✗ gh indisponible (GH_TOKEN ?)");
    return 1;
  }
  for (const plugin of plan.planned) {
    const notes = path.join(fs.realpathSync(os.tmpdir()), `release-${plugin.tag}-${process.pid}.md`);
    fs.writeFileSync(notes, renderReleaseBody([plugin], options));
    // --verify-tag : le tag est créé et poussé plus haut, `gh` ne doit pas en
    // créer un second depuis la branche par défaut.
    const release = run("gh", [
      "release",
      "create",
      plugin.tag,
      "--verify-tag",
      "--title",
      `${plugin.name} ${plugin.to}`,
      "--notes-file",
      notes,
    ]);
    fs.rmSync(notes, { force: true });
    if (release.missing) {
      console.error("✗ gh indisponible (GH_TOKEN ?)");
      return 1;
    }
    if (release.code !== 0) {
      console.error(`✗ gh release create ${plugin.tag} : ${release.stderr.trim() || "échec sans message"}`);
      return 1;
    }
    console.log(`  → ${plugin.name} ${plugin.to} publié (tag ${plugin.tag})`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const range = `${args.before}..${args.after}`;
  if (args.before === "" || args.after === "") {
    console.error(`✗ plage ${range} inexploitable : --before et --after sont requis`);
    return 1;
  }
  if (/^0+$/.test(args.before)) {
    console.error(`✗ plage ${range} inexploitable : before est nul (première poussée de la branche)`);
    return 1;
  }
  if (gitQuiet(["merge-base", "--is-ancestor", args.before, args.after]).code !== 0) {
    console.error(`✗ plage ${range} inexploitable : before n'est pas un ancêtre de after`);
    return 1;
  }

  // Résolu avant toute écriture : sans lui, aucune note de release n'est rendue.
  const ownerRepo =
    args.repo ??
    process.env.GITHUB_REPOSITORY ??
    repoFromRemote(git(["remote", "get-url", "origin"]).stdout) ??
    "";
  if (ownerRepo === "") {
    console.error("✗ dépôt introuvable (--repo, GITHUB_REPOSITORY ou remote origin)");
    return 1;
  }

  let catalog: Catalog;
  try {
    catalog = readCatalog(CATALOGS[0]);
  } catch (error) {
    console.error(`✗ catalogue illisible : ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // Idempotence (1) : le trailer du commit de release marque la fusion publiée.
  // --grep SANS pathspec : avec `-- .`, le commit de release (vide) est exclu.
  const already = git([
    "log",
    "--fixed-strings",
    `--grep=Release-Event: ${args.after}`,
    "--format=%H",
    "-n",
    "1",
    "origin/main",
  ]);
  if (already.stdout.trim() !== "") {
    console.log("· merge déjà publié");
    return 0;
  }

  let plugins: Plugin[];
  try {
    plugins = localPlugins(catalog).map((plugin) => ({
      ...plugin,
      previousTag: previousTag(plugin.name),
    }));
  } catch (error) {
    console.error(`✗ versions illisibles : ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (plugins.length === 0) {
    console.log("· catalogue sans plugin local");
    return 0;
  }

  // Idempotence (2) : le tag de la version CIBLE déjà posé sur le remote retire
  // le plugin du plan. Le contrôler APRÈS le plan est nécessaire — c'est la
  // version cible qui compte, pas la version courante — et sans lui `git tag -a`
  // échouerait (fatal) sur une version déjà sortie.
  const candidate = planRelease(parseCommits(git([
    "log",
    "--no-merges",
    "--name-only",
    "--format=%x1e%H%x1f%s%x1f%b%x1d",
    range,
  ]).stdout), plugins);
  const alreadyPublished = new Map<string, string>();
  const kept: Planned[] = [];
  for (const plugin of candidate.planned) {
    if (tagExists(plugin.tag)) {
      alreadyPublished.set(plugin.name, `· ${plugin.name} : déjà publié (tag ${plugin.tag})`);
      continue;
    }
    kept.push(plugin);
  }
  const plan: Plan = { planned: kept, unchanged: candidate.unchanged };

  // Sortie du plan : une ligne par plugin du catalogue, dans son ordre.
  for (const plugin of plugins) {
    const publishedLine = alreadyPublished.get(plugin.name);
    if (publishedLine !== undefined) {
      console.log(publishedLine);
      continue;
    }
    const planned = plan.planned.find((entry) => entry.name === plugin.name);
    console.log(
      planned
        ? `✓ ${planned.name} : ${planned.level} ${planned.from} → ${planned.to} (${planned.changes.length} commit(s))`
        : `· ${plugin.name} : inchangé (aucun fichier touché)`,
    );
  }

  if (plan.planned.length === 0 || args.dryRun) return 0;

  // Les écritures partent de origin/main : le push est donc un fast-forward.
  git(["checkout", "-B", "main", "origin/main"]);
  // Catalogue relu APRÈS le checkout : c'est le contenu de main qui est bumpé,
  // jamais celui d'un arbre de travail qui aurait divergé.
  const written = writeFiles(plan, readCatalog(CATALOGS[0]));

  const check = run("bash", ["scripts/check.sh"]);
  if (check.code !== 0) {
    const output = `${check.stdout}${check.stderr}`.trim();
    if (output !== "") console.error(output);
    console.error("✗ check.sh rouge après écriture — rien n'est committé");
    return 1;
  }

  return commitAndPublish(plan, args.after, written, { ownerRepo, marketplace: catalog.name });
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
