// Lot de features : modèle, magasin, lecture, bornes.
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { REQUIRED_CONTRACT_SECTIONS } from "./chain.ts";
import type { PipelinePhase } from "./contract.ts";
import { realpathOr } from "./git.ts";
import { clipTail } from "./panelWidth.ts";
// Type SEUL (`import type`) : la dépendance est effacée au chargement, donc aucun
// cycle runtime avec `runs.ts`, qui importe ce module.
import type { LotPromptKind } from "./runs.ts";
import { PIPELINE_PHASES, asStringOrNull, pidAlive, readAuditRelay, readJsonFile, writeJsonAtomic } from "./store.ts";
import type { PanelAskOption, PanelPendingAsk } from "./store.ts";



// ---------------------------------------------------------------------------
// Lot de features — le magasin, la chaîne, le pilote.
// ---------------------------------------------------------------------------
// Un lot = N features, un pipeline par feature, piloté par UN process (le
// propriétaire, `owner.pid`) — en pratique le SERVICE (S-4). Chaque maillon d'une
// feature est un RUN : une session EN PROCESS du service, qui travaille dans le
// worktree de la feature et est libérée à la fin de son tour (S-3). Le pilote ne décide rien d'autre que la
// suite, et cette décision est PURE (`nextChainAction`) : l'état vit dans deux
// fichiers — le contrat de la feature (écrit par l'agent) et le lot (écrit par le
// pilote seul).
//
// Pourquoi des processus et pas des sessions en mémoire : l'échec ou le blocage
// d'un pipeline ne doit ni emporter le lot ni freiner les autres (B-5), et une
// extension n'a aucun moyen de créer une session (`ctx.newSession` n'existe que
// sur un contexte de commande, cf. `## Documentation` §1). Le parallélisme du lot
// est donc celui de N processus indépendants, et l'isolation est structurelle.

export const LOT_VERSION = 1;


export type LotFeatureState = "pending" | "running" | "waiting" | "blocked" | "failed" | "done" | "cancelled";

/**
 * `ci` (S-9) : la revue est propre, mais la porte de l'intégration continue GitHub
 * (feature d'un dépôt conduit par le VPS qui touche du Swift) n'a pas rendu son
 * verdict sur la branche de travail. Aucun geste de l'utilisateur ne la franchit.
 */
export type LotWaitKind = "answer" | "specs" | "review" | "ci";

/**
 * D'où vient la feature. `session` : sa collecte se déroule dans la session de
 * l'utilisateur (créée par /req) — le pilote ne lance aucun run tant que le
 * maillon `req` n'est pas clos. `panneau` : tout est run, collecte comprise.
 */
export type LotOrigin = "session" | "panneau";


/**
 * Le lancement qu'un geste a demandé SANS qu'un créneau soit libre (S-3) : il est
 * mémorisé sur la feature, qui redevient `pending`, et la passe le démarre dès
 * qu'un run du lot rend son créneau — avec exactement l'argv, le prompt, la
 * reprise de session et les compteurs du chemin immédiat. Rien n'est perdu :
 * c'est la zone visée, le `fix`, le `kind`, le `resume` et le texte d'une réponse
 * qui partent au démarrage réel.
 */
export type HeldLaunch = {
  phase: PipelinePhase;
  fix: boolean;
  kind: LotPromptKind;
  resume: boolean;
  text?: string;
  /** D'où vient le texte d'une réponse (S-11) : absent = l'utilisateur. */
  source?: "contexte" | "arbitrage";
  /** Le recentrage de l'arbitre : lu par le prompt du SEUL run de ce lancement. */
  refocus?: string;
};


/**
 * Le quota qui bloque une feature (S-5) : le fournisseur, le modèle épuisé, son
 * échéance (epoch ms), si elle a été ANNONCÉE par le fournisseur, et la phase du run.
 */
export type FeatureQuota = { provider: string; model: string; until: number; announced: boolean; phase: PipelinePhase };


/**
 * Un GROUPE de quota (S-5) : les features `blocked` portant le quota d'un même
 * fournisseur. `until`/`announced` sont ceux de l'échéance la plus PROCHE du groupe.
 */
export type QuotaGroup = { provider: string; slugs: string[]; until: number; announced: boolean };

/** Le groupe de quota d'une feature (S-5), ou `null` : `blocked` ET porteuse d'un quota. */
export function blockedQuotaOf(feature: LotFeature): FeatureQuota | null {
  return feature.state === "blocked" && feature.quota !== undefined ? feature.quota : null;
}

/**
 * Les groupes de quota des features retenues par `keep` (S-5), un par fournisseur,
 * dans l'ordre d'apparition dans le lot. Pur.
 */
export function quotaGroupsOf(lot: Lot, keep: (feature: LotFeature) => boolean = () => true): QuotaGroup[] {
  const groups = new Map<string, QuotaGroup>();
  for (const feature of lot.features) {
    const quota = blockedQuotaOf(feature);
    if (quota === null || !keep(feature)) continue;
    const known = groups.get(quota.provider);
    if (known === undefined) {
      groups.set(quota.provider, { provider: quota.provider, slugs: [feature.slug], until: quota.until, announced: quota.announced });
      continue;
    }
    known.slugs.push(feature.slug);
    if (quota.until < known.until) {
      known.until = quota.until;
      known.announced = quota.announced;
    }
  }
  return [...groups.values()];
}


/**
 * Un arbitrage en vol (S-9) : la clé de l'élément arbitré, l'instant de mise en file
 * (`startedAt`) et son ÉTAT, lu par la Console — `queued` : en file derrière d'autres
 * éléments de la même session de pilote ; `deciding` : le tour du pilote a commencé à
 * `decidingAt`. Absent (fichier ancien) = `queued`.
 */
export type FeatureArbitration = { key: string; startedAt: number; status?: "queued" | "deciding"; decidingAt?: number };

/** Le motif d'une relance appliquée par l'arbitre. */
export type ArbiterRelaunchMotive = "cap" | "failure";

/** Les relances appliquées par l'arbitre, par motif, et le motif de la dernière. */
export type ArbiterRelaunches = { cap: number; failure: number; last: ArbiterRelaunchMotive };

/** Borne des relances de l'arbitre par motif et par feature : non configurable. */
export const ARBITER_RELAUNCH_MAX = 2;

/** Bornes (par la fin) de la sortie d'un run échoué conservée pour l'arbitre. */
export const LOT_FAILURE_STDERR_MAX = 2000;
export const LOT_FAILURE_STDOUT_MAX = 4000;


/** Plafond des enregistrements de run conservés par feature (S-12). */
export const LOT_RUNS_MAX = 100;

/**
 * Un run terminé (S-12) : son étape, son lot d'impl, le pic de contexte mesuré
 * (`null` sans usage), le nombre de compactions réussies pendant le run (entier
 * ≥ 0 ; un record ancien sans ce champ est relu à 0) et sa session.
 */
export type LotRunRecord = {
  step: PipelinePhase | "arbitre";
  lot: string | null;
  fix: boolean;
  startedAt: number;
  endedAt: number;
  peakContext: number | null;
  compactions: number;
  sessionFile: string | null;
};


/** Un élément que l'arbitre n'a pas pu trancher : il attend l'utilisateur (S-9, S-10). */
export type FeatureEscalation = {
  key: string;
  kind: "question" | "jalon" | "plafond" | "echec";
  phase: PipelinePhase;
  question: string;
  options: string[];
  reason: string;
  at: number;
};


/** Un contrôle GitHub rouge de la porte d'intégration continue : son nom et son lien (`html_url`). */
export type CiFailure = { name: string; url: string };

/**
 * L'état de la porte d'intégration continue d'une feature (S-9) : le commit de
 * travail poussé (`sha`), l'arbre qu'il fige (`tree`), l'heure du push, le dernier
 * verdict lu (`state`, `checkedAt` : `null` tant qu'aucune lecture) et les
 * contrôles rouges (`failures`).
 */
export type FeatureCi = {
  sha: string;
  tree: string;
  pushedAt: number;
  state: "pending" | "green" | "red";
  checkedAt: number | null;
  failures: CiFailure[];
};


