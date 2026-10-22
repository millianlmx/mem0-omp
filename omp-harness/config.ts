// La configuration du harness : un fichier JSON unique, complété par des défauts, validé au démarrage.
//
// Les valeurs par défaut SONT le budget du schéma d'architecture (VPS 32 Go, ~16 Go
// pour le harness) : 5 runners plafonnés à 1 Go, 2 slots heavy à 4 Go, 1 Go pour le
// service — 5 + 8 + 1 = 14 Go, 2 Go de marge. Un fichier de configuration ne fait
// que les surcharger.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { STEP_KINDS } from "./machine.ts";
import type { StepKind } from "./machine.ts";


/** Les familles de modèles, de la moins chère à la plus capable. */
export type Tier = "fast" | "standard" | "heavy";

export const TIERS: readonly Tier[] = ["fast", "standard", "heavy"];

/**
 * Le tier de chaque étape par défaut : un gros modèle là où l'on juge (cerner le
 * besoin, écrire les specs, relire avant l'auto-merge), un modèle moyen là où l'on
 * exécute des specs précises (/impl, /impl --fix).
 */
export const DEFAULT_STEP_TIERS: Readonly<Record<StepKind, Tier>> = {
  req: "heavy",
  specs: "heavy",
  impl: "standard",
  fix: "standard",
  review: "heavy",
};

/** Un modèle d'un fournisseur : la liste ordonnée d'un tier est sa chaîne de bascule. */
export type ModelChoice = { provider: string; model: string };

/** Le seau à jetons d'un fournisseur : `capacity` requêtes d'avance, `refillPerMinute` par minute. */
export type ProviderLimit = { capacity: number; refillPerMinute: number };

/**
 * L'isolation d'un process : `systemd` (VPS installé par install.sh ou le module
 * NixOS), `container` (un conteneur Docker ou podman par runner et par job, le
 * déploiement par compose), `none` en développement et en test.
 */
export type Isolation = "systemd" | "container" | "none";

export type RepoConfig = {
  /** Le nom par lequel l'API désigne le dépôt — jamais un chemin fourni par le client. */
  name: string;
  /** Le clone que le harness possède : `main` n'y est pas extraite (clone nu ou dédié). */
  path: string;
  /**
   * La scope mem0 de l'oracle (identité de PROJET, partagée avec le plugin mémoire).
   * Vide : lue au démarrage dans les manifestes de `main`, comme le fait le plugin.
   */
  scope: string;
  mainBranch: string;
  /** Les commandes de test ; `{files}` reçoit les fichiers touchés, cités pour le shell. */
  tests: { touched: string; full: string };
  /** `local` : squash + update-ref sur `main` ; `gh` : PR puis `gh pr merge --squash`. */
  merge: "local" | "gh";
  /** Le remote poussé après un merge local, ou `null` (aucun push). */
  remote: string | null;
  /** L'image des tests de ce dépôt en isolation `container` ; `null` : `container.testImage`. */
  testImage: string | null;
  /**
   * Les runs de ce dépôt vivants en même temps, au plus (`null` : seuls les slots et
   * les modules bornent). Un gros dépôt ne prend pas tous les runners aux autres.
   */
  maxParallel: number | null;
};

