// Déclarer un dépôt sans éditer la configuration à la main, en ligne de commande
// (`main.ts --add-repo <url>`) ou par l'API (`POST /v1/repos`, `ConfigAdmin`). Chaque
// dépôt reçoit sa clé SSH (`~/.ssh/repos/<nom>`, créée ou reprise : GitHub refuse une
// même clé de déploiement sur deux dépôts), le clone nu est fait avec elle, l'accès en
// écriture est éprouvé à blanc, les commandes de test sont devinées depuis les manifestes
// de la branche principale, puis l'entrée est écrite dans config.json.
//
// Codes de sortie (lus par harness.sh, qui guide la clé de déploiement) :
//   0 ajouté (ou déjà là) · 3 lecture refusée · 4 écriture refusée · 1 autre échec.
//
// `ConfigAdmin` relit aussi la configuration à chaud (SIGHUP, `POST /v1/reload`) : une
// configuration invalide est refusée, l'ancienne reste en place.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { rulesWith } from "./autonomy-learning.ts";
import type { AutonomyRuleInput } from "./autonomy-learning.ts";
import { checkAutonomy } from "./autonomy-rules.ts";
import type { AutonomyRule } from "./autonomy-rules.ts";
import type { CorporatePolicy, ForgeKind, HarnessConfig, Privacy, RepoConfig, TestJudge, Tier } from "./config.ts";
import {
  CORPORATE_POLICIES,
  DEFAULT_CI_TIMEOUT_SEC,
  FORGES,
  PRIVACIES,
  TEST_JUDGES,
  TIERS,
  ciTimeoutSec,
  corporatePolicy,
  loadConfig,
  testsJudge,
} from "./config.ts";
import { HarnessError } from "./errors.ts";
import { forgeKindOf, remoteLocation } from "./forge.ts";
import { remoteEnv, type Git } from "./git.ts";
import { execProcess } from "./proc.ts";

export type TestPlan = {
  touched: string;
  full: string;
  /** Le glob des fichiers de test (`repos[].tests.pattern`) ; `null` : pas de filtre. */
  pattern: string | null;
  /** Les commandes nommées (`repos[].checks`), devinées des scripts npm `lint` et `typecheck`. */
  checks: Record<string, string>;
  testImage: string | null;
};

/** Les scripts npm d'un `package.json` lu tel quel ; `{}` si absent ou illisible. */
function npmScripts(packageJson: string | null): Record<string, string> {
  if (packageJson === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) return {};
  const scripts: unknown = parsed.scripts;
  if (typeof scripts !== "object" || scripts === null) return {};
  const out: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) if (typeof command === "string") out[name] = command;
  return out;
}

/**
 * Les commandes de test d'un dépôt, d'après les fichiers à la racine de sa branche
 * principale et, pour un projet node, le contenu de son `package.json` : un script
 * `test:touched` (qui reçoit les fichiers touchés et sort 0 à vide) prime sur
 * `<runner> test -- {files}` ; `lint` et `typecheck` deviennent des `checks` nommés.
 * Le glob des tests suit l'arborescence : `test/` ⇒ `test/**\/*.test.ts`, sinon
 * `**\/*.test.{ts,js}`.
 */
