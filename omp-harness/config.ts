// La configuration du harness : un fichier JSON unique, complété par des défauts, validé au démarrage.
//
// Les valeurs par défaut SONT le budget du schéma d'architecture (VPS 32 Go, ~16 Go
// pour le harness) : 5 runners plafonnés à 1 Go, 2 slots heavy à 4 Go, 1 Go pour le
// service — 5 + 8 + 1 = 14 Go, 2 Go de marge. Un fichier de configuration ne fait
// que les surcharger.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOCAL_PROVIDER } from "./local-model.ts";
import type { LogLevel } from "./logger.ts";
import { LOG_LEVELS } from "./logger.ts";
import { STEP_KINDS } from "./machine.ts";
import type { StepKind } from "./machine.ts";
import { checkAutonomy } from "./autonomy-rules.ts";
import type { AutonomyRule } from "./autonomy-rules.ts";
import { isTimeZone } from "./cron.ts";

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

/** Les étapes qu'un contradicteur peut relire : celles qui écrivent le contrat (besoins, specs). */
export type ChallengeStep = "req" | "specs";

export const CHALLENGE_STEPS: readonly ChallengeStep[] = ["req", "specs"];

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

/** Les causes d'échec d'un prompt qui peuvent faire basculer sur le fournisseur suivant. */
export type FailoverCause = "rate_limit" | "server_error" | "network";

export const FAILOVER_CAUSES: readonly FailoverCause[] = ["rate_limit", "server_error", "network"];

/** L'attente avant chaque relance d'une étape échouée : 2, 10 puis 30 minutes. */
export const DEFAULT_RETRY_BACKOFF_SEC: readonly number[] = [120, 600, 1800];

/** Les événements notifiés par défaut : ce qui attend l'humain, et ce qui finit. */
export const DEFAULT_NOTIFY_EVENTS: readonly string[] = [
  "escalations",
  "specs_ready",
  "verdict",
  "run_failed",
  "project_done",
  "merged",
  "stalled",
  "budget_exceeded",
  "daily_budget_reached",
  "workstation_approval",
  "workstation_account",
  "pilot",
  "backup_failed",
  // La vigie : ce qu'elle rend à l'humain (notificationFor ne dit rien d'autre), et son silence.
  "vigie_incident",
  "vigie_silent",
];

/**
 * La confidentialité d'un dépôt (ou des jobs du poste) : `local-only` ne laisse partir
 * ses prompts que vers le modèle local (`omlx`, local-model.ts) et retire aux runners
 * les clés des fournisseurs distants ; `standard` (défaut) n'impose rien.
 */
export type Privacy = "standard" | "local-only";

export const PRIVACIES: readonly Privacy[] = ["standard", "local-only"];

/** Les forges des PR et des issues d'un dépôt (forge.ts). */
export type ForgeKind = "github" | "gitlab" | "none";

export const FORGES: readonly ForgeKind[] = ["github", "gitlab", "none"];

/**
 * Ce qu'une issue d'origine corpo (un signalement d'un collègue) peut contenir, par dépôt :
 * `forbid` aucune issue, `redacted` un texte reformulé et caviardé par le serveur (défaut),
 * `full` le texte confirmé, seulement si la forge confirme le dépôt privé.
 */
export type CorporatePolicy = "forbid" | "redacted" | "full";

export const CORPORATE_POLICIES: readonly CorporatePolicy[] = ["forbid", "redacted", "full"];

/** La politique d'issues d'origine corpo d'un dépôt : celle qu'il déclare, sinon `redacted`. */
export function corporatePolicy(repo: Pick<RepoConfig, "issues">): CorporatePolicy {
  return repo.issues?.corporate ?? "redacted";
}

/**
 * La politique de modèles d'un dépôt ou du poste (policy.ts) : des chaînes par tier
 * (`"fournisseur/modèle"`, prioritaires sur celles du serveur), une liste blanche de
 * fournisseurs (jamais de bascule hors de la liste) et la confidentialité. Absente :
 * les chaînes du serveur, comme avant.
 */
export type ModelPolicy = {
  models?: Partial<Record<Tier, string[]>>;
  providers?: string[];
  privacy?: Privacy;
};

/**
 * Une cible des notifications sortantes : `ntfy` (corps texte, en-têtes `Title`, `Priority`,
 * `Tags`, `Click`) ou `webhook` (un POST JSON `{title, body, priority, tags, click, event,
 * runId, repo, at}`). `headers` : des en-têtes en plus (un jeton d'accès, par exemple).
 */
export type NotifyTarget = { kind: "ntfy" | "webhook"; url: string; headers: Record<string, string> };

/**
 * La copie hors machine de chaque instantané : `command` (argv, sans shell) où `{file}`
 * reçoit le chemin de l'instantané et `{name}` son nom ; sans `{file}`, le chemin est
 * ajouté en dernier argument. Le chiffrement est l'affaire de l'outil (restic, rclone crypt).
 */
export type BackupRemote = { command: string[]; timeoutSec: number };

/**
 * Le poste de travail (workstation.ts) : l'extension Chrome observe et agit dans le
 * navigateur, l'agent 24/24 du serveur y fait de petites actions. `enabled: false` coupe
 * les routes `/v1/workstation*` (404) et les jobs de l'agent.
 */
export type WorkstationConfig = {
  enabled: boolean;
  /** Les heures d'observation après lesquelles l'autonomie `auto` passe de `observe` à `act`. */
  thresholdHours: number;
  /** Observations et segments de transcript plus vieux sont purgés. */
  retentionDays: number;
  /** Une action louée par l'extension sans résultat au-delà de ce délai passe `failed`. */
  actionTimeoutSec: number;
  /** Une action en attente d'approbation au-delà de ce délai passe `expired` (vaut refus, jamais approuvée). */
  approvalTtlHours: number;
  /** Le repos entre deux services de l'agent 24/24 (minutes). */
  shiftEveryMin: number;
  /** Les actions (décisions comprises) qu'un service dépose au plus. */
  shiftMaxActions: number;
  /** Le profil est resynthétisé au plus toutes les `profileEveryHours` heures, s'il y a du neuf. */
  profileEveryHours: number;
  /** La politique de modèles des jobs `poste-profil`, `poste-digest` et `poste-service` (données sensibles). */
  policy?: ModelPolicy;
  /**
   * Les hôtes où l'agent navigue sans approbation (`open`, `navigate`), sous-domaines
   * compris ; vide : tout hôte (hors sites exclus par l'extension). Un hôte hors de la
   * liste attend l'approbation humaine.
   */
  allowedHosts: string[];
  /**
   * La garde anti-exfiltration de l'agent 24/24 en autonomie : une adresse vers un hôte
   * jamais observé ni listé dans `allowedHosts`, ou dont la query porte une valeur
   * longue ou opaque, attend l'approbation humaine. `false` la coupe.
   */
  exfiltrationGuard: boolean;
  /** Les captures d'écran gardées par action, en heures (JPEG tel que capturé). */
  captureRetentionHours: number;
  /**
   * Le navigateur du poste sur le VPS (`obscura-poste`, browserId `vps`) : son URL et son jeton
   * CDP, complétés depuis l'environnement (`OBSCURA_POSTE_CDP_URL`, `OBSCURA_POSTE_CDP_TOKEN`) quand
   * le fichier ne les donne pas. `url` null : l'exécuteur `vps` ne démarre pas.
   */
  vps: { url: string | null; token: string | null };
  /** Le repos entre deux passages de lecture des canaux corpo (Gmail, Agenda, Slack), en minutes. */
  channelReadEveryMin: number;
  /** La veille proactive (job `poste-veille`, canaux/veille.ts). */
  watch: WatchConfig;
};