export type LotFeature = {
  slug: string;
  /** L'intention déclarée à l'ajout : elle amorce la collecte. */
  name: string;
  branch: string;
  /** Chemin du worktree de la feature ("" tant qu'il n'est pas créé). */
  worktree: string;
  deps: string[];
  origin: LotOrigin;
  state: LotFeatureState;
  phase: PipelinePhase;
  waitKind: LotWaitKind | null;
  /** Texte à montrer quand la feature attend une réponse (fin du tour du run). */
  waitPrompt: string | null;
  sessionFile: string | null;
  /**
   * Les messages de l'utilisateur MIS EN FILE (S-5) : un run est en vol, aucun
   * canal de l'hôte ne l'atteint (`## Documentation` §1), donc le texte part au
   * prochain run que le pilote démarre pour cette feature — quel qu'il soit.
   * Ordonné (FIFO), borné en nombre et en caractères, vidé par `cancel`, conservé
   * par une relance.
   */
  pendingTexts: string[];
  prUrl: string | null;
  stopReason: string | null;
  /** Tours de correction `impl --fix` consommés (plafond, S-5). */
  fixes: number;
  /**
   * Passes de revue au verdict ILLISIBLE consommées (borne du verdict illisible),
   * comptées au lancement. Borner l'illisible sur le total des revues faisait
   * bloquer une feature dès qu'elle avait corrigé ses bloquants (« verdict
   * illisible après 4 passes » alors qu'une seule l'était). Remis à zéro par tout
   * verdict lisible.
   */
  unreadableRuns?: number;
  /**
   * Reprises automatiques CONSÉCUTIVES du maillon courant par le service (S-4,
   * BR-3) : +1 à chaque reprise d'un run interrompu par l'arrêt du service, remis
   * à zéro à toute fin normale de maillon. Absent = 0 ; écrit seulement quand il
   * est > 0 (comme `arbiterRelaunches`), pour que les lots d'avant se relisent
   * à l'identique.
   */
  autoResumes?: number;
  /**
   * La porte de l'intégration continue GitHub (S-9, B-9) : présente seulement sur une
   * feature d'un dépôt conduit par le VPS qui touche du Swift, et le reste une fois
   * posée. `sha` est le commit de travail poussé sur `feat/<slug>`, `tree` l'arbre
   * du worktree qu'il fige (l'arbre COURANT doit lui être égal pour livrer).
   */
  ci?: FeatureCi;
  /**
   * sha1 de la section `## Revue` au LANCEMENT du run de revue courant. Une
   * empreinte identique à la fin du run veut dire que ce run n'a rien écrit : son
   * verdict est illisible, jamais `clean` (le texte lu viendrait d'un autre maillon).
   */
  reviewHash?: string | null;
  /** Dernier verdict de revue lu, publié pour le panneau (`null` : aucune revue lue). */
  lastVerdict?: "blockers" | "clean" | "unreadable" | null;
  /** Bloquants NUMÉROTÉS du dernier verdict, publiés pour le panneau. */
  lastBlockers?: number;
  /** Session du dernier run, quel que soit son sort : c'est elle qu'une réponse reprend. */
  lastRunSessionFile?: string | null;
  /** Le modèle qui a rendu le dernier verdict de revue (après replis), publié pour le panneau et le journal. */
  lastVerdictModel?: string | null;
  /** sha1 du contrat au DÉMARRAGE du run courant — dit si un run a travaillé. */
  contractHash: string | null;
  /**
   * Titres obligatoires du contrat présents au lancement du run courant — garde
   * « contrat endommagé » (S-7) ; absent = garde inactive (lot antérieur, release).
   * Invariant : sous-ensemble ordonné de REQUIRED_CONTRACT_SECTIONS.
   */
  launchSections?: string[];
  /**
   * La feature a-t-elle le DROIT de démarrer ? Une feature ajoutée par `a` à un lot
   * au brouillon porte `false` : elle attend `l` (le lancement du lot), qui la passe
   * à `true`. Absent (lot d'une version antérieure) vaut « lancée » : le garde est
   * `!== false`, jamais `=== true`.
   */
  launched?: boolean;
  /**
   * Le lancement RETENU par le plafond (S-3). Écrit SEULEMENT quand il porte un
   * lancement, et détruit par toute transition qui sort de `pending` (`settle`,
   * `cancel`, `remove`, démarrage) : un `held` incomplet est lu comme absent, il
   * ne fait jamais rejeter la feature. Il survit à une reprise du lot (il est dans
   * le fichier) comme à un déblocage par dépendance.
   */
  held?: HeldLaunch;
  /**
   * La CLÉ DE RELAIS de la feature : le chemin ABSOLU du fichier de la session
   * /audit qui l'a lancée, ou la `relayKey` du projet /project qui l'a lancée. Ses
   * questions et ses jalons sont relayés à cette session tant que son relais est
   * ouvert (`auditRelayOpen`). Absent : feature de lot ordinaire. Jamais modifié
   * par une transition — le nom du champ reste celui d'origine (champ persisté).
   */
  auditSession?: string;
  /**
   * Le GENRE du relais (S-6) : `"project"` pour une feature lancée par /project —
   * le panneau dit alors « /project » au lieu de « /audit ». Absent : relais
   * /audit (ou aucun). Écrit à la création, jamais modifié.
   */
  relayKind?: "project";
  /**
   * Le sha de DÉPART du worktree (S-7) : la branche par défaut du distant,
   * fraîchement récupérée pour le segment du projet. Absent : `HEAD` du dépôt
   * principal (comportement d'avant). Écrit à la création, jamais modifié.
   */
  base?: string;
  /**
   * Le modèle du groupe cadrage+revue (S-1) : le sélecteur canonique `provider/id`,
   * EXACTEMENT la valeur passée à `--model` sur les runs `req`, `specs` et `review`
   * (et sur la session d'arbitrage). Absent = groupe au défaut OMP (aucun
   * `--model`). Écrit à la création, remplaçable à tout moment par « Modifier les
   * modèles » (S-3) — jamais modifié par une transition.
   */
  modelReqSpecs?: string;
  /**
   * Le modèle du groupe exécution (S-1) : appliqué aux runs `impl` (y compris
   * `--fix`) et `release`. Mêmes règles d'écriture et de remplacement que
   * `modelReqSpecs`.
   */
  modelImplReview?: string;
  /**
   * Le repli du groupe cadrage+revue (S-1) : le sélecteur `provider/id` sur lequel
   * un run `req`, `specs` ou `review` continue quand le principal est épuisé. Absent
   * = aucun repli (jamais `""` ni `null` stockés). Remplaçable à tout moment par
   * `models`.
   */
  fallbackReqSpecs?: string;
  /** Le repli du groupe exécution (S-1) : runs `impl` (y compris `--fix`) et `release` ; mêmes règles que `fallbackReqSpecs`. */
  fallbackImplReview?: string;
  /** L'arbitrage EN VOL (S-9) : posé et sauvé avant l'ouverture de la session d'arbitre, effacé à la décision. */
  arbitration?: FeatureArbitration;
  /** L'escalade vers l'utilisateur (S-9, S-10) : posée par l'arbitre, effacée quand la décision est appliquée. */
  escalation?: FeatureEscalation;
  /** La source du jalon qui vient d'être décidé (S-11) : lue par le prompt du run qui suit, puis effacée. */
  milestoneSource?: "arbitrage" | "utilisateur";
  /**
   * Les relances APPLIQUÉES par l'arbitre, par motif (cap, failure) et le motif de la
   * dernière. Absent tant qu'aucune relance n'a eu lieu. Seule une relance de l'arbitre
   * l'incrémente et seule la livraison le supprime : R, une réponse, `resolveQuota`, une
   * annulation et la relance à l'échéance d'un quota ne le touchent pas.
   */
  arbiterRelaunches?: ArbiterRelaunches;
  /** Les fins de sortie du run échoué (stderr/stdout rognés par la fin) : lues par l'arbitre. Supprimées par `arm`. */
  failureOutput?: { stderr: string; stdout: string };
  /**
   * Les lots de l'impl (S-13), figés au lancement de l'impl qui suit la validation des specs :
   * un run d'impl par lot, chacun en session neuve. Absents : un seul run d'impl. Effacés à
   * l'entrée en review et sur `--fix`.
   */
  implLots?: string[];
  /** Rang (0-based) du lot d'impl courant dans `implLots`. */
  implLot?: number;
  /** Les runs terminés de la feature, du plus ancien au plus récent (S-12) ; au plus `LOT_RUNS_MAX`. */
  runs?: LotRunRecord[];
  /**
   * Le quota qui a BLOQUÉ la feature (S-5) : écrit avec `state: "blocked"` quand un
   * run a rendu un quota épuisé (ou que la garde de lancement l'a refusé), effacé par
   * la décision de l'utilisateur. Absent : la feature n'est pas bloquée par un quota.
   */
  quota?: FeatureQuota;
  /**
   * L'ANCIEN modèle unique, conservé en LECTURE seule (S-1, AC-4) : une feature
   * créée avant cette feature le porte, et il remplit alors les DEUX groupes tant
   * qu'il n'a pas été remplacé. Plus rien ne l'écrit ; `editModels` le supprime (S-3).
   */
  model?: string;
  addedAt: number;
  /** Instant d'entrée dans l'état courant : c'est lui que le panneau chronomètre. */
  sinceAt: number;
  updatedAt: number;
  endedAt: number | null;
};


export type Lot = {
  version: 1;
  id: string;
  repoRoot: string;
  status: "draft" | "running";
  /** Plafond de tours de correction, figé au premier lancement (S-5). */
  reviewCap: number;
  /**
   * Plafond de runs de features du lot MENÉS EN PARALLÈLE, figé au premier
   * lancement comme `reviewCap` (S-2) : le pilotage ne relit jamais
   * `MEM0_PIPELINE_SLOTS`, il compare à ce champ. Un créneau est occupé par une
   * feature `running` hors collecte de session ; un lot écrit par une version
   * antérieure se relit à `PIPELINE_SLOTS_DEFAULT`, sans migration.
   */
  slotCap: number;
  /** Instant du récap posté, `null` tant qu'il ne l'a pas été (S-12). */
  recapAt: number | null;
  /**
   * Le propriétaire du lot. `heartbeatAt` (epoch ms) est estampillé à chaque
   * écriture du lot : c'est ce qui distingue un pilote VIVANT d'un pid RÉUTILISÉ
   * après un redémarrage — sans lui, un lot resterait verrouillé pour toujours sur
   * un pid qui n'est plus celui du pilote. Absent d'un lot écrit par une version
   * antérieure : le pid y reste alors la seule autorité (le lot se lit et se
   * reprend comme avant).
   */
  owner: { pid: number; sessionFile: string | null; sessionId: string | null; heartbeatAt?: number };
  createdAt: number;
  launchedAt: number | null;
  /**
   * Le pilote du lot ARBITRE (S-9) : `true` quand le lot est piloté par le service, qui
   * câble l'arbitre. Une feature avec contexte (`auditSession`) d'un tel lot passe donc
   * par l'arbitre avant l'utilisateur, même avant que sa marque `arbitration` soit
   * posée (question en vol tout juste parue) : la Console le lit. Absent = `false`.
   */
  arbiter?: boolean;
  features: LotFeature[];
};