export type HarnessConfig = {
  listen: { host: string; port: number };
  /** Le fichier du jeton d'API (créé en 0600 au premier démarrage s'il manque) : le client `admin` historique. */
  tokenFile: string;
  /** Les clients nommés (jetons hachés, rôles, dépôts permis), gérés par `--add-client` (auth.ts). */
  clientsFile: string;
  /** La base SQLite et les overlays de réglages des runners. */
  dataDir: string;
  /** Les worktrees git, un par run. */
  worktreesDir: string;
  ompBin: string;
  /**
   * Le préfixe de tout `systemd-run` / `systemctl stop` en isolation `systemd` : le
   * lanceur root (via sudo) qui VALIDE la ligne avant de l'exécuter. Vide : appel
   * direct (service lancé par root, ou polkit déjà configuré).
   */
  launcher: string[];
  git: { authorName: string; authorEmail: string };
  runner: {
    slots: number;
    memoryMax: string;
    oomScoreAdjust: number;
    slice: string;
    isolation: Isolation;
    /** Le profil OMP isolé des runners (réglages, caches, sessions). */
    profile: string;
    /** Le nombre de relances d'une étape qui a échoué sans verdict. */
    stepRetries: number;
    /**
     * La durée maximale d'une étape, prompts et relances compris : au-delà, le runner
     * est arrêté et l'étape échoue (relançable). Un agent qui boucle ne garde pas son
     * slot indéfiniment.
     */
    stepTimeoutSec: number;
    /**
     * Les extensions chargées par chaque runner (`-e`) — d'abord le plugin mémoire
     * `omp-mem0-memory/extension.ts` : rappel automatique dans la mémoire du projet.
     */
    extensions: string[];
  };
  heavy: {
    slots: number;
    memoryMax: string;
    cpuQuota: string;
    user: string;
    oomScoreAdjust: number;
    slice: string;
    isolation: Isolation;
    /** Les relances après un OOM : un OOM est un job raté, jamais la box. */
    oomRetries: number;
    timeoutSec: number;
    /** Variables posées dans le job heavy — la SEULE porte d'entrée de son environnement. */
    env: Record<string, string>;
    /** Le dossier des `CARGO_TARGET_DIR` (un sous-dossier par worktree). */
    cargoTargetRoot: string | null;
    /** Les chemins inscriptibles en plus du worktree (caches sccache, store pnpm, HOME du user heavy). */
    readWritePaths: string[];
    /** Le bash qui lance la commande d'un job : `/bin/bash`, ou son chemin du store sous NixOS. */
    shell: string;
  };
  /**
   * L'isolation `container` : chaque runner et chaque job de tests est un conteneur
   * frère, lancé par le CLI du moteur (Docker, ou podman et son API compatible). Les
   * chemins des worktrees, des clones et de l'état sont ceux de l'HÔTE : le service
   * les voit au même endroit (montage identique), le moteur les monte tels quels.
   */
  container: {
    /** Le CLI du moteur : `["docker"]` ou `["podman"]`. */
    command: string[];
    /** L'image des runners : omp épinglé, git, le plugin mémoire. */
    runnerImage: string;
    /** L'image des tests par défaut ; un dépôt la remplace par `testImage`. */
    testImage: string;
    /** Le réseau des runners (celui du compose, qui porte la mémoire) ; les tests n'en ont aucun. */
    network: string | null;
    /** Le fichier de l'hôte monté dans chaque runner (clés LLM, jeton mem0), lu par son entrée. */
    runnerEnvFile: string | null;
    /** Le dossier de l'hôte monté en HOME des runners (connexion OMP, profil). */
    runnerHome: string | null;
    /** `uid:gid` des conteneurs ; `null` : celui du service. */
    user: string | null;
  };
  /** Admission sur `MemAvailable` : un process ne démarre que s'il laisse `reserveMiB` libres. */
  admission: { reserveMiB: number; runnerMiB: number; heavyMiB: number };
  /** La chaîne de bascule de chaque tier ; une chaîne vide prend celle du tier au-dessus. */
  models: Record<Tier, ModelChoice[]>;
  /** Le tier de chaque étape (la dernière correction avant le plafond passe toujours en heavy). */
  stepTiers: Record<StepKind, Tier>;
  providers: Record<string, ProviderLimit>;
  /** `specsGate` : la feature attend l'accord humain entre /specs et /impl. */
  review: { fixCap: number; maxDiffLines: number; specsGate: boolean };
  oracle: { url: string; token: string | null } | null;
  /** Le journal d'événements : au-delà de `retentionDays`, il est purgé (au démarrage, puis chaque heure). */
  events: { retentionDays: number };
  repos: RepoConfig[];
};


/** Le lanceur installé par `deploy/install.sh`. */
/** Jamais `-E` : sudo remet l'environnement à zéro, le lanceur ajoute lui-même les clés des runners. */
export const DEFAULT_LAUNCHER: readonly string[] = ["sudo", "-n", "/usr/local/libexec/omp-harness-systemd-run"];


/** La ligne d'un `systemd-run` (ou de `--stop <unité>`) derrière le lanceur configuré. */
export function launch(config: HarnessConfig, args: string[]): { command: string; args: string[] } {
  if (config.launcher.length === 0) {
    return args[0] === "--stop" ? { command: "systemctl", args: ["stop", ...args.slice(1)] } : { command: "systemd-run", args };
  }
  return { command: config.launcher[0] as string, args: [...config.launcher.slice(1), ...args] };
}


/** Le budget pire cas en Mio : runners + heavy + service. */
export function worstCaseBudgetMiB(config: HarnessConfig, serviceMiB = 1024): number {
  return config.runner.slots * sizeMiB(config.runner.memoryMax) + config.heavy.slots * sizeMiB(config.heavy.memoryMax) + serviceMiB;
}


