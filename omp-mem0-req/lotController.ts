// Le pilote d'un dépôt : une passe = lire, décider, lancer.
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { contractHashOf, nextChainAction, readContractText, reconcileInterrupted } from "./chain.ts";
import type { ChainOutcome } from "./chain.ts";
import { reviewVerdict } from "./contract.ts";
import type { PipelinePhase } from "./contract.ts";
import { branchFor, branchTaken, contractPathFor, createFeatureWorktree, realpathOr, toSlug, worktreePathFor, worktreesBaseDir } from "./git.ts";
import type { GitResult, GitRunner } from "./git.ts";
import { LOT_EDITOR_MAX, LOT_PENDING_FULL, LOT_PENDING_MAX, LOT_PENDING_TOTAL_MAX, LOT_REASON_MAX, LOT_TICK_MS, LOT_VERSION, LOT_WAIT_PROMPT_MAX, buildLotAlert, buildLotRecap, dependencyBlock, lotArchiveBaseDir, lotFeature, lotOmpBin, lotRepoKey, lotReviewCap, lotRunTimeoutMs, lotStateLabel, lotStateTerminal, lotTotals, readLot, rowReply, runnable, writeLot } from "./lot.ts";
import type { Lot, LotFeature, LotFeatureState, RowLiveWriter, RowReply } from "./lot.ts";
import { defaultSchedule } from "./panelView.ts";
import { clipTail } from "./panelWidth.ts";
import { reportStateWriteFailure } from "./publish.ts";
import { SELF_MODULE_URL, applyWorktreeFate, buildLotPrompt, buildLotRunArgv, lastLine, latestSessionFile, parsePrUrl, prUrlOfView, releaseArgs, releaseTarget, selfExtensionArg } from "./runs.ts";
import type { LotPromptKind, LotRunner, LotRunnerResult, WorktreeFate } from "./runs.ts";
import { dropInbox, panelInboxDirFor, panelInboxDirOf, pidAlive, readStore, writeDelivery } from "./store.ts";



// --- le pilote : une passe = lire, décider, lancer (S-2, S-4, S-11) ----------