export type LotTotals = { done: number; blocked: number; failed: number; cancelled: number; live: number };


export const LOT_FEATURE_STATES: Record<LotFeatureState, true> = {
  pending: true,
  running: true,
  waiting: true,
  blocked: true,
  failed: true,
  done: true,
  cancelled: true,
};

export const LOT_WAIT_KINDS: Record<LotWaitKind, true> = { answer: true, specs: true, review: true, ci: true };

export const LOT_ORIGINS: Record<LotOrigin, true> = { session: true, panneau: true };


/** Un état terminal ne repart que par une relance explicite (S-9). */
export function lotStateTerminal(state: LotFeatureState): boolean {
  return state === "blocked" || state === "failed" || state === "done" || state === "cancelled";
}


/**
 * Une feature peut-elle être ABANDONNÉE (S-9) ? Tout sauf `done` et `cancelled` :
 * une bloquée ou une échouée est relançable par `R`, mais `R` rouvre un crédit de
 * correction entier — ce n'est pas un abandon, et le panneau propose donc `c`
 * dessus.
 */
export function lotStateCancellable(state: LotFeatureState): boolean {
  return state !== "done" && state !== "cancelled";
}


/**
 * Le propriétaire d'un lot est-il encore là ? Le pid vivant ne suffit pas : après
 * un redémarrage, un pid enregistré peut désigner un AUTRE process, et le lot
 * resterait verrouillé pour toujours (chaque geste répondrait « piloté par une
 * autre session »). Un lot sans battement — écrit par une version antérieure —
 * garde donc le pid pour seule autorité : il se lit et se reprend comme avant.
 */
export function lotOwnerAlive(owner: Lot["owner"], now: number): boolean {
  if (!pidAlive(owner.pid)) return false;
  const beat = owner.heartbeatAt;
  if (typeof beat !== "number" || !Number.isFinite(beat)) return true;
  return now - beat <= LOT_OWNER_STALE_MS;
}


export function lotStateLabel(state: LotFeatureState): string {
  switch (state) {
    case "pending":
      return "à venir";
    case "running":
      return "en cours";
    case "waiting":
      return "attend";
    case "blocked":
      return "bloqué";
    case "failed":
      return "échoué";
    case "done":
      return "terminé";
    case "cancelled":
      return "annulé";
  }
}


/** Le libellé du jalon en cours d'attente (« attend ma réponse », …). */
export function lotWaitLabel(waitKind: LotWaitKind | null): string | null {
  if (waitKind === "answer") return "attend réponse";
  if (waitKind === "specs") return "attend validation";
  if (waitKind === "review") return "attend accord";
  if (waitKind === "ci") return "attend intégration continue";
  return null;
}


/** Au plus neuf options sélectionnables (S-3) : au-delà, la question reste lisible. */
export const MAX_REPLY_OPTIONS = 9;


/**
 * La forme EXACTE d'une option de question (S-3) : `- (1) <libellé>`. Le `\s*`
 * après la puce facultative est ce qui fait tenir la forme que la directive
 * impose aux runs (« `- (1) <libellé du choix>` ») : sans lui, la regex de la
 * spec ne reconnaissait ni `- (1) …` ni `* (2) …`, ses deux exemples.
 */
export const REPLY_OPTION = /^[-*]?\s*\((\d{1,2})\)\s+(\S.*)$/;


/** Le libellé d'une ligne d'option, ou `null` si la ligne n'en est pas une. */
export function replyOptionLabel(line: string): string | null {
  const match = REPLY_OPTION.exec(line.trim());
  if (!match) return null;
  const label = (match[2] as string).trim();
  return label === "" ? null : label;
}


/**
 * Les bornes du DERNIER bloc contigu de lignes d'options d'un texte, ou `null`.
 * Seule la dernière séquence compte : les options d'une question ancienne,
 * séparées par du texte, ne sont pas offertes — le panneau n'offre que ce à quoi
 * la feature attend une réponse maintenant.
 */
export function optionBlock(lines: string[]): { first: number; last: number } | null {
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (replyOptionLabel(lines[i] as string) !== null) {
      last = i;
      break;
    }
  }
  if (last === -1) return null;
  let first = last;
  while (first > 0 && replyOptionLabel(lines[first - 1] as string) !== null) first -= 1;
  return { first, last };
}


/**
 * Les libellés d'options d'une question en attente, dans l'ordre, au plus
 * MAX_REPLY_OPTIONS. Pure : la question est le `waitPrompt` du lot, déjà lu.
 */
export function parseReplyOptions(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n");
  const block = optionBlock(lines);
  if (block === null) return [];
  const options: string[] = [];
  for (let i = block.first; i <= block.last && options.length < MAX_REPLY_OPTIONS; i += 1) {
    const label = replyOptionLabel(lines[i] as string);
    if (label !== null) options.push(label);
  }
  return options;
}


/**
 * La QUESTION d'un prompt de maillon (S-7) : ses lignes, SANS le bloc d'options
 * final — celui-ci est rendu juste après, numéroté et sélectionnable. Sans ça, la
 * zone lirait deux fois la même liste, et le nombre de rangs de la question
 * dépendrait du nombre d'options.
 */
export function questionOf(prompt: string | null): string | null {
  if (prompt === null || prompt.trim() === "") return null;
  const lines = prompt.split("\n");
  const block = optionBlock(lines);
  const head = (block === null ? lines : lines.slice(0, block.first)).join("\n").trim();
  return head === "" ? null : head;
}


/**
 * La question en TEXTE qui TERMINE une sortie de run (S-8 §1), ou `null`. Deux
 * conditions, toutes deux nécessaires : un bloc d'options (`- (1) <libellé>`), et
 * RIEN après lui — une question ancienne suivie du livrable n'est pas une
 * question en attente. C'est ce qui autorise un maillon specs/impl/review à
 * s'arrêter sur une question au lieu d'enchaîner : la détection reste étroite,
 * elle ne se déclenche jamais sur une sortie qui a produit son livrable.
 */
export function trailingQuestion(stdout: string): string | null {
  const text = stdout.trimEnd();
  if (text === "") return null;
  const lines = text.split("\n");
  const block = optionBlock(lines);
  if (block === null) return null;
  for (const line of lines.slice(block.last + 1)) {
    if (line.trim() !== "") return null;
  }
  return questionOf(text);
}


/**
 * Ce qu'un rang accepte comme écriture (S-11, S-6, S-7, S-8) : la règle unique,
 * appliquée deux fois — le panneau s'en sert pour poser sa zone de saisie, et
 * `answer` l'applique pour exécuter. Pure : elle décide, elle n'écrit pas.
 *
 * Deux variantes sont nées du canal vers un run vivant : `steer` (un run armé
 * reçoit le texte DANS son tour) et `ask` (il attend une réponse à sa question).
 * `text` est la feature bloquée : elle n'a plus de run, sa réponse en relance un.
 */
export type RowReply =
  | { kind: "reply"; phase: PipelinePhase; question: string | null; options: string[] }
  | { kind: "ask"; phase: PipelinePhase; question: string; options: PanelAskOption[]; toolCallId: string; inbox: string }
  | { kind: "steer"; phase: PipelinePhase; inbox: string }
  | { kind: "text"; phase: PipelinePhase }
  | { kind: "queue"; phase: PipelinePhase }
  | { kind: "closed"; reason: string };


/** Ce que la règle d'écriture sait du run VIVANT d'une feature (S-6, S-7). */
export type RowLiveWriter = {
  inbox?: string | null;
  pendingAsk?: PanelPendingAsk | null;
  auditRelay?: boolean;
  /** L'écrivain EST l'arbitre ou le contexte (S-9) : le verrou « arbitrage en cours » ne s'applique pas à lui. */
  viaArbiter?: boolean;
};


/** Refus d'écriture d'une question confiée à /audit, mot pour mot (S-3). */
export const AUDIT_RELAY_REFUSAL = "question confiée à la session /audit — elle revient ici si cette session se ferme";

/** Refus des touches `v`/`y` sur un jalon confié à /audit, mot pour mot (S-3). */
export const AUDIT_RELAY_MILESTONE_REFUSAL = "jalon confié à la session /audit — il revient ici si cette session se ferme";

/** Premier item du pied d'une feature relayée (S-3). */
export const AUDIT_RELAY_FOOTER = "relayé à /audit";

/** Refus d'écriture d'une question confiée à /project, mot pour mot (S-6 §6). */
export const PROJECT_RELAY_REFUSAL = "question confiée à la session /project — elle revient ici si cette session se ferme";

/** Refus des touches `v`/`y` sur un jalon confié à /project, mot pour mot (S-6 §6). */
export const PROJECT_RELAY_MILESTONE_REFUSAL = "jalon confié à la session /project — il revient ici si cette session se ferme";