export function detectTests(files: readonly string[], packageJson: string | null = null): TestPlan {
  const has = (name: string) => files.includes(name);
  if (has("package.json")) {
    const runner = has("pnpm-lock.yaml")
      ? "pnpm"
      : has("yarn.lock")
        ? "yarn"
        : has("bun.lockb") || has("bun.lock")
          ? "bun"
          : "npm";
    const scripts = npmScripts(packageJson);
    const checks: Record<string, string> = {};
    for (const name of ["lint", "typecheck"]) if (name in scripts) checks[name] = `${runner} run -s ${name}`;
    return {
      touched: "test:touched" in scripts ? `${runner} run -s test:touched -- {files}` : `${runner} test -- {files}`,
      full: `${runner} test`,
      pattern: has("test") ? "test/**/*.test.ts" : "**/*.test.{ts,js}",
      checks,
      testImage: null,
    };
  }
  if (has("Cargo.toml"))
    return {
      touched: "cargo test",
      full: "cargo test",
      pattern: null,
      checks: {},
      testImage: "docker.io/library/rust:1-bookworm",
    };
  if (has("go.mod"))
    return {
      touched: "go test ./...",
      full: "go test ./...",
      pattern: null,
      checks: {},
      testImage: "docker.io/library/golang:1-bookworm",
    };
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    return {
      touched: "python -m pytest {files}",
      full: "python -m pytest",
      pattern: null,
      checks: {},
      testImage: "docker.io/library/python:3-bookworm",
    };
  }
  // Rien de reconnu : les tests passent toujours, la revue lit le code.
  return { touched: "true {files}", full: "true", pattern: null, checks: {}, testImage: null };
}

/** Le nom d'un dépôt d'après son URL : `git@github.com:moi/mon-produit.git` → `mon-produit`. */
export function repoName(url: string): string {
  return (url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "").replace(/\.git$/, "");
}

/** La clé de déploiement à poser sur le distant : sa clé publique et, sur GitHub, la page où la coller. */
export type DeployKey = { publicKey: string; url: string | null };

/** `deployKey` : la clé à poser quand le distant refuse la lecture (3) ou l'écriture (4). */
export type AddResult = { code: 0 | 1 | 3 | 4; message: string; deployKey?: DeployKey };

/** Le lanceur de `ssh-keygen` (doublé par les tests) ; lève si la clé n'est pas créée. */
export type KeyGen = (args: string[]) => Promise<void>;

/** `ssh-keygen` lui-même, borné à 30 s. */
export const sshKeygen: KeyGen = async (args) => {
  const made = await execProcess("ssh-keygen", args, { timeoutMs: 30_000 });
  if (made.code !== 0) throw new Error(`ssh-keygen : ${made.stderr.trim()}`);
};

/** La clé du dépôt `<HOME>/.ssh/repos/<nom>` : reprise si elle existe, sinon créée. */
export async function ensureRepoKey(name: string, keygen: KeyGen, home: string): Promise<string> {
  const dir = path.join(home, ".ssh", "repos");
  const key = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(key)) await keygen(["-q", "-t", "ed25519", "-N", "", "-C", `omp-harness:${name}`, "-f", key]);
  return key;
}

/** La clé publique du dépôt et, sur GitHub ou GitLab, la page des clés de déploiement. */
function deployKeyOf(url: string, key: string): DeployKey {
  const at = remoteLocation(url);
  const kind = forgeKindOf({ merge: "local" }, url);
  return {
    publicKey: fs.readFileSync(`${key}.pub`, "utf8").trim(),
    url:
      at === null || kind === "none"
        ? null
        : kind === "github"
          ? `https://github.com/${at.path}/settings/keys/new`
          : `https://${at.host}/${at.path}/-/settings/repository`,
  };
}

/** Le geste qui accorde l'accès, en clair pour la ligne de commande. */
function deployKeyHelp(deployKey: DeployKey): string {
  const page = deployKey.url ? ` (${deployKey.url})` : "";
  return `\nAjoute cette clé de déploiement AVEC écriture sur le dépôt${page} :\n${deployKey.publicKey}`;
}