/** Les jours de la semaine des heures ouvrées, dans l'ordre de `Date.getUTCDay()`. */
export const WEEK_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

/**
 * La veille proactive du poste : un passage toutes les `intervalMinutes` minutes aux heures
 * ouvrées (`days`, de `start` à `end`, heure murale de `schedules.timezone`), plus les passages
 * des 15 minutes avant l'ouverture, qui ne préparent que les réunions du début de plage.
 */
export type WatchConfig = {
  /** De 1 à 15. */
  intervalMinutes: number;
  days: WeekDay[];
  /** `HH:MM`, avant `end`. */
  start: string;
  end: string;
  /** Le silence (en jours ouvrés) après lequel un mail de l'utilisateur sans réponse est relancé. */
  followUpDays: number;
};

/** Le monitoring : plafond de coût, veille des features muettes ou lentes, santé du serveur. */
export type MonitoringConfig = {
  /** Le coût (en dollars) d'une feature au-delà duquel l'humain est prévenu (`budget_exceeded`) ; `null` : jamais. */
  runBudgetUsd: number | null;
  /**
   * Au-delà du budget, la feature attend l'humain au lieu de continuer : l'étape en cours
   * est arrêtée dès que le coût la franchit (une étape peut durer `stepTimeoutSec`).
   */
  pauseOnBudget: boolean;
  /**
   * Le plafond de dépense de TOUT le serveur sur un jour UTC (runs et audits, en dollars) :
   * atteint, aucune nouvelle étape ni analyse ne part avant minuit UTC ou un plafond relevé
   * (`daily_budget_reached`) ; les étapes en cours finissent. `null` : aucun plafond.
   */
  dailyBudgetUsd: number | null;
  /** Les minutes sans trame d'un agent (aucun outil en cours) avant l'alerte `stalled` ; `null` : jamais. */
  stallMin: number | null;
  /** Les mêmes minutes quand un outil tourne (une suite de tests peut être longue) ; `null` : jamais. */
  stallToolMin: number | null;
  /** Une étape plus longue que `slowFactor` × la médiane de son type alerte (`step_slow`) ; `null` : jamais. */
  slowFactor: number | null;
  /** À partir de ce nombre de corrections, la boucle revue ⇄ correction alerte (`fix_loop`) ; `null` : jamais. */
  fixLoop: number | null;
  /** La santé du serveur : un point toutes les `sampleSec` secondes, les `keep` derniers gardés. */
  sampleSec: number;
  keep: number;
};

/**
 * Les seuils des propositions de palier d'autonomie (autonomy-learning.ts) : sur `windowDays`
 * jours, un groupe (dépôt, type, porte) d'au moins `minRuns` runs reçoit une proposition de
 * baisse si son taux de corrections vaut `lowerMinRate` ou plus, de montée s'il vaut `raiseMaxRate`
 * ou moins. Le harness ne change jamais une règle seul.
 */
export type AutonomyLearningConfig = {
  windowDays: number;
  minRuns: number;
  raiseMaxRate: number;
  lowerMinRate: number;
};

/** L'envoi des notifications push d'Apple (Live Activities de l'app iOS) : `null` les coupe. */
export type ApnsConfig = {
  /** La clé `.p8` d'Apple (fichier de l'hôte, 0600). */
  keyFile: string;
  keyId: string;
  teamId: string;
  /** L'identifiant de l'app iOS (`com.omp.console.ios`) : le sujet des pushes. */
  topic: string;
  /** `true` : la passerelle de développement (app installée depuis Xcode). */
  sandbox: boolean;
};

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
  /**
   * Les commandes de test ; `{files}` reçoit les fichiers touchés, cités pour le
   * shell. `pattern` : le glob des fichiers de test (`test/**\/*.test.ts`) qui filtre
   * `{files}` ; `null` = pas de filtre.
   */
  tests: { touched: string; full: string; pattern: string | null };
  /** Les commandes nommées (`{ "lint": "bash scripts/lint.sh" }`) que `run_tests scope:"check"` lance. */
  checks: Record<string, string>;
  /**
   * `local` : squash + update-ref sur `main` ; `gh` : une PR (une MR sur GitLab) posée sur la
   * forge du dépôt (`forge`), fusionnée par elle en squash.
   */
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
  /**
   * La clé SSH PRIVÉE de ce dépôt (chemin absolu) pour tout appel au distant : GitHub
   * refuse une même clé de déploiement sur deux dépôts. `null` : l'identité du service.
   */
  sshKey: string | null;
  /** L'identité des commits de ce dépôt (WIP, squash de merge, revert) ; absente : `git` du serveur. */
  git?: { name: string; email: string };
  /**
   * Le compte GitHub de ce dépôt pour `gh` (PR, merge, issues, MCP) : `configDir` est le
   * `GH_CONFIG_DIR` d'une connexion `gh auth login` propre, `tokenEnv` le NOM d'une variable
   * du service qui porte son jeton. Absent : la connexion (ou `GH_TOKEN`) du service.
   */
  gh?: { configDir?: string; tokenEnv?: string };
  /**
   * La forge des PR et des issues (forge.ts) : `github` (`gh`), `gitlab` (`glab`) ou `none`
   * (merge local seulement, pas d'issues). Absente : déduite de l'URL du distant
   * (github.com → github ; un hôte qui contient « gitlab », ou un bloc `gitlab` → gitlab ;
   * sinon none).
   */
  forge?: ForgeKind;
  /** Les issues d'origine corpo de ce dépôt : `corporate` (`redacted` par défaut). */
  issues?: { corporate?: CorporatePolicy };
  /**
   * Le GitLab de ce dépôt pour `glab` : `host` l'instance (`gitlab.client.example`, ou son
   * URL ; absente : l'hôte du distant), `tokenEnv` le NOM d'une variable du service qui
   * porte son jeton, `configDir` le `GLAB_CONFIG_DIR` d'une connexion `glab auth login`
   * propre. Sans jeton ni connexion propres : celle du service.
   */
  gitlab?: { host?: string; tokenEnv?: string; configDir?: string };
  /**
   * Le jeton mémoire de ce dépôt : `tokenEnv` est le NOM d'une variable du service qui
   * porte un jeton mem0-rs limité à sa scope (`MEM0_HTTP_TOKENS`). Ses runners le
   * reçoivent au lieu du jeton global. Absent : le jeton global.
   */
  memory?: { tokenEnv?: string };
  /**
   * La prévisualisation de ce dépôt pour la QA de /review (browser/qa.ts) : `command` la lance dans
   * un conteneur de l'image des tests, sans réseau, depuis le worktree du run (isolation `container`
   * seulement) ; `port` est celui qu'elle écoute ; `path` sa page d'accueil, capturée d'office ;
   * `readyTimeoutSec` le temps qu'elle a pour répondre. Absente : pas de QA navigateur.
   */
  preview?: { command: string; port: number; path: string; readyTimeoutSec: number };
  /**
   * L'autonomie par paliers (autonomy-rules.ts) : des règles ordonnées, la première qui
   * correspond à un run décide si le serveur lève seul son attente `specs` ou `verdict`.
   * Absent : tout reste à l'humain.
   */
  autonomy?: { rules: AutonomyRule[] };
} & ModelPolicy;