/** Premier item du pied d'une feature relayée à /project (S-6 §6). */
export const PROJECT_RELAY_FOOTER = "relayé à /project";

/** Le refus de réponse, de `v` et de `y` pendant qu'un arbitre juge l'élément courant (S-10), mot pour mot. */
export const ARBITRATION_REFUSAL = "arbitrage en cours — la décision sera consignée au journal";


/** Le refus d'écriture d'une question relayée : le texte du GENRE de relais de la feature. */
export function relayRefusal(feature: LotFeature): string {
  return feature.relayKind === "project" ? PROJECT_RELAY_REFUSAL : AUDIT_RELAY_REFUSAL;
}

/** Le refus de `v`/`y` sur un jalon relayé, selon le genre de relais de la feature. */
export function relayMilestoneRefusal(feature: LotFeature): string {
  return feature.relayKind === "project" ? PROJECT_RELAY_MILESTONE_REFUSAL : AUDIT_RELAY_MILESTONE_REFUSAL;
}

/** Le premier item du pied d'une feature relayée, selon son genre de relais. */
export function relayFooter(feature: LotFeature): string {
  return feature.relayKind === "project" ? PROJECT_RELAY_FOOTER : AUDIT_RELAY_FOOTER;
}

/** Le motif d'un refus d'écriture est-il celui d'une question relayée (l'un des deux genres) ? */
export function isRelayRefusal(reason: string): boolean {
  return reason === AUDIT_RELAY_REFUSAL || reason === PROJECT_RELAY_REFUSAL || reason === ARBITRATION_REFUSAL;
}

/**
 * Le refus d'un geste de jalon (`v`, `y`) pour l'utilisateur : l'arbitre juge
 * l'élément (S-10), ou une session /audit ou /project ouverte le porte. `null` : le geste passe.
 */
export function milestoneGestureRefusal(feature: LotFeature, relayed: boolean): string | null {
  if (feature.arbitration !== undefined) return ARBITRATION_REFUSAL;
  return relayed ? relayMilestoneRefusal(feature) : null;
}


// --- les refus du lot, mot pour mot ------------------------------------------
// Une seule source pour chaque motif : le geste du panneau, le relais et la
// commande du canal (`commands.ts`) doivent dire EXACTEMENT la même chose — deux
// littéraux jumeaux dans deux fichiers divergent à la première retouche, et c'est
// le texte de l'accusé qui fait foi côté client (S-1).

/** Aucun lot pour ce dépôt (S-3). */
export const LOT_NONE_REFUSAL = "aucun lot pour ce dépôt";

/** La feature visée n'est pas dans le lot. */
export function lotFeatureMissingRefusal(slug: string): string {
  return `« ${slug} » n'est pas dans le lot`;
}

/** Un ajout dont le slug est déjà dans le lot. */
export function lotSlugPresentRefusal(slug: string): string {
  return `« ${slug} » est déjà dans le lot`;
}

/** Un ajout dont la branche `feat/<slug>` existe déjà (hints git compris). */
export function lotBranchTakenRefusal(branch: string): string {
  return `la branche ${branch} existe déjà — renomme la feature (un autre nom) ou supprime la branche (git branch -D ${branch})`;
}

/** Une dépendance qui n'est pas dans le lot. */
export function lotUnknownDepRefusal(dep: string): string {
  return `dépendance inconnue : ${dep}`;
}

/** Une dépendance qui désigne la feature elle-même. */
export function lotCyclicDepRefusal(slug: string): string {
  return `dépendance circulaire : ${slug}`;
}

/** Le retrait d'une feature déjà démarrée (le hint TUI `c` en fait partie). */
export function lotRemoveStartedRefusal(slug: string): string {
  return `« ${slug} » a déjà démarré — c pour annuler`;
}

/** Le retrait d'une feature dont une feature EN ATTENTE dépend. */
export function lotRemoveDependentRefusal(slug: string): string {
  return `retrait refusé : ${slug} en dépend`;
}


/**
 * Ce qu'une feature du lot accepte, dans cet ordre (S-11, S-6, S-7, S-8) : la
 * collecte d'une feature ouverte par /req se répond DANS la session ; une feature
 * qui attend une réponse la reçoit ; une feature bloquée se relance par une
 * réponse ; une feature qui tourne avec un run ARMÉ reçoit le message dans son
 * tour (question `ask` en vol, sinon texte) ; une feature qui tourne sans boîte
 * met le texte en file ; tout autre état est fermé. Le second argument est
 * facultatif : sans lui, la règle est celle d'avant le canal (file).
 */
export function rowReply(feature: LotFeature, live?: RowLiveWriter | null): RowReply {
  const reply = rowReplyOf(feature, live);
  // Une question relayée ne se répond pas ici : c'est la session /audit ou
  // /project qui la tranche (S-3, S-6 §6). Les autres écritures (steer, file,
  // texte) restent.
  if (feature.arbitration !== undefined && live?.viaArbiter !== true && (reply.kind === "ask" || reply.kind === "reply")) {
    return { kind: "closed", reason: ARBITRATION_REFUSAL };
  }
  if (live?.auditRelay === true && (reply.kind === "ask" || reply.kind === "reply")) {
    return { kind: "closed", reason: relayRefusal(feature) };
  }
  return reply;
}


function rowReplyOf(feature: LotFeature, live?: RowLiveWriter | null): RowReply {
  if (feature.origin === "session" && feature.phase === "req") {
    return { kind: "closed", reason: "la collecte se déroule dans ta session — réponds-y directement" };
  }
  if (feature.state === "waiting" && feature.waitKind === "answer") {
    return {
      kind: "reply",
      phase: feature.phase,
      question: questionOf(feature.waitPrompt),
      options: parseReplyOptions(feature.waitPrompt),
    };
  }
  if (feature.state === "blocked") return { kind: "text", phase: feature.phase };
  if (feature.state === "running") {
    const inbox = asStringOrNull(live?.inbox);
    if (inbox !== null) {
      const ask = live?.pendingAsk ?? null;
      if (ask) {
        return {
          kind: "ask",
          phase: feature.phase,
          question: ask.question,
          // Les options publiées passent TELLES QUELLES (S-5) : la description que
          // le maillon a fournie est rendue par la zone, et la livraison n'envoie
          // que le libellé.
          options: ask.options,
          toolCallId: ask.toolCallId,
          inbox,
        };
      }
      return { kind: "steer", phase: feature.phase, inbox };
    }
    return { kind: "queue", phase: feature.phase };
  }
  return { kind: "closed", reason: lotReplyRefusal(feature.state) };
}


/**
 * Le motif d'un refus d'écriture, un libellé CORRECT par état (F6) : l'ancien
 * gabarit `la feature est ${lotStateLabel}` produisait « la feature est attend »,
 * « la feature est échoué ». Un libellé par état, sans changer le SENS du refus.
 */
export function lotReplyRefusal(state: LotFeatureState): string {
  switch (state) {
    case "pending":
      return "rien à répondre : la feature n'a pas encore démarré";
    case "running":
      return "rien à répondre : la feature est en cours";
    case "waiting":
      return "rien à répondre : la feature est en attente d'un jalon";
    case "blocked":
      return "rien à répondre : la feature est bloquée";
    case "failed":
      return "rien à répondre : la feature a échoué";
    case "done":
      return "rien à répondre : la feature est terminée";
    case "cancelled":
      return "rien à répondre : la feature est annulée";
  }
}


/**
 * Le motif d'un refus d'annulation, dans les mêmes mots que le refus d'écriture
 * (`lotReplyRefusal`) : un libellé par état, jamais « la feature est terminé ».
 * Seules `done` et `cancelled` refusent — une bloquée ou une échouée s'abandonne.
 */
export function lotCancelRefusal(state: LotFeatureState): string {
  switch (state) {
    case "done":
      return "annulation impossible : la feature est déjà terminée";
    case "cancelled":
      return "annulation impossible : la feature est déjà annulée";
    case "pending":
      return "annulation impossible : la feature n'a pas encore démarré";
    case "running":
      return "annulation impossible : la feature est en cours";
    case "waiting":
      return "annulation impossible : la feature est en attente d'un jalon";
    case "blocked":
      return "annulation impossible : la feature est bloquée";
    case "failed":
      return "annulation impossible : la feature a échoué";
  }
}


/** `<stateDir>/lots` : un fichier par dépôt. */
export function lotStateDir(stateDir: string): string {
  return path.join(stateDir, "lots");
}


/** `sha1(realpath(repoRoot)).slice(0,16)` : même famille d'id que `runningIdFor`. */
export function lotRepoKey(repoRoot: string): string {
  return crypto.createHash("sha1").update(realpathOr(repoRoot)).digest("hex").slice(0, 16);
}


export function lotPathFor(stateDir: string, repoKey: string): string {
  return path.join(lotStateDir(stateDir), `${repoKey}.json`);
}


export function asLotFeatureState(value: unknown): LotFeatureState | null {
  return typeof value === "string" && LOT_FEATURE_STATES[value as LotFeatureState] === true
    ? (value as LotFeatureState)
    : null;
}


/** Le verdict de revue publié dans le lot : absent ou hors vocabulaire vaut `null`. */
export function asReviewVerdict(value: unknown): "blockers" | "clean" | "unreadable" | null {
  return value === "blockers" || value === "clean" || value === "unreadable" ? value : null;
}