export async function addRepo(
  configFile: string,
  config: HarnessConfig,
  git: Git,
  url: string,
  options: { name?: string; keygen: KeyGen; home?: string },
): Promise<AddResult> {
  const name = options.name ?? repoName(url);
  const home = options.home ?? process.env.HOME ?? os.homedir();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name))
    return { code: 1, message: `nom de dépôt invalide : « ${name} » (passe --name)` };
  // Une « URL » qui commence par un tiret serait lue par git comme une option.
  if (url.trim() === "" || url.startsWith("-")) return { code: 1, message: `URL de dépôt invalide : « ${url} »` };
  const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as { repos?: Record<string, unknown>[] };
  const repos = (raw.repos ?? []).filter((repo) => repo.name !== "mon-produit");
  if (repos.some((repo) => repo.name === name)) return { code: 0, message: `${name} est déjà déclaré` };

  const reposRoot = path.dirname(config.dataDir);
  const clone = path.join(reposRoot, "repos", name);
  const sshKey = await ensureRepoKey(name, options.keygen, home);
  const env = remoteEnv({ sshKey }, { ...process.env, HOME: home });
  if (!fs.existsSync(clone)) {
    const read = await git.raw(reposRoot, ["ls-remote", "--heads", url], env);
    if (read.code !== 0) {
      const deployKey = deployKeyOf(url, sshKey);
      return {
        code: 3,
        message: `lecture refusée sur ${url} : ${read.stderr.trim().split("\n")[0] ?? ""}${deployKeyHelp(deployKey)}`,
        deployKey,
      };
    }
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    const cloned = await git.raw(reposRoot, ["clone", "--quiet", "--bare", url, clone], env);
    if (cloned.code !== 0) return { code: 1, message: `clone impossible : ${cloned.stderr.trim()}` };
  }
  const head = await git.raw(clone, ["symbolic-ref", "--short", "HEAD"]);
  const mainBranch = head.code === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : "main";
  const write = await git.raw(
    clone,
    ["push", "--dry-run", "--porcelain", "origin", `refs/heads/${mainBranch}:refs/heads/omp-harness-check`],
    env,
  );
  if (write.code !== 0) {
    const deployKey = deployKeyOf(url, sshKey);
    return {
      code: 4,
      message: `écriture refusée sur ${url} : ${write.stderr.trim().split("\n")[0] ?? ""}${deployKeyHelp(deployKey)}`,
      deployKey,
    };
  }

  const listed = await git.raw(clone, ["ls-tree", "--name-only", mainBranch]);
  const files = listed.code === 0 ? listed.stdout.split("\n").filter(Boolean) : [];
  const manifest = files.includes("package.json") ? await git.raw(clone, ["show", `${mainBranch}:package.json`]) : null;
  const plan = detectTests(files, manifest !== null && manifest.code === 0 ? manifest.stdout : null);
  repos.push({
    name,
    path: clone,
    mainBranch,
    tests: { touched: plan.touched, full: plan.full, pattern: plan.pattern },
    checks: plan.checks,
    ...(plan.testImage ? { testImage: plan.testImage } : {}),
    merge: "local",
    remote: "origin",
    sshKey,
  });
  fs.writeFileSync(configFile, `${JSON.stringify({ ...raw, repos }, null, 2)}\n`);
  // La forge se déduit de l'URL à chaque appel : rien à écrire, mais l'humain sait ce qui servira PR et issues.
  const forge = forgeKindOf({ merge: "local" }, url);
  return {
    code: 0,
    message: `${name} ajouté — tests : « ${plan.full} »${plan.testImage ? ` dans ${plan.testImage}` : ""} — forge : ${forge === "none" ? "aucune (merge local seulement ; `forge` dans la configuration pour la changer)" : forge}`,
  };
}

/** Ce que rend un rechargement : les dépôts en vigueur, et ce qui a changé. */
export type ReloadSummary = { repos: string[]; added: string[]; removed: string[]; kept: string[] };

/** Ce que `ConfigAdmin` demande au service : sa configuration courante et le rechargement de ses dépôts. */
export type Reloadable = {
  readonly config: HarnessConfig;
  reloadRepos(next: RepoConfig[]): Promise<{ added: string[]; removed: string[]; kept: string[] }>;
};

/** La déclaration d'un dépôt par l'API : son nom, s'il sert désormais, et la clé à poser s'il le faut. */
export type RepoDeclared = {
  repo: string;
  added: boolean;
  message: string;
  deployKey?: DeployKey;
  reload: ReloadSummary | null;
};

/**
 * Les distants qu'un client de l'API peut déclarer : SSH (`git@hôte:chemin`, `ssh://`) ou
 * HTTPS — jamais un chemin local, un autre transport (`ext::`) ni un hôte ou un chemin qui
 * commence par un tiret (git le lirait comme une option).
 */