export type HarnessConfig = {
  listen: { host: string; port: number };
  /** Le fichier du jeton d'API (créé en 0600 au premier démarrage s'il manque) : le client `admin` historique. */
  tokenFile: string;
  /** Les clients nommés (jetons hachés, rôles, dépôts permis), gérés par `--add-client` (auth.ts). */
  clientsFile: string;
  /** Les canaux corpo (canaux/) : identifiants des clients OAuth et jetons Gmail, Agenda, Slack (0600, hors base). */
  channelsFile: string;
  /**
   * Les fournisseurs déclarés par l'API (providers.ts) : leurs clés (`*_API_KEY`, 0600) et
   * le `models.yml` des fournisseurs compatibles OpenAI, que le lanceur pose chez les runners.
   */
  providersEnvFile: string;
  providersModelsFile: string;
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
    /**
     * Le nombre de relances d'une étape qui a échoué sans verdict ; absent, c'est la
     * longueur de `retryBackoffSec`.
     */
    stepRetries: number;
    /** L'attente (s) avant chaque relance : la n-ième relance attend `retryBackoffSec[n]`. */
    retryBackoffSec: number[];
    /** Les causes d'échec d'un prompt qui font basculer sur le fournisseur suivant de la chaîne. */
    failoverOn: FailoverCause[];
    /**
     * La durée maximale d'une étape, prompts et relances compris : au-delà, le runner
     * est arrêté et l'étape échoue (relançable). Un agent qui boucle ne garde pas son
     * slot indéfiniment.
     */
    stepTimeoutSec: number;
    /**
     * Les extensions chargées par chaque runner (`-e`) EN PLUS du plugin mémoire
     * (`omp-mem0-memory/extension.ts`), que la pile charge toujours (`runnerExtensions`).
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
  /**
   * `specsGate` : la feature attend l'accord humain entre /specs et /impl (`"auto"` :
   * seulement si les specs découpent, laissent les modules vides ou touchent à
   * l'irréversible). `autoMergeRisk` : le risque le plus haut qui s'auto-merge.
   * `diffCount` : les lignes comptées face à `maxDiffLines` (`code` exclut tests, docs
   * et manifestes). `escalationTimeoutSec` : passé ce délai, une escalade ouverte est
   * tranchée sur la recommandation de l'agent (`null` : jamais). `mergeRetries` : les
   * merges arrêtés tolérés avant l'humain. `mergePollSec` / `mergeWaitSec` : en mode
   * `gh`, la cadence de relecture de la PR après `gh pr merge --auto` et l'attente
   * maximale de sa fusion (les checks requis de la branche protégée). `crossProvider` :
   * la revue tourne de préférence chez un autre fournisseur que celui qui a implémenté.
   */
  review: {
    fixCap: number;
    maxDiffLines: number;
    specsGate: boolean | "auto";
    autoMergeRisk: "low" | "medium";
    diffCount: "all" | "code";
    escalationTimeoutSec: number | null;
    mergeRetries: number;
    mergePollSec: number;
    mergeWaitSec: number;
    crossProvider: boolean;
  };
  /**
   * Le contradicteur : en fin de /req et de /specs, un agent neuf (autre contexte, autre
   * fournisseur si la chaîne en a un) relit l'artefact pour le prendre en défaut ;
   * l'auteur corrige ou réfute chaque point. `steps` vide le coupe.
   */
  challenge: { steps: ChallengeStep[]; tier: Tier };
  /**
   * Les notifications sortantes (ntfy ou webhook) : `url` null = aucune ; `events` = les types envoyés ;
   * `digestHour` = l'heure locale (0-23) du rapport quotidien, `null` = pas de rapport.
   */
  notify: {
    url: string | null;
    /** Des cibles en plus de `url` (ntfy ou webhook générique). */
    targets: NotifyTarget[];
    events: string[];
    digestHour: number | null;
    /** Une même notification (titre et corps) n'est pas renvoyée avant ces minutes ; `null` : toujours. */
    dedupMin: number | null;
  };
  /** `runnerMode` : les runners reçoivent `MEM0_MODE=runner` (pas de rappel par tour ni d'épinglage). */
  memory: { runnerMode: boolean };
  oracle: { url: string; token: string | null } | null;
  /**
   * Le rêve de la mémoire (dreams.ts) : la consolidation des faits du projet en
   * observations et en mental models, confiée à une session omp sur `tier`. Chaque dépôt
   * est examiné au plus toutes les `checkMinutes` minutes (`null` : rêves coupés), quand
   * aucun de ses runs n'est en cours ; la session ne part que s'il y a au moins `minFacts`
   * faits nouveaux, ou un fait nouveau qui attend depuis `maxDelayHours` heures. Sans
   * oracle, rien.
   */
  dreams: { checkMinutes: number | null; minFacts: number; maxDelayHours: number; tier: Tier };
  /**
   * Le pilote des audits (pilot.ts) : chaque run d'un audit lancé qui attend l'humain est
   * d'abord confié à une session sur `tier`, au plus `actionsPerRun` fois par run (`0` :
   * pilote coupé) ; au-delà, l'humain.
   */
  pilot: { actionsPerRun: number; tier: Tier };
  /** Le classement des Demandes (intake.ts) : la session qui classe une phrase libre tourne sur `tier`. */
  intake: { tier: Tier };
  /** Le journal d'événements : au-delà de `retentionDays`, il est purgé (au démarrage, puis chaque heure). */
  events: { retentionDays: number };
  /**
   * Les instantanés de la base (backup.ts) : un toutes les `intervalHours` heures
   * (`null` : aucun) et un avant chaque migration du schéma (`beforeMigration`), les
   * `keep` derniers de chaque sorte gardés, dans `dir` (`null` : `<dataDir>/backups`).
   */
  backups: {
    dir: string | null;
    intervalHours: number | null;
    keep: number;
    beforeMigration: boolean;
    remote: BackupRemote | null;
  };
  /** Le journal structuré (logger.ts) : `<dir>/harness-AAAA-MM-JJ.jsonl`, `dir` null = `<dataDir>/logs`. */
  logs: { dir: string | null; retentionDays: number; level: LogLevel };
  /** Les points de `GET /v1/metrics`, gardés en base `retentionDays` jours. */
  metrics: { retentionDays: number };
  /**
   * Les seuils de `GET /v1/health` : le dernier tour du scheduling date de moins de
   * `tickStaleSec` secondes, il reste au moins `minFreeMiB` Mio libres sous `dataDir`
   * et `worktreesDir`.
   */
  health: { tickStaleSec: number; minFreeMiB: number };
  /** Les seuils des propositions de palier d'autonomie ; changés au redémarrage seulement. */
  autonomyLearning: AutonomyLearningConfig;
  monitoring: MonitoringConfig;
  apns: ApnsConfig | null;
  workstation: WorkstationConfig;
  /**
   * Les issues GitHub servies aux clients MCP (`POST /v1/mcp`, issues.ts) : `label` désigne
   * les issues qu'`issues_fix_labeled` lance, `maxLaunch` borne les runs lancés par appel,
   * `pollSec` l'intervalle de la relève automatique du label (`null` : à la demande seulement).
   */
  issues: { label: string; maxLaunch: number; pollSec: number | null };
  /**
   * Les voies d'un run (orchestrator.ts) : `direct` laisse une demande qui porte déjà ses
   * critères d'acceptation (`## Critères d'acceptation`, au moins un `AC-n`) partir à /impl
   * sans /req ni /specs ; `false` : tout run passe par /req.
   */
  lanes: { direct: boolean };
  /**
   * Les planifications récurrentes (schedules.ts) : leurs expressions cron se lisent en heure
   * murale de `timezone` (IANA) ; une échéance passée pendant un arrêt du service n'est
   * rattrapée (une seule fois) que si elle date de moins de `catchUpMin` minutes, sinon elle
   * est notée manquée.
   */
  schedules: { timezone: string; catchUpMin: number };
  /**
   * Le navigateur Obscura des outils MCP `browser_*` (omp-harness/browser/). `url` null :
   * « navigateur non configuré » ; l'URL et le jeton viennent de l'environnement quand le
   * fichier ne les donne pas (`browserFromEnv`). `allowPrivateNetwork` : développement
   * seulement, il lève le pré-contrôle du harness sur la boucle locale, les réseaux
   * privés, link-local et ULA (jamais le tailnet).
   */
  browser: {
    url: string | null;
    token: string | null;
    allowPrivateNetwork: boolean;
    maxContextsPerClient: number;
    maxContexts: number;
    idleSec: number;
    callTimeoutSec: number;
  };
  repos: RepoConfig[];
};