/**
 * Un lancement retenu (S-3), lu TOLÉRAMMENT : absent, hors vocabulaire ou
 * incomplet (phase inconnue, `kind` inconnu, `fix`/`resume` non booléens, `text`
 * non textuel) vaut « absent » — jamais un rejet de la feature, dont le schéma ne
 * doit pas dépendre d'un champ d'attente. Le texte est rogné à la borne de
 * l'éditeur, la même que celle qui l'a écrit.
 */
export function asHeldLaunch(raw: unknown): HeldLaunch | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  if (!PIPELINE_PHASES.includes(h.phase as PipelinePhase)) return null;
  if (typeof h.fix !== "boolean" || typeof h.resume !== "boolean") return null;
  if (h.kind !== "collecte" && h.kind !== "phase" && h.kind !== "relaunch" && h.kind !== "answer") return null;
  if (h.text !== undefined && typeof h.text !== "string") return null;
  return {
    phase: h.phase as PipelinePhase,
    fix: h.fix,
    kind: h.kind,
    resume: h.resume,
    ...(typeof h.text === "string" ? { text: h.text.slice(0, LOT_EDITOR_MAX) } : {}),
    ...(h.source === "contexte" || h.source === "arbitrage" ? { source: h.source } : {}),
    ...(typeof h.refocus === "string" && h.refocus !== "" ? { refocus: h.refocus } : {}),
  };
}


/**
 * Un sha de base de worktree valide (S-7) : 40 hexadécimaux minuscules (SHA-1) ou
 * 64 (SHA-256) — la seule forme que le lot écrit et relit dans `LotFeature.base`.
 */
export function isLotBaseSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);
}


/** Le quota d'une feature relu du disque : complet ou absent (S-5), jamais un rejet. */
function asFeatureQuota(raw: unknown): FeatureQuota | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.provider !== "string" || q.provider === "") return null;
  if (typeof q.model !== "string" || q.model === "") return null;
  if (typeof q.until !== "number" || !Number.isFinite(q.until)) return null;
  if (typeof q.announced !== "boolean") return null;
  if (!PIPELINE_PHASES.includes(q.phase as PipelinePhase)) return null;
  return { provider: q.provider, model: q.model, until: q.until, announced: q.announced, phase: q.phase as PipelinePhase };
}

/** Les enregistrements de run relus du disque (S-12) : seuls les complets, au plus `LOT_RUNS_MAX`. */
function asRunRecords(raw: unknown): LotRunRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: LotRunRecord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const step = r.step === "arbitre" || PIPELINE_PHASES.includes(r.step as PipelinePhase) ? (r.step as LotRunRecord["step"]) : null;
    if (step === null || typeof r.fix !== "boolean") continue;
    if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt) || typeof r.endedAt !== "number" || !Number.isFinite(r.endedAt)) continue;
    const peak = typeof r.peakContext === "number" && Number.isFinite(r.peakContext) ? r.peakContext : null;
    out.push({
      step,
      lot: typeof r.lot === "string" && r.lot !== "" ? r.lot : null,
      fix: r.fix,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      peakContext: peak,
      compactions: typeof r.compactions === "number" && Number.isInteger(r.compactions) && r.compactions >= 0 ? r.compactions : 0,
      sessionFile: typeof r.sessionFile === "string" && r.sessionFile !== "" ? r.sessionFile : null,
    });
  }
  return out.slice(-LOT_RUNS_MAX);
}

/** Ajoute un run terminé à la feature ; au-delà de `LOT_RUNS_MAX`, les plus anciens sont retirés (S-12). */
export function appendRunRecord(feature: LotFeature, record: LotRunRecord): void {
  feature.runs = [...(feature.runs ?? []), record].slice(-LOT_RUNS_MAX);
}


/** L'arbitrage en vol relu du disque (S-9) : complet ou absent. */
function asFeatureArbitration(raw: unknown): FeatureArbitration | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.key !== "string" || a.key === "" || typeof a.startedAt !== "number" || !Number.isFinite(a.startedAt)) return null;
  return {
    key: a.key,
    startedAt: a.startedAt,
    ...(a.status === "queued" || a.status === "deciding" ? { status: a.status } : {}),
    ...(typeof a.decidingAt === "number" && Number.isFinite(a.decidingAt) ? { decidingAt: a.decidingAt } : {}),
  };
}


/** L'escalade relue du disque (S-9, S-10) : complète ou absente. */
function asFeatureEscalation(raw: unknown): FeatureEscalation | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.key !== "string" || e.key === "") return null;
  if (e.kind !== "question" && e.kind !== "jalon" && e.kind !== "plafond" && e.kind !== "echec") return null;
  if (typeof e.phase !== "string" || (PIPELINE_PHASES as readonly string[]).indexOf(e.phase) < 0) return null;
  if (typeof e.question !== "string" || typeof e.reason !== "string") return null;
  if (!Array.isArray(e.options) || !e.options.every((o) => typeof o === "string")) return null;
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return null;
  return {
    key: e.key,
    kind: e.kind,
    phase: e.phase as PipelinePhase,
    question: e.question,
    options: e.options as string[],
    reason: e.reason,
    at: e.at,
  };
}

/** Les relances de l'arbitre relues du disque : deux entiers ≥ 0 et le dernier motif, sinon absentes. */
function asArbiterRelaunches(raw: unknown): ArbiterRelaunches | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (!isCount(r.cap) || !isCount(r.failure)) return null;
  if (r.last !== "cap" && r.last !== "failure") return null;
  return { cap: r.cap, failure: r.failure, last: r.last };
}

/** La porte d'intégration continue, relue complète ou absente (jamais un rejet de la feature). */
function asFeatureCi(raw: unknown): FeatureCi | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.sha !== "string" || o.sha === "" || typeof o.tree !== "string" || o.tree === "") return null;
  if (typeof o.pushedAt !== "number" || !Number.isFinite(o.pushedAt)) return null;
  if (o.state !== "pending" && o.state !== "green" && o.state !== "red") return null;
  const checkedAt = typeof o.checkedAt === "number" && Number.isFinite(o.checkedAt) ? o.checkedAt : null;
  const failures = Array.isArray(o.failures)
    ? o.failures.flatMap((entry): CiFailure[] => {
        if (!entry || typeof entry !== "object") return [];
        const e = entry as Record<string, unknown>;
        return typeof e.name === "string" && typeof e.url === "string" ? [{ name: e.name, url: e.url }] : [];
      })
    : [];
  return { sha: o.sha, tree: o.tree, pushedAt: o.pushedAt, state: o.state, checkedAt, failures };
}


/** La fin de sortie du dernier échec, relue du disque : deux chaînes, sinon absente. */
function asFailureOutput(raw: unknown): { stderr: string; stdout: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.stderr !== "string" || typeof o.stdout !== "string") return null;
  return { stderr: o.stderr, stdout: o.stdout };
}