const REMOTE_URL = /^(?:(?:ssh|https):\/\/\w[\w.@:-]*\/\S+|\w[\w.-]*@\w[\w.-]*:[^\s-]\S*)$/;

/**
 * Le fichier de configuration du service, administré à chaud : rechargement (SIGHUP,
 * `POST /v1/reload`) et déclaration d'un dépôt (`POST /v1/repos`). Les gestes passent
 * un par un : deux déclarations simultanées n'écrivent jamais le fichier l'une sur l'autre.
 */
export class ConfigAdmin {
  readonly #file: string | null;
  readonly #service: Reloadable;
  readonly #git: Git;
  readonly #keygen: KeyGen;
  readonly #home: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(file: string | null, service: Reloadable, deps: { git: Git; keygen?: KeyGen; home?: string }) {
    this.#file = file;
    this.#service = service;
    this.#git = deps.git;
    this.#keygen = deps.keygen ?? sshKeygen;
    this.#home = deps.home;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => {}).then(fn);
    this.#queue = next;
    return next;
  }

  #requireFile(): string {
    if (this.#file === null)
      throw new HarnessError(409, "service lancé sans fichier de configuration (--config) : rien à relire ni à écrire");
    return this.#file;
  }

  /**
   * Relit la configuration et recharge les dépôts sans arrêter les runs. Une
   * configuration illisible ou invalide est un 400 : rien ne change.
   */
  reload(): Promise<ReloadSummary> {
    return this.#serial(() => this.#reload());
  }

  async #reload(): Promise<ReloadSummary> {
    const file = this.#requireFile();
    let next: HarnessConfig;
    try {
      next = loadConfig(file);
    } catch (err) {
      throw new HarnessError(
        400,
        `configuration refusée, l'ancienne reste en place : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const changes = await this.#service.reloadRepos(next.repos);
    return { repos: this.#service.config.repos.map((repo) => repo.name), ...changes };
  }

  /**
   * Déclare un dépôt comme `--add-repo`, puis recharge : il sert tout de suite. Un
   * distant qui refuse la clé du dépôt rend `deployKey` (rien n'est déclaré) ; un nom
   * ou une URL invalide, un clone impossible : 400.
   */
  declare(url: string, name?: string): Promise<RepoDeclared> {
    return this.#serial(async () => {
      const file = this.#requireFile();
      const remote = url.trim();
      if (!REMOTE_URL.test(remote))
        throw new HarnessError(400, "url : un distant SSH (git@hôte:chemin, ssh://…) ou HTTPS attendu");
      const repo = name ?? repoName(remote);
      const result = await addRepo(file, this.#service.config, this.#git, remote, {
        name: repo,
        keygen: this.#keygen,
        ...(this.#home !== undefined ? { home: this.#home } : {}),
      });
      if (result.code === 1) throw new HarnessError(400, result.message);
      if (result.code !== 0)
        return { repo, added: false, message: result.message, deployKey: result.deployKey, reload: null };
      const reload = await this.#reload();
      return { repo, added: reload.added.includes(repo), message: result.message, reload };
    });
  }

  /**
   * Remplace le fichier de configuration par `raw`, puis recharge. Le candidat est validé AVANT de remplacer
   * l'ancien, hors du dossier du service : refusé, c'est un 400 et rien ne change. Le fichier est réécrit sur
   * place comme `addRepo` (un fichier monté seul dans un conteneur ne se remplace pas par renommage).
   */
  async #replace(file: string, raw: unknown): Promise<ReloadSummary> {
    const content = `${JSON.stringify(raw, null, 2)}\n`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-harness-config-"));
    try {
      const candidate = path.join(dir, "config.json");
      fs.writeFileSync(candidate, content);
      loadConfig(candidate);
    } catch (err) {
      throw new HarnessError(
        400,
        `réglage refusé, rien ne change : ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.writeFileSync(file, content);
    return this.#reload();
  }

  /**
   * Change qui juge la suite complète d'un dépôt déclaré (`tests.judge`, `tests.ciTimeoutSec` ; `null` rend le
   * défaut), sans éditer le fichier à la main. Le fichier candidat est validé AVANT de remplacer l'ancien : une
   * configuration refusée (par exemple `ci` sans forge) est un 400 et rien ne change. Puis rechargement à chaud.
   */
  setTests(name: string, patch: RepoTestsPatch): Promise<RepoTestsSet> {
    return this.#serial(async () => {
      const file = this.#requireFile();
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { repos?: Record<string, unknown>[] };
      const entry = (raw.repos ?? []).find((repo) => repo.name === name);
      if (entry === undefined) throw new HarnessError(404, `dépôt non déclaré : ${name}`);
      const tests: Record<string, unknown> =
        typeof entry.tests === "object" && entry.tests !== null ? { ...(entry.tests as Record<string, unknown>) } : {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete tests[key];
        else if (value !== undefined) tests[key] = value;
      }
      entry.tests = tests;
      const reload = await this.#replace(file, raw);
      const repo = this.#service.config.repos.find((candidateRepo) => candidateRepo.name === name);
      return {
        repo: name,
        judge: repo ? testsJudge(repo) : "local",
        ciTimeoutSec: repo ? ciTimeoutSec(repo) : DEFAULT_CI_TIMEOUT_SEC,
        reload,
      };
    });
  }

  /**
   * Règle la porte d'un type de travail d'un dépôt déclaré (`repos[].autonomy.rules`) : la règle qui la règle
   * déjà change de porte, sinon une règle prudente est ajoutée (autonomy-learning.ts `rulesWith`, la même
   * modification qu'une proposition de palier). Écrit, validé et rechargé comme `setTests` : une configuration
   * refusée est un 400 et rien ne change.
   */
  setAutonomyRule(input: AutonomyRuleInput): Promise<{ repo: string; rules: AutonomyRule[] }> {
    return this.#serial(async () => {
      const file = this.#requireFile();
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { repos?: Record<string, unknown>[] };
      const entry = (raw.repos ?? []).find((repo) => repo.name === input.repo);
      if (entry === undefined) throw new HarnessError(404, `dépôt non déclaré : ${input.repo}`);
      let current: AutonomyRule[];
      try {
        current = checkAutonomy(`repos.${input.repo}.autonomy`, entry.autonomy ?? {}).rules;
      } catch (err) {
        throw new HarnessError(
          400,
          `réglage refusé, rien ne change : ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      entry.autonomy = { rules: rulesWith(current, input, this.#service.config.review.maxDiffLines) };
      await this.#replace(file, raw);
      const repo = this.#service.config.repos.find((candidate) => candidate.name === input.repo);
      return { repo: input.repo, rules: repo?.autonomy?.rules ?? [] };
    });
  }

  /**
   * Les réglages d'un dépôt déclaré, tels qu'ils servent (défauts compris), avec ce que l'humain doit voir
   * pour les juger : l'URL du distant, la clé publique de déploiement. Jamais la clé privée ni un secret : les
   * comptes (`gh`, `gitlab`, `memory`) ne portent que des NOMS de variables, et ne sont pas rendus ici.
   */
  async settings(name: string): Promise<RepoSettings> {
    const repo = this.#service.config.repos.find((candidate) => candidate.name === name);
    if (repo === undefined) throw new HarnessError(404, `dépôt non déclaré : ${name}`);
    const read = await this.#git.raw(repo.path, ["remote", "get-url", repo.remote ?? "origin"]).catch(() => null);
    const remoteUrl = read?.code === 0 && read.stdout.trim() !== "" ? read.stdout.trim() : null;
    let deployKey: DeployKey | null = null;
    if (repo.sshKey !== null && fs.existsSync(`${repo.sshKey}.pub`)) {
      try {
        deployKey = deployKeyOf(remoteUrl ?? "", repo.sshKey);
      } catch {
        deployKey = null;
      }
    }
    return {
      name: repo.name,
      mainBranch: repo.mainBranch,
      scope: repo.scope,
      merge: repo.merge,
      forge: repo.forge ?? null,
      forgeInUse: forgeKindOf(repo, remoteUrl),
      maxParallel: repo.maxParallel,
      git: repo.git ?? null,
      corporate: corporatePolicy(repo),
      atlassian: repo.atlassian === true,
      privacy: repo.privacy ?? null,
      providers: repo.providers ?? null,
      models: repo.models ?? null,
      tests: {
        touched: repo.tests.touched,
        full: repo.tests.full,
        pattern: repo.tests.pattern,
        judge: testsJudge(repo),
        ciTimeoutSec: ciTimeoutSec(repo),
      },
      checks: repo.checks,
      testImage: repo.testImage,
      preview: repo.preview !== undefined,
      autonomyRules: repo.autonomy?.rules.length ?? 0,
      remoteUrl,
      deployKey,
    };
  }

  /**
   * Change les réglages d'un dépôt déclaré sans éditer le fichier à la main : seuls les champs présents
   * changent, `null` rend le défaut. Écrit, validé et rechargé comme `setTests` : une configuration refusée
   * (par exemple `merge: "gh"` sans forge) est un 400 et rien ne change. Les commandes (tests, checks,
   * prévisualisation), les chemins et les comptes restent au fichier : ils s'exécutent ou se lisent sur le serveur.
   */
  update(name: string, patch: RepoSettingsPatch): Promise<RepoSettings> {
    return this.#serial(async () => {
      const file = this.#requireFile();
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { repos?: Record<string, unknown>[] };
      const entry = (raw.repos ?? []).find((repo) => repo.name === name);
      if (entry === undefined) throw new HarnessError(404, `dépôt non déclaré : ${name}`);
      const { tests, corporate, ...plain } = patch;
      for (const [key, value] of Object.entries(plain)) {
        if (value === null) delete entry[key];
        else if (value !== undefined) entry[key] = value;
      }
      if (corporate !== undefined) {
        const issues: Record<string, unknown> =
          typeof entry.issues === "object" && entry.issues !== null
            ? { ...(entry.issues as Record<string, unknown>) }
            : {};
        if (corporate === null) delete issues.corporate;
        else issues.corporate = corporate;
        if (Object.keys(issues).length === 0) delete entry.issues;
        else entry.issues = issues;
      }
      if (tests !== undefined) {
        const current: Record<string, unknown> =
          typeof entry.tests === "object" && entry.tests !== null
            ? { ...(entry.tests as Record<string, unknown>) }
            : {};
        for (const [key, value] of Object.entries(tests)) {
          if (value === null) delete current[key];
          else if (value !== undefined) current[key] = value;
        }
        entry.tests = current;
      }
      await this.#replace(file, raw);
      return this.settings(name);
    });
  }

  /**
   * Retire un dépôt de la configuration, puis recharge. Un dépôt qui a encore des runs vivants ou en file
   * reste servi jusqu'à leur fin (`kept`) ; son clone et sa clé restent sur le disque (le redéclarer reprend
   * la même clé, déjà posée sur la forge).
   */
  remove(name: string): Promise<RepoRemoved> {
    return this.#serial(async () => {
      const file = this.#requireFile();
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { repos?: Record<string, unknown>[] };
      const repos = raw.repos ?? [];
      if (!repos.some((repo) => repo.name === name)) throw new HarnessError(404, `dépôt non déclaré : ${name}`);
      const reload = await this.#replace(file, { ...raw, repos: repos.filter((repo) => repo.name !== name) });
      return { repo: name, kept: reload.kept.includes(name), reload };
    });
  }
}

/** Ce qu'un administrateur change dans `repos[].tests` par l'API ; `null` rend le défaut, absent ne touche pas. */
export type RepoTestsPatch = { judge?: TestJudge | null; ciTimeoutSec?: number | null };

/** Le réglage en vigueur après `setTests`, défauts compris. */
export type RepoTestsSet = { repo: string; judge: TestJudge; ciTimeoutSec: number; reload: ReloadSummary };

/**
 * Ce qu'un administrateur change d'un dépôt par l'API (`PATCH /v1/repos/{name}`) ; `null` rend le défaut,
 * absent ne touche pas. `corporate` s'écrit dans `issues.corporate`.
 */
export type RepoSettingsPatch = {
  mainBranch?: string;
  scope?: string | null;
  merge?: "local" | "gh" | null;
  forge?: ForgeKind | null;
  maxParallel?: number | null;
  git?: { name: string; email: string } | null;
  corporate?: CorporatePolicy | null;
  atlassian?: boolean | null;
  privacy?: Privacy | null;
  providers?: string[] | null;
  models?: Partial<Record<Tier, string[]>> | null;
  tests?: RepoTestsPatch;
};

/**
 * Les réglages d'un dépôt tels qu'ils servent (`GET /v1/repos/{name}`). `forge` est celle déclarée (`null` :
 * déduite), `forgeInUse` celle qui sert ; `deployKey` la clé PUBLIQUE à poser sur la forge, `null` sans clé
 * propre au dépôt. Les commandes sont rendues en lecture : elles ne se changent que dans le fichier.
 */
export type RepoSettings = {
  name: string;
  mainBranch: string;
  scope: string;
  merge: "local" | "gh";
  forge: ForgeKind | null;
  forgeInUse: ForgeKind;
  maxParallel: number | null;
  git: { name: string; email: string } | null;
  corporate: CorporatePolicy;
  atlassian: boolean;
  privacy: Privacy | null;
  providers: string[] | null;
  models: Partial<Record<Tier, string[]>> | null;
  tests: { touched: string; full: string; pattern: string | null; judge: TestJudge; ciTimeoutSec: number };
  checks: Record<string, string>;
  testImage: string | null;
  preview: boolean;
  autonomyRules: number;
  remoteUrl: string | null;
  deployKey: DeployKey | null;
};

/** Un dépôt retiré : `kept` s'il sert encore, le temps que ses runs vivants ou en file finissent. */
export type RepoRemoved = { repo: string; kept: boolean; reload: ReloadSummary };

/** Les champs que `PATCH /v1/repos/{name}` accepte ; tout autre est un 400 (les commandes, chemins et comptes restent au fichier). */
const SETTINGS_KEYS = [
  "mainBranch",
  "scope",
  "merge",
  "forge",
  "maxParallel",
  "git",
  "corporate",
  "atlassian",
  "privacy",
  "providers",
  "models",
  "tests",
] as const;

/** Une branche que git accepte et ne lit pas comme une option. */
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T | null | undefined {
  if (value === undefined || value === null) return value;
  if (!(allowed as readonly unknown[]).includes(value))
    throw new HarnessError(400, `${field} : ${allowed.map((option) => `"${option}"`).join(" | ")} ou null`);
  return value as T;
}

function names(field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === ""))
    throw new HarnessError(400, `${field} : une liste de noms attendue`);
  return (value as string[]).map((item) => item.trim());
}

/**
 * Le corps de `PATCH /v1/repos/{name}` lu champ par champ : la forme ici, le sens (forge exigée par `gh` ou
 * `ci`, fournisseurs de la liste blanche, `local-only`) par la validation de la configuration candidate.
 */
export function repoSettingsPatch(body: Record<string, unknown>): RepoSettingsPatch {
  const unknown = Object.keys(body).filter((key) => !(SETTINGS_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new HarnessError(400, `champ(s) non modifiable(s) par l'API : ${unknown.join(", ")}`);
  if (Object.keys(body).length === 0) throw new HarnessError(400, "rien à changer");
  const patch: RepoSettingsPatch = {};
  if (body.mainBranch !== undefined) {
    if (typeof body.mainBranch !== "string" || !BRANCH.test(body.mainBranch.trim()))
      throw new HarnessError(400, "mainBranch : un nom de branche attendu");
    patch.mainBranch = body.mainBranch.trim();
  }
  if (body.scope !== undefined) {
    if (body.scope !== null && (typeof body.scope !== "string" || /[\n\r]/.test(body.scope) || body.scope.length > 200))
      throw new HarnessError(400, "scope : une ligne de 200 caractères au plus, ou null");
    const scope = typeof body.scope === "string" ? body.scope.trim() : null;
    patch.scope = scope === "" ? null : scope;
  }
  const merge = oneOf("merge", body.merge, ["local", "gh"] as const);
  if (merge !== undefined) patch.merge = merge;
  const forge = oneOf("forge", body.forge, FORGES);
  if (forge !== undefined) patch.forge = forge;
  if (body.maxParallel !== undefined) {
    if (body.maxParallel !== null && !(Number.isInteger(body.maxParallel) && (body.maxParallel as number) >= 1))
      throw new HarnessError(400, "maxParallel : entier ≥ 1, ou null");
    patch.maxParallel = body.maxParallel as number | null;
  }
  if (body.git !== undefined) {
    const git = body.git;
    if (git === null) patch.git = null;
    else if (
      typeof git !== "object" ||
      Array.isArray(git) ||
      typeof (git as Record<string, unknown>).name !== "string" ||
      typeof (git as Record<string, unknown>).email !== "string"
    )
      throw new HarnessError(400, "git : { name, email } ou null");
    else {
      const { name, email } = git as { name: string; email: string };
      patch.git = { name: name.trim(), email: email.trim() };
    }
  }
  const corporate = oneOf("corporate", body.corporate, CORPORATE_POLICIES);
  if (corporate !== undefined) patch.corporate = corporate;
  if (body.atlassian !== undefined) {
    if (body.atlassian !== null && typeof body.atlassian !== "boolean")
      throw new HarnessError(400, "atlassian : true, false ou null");
    patch.atlassian = body.atlassian === true ? true : null;
  }
  const privacy = oneOf("privacy", body.privacy, PRIVACIES);
  if (privacy !== undefined) patch.privacy = privacy;
  if (body.providers !== undefined)
    patch.providers = body.providers === null ? null : names("providers", body.providers);
  if (body.models !== undefined) {
    const models = body.models;
    if (models === null) patch.models = null;
    else if (typeof models !== "object" || Array.isArray(models))
      throw new HarnessError(400, `models : { ${TIERS.join(", ")} } ou null`);
    else {
      const chains: Partial<Record<Tier, string[]>> = {};
      for (const [tier, chain] of Object.entries(models as Record<string, unknown>)) {
        if (!(TIERS as readonly string[]).includes(tier))
          throw new HarnessError(400, `models.${tier} : tier inconnu (${TIERS.join(" | ")})`);
        const list = names(`models.${tier}`, chain);
        if (list.length > 0) chains[tier as Tier] = list;
      }
      patch.models = Object.keys(chains).length === 0 ? null : chains;
    }
  }
  if (body.tests !== undefined) {
    const tests = body.tests;
    if (typeof tests !== "object" || tests === null || Array.isArray(tests))
      throw new HarnessError(400, "tests : un objet { judge?, ciTimeoutSec? } attendu");
    const fields = tests as Record<string, unknown>;
    const locked = Object.keys(fields).filter((key) => key !== "judge" && key !== "ciTimeoutSec");
    if (locked.length > 0) throw new HarnessError(400, `tests : champ(s) non modifiable(s) ici : ${locked.join(", ")}`);
    const judge = oneOf("tests.judge", fields.judge, TEST_JUDGES);
    const { ciTimeoutSec: timeout } = fields;
    if (timeout !== undefined && timeout !== null && !(Number.isInteger(timeout) && (timeout as number) >= 1))
      throw new HarnessError(400, "tests.ciTimeoutSec : entier ≥ 1 (secondes) ou null");
    patch.tests = {
      ...(judge !== undefined ? { judge } : {}),
      ...(timeout !== undefined ? { ciTimeoutSec: timeout as number | null } : {}),
    };
  }
  return patch;
}