export type AddFeatureInput = { name: string; description: string; deps: string[] };


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
   * Les annulations en cours. Une annulation laisse au run qu'elle tue jusqu'à 10 s
   * pour rendre la main (S-9) : la fin de ce run ne doit donc pas marquer la
   * feature `failed` pendant cette attente — c'est l'annulation qui décide de son
   * sort, et une feature que l'utilisateur annule ne doit pas finir « échouée ».
   */
  const cancelling = new Set<string>();
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
   * mort n'est pas un obstacle : c'est la reprise admise (S-1).
   */
  function foreignOwner(): number | null {
    const onDisk = read();
    if (!onDisk || onDisk.owner.pid === process.pid) return null;
    return pidAlive(onDisk.owner.pid) ? onDisk.owner.pid : null;
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
    lot.owner = { pid: process.pid, sessionFile: session.file, sessionId: session.id };
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
   * entrée de magasin, où vit sa boîte. Un propriétaire mort n'écrit plus rien —
   * le magasin n'est pas encore réconcilié, c'est ici qu'on le constate.
   */
  function liveWriterOf(feature: LotFeature): RowLiveWriter | null {
    if (feature.worktree === "") return null;
    const real = realpathOr(feature.worktree);
    for (const entry of readStore(stateDir).running) {
      if (!pidAlive(entry.owner.pid)) continue;
      if (realpathOr(entry.cwd) !== real) continue;
      return { inbox: panelInboxDirOf(entry), pendingAsk: entry.pendingAsk ?? null };
    }
    return null;
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
   * d'un lot dont plus rien ne tourne (le récap a déjà été posté), puis les
   * validations de S-3 — dans cet ordre, sans rien créer. Rend le motif du refus,
   * ou le lot et ses dépendances normalisées.
   *
   * `add` l'appelle DEUX fois — avant et après l'attente de `branchTaken` : la
   * première passe rend le bon motif tout de suite (l'ordre de S-3), la seconde
   * est celle qui écrit.
   */
  function lotForAdd(slug: string, depsRaw: string[]): { lot: Lot; deps: string[] } | string {
    const existing = read();
    if (existing && existing.owner.pid !== process.pid) {
      if (pidAlive(existing.owner.pid)) return foreignOwnerReason(existing.owner.pid);
      const refusal = save(existing);
      if (refusal) return refusal;
      start();
    }
    const lot = !existing || (existing.features.length > 0 && lotTotals(existing).live === 0) ? freshLot() : existing;
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
    const sessionFile = launch.resume ? feature.sessionFile : null;
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
    });
    const abort = new AbortController();
    inFlight.set(feature.slug, abort);
    watched.set(feature.slug, "inflight");
    // Le hash du contrat est figé AVANT le lancement, et ÉCRIT avant lui (S-1) :
    // c'est le seul indice dont disposera un pilote qui reprend un run interrompu
    // pour juger si le maillon a travaillé. Les appelants ont déjà sauvegardé leur
    // état, donc cette écriture est la leur, augmentée du hash — la poser après
    // leur sauvegarde (comme avant) la laissait en mémoire et jamais sur le disque.
    // `""` note « aucun contrat au démarrage », à distinguer de `null` : « aucun
    // run n'a été lancé pour cette feature » (bascule d'une collecte, S-14).
    feature.contractHash = contractHashOf(feature.worktree) ?? "";
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
        deps.run({ argv, cwd: feature.worktree, timeout: runTimeout, signal: abort.signal }),
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
    watched.set(slug, "settled");
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
    const outcome: ChainOutcome = result.code === 0 && !result.killed ? "ok" : "error";
    if (outcome === "ok") {
      // La session du run sert à répondre (AC-12) et à rejoindre la ligne.
      const session = latestSessionFile(stateDir, feature.worktree, startedAt);
      if (session) feature.sessionFile = session;
    }
    const routed = route(lot, feature, { outcome, stdout: result.stdout, reason: failureReason(result) });
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
    const action = nextChainAction({
      phase: feature.phase,
      outcome: result.outcome,
      contract,
      fixes: feature.fixes,
      reviewRuns: feature.reviewRuns,
      // Le plafond est celui FIGÉ dans le lot au premier lancement (S-5) : un
      // pilote qui reprend le lot avec un autre environnement ne doit pas
      // changer la borne en cours de route.
      cap: lot.reviewCap,
    });
    if (action.kind === "run") {
      feature.fixes += action.fix ? 1 : 0;
      feature.reviewRuns += action.phase === "review" ? 1 : 0;
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
    const created: Array<{ slug: string; result: { path: string; branch: string } | { error: string } }> = [];
    if (initial.status === "running") {
      for (const feature of initial.features) {
        if (feature.state !== "pending" || feature.worktree !== "" || !runnable(initial, feature)) continue;
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
        created.push({
          slug: feature.slug,
          result: made.ok ? { path: made.path, branch: made.branch } : { error: made.error },
        });
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
        if ("path" in item.result) orphans.push(item.result.path);
        continue;
      }
      if ("error" in item.result) {
        settle(lot, feature, "failed", item.result.error);
      } else {
        feature.worktree = item.result.path;
        feature.branch = item.result.branch;
      }
      changed = true;
    }

    // 1. Les features en cours sans run suivi : un maillon jamais lancé (bascule
    // d'une collecte en session, pilote repris) démarre ici ; un run interrompu se
    // juge sur le contrat (modifié = le maillon a travaillé).
    for (const feature of lot.features) {
      if (feature.state !== "running" || inFlight.has(feature.slug)) continue;
      if (feature.origin === "session" && feature.phase === "req") continue; // collecte en session
      if (feature.worktree === "") continue;
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

    // 2. Les dépendances fautives bloquent leurs dépendantes (AC-17).
    for (const feature of lot.features) {
      if (feature.state !== "pending") continue;
      const reason = dependencyBlock(lot, feature);
      if (reason) {
        settle(lot, feature, "blocked", reason);
        changed = true;
      }
    }

    // 3. Les features runnables démarrent, toutes dans la même passe (AC-18).
    for (const feature of lot.features) {
      if (lot.status !== "running" || feature.state !== "pending") continue;
      if (!runnable(lot, feature) || feature.worktree === "") continue;
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
    if (!lot || lot.status !== "running" || lotTotals(lot).live === 0) return false;
    if (lot.owner.pid === process.pid || pidAlive(lot.owner.pid)) return false;
    if (save(lot) !== null) return false;
    notify(`[pipeline] lot ${repo} repris par cette session (pilote précédent disparu)`);
    return true;
  }

  /**
   * Une action du panneau qui démarre un run : l'état change, puis le run part.
   * Rend le motif du refus quand le lot n'a pas pu être écrit (rien ne partirait).
   */
  function startPlanned(lot: Lot, feature: LotFeature, launch: PlannedLaunch): string | null {
    feature.phase = launch.phase;
    feature.state = "running";
    feature.waitKind = null;
    feature.waitPrompt = null;
    feature.stopReason = null;
    feature.endedAt = null;
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
      if (pidAlive(lot.owner.pid)) return foreignOwnerReason(lot.owner.pid);
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

    enrol(input) {
      const existing = read();
      // Un lot conduit par une session VIVANTE n'est jamais réécrit (S-1,
      // invariant 2) : ce `/req` n'y inscrit rien — sa feature garde la chaîne
      // manuelle (S-14), et le lot de l'autre session est intact. Un pilote MORT,
      // lui, se reprend : c'est la seule reprise admise.
      if (existing && existing.owner.pid !== process.pid) {
        if (pidAlive(existing.owner.pid)) {
          reportForeignOwner(existing.owner.pid);
          return foreignOwnerReason(existing.owner.pid);
        }
        const taken = save(existing);
        if (taken) return taken;
        start();
      }
      const lot =
        !existing || (existing.features.length > 0 && lotTotals(existing).live === 0) ? freshLot() : existing;
      if (lotFeature(lot, input.slug)) return null;
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
        contractHash: null,
        addedAt: at,
        sinceAt: at,
        updatedAt: at,
        endedAt: null,
      });
      if (lot.status === "draft") {
        lot.status = "running";
        lot.launchedAt = at;
        lot.reviewCap = cap;
      }
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
        return `la branche ${branch} existe déjà — choisis un autre nom`;
      }
      // `branchTaken` a ATTENDU : le lot est donc relu ici, et l'ajout s'écrit
      // dans la foulée sans aucun `await` (S-1). Écrire le lot lu avant l'attente
      // écraserait une transition tombée entre-temps (AC-2 : les pipelines en
      // cours ne bougent pas).
      const opened = lotForAdd(slug, input.deps);
      if (typeof opened === "string") return opened;
      const { lot, deps: depsSlugs } = opened;
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
        contractHash: null,
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
      if (lot.status === "draft") {
        lot.status = "running";
        lot.launchedAt = now();
        lot.reviewCap = cap;
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
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      const trimmed = text.trim();
      if (trimmed === "") return "réponse vide";
      const reply = rowReply(feature, liveWriterOf(feature));
      if (reply.kind === "closed") return reply.reason;
      if (reply.kind === "steer") {
        // Le run vit : le texte entre dans SON tour, aucun run n'est lancé et le
        // lot n'est pas écrit — il n'y a rien à décider (S-6).
        try {
          writeDelivery(reply.inbox, {
            version: 1,
            kind: "text",
            text: trimmed.slice(0, LOT_EDITOR_MAX),
            sentAt: now(),
          });
          return null;
        } catch (err) {
          return `écriture impossible : ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (reply.kind === "ask") {
        return "le maillon attend une réponse à sa question : choisis une option dans sa conversation";
      }
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
      if (feature.state !== "blocked" && feature.state !== "failed") {
        return "relance possible sur une feature bloquée ou échouée";
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
      if (target.state !== "blocked" && target.state !== "failed") {
        return "relance possible sur une feature bloquée ou échouée";
      }
      // Le worktree préparé est un fait du DISQUE : il se consigne même si la
      // feature a bougé entre-temps — c'est le chemin qu'un run utiliserait.
      target.worktree = prepared;
      target.branch = preparedBranch;
      // Le plafond est une borne par tentative : relancer ouvre un nouveau crédit.
      target.fixes = 0;
      target.reviewRuns = 0;
      const fix = target.phase === "impl" && reviewVerdict(readContractText(target.worktree)) === "blockers";
      return startPlanned(fresh, target, { slug, phase: target.phase, fix, kind: "relaunch", resume: false });
    },

    async cancel(slug, fate) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { feature } = opened;
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      if (lotStateTerminal(feature.state)) return `annulation impossible : la feature est ${lotStateLabel(feature.state)}`;
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
        if (lotStateTerminal(target.state)) {
          return `annulation impossible : la feature est ${lotStateLabel(target.state)}`;
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
