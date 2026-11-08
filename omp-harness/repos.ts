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
import type { HarnessConfig, RepoConfig } from "./config.ts";
import { loadConfig } from "./config.ts";
import { HarnessError } from "./errors.ts";
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

/** La clé publique du dépôt et, sur GitHub, la page des clés de déploiement. */
function deployKeyOf(url: string, key: string): DeployKey {
  const github = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/*$/.exec(url);
  return {
    publicKey: fs.readFileSync(`${key}.pub`, "utf8").trim(),
    url: github ? `https://github.com/${github[1]}/${github[2]}/settings/keys/new` : null,
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
  return {
    code: 0,
    message: `${name} ajouté — tests : « ${plan.full} »${plan.testImage ? ` dans ${plan.testImage}` : ""}`,
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
}