/** Validation champ par champ : un fichier au schéma incomplet est rejeté. */
export function asLotFeature(raw: unknown): LotFeature | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  // Le FORMAT du slug compte autant que son type : il nomme un répertoire de
  // worktree et sort de la base d'archive (`worktreePathFor`), puis sert de `cwd`
  // aux runs. Un slug hors `[a-z0-9-]` — fichier de lot falsifié ou écrit par une
  // version future — est donc rejeté ici, comme un champ manquant.
  if (typeof f.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(f.slug)) return null;
  if (typeof f.name !== "string" || typeof f.branch !== "string" || typeof f.worktree !== "string") return null;
  const state = asLotFeatureState(f.state);
  if (!state) return null;
  if (!PIPELINE_PHASES.includes(f.phase as PipelinePhase)) return null;
  const origin =
    typeof f.origin === "string" && LOT_ORIGINS[f.origin as LotOrigin] === true ? (f.origin as LotOrigin) : null;
  if (!origin) return null;
  const waitKind =
    f.waitKind === null
      ? null
      : typeof f.waitKind === "string" && LOT_WAIT_KINDS[f.waitKind as LotWaitKind] === true
        ? (f.waitKind as LotWaitKind)
        : undefined;
  if (waitKind === undefined) return null;
  const deps = Array.isArray(f.deps) ? f.deps.filter((d): d is string => typeof d === "string") : [];
  // La file (S-5) suit la convention déjà en place pour `deps` : un champ absent
  // ou qui n'est pas un tableau vaut `[]`, donc un lot écrit avant cette feature se
  // lit sans aucune modification. Les textes vides tombent, l'ordre est conservé,
  // et chaque texte est rogné à la borne de l'éditeur.
  const pendingTexts = Array.isArray(f.pendingTexts)
    ? f.pendingTexts
        .filter((t): t is string => typeof t === "string" && t.trim() !== "")
        .slice(0, LOT_PENDING_MAX)
        .map((t) => t.slice(0, LOT_EDITOR_MAX))
    : [];
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const held = asHeldLaunch(f.held);
  const featureQuota = asFeatureQuota(f.quota);
  const arbitration = asFeatureArbitration(f.arbitration);
  const escalation = asFeatureEscalation(f.escalation);
  const runs = asRunRecords(f.runs);
  const arbiterRelaunches = asArbiterRelaunches(f.arbiterRelaunches);
  const featureCi = asFeatureCi(f.ci);
  const failureOutput = asFailureOutput(f.failureOutput);
  return {
    slug: f.slug,
    name: f.name,
    branch: f.branch,
    worktree: f.worktree,
    deps,
    origin,
    state,
    // La phase est validée contre la liste ci-dessus : c'est un PipelinePhase.
    phase: f.phase as PipelinePhase,
    waitKind,
    waitPrompt: asStringOrNull(f.waitPrompt),
    sessionFile: asStringOrNull(f.sessionFile),
    pendingTexts,
    prUrl: asStringOrNull(f.prUrl),
    stopReason: asStringOrNull(f.stopReason),
    fixes: Math.max(0, Math.trunc(num(f.fixes, 0))),
    unreadableRuns: Math.max(0, Math.trunc(num(f.unreadableRuns, 0))),
    ...(Math.trunc(num(f.autoResumes, 0)) > 0 ? { autoResumes: Math.trunc(num(f.autoResumes, 0)) } : {}),
    reviewHash: asStringOrNull(f.reviewHash),
    // Un verdict hors vocabulaire est lu comme ABSENT plutôt que de faire rejeter
    // le lot : ce champ ne sert qu'à l'affichage du panneau, et un lot amputé
    // ferait disparaître un pipeline entier du panneau.
    lastVerdict: asReviewVerdict(f.lastVerdict),
    lastBlockers: Math.max(0, Math.trunc(num(f.lastBlockers, 0))),
    lastRunSessionFile: asStringOrNull(f.lastRunSessionFile),
    // Même patron que `launched` : la clé n'est relue que si elle porte un sélecteur
    // ou `null` explicite ; un lot antérieur ne la porte pas et se relit à l'identique.
    ...("lastVerdictModel" in f && (typeof f.lastVerdictModel === "string" || f.lastVerdictModel === null)
      ? { lastVerdictModel: f.lastVerdictModel }
      : {}),
    // La clé n'est écrite QUE lorsqu'elle est `false` : un lot qui ne la porte pas
    // (version antérieure, ou feature lancée) se relit à l'identique, et le garde
    // `!== false` la traite comme lancée.
    ...(f.launched === false ? { launched: false } : {}),
    // Même patron : écrite seulement quand elle porte un chemin absolu ; toute autre
    // valeur est lue comme absente, sans rejeter la feature ni le lot.
    ...(typeof f.auditSession === "string" && path.isAbsolute(f.auditSession) ? { auditSession: f.auditSession } : {}),
    // Le genre de relais et la base (S-7) : même patron — relus seulement s'ils
    // valent exactement `"project"` / un sha complet, sinon absents (jamais un rejet).
    ...(f.relayKind === "project" ? { relayKind: "project" as const } : {}),
    ...(isLotBaseSha(f.base) ? { base: f.base } : {}),
    // Les replis (S-1) : mêmes règles de lecture que les modèles — `""`, `null` ou
    // un autre type sont lus comme ABSENTS, jamais un rejet.
    ...(typeof f.fallbackReqSpecs === "string" && f.fallbackReqSpecs.trim() !== ""
      ? { fallbackReqSpecs: f.fallbackReqSpecs }
      : {}),
    ...(typeof f.fallbackImplReview === "string" && f.fallbackImplReview.trim() !== ""
      ? { fallbackImplReview: f.fallbackImplReview }
      : {}),
    // L'arbitrage en vol, l'escalade et la source du jalon (S-9, S-10, S-11) : relus complets ou absents.
    ...(arbitration ? { arbitration } : {}),
    ...(escalation ? { escalation } : {}),
    ...(runs.length > 0 ? { runs } : {}),
    ...(f.milestoneSource === "arbitrage" || f.milestoneSource === "utilisateur" ? { milestoneSource: f.milestoneSource } : {}),
    ...(() => {
      const ids = Array.isArray(f.implLots) ? f.implLots.filter((id): id is string => typeof id === "string" && id !== "") : [];
      const rank = Math.trunc(num(f.implLot, -1));
      return ids.length >= 2 && rank >= 0 && rank < ids.length ? { implLots: ids, implLot: rank } : {};
    })(),
    // Garde « contrat endommagé » : seules les chaînes connues sont gardées ; un
    // non-tableau laisse la clé absente (garde inactive).
    ...(Array.isArray(f.launchSections)
      ? { launchSections: f.launchSections.filter((t): t is string => typeof t === "string" && (REQUIRED_CONTRACT_SECTIONS as readonly string[]).includes(t)) }
      : {}),
    // Le quota bloquant (S-5) : relu seulement quand il est complet, sinon absent.
    ...(featureQuota ? { quota: featureQuota } : {}),
    // Les relances de l'arbitre (cap, failure) et la fin de sortie du dernier échec : relues complètes ou absentes.
    ...(arbiterRelaunches ? { arbiterRelaunches } : {}),
    ...(failureOutput ? { failureOutput } : {}),
    // La porte d'intégration continue (S-9) : relue complète ou absente.
    ...(featureCi ? { ci: featureCi } : {}),
    // Les modèles (S-1) : chaque clé n'est écrite que si elle est non vide après
    // `trim()` — toute autre valeur (`""`, `42`, `null`) est lue comme ABSENTE,
    // jamais un rejet. Les valeurs ne sont pas revalidées contre le catalogue : un
    // modèle retiré depuis le choix reste écrit et transmis, et c'est le run qui
    // échoue.
    ...(typeof f.modelReqSpecs === "string" && f.modelReqSpecs.trim() !== "" ? { modelReqSpecs: f.modelReqSpecs } : {}),
    ...(typeof f.modelImplReview === "string" && f.modelImplReview.trim() !== ""
      ? { modelImplReview: f.modelImplReview }
      : {}),
    // L'ancien modèle unique, relu pour la compatibilité seulement (AC-4).
    ...(typeof f.model === "string" && f.model.trim() !== "" ? { model: f.model } : {}),
    // Le lancement retenu (S-3) : écrit seulement quand il est exploitable — même
    // patron que `launched` et `auditSession`, un `held` incomplet est absent.
    ...(held ? { held } : {}),
    contractHash: asStringOrNull(f.contractHash),
    addedAt: num(f.addedAt, 0),
    sinceAt: num(f.sinceAt, 0),
    updatedAt: num(f.updatedAt, 0),
    endedAt: typeof f.endedAt === "number" && Number.isFinite(f.endedAt) ? f.endedAt : null,
  };
}


export function asLot(raw: unknown): Lot | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  if (l.version !== LOT_VERSION) return null;
  if (typeof l.id !== "string" || l.id === "" || typeof l.repoRoot !== "string" || l.repoRoot === "") return null;
  if (l.status !== "draft" && l.status !== "running") return null;
  if (!Array.isArray(l.features)) return null;
  // Une feature invalide fait rejeter le lot ENTIER : un lot amputé en silence
  // ferait disparaître un pipeline du panneau et lancerait les runs d'un état que
  // personne n'a écrit. Même doctrine que le reste du fichier — un schéma
  // incomplet est lu comme absent (S-1), et le panneau le compte comme illisible.
  const features: LotFeature[] = [];
  for (const raw of l.features) {
    const feature = asLotFeature(raw);
    if (!feature) return null;
    features.push(feature);
  }
  const owner = l.owner;
  if (!owner || typeof owner !== "object" || typeof (owner as Record<string, unknown>).pid !== "number") return null;
  const o = owner as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    version: LOT_VERSION,
    id: l.id,
    repoRoot: l.repoRoot,
    status: l.status,
    reviewCap: Math.max(1, Math.trunc(typeof l.reviewCap === "number" ? l.reviewCap : 1)),
    // Le plafond de runs parallèles (S-2), lu TOLÉRAMMENT : un champ absent, non
    // numérique ou non fini vaut `PIPELINE_SLOTS_DEFAULT`, une valeur hors bornes
    // est ramenée dans `[1, 32]` — donc un lot d'une version antérieure se relit
    // sans migration ni bump de `LOT_VERSION`, et aucune valeur ne bloque tout.
    slotCap: envInt(
      typeof l.slotCap === "number" ? String(l.slotCap) : undefined,
      PIPELINE_SLOTS_DEFAULT,
      1,
      PIPELINE_SLOTS_MAX,
    ),
    recapAt: typeof l.recapAt === "number" && Number.isFinite(l.recapAt) ? l.recapAt : null,
    owner: {
      pid: o.pid as number,
      sessionFile: asStringOrNull(o.sessionFile),
      sessionId: asStringOrNull(o.sessionId),
      // Absent d'un lot d'avant le battement : la clé n'est alors PAS écrite, et
      // `lotOwnerAlive` retombe sur le pid seul (le lot reste reprenable).
      ...(typeof o.heartbeatAt === "number" && Number.isFinite(o.heartbeatAt) ? { heartbeatAt: o.heartbeatAt } : {}),
    },
    createdAt: num(l.createdAt),
    launchedAt: typeof l.launchedAt === "number" && Number.isFinite(l.launchedAt) ? l.launchedAt : null,
    ...(l.arbiter === true ? { arbiter: true } : {}),
    features,
  };
}


/** Le lot du dépôt, ou `null` (absent, illisible, ou schéma d'une autre version). */
export function readLot(stateDir: string, repoKey: string): Lot | null {
  return asLot(readJsonFile(lotPathFor(stateDir, repoKey)));
}


export function writeLot(stateDir: string, lot: Lot): void {
  writeJsonAtomic(lotPathFor(stateDir, lot.id), { ...lot, version: LOT_VERSION });
}


export function lotFeature(lot: Lot, slug: string): LotFeature | undefined {
  return lot.features.find((f) => f.slug === slug);
}


