// Le pilote d'un dépôt : une passe = lire, décider, lancer.
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { contractHashOf, effectiveReviewVerdict, isReviewCapReason, nextChainAction, readContractText, reconcileInterrupted, reviewSectionHash } from "./chain.ts";
import type { ChainOutcome } from "./chain.ts";
import { contractLots, reviewBlockers, reviewVerdict } from "./contract.ts";
import type { PipelinePhase } from "./contract.ts";
import { branchFor, branchTaken, contractPathFor, createFeatureWorktree, realpathOr, toSlug, worktreePathFor, worktreesBaseDir } from "./git.ts";
import type { GitResult, GitRunner } from "./git.ts";
import { LOT_ALERT_PROMPT_MAX, LOT_EDITOR_MAX, LOT_NONE_REFUSAL, LOT_PENDING_FULL, LOT_PENDING_MAX, LOT_PENDING_TOTAL_MAX, LOT_REASON_MAX, LOT_RUN_DEADLINE_MARGIN_MS, LOT_TICK_MS, LOT_VERSION, LOT_WAIT_PROMPT_MAX, appendRunRecord, auditRelayOpen, buildLotAlert, buildLotRecap, dependencyBlock, dependencyStopReason, freeSlots, hasFreeSlot, isLotBaseSha, lotArchiveBaseDir, lotBranchTakenRefusal, lotCancelRefusal, lotCyclicDepRefusal, lotFeature, lotFeatureMissingRefusal, lotOwnerAlive, lotRemoveDependentRefusal, lotRemoveStartedRefusal, lotRepoKey, lotReplaceable, lotReviewCap, lotRunTimeoutMs, lotSlots, lotSlugPresentRefusal, lotStateCancellable, lotStateLabel, lotStateTerminal, lotTotals, lotUnknownDepRefusal, readLot, quotaGroupsOf, rowReply, runnable, trailingQuestion, writeLot } from "./lot.ts";
import type { HeldLaunch, Lot, LotFeature, LotFeatureState, RowLiveWriter, RowReply } from "./lot.ts";
import { ARBITRATION_REFUSAL } from "./lot.ts";
import { COMMAND_MAX_PER_PASS, COMMAND_POLL_MS, COMMAND_UNREADABLE_REFUSAL, asCommand, commandAck, commandIdOf, commandRefusal, commandShapeRefusal, commandSlugOf, purgeCommandAcks, readCommandAck, readCommands, removeCommandFile, writeCommandAck } from "./commands.ts";
import type { CommandState, CommandView, PipelineCommand, PipelineCommandAck } from "./commands.ts";
import { defaultSchedule } from "./panelView.ts";
import { fallbackEqualsPrimaryRefusal, fallbackSlotsField, featureFallbackForPhase, featureModelForPhase, modelGroupOf, modelSlotsField } from "./models.ts";
import { clipTail } from "./panelWidth.ts";
import { reportStateWriteFailure } from "./publish.ts";
import { questionOf } from "./lot.ts";
import { appendJournal, contextBlock, journalFor, readBrief } from "./context.ts";
import type { DecisionSource, JournalKind } from "./context.ts";
import { ARBITER_DEADLINE_MS, buildArbiterCorpus, buildArbiterPrompt, itemQuestion, normalizeQuestion, validateArbiterDecision } from "./arbiter.ts";
import type { ArbiterEffect, ArbiterItem } from "./arbiter.ts";
import { relayItemsOf } from "./relay.ts";
import type { RelayItem } from "./relay.ts";
import { applyWorktreeFate, buildLotPrompt, lastLine, latestSessionFile, milestoneLine, parsePrUrl, prUrlOfView, releaseArgs, releaseTarget } from "./runs.ts";
import type { LotPromptKind, WorktreeFate } from "./runs.ts";
import { exhaustedUntil, markExhausted, quotaDeadlineLabel, quotaStopReason } from "./quota.ts";
import type { QuotaHit } from "./quota.ts";
import type { ArbiterRunner, LotRunner, LotRunnerResult, LotRunSpec } from "./serviceRuns.ts";
import { dropInbox, liveRunFor, panelInboxDirFor, panelInboxDirOf, readStore, writeDelivery } from "./store.ts";
import type { PanelDelivery, PanelPendingAsk, RunningEntry } from "./store.ts";
import { serviceRunning } from "./serviceState.ts";



// --- le pilote : une passe = lire, décider, lancer (S-2, S-4, S-11) ----------

/**
 * `auditSession` : la CLÉ DE RELAIS de la feature (S-1, S-6) — chemin absolu de la
 * session /audit qui la lance, ou `relayKey` du projet /project qui la lance. Une
 * feature relayée démarre tout de suite, même dans un lot au brouillon.
 * `modelReqSpecs` / `modelImplReview` : les deux modèles choisis à la création
 * (S-1, S-2) — absents ou vides, le groupe correspondant naît au défaut OMP. La
 * clé n'existe QUE pour une valeur exploitable (`modelSlotsField`).
 * `relayKind` : `"project"` pour une feature lancée par /project (textes du panneau).
 * `base` : le sha de départ de son worktree (S-7) — absent, `HEAD` du dépôt principal.
 */
export type AddFeatureInput = {
  name: string;
  description: string;
  deps: string[];
  auditSession?: string;
  modelReqSpecs?: string | null;
  modelImplReview?: string | null;
  fallbackReqSpecs?: string | null;
  fallbackImplReview?: string | null;
  relayKind?: "project";
  base?: string;
};


/** Le refus d'une réponse à un `ask` (S-7) : la question se répond dans SA vue. */
const ASK_REPLY_REFUSAL = "le maillon attend une réponse à sa question : choisis une option dans sa conversation";


/**
 * Les features qu'une décision de quota vise (S-5) : celles d'une session
 * /project ou /audit (`context`, sa clé de relais), celles qu'AUCUNE session
 * ouverte ne porte (`unrelayed`, le rang de /pipelines), ou toutes.
 */
export type QuotaScope = { kind: "context"; key: string } | { kind: "unrelayed" } | { kind: "all" };


/** Ce que le panneau demande au pilote : chaque refus rend son motif, jamais une exception. */
export type LotPanelActions = {
  add(input: AddFeatureInput): Promise<string | null>;
  /**
   * Remplace les deux modèles d'une feature (S-3). Rend `null`, ou le motif du
   * refus. Une valeur blanche EFFACE la clé du groupe ; l'ancien modèle unique est
   * supprimé (il ne resert plus de repli). Aucun autre champ de la feature ne
   * change, et un run déjà lancé n'est ni interrompu ni relancé.
   */
  editModels(
    slug: string,
    input: {
      modelReqSpecs: string | null;
      modelImplReview: string | null;
      fallbackReqSpecs?: string | null;
      fallbackImplReview?: string | null;
    },
  ): Promise<string | null>;
  /**
   * La décision de quota (S-5) : `model` devient le REPLI du groupe de chaque
   * feature bloquée par `provider` dans `scope` (le principal ne change pas), puis
   * chacune est relancée par `relaunch` — session reprise. Rend `null`, ou le motif.
   */
  resolveQuota(provider: string, model: string, scope: QuotaScope): Promise<string | null>;
  launch(): Promise<string | null>;
  remove(slug: string): Promise<string | null>;
  /**
   * Livre la réponse (feature `waiting`+`answer`) ou met le texte en file (`running`).
   * `source` (S-11) : d'où vient la réponse — `utilisateur` par défaut, `contexte` ou
   * `arbitrage` pour l'arbitre. `viaRelay` : le relais ou l'arbitre répondent eux-mêmes —
   * une question relayée n'est pas refusée comme « confiée à la session » (S-3, S-6).
   */
  answer(slug: string, text: string, options?: { source?: DecisionSource; viaRelay?: boolean }): Promise<string | null>;
  /** Ce que cette feature accepte comme écriture — la MÊME règle que `answer` applique. */
  reply(slug: string): RowReply;
  validate(slug: string, options?: { source?: DecisionSource }): Promise<string | null>;
  accept(slug: string, options?: { source?: DecisionSource }): Promise<string | null>;
  relaunch(slug: string): Promise<string | null>;
  cancel(slug: string, fate: WorktreeFate): Promise<string | null>;
};


export type LotControllerDeps = {
  stateDir: string;
  repoRoot: string;
  run: LotRunner;
  /** Le lanceur d'arbitre (S-9) : absent = aucun arbitrage, les éléments restent à l'utilisateur. */
  arbiter?: ArbiterRunner;
  runGit: GitRunner;
  /** `gh`, pour l'URL du dépôt et la PR. Absent ⇒ la livraison est bloquée, sans exception. */
  runGh?: (args: string[], cwd: string) => Promise<GitResult>;
  notify?: (text: string) => void;
  toast?: (text: string, type: "info" | "warning" | "error") => void;
  /** La session du pilote : publiée comme propriétaire (diagnostic et reprise). */
  session?: () => { file: string | null; id: string | null };
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => () => void;
  worktreesBase?: string;
  archiveBase?: string;
  reviewCap?: number;
  /**
   * Le plafond de runs parallèles du lot (S-2) : injecté par les tests, lu sinon
   * sur `MEM0_PIPELINE_SLOTS`. Comme `reviewCap`, il n'est lu qu'à la CRÉATION ou
   * au premier lancement du lot, puis FIGÉ dans `lot.slotCap` — le pilotage ne
   * relit jamais l'environnement.
   */
  slots?: number;
  runTimeoutMs?: number;
  /**
   * Le RÔLE de ce contrôleur (S-4) : `service` = le pilote unique de la machine,
   * qui reprend un lot tenu par une session terminale vivante ; `session`
   * (défaut) = une session de l'utilisateur, qui écrit le lot SANS en prendre la
   * propriété quand un service le pilote — et ne pilote plus rien elle-même.
   */
  pilotRole?: "service" | "session";
};


export type LotController = LotPanelActions & {
  read(): Lot | null;
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  /**
   * Une passe du canal de commande (S-1) : les commandes stables du dépôt sont
   * accusées puis appliquées. Exposé pour les tests (aucun minuteur) et pour tout
   * appelant qui veut forcer une passe ; la boucle du pilote l'appelle seule.
   */
  pumpCommands(): Promise<void>;
  /**
   * Applique une commande reçue par l'API (S-9) : mêmes refus, même accusé, même
   * idempotence que le canal de fichiers, et un tick avant de rendre la main pour
   * que le magasin porte l'état résultant au retour de la réponse.
   */
  acceptCommand(cmd: PipelineCommand): Promise<PipelineCommandAck>;
  adopt(): boolean;
  /**
   * Tue tous les runs EN VOL (S-1), avec le motif affiché. Appelé à la fermeture
   * de la session pilote : les enfants d'un `pi.exec` ne meurent pas avec leur
   * parent, donc sans cet abort quitter OMP laissait des runs orphelins, sans
   * délai, dans des worktrees que plus personne ne pilotait. Rendu immédiat,
   * jamais d'exception.
   */
  abortAll(reason: string): void;
  /** Inscription d'une feature créée par /req (sa collecte se déroule en session). Rend le motif d'un refus. */
  enrol(input: {
    slug: string;
    name: string;
    branch: string;
    worktree: string;
    modelReqSpecs?: string | null;
    modelImplReview?: string | null;
    fallbackReqSpecs?: string | null;
    fallbackImplReview?: string | null;
  }): string | null;
};


/**
 * Un lancement décidé : la forme RETENUE (S-3) plus la feature visée. Une seule
 * forme de lancement pour tous les chemins — un geste retenu rejoue exactement ce
 * que le chemin immédiat aurait lancé.
 */
export type PlannedLaunch = HeldLaunch & { slug: string };


/**
 * Le pilote d'un dépôt. Il lit le lot, décide (`nextChainAction`), lance des runs
 * et se réécrit propriétaire. Deux règles structurent tout le reste : un run
 * n'est JAMAIS attendu dans une passe (l'isolation de B-5 tient à ça), et une
 * feature ne bouge que par sa propre entrée — aucune transition ne touche deux
 * features à la fois.
 */