/** Le lanceur installé par `deploy/install.sh`. */
/** Jamais `-E` : sudo remet l'environnement à zéro, le lanceur ajoute lui-même les clés des runners. */
export const DEFAULT_LAUNCHER: readonly string[] = ["sudo", "-n", "/usr/local/libexec/omp-harness-systemd-run"];

/** La ligne d'un `systemd-run` (ou de `--stop <unité>`) derrière le lanceur configuré. */
export function launch(config: HarnessConfig, args: string[]): { command: string; args: string[] } {
  if (config.launcher.length === 0) {
    return args[0] === "--stop"
      ? { command: "systemctl", args: ["stop", ...args.slice(1)] }
      : { command: "systemd-run", args };
  }
  return { command: config.launcher[0] as string, args: [...config.launcher.slice(1), ...args] };
}

/** Le budget pire cas en Mio : runners + heavy + service. */
export function worstCaseBudgetMiB(config: HarnessConfig, serviceMiB = 1024): number {
  return (
    config.runner.slots * sizeMiB(config.runner.memoryMax) +
    config.heavy.slots * sizeMiB(config.heavy.memoryMax) +
    serviceMiB
  );
}

/** La chaîne de bascule d'un tier : la sienne, sinon celle du premier tier au-dessus qui en a une. */
export function modelChain(config: HarnessConfig, tier: Tier): ModelChoice[] {
  for (const candidate of TIERS.slice(TIERS.indexOf(tier)))
    if (config.models[candidate].length > 0) return config.models[candidate];
  return [];
}

/** Une taille systemd (`512M`, `4G`) en Mio. */
export function sizeMiB(size: string): number {
  const match = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(size.trim());
  if (!match) throw new Error(`taille illisible : ${size}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? "").toUpperCase();
  const factor =
    unit === "K" ? 1 / 1024 : unit === "M" ? 1 : unit === "G" ? 1024 : unit === "T" ? 1024 * 1024 : 1 / (1024 * 1024);
  return Math.round(value * factor);
}

export function defaultConfig(base = path.join(os.homedir(), ".omp-harness")): HarnessConfig {
  return {
    listen: { host: "127.0.0.1", port: 8790 },
    tokenFile: path.join(base, "token"),
    clientsFile: path.join(base, "clients.json"),
    channelsFile: path.join(base, "channels.json"),
    providersEnvFile: path.join(base, "providers.env"),
    providersModelsFile: path.join(base, "providers.models.yml"),
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
      stepRetries: DEFAULT_RETRY_BACKOFF_SEC.length,
      retryBackoffSec: [...DEFAULT_RETRY_BACKOFF_SEC],
      failoverOn: [...FAILOVER_CAUSES],
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
    review: {
      fixCap: 3,
      maxDiffLines: 300,
      specsGate: "auto",
      autoMergeRisk: "medium",
      diffCount: "code",
      escalationTimeoutSec: 3600,
      mergeRetries: 3,
      mergePollSec: 60,
      mergeWaitSec: 7200,
      crossProvider: true,
    },
    challenge: { steps: [...CHALLENGE_STEPS], tier: "heavy" },
    notify: { url: null, targets: [], events: [...DEFAULT_NOTIFY_EVENTS], digestHour: 8, dedupMin: 30 },
    memory: { runnerMode: true },
    oracle: null,
    dreams: { checkMinutes: 60, minFacts: 5, maxDelayHours: 24, tier: "standard" },
    pilot: { actionsPerRun: 3, tier: "heavy" },
    intake: { tier: "standard" },
    events: { retentionDays: 30 },
    backups: { dir: null, intervalHours: 24, keep: 7, beforeMigration: true, remote: null },
    logs: { dir: null, retentionDays: 14, level: "info" },
    metrics: { retentionDays: 7 },
    health: { tickStaleSec: 120, minFreeMiB: 1024 },
    monitoring: {
      runBudgetUsd: null,
      pauseOnBudget: false,
      dailyBudgetUsd: null,
      stallMin: 15,
      stallToolMin: 45,
      slowFactor: 2,
      fixLoop: 2,
      sampleSec: 15,
      keep: 480,
    },
    autonomyLearning: { windowDays: 30, minRuns: 10, raiseMaxRate: 0.05, lowerMinRate: 0.2 },
    apns: null,
    workstation: {
      enabled: true,
      thresholdHours: 8,
      retentionDays: 30,
      actionTimeoutSec: 60,
      approvalTtlHours: 24,
      shiftEveryMin: 30,
      shiftMaxActions: 20,
      profileEveryHours: 6,
      allowedHosts: [],
      exfiltrationGuard: true,
      captureRetentionHours: 24,
      vps: { url: null, token: null },
      channelReadEveryMin: 5,
      watch: {
        intervalMinutes: 5,
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "09:00",
        end: "18:00",
        followUpDays: 3,
      },
    },
    issues: { label: "omp:fix", maxLaunch: 5, pollSec: 900 },
    lanes: { direct: true },
    schedules: { timezone: "Europe/Paris", catchUpMin: 60 },
    browser: {
      url: null,
      token: null,
      allowPrivateNetwork: false,
      maxContextsPerClient: 3,
      maxContexts: 12,
      idleSec: 600,
      callTimeoutSec: 30,
    },
    repos: [],
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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

/** Les minutes depuis minuit d'une heure `HH:MM` (00:00 à 24:00), `null` si illisible. */
export function minutesOf(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const match = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(text);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= 24 * 60 ? minutes : null;
}

/** Valide la veille du poste : chaque erreur nomme sa clé (le harness refuse de démarrer). */
function checkWatch(watch: unknown): void {
  if (!isRecord(watch)) fail("workstation.watch : { intervalMinutes, days, start, end, followUpDays }");
  const interval = watch.intervalMinutes;
  if (!(Number.isInteger(interval) && (interval as number) >= 1 && (interval as number) <= 15))
    fail("workstation.watch.intervalMinutes : entier de 1 à 15");
  if (
    !Array.isArray(watch.days) ||
    watch.days.length === 0 ||
    watch.days.some((day) => !(WEEK_DAYS as readonly unknown[]).includes(day))
  )
    fail(`workstation.watch.days : liste non vide de jours parmi ${WEEK_DAYS.join(", ")}`);
  const start = minutesOf(watch.start);
  if (start === null) fail("workstation.watch.start : heure HH:MM");
  const end = minutesOf(watch.end);
  if (end === null) fail("workstation.watch.end : heure HH:MM");
  if (end <= start) fail("workstation.watch.end : plage vide, la fin doit suivre le début (workstation.watch.start)");
  if (!(Number.isInteger(watch.followUpDays) && (watch.followUpDays as number) >= 1))
    fail("workstation.watch.followUpDays : entier de jours ouvrés ≥ 1");
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

/** Une référence de modèle d'une politique : `fournisseur/modèle` (le modèle peut porter des `/`). */
export const MODEL_REF = /^([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:/@-]{1,128})$/;

/** Le nom d'une variable d'environnement du service (`tokenEnv`). */
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** Valide une politique de modèles (`where` : `repos.<nom>` ou `workstation.policy`). */
function checkPolicy(where: string, policy: ModelPolicy): void {
  const { models, providers, privacy } = policy;
  if (privacy !== undefined && !(PRIVACIES as readonly string[]).includes(privacy))
    fail(`${where}.privacy : ${PRIVACIES.join(" | ")}`);
  const localOnly = privacy === "local-only";
  if (providers !== undefined) {
    if (!Array.isArray(providers) || providers.some((name) => typeof name !== "string" || name.trim() === ""))
      fail(`${where}.providers : liste de noms de fournisseurs`);
    const remote = localOnly ? providers.filter((name) => name !== LOCAL_PROVIDER) : [];
    if (remote.length > 0)
      fail(`${where}.providers : « local-only » refuse tout fournisseur distant (${remote.join(", ")})`);
  }
  if (models !== undefined) {
    if (!isRecord(models)) fail(`${where}.models : { fast?, standard?, heavy? }`);
    for (const [tier, list] of Object.entries(models)) {
      if (!(TIERS as readonly string[]).includes(tier))
        fail(`${where}.models.${tier} : tier inconnu (${TIERS.join(" | ")})`);
      if (!Array.isArray(list)) fail(`${where}.models.${tier} : liste de "fournisseur/modèle"`);
      for (const ref of list) {
        const match = typeof ref === "string" ? MODEL_REF.exec(ref) : null;
        if (!match) fail(`${where}.models.${tier} : « ${String(ref)} » n'est pas "fournisseur/modèle"`);
        const provider = match[1] as string;
        if (localOnly && provider !== LOCAL_PROVIDER)
          fail(`${where}.models.${tier} : « local-only » refuse le fournisseur distant ${provider}`);
        if (providers !== undefined && !providers.includes(provider))
          fail(`${where}.models.${tier} : ${provider} est hors de la liste blanche \`providers\``);
      }
    }
  }
}