/** La chaîne de bascule d'un tier : la sienne, sinon celle du premier tier au-dessus qui en a une. */
export function modelChain(config: HarnessConfig, tier: Tier): ModelChoice[] {
  for (const candidate of TIERS.slice(TIERS.indexOf(tier))) if (config.models[candidate].length > 0) return config.models[candidate];
  return [];
}


/** Une taille systemd (`512M`, `4G`) en Mio. */
export function sizeMiB(size: string): number {
  const match = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(size.trim());
  if (!match) throw new Error(`taille illisible : ${size}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? "").toUpperCase();
  const factor = unit === "K" ? 1 / 1024 : unit === "M" ? 1 : unit === "G" ? 1024 : unit === "T" ? 1024 * 1024 : 1 / (1024 * 1024);
  return Math.round(value * factor);
}


export function defaultConfig(base = path.join(os.homedir(), ".omp-harness")): HarnessConfig {
  return {
    listen: { host: "127.0.0.1", port: 8790 },
    tokenFile: path.join(base, "token"),
    clientsFile: path.join(base, "clients.json"),
    dataDir: base,
    worktreesDir: path.join(base, "worktrees"),
    ompBin: "omp",
    launcher: [...DEFAULT_LAUNCHER],
    git: { authorName: "omp-harness", authorEmail: "omp-harness@localhost" },
    runner: {
      slots: 5,
      memoryMax: "1G",
      oomScoreAdjust: 300,
      slice: "omp-harness-runners.slice",
      isolation: "systemd",
      profile: "pipeline",
      stepRetries: 1,
      stepTimeoutSec: 5400,
      extensions: [],
    },
    heavy: {
      slots: 2,
      memoryMax: "4G",
      cpuQuota: "300%",
      user: "omp-heavy",
      oomScoreAdjust: 800,
      slice: "omp-harness-heavy.slice",
      isolation: "systemd",
      oomRetries: 2,
      timeoutSec: 1800,
      env: {},
      cargoTargetRoot: null,
      readWritePaths: [],
      shell: "/bin/bash",
    },
    container: {
      command: ["docker"],
      runnerImage: "omp-harness-runner:local",
      testImage: "docker.io/library/node:22-bookworm",
      network: null,
      runnerEnvFile: null,
      runnerHome: null,
      user: null,
    },
    admission: { reserveMiB: 2048, runnerMiB: 1024, heavyMiB: 4096 },
    models: { fast: [], standard: [], heavy: [] },
    stepTiers: { ...DEFAULT_STEP_TIERS },
    providers: {},
    review: { fixCap: 3, maxDiffLines: 300, specsGate: true },
    oracle: null,
    events: { retentionDays: 30 },
    repos: [],
  };
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


/** Fusion profonde des objets ; les tableaux et scalaires de `over` remplacent ceux de `base`. */
function merge<T>(base: T, over: unknown): T {
  if (!isRecord(base) || !isRecord(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = merge((base as Record<string, unknown>)[key], value);
  return out as T;
}


function fail(message: string): never {
  throw new Error(`configuration du harness : ${message}`);
}


function checkModels(tier: string, list: unknown): ModelChoice[] {
  if (!Array.isArray(list)) fail(`models.${tier} doit être une liste`);
  return list.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.provider !== "string" || typeof entry.model !== "string") {
      fail(`models.${tier}[${index}] : { provider, model } attendus`);
    }
    return { provider: entry.provider, model: entry.model };
  });
}


/** Valide une configuration complète ; lève une erreur NOMMÉE au premier défaut. */
export function validateConfig(config: HarnessConfig): HarnessConfig {
  if (!Number.isInteger(config.listen.port) || config.listen.port < 0 || config.listen.port > 65535) fail("listen.port invalide");
  if (!Number.isInteger(config.runner.slots) || config.runner.slots < 1) fail("runner.slots doit être ≥ 1");
  if (!Number.isInteger(config.heavy.slots) || config.heavy.slots < 1) fail("heavy.slots doit être ≥ 1");
  if (!(config.runner.stepTimeoutSec >= 1)) fail("runner.stepTimeoutSec doit être ≥ 1");
  if (!(config.events.retentionDays > 0)) fail("events.retentionDays doit être > 0");
  sizeMiB(config.runner.memoryMax);
  sizeMiB(config.heavy.memoryMax);
  if (!/^\d+%$/.test(config.heavy.cpuQuota)) fail("heavy.cpuQuota doit être un pourcentage (300%)");
  if (typeof config.heavy.shell !== "string" || !path.isAbsolute(config.heavy.shell)) fail("heavy.shell doit être un chemin absolu");
  for (const isolation of [config.runner.isolation, config.heavy.isolation]) {
    if (isolation !== "systemd" && isolation !== "container" && isolation !== "none") fail(`isolation inconnue : ${String(isolation)}`);
  }
  if (!Array.isArray(config.container.command) || config.container.command.length === 0) fail("container.command : le CLI du moteur, par exemple [\"docker\"]");
  for (const [key, value] of [["runnerEnvFile", config.container.runnerEnvFile], ["runnerHome", config.container.runnerHome]] as const) {
    if (value !== null && !path.isAbsolute(value)) fail(`container.${key} doit être un chemin absolu de l'hôte`);
  }
  for (const key of Object.keys(config.models)) if (!(TIERS as readonly string[]).includes(key)) fail(`models.${key} : tier inconnu (${TIERS.join(" | ")})`);
  for (const tier of TIERS) config.models[tier] = checkModels(tier, config.models[tier]);
  for (const [step, tier] of Object.entries(config.stepTiers)) {
    if (!(STEP_KINDS as readonly string[]).includes(step)) fail(`stepTiers.${step} : étape inconnue (${STEP_KINDS.join(" | ")})`);
    if (!(TIERS as readonly string[]).includes(tier)) fail(`stepTiers.${step} : tier inconnu (${TIERS.join(" | ")})`);
  }
  for (const [provider, limit] of Object.entries(config.providers)) {
    if (!(limit.capacity >= 1) || !(limit.refillPerMinute > 0)) fail(`providers.${provider} : capacity ≥ 1 et refillPerMinute > 0`);
  }
  const names = new Set<string>();
  for (const repo of config.repos) {
    if (typeof repo.name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(repo.name)) fail(`nom de dépôt invalide : ${String(repo.name)}`);
    if (names.has(repo.name)) fail(`dépôt en double : ${repo.name}`);
    names.add(repo.name);
    if (typeof repo.path !== "string" || !path.isAbsolute(repo.path)) fail(`repos.${repo.name}.path doit être absolu`);
    if (repo.merge !== "local" && repo.merge !== "gh") fail(`repos.${repo.name}.merge : local | gh`);
    if (repo.maxParallel !== null && !(Number.isInteger(repo.maxParallel) && repo.maxParallel >= 1)) fail(`repos.${repo.name}.maxParallel : entier ≥ 1, ou null`);
  }
  return config;
}