export function createLotController(deps: LotControllerDeps): LotController {
  const { stateDir } = deps;
  const repoKey = lotRepoKey(deps.repoRoot);
  const repo = path.basename(realpathOr(deps.repoRoot)) || realpathOr(deps.repoRoot);
  const now = () => (deps.now ?? Date.now)();
  /** Une décision APPLIQUÉE, consignée au journal du dépôt (S-7) — source `utilisateur` ici. */
  function journalDecision(
    feature: LotFeature,
    phase: PipelinePhase,
    kind: JournalKind,
    question: string,
    answer: string,
    source: DecisionSource = "utilisateur",
  ): void {
    appendJournal(stateDir, repoKey, {
      at: now(),
      slug: feature.slug,
      phase,
      kind,
      question,
      answer,
      source,
      context: feature.auditSession ?? null,
    });
  }

  const cap = deps.reviewCap ?? lotReviewCap();
  const slots = deps.slots ?? lotSlots();
  const runTimeout = deps.runTimeoutMs ?? lotRunTimeoutMs();
  const pilotRole = deps.pilotRole ?? "session";
  const worktreesBase = deps.worktreesBase ?? worktreesBaseDir();
  const archiveBase = deps.archiveBase ?? lotArchiveBaseDir();
  const inFlight = new Map<string, AbortController>();
  /** Le lot d'impl et le `--fix` du run EN VOL de chaque feature, relus par `finishRun` pour son enregistrement (S-12). */
  const runKinds = new Map<string, { lot: string | null; fix: boolean }>();
  /**
   * La boîte de chaque run EN VOL (S-6) : créée par le lanceur, consommée par
   * l'enfant, vidée par `finishRun` — les textes jamais consommés reviennent à la
   * feature (S-8 §4). Un slug absent n'a pas de boîte : son run n'accepte aucune
   * écriture directe, et la file `pendingTexts` reste la règle.
   */
  const inboxes = new Map<string, string>();
  /**
   * Ce que CE pilote sait des runs : `inflight` pendant, `settled` quand la fin a
   * été traitée. C'est ce qui distingue « le maillon n'a jamais tourné » (bascule
   * d'une collecte en session, feature reprise par un autre pilote) de « le run a
   * fini et la chaîne a déjà décidé » — un état purement local, qui ne se confond
   * pas avec l'absence de contrat.
   */
  const watched = new Map<string, "inflight" | "settled">();
  /**
   * La dernière question `ask` ANNONCÉE par feature (son `toolCallId`) : une
   * question en vol ne prévient qu'UNE fois — une alerte par passe ferait du bruit
   * toutes les deux secondes —, et une question NOUVELLE prévient à nouveau.
   */
  const alertedAsk = new Map<string, string>();
  /**
   * Les annulations en cours. Une annulation laisse au run qu'elle tue jusqu'à 10 s
   * pour rendre la main (S-9) : la fin de ce run ne doit donc pas marquer la
   * feature `failed` pendant cette attente — c'est l'annulation qui décide de son
   * sort, et une feature que l'utilisateur annule ne doit pas finir « échouée ».
   */
  const cancelling = new Set<string>();
  /**
   * Les runs que le PILOTE a abandonnés pour dépassement de leur budget de
   * travail (S-8 §1). Le run est tué par notre `abort`, donc son issue dépend du
   * runner (rejet, code 127…) : sans ce marqueur, un dépassement se lirait
   * « binaire omp introuvable ».
   */
  const expiredRuns = new Set<string>();
  /**
   * Le budget de travail EFFECTIF de chaque run en vol : `since` est le début du
   * créneau de travail courant, `null` quand le run attend une réponse (`ask`).
   * L'attente humaine ne consomme rien du budget — sans quoi une question posée
   * tard, ou vue tard, ferait finir la feature en « délai dépassé », donc `failed`.
   */
  const workBudget = new Map<string, { spent: number; since: number | null }>();
  let stopLoop: (() => void) | null = null;
  /** La file des passes : une seule à la fois, aucune perdue (cf. `tick`). */
  let tickQueue: Promise<void> = Promise.resolve();
  /**
   * La file du POMPAGE du canal de commande : une seule passe de pompage à la
   * fois, comme `tickQueue` pour les passes du lot. Le pompage a son PROPRE
   * minuteur et sa propre file : `add`/`launch` attendent une passe enchaînée
   * derrière la leur, donc un pompage qui vivrait dans `pass()` s'auto-bloquerait
   * (piège mesuré du dépôt).
   */
  let pumpQueue: Promise<void> = Promise.resolve();
  let stopPump: (() => void) | null = null;
  /**
   * Les couples (slug, `toolCallId`) dont la réponse a été LIVRÉE par une commande
   * `answer` : le run ne republie son état qu'à son battement suivant, donc c'est
   * ce garde qui rend déterministe le refus « déjà reçu sa réponse » (S-11).
   */
  const answeredAsks = new Set<string>();
  /**
   * Les actions PUBLIQUES du contrôleur, liées après la construction de l'objet
   * rendu : le pompage est le seul appelant INTERNE (il ne peut pas référencer le
   * littéral en cours de création), et il ne tourne qu'après le retour de
   * `createLotController`.
   */
  let api: LotController | null = null;
  /** Une seule notice pour un lot qu'un autre process conduit (S-1). */
  let foreignOwnerWarned = false;

  const read = () => readLot(stateDir, repoKey);
  const notify = (text: string) => {
    try {
      deps.notify?.(text);
    } catch {
      /* une notice ne casse jamais un tour */
    }
  };

  /** Le motif d'un refus d'écriture, mot pour mot le même que celui d'`open`. */
  const foreignOwnerReason = (pid: number) => `le lot est piloté par une autre session (pid ${pid})`;

  /**
   * Le pid étranger VIVANT qui conduit ce lot sur le DISQUE, ou `null`. Le pid
   * mort n'est pas un obstacle : c'est la reprise admise (S-1). Un pid vivant ne
   * suffit pas non plus : un pid RÉUTILISÉ après un redémarrage désigne un autre
   * process, donc le battement du propriétaire départage (`lotOwnerAlive`).
   *
   * Deux cas de S-4 ne sont PAS des étrangers : le SERVICE vivant — il relit le
   * magasin à chaque passe, donc une session terminale doit pouvoir y écrire — et,
   * quand ce contrôleur EST le service, tout autre pid, puisque plus aucune
   * session terminale ne pilote un lot : le service reprend la main.
   */
  function foreignOwner(): number | null {
    const onDisk = read();
    if (!onDisk || onDisk.owner.pid === process.pid) return null;
    if (!lotOwnerAlive(onDisk.owner, now())) return null;
    if (pilotRole === "service") return null;
    const service = serviceRunning(stateDir);
    if (service !== null && service.pid === onDisk.owner.pid) return null;
    return onDisk.owner.pid;
  }

  /** Un refus d'écriture est dit UNE fois par session — le toast disparaîtrait. */
  function reportForeignOwner(pid: number): void {
    if (foreignOwnerWarned) return;
    foreignOwnerWarned = true;
    notify(`[pipeline] lot ${repo} : ${foreignOwnerReason(pid)} — rien ne lui a été écrit`);
  }

  /**
   * Le motif du refus d'écrire ce lot, ou `null` : la politique de propriété est
   * celle de `foreignOwner` — un seul endroit la dit (S-4 : le service vivant
   * n'est pas un pilote étranger, et le service lui-même reprend tout lot tenu par
   * une session).
   */
  function foreignRefusal(): string | null {
    const foreign = foreignOwner();
    if (foreign === null) return null;
    reportForeignOwner(foreign);
    return foreignOwnerReason(foreign);
  }

  /**
   * Écrit le lot ENTIER : l'objet passé doit donc venir d'une lecture qui n'a
   * aucun `await` d'écart avec cette écriture (S-1, « un seul écrivain »).
   * La passe sépare pour cela sa phase d'attente (les worktrees) de sa phase de
   * décision, `finishRun` et `finishRelease` ne mutent qu'une relecture, et les
   * actions du panneau — qui attendent `git`, `gh` ou la mort d'un run (jusqu'à
   * 10 s pour une annulation) — relisent le lot APRÈS leur attente, avant de
   * muter. Un lot périmé réécrit ici effacerait les transitions écrites
   * entre-temps : une feature reviendrait au maillon précédent, sa fin de run
   * serait ignorée et elle resterait `running` sans run, sans alerte, hors de
   * portée du panneau (AC-2, AC-19).
   *
   * Le propriétaire est revérifié ICI, sur le disque, quel que soit le chemin qui
   * écrit : un lot conduit par un process VIVANT étranger n'est JAMAIS réécrit
   * (S-1, invariant 2). Sans cette garde, un `/req` d'une seconde session — ou une
   * écriture qui a attendu pendant qu'un autre pilote reprenait le lot — en
   * ferait le propriétaire : deux pilotes sur le même lot, les transitions du
   * premier jetées par la garde de sa passe, et deux runs concurrents dans le
   * même worktree. Un propriétaire MORT ne s'oppose à rien (c'est la reprise) :
   * `adopt`, `open` et `lotForAdd` écrivent après l'avoir constaté.
   *
   * Rend `null` quand le lot a été écrit, sinon le motif du refus — jamais une
   * exception.
   */
  function save(lot: Lot): string | null {
    const foreign = foreignOwner();
    if (foreign !== null) {
      reportForeignOwner(foreign);
      return foreignOwnerReason(foreign);
    }
    const session = deps.session?.() ?? { file: null, id: null };
    const service = serviceRunning(stateDir);
    if (pilotRole !== "service" && service !== null && service.pid !== process.pid) {
      // Une session TERMINALE n'est jamais propriétaire d'un lot quand un service
      // le pilote (S-4) : son écriture laisse le lot au service — le battement est
      // rafraîchi ici pour qu'un lot fraîchement écrit ne paraisse pas abandonné
      // avant le tick suivant, et la session publiée reste celle du service.
      lot.owner = {
        pid: service.pid,
        sessionFile: lot.owner.sessionFile ?? null,
        sessionId: lot.owner.sessionId ?? null,
        heartbeatAt: now(),
      };
    } else {
      // Le battement est estampillé à CHAQUE écriture : c'est lui qui distingue un
      // pilote vivant d'un pid réutilisé après un redémarrage (S-1). Un lot sans
      // battement (écrit par une version antérieure) reste lisible : `lotOwnerAlive`
      // retombe alors sur le pid seul.
      lot.owner = { pid: process.pid, sessionFile: session.file, sessionId: session.id, heartbeatAt: now() };
    }
    try {
      writeLot(stateDir, lot);
    } catch (err) {
      // Même garantie que pour le magasin : avalée, et signalée AU PLUS UNE FOIS
      // par session (le drapeau est celui de `reportStateWriteFailure`).
      reportStateWriteFailure({ notify: deps.notify, stateDir }, err);
      return `écriture du lot impossible : ${err instanceof Error ? err.message : String(err)}`;
    }
    return null;
  }

  /** Entrée dans un nouvel état : `sinceAt` et `updatedAt` avancent ensemble. */
  function touch(feature: LotFeature, at: number): number {
    feature.sinceAt = at;
    feature.updatedAt = at;
    return at;
  }

  /**
   * Les textes jamais consommés de la boîte d'un run, et le dossier retiré (S-8
   * §4). Une réponse `ask` restée dans la boîte meurt avec sa question : elle est
   * ignorée puis supprimée par `dropInbox`.
   */
  function takeInbox(slug: string): string[] {
    const dir = inboxes.get(slug);
    inboxes.delete(slug);
    return dir === undefined ? [] : dropInbox(dir);
  }

  /**
   * Les restes d'un run rejoignent la file de sa feature, dans l'ordre et sous les
   * bornes existantes (S-5) : la file est un repli, jamais un débordement. Un
   * texte qui ne rentre plus est abandonné — la file pleine refuse déjà les
   * nouveaux messages, elle ne les empile pas.
   */
  function queueLeftovers(feature: LotFeature, texts: string[]): void {
    if (texts.length === 0) return;
    const queued = feature.pendingTexts;
    let total = queued.reduce((count, message) => count + message.length, 0);
    for (const raw of texts) {
      const text = raw.trim();
      if (text === "" || queued.length >= LOT_PENDING_MAX) continue;
      if (total + text.length > LOT_PENDING_TOTAL_MAX) continue;
      queued.push(text.slice(0, LOT_EDITOR_MAX));
      total += text.length;
    }
    feature.pendingTexts = queued;
  }

  /**
   * Le run VIVANT d'une feature, tel que la règle d'écriture le lit (S-6) : son
   * entrée de magasin, où vit sa boîte. `liveRunFor` porte la règle — même cwd
   * RÉEL et pid propriétaire vivant — donc un pilote mort n'écrit plus rien : le
   * magasin n'est pas encore réconcilié, c'est ici qu'on le constate. Le relais
   * /audit de la feature (S-3) est lu contre le pilote du lot LU.
   */
  function liveWriterOf(lot: Lot, feature: LotFeature): RowLiveWriter {
    const auditRelay = auditRelayOpen(stateDir, feature, lot.owner.pid, now());
    const entry = liveEntryOf(feature.worktree);
    if (!entry) return { auditRelay };
    return { inbox: panelInboxDirOf(entry), pendingAsk: entry.pendingAsk ?? null, auditRelay };
  }

  /** L'entrée du run VIVANT de ce worktree, ou `null` (S-1, S-6) — jamais pour un worktree vide. */
  function liveEntryOf(worktree: string): RunningEntry | null {
    return worktree === "" ? null : liveRunFor(stateDir, worktree);
  }

  /**
   * La question `ask` publiée par le run d'un worktree, VIVANT OU NON : au moment
   * où un run est tué, sa question en vol est encore dans le magasin (le fichier
   * n'est réconcilié que plus tard), et c'est elle qui dit que le maillon ATTENDAIT
   * au lieu d'échouer (S-8 §1).
   */
  function publishedAsk(worktree: string): PanelPendingAsk | null {
    if (worktree === "") return null;
    const real = realpathOr(worktree);
    for (const entry of readStore(stateDir).running) {
      if (realpathOr(entry.cwd) === real && entry.pendingAsk) return entry.pendingAsk;
    }
    return null;
  }

  /**
   * Le lot porte-t-il une feature SORTIE de sa collecte ? C'est la clôture de SA
   * collecte (S-14) qui démarre SON pipeline — et c'est elle qui ouvre un lot encore
   * au BROUILLON, `enrol` ne l'ouvrant plus (CHAIN-11). Les features ajoutées par
   * `a`, elles, attendent `l`. Une collecte EN COURS n'est pas un départ.
   */
  function hasStartedFeature(lot: Lot): boolean {
    return lot.features.some(
      (f) => !(f.origin === "session" && f.phase === "req") && f.state !== "pending" && !lotStateTerminal(f.state),
    );
  }

  /**
   * Dépose un texte dans la boîte d'un run VIVANT (S-6). Le run vit : le texte
   * entre dans SON tour, aucun run n'est lancé et le lot n'est pas écrit — il n'y a
   * rien à décider. Rend le motif d'un échec d'écriture, jamais une exception.
   */
  function deliverSteer(inbox: string, text: string): string | null {
    try {
      writeDelivery(inbox, { version: 1, kind: "text", text: text.slice(0, LOT_EDITOR_MAX), sentAt: now() });
      return null;
    } catch (err) {
      return `écriture impossible : ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Une transition qui appelle l'utilisateur est annoncée UNE fois (AC-11). Une
   * attente (question, jalon) ou un plafond de revue d'une feature dont le relais
   * /audit est ouvert est confié à la session /audit : aucune alerte ici (S-3).
   */
  function emit(lot: Lot, feature: LotFeature, before: LotFeatureState): void {
    if (before === feature.state) return;
    const relayable =
      feature.state === "waiting" || (feature.state === "blocked" && isReviewCapReason(feature.stopReason));
    if (relayable && auditRelayOpen(stateDir, feature, lot.owner.pid, now())) return;
    const alert = buildLotAlert(repo, feature);
    if (!alert) return;
    notify(alert.text);
    try {
      // Le MÊME texte que le message durable (S-8) : le toast est la visibilité
      // immédiate, et le prompt d'un run est repris en entier.
      deps.toast?.(alert.text, alert.tone);
    } catch {
      /* un toast raté n'a aucune conséquence : le message durable est posté */
    }
  }

  function settle(lot: Lot, feature: LotFeature, state: "blocked" | "failed", reason: string): void {
    const before = feature.state;
    feature.state = state;
    // Tout ce qui sort de `pending` détruit le lancement retenu (S-3) : une
    // feature bloquée ou échouée ne porte pas d'ordre de départ en attente.
    delete feature.held;
    feature.stopReason = reason;
    feature.waitKind = null;
    feature.waitPrompt = null;
    feature.endedAt = touch(feature, now());
    emit(lot, feature, before);
  }


  /**
   * Le corps d'ARMEMENT d'un lancement, partagé par les trois chemins qui mettent
   * une feature en marche (le geste immédiat, la retenue rejouée par la passe, et
   * le maillon suivant d'un run qui rend la main) : phase, état, attente effacée,
   * compteurs du plafond, horloge. Les compteurs sont donc consommés au DÉMARRAGE
   * réel, jamais à la retenue (S-3).
   */
  function arm(feature: LotFeature, launch: { phase: PipelinePhase; fix: boolean }): void {
    delete feature.held;
    feature.phase = launch.phase;
    feature.state = "running";
    feature.waitKind = null;
    feature.waitPrompt = null;
    feature.stopReason = null;
    delete feature.quota;
    feature.endedAt = null;
    // Les compteurs du plafond comptent AUSSI les runs lancés par une action (R,
    // réponse, jalon) : sinon le plafond effectif valait cap+1 corrections, et une
    // revue lancée par R n'était comptée nulle part (S-5).
    // Le découpage de l'impl (S-13) s'arrête à l'entrée en review et sur `--fix`.
    if (launch.phase === "review" || launch.fix) {
      delete feature.implLots;
      delete feature.implLot;
    }
    feature.fixes += launch.fix ? 1 : 0;
    feature.reviewRuns += launch.phase === "review" ? 1 : 0;
    feature.unreadableRuns = (feature.unreadableRuns ?? 0) + (launch.phase === "review" ? 1 : 0);
    touch(feature, now());
  }

  function freshLot(): Lot {
    const at = now();
    return {
      version: LOT_VERSION,
      id: repoKey,
      repoRoot: realpathOr(deps.repoRoot),
      status: "draft",
      reviewCap: cap,
      slotCap: slots,
      recapAt: null,
      owner: { pid: process.pid, sessionFile: null, sessionId: null },
      createdAt: at,
      launchedAt: null,
      features: [],
    };
  }

  /**
   * Le lot prêt à recevoir une nouvelle feature, RELU à l'instant de l'écriture :
   * propriété (refus si un autre pilote vit, reprise s'il est mort), remplacement
   * d'un lot dont plus RIEN ne peut repartir — toutes les features `done` ou
   * `cancelled` —, puis les validations de S-3, dans cet ordre, sans rien créer.
   * Rend le motif du refus, ou le lot et ses dépendances normalisées.
   *
   * `add` l'appelle DEUX fois — avant et après l'attente de `branchTaken` : la
   * première passe rend le bon motif tout de suite (l'ordre de S-3), la seconde
   * est celle qui écrit.
   */
  function lotForAdd(slug: string, depsRaw: string[]): { lot: Lot; deps: string[] } | string {
    const existing = read();
    const foreign = foreignRefusal();
    if (foreign !== null) return foreign;
    if (existing && existing.owner.pid !== process.pid) {
      const refusal = save(existing);
      if (refusal) return refusal;
      start();
    }
    const lot = !existing || lotReplaceable(existing) ? freshLot() : existing;
    if (lotFeature(lot, slug)) return lotSlugPresentRefusal(slug);
    const deps: string[] = [];
    for (const raw of depsRaw) {
      // Un slug non normalisable n'est jamais dans le lot : il tombe donc dans
      // le même refus que la dépendance absente (S-3), sans message de plus.
      const dep = toSlug(raw) ?? raw.trim();
      if (dep === slug) return lotCyclicDepRefusal(slug);
      if (!lotFeature(lot, dep)) return lotUnknownDepRefusal(dep);
      deps.push(dep);
    }
    return { lot, deps };
  }

  /**
   * Le modèle de DÉPART d'un run (S-4) : le principal s'il est nul (défaut OMP —
   * la garde est alors appliquée après ouverture, par le runner) ou non épuisé ;
   * sinon le repli s'il existe et n'est pas épuisé ; sinon rien : le quota du
   * principal bloque la feature.
   */
  function startModel(primary: string | null, fallback: string | null): { model: string | null } | { blocked: QuotaHit } {
    if (primary === null) return { model: null };
    const at = now();
    const hit = exhaustedUntil(stateDir, primary, at);
    if (hit === null) return { model: primary };
    if (fallback !== null && exhaustedUntil(stateDir, fallback, at) === null) return { model: fallback };
    return { blocked: hit };
  }

  /** Passe la feature en « bloquée : quota » (S-5) : `blocked`, jamais `failed`, avec son quota. */
  function blockOnQuota(lot: Lot, feature: LotFeature, phase: PipelinePhase, hit: QuotaHit): void {
    feature.quota = { provider: hit.provider, model: hit.model, until: hit.until, announced: hit.announced, phase };
    settle(lot, feature, "blocked", quotaStopReason(hit));
  }

  function startRun(lot: Lot, feature: LotFeature, launch: PlannedLaunch): void {
    const primary = featureModelForPhase(feature, launch.phase);
    const fallback = featureFallbackForPhase(feature, launch.phase);
    // La garde de lancement (S-4) : jamais de run sur un modèle épuisé, et aucune
    // session ouverte quand ni le principal ni le repli n'est disponible.
    const started = startModel(primary, fallback);
    if ("blocked" in started) {
      blockOnQuota(lot, feature, launch.phase, started.blocked);
      if (save(lot) !== null) watched.delete(feature.slug);
      return;
    }
    // La file (S-5) est consommée PAR le run qui part : les textes sont capturés
    // avant d'être vidés, et le vidage part dans l'écriture même qui démarre le run.
    // Une écriture refusée (propriétaire étranger vivant, disque) rend les textes à
    // la file : aucun run ne part, donc aucun message n'est perdu.
    const queued = feature.pendingTexts;
    feature.pendingTexts = [];
    // La source du jalon qui vient d'être franchi (S-11) : nommée à la fin du prompt du
    // run qui le suit (impl après « specs validées », release après « revue propre »).
    const milestoneSource = feature.milestoneSource;
    const milestone =
      milestoneSource !== undefined && launch.kind === "phase" && !launch.fix
        ? launch.phase === "impl"
          ? milestoneLine("specs validées", milestoneSource)
          : launch.phase === "release"
            ? milestoneLine("revue propre", milestoneSource)
            : undefined
        : undefined;
    if (milestone !== undefined) delete feature.milestoneSource;
    // Le lot d'impl du run (S-13) : seulement un run d'impl hors `--fix`, sur une feature découpée.
    const implLots = feature.implLots;
    const implRank = feature.implLot;
    const lotOfRun =
      launch.phase === "impl" && !launch.fix && implLots !== undefined && implRank !== undefined && implLots[implRank] !== undefined
        ? { id: implLots[implRank] as string, index: implRank, ids: implLots }
        : undefined;
    runKinds.set(feature.slug, { lot: lotOfRun?.id ?? null, fix: launch.fix });
    const prompt = buildLotPrompt({
      ...(lotOfRun === undefined ? {} : { lot: lotOfRun }),
      kind: launch.kind,
      phase: launch.phase,
      slug: feature.slug,
      description: feature.name,
      text: launch.text,
      fix: launch.fix,
      messages: queued,
      ...(launch.source === undefined ? {} : { source: launch.source }),
      ...(milestone === undefined ? {} : { milestone }),
      // Le contexte de conduite (S-8) : seulement pour une feature lancée par /project ou /audit.
      ...(feature.auditSession !== undefined
        ? { context: contextBlock({ stateDir, repoKey, slug: feature.slug, contextKey: feature.auditSession }) }
        : {}),
    });
    // La session reprise (S-8 §1) : celle de l'entrée VIVANTE du worktree quand il
    // y en a une — c'est le run lui-même qui l'a publiée, donc elle fait autorité
    // —, sinon celle de la feature. Une feature enrôlée par /req porte encore la
    // session d'AVANT la bascule : reprendre celle-là écrirait dans la session du
    // dépôt principal.
    const live = liveEntryOf(feature.worktree);
    const sessionFile = launch.resume ? (live?.sessionFile ?? feature.sessionFile) : null;
    // L'échéance passée à l'enfant est une borne d'ORPHELIN, jamais le budget de
    // travail : le pilote suspend son propre délai pendant une question en vol, et
    // une échéance calée sur le travail tuerait un run qui attend une réponse.
    const at = now();
    // La BOÎTE du run (S-6) : créée AVANT le lancement, sinon l'enfant démarre non
    // armé et plus rien n'atteint son tour. Un dossier impossible à créer ne fait
    // PAS échouer le lancement : le run part sans boîte, comme un run d'avant
    // cette feature, et la file `pendingTexts` prend le relais.
    let inbox: string | null = null;
    try {
      inbox = panelInboxDirFor(stateDir, feature.worktree);
      fs.mkdirSync(inbox, { recursive: true });
    } catch {
      inbox = null;
    }
    if (inbox === null) inboxes.delete(feature.slug);
    else inboxes.set(feature.slug, inbox);
    const spec: LotRunSpec = {
      lotId: lot.id,
      slug: feature.slug,
      phase: launch.phase,
      stateDir,
      worktree: feature.worktree,
      prompt,
      sessionFile,
      // Le modèle (S-1) vient de la FEATURE, au moment du lancement : le groupe de
      // la PHASE du run décide de la clé, et l'ancien modèle unique en repli (AC-4).
      model: started.model,
      primary,
      fallback,
      inbox,
      deadline: at + runTimeout + LOT_RUN_DEADLINE_MARGIN_MS,
    };
    const abort = new AbortController();
    inFlight.set(feature.slug, abort);
    watched.set(feature.slug, "inflight");
    workBudget.set(feature.slug, { spent: 0, since: at });
    // Le hash du contrat est figé AVANT le lancement, et ÉCRIT avant lui (S-1) :
    // c'est le seul indice dont disposera un pilote qui reprend un run interrompu
    // pour juger si le maillon a travaillé. Les appelants ont déjà sauvegardé leur
    // état, donc cette écriture est la leur, augmentée du hash — la poser après
    // leur sauvegarde (comme avant) la laissait en mémoire et jamais sur le disque.
    // `""` note « aucun contrat au démarrage », à distinguer de `null` : « aucun
    // run n'a été lancé pour cette feature » (bascule d'une collecte, S-14).
    feature.contractHash = contractHashOf(feature.worktree) ?? "";
    // L'empreinte de `## Revue` est figée ICI, au lancement d'un run de revue : à
    // sa fin, une empreinte identique voudra dire que CE run n'a rien écrit — le
    // verdict lu viendrait d'un autre maillon (/impl --fix), donc illisible.
    feature.reviewHash = launch.phase === "review" ? reviewSectionHash(feature.worktree) : null;
    // Le lot n'est pas écrit (propriétaire étranger vivant, écriture impossible) :
    // aucun run ne part — un maillon lancé sans que son lot le sache serait un
    // processus orphelin, dans un worktree que le véritable pilote conduit. Le
    // suivi en mémoire est DÉFAIT avec lui : `inFlight` retenu sans run ferait
    // sauter la feature à toutes les passes (`inFlight.has`), donc rester `running`
    // sur le disque sans run et sans réconciliation — la classe de défaut qu'AC-19
    // interdit.
    if (save(lot) !== null) {
      inFlight.delete(feature.slug);
      watched.delete(feature.slug);
      // Le lot n'a pas été écrit : le vidage de la file non plus. Les textes
      // retournent dans la feature, comme ils sont restés sur le disque (S-5).
      feature.pendingTexts = queued;
      if (milestoneSource !== undefined) feature.milestoneSource = milestoneSource;
      return;
    }
    const startedAt = now();
    // `deps.run` peut jeter AVANT de rendre sa promesse (argv inexploitable,
    // spawn refusé) : l'échec appartient alors à CETTE feature, jamais à la passe.
    let launched: Promise<LotRunnerResult>;
    try {
      launched = Promise.resolve(
        // Le délai du runner est la MÊME borne de sécurité que celle du run : le
        // budget de TRAVAIL est tenu par la passe (elle seule sait suspendre le
        // décompte pendant une question en vol, cf. `workBudget`). Un délai de
        // runner calé sur le budget de travail tuerait un run qui ATTEND.
        deps.run({
          spec,
          cwd: feature.worktree,
          timeout: runTimeout + LOT_RUN_DEADLINE_MARGIN_MS,
          signal: abort.signal,
        }),
      );
    } catch (err) {
      launched = Promise.reject(err);
    }
    void launched
      .catch((err: unknown) => ({
        code: 127,
        killed: false,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      }))
      .then((result: LotRunnerResult) => finishRun(feature.slug, launch.phase, result, startedAt));
  }

  /**
   * La branche de BASE du worktree d'une feature dépendante (S-10) : celle de sa
   * première dépendance TERMINÉE. « Terminée » veut dire PR ouverte, donc
   * commitée — la livraison commite —, et cette branche porte un travail que
   * `HEAD` du dépôt principal n'a pas encore. LIMITE ASSUMÉE : avec plusieurs
   * dépendances, seule la première terminée sert de base ; les autres restent à
   * fusionner par l'utilisateur.
   */
  function baseBranchFor(lot: Lot, feature: LotFeature): string | null {
    for (const dep of feature.deps) {
      const up = lotFeature(lot, dep);
      if (up && up.state === "done" && up.branch !== "") return up.branch;
    }
    return null;
  }

  /** La raison consignée quand un run ne rend pas `ok` (S-4). */
  function failureReason(result: LotRunnerResult): string {
    if (result.killed) return `délai dépassé (${Math.round(runTimeout / 60_000)} min)`;
    if (result.code === 127) return "binaire omp introuvable (code 127)";
    // 200 caractères : un motif de panne tient dans une ligne de panneau et dans
    // une alerte ; une trace entière n'y tient pas et noierait le reste.
    const reason = lastLine(result.stderr) || lastLine(result.stdout) || `sortie non nulle (code ${result.code})`;
    return reason.length > LOT_REASON_MAX ? `${reason.slice(0, LOT_REASON_MAX - 1)}…` : reason;
  }

  /** Le run a rendu la main : la chaîne décide de la suite, pour CETTE feature. */
  function finishRun(slug: string, phase: PipelinePhase, result: LotRunnerResult, startedAt: number): void {
    inFlight.delete(slug);
    workBudget.delete(slug);
    watched.set(slug, "settled");
    // Le budget de travail de CE run est consommé : le marqueur dit que le
    // dépassement vient de nous, pas du runner (qui rapporterait autre chose).
    const expired = expiredRuns.delete(slug);
    // Les restes de la boîte (S-8 §4) : un texte confirmé par l'utilisateur et
    // jamais consommé n'est pas perdu, il part au prochain run de sa feature. Le
    // dossier, lui, est retiré dans TOUS les cas — un run tué ou repris par un
    // autre pilote ne laisse pas de boîte derrière lui.
    const leftovers = takeInbox(slug);
    // Une annulation en cours décide SEULE du sort de sa feature (S-9) : le run
    // qu'elle vient de tuer ne la marque pas `failed`.
    if (cancelling.has(slug)) return;
    const lot = read();
    if (!lot) return;
    if (lot.owner.pid !== process.pid) return; // un autre pilote a repris : ne rien écrire
    const feature = lotFeature(lot, slug);
    if (!feature || feature.state !== "running" || feature.phase !== phase) return;
    queueLeftovers(feature, leftovers);
    const runKind = runKinds.get(slug);
    runKinds.delete(slug);
    // La session du run est retenue quel que soit son SORT (S-8 §1) : un run tué ou
    // en échec a quand même une conversation, et c'est elle qu'une réponse doit
    // reprendre — la perdre obligeait `R` à repartir d'une session NEUVE, en
    // effaçant l'échange en cours.
    const session = latestSessionFile(stateDir, feature.worktree, startedAt);
    if (session) {
      feature.sessionFile = session;
      feature.lastRunSessionFile = session;
    }
    appendRunRecord(feature, {
      step: phase,
      lot: runKind?.lot ?? null,
      fix: runKind?.fix ?? false,
      startedAt,
      endedAt: now(),
      peakContext: result.peakContext ?? null,
      sessionFile: session ?? null,
    });
    // Un run rendu SANS modèle disponible (S-2) n'a pas échoué : son quota est
    // épuisé. La feature devient `blocked` (jamais `failed`), avec sa session et son
    // worktree intacts ; l'inscription au registre précède la sauvegarde (S-4), pour
    // qu'aucun lancement ne retombe sur ce modèle.
    if (result.quota) {
      markExhausted(stateDir, result.quota);
      blockOnQuota(lot, feature, phase, result.quota);
      if (save(lot) !== null) watched.delete(slug);
      void Promise.resolve().then(() => tick().catch(() => undefined));
      return;
    }
    // Un run tué alors qu'une question était EN VOL n'a pas échoué : il attendait.
    // La feature devient `blocked` (répondable, avec sa session) au lieu de
    // `failed` — un `failed` ne reprend aucune session et sa question est perdue.
    // Un dépassement décidé par la passe, lui, n'est pas une attente.
    const ask = result.killed && !expired ? publishedAsk(feature.worktree) : null;
    if (ask) {
      const reason = `délai dépassé pendant une question en attente : ${ask.question}`;
      settle(lot, feature, "blocked", reason.length > LOT_REASON_MAX ? `${reason.slice(0, LOT_REASON_MAX - 1)}…` : reason);
      if (save(lot) !== null) watched.delete(slug);
      void Promise.resolve().then(() => tick().catch(() => undefined));
      return;
    }
    const outcome: ChainOutcome = !expired && result.code === 0 && !result.killed ? "ok" : "error";
    const routed = route(lot, feature, {
      outcome,
      stdout: result.stdout,
      reason: expired ? `délai dépassé (${Math.round(runTimeout / 60_000)} min)` : failureReason(result),
    });
    // Rien n'a été écrit : la chaîne ne part pas, et le marqueur `settled` est
    // retiré — sans lui, la passe croirait la fin de ce run déjà traitée et
    // laisserait la feature `running` sans run, alors que la réconciliation par
    // le hash du contrat (S-1) saurait, elle, décider (reprise ou `failed`
    // relançable).
    if (save(lot) !== null) {
      watched.delete(slug);
      return;
    }
    for (const launch of routed.launches) startRun(lot, feature, launch);
    if (routed.release) void finishRelease(feature);
    void Promise.resolve().then(() => tick().catch(() => undefined));
  }

  /**
   * Applique la décision de la chaîne à UNE feature et rend ce qu'il reste à
   * faire APRÈS la sauvegarde : les runs à lancer et, pour la livraison, les deux
   * commandes mécaniques. Rien n'est lancé ici : un run qui rend la main aussitôt
   * écrirait sa transition sur un lot plus vieux que celui qu'on vient de calculer.
   */
  function route(
    lot: Lot,
    feature: LotFeature,
    result: { outcome: ChainOutcome; stdout: string; reason: string },
  ): { launches: PlannedLaunch[]; release: boolean } {
    const out: { launches: PlannedLaunch[]; release: boolean } = { launches: [], release: false };
    const before = feature.state;
    const contract = readContractText(feature.worktree);
    // La revue a-t-elle RÉÉCRIT sa section ? L'empreinte figée au lancement est le
    // seul juge : une section inchangée n'est pas un verdict de revue, quel que
    // soit le texte laissé par /impl --fix.
    const currentReview = feature.phase === "review" ? reviewSectionHash(feature.worktree) : null;
    const reviewRewritten =
      feature.phase !== "review" || (currentReview !== null && currentReview !== (feature.reviewHash ?? null));
    // Ce que le pilote PUBLIE du verdict (S-…), pour le panneau : le même verdict
    // que celui sur lequel la chaîne décide, jamais un second calcul divergent.
    if (feature.phase === "review") {
      const verdict = effectiveReviewVerdict(contract, reviewRewritten);
      feature.lastVerdict = verdict;
      feature.lastBlockers = verdict === "blockers" ? reviewBlockers(contract) : 0;
      // Un verdict LISIBLE remet le budget de l'illisible à zéro (S-5) : c'est ce
      // qui empêche une seule revue illisible de bloquer après des corrections.
      if (verdict !== "unreadable") feature.unreadableRuns = 0;
    }
    const action = nextChainAction({
      phase: feature.phase,
      outcome: result.outcome,
      contract,
      fixes: feature.fixes,
      unreadableRuns: feature.unreadableRuns ?? 0,
      // Le plafond est celui FIGÉ dans le lot au premier lancement (S-5) : un
      // pilote qui reprend le lot avec un autre environnement ne doit pas
      // changer la borne en cours de route.
      cap: lot.reviewCap,
      question: trailingQuestion(result.stdout),
      reviewRewritten,
    });
    if (action.kind === "run") {
      // Le maillon suivant du MÊME run : le créneau est déjà tenu, donc aucun
      // plafond ne s'applique ici — seul l'armement est partagé.
      // Impl par lot (S-13) : quand la chaîne dirait « review » et qu'un lot reste, le lot
      // suivant part à la place ; le rang est écrit avec la sauvegarde qui précède le run.
      const lots = feature.implLots;
      const rank = feature.implLot ?? 0;
      if (feature.phase === "impl" && action.phase === "review" && lots !== undefined && rank + 1 < lots.length) {
        feature.implLot = rank + 1;
        arm(feature, { phase: "impl", fix: false });
        out.launches.push({ slug: feature.slug, phase: "impl", fix: false, kind: "phase", resume: false });
        return out;
      }
      arm(feature, action);
      out.launches.push({
        slug: feature.slug,
        phase: action.phase,
        fix: action.fix,
        kind: "phase",
        resume: false,
      });
      return out;
    }
    if (action.kind === "wait") {
      feature.state = "waiting";
      feature.waitKind = action.waitKind;
      feature.waitPrompt = action.waitKind === "answer" ? clipTail(result.stdout.trim(), LOT_WAIT_PROMPT_MAX) || null : null;
      feature.stopReason = null;
      feature.endedAt = null;
      touch(feature, now());
      emit(lot, feature, before);
      return out;
    }
    if (action.kind === "failed") {
      settle(lot, feature, "failed", result.reason || action.reason);
      return out;
    }
    if (action.kind === "blocked") {
      settle(lot, feature, "blocked", action.reason);
      return out;
    }
    // `done` : la seule route qui y mène est la fin d'un run de livraison — les
    // deux commandes mécaniques restent à passer (elles sont asynchrones).
    out.release = true;
    return out;
  }

  /**
   * Les deux commandes de la livraison (S-6) : pousser vers l'URL HTTPS du dépôt
   * puis ouvrir la PR avec `gh`, dont la sortie porte l'URL. Tout échec rend la
   * feature `blocked` avec le motif de la commande — jamais un demi-succès.
   *
   * Cette étape ATTEND (git, gh, plusieurs secondes) : elle réapplique donc son
   * seul changement sur une lecture FRAÎCHE du lot, pour ne rien écraser des
   * transitions qui auraient eu lieu entre-temps — et si la feature a été
   * annulée ou relancée pendant l'attente, elle ne touche plus à rien.
   */
  async function finishRelease(feature: LotFeature): Promise<void> {
    const commit = (state: "blocked" | "done", prUrl: string | null, reason: string | null) => {
      const fresh = read();
      // Le lot peut avoir changé de main pendant les attentes (git, gh) : la
      // transition n'est écrite — et annoncée — que si CE pilote le conduit encore
      // (S-1). `emit` avant la garde aurait annoncé un état que personne n'écrit.
      if (!fresh || fresh.owner.pid !== process.pid) return;
      const target = lotFeature(fresh, feature.slug);
      if (!target || target.state !== "running") return;
      const before = target.state;
      target.state = state;
      target.prUrl = prUrl;
      target.stopReason = reason;
      target.waitKind = null;
      target.waitPrompt = null;
      target.endedAt = touch(target, now());
      emit(fresh, target, before);
      maybeRecap(fresh);
      save(fresh);
    };
    const fail = (reason: string) => commit("blocked", null, reason);
    const gh = deps.runGh;
    if (!gh) {
      fail("gh introuvable — installe GitHub CLI puis relance la livraison");
      return;
    }
    const view = await gh(["repo", "view", "--json", "url,defaultBranchRef"], feature.worktree);
    if (view.code !== 0) {
      // `pi.exec` JETTE quand le binaire est absent (spawn ENOENT) ; le runner
      // câblé en production le mappe en `code 127`. C'est LE signal d'un `gh`
      // absent du PATH : s'en remettre au seul `deps.runGh` manquant rendait ce
      // libellé inatteignable hors des tests, et une machine sans GitHub CLI
      // lisait `gh indisponible : spawn gh ENOENT` au lieu de la marche à suivre.
      // Un dépassement de délai (`killed`, code 124) n'est PAS un binaire absent :
      // il garde son motif, qui dit la vérité.
      fail(
        view.code === 127
          ? "gh introuvable — installe GitHub CLI puis relance la livraison"
          : `gh indisponible : ${lastLine(view.stderr) || `code ${view.code}`}`,
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(view.stdout);
    } catch {
      parsed = null;
    }
    const target = releaseTarget(parsed);
    if (!target.pushUrl) {
      fail("URL HTTPS du dépôt introuvable (gh repo view)");
      return;
    }
    const subject = await deps.runGit(["log", "-1", "--format=%s"], feature.worktree);
    const title = subject.code === 0 && subject.stdout.trim() !== "" ? subject.stdout.trim() : feature.branch;
    const bodyFile = path.join(contractPathFor(feature.worktree), "..", "pr-body.md");
    const body = await deps.runGit(["log", "-1", "--format=%b"], feature.worktree);
    const args = releaseArgs({
      pushUrl: target.pushUrl,
      branch: feature.branch,
      base: target.base ?? "main",
      title,
      bodyFile: fs.existsSync(bodyFile) ? bodyFile : null,
      body: lastLine(body.stdout),
    });
    const push = await deps.runGit(args.push, feature.worktree);
    if (push.code !== 0) {
      fail(`push refusé : ${lastLine(push.stderr) || `code ${push.code}`}`);
      return;
    }
    const pr = await gh(args.pr, feature.worktree);
    let url = parsePrUrl(pr.stdout);
    if (pr.code !== 0 && !url) {
      // Une PR peut déjà exister (relance après un push réussi) : la retrouver
      // plutôt que de la déclarer manquante. `gh pr view --json url` imprime du
      // JSON — c'est `prUrlOfView` qui le lit, pas `parsePrUrl`.
      const existing = await gh(["pr", "view", feature.branch, "--json", "url"], feature.worktree);
      url = existing.code === 0 ? prUrlOfView(existing.stdout) : null;
      if (!url) {
        fail(`PR non créée : ${lastLine(pr.stderr) || `code ${pr.code}`}`);
        return;
      }
    }
    commit("done", url, null);
  }

  /** Le worktree d'une feature, créé au moment où elle démarre (S-2). */
  async function ensureWorktree(feature: LotFeature): Promise<string | null> {
    if (feature.worktree !== "") {
      if (!fs.existsSync(feature.worktree)) return "worktree introuvable sur le disque";
      // Un arbre sur disque n'est pas forcément celui de la branche annoncée :
      // relancer dessus écrirait dans un worktree étranger (S-2). Un `git` muet
      // (chemin qui n'est pas un dépôt) n'est pas un motif de refus : il n'y a
      // rien à juger, et le run rapportera lui-même ce qu'il trouve.
      const head = await deps.runGit(["rev-parse", "--abbrev-ref", "HEAD"], feature.worktree);
      if (head.code === 0 && head.stdout.trim() !== feature.branch) return "worktree sans branche";
      return null;
    }
    const created = await createFeatureWorktree({
      run: deps.runGit,
      primaryRoot: deps.repoRoot,
      slug: feature.slug,
      baseDir: worktreesBase,
      base: feature.base,
    });
    if (!created.ok) return created.error;
    feature.worktree = created.path;
    feature.branch = created.branch;
    return null;
  }

  /**
   * Les arbres créés pour une feature que l'utilisateur a reprise pendant la
   * création (annulation) : personne ne les réclame. Les retirer est la seule
   * façon de ne pas laisser d'orphelin derrière une annulation qui vient
   * d'annoncer « jamais créé » (S-9). La BRANCHE est conservée : c'est la règle
   * des trois devenirs (S-9), un arbre retiré ne fait pas disparaître le travail.
   * Ne lève jamais : un retrait refusé est dit, jamais avalé — et l'arbre reste
   * nommé, pour que l'utilisateur sache quoi retirer à la main.
   */
  async function discardWorktrees(paths: string[]): Promise<void> {
    for (const dir of paths) {
      try {
        const removed = await deps.runGit(["worktree", "remove", "--force", dir], deps.repoRoot);
        if (removed.code === 0) continue;
        notify(
          `[pipeline] worktree créé puis abandonné — retrait refusé : ${
            lastLine(removed.stderr) || `code ${removed.code}`
          } — arbre à retirer à la main : ${dir}`,
        );
      } catch (err) {
        notify(
          `[pipeline] worktree créé puis abandonné — retrait refusé : ${
            err instanceof Error ? err.message : String(err)
          } — arbre à retirer à la main : ${dir}`,
        );
      }
    }
  }

  /** Le récap de fin de lot (AC-15) : posté une fois, quand plus rien ne tourne. */
  function maybeRecap(lot: Lot): boolean {
    if (lot.features.length === 0 || lotTotals(lot).live > 0 || lot.recapAt !== null) return false;
    lot.recapAt = now();
    notify(buildLotRecap(repo, lot));
    return true;
  }

  /**
   * Une passe. Deux passes concurrentes créeraient deux fois le même worktree
   * (la seconde échouerait sur le `git` de la première et la feature serait
   * marquée `failed` pour rien) : les appels sont donc SÉRIALISÉS — un tick
   * demandé pendant une passe n'est jamais perdu, il attend la fin de celle-ci.
   */
  function tick(): Promise<void> {
    const next = tickQueue.then(() => pass(), () => pass());
    tickQueue = next.catch(() => undefined);
    return next;
  }

  // --- l'arbitre éphémère (S-9) -----------------------------------------------
  // Une session NEUVE par élément, jamais reprise : elle juge sur un corpus fermé
  // (brief, journal, contrat) et rend UNE décision que ce pilote valide avant tout
  // effet. Aucun message n'est jamais envoyé à une session parente.

  /** Les arbitrages VIVANTS de CE process : une marque `feature.arbitration` sans entrée ici est périmée. */
  const arbiting = new Map<string, AbortController>();
  const ARBITRABLE: ReadonlySet<string> = new Set(["ask", "question", "specs", "review"]);

  /** Les éléments courants de toutes les features avec contexte, dans l'ordre du lot. */
  function currentItems(lot: Lot): RelayItem[] {
    const keys = new Set<string>();
    for (const feature of lot.features) if (feature.auditSession !== undefined) keys.add(feature.auditSession);
    const items: RelayItem[] = [];
    for (const key of keys) items.push(...relayItemsOf(lot, key, (feature) => liveEntryOf(feature.worktree), { cap: false }));
    return items;
  }

  /**
   * Décide quels éléments partent à l'arbitre, et nettoie les marques périmées :
   * une marque sans arbitre vivant dans ce process (service redémarré) est
   * effacée et l'élément ré-arbitré ; une escalade dont l'élément n'est plus
   * courant tombe. Pose `feature.arbitration` — écrit avec la passe.
   */
  function planArbitrations(lot: Lot): { changed: boolean; planned: Array<{ slug: string; item: RelayItem }> } {
    const out = { changed: false, planned: [] as Array<{ slug: string; item: RelayItem }> };
    if (deps.arbiter === undefined) return out;
    const items = currentItems(lot).filter((item) => ARBITRABLE.has(item.kind));
    for (const feature of lot.features) {
      if (feature.arbitration !== undefined && !arbiting.has(feature.slug)) {
        delete feature.arbitration;
        out.changed = true;
      }
      const item = items.find((candidate) => candidate.slug === feature.slug);
      if (feature.escalation !== undefined && item?.key !== feature.escalation.key) {
        delete feature.escalation;
        out.changed = true;
      }
      if (item === undefined || feature.auditSession === undefined) continue;
      if (feature.escalation !== undefined || feature.arbitration !== undefined) continue;
      if (item.kind === "ask" && answeredAsks.has(askKey(item.slug, item.toolCallId ?? ""))) continue;
      feature.arbitration = { key: item.key, startedAt: now() };
      out.planned.push({ slug: feature.slug, item });
      out.changed = true;
    }
    return out;
  }

  function arbiterItemOf(item: RelayItem): ArbiterItem {
    return {
      kind: item.kind as ArbiterItem["kind"],
      slug: item.slug,
      phase: item.phase,
      question: item.kind === "ask" || item.kind === "question" ? (item.question ?? "") : null,
      options: item.options.map((option) => option.label),
    };
  }

  /** Pose l'escalade de l'élément (S-9) et efface la marque, dans la MÊME sauvegarde. */
  function escalateItem(slug: string, item: RelayItem, reason: string): void {
    const lot = read();
    const feature = lot ? lotFeature(lot, slug) : undefined;
    if (!lot || !feature || feature.arbitration?.key !== item.key) return;
    feature.escalation = {
      key: item.key,
      kind: item.kind === "specs" || item.kind === "review" ? "jalon" : "question",
      phase: item.phase,
      question: itemQuestion(arbiterItemOf(item)),
      options: item.options.map((option) => option.label),
      reason,
      at: now(),
    };
    delete feature.arbitration;
    save(lot);
  }

  /** Efface la marque d'arbitrage de l'élément (la décision est appliquée, ou jetée). */
  function clearArbitration(slug: string, key: string): void {
    const lot = read();
    const feature = lot ? lotFeature(lot, slug) : undefined;
    if (!lot || !feature || feature.arbitration?.key !== key) return;
    delete feature.arbitration;
    save(lot);
  }

  /**
   * La décision de l'arbitre pour `item`, ou `null` quand la feature a disparu :
   * raccourci du journal (question déjà tranchée), garde de modèle (S-4), run
   * d'arbitre puis validation déterministe.
   */
  async function decideItem(slug: string, item: RelayItem, signal: AbortSignal): Promise<ArbiterEffect | null> {
    const lot = read();
    const feature = lot ? lotFeature(lot, slug) : undefined;
    if (!feature || feature.auditSession === undefined || deps.arbiter === undefined) return null;
    const arbiterItem = arbiterItemOf(item);
    const entries = journalFor(stateDir, repoKey, slug);
    if (arbiterItem.question !== null) {
      const wanted = normalizeQuestion(arbiterItem.question);
      const known = entries.find((entry) => entry.kind === "question" && normalizeQuestion(entry.question) === wanted);
      if (known) {
        return { kind: "answer", answer: known.answer, source: "contexte", selected: arbiterItem.options.includes(known.answer) };
      }
    }
    const fallback = featureFallbackForPhase(feature, item.phase);
    const started = startModel(featureModelForPhase(feature, item.phase), fallback);
    if ("blocked" in started) {
      return { kind: "escalate", reason: `arbitre indisponible : quota épuisé (${started.blocked.provider})` };
    }
    const corpus = buildArbiterCorpus({
      brief: readBrief(stateDir, feature.auditSession),
      slug,
      entries,
      contract: readContractText(feature.worktree) || null,
    });
    const result = await deps.arbiter({
      stateDir,
      cwd: feature.worktree,
      prompt: buildArbiterPrompt(arbiterItem, corpus),
      model: started.model,
      fallback,
      deadline: now() + ARBITER_DEADLINE_MS,
      signal,
    });
    // Le run d'arbitre est enregistré à sa fin, décision ou non (S-12).
    {
      const after = read();
      const arbitrated = after ? lotFeature(after, slug) : undefined;
      if (after && arbitrated) {
        appendRunRecord(arbitrated, {
          step: "arbitre",
          lot: null,
          fix: false,
          startedAt: result.startedAt,
          endedAt: result.endedAt,
          peakContext: result.peakContext ?? null,
          sessionFile: result.sessionFile,
        });
        save(after);
      }
    }
    return validateArbiterDecision(arbiterItem, result.decision, corpus);
  }

  /**
   * Applique la décision validée : l'élément est REVÉRIFIÉ (même clé toujours
   * courante) avant tout effet ; une décision d'un élément disparu est jetée,
   * sans journal. L'effet passe par les actions publiques, source nommée — qui
   * journalisent elles-mêmes (S-7). Un refus de l'effet escalade.
   */
  async function applyEffect(slug: string, item: RelayItem, effect: ArbiterEffect): Promise<void> {
    const lot = read();
    const feature = lot ? lotFeature(lot, slug) : undefined;
    if (!lot || !feature || feature.arbitration?.key !== item.key) return;
    if (!currentItems(lot).some((candidate) => candidate.key === item.key)) return;
    if (effect.kind === "escalate") {
      escalateItem(slug, item, effect.reason);
      return;
    }
    let refusal: string | null;
    if (effect.kind === "approve") {
      refusal =
        item.kind === "specs"
          ? await controller.validate(slug, { source: "arbitrage" })
          : await controller.accept(slug, { source: "arbitrage" });
    } else if (item.kind === "ask") {
      refusal = deliverAskAnswer(
        {
          version: 1,
          id: "",
          sentAt: now(),
          repo: "",
          kind: "answer",
          slug,
          toolCallId: item.toolCallId ?? "",
          ...(effect.selected ? { selected: effect.answer } : { custom: effect.answer }),
        },
        effect.source,
      );
    } else {
      refusal = await controller.answer(slug, effect.answer, { source: effect.source, viaRelay: true });
    }
    if (refusal !== null) escalateItem(slug, item, `décision d'arbitre refusée : ${refusal}`);
  }

  async function arbitrate(slug: string, item: RelayItem): Promise<void> {
    const abort = new AbortController();
    arbiting.set(slug, abort);
    try {
      let effect: ArbiterEffect | null;
      try {
        effect = await decideItem(slug, item, abort.signal);
      } catch {
        effect = { kind: "escalate", reason: "arbitre sans décision" };
      }
      if (effect !== null) await applyEffect(slug, item, effect);
    } catch {
      /* l'effet a échoué : la marque tombe, la passe suivante ré-arbitre */
    } finally {
      arbiting.delete(slug);
      clearArbitration(slug, item.key);
    }
  }

  async function pass(): Promise<void> {
    const initial = read();
    if (!initial) return;
    if (initial.owner.pid !== process.pid) {
      stop();
      return;
    }
    // PHASE A — les worktrees manquants. C'est le SEUL moment où la passe attend :
    // aucune mutation en mémoire ne l'a précédée, donc rien ne sera écrit sur un
    // lot périmé (une fin de run peut tomber pendant l'attente du git).
    const created: Array<{ slug: string; result: { path?: string; branch?: string; error?: string } }> = [];
    if (initial.status === "running") {
      // Phase A bornée par les créneaux LIBRES (S-1) : `git worktree add` est la
      // seule attente de la passe, et préparer 28 arbres pour n'en lancer 4 ferait
      // exactement la rafale que le plafond supprime — en retardant toutes les
      // décisions de la passe. Un arbre créé pour une feature qui reste `pending`
      // est CONSERVÉ : c'est son arbre, jamais passé à `discardWorktrees`.
      let creating = freeSlots(initial);
      for (const feature of initial.features) {
        if (creating <= 0) break;
        if (feature.state !== "pending" || feature.worktree !== "" || !runnable(initial, feature)) continue;
        // Une feature que `l` n'a pas lancée n'a pas de worktree à créer : elle
        // attend le lancement du lot (S-3, CHAIN-11).
        if (feature.launched === false) continue;
        // L'arbre est déjà là mais la branche `feat/<slug>` n'existe pas : ce n'est
        // pas le worktree de cette feature, et git refuserait de le recréer — le
        // diagnostic est nommé plutôt que rendu par le message brut de git (S-2).
        const target = worktreePathFor(worktreesBase, deps.repoRoot, feature.slug);
        if (fs.existsSync(target)) {
          const branch = await deps.runGit(
            ["rev-parse", "--verify", "--quiet", `refs/heads/${feature.branch}`],
            deps.repoRoot,
          );
          if (branch.code !== 0) {
            created.push({ slug: feature.slug, result: { error: "worktree sans branche" } });
            continue;
          }
        }
        const made = await createFeatureWorktree({
          run: deps.runGit,
          primaryRoot: deps.repoRoot,
          slug: feature.slug,
          baseDir: worktreesBase,
          // La base d'une feature de projet (S-7) : la branche par défaut du
          // distant, récupérée pour son segment — sinon `HEAD`, comme avant.
          base: feature.base,
        });
        if (!made.ok) {
          created.push({ slug: feature.slug, result: { error: made.error } });
          continue;
        }
        // L'arbre EXISTE : il consomme un créneau de préparation (un échec, lui,
        // n'en consomme aucun — la feature passe `failed` et le reste avance).
        creating -= 1;
        // La dépendance est la BASE du travail, pas seulement son ordre (S-10) :
        // `createFeatureWorktree` part de `HEAD` du dépôt principal, où le travail
        // d'une dépendance n'est pas encore — « terminée » veut dire PR ouverte,
        // donc commitée sur sa branche, jamais fusionnée. On avance donc la branche
        // neuve jusqu'à celle de la première dépendance terminée. LIMITE ASSUMÉE :
        // avec plusieurs dépendances, seule la première terminée sert de base ; les
        // autres restent à fusionner par l'utilisateur. Une dépendance `done` dont
        // la branche a disparu (archivée) laisse la base à `HEAD` : rien à avancer.
        const base = baseBranchFor(initial, feature);
        if (base !== null) {
          const known = await deps.runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${base}`], deps.repoRoot);
          if (known.code === 0) {
            const merged = await deps.runGit(["merge", "--ff-only", base], made.path);
            if (merged.code !== 0) {
              // L'arbre ET sa branche existent : le chemin est consigné pour qu'il
              // ne reste pas orphelin, et l'échec est nommé (S-2).
              created.push({
                slug: feature.slug,
                result: {
                  path: made.path,
                  branch: made.branch,
                  error: `base ${base} non fusionnable : ${lastLine(merged.stderr) || `code ${merged.code}`}`,
                },
              });
              continue;
            }
          }
        }
        created.push({ slug: feature.slug, result: { path: made.path, branch: made.branch } });
      }
    }

    // PHASE B — lecture fraîche, décisions, écriture : AUCUNE attente ici, pour
    // qu'une transition concurrente ne soit jamais écrasée par un état périmé.
    const lot = read();
    if (!lot) return;
    if (lot.owner.pid !== process.pid) {
      stop();
      return;
    }
    const launches: PlannedLaunch[] = [];
    const releases: LotFeature[] = [];
    /**
     * Les arbres créés pendant que l'utilisateur reprenait leur feature : plus
     * personne ne les réclame, et les laisser derrière ferait mentir l'annulation
     * qui vient d'annoncer « jamais créé » (S-9, AC-14). Retirés APRÈS l'écriture.
     */
    const orphans: string[] = [];
    let changed = false;

    // Un lot au BROUILLON qui porte une feature SORTIE de sa collecte (S-14) est
    // conduit : c'est la clôture de SA collecte qui démarre SON pipeline, et un lot
    // n'est piloté (`adopt`, boucle, propriété) que `running`. Les features que `a`
    // a ajoutées ne partent pas pour autant : elles portent `launched: false` et
    // attendent `l` (CHAIN-11). La collecte EN COURS, elle, n'est pas un départ.
    if (lot.status === "draft" && hasStartedFeature(lot)) {
      lot.status = "running";
      lot.launchedAt = now();
      lot.reviewCap = cap;
      lot.slotCap = slots;
      changed = true;
    }

    for (const item of created) {
      const feature = lotFeature(lot, item.slug);
      // L'ACTION DE L'UTILISATEUR PRIME (S-1, AC-14) : pendant la création du
      // worktree (phase A, la seule qui attend), la feature a pu être annulée —
      // une annulation n'attend rien quand son worktree est vide. Appliquer ici
      // une décision périmée la ressusciterait `failed` après la notice `annulé`
      // (et après son récap), et lui écrirait le chemin d'un arbre créé APRÈS
      // l'annulation : un orphelin que cette notice dit « jamais créé », hors de
      // portée de `cancel` (une feature terminale) comme de `remove` (une feature
      // démarrée). Rien n'est donc appliqué, et l'arbre sans propriétaire est
      // retiré — la branche, elle, reste (même règle que les trois devenirs S-9).
      if (!feature || feature.state !== "pending") {
        if (item.result.path !== undefined) orphans.push(item.result.path);
        continue;
      }
      // L'arbre est un fait du DISQUE : son chemin se consigne même quand la base
      // n'a pas pu être fusionnée — sans lui, il serait orphelin (personne ne
      // connaîtrait son chemin, et `R` ne saurait pas où relancer).
      if (item.result.path !== undefined) {
        feature.worktree = item.result.path;
        feature.branch = item.result.branch ?? feature.branch;
      }
      if (item.result.error !== undefined) settle(lot, feature, "failed", item.result.error);
      changed = true;
    }

    // 0. Les runs VIVANTS du magasin (S-1, S-6, S-8 §1). Deux effets, tous deux
    //    portés par la MÊME lecture : la session publiée par le run fait autorité
    //    (c'est lui qui l'a écrite — une feature enrôlée par /req porte encore la
    //    session d'avant la bascule), et sa question `ask` en vol est annoncée UNE
    //    fois (sans quoi l'utilisateur ne saurait pas qu'on l'attend, et le budget
    //    du run se consumerait pendant qu'il attend).
    const liveSlugs = new Set<string>();
    const askedSlugs = new Set<string>();
    for (const feature of lot.features) {
      if (lotStateTerminal(feature.state) || feature.worktree === "") continue;
      const entry = liveEntryOf(feature.worktree);
      if (!entry) continue;
      if (entry.sessionFile && feature.sessionFile !== entry.sessionFile) {
        feature.sessionFile = entry.sessionFile;
        feature.lastRunSessionFile = entry.sessionFile;
        changed = true;
      }
      const ask = entry.pendingAsk ?? null;
      if (ask) askedSlugs.add(feature.slug);
      // Une question confiée à la session /audit n'est pas annoncée ici, et
      // `alertedAsk` ne bouge pas : l'alerte part à la première passe qui suit la
      // fermeture du relais (S-3).
      // Une question de feature AVEC contexte est tranchée par l'arbitre (S-9) : elle ne
      // prévient l'utilisateur que quand elle lui est escaladée.
      const arbitrated = deps.arbiter !== undefined && feature.auditSession !== undefined && feature.escalation === undefined;
      if (ask && !arbitrated && alertedAsk.get(feature.slug) !== ask.toolCallId && !auditRelayOpen(stateDir, feature, lot.owner.pid, now())) {
        alertedAsk.set(feature.slug, ask.toolCallId);
        const text =
          `[pipeline] ${repo}/${feature.slug} attend ta réponse (maillon /${feature.phase}) — /pipelines\n` +
          clipTail(ask.question, LOT_ALERT_PROMPT_MAX);
        notify(text);
        try {
          deps.toast?.(text, "warning");
        } catch {
          /* un toast raté n'a aucune conséquence : le message durable est posté */
        }
      }
      // Un run VIVANT dans le worktree n'est ni relancé ni jugé : on le SUIT et on
      // attend la disparition de son entrée. C'est le cas d'un run ORPHELIN (la
      // mort du pilote ne tue pas ses enfants) comme d'un run lancé par une autre
      // session du même dépôt. Sans cette garde, la reprise jugeait « pilote
      // disparu » un run qui travaille, et `R` lançait un SECOND agent dans le
      // même worktree.
      if (feature.state === "running" && !inFlight.has(feature.slug)) liveSlugs.add(feature.slug);
    }

    // Le budget de TRAVAIL des runs en vol (S-8 §1) : le décompte est suspendu
    // tant que la question du run attend une réponse, et l'abandon est décidé ICI,
    // à la passe — jamais par le délai du runner, qui couvre aussi l'attente.
    for (const [slug, clock] of workBudget) {
      const abort = inFlight.get(slug);
      if (!abort) {
        workBudget.delete(slug);
        continue;
      }
      const at = now();
      if (askedSlugs.has(slug)) {
        if (clock.since !== null) {
          clock.spent += at - clock.since;
          clock.since = null;
        }
        continue;
      }
      if (clock.since === null) clock.since = at;
      if (clock.spent + (at - clock.since) > runTimeout) {
        expiredRuns.add(slug);
        abort.abort();
      }
    }

    // 1. Les features en cours sans run suivi : un maillon jamais lancé (bascule
    // d'une collecte en session, pilote repris) démarre ici ; un run interrompu se
    // juge sur le contrat (modifié = le maillon a travaillé).
    for (const feature of lot.features) {
      if (feature.state !== "running" || inFlight.has(feature.slug)) continue;
      if (feature.origin === "session" && feature.phase === "req") continue; // collecte en session
      if (feature.worktree === "") continue;
      // Le run de ce worktree vit ENCORE (étape 0) : rien à décider.
      if (liveSlugs.has(feature.slug)) continue;
      // La fin de ce run a déjà été traitée par ce pilote : la chaîne a décidé.
      if (watched.get(feature.slug) === "settled") continue;
      // Aucun hash : aucun pilote n'a lancé de run pour cette feature — c'est le
      // cas d'une feature dont la collecte vient de basculer (S-14). Un run
      // interrompu, lui, a laissé sa marque sur le disque : le hash du contrat au
      // démarrage du run, `""` s'il n'y en avait pas encore (S-1).
      if (feature.contractHash === null) {
        launches.push({
          slug: feature.slug,
          phase: feature.phase,
          fix: false,
          kind: feature.phase === "req" ? "collecte" : "phase",
          resume: false,
        });
        changed = true;
        continue;
      }
      const verdict = reconcileInterrupted({
        contractHashAtStart: feature.contractHash,
        currentContractHash: contractHashOf(feature.worktree),
      });
      if (verdict === "continue") {
        const routed = route(lot, feature, { outcome: "ok", stdout: "", reason: "" });
        launches.push(...routed.launches);
        if (routed.release) releases.push(feature);
      } else {
        settle(lot, feature, "failed", "exécution interrompue (pilote disparu)");
      }
      changed = true;
    }

    // 2. Les dépendances fautives bloquent leurs dépendantes (AC-17) — et une
    // dépendante bloquée dont les dépendances sont REDEVENUES saines repart
    // seule : un amont qui finit par réussir ne doit pas laisser sa dépendante
    // bloquée jusqu'à un `R` que rien n'annonce. Seul un blocage HÉRITÉ d'une
    // dépendance se défait ainsi : un blocage du maillon lui-même reste au maillon.
    for (const feature of lot.features) {
      if (feature.state === "blocked" && dependencyStopReason(feature.stopReason) && runnable(lot, feature)) {
        feature.state = "pending";
        feature.stopReason = null;
        feature.waitKind = null;
        feature.waitPrompt = null;
        feature.endedAt = null;
        touch(feature, now());
        changed = true;
        continue;
      }
      if (feature.state !== "pending") continue;
      const reason = dependencyBlock(lot, feature);
      if (reason) {
        settle(lot, feature, "blocked", reason);
        changed = true;
      }
    }

    // 3. Les features runnables démarrent, dans l'ordre du lot et DANS LA LIMITE
    // DES CRÉNEAUX LIBRES (S-1, AC-1, AC-2) — sauf celles qu'un ajout dans un lot
    // au BROUILLON a mises de côté : elles attendent `l`, qui les marque lancées.
    // Sans ce garde, un `/req` dans un lot brouillon démarrait tous les pipelines
    // ajoutés par `a` (S-3, CHAIN-11). Le parcours s'INTERROMPT dès que le
    // compteur tombe à zéro : les suivantes restent `pending`, sans qu'aucune
    // écriture ne les touche (leur horloge court depuis leur entrée en attente).
    let free = freeSlots(lot);
    for (const feature of lot.features) {
      if (lot.status !== "running" || feature.state !== "pending") continue;
      if (feature.launched === false || !runnable(lot, feature) || feature.worktree === "") continue;
      if (free <= 0) break;
      free -= 1;
      // Un lancement RETENU (S-3) repart TEL QUEL : phase, `fix`, `kind`, `resume`
      // et texte d'une réponse sont ceux du geste, et l'armement partagé consomme
      // les compteurs du plafond au démarrage réel — pas à la retenue.
      const held = feature.held;
      const launch: PlannedLaunch = held
        ? { ...held, slug: feature.slug }
        : {
            slug: feature.slug,
            phase: feature.phase,
            fix: false,
            kind: feature.phase === "req" ? "collecte" : "phase",
            resume: false,
          };
      arm(feature, launch);
      launches.push(launch);
      changed = true;
    }

    // 4. L'arbitrage (S-9) : l'élément courant de chaque feature AVEC contexte
    // qui n'a ni escalade ni arbitrage en vol. Les marques sont posées ICI et
    // écrites AVEC la passe — l'arbitre ne part qu'après la sauvegarde.
    const arbitrations = planArbitrations(lot);
    if (arbitrations.changed) changed = true;
    if (maybeRecap(lot)) changed = true;
    // Le battement du propriétaire (S-1) : un pilote VIVANT le rafraîchit à chaque
    // passe. Sans lui, un pid réutilisé après un redémarrage ferait passer un
    // propriétaire mort pour vivant — et le lot resterait verrouillé pour toujours.
    const beat = lot.owner.heartbeatAt;
    if (lot.owner.pid === process.pid && (beat === undefined || now() - beat >= LOT_TICK_MS)) changed = true;
    // Le lot n'a pas pu être écrit : aucun run ne part (cf. `startRun`), et la
    // passe rend la main — le véritable pilote conduira ce lot.
    if (changed && save(lot) !== null) return;
    // Les lancements viennent APRÈS la sauvegarde : un run qui rend la main
    // aussitôt n'écrit jamais sur un lot plus vieux que celui qu'on vient d'écrire.
    for (const launch of launches) {
      const feature = lotFeature(lot, launch.slug);
      if (feature) startRun(lot, feature, launch);
    }
    for (const feature of releases) void finishRelease(feature);
    for (const planned of arbitrations.planned) void arbitrate(planned.slug, planned.item);
    // Dernier acte de la passe, APRÈS l'écriture : c'est un `await` (`git`), il ne
    // décide plus rien — l'arbre abandonné n'appartient à aucune feature du lot.
    await discardWorktrees(orphans);
  }

  // --- le canal de commande : pompage, effets, purge (S-1 à S-14) -------------
  // Le canal est POMPÉ par sa propre minuterie (S-1) et sa propre file : une
  // commande peut lancer un lot (`add` + `launch`), donc l'appliquer depuis
  // `pass()` s'auto-bloquerait sur la passe enchaînée derrière la sienne.

  /** Le pompage demandé : une passe à la fois, aucune perdue (patron de `tick`). */
  function pumpCommands(): Promise<void> {
    const next = pumpQueue.then(() => pumpPass(), () => pumpPass());
    pumpQueue = next.catch(() => undefined);
    return next;
  }

  /** La clé d'un couple (feature, question) : une seule forme pour le garde de S-5. */
  function askKey(slug: string, toolCallId: string): string {
    return `${slug}\u0000${toolCallId}`;
  }

  /**
   * L'accusé écrit sur le disque. Rend `false` quand l'écriture est impossible
   * (disque) : la commande N'EST PAS retirée du canal et sera reprise à la passe
   * suivante (S-1) — et rien n'est appliqué entre-temps (S-8).
   */
  function writeAck(raw: unknown, id: string, state: CommandState, reason: string | null): boolean {
    try {
      writeCommandAck(stateDir, commandAck(raw, id, state, reason, now()));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ce que la décision d'UNE commande doit savoir, relu frais (S-11) : le lot, le
   * motif du refus d'un pilote VIVANT étranger, les features dont le jalon est
   * confié à une session de relais ouverte (un verdict seulement — c'est le seul
   * geste que le relais s'approprie) et la question en vol du run vivant visé.
   */
  function commandViewOf(cmd: PipelineCommand, branchTakenNow: boolean): CommandView {
    const lot = read();
    const foreign = foreignOwner();
    const relayed = new Set<string>();
    if (lot && cmd.kind === "verdict") {
      for (const feature of lot.features) {
        if (auditRelayOpen(stateDir, feature, lot.owner.pid, now())) relayed.add(feature.slug);
      }
    }
    const slug = commandSlugOf(cmd);
    const feature = lot !== null && slug !== null ? lotFeature(lot, slug) : undefined;
    const entry = feature === undefined ? null : liveEntryOf(feature.worktree);
    return {
      lot,
      foreignReason: foreign === null ? null : foreignOwnerReason(foreign),
      branchTaken: branchTakenNow,
      relayed,
      pendingAsk: entry?.pendingAsk ?? null,
      askAnswered: cmd.kind === "answer" && slug !== null && answeredAsks.has(askKey(slug, cmd.toolCallId)),
    };
  }

  /**
   * La réponse à une question en vol (S-5) : une livraison `ask` dans la boîte
   * PUBLIÉE par le run (`panelInboxDirOf`), jamais un chemin recalculé —
   * `panelInboxDirFor` rend le premier dossier inexistant et deux calculs
   * successifs divergent (piège mesuré). Le couple (slug, question) n'est inscrit
   * dans `answeredAsks` QUE si la livraison a réussi : une écriture ratée laisse la
   * question répondable par une commande neuve.
   */
  function deliverAskAnswer(
    cmd: Extract<PipelineCommand, { kind: "answer" }>,
    source: DecisionSource = "utilisateur",
  ): string | null {
    const lot = read();
    if (!lot) return LOT_NONE_REFUSAL;
    const feature = lotFeature(lot, cmd.slug);
    if (!feature) return lotFeatureMissingRefusal(cmd.slug);
    const entry = liveEntryOf(feature.worktree);
    const inbox = entry === null ? null : panelInboxDirOf(entry);
    const sentAt = now();
    const tag = source === "utilisateur" ? {} : { source };
    const delivery: PanelDelivery =
      cmd.selected !== undefined
        ? { version: 1, kind: "ask", toolCallId: cmd.toolCallId, selected: cmd.selected, sentAt, ...tag }
        : { version: 1, kind: "ask", toolCallId: cmd.toolCallId, custom: cmd.custom ?? "", sentAt, ...tag };
    if (inbox === null) return "écriture impossible : ce run n'a plus de boîte";
    try {
      writeDelivery(inbox, delivery);
    } catch (err) {
      return `écriture impossible : ${err instanceof Error ? err.message : String(err)}`;
    }
    answeredAsks.add(askKey(cmd.slug, cmd.toolCallId));
    // Le journal (S-7) : la question du run en vol, une fois la réponse livrée.
    const asked = entry?.pendingAsk;
    journalDecision(
      feature,
      feature.phase,
      "question",
      asked && asked.toolCallId === cmd.toolCallId ? asked.question : (questionOf(feature.waitPrompt) ?? "(question sans texte)"),
      cmd.selected ?? cmd.custom ?? "",
      source,
    );
    return null;
  }

  /**
   * L'effet d'une commande prise en charge, par les MÊMES actions que le panneau et
   * les relais — rien n'est réécrit ici (BR-2). Un refus rendu APRÈS l'accusé
   * `taken` (course avec un autre écrivain, branche prise entre la décision et
   * l'ajout) est signalé par une notice durable : l'accusé n'est jamais réécrit.
   */
  async function applyCommand(cmd: PipelineCommand): Promise<void> {
    const actions = api;
    if (actions === null) return;
    switch (cmd.kind) {
      case "launch": {
        const added = await actions.add({
          name: cmd.title,
          description: cmd.description,
          deps: cmd.deps ?? [],
          modelReqSpecs: cmd.modelReqSpecs ?? null,
          modelImplReview: cmd.modelImplReview ?? null,
          ...(cmd.fallbackReqSpecs !== undefined ? { fallbackReqSpecs: cmd.fallbackReqSpecs } : {}),
          ...(cmd.fallbackImplReview !== undefined ? { fallbackImplReview: cmd.fallbackImplReview } : {}),
        });
        if (added !== null) {
          notify(`[pipeline] commande launch : ${added}`);
          return;
        }
        const started = await actions.launch();
        if (started !== null) notify(`[pipeline] commande launch : ${started}`);
        return;
      }
      case "add": {
        const added = await actions.add({
          name: cmd.title,
          description: cmd.description,
          deps: cmd.deps ?? [],
          modelReqSpecs: cmd.modelReqSpecs ?? null,
          modelImplReview: cmd.modelImplReview ?? null,
          ...(cmd.fallbackReqSpecs !== undefined ? { fallbackReqSpecs: cmd.fallbackReqSpecs } : {}),
          ...(cmd.fallbackImplReview !== undefined ? { fallbackImplReview: cmd.fallbackImplReview } : {}),
        });
        if (added !== null) notify(`[pipeline] commande add : ${added}`);
        return;
      }
      case "models": {
        const edited = await actions.editModels(cmd.slug, {
          modelReqSpecs: cmd.modelReqSpecs,
          modelImplReview: cmd.modelImplReview,
          ...(cmd.fallbackReqSpecs !== undefined ? { fallbackReqSpecs: cmd.fallbackReqSpecs } : {}),
          ...(cmd.fallbackImplReview !== undefined ? { fallbackImplReview: cmd.fallbackImplReview } : {}),
        });
        if (edited !== null) notify(`[pipeline] commande models : ${edited}`);
        return;
      }
      case "remove": {
        const removed = await actions.remove(cmd.slug);
        if (removed !== null) notify(`[pipeline] commande remove : ${removed}`);
        return;
      }
      case "verdict": {
        const done = cmd.verdict === "v" ? await actions.validate(cmd.slug) : await actions.accept(cmd.slug);
        if (done !== null) notify(`[pipeline] commande verdict : ${done}`);
        return;
      }
      case "answer": {
        const delivered = deliverAskAnswer(cmd);
        if (delivered !== null) notify(`[pipeline] commande answer : ${delivered}`);
        return;
      }
      case "reply": {
        const replied = await actions.answer(cmd.slug, cmd.text);
        if (replied !== null) notify(`[pipeline] commande reply : ${replied}`);
        return;
      }
      case "relaunch": {
        const done = await actions.relaunch(cmd.slug);
        if (done !== null) notify(`[pipeline] commande relaunch : ${done}`);
        return;
      }
      case "quota": {
        const done = await actions.resolveQuota(cmd.provider, cmd.model, { kind: "unrelayed" });
        if (done !== null) notify(`[pipeline] commande quota : ${done}`);
        return;
      }
      case "cancel": {
        const done = await actions.cancel(cmd.slug, cmd.fate);
        if (done !== null) notify(`[pipeline] commande cancel : ${done}`);
        return;
      }
      case "start": {
        const done = await actions.launch();
        if (done !== null) notify(`[pipeline] commande start : ${done}`);
        return;
      }
      case "stop": {
        // L'état « cohérent » de l'arrêt (S-3) : les runs en vol sont interrompus
        // sans être attendus, et les features restent `running` avec leur hash de
        // contrat — un pilote ultérieur les réconcilie.
        actions.abortAll("commande d'arrêt");
        stop();
        return;
      }
    }
  }

  /**
   * Une commande reçue par l'API (S-9) : les MÊMES refus, le MÊME accusé et la
   * MÊME idempotence que le canal de fichiers — la décision est la fonction pure
   * `commandRefusal`, sur une lecture fraîche, et l'accusé écrit sur le disque est
   * ce qui rend le rejeu d'un identifiant inoffensif.
   *
   * L'effet précède un TICK du contrôleur : au retour de la réponse, le magasin
   * porte déjà l'état résultant (S-8, S-9). Un accusé impossible à écrire ne
   * laisse RIEN s'appliquer : sans lui, un rejeu doublerait l'effet.
   */
  async function acceptCommand(cmd: PipelineCommand): Promise<PipelineCommandAck> {
    const known = readCommandAck(stateDir, cmd.id);
    if (known !== null) return known;
    // Le contrôle de BRANCHE d'un ajout est un `git` : il est fait AVANT la
    // décision pour que celle-ci reste pure (même ordre que le canal de fichiers).
    let branchTakenNow = false;
    if (cmd.kind === "launch" || cmd.kind === "add") {
      const slug = toSlug(cmd.title);
      if (slug !== null) {
        try {
          branchTakenNow = await branchTaken(deps.runGit, deps.repoRoot, branchFor(slug));
        } catch {
          branchTakenNow = false;
        }
      }
    }
    const reason = commandRefusal(cmd, commandViewOf(cmd, branchTakenNow));
    const ack = commandAck(cmd, cmd.id, reason === null ? "taken" : "refused", reason, now());
    try {
      writeCommandAck(stateDir, ack);
    } catch {
      return commandAck(cmd, cmd.id, "refused", "écriture de l'accusé impossible", now());
    }
    if (reason !== null) return ack;
    try {
      await applyCommand(cmd);
    } catch {
      /* l'accusé fait foi : le rejeu ne double pas l'effet (S-9) */
    }
    await tick();
    return ack;
  }

  /**
   * Une passe du canal : les commandes STABLES du dépôt, dans l'ordre
   * lexicographique (chronologique), au plus `COMMAND_MAX_PER_PASS` — le reste
   * attend la passe suivante. Chaque commande suit le même ordre (S-8) : décision
   * pure sur une lecture FRAÎCHE → si refus, accusé `refused` PUIS retrait ; sinon
   * accusé `taken`, PUIS l'effet, PUIS le retrait. Le fichier n'est jamais retiré
   * avant que l'accusé soit sur le disque (B-7), et un accusé déjà présent fait
   * réponse sans nouvel effet (S-9).
   */
  async function pumpPass(): Promise<void> {
    const candidates = readCommands(stateDir, now());
    if (candidates.length === 0) return;
    const repo = realpathOr(deps.repoRoot);
    let handled = 0;
    for (const candidate of candidates) {
      if (handled >= COMMAND_MAX_PER_PASS) break;
      const cmd = candidate.unreadable ? null : asCommand(candidate.raw);
      // (1) L'ADRESSAGE d'abord : une commande d'un autre dépôt est laissée telle
      //     quelle, sans accusé ni retrait (S-10) — son pilote s'en chargera.
      if (cmd !== null && realpathOr(cmd.repo) !== repo) continue;
      // (2) Un accusé déjà écrit EST l'enregistrement du traitement (S-9) : le
      //     fichier est retiré sans nouvel accusé et sans effet. Un accusé
      //     ILLISIBLE est traité comme absent (`readCommandAck` rend `null`).
      const knownId = cmd !== null ? cmd.id : commandIdOf(candidate.raw);
      if (knownId !== null && readCommandAck(stateDir, knownId) !== null) {
        removeCommandFile(candidate.file);
        handled += 1;
        continue;
      }
      // (3) Un JSON illisible n'a ni identifiant ni dépôt à qui répondre : aucun
      //     accusé n'est possible (S-1 interdit d'en reconstruire un), mais le
      //     refus est DIT et le fichier retiré — sans quoi la pompe le relirait à
      //     chaque passe (S-13).
      if (candidate.unreadable) {
        notify(`[pipeline] commande refusée : ${COMMAND_UNREADABLE_REFUSAL} (${path.basename(candidate.file)})`);
        removeCommandFile(candidate.file);
        handled += 1;
        continue;
      }
      if (cmd === null) {
        // Hors schéma : l'accusé est possible dès que l'identifiant l'est.
        if (knownId !== null && !writeAck(candidate.raw, knownId, "refused", commandShapeRefusal(candidate.raw))) {
          continue;
        }
        removeCommandFile(candidate.file);
        handled += 1;
        continue;
      }
      // (4) Le contrôle de BRANCHE d'un ajout est un `git` : il est fait AVANT la
      //     décision pour que celle-ci reste pure et garde l'ordre du tableau de
      //     S-1 (contenu, slug, branche, dépendances, pilote étranger). Un `git`
      //     en échec ne vaut pas « branche prise » : c'est `add` qui tranchera.
      let branchTakenNow = false;
      if (cmd.kind === "launch" || cmd.kind === "add") {
        const slug = toSlug(cmd.title);
        if (slug !== null) {
          try {
            branchTakenNow = await branchTaken(deps.runGit, deps.repoRoot, branchFor(slug));
          } catch {
            branchTakenNow = false;
          }
        }
      }
      const reason = commandRefusal(cmd, commandViewOf(cmd, branchTakenNow));
      if (reason !== null) {
        if (!writeAck(cmd, cmd.id, "refused", reason)) continue;
        removeCommandFile(candidate.file);
        handled += 1;
        continue;
      }
      if (!writeAck(cmd, cmd.id, "taken", null)) continue;
      try {
        await applyCommand(cmd);
      } catch {
        /* l'accusé fait foi : le rejeu ne double pas l'effet (S-9) */
      }
      removeCommandFile(candidate.file);
      handled += 1;
    }
  }

  /** La purge d'AC-12 : un lot TERMINÉ n'a plus de canal — ses accusés sont retirés. */
  function purgeAcksOnStop(): void {
    const lot = read();
    // Seul le PROPRIÉTAIRE purge : l'arrêt d'une session qui n'écrit pas ce lot ne
    // touche pas le canal d'un autre pilote.
    if (!lot || lot.owner.pid !== process.pid || !lotReplaceable(lot)) return;
    purgeCommandAcks(stateDir, deps.repoRoot);
  }

  /**
   * Démarre la boucle (une passe par `LOT_TICK_MS`) et se réécrit propriétaire.
   *
   * Une session TERMINALE n'arme JAMAIS sa boucle tant qu'un service vit (S-4,
   * S-11) : son runner est une porte fermée, ses passes ne feraient qu'écrire des
   * refus et disputer le lot au vrai pilote. Seuls le service, et une machine sans
   * service (où plus rien n'avance, S-4), font tourner cette boucle.
   */
  function start(): void {
    if (stopLoop) return;
    const service = serviceRunning(stateDir);
    if (pilotRole !== "service" && service !== null && service.pid !== process.pid) return;
    stopLoop = (deps.schedule ?? defaultSchedule)(() => {
      void tick().catch(() => undefined);
    }, LOT_TICK_MS);
    stopPump = (deps.schedule ?? defaultSchedule)(() => {
      void pumpCommands().catch(() => undefined);
    }, COMMAND_POLL_MS);
    // Le démarrage d'un pilote pompe IMMÉDIATEMENT, avant sa première passe
    // (S-10) : une commande en attente est prise en charge dès l'armement.
    void pumpCommands();
    void tick().catch(() => undefined);
  }

  function stop(): void {
    stopLoop?.();
    stopLoop = null;
    stopPump?.();
    stopPump = null;
    purgeAcksOnStop();
  }

  /** Reprend un lot dont le pilote a disparu (S-1) — jamais un lot qui vit encore. */
  function adopt(): boolean {
    const lot = read();
    if (!lot || lotTotals(lot).live === 0) return false;
    // Un lot encore au BROUILLON n'est repris que si la clôture d'une collecte de
    // session en a ouvert le pipeline (S-14) : un brouillon où `a` a seulement
    // ajouté des features attend `l` — le reprendre lancerait leur pipeline.
    if (lot.status === "draft" && !hasStartedFeature(lot)) return false;
    if (lot.owner.pid === process.pid) return false;
    // Le service est le pilote UNIQUE de la machine (S-4) : un pid vivant qui n'est
    // pas lui — session terminale d'avant la bascule, run d'une version antérieure
    // — ne lui dispute pas le lot, il le reprend.
    if (pilotRole !== "service" && lotOwnerAlive(lot.owner, now())) return false;
    if (save(lot) !== null) return false;
    notify(`[pipeline] lot ${repo} repris par cette session (pilote précédent disparu)`);
    return true;
  }

  /**
   * Une action du panneau qui démarre un run : l'état change, puis le run part.
   * Rend le motif du refus quand le lot n'a pas pu être écrit (rien ne partirait).
   *
   * LE PLAFOND PASSE ICI AUSSI (S-3) : sans créneau libre, le geste n'est ni perdu
   * ni refusé — il est RETENU (la feature redevient `pending` avec son lancement
   * mémorisé dans `held`) et la passe le démarre dès qu'un run rend son créneau,
   * dans l'ordre du lot.
   */
  function startPlanned(lot: Lot, feature: LotFeature, launch: PlannedLaunch): string | null {
    // Une feature TERMINALE qui repart rouvre le lot : le récap déjà posté décrivait
    // un état final qui n'en est plus un (S-12). Sans cette remise à zéro, la vraie
    // fin ne serait jamais annoncée, et le seul récap resterait faux.
    if (lotStateTerminal(feature.state)) lot.recapAt = null;
    if (!hasFreeSlot(lot)) {
      feature.phase = launch.phase;
      feature.state = "pending";
      feature.waitKind = null;
      feature.waitPrompt = null;
      feature.stopReason = null;
      feature.endedAt = null;
      feature.held = {
        phase: launch.phase,
        fix: launch.fix,
        kind: launch.kind,
        resume: launch.resume,
        // Le texte d'une réponse est borné par la même borne que l'éditeur du
        // panneau : un `held` ne fait jamais grossir le lot au-delà de ses règles.
        ...(launch.text === undefined ? {} : { text: launch.text.slice(0, LOT_EDITOR_MAX) }),
      };
      touch(feature, now());
      // Le récap a décrit un état final qui n'en est plus un : le lancement retenu
      // repart le lot.
      lot.recapAt = null;
      // Sauvegarde AVANT tout : le geste retenu ne doit pas pouvoir se perdre — un
      // échec d'écriture rend le motif de refus habituel, et rien ne part.
      const refusal = save(lot);
      if (refusal) return refusal;
      // La boucle est armée et une passe suit : c'est elle qui démarrera la retenue
      // dès qu'un créneau se libère, sans autre geste de l'utilisateur.
      start();
      void tick().catch(() => undefined);
      return null;
    }
    arm(feature, launch);
    // Sauvegarde AVANT le lancement : un run qui rend la main tout de suite ne
    // doit pas écrire sa transition sur un lot plus vieux que celui-ci — et rien
    // ne part si le lot n'a pas pu être écrit.
    const refusal = save(lot);
    if (refusal) return refusal;
    startRun(lot, feature, launch);
    return null;
  }

  /**
   * Ouvre le lot pour une action : refuse si une AUTRE session vivante le pilote
   * (un seul pilote), reprend la main si son pilote est mort. Rend un motif de
   * refus, ou le lot (et la feature demandée).
   */
  function open(slug?: string): { lot: Lot; feature?: LotFeature } | string {
    const lot = read();
    if (!lot) return LOT_NONE_REFUSAL;
    const foreign = foreignRefusal();
    if (foreign !== null) return foreign;
    if (lot.owner.pid !== process.pid) {
      const refusal = save(lot);
      if (refusal) return refusal;
      start();
    }
    if (slug === undefined) return { lot };
    const feature = lotFeature(lot, slug);
    if (!feature) return lotFeatureMissingRefusal(slug);
    return { lot, feature };
  }

  const controller: LotController = {
    read,
    start,
    stop,
    tick,
    pumpCommands,
    adopt,
    acceptCommand,

    /**
     * Tue les runs EN VOL (S-1) : appelé à la fermeture de la session pilote. Les
     * enfants d'un `pi.exec` ne meurent pas avec leur parent, donc sans cet abort
     * quitter OMP laissait des runs orphelins — sans délai, dans des worktrees que
     * plus personne ne pilotait, et la session suivante les jugeait « pilote
     * disparu » pendant qu'ils travaillaient encore.
     *
     * Les features restent `running` : la fin de ces runs n'est PAS un échec de
     * leur maillon (elles sont marquées `cancelling`, donc `finishRun` ne les
     * touche pas), et la session qui reprend le lot les réconcilie par le hash de
     * leur contrat (S-1). Rendu immédiat, jamais d'exception.
     */
    abortAll(reason) {
      const running = [...inFlight.keys()];
      for (const [slug, abort] of inFlight) {
        cancelling.add(slug);
        try {
          abort.abort();
        } catch {
          /* un abort raté ne lève jamais : le run finira par sa propre échéance */
        }
      }
      inFlight.clear();
      workBudget.clear();
      expiredRuns.clear();
      if (running.length > 0) notify(`[pipeline] lot ${repo} : ${reason} — ${running.length} run(s) arrêté(s)`);
    },

    enrol(input) {
      const existing = read();
      // Un lot conduit par un AUTRE PILOTE VIVANT n'est jamais réécrit (S-1,
      // invariant 2) : ce `/req` n'y inscrit rien — sa feature garde la chaîne
      // manuelle (S-14), et le lot de l'autre est intact. Le SERVICE, lui, n'est
      // pas un étranger : une session terminale écrit son lot, le service l'adopte
      // au balayage suivant (S-4).
      const foreign = foreignRefusal();
      if (foreign !== null) return foreign;
      if (existing && existing.owner.pid !== process.pid) {
        const taken = save(existing);
        if (taken) return taken;
        start();
      }
      const lot = !existing || lotReplaceable(existing) ? freshLot() : existing;
      if (lotFeature(lot, input.slug)) return null;
      // Le récap déjà posté décrivait un état final qui n'en est plus un : la
      // nouvelle feature repart le lot, donc c'est la VRAIE fin qui sera annoncée.
      lot.recapAt = null;
      const at = now();
      lot.features.push({
        slug: input.slug,
        name: input.name,
        branch: input.branch,
        worktree: input.worktree,
        deps: [],
        origin: "session",
        state: "running",
        phase: "req",
        waitKind: null,
        waitPrompt: null,
        sessionFile: deps.session?.().file ?? null,
        pendingTexts: [],
        prUrl: null,
        stopReason: null,
        fixes: 0,
        reviewRuns: 0,
        unreadableRuns: 0,
        lastRunSessionFile: null,
        contractHash: null,
        // La feature de session est LANCÉE : c'est la clôture de sa collecte qui
        // démarre son pipeline (S-14), pas le lancement du lot. Le lot, lui, reste
        // au brouillon : `a` n'a rien lancé, et `enrol` ne décide pas pour lui.
        launched: true,
        // Les modèles (S-2) : chaque clé n'existe que pour une valeur exploitable —
        // « défaut OMP » ne s'écrit pas.
        ...modelSlotsField(input),
        ...fallbackSlotsField(input),
        addedAt: at,
        sinceAt: at,
        updatedAt: at,
        endedAt: null,
      });
      return save(lot);
    },

    async add(input) {
      const slug = toSlug(input.name);
      if (!slug) {
        return `nom invalide : « ${input.name} » — lettres minuscules, chiffres et tirets (ex. isolation-worktree)`;
      }
      // Les refus qui ne demandent aucun `git` sont rendus tout de suite, dans
      // l'ordre de S-3.
      const early = lotForAdd(slug, input.deps);
      if (typeof early === "string") return early;
      const branch = branchFor(slug);
      if (await branchTaken(deps.runGit, deps.repoRoot, branch)) {
        return lotBranchTakenRefusal(branch);
      }
      // `branchTaken` a ATTENDU : le lot est donc relu ici, et l'ajout s'écrit
      // dans la foulée sans aucun `await` (S-1). Écrire le lot lu avant l'attente
      // écraserait une transition tombée entre-temps (AC-2 : les pipelines en
      // cours ne bougent pas).
      const opened = lotForAdd(slug, input.deps);
      if (typeof opened === "string") return opened;
      const { lot, deps: depsSlugs } = opened;
      // Le récap déjà posté décrivait un état final qui n'en est plus un : la
      // nouvelle feature repart le lot, donc c'est la VRAIE fin qui sera annoncée.
      lot.recapAt = null;
      // Ajoutée à un lot LANCÉ, elle démarre à la passe suivante (AC-2) ; ajoutée à
      // un lot au BROUILLON, elle attend `l` comme les autres (CHAIN-11). Une
      // feature /audit démarre toujours : le lot au brouillon passe en marche dans
      // la MÊME écriture, ses autres features attendent toujours `l` (S-1).
      const audit = input.auditSession !== undefined;
      const launched = audit || lot.status === "running";
      const at = now();
      if (audit && lot.status === "draft") {
        lot.status = "running";
        lot.launchedAt = at;
        lot.reviewCap = cap;
        lot.slotCap = slots;
      }
      lot.features.push({
        slug,
        name: input.description.trim(),
        branch,
        worktree: "",
        deps: depsSlugs,
        origin: "panneau",
        state: "pending",
        phase: "req",
        waitKind: null,
        waitPrompt: null,
        sessionFile: null,
        pendingTexts: [],
        prUrl: null,
        stopReason: null,
        fixes: 0,
        reviewRuns: 0,
        unreadableRuns: 0,
        lastRunSessionFile: null,
        contractHash: null,
        launched,
        ...(audit ? { auditSession: input.auditSession } : {}),
        // Le genre de relais et la base (S-7) : écrits à la création, jamais
        // modifiés — même patron que `auditSession`.
        ...(input.relayKind === "project" ? { relayKind: "project" as const } : {}),
        ...(isLotBaseSha(input.base) ? { base: input.base } : {}),
        // Les modèles (S-2) : même garde qu'à l'enrôlement — une commande d'un
        // client antérieur (clés absentes) crée une feature sans clé de modèle.
        ...modelSlotsField(input),
        ...fallbackSlotsField(input),
        addedAt: at,
        sinceAt: at,
        updatedAt: at,
        endedAt: null,
      });
      const refusal = save(lot);
      if (refusal) return refusal;
      // Un lot lancé avance par sa boucle : la nouvelle feature démarre à la
      // passe qui suit, sans autre action de l'utilisateur (AC-2) et sans que
      // les autres pipelines soient touchés.
      if (lot.status === "running") {
        start();
        await tick();
      }
      return null;
    },

    async launch() {
      const opened = open();
      if (typeof opened === "string") return opened;
      const { lot } = opened;
      if (lot.features.length === 0) return "lot vide — a pour ajouter une feature";
      // `l` est LE lancement : le lot passe en marche s'il était au brouillon, et
      // TOUTES les features en attente deviennent lancées — celles que `a` avait
      // mises de côté comprises (CHAIN-11). Le faire même sur un lot déjà lancé
      // rattrape un brouillon qu'une clôture de collecte a ouvert (S-14).
      const at = now();
      let changed = false;
      if (lot.status === "draft") {
        lot.status = "running";
        lot.launchedAt = at;
        lot.reviewCap = cap;
        lot.slotCap = slots;
        changed = true;
      }
      for (const feature of lot.features) {
        if (feature.state === "pending" && feature.launched === false) {
          feature.launched = true;
          changed = true;
        }
      }
      if (changed) {
        const refusal = save(lot);
        if (refusal) return refusal;
      }
      // Le lot tourne : sa boucle est armée (S-11). Sans elle, un lot né du
      // panneau n'avancerait qu'à la fin d'un run — une feature devenue runnable
      // pendant qu'aucun run n'est en vol resterait `pending` indéfiniment.
      start();
      await tick();
      return null;
    },

    async remove(slug) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return lotFeatureMissingRefusal(slug);
      if (feature.state !== "pending") return lotRemoveStartedRefusal(slug);
      const dependent = lot.features.find((other) => other.state === "pending" && other.deps.includes(slug));
      if (dependent) return lotRemoveDependentRefusal(dependent.slug);
      lot.features = lot.features.filter((other) => other.slug !== slug);
      return save(lot);
    },

    async editModels(slug, input) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return lotFeatureMissingRefusal(slug);
      // Les clés de modèle sont REMPLACÉES ensemble (S-3) : une valeur blanche EFFACE
      // la clé, et l'ancien modèle unique est supprimé — il ne sert plus de repli.
      // Les replis (S-1) : clé absente = inchangé, `null` = retiré, chaîne = ce repli.
      // Le refus « repli identique au principal » est jugé AVANT toute mutation.
      const nextModels = modelSlotsField(input);
      const nextFallbacks = {
        fallbackReqSpecs: input.fallbackReqSpecs === undefined ? feature.fallbackReqSpecs : input.fallbackReqSpecs,
        fallbackImplReview:
          input.fallbackImplReview === undefined ? feature.fallbackImplReview : input.fallbackImplReview,
      };
      const identical =
        fallbackEqualsPrimaryRefusal(nextModels.modelReqSpecs, nextFallbacks.fallbackReqSpecs, "modelReqSpecs") ??
        fallbackEqualsPrimaryRefusal(nextModels.modelImplReview, nextFallbacks.fallbackImplReview, "modelImplReview");
      if (identical !== null) return identical;
      // Le seul champ touché est le modèle (et son repli) : ni l'état, ni la phase, ni les compteurs.
      delete feature.model;
      delete feature.modelReqSpecs;
      delete feature.modelImplReview;
      delete feature.fallbackReqSpecs;
      delete feature.fallbackImplReview;
      Object.assign(feature, nextModels, fallbackSlotsField(nextFallbacks));
      return save(lot);
    },

    /**
     * Livre une réponse — dans la boîte d'un run ARMÉ, dans la file d'un run sans
     * boîte, ou par un nouveau run avec son contexte — la MÊME règle que
     * `rowReply`, appliquée ici pour exécuter (S-5, S-6, S-8, S-11). Un tampon
     * vide se refuse AVANT la règle. Aucun `await` entre la lecture et l'écriture :
     * un seul écrivain.
     */
    async answer(slug, text, options) {
      const trimmed = text.trim();
      if (trimmed === "") return "réponse vide";
      // Le relais (/audit ou /project) répond lui-même : la question qu'il relaie
      // n'est pas refusée comme « confiée à la session » (S-3, S-6).
      const fromRelay = options?.viaRelay === true;
      const source = options?.source ?? "utilisateur";
      // Les cas qui n'écrivent PAS le lot se règlent SANS revendiquer la propriété
      // (F1) : la boîte d'un run vivant et la question en vol s'atteignent depuis
      // n'importe quelle session — exiger la propriété ici faisait annoncer
      // « steer » par `reply` puis refuser par `answer`, et le panneau proposait
      // une touche qui ne marchait pas.
      const known = read();
      const knownFeature = known ? lotFeature(known, slug) : undefined;
      if (known && knownFeature) {
        const live = liveWriterOf(known, knownFeature);
        const direct = rowReply(knownFeature, { ...live, ...(fromRelay ? { auditRelay: false } : {}), viaArbiter: source !== "utilisateur" });
        if (direct.kind === "closed") return direct.reason;
        if (direct.kind === "ask") return ASK_REPLY_REFUSAL;
        if (direct.kind === "steer") return deliverSteer(direct.inbox, trimmed);
      }
      // Tout le reste ÉCRIT le lot (file `pendingTexts`, relance d'un maillon) :
      // `open` en est la garde, et un lot conduit par une session vivante n'y est
      // jamais réécrit (S-1, invariant 2).
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return lotFeatureMissingRefusal(slug);
      const live = liveWriterOf(lot, feature);
      const reply = rowReply(feature, { ...live, ...(fromRelay ? { auditRelay: false } : {}), viaArbiter: source !== "utilisateur" });
      if (reply.kind === "closed") return reply.reason;
      if (reply.kind === "ask") return ASK_REPLY_REFUSAL;
      if (reply.kind === "steer") return deliverSteer(reply.inbox, trimmed);
      if (reply.kind === "queue") {
        const queued = feature.pendingTexts;
        const total = queued.reduce((count, message) => count + message.length, 0);
        if (queued.length >= LOT_PENDING_MAX || total + trimmed.length > LOT_PENDING_TOTAL_MAX) {
          return LOT_PENDING_FULL;
        }
        feature.pendingTexts = [...queued, trimmed.slice(0, LOT_EDITOR_MAX)];
        feature.updatedAt = now();
        return save(lot);
      }
      // `reply` (feature en attente) et `text` (feature bloquée) : un run repart
      // avec son contexte, et la PHASE est conservée (S-8 §1 et §2).
      const asked = feature.state === "waiting" && feature.waitKind === "answer" ? feature.waitPrompt : null;
      delete feature.escalation;
      const started = await startPlanned(lot, feature, {
        slug,
        phase: feature.phase,
        fix: false,
        kind: "answer",
        text: trimmed,
        resume: true,
        ...(source === "utilisateur" ? {} : { source }),
      });
      // Le journal (S-7) : une réponse À UNE QUESTION, une fois appliquée.
      if (started === null && asked !== null) {
        journalDecision(feature, feature.phase, "question", questionOf(asked) ?? asked, trimmed, source);
      }
      return started;
    },

    /**
     * Ce que cette feature accepte comme écriture (S-11), pour la zone de saisie
     * de la vue. Lecture seule : aucun propriétaire n'est revendiqué, et un slug
     * absent rend le motif que `answer` aurait rendu.
     */
    reply(slug) {
      const lot = read();
      if (!lot) return { kind: "closed", reason: LOT_NONE_REFUSAL };
      const feature = lotFeature(lot, slug);
      if (!feature) return { kind: "closed", reason: lotFeatureMissingRefusal(slug) };
      return rowReply(feature, liveWriterOf(lot, feature));
    },

    async validate(slug, options) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return lotFeatureMissingRefusal(slug);
      if (feature.state !== "waiting" || feature.waitKind !== "specs") {
        return "rien à valider : la feature n'est pas au jalon des specs";
      }
      const source = options?.source === "arbitrage" ? "arbitrage" : "utilisateur";
      if (source === "utilisateur" && feature.arbitration !== undefined) return ARBITRATION_REFUSAL;
      // La source du jalon (S-11) : lue par le prompt du run qui suit, puis effacée.
      feature.milestoneSource = source;
      delete feature.escalation;
      // La découpe de l'impl (S-13) : figée ICI, depuis le contrat tel qu'il est validé.
      const implLots = contractLots(readContractText(feature.worktree));
      if (implLots.length >= 2) {
        feature.implLots = implLots;
        feature.implLot = 0;
      } else {
        delete feature.implLots;
        delete feature.implLot;
      }
      const started = await startPlanned(lot, feature, { slug, phase: "impl", fix: false, kind: "phase", resume: false });
      if (started === null) journalDecision(feature, "specs", "jalon", "specs validées ?", "validé", source);
      else {
        delete feature.milestoneSource;
        delete feature.implLots;
        delete feature.implLot;
      }
      return started;
    },

    async accept(slug, options) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return lotFeatureMissingRefusal(slug);
      if (feature.state !== "waiting" || feature.waitKind !== "review") {
        return "rien à accepter : la revue n'est pas propre";
      }
      const source = options?.source === "arbitrage" ? "arbitrage" : "utilisateur";
      if (source === "utilisateur" && feature.arbitration !== undefined) return ARBITRATION_REFUSAL;
      feature.milestoneSource = source;
      delete feature.escalation;
      const started = await startPlanned(lot, feature, { slug, phase: "release", fix: false, kind: "phase", resume: false });
      if (started === null) journalDecision(feature, "review", "jalon", "revue propre : livrer ?", "accepté", source);
      else delete feature.milestoneSource;
      return started;
    },

    async resolveQuota(provider, model, scope) {
      const opened = open();
      if (typeof opened === "string") return opened;
      const { lot } = opened;
      const at = now();
      const inScope = (feature: LotFeature): boolean =>
        scope.kind === "context"
          ? feature.auditSession === scope.key
          : scope.kind === "unrelayed"
            ? !auditRelayOpen(stateDir, feature, lot.owner.pid, at)
            : true;
      const slugs = quotaGroupsOf(lot, inScope).find((group) => group.provider === provider)?.slugs ?? [];
      if (slugs.length === 0) return `aucune feature bloquée par le quota ${provider}`;
      const hit = exhaustedUntil(stateDir, model, at);
      if (hit !== null) return `${model} est épuisé ${quotaDeadlineLabel(hit.until, hit.announced)} — choisis un autre modèle`;
      // Le repli du groupe du run bloqué devient M ; le principal ne change JAMAIS,
      // et un M qui EST le principal du groupe laisse la feature telle quelle.
      for (const slug of slugs) {
        const feature = lotFeature(lot, slug) as LotFeature;
        const quota = feature.quota as NonNullable<LotFeature["quota"]>;
        if (featureModelForPhase(feature, quota.phase) === model) continue;
        const key = modelGroupOf(quota.phase) === "modelReqSpecs" ? "fallbackReqSpecs" : "fallbackImplReview";
        feature[key] = model;
      }
      const written = save(lot);
      if (written === null) {
        for (const slug of slugs) {
          const feature = lotFeature(lot, slug) as LotFeature;
          const quota = feature.quota as NonNullable<LotFeature["quota"]>;
          journalDecision(feature, quota.phase, "quota", `quota ${provider} épuisé — relancer avec quel repli ?`, model);
        }
      }
      if (written !== null) return written;
      const refusals: string[] = [];
      for (const slug of slugs) {
        const refusal = await controller.relaunch(slug);
        if (refusal !== null) refusals.push(`${slug} : ${refusal}`);
      }
      return refusals.length === 0 ? null : refusals.join(" · ");
    },

    async relaunch(slug) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return lotFeatureMissingRefusal(slug);
      // Une feature ANNULÉE dont le worktree est conservé se relance : l'annulation
      // garde la branche dans les trois devenirs (S-9), donc refuser la relance
      // condamnait un travail intact — et la ré-ajouter sous le même nom butait sur
      // « la branche existe déjà ».
      if (!lotStateTerminal(feature.state) || feature.state === "done") {
        return "relance possible sur une feature bloquée, échouée ou annulée";
      }
      // Une dépendance non satisfaite garde la feature à l'arrêt (S-10) : la
      // relancer ouvrirait un run pour une feature dont l'amont a échoué.
      const unmet = feature.deps.map((dep) => lotFeature(lot, dep)).find((up) => up?.state !== "done");
      if (!runnable(lot, feature) && unmet) {
        const refusal = `dépendance ${unmet.slug} non terminée (${lotStateLabel(unmet.state)})`;
        // `settle` alerte lui-même si l'état CHANGE (échouée → bloquée) : une
        // feature déjà bloquée n'a pas de transition, donc pas d'alerte en double.
        settle(lot, feature, "blocked", refusal);
        const written = save(lot);
        return written ?? refusal;
      }
      // La préparation du worktree ATTEND (`git`) : elle travaille sur un brouillon
      // jetable, jamais sur le lot — l'écriture se fera après la relecture.
      const draft: LotFeature = { ...feature };
      const worktreeError = await ensureWorktree(draft);
      if (worktreeError) return worktreeError;
      const prepared = draft.worktree;
      const preparedBranch = draft.branch;
      // La préparation du worktree a ATTENDU (`git`) : le lot est relu ici, et la
      // relance s'écrit dans la foulée sans aucun `await` (S-1).
      const fresh = read();
      if (!fresh) return LOT_NONE_REFUSAL;
      if (fresh.owner.pid !== process.pid) {
        return foreignOwnerReason(fresh.owner.pid);
      }
      const target = lotFeature(fresh, slug);
      if (!target) return lotFeatureMissingRefusal(slug);
      if (!lotStateTerminal(target.state) || target.state === "done") {
        return "relance possible sur une feature bloquée, échouée ou annulée";
      }
      // Le worktree préparé est un fait du DISQUE : il se consigne même si la
      // feature a bougé entre-temps — c'est le chemin qu'un run utiliserait.
      target.worktree = prepared;
      target.branch = preparedBranch;
      // Le plafond est une borne par tentative : relancer ouvre un nouveau crédit.
      target.fixes = 0;
      target.reviewRuns = 0;
      target.unreadableRuns = 0;
      // Un blocage au PLAFOND laisse la feature en phase `review` avec un verdict
      // bloquant : la relancer en /review relancerait une revue sur un code
      // inchangé, soit une revue complète de plus. C'est /impl --fix qui a du sens.
      const verdict = reviewVerdict(readContractText(target.worktree));
      const fix = verdict === "blockers";
      const phase = fix && target.phase === "review" ? "impl" : target.phase;
      // Au maillon `req`, la relance reprend la COLLECTE (avec l'intention
      // déclarée) : un prompt `[reprise] …` n'est pas reconnu comme une notice
      // `[req]`, donc un slug contenant « fin » y clôturerait la collecte au
      // premier tour, et « reprends où tu t'es arrêté » ne veut rien dire pour une
      // feature qui n'a jamais tourné.
      const kind: LotPromptKind = phase === "req" ? "collecte" : "relaunch";
      // La relance REPREND la session retenue quand il y en a une (S-8 §1) : un run
      // tué ou en échec a quand même une conversation, et repartir d'une session
      // NEUVE effaçait l'échange (la collecte, les arbitrages déjà rendus).
      return startPlanned(fresh, target, {
        slug,
        phase,
        fix,
        kind,
        resume: target.sessionFile !== null || liveEntryOf(target.worktree) !== null,
      });
    },

    async cancel(slug, fate) {
      // Deux annulations de la MÊME feature ne s'empilent pas (S-9) : la seconde
      // écrirait « annulation impossible : la feature est annulée » après le succès
      // de la première, ou retirerait deux fois le même worktree. La première rend
      // sa propre notice, donc la seconde est un succès silencieux.
      if (cancelling.has(slug)) return null;
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { feature } = opened;
      if (!feature) return lotFeatureMissingRefusal(slug);
      // Une bloquée ou une échouée s ABANDONNE (S-9) : `R` rouvre un crédit de
      // correction entier, ce n est pas un abandon. Seules `done` et `cancelled`
      // refusent encore.
      if (!lotStateCancellable(feature.state)) return lotCancelRefusal(feature.state);
      // Une annulation ATTEND : la mort du run (jusqu'à 10 s, c'est ce qu'elle
      // attend) puis `git` pour le sort du worktree. Elle n'écrit donc RIEN avant
      // d'avoir relu le lot (S-1) : la transition d'une AUTRE feature tombée dans
      // cette fenêtre doit survivre — S-9 promet de ne pas y toucher, et AC-19
      // qu'un pipeline fautif ne freine pas les autres.
      cancelling.add(slug);
      try {
        const abort = inFlight.get(slug);
        if (abort) {
          abort.abort();
          const deadline = Date.now() + 10_000;
          while (inFlight.has(slug) && Date.now() < deadline) await sleep(50);
          inFlight.delete(slug);
        }
        // Le chemin du worktree vient du DISQUE, pas d'un lot lu avant l'attente.
        const known = read();
        const subject = (known ? lotFeature(known, slug) : undefined) ?? feature;
        let message = "worktree conservé (jamais créé)";
        if (subject.worktree !== "") {
          const applied = await applyWorktreeFate({
            fate,
            feature: subject,
            repoRoot: deps.repoRoot,
            archiveBase,
            currentCwd: process.cwd(),
            run: deps.runGit,
          });
          if (!applied.ok) {
            const lot = read();
            const target = lot ? lotFeature(lot, slug) : undefined;
            // Une feature devenue terminale pendant l'attente (son run a fini
            // avant de mourir) n'est plus touchée : le refus est alors rendu sans
            // écriture — pas plus qu'un lot repris entre-temps par un pilote
            // vivant, dont cette session n'écrit plus rien (S-1).
            if (lot && lot.owner.pid === process.pid && target && !lotStateTerminal(target.state)) {
              settle(lot, target, "blocked", applied.message);
              save(lot);
            }
            return applied.message;
          }
          message = applied.message;
        }
        // Relecture, mutation, écriture : sans aucun `await` entre elles.
        const lot = read();
        if (!lot) return LOT_NONE_REFUSAL;
        if (lot.owner.pid !== process.pid) return foreignOwnerReason(lot.owner.pid);
        const target = lotFeature(lot, slug);
        if (!target) return lotFeatureMissingRefusal(slug);
        if (!lotStateCancellable(target.state)) {
          return lotCancelRefusal(target.state);
        }
        // Un run a pu partir pendant l'attente (passe déclenchée par une autre
        // feature) : une feature annulée n'en laisse aucun tourner.
        inFlight.get(slug)?.abort();
        const before = target.state;
        target.state = "cancelled";
        // Une feature annulée n'a plus de destinataire : le lancement retenu tombe
        // avec elle (S-3), comme sa file.
        delete target.held;
        target.waitKind = null;
        target.waitPrompt = null;
        target.stopReason = null;
        // Une feature terminale n'a plus de destinataire : la file tombe avec elle
        // (S-5). Une RELANCE, elle, la conserve — la reprise emporte le message.
        target.pendingTexts = [];
        target.endedAt = touch(target, now());
        emit(lot, target, before);
        notify(`[pipeline] ${slug} annulé — ${message}`);
        maybeRecap(lot);
        return save(lot);
      } finally {
        cancelling.delete(slug);
      }
    },
  };
  // Les actions publiques sont liées ICI : le pompage (armé par `start`) est le
  // seul appelant interne qui doit passer par elles.
  api = controller;
  return controller;
}