const PREVIEW_KEYS = ["command", "port", "path", "readyTimeoutSec"];

/** Le port du CDP du navigateur de QA dans l'espace réseau de la prévisualisation (browser/qa.ts). */
export const QA_CDP_PORT = 9222;

/**
 * Valide `repos.<nom>.preview` (la prévisualisation de la QA de /review) et complète ses défauts :
 * `path` = `/`, `readyTimeoutSec` = 60. Un dépôt sans `preview` n'est pas touché.
 */
function checkPreview(repo: RepoConfig): void {
  if (repo.preview === undefined) return;
  const where = `repos.${repo.name}.preview`;
  const preview: unknown = repo.preview;
  if (!isRecord(preview)) fail(`${where} : { command, port, path?, readyTimeoutSec? }`);
  const unknown = Object.keys(preview).find((key) => !PREVIEW_KEYS.includes(key));
  if (unknown !== undefined) fail(`${where}.${unknown} : clé inconnue (${PREVIEW_KEYS.join(", ")})`);
  const { command, port, path: home = "/", readyTimeoutSec = 60 } = preview;
  if (typeof command !== "string" || command.trim() === "" || /[\n\r]/.test(command) || command.includes("\0"))
    fail(`${where}.command : commande non vide sur une ligne (lancée par bash -c dans le worktree)`);
  if (!(Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65_535))
    fail(`${where}.port : entier de 1 à 65535`);
  if (port === QA_CDP_PORT) fail(`${where}.port : ${QA_CDP_PORT} est réservé au navigateur de QA`);
  if (
    typeof home !== "string" ||
    home.length > 512 ||
    !home.startsWith("/") ||
    home.startsWith("//") ||
    /[\s\p{Cc}]/u.test(home)
  )
    fail(`${where}.path : chemin /… sans espace, 512 caractères au plus (ex. /)`);
  if (!(Number.isInteger(readyTimeoutSec) && (readyTimeoutSec as number) >= 1 && (readyTimeoutSec as number) <= 600))
    fail(`${where}.readyTimeoutSec : entier de 1 à 600 (secondes)`);
  repo.preview = { command, port: port as number, path: home, readyTimeoutSec: readyTimeoutSec as number };
}

/** L'instance d'un GitLab : un hôte (`gitlab.client.example`, port permis) ou son URL http(s). */
const GITLAB_HOST = /^(?:https?:\/\/)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})(?::\d{1,5})?(?:\/[\w.~-]+)*\/?$/;

/** Valide les champs propres à un dépôt : identité, comptes gh et GitLab, forge, jeton mémoire. */
function checkRepoAccounts(repo: RepoConfig): void {
  const where = `repos.${repo.name}`;
  if (repo.git !== undefined) {
    const { git } = repo;
    const text = (value: unknown) => typeof value === "string" && value.trim() !== "" && !/[\n\r<>]/.test(value);
    if (!isRecord(git) || !text(git.name) || !text(git.email))
      fail(`${where}.git : { name, email } non vides, sur une ligne, sans < ni >`);
  }
  if (repo.gh !== undefined) {
    const { gh } = repo;
    if (!isRecord(gh)) fail(`${where}.gh : { configDir?, tokenEnv? }`);
    if (gh.configDir !== undefined && (typeof gh.configDir !== "string" || !path.isAbsolute(gh.configDir)))
      fail(`${where}.gh.configDir : chemin absolu`);
    if (gh.tokenEnv !== undefined && (typeof gh.tokenEnv !== "string" || !ENV_NAME.test(gh.tokenEnv)))
      fail(`${where}.gh.tokenEnv : nom de variable (MAJUSCULES_ET_SOULIGNÉS)`);
  }
  if (repo.forge !== undefined && !(FORGES as readonly string[]).includes(repo.forge))
    fail(`${where}.forge : ${FORGES.join(" | ")}`);
  if (repo.issues !== undefined) {
    const { issues } = repo;
    if (!isRecord(issues)) fail(`${where}.issues : { corporate? }`);
    if (issues.corporate !== undefined && !(CORPORATE_POLICIES as readonly unknown[]).includes(issues.corporate))
      fail(`${where}.issues.corporate : ${CORPORATE_POLICIES.join(" | ")}`);
  }
  if (repo.forge === "none" && repo.merge === "gh")
    fail(`${where}.forge : « none » n'ouvre aucune PR, \`merge: "gh"\` demande une forge`);
  if (repo.gitlab !== undefined) {
    const { gitlab } = repo;
    if (!isRecord(gitlab)) fail(`${where}.gitlab : { host?, tokenEnv?, configDir? }`);
    if (repo.forge !== undefined && repo.forge !== "gitlab")
      fail(`${where}.gitlab : déclaré pour une forge ${repo.forge}`);
    if (gitlab.host !== undefined && (typeof gitlab.host !== "string" || !GITLAB_HOST.test(gitlab.host)))
      fail(`${where}.gitlab.host : un hôte (gitlab.client.example) ou son URL https://`);
    if (gitlab.configDir !== undefined && (typeof gitlab.configDir !== "string" || !path.isAbsolute(gitlab.configDir)))
      fail(`${where}.gitlab.configDir : chemin absolu`);
    if (gitlab.tokenEnv !== undefined && (typeof gitlab.tokenEnv !== "string" || !ENV_NAME.test(gitlab.tokenEnv)))
      fail(`${where}.gitlab.tokenEnv : nom de variable (MAJUSCULES_ET_SOULIGNÉS)`);
  }
  if (repo.memory !== undefined) {
    const { memory } = repo;
    if (!isRecord(memory)) fail(`${where}.memory : { tokenEnv? }`);
    if (memory.tokenEnv !== undefined && (typeof memory.tokenEnv !== "string" || !ENV_NAME.test(memory.tokenEnv)))
      fail(`${where}.memory.tokenEnv : nom de variable (MAJUSCULES_ET_SOULIGNÉS)`);
  }
  checkPolicy(where, repo);
}