/** Une feature sans dépendance satisfaite n'a pas le droit de démarrer (S-10). */
export function runnable(lot: Lot, feature: LotFeature): boolean {
  return feature.deps.every((dep) => lotFeature(lot, dep)?.state === "done");
}


/**
 * Le nombre de créneaux OCCUPÉS (S-1) : les features du lot `running`, hors
 * collecte de session (`origin === "session" && phase === "req"` — elle appartient
 * à la session de l'utilisateur, ce n'est pas un run du pilote). Aucune autre
 * source n'entre dans le compte : ni le magasin `running/`, ni le panneau, ni un
 * autre dépôt. Un run HORS LOT ne consomme donc aucun créneau (AC-4).
 */
export function slotBusy(lot: Lot): number {
  let busy = 0;
  for (const feature of lot.features) {
    if (feature.state !== "running") continue;
    if (feature.origin === "session" && feature.phase === "req") continue;
    busy += 1;
  }
  return busy;
}


/** Reste-t-il un créneau ? Le plafond effectif est `lot.slotCap`, jamais l'environnement. */
export function hasFreeSlot(lot: Lot): boolean {
  return slotBusy(lot) < lot.slotCap;
}


/** Le nombre de créneaux libres, jamais négatif : c'est lui qui borne une passe. */
export function freeSlots(lot: Lot): number {
  return Math.max(0, lot.slotCap - slotBusy(lot));
}


/**
 * Une feature RUNNABLE retenue par le plafond, telle que la passe la verrait (S-1,
 * S-3) : le lot TOURNE, elle est `pending` et lancée, ses dépendances sont
 * satisfaites, et plus aucun créneau n'est libre. Ne teste PAS `feature.worktree` :
 * une feature dont l'arbre n'est pas encore créé est retenue comme les autres.
 */
export function heldBySlots(lot: Lot, feature: LotFeature): boolean {
  return (
    lot.status === "running" &&
    feature.state === "pending" &&
    feature.launched !== false &&
    runnable(lot, feature) &&
    !hasFreeSlot(lot)
  );
}


/**
 * Raison de blocage héritée d'une dépendance, ou `null`. Une dépendance `done`
 * libère ; une dépendance en cours ou en attente fait patienter (sans erreur) ;
 * échouée, bloquée ou annulée bloque la dépendante (AC-17).
 */
export function dependencyBlock(lot: Lot, feature: LotFeature): string | null {
  for (const dep of feature.deps) {
    const d = lotFeature(lot, dep);
    if (!d) return `dépendance inconnue : ${dep}`;
    if (d.state === "failed" || d.state === "blocked" || d.state === "cancelled") {
      return `dépend de ${dep} (${lotStateLabel(d.state)})`;
    }
  }
  return null;
}


/**
 * Le motif de blocage vient-il d'une DÉPENDANCE (et non du maillon lui-même) ? Seul
 * ce blocage se défait tout seul : quand les dépendances redeviennent saines, la
 * dépendante repasse `pending` à la passe suivante — sans `R`, que l'utilisateur
 * n'a aucune raison d'avoir à taper pour un amont qui a fini par réussir.
 */
export function dependencyStopReason(reason: string | null): boolean {
  return reason !== null && (reason.startsWith("dépend de ") || reason.startsWith("dépendance inconnue : "));
}


export function lotTotals(lot: Lot): LotTotals {
  const totals: LotTotals = { done: 0, blocked: 0, failed: 0, cancelled: 0, live: 0 };
  for (const f of lot.features) {
    if (f.state === "done") totals.done += 1;
    else if (f.state === "blocked") totals.blocked += 1;
    else if (f.state === "failed") totals.failed += 1;
    else if (f.state === "cancelled") totals.cancelled += 1;
    else totals.live += 1;
  }
  return totals;
}


/**
 * Le lot peut-il être REMPLACÉ par un lot neuf ? Seulement quand toutes ses
 * features sont `done` ou `cancelled` — les deux seuls états dont on ne repart
 * jamais. Une `blocked` ou une `failed` est CONSERVÉE : la remplacer la ferait
 * disparaître du lot, sa relance (`R`) deviendrait impossible et son worktree
 * resterait orphelin, sans plus personne pour le nommer.
 */
export function lotReplaceable(lot: Lot): boolean {
  return lot.features.length > 0 && lot.features.every((f) => f.state === "done" || f.state === "cancelled");
}


/**
 * Récap de fin de lot (AC-15) : le décompte exact et une ligne par catégorie non
 * vide. Les raisons des bloquées et des échouées sont reprises telles quelles.
 */
export function buildLotRecap(repo: string, lot: Lot): string {
  const t = lotTotals(lot);
  const lines = [
    `[pipeline] lot ${repo} terminé — ${t.done} terminées, ${t.blocked} bloquées, ${t.failed} échouées, ${t.cancelled} annulées`,
  ];
  const withState = (state: LotFeatureState) => lot.features.filter((f) => f.state === state);
  const done = withState("done").map((f) => f.slug);
  if (done.length > 0) lines.push(`terminé : ${done.join(", ")}`);
  const blocked = withState("blocked");
  if (blocked.length > 0) {
    lines.push(`bloqué : ${blocked.map((f) => `${f.slug} (${f.stopReason ?? "raison inconnue"})`).join(", ")}`);
  }
  const failed = withState("failed");
  if (failed.length > 0) {
    lines.push(`échoué : ${failed.map((f) => `${f.slug} (${f.stopReason ?? "raison inconnue"})`).join(", ")}`);
  }
  const cancelled = withState("cancelled").map((f) => f.slug);
  if (cancelled.length > 0) lines.push(`annulé : ${cancelled.join(", ")}`);
  return lines.join("\n");
}


export type LotAlert = { text: string; tone: "info" | "warning" | "error" };


/**
 * Alerte d'une transition (AC-11) : une par transition, jamais rejouée par une
 * relecture. `null` pour les états qui n'appellent pas l'utilisateur (à venir, en
 * cours, annulé). Le texte ne contient jamais « fin » comme mot isolé : il
 * retraverse `before_agent_start`, où ce mot clôturerait une collecte.
 */
export function buildLotAlert(repo: string, feature: LotFeature): LotAlert | null {
  const head = `${repo}/${feature.slug}`;
  if (feature.state === "waiting") {
    if (feature.waitKind === "specs") {
      return { text: `[pipeline] ${head} : spécifications prêtes, attend ta validation — v dans /pipelines`, tone: "warning" };
    }
    if (feature.waitKind === "review") {
      return {
        text: `[pipeline] ${head} : revue propre, attend ton accord pour livrer — y dans /pipelines`,
        tone: "warning",
      };
    }
    // L'attente de l'intégration continue (S-9) n'appelle personne : le pilote la lit seul.
    if (feature.waitKind === "ci") return null;
    const prompt = feature.waitPrompt ? `\n${clipTail(feature.waitPrompt, LOT_ALERT_PROMPT_MAX)}` : "";
    return {
      text: `[pipeline] ${head} attend ta réponse (maillon /${feature.phase}) — /pipelines${prompt}`,
      tone: "warning",
    };
  }
  if (feature.state === "blocked") {
    return { text: `[pipeline] ${head} bloqué : ${feature.stopReason ?? "raison inconnue"} — /pipelines`, tone: "error" };
  }
  if (feature.state === "failed") {
    return { text: `[pipeline] ${head} échoué : ${feature.stopReason ?? "raison inconnue"} — /pipelines`, tone: "error" };
  }
  if (feature.state === "done") {
    return { text: `[pipeline] ${head} terminé — ${feature.prUrl ? `PR ${feature.prUrl}` : "PR non confirmée"}`, tone: "info" };
  }
  return null;
}


/**
 * L'alerte d'une ESCALADE de l'arbitre (S-9) : le seul moment où une feature arbitrée
 * appelle l'utilisateur — ce que l'arbitre lui confie, son motif, puis la question.
 * Les transitions d'une feature arbitrée (attente, plafond, échec) ne sont pas
 * annoncées : l'arbitre les traite d'abord.
 */
export function buildEscalationAlert(repo: string, feature: LotFeature, escalation: FeatureEscalation): LotAlert {
  const what =
    escalation.kind === "plafond"
      ? "le plafond de revue"
      : escalation.kind === "echec"
        ? "l'échec du run"
        : escalation.kind === "jalon"
          ? escalation.phase === "specs"
            ? "la validation des spécifications"
            : "l'accord pour livrer"
          : "une question";
  const question = escalation.question.trim() === "" ? "" : `\n${clipTail(escalation.question, LOT_ALERT_PROMPT_MAX)}`;
  return {
    text: `[pipeline] ${repo}/${feature.slug} : l'arbitre te confie ${what} (maillon /${escalation.phase}) — /pipelines\nmotif de l'arbitre : ${escalation.reason}${question}`,
    tone: escalation.kind === "echec" || escalation.kind === "plafond" ? "error" : "warning",
  };
}


// --- plafond, sortie de run, timeouts : bornes et lecture d'environnement -----

export const LOT_TICK_MS = 2000;

/**
 * Le battement d'un propriétaire est périmé au-delà de cinq passes : c'est la
 * marge qui sépare « pilote vivant mais occupé » (il bat à chaque passe) d'un pid
 * RÉUTILISÉ par un autre process après un redémarrage. Déclaré ICI, avec la
 * cadence qu'il dérive : une constante qui multiplie `LOT_TICK_MS` ne peut pas
 * vivre avant lui (TDZ à l'import).
 */
