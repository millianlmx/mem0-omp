// Le pilote d'un dépôt : une passe = lire, décider, lancer.
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { contractHashOf, effectiveReviewVerdict, nextChainAction, readContractText, reconcileInterrupted, reviewSectionHash } from "./chain.ts";
import type { ChainOutcome } from "./chain.ts";
import { reviewBlockers, reviewVerdict } from "./contract.ts";
import type { PipelinePhase } from "./contract.ts";
import { branchFor, branchTaken, contractPathFor, createFeatureWorktree, realpathOr, toSlug, worktreePathFor, worktreesBaseDir } from "./git.ts";
import type { GitResult, GitRunner } from "./git.ts";
import { LOT_ALERT_PROMPT_MAX, LOT_EDITOR_MAX, LOT_PENDING_FULL, LOT_PENDING_MAX, LOT_PENDING_TOTAL_MAX, LOT_REASON_MAX, LOT_RUN_DEADLINE_MARGIN_MS, LOT_TICK_MS, LOT_VERSION, LOT_WAIT_PROMPT_MAX, buildLotAlert, buildLotRecap, dependencyBlock, dependencyStopReason, lotArchiveBaseDir, lotCancelRefusal, lotFeature, lotOmpBin, lotOwnerAlive, lotRepoKey, lotReplaceable, lotReviewCap, lotRunTimeoutMs, lotStateCancellable, lotStateLabel, lotStateTerminal, lotTotals, readLot, rowReply, runnable, trailingQuestion, writeLot } from "./lot.ts";
import type { Lot, LotFeature, LotFeatureState, RowLiveWriter, RowReply } from "./lot.ts";
import { defaultSchedule } from "./panelView.ts";
import { clipTail } from "./panelWidth.ts";
import { reportStateWriteFailure } from "./publish.ts";
import { SELF_MODULE_URL, applyWorktreeFate, buildLotPrompt, buildLotRunArgv, lastLine, latestSessionFile, parsePrUrl, prUrlOfView, releaseArgs, releaseTarget, selfExtensionArg } from "./runs.ts";
import type { LotPromptKind, LotRunner, LotRunnerResult, WorktreeFate } from "./runs.ts";
import { dropInbox, liveRunFor, panelInboxDirFor, panelInboxDirOf, readStore, writeDelivery } from "./store.ts";
import type { PanelPendingAsk, RunningEntry } from "./store.ts";



// --- le pilote : une passe = lire, décider, lancer (S-2, S-4, S-11) ----------

export type AddFeatureInput = { name: string; description: string; deps: string[] };


/** Le refus d'une réponse à un `ask` (S-7) : la question se répond dans SA vue. */
const ASK_REPLY_REFUSAL = "le maillon attend une réponse à sa question : choisis une option dans sa conversation";


/** Ce que le panneau demande au pilote : chaque refus rend son motif, jamais une exception. */
export type LotPanelActions = {
  add(input: AddFeatureInput): Promise<string | null>;
  launch(): Promise<string | null>;
  remove(slug: string): Promise<string | null>;
  /** Livre la réponse (feature `waiting`+`answer`) ou met le texte en file (`running`). */
  answer(slug: string, text: string): Promise<string | null>;
  /** Ce que cette feature accepte comme écriture — la MÊME règle que `answer` applique. */
  reply(slug: string): RowReply;
  validate(slug: string): Promise<string | null>;
  accept(slug: string): Promise<string | null>;
  relaunch(slug: string): Promise<string | null>;
  cancel(slug: string, fate: WorktreeFate): Promise<string | null>;
};


export type LotControllerDeps = {
  stateDir: string;
  repoRoot: string;
  run: LotRunner;
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
  ompBin?: string;
  selfPath?: string | null;
  reviewCap?: number;
  runTimeoutMs?: number;
};