/** Valide une configuration complète ; lève une erreur NOMMÉE au premier défaut. */
export function validateConfig(config: HarnessConfig): HarnessConfig {
  if (!Number.isInteger(config.listen.port) || config.listen.port < 0 || config.listen.port > 65535)
    fail("listen.port invalide");
  if (!Number.isInteger(config.runner.slots) || config.runner.slots < 1) fail("runner.slots doit être ≥ 1");
  if (!Number.isInteger(config.heavy.slots) || config.heavy.slots < 1) fail("heavy.slots doit être ≥ 1");
  if (!(config.runner.stepTimeoutSec >= 1)) fail("runner.stepTimeoutSec doit être ≥ 1");
  if (!(config.events.retentionDays > 0)) fail("events.retentionDays doit être > 0");
  const { backups, health } = config;
  if (backups.dir !== null && (typeof backups.dir !== "string" || !path.isAbsolute(backups.dir)))
    fail("backups.dir : chemin absolu, ou null");
  if (backups.intervalHours !== null && !(typeof backups.intervalHours === "number" && backups.intervalHours > 0))
    fail("backups.intervalHours : heures > 0, ou null");
  if (!(Number.isInteger(backups.keep) && backups.keep >= 1)) fail("backups.keep : entier ≥ 1");
  if (typeof backups.beforeMigration !== "boolean") fail("backups.beforeMigration : booléen");
  if (backups.remote !== null) {
    const remote = backups.remote as unknown;
    if (
      !isRecord(remote) ||
      !Array.isArray(remote.command) ||
      remote.command.length === 0 ||
      remote.command.some((arg) => typeof arg !== "string" || arg === "")
    )
      fail('backups.remote : { "command": ["rclone", "copyto", "{file}", "…"], "timeoutSec"? } ou null');
    const timeoutSec = remote.timeoutSec ?? 600;
    if (!(typeof timeoutSec === "number" && timeoutSec >= 1)) fail("backups.remote.timeoutSec : secondes ≥ 1");
    backups.remote = { command: remote.command as string[], timeoutSec };
  }
  const { logs, metrics } = config;
  if (logs.dir !== null && (typeof logs.dir !== "string" || !path.isAbsolute(logs.dir)))
    fail("logs.dir : chemin absolu, ou null");
  if (!(typeof logs.retentionDays === "number" && logs.retentionDays > 0)) fail("logs.retentionDays : jours > 0");
  if (!(LOG_LEVELS as readonly string[]).includes(logs.level)) fail(`logs.level : ${LOG_LEVELS.join(" | ")}`);
  if (!(typeof metrics.retentionDays === "number" && metrics.retentionDays > 0))
    fail("metrics.retentionDays : jours > 0");
  if (!(health.tickStaleSec > 0)) fail("health.tickStaleSec : secondes > 0");
  if (!(health.minFreeMiB >= 0)) fail("health.minFreeMiB : Mio ≥ 0");
  sizeMiB(config.runner.memoryMax);
  sizeMiB(config.heavy.memoryMax);
  if (!/^\d+%$/.test(config.heavy.cpuQuota)) fail("heavy.cpuQuota doit être un pourcentage (300%)");
  if (typeof config.heavy.shell !== "string" || !path.isAbsolute(config.heavy.shell))
    fail("heavy.shell doit être un chemin absolu");
  for (const isolation of [config.runner.isolation, config.heavy.isolation]) {
    if (isolation !== "systemd" && isolation !== "container" && isolation !== "none")
      fail(`isolation inconnue : ${String(isolation)}`);
  }
  if (!Array.isArray(config.container.command) || config.container.command.length === 0)
    fail('container.command : le CLI du moteur, par exemple ["docker"]');
  for (const [key, value] of [
    ["runnerEnvFile", config.container.runnerEnvFile],
    ["runnerHome", config.container.runnerHome],
  ] as const) {
    if (value !== null && !path.isAbsolute(value)) fail(`container.${key} doit être un chemin absolu de l'hôte`);
  }
  for (const key of Object.keys(config.models))
    if (!(TIERS as readonly string[]).includes(key)) fail(`models.${key} : tier inconnu (${TIERS.join(" | ")})`);
  for (const tier of TIERS) config.models[tier] = checkModels(tier, config.models[tier]);
  for (const [step, tier] of Object.entries(config.stepTiers)) {
    if (!(STEP_KINDS as readonly string[]).includes(step))
      fail(`stepTiers.${step} : étape inconnue (${STEP_KINDS.join(" | ")})`);
    if (!(TIERS as readonly string[]).includes(tier)) fail(`stepTiers.${step} : tier inconnu (${TIERS.join(" | ")})`);
  }
  for (const [provider, limit] of Object.entries(config.providers)) {
    if (!(limit.capacity >= 1) || !(limit.refillPerMinute > 0))
      fail(`providers.${provider} : capacity ≥ 1 et refillPerMinute > 0`);
  }
  const names = new Set<string>();
  for (const repo of config.repos) {
    if (typeof repo.name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(repo.name))
      fail(`nom de dépôt invalide : ${String(repo.name)}`);
    if (names.has(repo.name)) fail(`dépôt en double : ${repo.name}`);
    names.add(repo.name);
    if (typeof repo.path !== "string" || !path.isAbsolute(repo.path)) fail(`repos.${repo.name}.path doit être absolu`);
    if (repo.merge !== "local" && repo.merge !== "gh") fail(`repos.${repo.name}.merge : local | gh`);
    if (repo.maxParallel !== null && !(Number.isInteger(repo.maxParallel) && repo.maxParallel >= 1))
      fail(`repos.${repo.name}.maxParallel : entier ≥ 1, ou null`);
    if (
      repo.sshKey !== null &&
      (typeof repo.sshKey !== "string" || !path.isAbsolute(repo.sshKey) || repo.sshKey.includes("'"))
    )
      fail(`repos.${repo.name}.sshKey : chemin absolu sans apostrophe, ou null`);
    if (repo.autonomy !== undefined) {
      try {
        repo.autonomy = checkAutonomy(`repos.${repo.name}.autonomy`, repo.autonomy);
      } catch (err: unknown) {
        fail(err instanceof Error ? err.message : String(err));
      }
    }
    checkRepoAccounts(repo);
    checkPreview(repo);
  }
  if (!Array.isArray(config.runner.retryBackoffSec) || config.runner.retryBackoffSec.some((s) => !(s >= 0)))
    fail("runner.retryBackoffSec : liste de secondes ≥ 0");
  if (!Number.isInteger(config.runner.stepRetries) || config.runner.stepRetries < 0)
    fail("runner.stepRetries doit être un entier ≥ 0");
  if (
    !Array.isArray(config.runner.failoverOn) ||
    config.runner.failoverOn.some((cause) => !(FAILOVER_CAUSES as readonly string[]).includes(cause))
  )
    fail(`runner.failoverOn : liste parmi ${FAILOVER_CAUSES.join(" | ")}`);
  if (config.review.specsGate !== true && config.review.specsGate !== false && config.review.specsGate !== "auto")
    fail('review.specsGate : true | false | "auto"');
  if (config.review.autoMergeRisk !== "low" && config.review.autoMergeRisk !== "medium")
    fail("review.autoMergeRisk : low | medium");
  if (config.review.diffCount !== "all" && config.review.diffCount !== "code") fail("review.diffCount : all | code");
  if (config.review.escalationTimeoutSec !== null && !(config.review.escalationTimeoutSec > 0))
    fail("review.escalationTimeoutSec : secondes > 0, ou null");
  if (!Number.isInteger(config.review.mergeRetries) || config.review.mergeRetries < 0)
    fail("review.mergeRetries doit être un entier ≥ 0");
  if (!(config.review.mergePollSec > 0)) fail("review.mergePollSec : secondes > 0");
  if (!(config.review.mergeWaitSec > 0)) fail("review.mergeWaitSec : secondes > 0");
  if (typeof config.review.crossProvider !== "boolean") fail("review.crossProvider : booléen");
  if (
    !Array.isArray(config.challenge.steps) ||
    config.challenge.steps.some((step) => !(CHALLENGE_STEPS as readonly string[]).includes(step))
  )
    fail(`challenge.steps : liste parmi ${CHALLENGE_STEPS.join(" | ")}`);
  if (!(TIERS as readonly string[]).includes(config.challenge.tier))
    fail(`challenge.tier : tier inconnu (${TIERS.join(" | ")})`);
  if (config.notify.url !== null && typeof config.notify.url !== "string") fail("notify.url : URL ou null");
  if (!Array.isArray(config.notify.events) || config.notify.events.some((event) => typeof event !== "string"))
    fail("notify.events : liste de noms d'événements");
  const { digestHour } = config.notify;
  if (digestHour !== null && !(Number.isInteger(digestHour) && digestHour >= 0 && digestHour <= 23))
    fail("notify.digestHour : heure entière 0-23, ou null");
  const { dedupMin } = config.notify;
  if (dedupMin !== null && !(typeof dedupMin === "number" && dedupMin >= 0))
    fail("notify.dedupMin : minutes ≥ 0, ou null");
  if (!Array.isArray(config.notify.targets)) fail("notify.targets : liste de { kind, url, headers? }");
  config.notify.targets = config.notify.targets.map((target: unknown, index) => {
    if (
      !isRecord(target) ||
      (target.kind !== "ntfy" && target.kind !== "webhook") ||
      typeof target.url !== "string" ||
      !/^https?:\/\//.test(target.url)
    )
      fail(`notify.targets[${index}] : { "kind": "ntfy" | "webhook", "url": "https://…", "headers"? }`);
    const headers = target.headers ?? {};
    if (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== "string"))
      fail(`notify.targets[${index}].headers : { nom: valeur }`);
    return { kind: target.kind, url: target.url, headers: headers as Record<string, string> };
  });
  if (typeof config.memory.runnerMode !== "boolean") fail("memory.runnerMode : booléen");
  const { dreams } = config;
  if (dreams.checkMinutes !== null && !(typeof dreams.checkMinutes === "number" && dreams.checkMinutes > 0))
    fail("dreams.checkMinutes : minutes > 0, ou null");
  if (!(Number.isInteger(dreams.minFacts) && dreams.minFacts >= 1)) fail("dreams.minFacts : entier ≥ 1");
  if (!(typeof dreams.maxDelayHours === "number" && dreams.maxDelayHours > 0))
    fail("dreams.maxDelayHours : heures > 0");
  if (!(TIERS as readonly string[]).includes(dreams.tier)) fail(`dreams.tier : tier inconnu (${TIERS.join(" | ")})`);
  if (!(Number.isInteger(config.pilot.actionsPerRun) && config.pilot.actionsPerRun >= 0))
    fail("pilot.actionsPerRun : entier ≥ 0");
  if (!(TIERS as readonly string[]).includes(config.pilot.tier))
    fail(`pilot.tier : tier inconnu (${TIERS.join(" | ")})`);
  if (!(TIERS as readonly string[]).includes(config.intake.tier))
    fail(`intake.tier : tier inconnu (${TIERS.join(" | ")})`);
  const monitoring = config.monitoring;
  for (const key of ["runBudgetUsd", "dailyBudgetUsd", "stallMin", "stallToolMin", "slowFactor", "fixLoop"] as const) {
    const value = monitoring[key];
    if (value !== null && !(typeof value === "number" && value > 0)) fail(`monitoring.${key} : nombre > 0, ou null`);
  }
  if (typeof monitoring.pauseOnBudget !== "boolean") fail("monitoring.pauseOnBudget : booléen");
  if (!(monitoring.sampleSec >= 1)) fail("monitoring.sampleSec : secondes ≥ 1");
  if (!(Number.isInteger(monitoring.keep) && monitoring.keep >= 1)) fail("monitoring.keep : entier ≥ 1");
  const learning = config.autonomyLearning;
  if (!(Number.isInteger(learning.windowDays) && learning.windowDays >= 1))
    fail("autonomyLearning.windowDays : entier ≥ 1");
  if (learning.windowDays > config.events.retentionDays)
    fail(
      `autonomyLearning.windowDays : au plus events.retentionDays (${config.events.retentionDays}), le journal purgé ne porte plus la fenêtre`,
    );
  if (!(Number.isInteger(learning.minRuns) && learning.minRuns >= 1)) fail("autonomyLearning.minRuns : entier ≥ 1");
  for (const key of ["raiseMaxRate", "lowerMinRate"] as const)
    if (!(typeof learning[key] === "number" && learning[key] >= 0 && learning[key] <= 1))
      fail(`autonomyLearning.${key} : nombre entre 0 et 1`);
  if (!(learning.raiseMaxRate < learning.lowerMinRate)) fail("autonomyLearning : raiseMaxRate < lowerMinRate");
  const workstation = config.workstation;
  if (!isRecord(workstation)) fail("workstation : objet attendu");
  if (typeof workstation.enabled !== "boolean") fail("workstation.enabled : booléen");
  for (const key of [
    "thresholdHours",
    "retentionDays",
    "approvalTtlHours",
    "profileEveryHours",
    "captureRetentionHours",
  ] as const)
    if (!(typeof workstation[key] === "number" && workstation[key] > 0)) fail(`workstation.${key} : nombre > 0`);
  if (
    !Array.isArray(workstation.allowedHosts) ||
    workstation.allowedHosts.some((host) => typeof host !== "string" || host.trim() === "")
  )
    fail("workstation.allowedHosts : liste d'hôtes (chaînes non vides)");
  if (typeof workstation.exfiltrationGuard !== "boolean") fail("workstation.exfiltrationGuard : booléen");
  if (!(typeof workstation.actionTimeoutSec === "number" && workstation.actionTimeoutSec >= 1))
    fail("workstation.actionTimeoutSec : secondes ≥ 1");
  if (!(typeof workstation.shiftEveryMin === "number" && workstation.shiftEveryMin >= 1))
    fail("workstation.shiftEveryMin : minutes ≥ 1");
  if (!(Number.isInteger(workstation.shiftMaxActions) && workstation.shiftMaxActions >= 1))
    fail("workstation.shiftMaxActions : entier ≥ 1");
  if (!(typeof workstation.channelReadEveryMin === "number" && workstation.channelReadEveryMin >= 1))
    fail("workstation.channelReadEveryMin : minutes ≥ 1");
  checkWatch(workstation.watch);
  if (workstation.policy !== undefined) {
    if (!isRecord(workstation.policy)) fail("workstation.policy : { models?, providers?, privacy? }");
    checkPolicy("workstation.policy", workstation.policy);
  }
  if (!isRecord(workstation.vps)) fail("workstation.vps : { url, token }");
  checkCdpEndpoint("workstation.vps", workstation.vps as { url: string | null; token: string | null });
  if (config.apns !== null) {
    const apns = config.apns;
    if (!isRecord(apns)) fail("apns : { keyFile, keyId, teamId, topic, sandbox } ou null");
    if (typeof apns.keyFile !== "string" || !path.isAbsolute(apns.keyFile)) fail("apns.keyFile : chemin absolu");
    for (const key of ["keyId", "teamId", "topic"] as const)
      if (typeof apns[key] !== "string" || apns[key].trim() === "") fail(`apns.${key} : texte non vide`);
    if (typeof apns.sandbox !== "boolean") fail("apns.sandbox : booléen");
  }
  if (typeof config.issues.label !== "string" || config.issues.label.trim() === "")
    fail("issues.label : texte non vide");
  if (!(Number.isInteger(config.issues.maxLaunch) && config.issues.maxLaunch >= 1))
    fail("issues.maxLaunch : entier ≥ 1");
  if (typeof config.lanes.direct !== "boolean") fail("lanes.direct : booléen");
  if (config.issues.pollSec !== null && !(Number.isInteger(config.issues.pollSec) && config.issues.pollSec >= 60))
    fail("issues.pollSec : entier ≥ 60 (secondes), ou null");
  if (typeof config.schedules.timezone !== "string" || !isTimeZone(config.schedules.timezone))
    fail(`schedules.timezone : fuseau IANA inconnu (${String(config.schedules.timezone)}), ex. Europe/Paris`);
  if (
    !(
      Number.isInteger(config.schedules.catchUpMin) &&
      config.schedules.catchUpMin >= 1 &&
      config.schedules.catchUpMin <= 10_080
    )
  )
    fail("schedules.catchUpMin : entier de 1 à 10080 (minutes, une semaine au plus)");
  validateBrowser(config.browser);
  for (const repo of config.repos) {
    if (repo.tests.pattern !== null && typeof repo.tests.pattern !== "string")
      fail(`repos.${repo.name}.tests.pattern : glob ou null`);
    if (!isRecord(repo.checks) || Object.values(repo.checks).some((command) => typeof command !== "string"))
      fail(`repos.${repo.name}.checks : { nom: commande }`);
  }
  return config;
}