export const LOT_OWNER_STALE_MS = 5 * LOT_TICK_MS;

/** Un relais /audit est périmé au même seuil qu'un propriétaire de lot (S-2). */
export const AUDIT_RELAY_STALE_MS = LOT_OWNER_STALE_MS;


/**
 * Le relais /audit d'une feature est-il OUVERT (S-2) ? Le fichier de relais de sa
 * session doit exister, être tenu par le PILOTE du lot (`ownerPid`) — seul à
 * pouvoir exécuter les réponses —, vivant, et battre depuis moins de
 * `AUDIT_RELAY_STALE_MS`. Une feature sans `auditSession` ne lit aucun fichier.
 */
export function auditRelayOpen(stateDir: string, feature: LotFeature, ownerPid: number, now: number): boolean {
  if (feature.auditSession === undefined) return false;
  const record = readAuditRelay(stateDir, feature.auditSession);
  if (record === null || record.pid !== ownerPid || !pidAlive(record.pid)) return false;
  return now - record.heartbeatAt <= AUDIT_RELAY_STALE_MS;
}

export const LOT_RUN_TIMEOUT_MS = 3_600_000;

/**
 * Marge de SÉCURITÉ ajoutée à l'échéance `spec.deadline` du runner hébergé
 * (minuteur du runner → abort → code 124) : borne de sécurité, jamais budget de
 * travail. Le pilote est seul juge du budget de travail, qu'il suspend pendant une
 * question en vol (S-8 §1) ; une échéance de runner calée sur le budget de travail
 * tuerait un run qui attend une réponse humaine, exactement le défaut qu'on répare.
 */
export const LOT_RUN_DEADLINE_MARGIN_MS = 3_600_000;

/**
 * La borne DURE d'un run en minutes (budget + marge) : le seul chiffre que les
 * libellés « délai dépassé (N min) » du pilote doivent citer, pour qu'il ne diverge
 * jamais du minuteur du runner.
 */
export function runHardDeadlineMinutes(runTimeoutMs: number): number {
  return Math.round((runTimeoutMs + LOT_RUN_DEADLINE_MARGIN_MS) / 60_000);
}

export const PIPELINE_REVIEW_CAP_DEFAULT = 3;

/** Le texte d'un run est borné : le panneau en montre la fin (les questions y sont). */
export const LOT_WAIT_PROMPT_MAX = 1200;

export const LOT_ALERT_PROMPT_MAX = 400;

/** Un motif de panne tient dans un rang de panneau et dans une alerte (S-4). */
export const LOT_REASON_MAX = 200;

/** Budget de l'éditeur en ligne du panneau (S-7). */
export const LOT_EDITOR_MAX = 4000;

/** Messages en file par feature (S-5) : au-delà, la mise en file est refusée. */
export const LOT_PENDING_MAX = 9;

/** Caractères en file par feature (S-5) : la somme des textes en attente. */
export const LOT_PENDING_TOTAL_MAX = 12_000;

/** Refus de mise en file, mot pour mot (S-5) : il s'affiche tel quel au panneau. */
export const LOT_PENDING_FULL = "file pleine — attends la transmission des messages en attente";


/** Entier d'environnement borné, ou le défaut (une variable absente ou vide). */
export function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const text = (raw ?? "").trim();
  if (text === "") return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}


/** `MEM0_PIPELINE_REVIEW_CAP` : plafond des tours de correction (défaut 3). */
export function lotReviewCap(env: Record<string, string | undefined> = process.env): number {
  return envInt(env.MEM0_PIPELINE_REVIEW_CAP, PIPELINE_REVIEW_CAP_DEFAULT, 1, 20);
}


/** `MEM0_PIPELINE_ARBITER_JOURNAL` : entrées du journal du lot soumises à l'arbitre (défaut 200). */
export function lotArbiterJournalMax(env: Record<string, string | undefined> = process.env): number {
  return envInt(env.MEM0_PIPELINE_ARBITER_JOURNAL, 200, 1, 10_000);
}


/** `MEM0_PIPELINE_SLOTS` : runs de features du lot menés en parallèle (défaut 4). */
export const PIPELINE_SLOTS_DEFAULT = 4;

/**
 * Borne HAUTE du parallélisme : au-delà, on retombe sur une rafale de processus
 * `omp` que rien ne justifie (et que l'utilisateur n'a pas demandée).
 */
export const PIPELINE_SLOTS_MAX = 32;


/**
 * `MEM0_PIPELINE_SLOTS` : le plafond de runs de features du lot menés en
 * parallèle. Variable absente, vide ou illisible ⇒ 4 ; `0` ou négative ⇒ 1 ; au-delà
 * de 32 ⇒ 32. Aucune valeur ne peut donc empêcher tout démarrage ni laisser le
 * parallélisme illimité — il n'y a PAS de cas « 0 = illimité ». La valeur n'est lue
 * qu'au premier lancement du lot : ensuite, le pilotage compare à `lot.slotCap`.
 */
export function lotSlots(env: Record<string, string | undefined> = process.env): number {
  return envInt(env.MEM0_PIPELINE_SLOTS, PIPELINE_SLOTS_DEFAULT, 1, PIPELINE_SLOTS_MAX);
}


/** `MEM0_PIPELINE_RUN_TIMEOUT_MS` : budget d'un run (défaut 1 h). */
export function lotRunTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return envInt(env.MEM0_PIPELINE_RUN_TIMEOUT_MS, LOT_RUN_TIMEOUT_MS, 10_000, 86_400_000);
}


/** Seuil SOFT par défaut (tokens) : au franchissement, le run hébergé est compacté à la fin du tour. */
export const LOT_CONTEXT_SOFT_DEFAULT = 120_000;

/**
 * Seuil SOFT par défaut d'une REVUE : une revue lit plus qu'elle n'écrit, et son
 * verdict se dégrade dès que le diff et les tests lus ne tiennent plus en tête.
 */
export const LOT_CONTEXT_SOFT_REVIEW_DEFAULT = 90_000;

/** Seuil HARD par défaut (tokens) : atteint, le run n'a plus qu'un dernier tour pour livrer, puis il est coupé. */
export const LOT_CONTEXT_HARD_DEFAULT = 250_000;

/** Les deux seuils de contexte d'un run ou d'une session hébergés. */
export type ContextThresholds = { soft: number; hard: number };

/** Entier ≥ 1 d'une variable de seuil, ou le défaut de CETTE variable (pas de borne : `envInt` bornerait au lieu de retomber). */
function thresholdFromEnv(raw: string | undefined, fallback: number): number {
  const text = (raw ?? "").trim();
  if (text === "") return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  const whole = Math.trunc(value);
  return whole >= 1 ? whole : fallback;
}

/** Le défaut SOFT d'une phase : 90 000 pour la revue, 120 000 ailleurs (et sans phase). */
export function lotContextSoftDefault(phase?: PipelinePhase): number {
  return phase === "review" ? LOT_CONTEXT_SOFT_REVIEW_DEFAULT : LOT_CONTEXT_SOFT_DEFAULT;
}

/**
 * `MEM0_PIPELINE_CONTEXT_SOFT` et `MEM0_PIPELINE_CONTEXT_HARD` (défaut 250000) :
 * seuils de contexte, relus au démarrage de chaque run ou session hébergés et
 * jamais persistés dans le lot. Avec une `phase`, `MEM0_PIPELINE_CONTEXT_SOFT_<PHASE>`
 * (ex. `…_SOFT_REVIEW`) prime sur la variable générale, et le défaut SOFT est celui
 * de la phase (`lotContextSoftDefault`). Une valeur absente, vide, non numérique,
 * nulle ou négative retombe sur la valeur de rang inférieur ; si `soft` atteint ou
 * dépasse `hard`, les deux défauts s'appliquent.
 */
export function lotContextThresholds(env: Record<string, string | undefined> = process.env, phase?: PipelinePhase): ContextThresholds {
  const softDefault = lotContextSoftDefault(phase);
  const general = thresholdFromEnv(env.MEM0_PIPELINE_CONTEXT_SOFT, softDefault);
  const soft = phase === undefined ? general : thresholdFromEnv(env[`MEM0_PIPELINE_CONTEXT_SOFT_${phase.toUpperCase()}`], general);
  const hard = thresholdFromEnv(env.MEM0_PIPELINE_CONTEXT_HARD, LOT_CONTEXT_HARD_DEFAULT);
  if (soft >= hard) return { soft: softDefault, hard: LOT_CONTEXT_HARD_DEFAULT };
  return { soft, hard };
}


/** `MEM0_PIPELINE_OMP_BIN` : binaire `omp` des runs, sinon `omp` du PATH. */
export function lotOmpBin(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.MEM0_PIPELINE_OMP_BIN ?? "").trim();
  return raw === "" ? "omp" : raw;
}


/**
 * `MEM0_PIPELINE_ARCHIVE_DIR` (absolu ou `~`) sinon `~/.omp/pipeline-archive` :
 * même famille que `worktreesBaseDir`, un chemin relatif est ignoré.
 */
export function lotArchiveBaseDir(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const raw = (env.MEM0_PIPELINE_ARCHIVE_DIR ?? "").trim();
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (path.isAbsolute(raw)) return raw;
  return path.join(home, ".omp", "pipeline-archive");
}