export type LotController = LotPanelActions & {
  read(): Lot | null;
  start(): void;
  stop(): void;
  tick(): Promise<void>;
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
  enrol(input: { slug: string; name: string; branch: string; worktree: string }): string | null;
};


export type PlannedLaunch = { slug: string; phase: PipelinePhase; fix: boolean; kind: LotPromptKind; text?: string; resume: boolean };


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
  const cap = deps.reviewCap ?? lotReviewCap();
  const runTimeout = deps.runTimeoutMs ?? lotRunTimeoutMs();
  const ompBin = deps.ompBin ?? lotOmpBin();
  const worktreesBase = deps.worktreesBase ?? worktreesBaseDir();
  const archiveBase = deps.archiveBase ?? lotArchiveBaseDir();
  const inFlight = new Map<string, AbortController>();
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
   */
  function foreignOwner(): number | null {
    const onDisk = read();
    if (!onDisk || onDisk.owner.pid === process.pid) return null;
    return lotOwnerAlive(onDisk.owner, now()) ? onDisk.owner.pid : null;
  }

  /** Un refus d'écriture est dit UNE fois par session — le toast disparaîtrait. */
  function reportForeignOwner(pid: number): void {
    if (foreignOwnerWarned) return;
    foreignOwnerWarned = true;
    notify(`[pipeline] lot ${repo} : ${foreignOwnerReason(pid)} — rien ne lui a été écrit`);
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
    // Le battement est estampillé à CHAQUE écriture : c'est lui qui distingue un
    // pilote vivant d'un pid réutilisé après un redémarrage (S-1). Un lot sans
    // battement (écrit par une version antérieure) reste lisible : `lotOwnerAlive`
    // retombe alors sur le pid seul.
    lot.owner = { pid: process.pid, sessionFile: session.file, sessionId: session.id, heartbeatAt: now() };
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
   * magasin n'est pas encore réconcilié, c'est ici qu'on le constate.
   */
  function liveWriterOf(feature: LotFeature): RowLiveWriter | null {
    const entry = liveEntryOf(feature.worktree);
    if (!entry) return null;
    return { inbox: panelInboxDirOf(entry), pendingAsk: entry.pendingAsk ?? null };
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

  /** Une transition qui appelle l'utilisateur est annoncée UNE fois (AC-11). */
  function emit(lot: Lot, feature: LotFeature, before: LotFeatureState): void {
    if (before === feature.state) return;
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
    feature.stopReason = reason;
    feature.waitKind = null;
    feature.waitPrompt = null;
    feature.endedAt = touch(feature, now());
    emit(lot, feature, before);
  }

  function freshLot(): Lot {
    const at = now();
    return {
      version: LOT_VERSION,
      id: repoKey,
      repoRoot: realpathOr(deps.repoRoot),
      status: "draft",
      reviewCap: cap,
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
    if (existing && existing.owner.pid !== process.pid) {
      if (lotOwnerAlive(existing.owner, now())) return foreignOwnerReason(existing.owner.pid);
      const refusal = save(existing);
      if (refusal) return refusal;
      start();
    }
    const lot = !existing || lotReplaceable(existing) ? freshLot() : existing;
    if (lotFeature(lot, slug)) return `« ${slug} » est déjà dans le lot`;
    const deps: string[] = [];
    for (const raw of depsRaw) {
      // Un slug non normalisable n'est jamais dans le lot : il tombe donc dans
      // le même refus que la dépendance absente (S-3), sans message de plus.
      const dep = toSlug(raw) ?? raw.trim();
      if (dep === slug) return `dépendance circulaire : ${slug}`;
      if (!lotFeature(lot, dep)) return `dépendance inconnue : ${dep}`;
      deps.push(dep);
    }
    return { lot, deps };
  }

  function startRun(lot: Lot, feature: LotFeature, launch: PlannedLaunch): void {
    // La file (S-5) est consommée PAR le run qui part : les textes sont capturés
    // avant d'être vidés, et le vidage part dans l'écriture même qui démarre le run.
    // Une écriture refusée (propriétaire étranger vivant, disque) rend les textes à
    // la file : aucun run ne part, donc aucun message n'est perdu.
    const queued = feature.pendingTexts;
    feature.pendingTexts = [];
    const prompt = buildLotPrompt({
      kind: launch.kind,
      phase: launch.phase,
      slug: feature.slug,
      description: feature.name,
      text: launch.text,
      fix: launch.fix,
      messages: queued,
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
    const argv = buildLotRunArgv({
      ompBin,
      worktree: feature.worktree,
      prompt,
      lotId: lot.id,
      slug: feature.slug,
      phase: launch.phase,
      stateDir,
      sessionFile,
      selfPath: deps.selfPath ?? selfExtensionArg(SELF_MODULE_URL),
      inbox,
      deadline: at + runTimeout + LOT_RUN_DEADLINE_MARGIN_MS,
    });
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
      return;
    }
    const startedAt = now();
    // `deps.run` peut jeter AVANT de rendre sa promesse (argv inexploitable,
    // spawn refusé) : l'échec appartient alors à CETTE feature, jamais à la passe.
    let launched: Promise<LotRunnerResult>;
    try {
      launched = Promise.resolve(
        // Le délai du runner est la MÊME borne de sécurité que celle de l'enfant :
        // le budget de TRAVAIL est tenu par la passe (elle seule sait suspendre le
        // décompte pendant une question en vol, cf. `workBudget`). Un délai de
        // runner calé sur le budget de travail tuerait un run qui ATTEND.
        deps.run({
          argv,
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
    // La session du run est retenue quel que soit son SORT (S-8 §1) : un run tué ou
    // en échec a quand même une conversation, et c'est elle qu'une réponse doit
    // reprendre — la perdre obligeait `R` à repartir d'une session NEUVE, en
    // effaçant l'échange en cours.
    const session = latestSessionFile(stateDir, feature.worktree, startedAt);
    if (session) {
      feature.sessionFile = session;
      feature.lastRunSessionFile = session;
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
      feature.fixes += action.fix ? 1 : 0;
      feature.reviewRuns += action.phase === "review" ? 1 : 0;
      feature.unreadableRuns = (feature.unreadableRuns ?? 0) + (action.phase === "review" ? 1 : 0);
      feature.phase = action.phase;
      feature.state = "running";
      feature.waitKind = null;
      feature.waitPrompt = null;
      feature.stopReason = null;
      feature.endedAt = null;
      touch(feature, now());
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
      for (const feature of initial.features) {
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
        });
        if (!made.ok) {
          created.push({ slug: feature.slug, result: { error: made.error } });
          continue;
        }
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
      if (ask && alertedAsk.get(feature.slug) !== ask.toolCallId) {
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

    // 3. Les features runnables démarrent, toutes dans la même passe (AC-18) — sauf
    // celles qu'un ajout dans un lot au BROUILLON a mises de côté : elles attendent
    // `l`, qui les marque lancées. Sans ce garde, un `/req` dans un lot brouillon
    // démarrait tous les pipelines ajoutés par `a` (S-3, CHAIN-11).
    for (const feature of lot.features) {
      if (lot.status !== "running" || feature.state !== "pending") continue;
      if (feature.launched === false || !runnable(lot, feature) || feature.worktree === "") continue;
      feature.state = "running";
      feature.waitKind = null;
      feature.stopReason = null;
      touch(feature, now());
      launches.push({
        slug: feature.slug,
        phase: feature.phase,
        fix: false,
        kind: feature.phase === "req" ? "collecte" : "phase",
        resume: false,
      });
      changed = true;
    }

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
    // Dernier acte de la passe, APRÈS l'écriture : c'est un `await` (`git`), il ne
    // décide plus rien — l'arbre abandonné n'appartient à aucune feature du lot.
    await discardWorktrees(orphans);
  }

  /** Démarre la boucle (une passe par `LOT_TICK_MS`) et se réécrit propriétaire. */
  function start(): void {
    if (stopLoop) return;
    stopLoop = (deps.schedule ?? defaultSchedule)(() => {
      void tick().catch(() => undefined);
    }, LOT_TICK_MS);
    void tick().catch(() => undefined);
  }

  function stop(): void {
    stopLoop?.();
    stopLoop = null;
  }

  /** Reprend un lot dont le pilote a disparu (S-1) — jamais un lot qui vit encore. */
  function adopt(): boolean {
    const lot = read();
    if (!lot || lotTotals(lot).live === 0) return false;
    // Un lot encore au BROUILLON n'est repris que si la clôture d'une collecte de
    // session en a ouvert le pipeline (S-14) : un brouillon où `a` a seulement
    // ajouté des features attend `l` — le reprendre lancerait leur pipeline.
    if (lot.status === "draft" && !hasStartedFeature(lot)) return false;
    if (lot.owner.pid === process.pid || lotOwnerAlive(lot.owner, now())) return false;
    if (save(lot) !== null) return false;
    notify(`[pipeline] lot ${repo} repris par cette session (pilote précédent disparu)`);
    return true;
  }

  /**
   * Une action du panneau qui démarre un run : l'état change, puis le run part.
   * Rend le motif du refus quand le lot n'a pas pu être écrit (rien ne partirait).
   */
  function startPlanned(lot: Lot, feature: LotFeature, launch: PlannedLaunch): string | null {
    // Une feature TERMINALE qui repart rouvre le lot : le récap déjà posté décrivait
    // un état final qui n'en est plus un (S-12). Sans cette remise à zéro, la vraie
    // fin ne serait jamais annoncée, et le seul récap resterait faux.
    if (lotStateTerminal(feature.state)) lot.recapAt = null;
    feature.phase = launch.phase;
    feature.state = "running";
    feature.waitKind = null;
    feature.waitPrompt = null;
    feature.stopReason = null;
    feature.endedAt = null;
    // Les compteurs du plafond comptent AUSSI les runs lancés par une action (R,
    // réponse, jalon) : sinon le plafond effectif valait cap+1 corrections, et une
    // revue lancée par R n'était comptée nulle part (S-5).
    feature.fixes += launch.fix ? 1 : 0;
    feature.reviewRuns += launch.phase === "review" ? 1 : 0;
    feature.unreadableRuns = (feature.unreadableRuns ?? 0) + (launch.phase === "review" ? 1 : 0);
    touch(feature, now());
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
    if (!lot) return "aucun lot pour ce dépôt";
    if (lot.owner.pid !== process.pid) {
      if (lotOwnerAlive(lot.owner, now())) return foreignOwnerReason(lot.owner.pid);
      const refusal = save(lot);
      if (refusal) return refusal;
      start();
    }
    if (slug === undefined) return { lot };
    const feature = lotFeature(lot, slug);
    if (!feature) return `« ${slug} » n'est pas dans le lot`;
    return { lot, feature };
  }

  return {
    read,
    start,
    stop,
    tick,
    adopt,

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
      // Un lot conduit par une session VIVANTE n'est jamais réécrit (S-1,
      // invariant 2) : ce `/req` n'y inscrit rien — sa feature garde la chaîne
      // manuelle (S-14), et le lot de l'autre session est intact. Un pilote MORT,
      // lui, se reprend : c'est la seule reprise admise.
      if (existing && existing.owner.pid !== process.pid) {
        if (lotOwnerAlive(existing.owner, now())) {
          reportForeignOwner(existing.owner.pid);
          return foreignOwnerReason(existing.owner.pid);
        }
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
        return `la branche ${branch} existe déjà — renomme la feature (un autre nom) ou supprime la branche (git branch -D ${branch})`;
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
      // un lot au BROUILLON, elle attend `l` comme les autres (CHAIN-11).
      const launched = lot.status === "running";
      const at = now();
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
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      if (feature.state !== "pending") return `« ${slug} » a déjà démarré — c pour annuler`;
      const dependent = lot.features.find((other) => other.state === "pending" && other.deps.includes(slug));
      if (dependent) return `retrait refusé : ${dependent.slug} en dépend`;
      lot.features = lot.features.filter((other) => other.slug !== slug);
      return save(lot);
    },

    /**
     * Livre une réponse — dans la boîte d'un run ARMÉ, dans la file d'un run sans
     * boîte, ou par un nouveau run avec son contexte — la MÊME règle que
     * `rowReply`, appliquée ici pour exécuter (S-5, S-6, S-8, S-11). Un tampon
     * vide se refuse AVANT la règle. Aucun `await` entre la lecture et l'écriture :
     * un seul écrivain.
     */
    async answer(slug, text) {
      const trimmed = text.trim();
      if (trimmed === "") return "réponse vide";
      // Les cas qui n'écrivent PAS le lot se règlent SANS revendiquer la propriété
      // (F1) : la boîte d'un run vivant et la question en vol s'atteignent depuis
      // n'importe quelle session — exiger la propriété ici faisait annoncer
      // « steer » par `reply` puis refuser par `answer`, et le panneau proposait
      // une touche qui ne marchait pas.
      const known = read();
      const knownFeature = known ? lotFeature(known, slug) : undefined;
      if (knownFeature) {
        const direct = rowReply(knownFeature, liveWriterOf(knownFeature));
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
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      const reply = rowReply(feature, liveWriterOf(feature));
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
      return startPlanned(lot, feature, {
        slug,
        phase: feature.phase,
        fix: false,
        kind: "answer",
        text: trimmed,
        resume: true,
      });
    },

    /**
     * Ce que cette feature accepte comme écriture (S-11), pour la zone de saisie
     * de la vue. Lecture seule : aucun propriétaire n'est revendiqué, et un slug
     * absent rend le motif que `answer` aurait rendu.
     */
    reply(slug) {
      const lot = read();
      if (!lot) return { kind: "closed", reason: "aucun lot pour ce dépôt" };
      const feature = lotFeature(lot, slug);
      if (!feature) return { kind: "closed", reason: `« ${slug} » n'est pas dans le lot` };
      return rowReply(feature, liveWriterOf(feature));
    },

    async validate(slug) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      if (feature.state !== "waiting" || feature.waitKind !== "specs") {
        return "rien à valider : la feature n'est pas au jalon des specs";
      }
      return startPlanned(lot, feature, { slug, phase: "impl", fix: false, kind: "phase", resume: false });
    },

    async accept(slug) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      if (feature.state !== "waiting" || feature.waitKind !== "review") {
        return "rien à accepter : la revue n'est pas propre";
      }
      return startPlanned(lot, feature, { slug, phase: "release", fix: false, kind: "phase", resume: false });
    },

    async relaunch(slug) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
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
      if (!fresh) return "aucun lot pour ce dépôt";
      if (fresh.owner.pid !== process.pid) {
        return foreignOwnerReason(fresh.owner.pid);
      }
      const target = lotFeature(fresh, slug);
      if (!target) return `« ${slug} » n'est pas dans le lot`;
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
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
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
        if (!lot) return "aucun lot pour ce dépôt";
        if (lot.owner.pid !== process.pid) return foreignOwnerReason(lot.owner.pid);
        const target = lotFeature(lot, slug);
        if (!target) return `« ${slug} » n'est pas dans le lot`;
        if (!lotStateCancellable(target.state)) {
          return lotCancelRefusal(target.state);
        }
        // Un run a pu partir pendant l'attente (passe déclenchée par une autre
        // feature) : une feature annulée n'en laisse aucun tourner.
        inFlight.get(slug)?.abort();
        const before = target.state;
        target.state = "cancelled";
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
}