/** L'adresse et le jeton d'un Obscura : refusés avec un message préfixé `<prefix>.url :` ou `<prefix>.token :`. */
function checkCdpEndpoint(prefix: string, endpoint: { url: string | null; token: string | null }): void {
  const { url, token } = endpoint;
  if (url !== null) {
    let parsed: URL | null = null;
    try {
      parsed = typeof url === "string" ? new URL(url) : null;
    } catch {
      parsed = null;
    }
    if (parsed === null) fail(`${prefix}.url : URL http:// ou ws:// (réseau interne), ou null`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "ws:")
      fail(`${prefix}.url : http:// ou ws:// attendu (réseau interne)`);
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || parsed.username !== "")
      fail(`${prefix}.url : sans chemin (http://hôte:port)`);
  }
  if (token !== null && !(typeof token === "string" && token.length >= 32))
    fail(`${prefix}.token : 32 caractères au moins, ou null`);
}

/** Les réglages du navigateur d'Obscura : refusés avec un message préfixé `browser.<clé> :`. */
function validateBrowser(browser: HarnessConfig["browser"]): void {
  checkCdpEndpoint("browser", browser);
  if (typeof browser.allowPrivateNetwork !== "boolean") fail("browser.allowPrivateNetwork : booléen");
  const integer = (
    key: "maxContextsPerClient" | "maxContexts" | "idleSec" | "callTimeoutSec",
    min: number,
    max: number,
  ) => {
    const value = browser[key];
    if (!(Number.isInteger(value) && value >= min && value <= max)) fail(`browser.${key} : entier de ${min} à ${max}`);
  };
  integer("maxContextsPerClient", 1, 20);
  integer("maxContexts", browser.maxContextsPerClient, 64);
  integer("idleSec", 1, 86_400);
  integer("callTimeoutSec", 1, 300);
}