/** Les défauts d'un dépôt déclaré par son seul nom et son chemin. */
export function repoDefaults(raw: Record<string, unknown>): RepoConfig {
  const name = String(raw.name ?? "");
  return merge<RepoConfig>(
    {
      name,
      path: String(raw.path ?? ""),
      scope: "",
      mainBranch: "main",
      tests: { touched: "npm test -- {files}", full: "npm test" },
      merge: "local",
      remote: null,
      testImage: null,
      maxParallel: null,
    },
    raw,
  );
}


/** Lit le fichier de configuration (JSON), le complète et le valide. */
export function loadConfig(file: string | null): HarnessConfig {
  const base = defaultConfig();
  if (file === null) return validateConfig(base);
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(raw)) fail("la racine doit être un objet");
  const repos = Array.isArray(raw.repos) ? raw.repos.map(entry => repoDefaults(isRecord(entry) ? entry : {})) : [];
  const config = merge(base, { ...raw, repos });
  // Un `dataDir` déclaré entraîne ce qui en dépend, sauf déclaration explicite.
  if (typeof raw.dataDir === "string") {
    if (raw.tokenFile === undefined) config.tokenFile = path.join(raw.dataDir, "token");
    if (raw.worktreesDir === undefined) config.worktreesDir = path.join(raw.dataDir, "worktrees");
  }
  // Les clients vivent à côté du jeton historique (même dossier d'état, mêmes droits).
  if (raw.clientsFile === undefined) config.clientsFile = path.join(path.dirname(config.tokenFile), "clients.json");
  return validateConfig(config);
}


export function repoByName(config: HarnessConfig, name: string): RepoConfig | null {
  return config.repos.find(repo => repo.name === name) ?? null;
}