/**
 * L'URL et le jeton du navigateur, complétés depuis l'environnement (`OBSCURA_CDP_URL`,
 * `OBSCURA_CDP_TOKEN`, posés par le service `setup`) quand le fichier ne les donne pas ;
 * une valeur vide est ignorée. Les réglages sont revalidés.
 */
export function browserFromEnv(
  config: HarnessConfig,
  env: Record<string, string | undefined> = process.env,
): HarnessConfig {
  config.browser.url ??= env.OBSCURA_CDP_URL || null;
  config.browser.token ??= env.OBSCURA_CDP_TOKEN || null;
  validateBrowser(config.browser);
  // Le navigateur du poste (`obscura-poste`) : lu seulement par l'exécuteur `vps`.
  config.workstation.vps.url ??= env.OBSCURA_POSTE_CDP_URL || null;
  config.workstation.vps.token ??= env.OBSCURA_POSTE_CDP_TOKEN || null;
  checkCdpEndpoint("workstation.vps", config.workstation.vps);
  return config;
}

/**
 * Les attentes effectives des relances d'une étape : `stepRetries` entrées, prises
 * dans `retryBackoffSec` (la dernière répétée s'il en manque, 0 si la liste est vide).
 */
export function retryBackoff(config: HarnessConfig): number[] {
  const list = config.runner.retryBackoffSec;
  const last = list[list.length - 1] ?? 0;
  return Array.from({ length: config.runner.stepRetries }, (_, index) => list[index] ?? last);
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
      tests: { touched: "npm test -- {files}", full: "npm test", pattern: null },
      checks: {},
      merge: "local",
      remote: null,
      testImage: null,
      maxParallel: null,
      sshKey: null,
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
  const repos = Array.isArray(raw.repos) ? raw.repos.map((entry) => repoDefaults(isRecord(entry) ? entry : {})) : [];
  const config = merge(base, { ...raw, repos });
  // Sans `stepRetries` déclaré, la liste des attentes dit combien de relances on fait.
  if (isRecord(raw.runner) && raw.runner.stepRetries === undefined)
    config.runner.stepRetries = config.runner.retryBackoffSec.length;
  // Un `dataDir` déclaré entraîne ce qui en dépend, sauf déclaration explicite.
  if (typeof raw.dataDir === "string") {
    if (raw.tokenFile === undefined) config.tokenFile = path.join(raw.dataDir, "token");
    if (raw.worktreesDir === undefined) config.worktreesDir = path.join(raw.dataDir, "worktrees");
  }
  // Les clients vivent à côté du jeton historique (même dossier d'état, mêmes droits).
  if (raw.clientsFile === undefined) config.clientsFile = path.join(path.dirname(config.tokenFile), "clients.json");
  if (raw.channelsFile === undefined) config.channelsFile = path.join(path.dirname(config.tokenFile), "channels.json");
  if (raw.providersEnvFile === undefined)
    config.providersEnvFile = path.join(path.dirname(config.tokenFile), "providers.env");
  if (raw.providersModelsFile === undefined)
    config.providersModelsFile = path.join(path.dirname(config.tokenFile), "providers.models.yml");
  return validateConfig(config);
}

export function repoByName(config: HarnessConfig, name: string): RepoConfig | null {
  return config.repos.find((repo) => repo.name === name) ?? null;
}
