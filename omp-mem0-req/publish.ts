// Publication de l'état d'un process : armement, battement, clôture.
import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelinePhase } from "./contract.ts";
import { armPhase, stateOfCwd, states } from "./state.ts";
import { runState } from "./runState.ts";
import { PIPELINE_HEARTBEAT_MS, asRunningEntry, asStringOrNull, deleteRunningEntry, historyIdFor, pipelineLabel, pipelineRunningDir, pipelineStateDir, readJsonFile, runningIdFor, writeHistoryEntry, writeRunningEntry } from "./store.ts";
import type { HistoryEntry, PanelAskOption, PipelineCtx, PipelineFinalState, PipelineRunState, RunningEntry } from "./store.ts";



// --- côté propriétaire : armement, battement, publication -------------------

/** Horloge et sorties injectables : les tests pilotent le temps et les notices. */
export type PublishDeps = {
  ctx?: PipelineCtx;
  notify?: (text: string) => void;
  now?: () => number;
  stateDir?: string;
};


// Compteurs d'activité par identifiant d'appel d'outil : incrémentés et
// décrémentés, jamais posés à zéro sur un événement — un `tool_execution_end`
// manquant (processus tué, tour interrompu) ne doit pas figer l'état.
export const pendingAsks = new Set<string>();

export const pendingApprovals = new Set<string>();


// Dernier contexte vu pour ce processus : source de `isIdle` (délégué au runner,
// donc vivant) et de la session publiée. Le battement n'en a pas d'autre.
export let liveCtx: PipelineCtx | undefined;

export let stateWriteWarned = false;


// La boîte armée, la question en vol ET le battement de ce process vivent dans
// `runState` (partagé par `globalThis`, cf. `runState.ts`) : un process qui charge
// l'extension deux fois n'a qu'une seule pompe, une seule question publiée et une
// seule minuterie de battement.


// Le verdict « session de sous-agent » par fichier de session : le lire à chaque
// publication ferait un `open` par événement d'outil, alors que l'en-tête d'un
// fichier de session ne change plus après sa création. Seuls les verdicts d'un
// fichier LISIBLE sont mémoïsés : un fichier pas encore écrit doit pouvoir être
// jugé au tour suivant.
const subagentVerdicts = new Map<string, boolean>();

/** Assez pour la ligne 1 (créneau de titre, 256 o) et l'en-tête de session. */
const SESSION_HEADER_READ_BYTES = 8192;


/** `true`/`false` : verdict ; `null` : fichier absent ou illisible (on ne conclut pas). */
function headerHasParentSession(file: string): boolean | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(SESSION_HEADER_READ_BYTES);
    const read = fs.readSync(fd, buffer, 0, SESSION_HEADER_READ_BYTES, 0);
    if (read <= 0) return null;
    for (const line of buffer.toString("utf8", 0, read).split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // ligne partielle (fenêtre de lecture, écriture en cours)
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const entry = parsed as Record<string, unknown>;
      // La ligne `type: "session"` est l'en-tête : c'est elle qui porte
      // `parentSession` (le fichier ou l'id de la session dont celle-ci dérive).
      if (entry.type !== "session") continue;
      return typeof entry.parentSession === "string" && entry.parentSession !== "";
    }
    return false;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* descripteur déjà fermé : rien à faire */
    }
  }
}


/**
 * Le fichier de session appartient-il à un SOUS-AGENT (`task`) ? Un sous-agent
 * rebinde la fabrique de l'extension dans le MÊME process et reçoit son propre
 * `session_start` : sans ce test, il volerait le battement de son parent (sa
 * minuterie est nettoyée à sa fin), publierait SA session dans l'entrée du
 * worktree — le cwd est le même — et l'utilisateur rejoindrait sa transcription
 * au lieu de celle du maillon (S-6, AC-19).
 *
 * Le format le dit : l'en-tête d'une session dérivée (sous-agent, fork) porte
 * `parentSession`. `null` (session inconnue) n'est jamais un sous-agent.
 */
export function isSubagentSession(file: string | null): boolean {
  if (file === null || file === "") return false;
  const known = subagentVerdicts.get(file);
  if (known !== undefined) return known;
  const verdict = headerHasParentSession(file);
  if (verdict === null) return false;
  subagentVerdicts.set(file, verdict);
  return verdict;
}


export function armedCwds(): string[] {
  const out: string[] = [];
  for (const [cwd, st] of states) {
    if (st.phase) out.push(cwd);
  }
  return out;
}


/**
 * Une écriture impossible (disque plein, permissions) ne casse JAMAIS un tour :
 * l'erreur est avalée et signalée au plus une fois par session, par une notice
 * durable — un toast disparaîtrait au redraw.
 */
export function reportStateWriteFailure(deps: PublishDeps, error: unknown): void {
  if (stateWriteWarned) return;
  stateWriteWarned = true;
  const reason = error instanceof Error ? error.message : String(error);
  deps.notify?.(`[pipeline] état des pipelines non écrit : ${reason}`);
}


/** La session de ce contexte conduit-elle bien ce cwd ? Sinon le fichier est nul. */
export function sessionMatches(ctx: PipelineCtx | undefined, cwd: string): boolean {
  const manager = ctx?.sessionManager;
  if (typeof manager?.getCwd !== "function") return false;
  try {
    // Appelée SUR le manager, jamais via une variable intermédiaire : `getCwd`
    // lit `this.#cwd`, et un receveur perdu lève un TypeError qu'on lirait à tort
    // comme « pas la bonne session » — donc comme une entrée sans fichier.
    return path.resolve(manager.getCwd() ?? "") === path.resolve(cwd);
  } catch {
    return false;
  }
}


export function sessionFileOf(ctx: PipelineCtx | undefined): string | null {
  try {
    return asStringOrNull(ctx?.sessionManager?.getSessionFile?.());
  } catch {
    return null;
  }
}


export function sessionIdOf(ctx: PipelineCtx | undefined): string | null {
  try {
    return asStringOrNull(ctx?.sessionManager?.getSessionId?.());
  } catch {
    return null;
  }
}


/**
 * État publié d'une pipeline : `waiting` si une question `ask` est en vol, si une
 * approbation est en attente, si l'agent est inactif, ou si la session courante
 * ne conduit pas ce cwd (cette pipeline n'est alors plus pilotée par personne) ;
 * `running` sinon.
 */
export function currentRunState(ctx: PipelineCtx | undefined, cwd: string): PipelineRunState {
  if (pendingAsks.size > 0 || pendingApprovals.size > 0) return "waiting";
  if (ctx?.cwd && path.resolve(ctx.cwd) !== path.resolve(cwd)) return "waiting";
  try {
    if (ctx?.isIdle?.() === true) return "waiting";
  } catch {
    /* contexte sans isIdle : on suppose l'agent actif */
  }
  return "running";
}


/**
 * Publie (ou republie) l'entrée en cours d'un cwd ARMÉ : phase courante, horodatage
 * de l'étape, état, session. Aucun effet si ce cwd n'est pas armé par ce processus —
 * le propriétaire ne réécrit que SES entrées.
 */
export function publishRunning(deps: PublishDeps, cwd: string): void {
  const st = states.get(path.resolve(cwd));
  if (!st?.phase) return;
  const ctx = deps.ctx ?? liveCtx;
  // Un sous-agent publie SON contexte sur le MÊME cwd : sa session prendrait la
  // place de celle du maillon dans l'entrée (le cwd ne les distingue pas), et
  // l'utilisateur rejoindrait sa transcription. Il n'écrit rien.
  if (isSubagentSession(sessionFileOf(ctx))) return;
  const now = (deps.now ?? Date.now)();
  const previous = st.entry;
  const same = sessionMatches(ctx, cwd);
  const entry: RunningEntry = {
    id: runningIdFor(cwd),
    cwd: path.resolve(cwd),
    label: previous?.label ?? pipelineLabel(cwd),
    phase: st.phase,
    state: currentRunState(ctx, cwd),
    phaseStartedAt: st.phaseStartedAt ?? previous?.phaseStartedAt ?? now,
    updatedAt: now,
    // La session publiée n'est retenue que si le contexte appartient bien à ce
    // cwd : après un `newSession`, le contexte du handler décrit encore la
    // session PRÉCÉDENTE, et publier son fichier ferait rejoindre la mauvaise.
    // Faute de mieux, la session du PREMIER contexte armé fait foi : c'est elle
    // que le pilote a lancée, et un contexte étranger ne doit pas la remplacer.
    sessionFile: same
      ? (sessionFileOf(ctx) ?? previous?.sessionFile ?? runState.sessionFile ?? null)
      : (previous?.sessionFile ?? runState.sessionFile ?? null),
    sessionId: same ? (sessionIdOf(ctx) ?? previous?.sessionId ?? null) : (previous?.sessionId ?? null),
    owner: { pid: process.pid },
    // La boîte et la question en vol décrivent CE process : elles ne se reprennent
    // pas de l'entrée précédente (une boîte n'est armée qu'au démarrage, et une
    // question ne survit pas à la fin de son appel).
    inbox: runState.inbox,
    pendingAsk: runState.pendingAsk,
  };
  st.entry = entry;
  const stateDir = deps.stateDir ?? pipelineStateDir();
  // Republication IDEMPOTENTE (S-6) : le battement republie la même entrée toutes
  // les 2 s, et une réponse `ask` la republie sans que rien d'autre n'ait bougé —
  // la réécrire remplacerait le fichier sous les yeux du panneau (mtime, rang qui
  // clignote) sans rien apprendre à personne. Seul `updatedAt` bouge à vide : il
  // est donc exclu de la comparaison, et l'entrée du DISQUE fait foi (un autre
  // pid, une autre session ou une question différente forcent l'écriture).
  if (samePublished(asRunningEntry(readJsonFile(path.join(pipelineRunningDir(stateDir), `${entry.id}.json`))), entry)) {
    return;
  }
  try {
    writeRunningEntry(stateDir, entry);
  } catch (err) {
    reportStateWriteFailure(deps, err);
  }
}


/**
 * Deux entrées publiées disent-elles la même chose ? Tout compte sauf `updatedAt`
 * (l'horodatage du battement) : le propriétaire, la session, la boîte et la
 * question complète — une question dont les options changent est un changement.
 */
function samePublished(onDisk: RunningEntry | null, next: RunningEntry): boolean {
  if (!onDisk) return false;
  if (
    onDisk.id !== next.id ||
    onDisk.cwd !== next.cwd ||
    onDisk.label !== next.label ||
    onDisk.phase !== next.phase ||
    onDisk.state !== next.state ||
    onDisk.phaseStartedAt !== next.phaseStartedAt ||
    onDisk.sessionFile !== next.sessionFile ||
    onDisk.sessionId !== next.sessionId ||
    onDisk.owner.pid !== next.owner.pid ||
    (onDisk.inbox ?? null) !== (next.inbox ?? null)
  ) {
    return false;
  }
  const was = onDisk.pendingAsk ?? null;
  const is = next.pendingAsk ?? null;
  if (was === null || is === null) return was === is;
  if (was.toolCallId !== is.toolCallId || was.id !== is.id || was.question !== is.question) return false;
  if (was.options.length !== is.options.length) return false;
  return was.options.every((option, index) => {
    const other = is.options[index] as PanelAskOption;
    return option.label === other.label && (option.description ?? "") === (other.description ?? "");
  });
}


/** Republie l'entrée du cwd courant, s'il est armé : le chemin des six événements. */
export function publishCurrentCwd(deps: PublishDeps): void {
  // Une publication est un effet de bord : elle ne doit jamais faire échouer le
  // tour qui l'a déclenchée, quelle que soit la panne.
  try {
    const ctx = deps.ctx;
    if (!ctx?.cwd) return;
    // Un sous-agent (`task`) émet les MÊMES événements d'outils dans ce process :
    // prendre son contexte comme « dernier contexte vu » ferait publier sa session
    // pour le cwd du maillon, et les pilotes liraient sa transcription.
    if (isSubagentSession(sessionFileOf(ctx))) return;
    liveCtx = ctx;
    publishRunning(deps, ctx.cwd);
  } catch (err) {
    reportStateWriteFailure(deps, err);
  }
}


/**
 * Un seul intervalle de battement par processus : réarmer REMPLACE le précédent.
 * Réarmé à chaque armement parce qu'un changement de session (newSession) nettoie
 * les minuteries gérées de la session quittée. Le battement vit dans `runState`
 * (partagé par `globalThis`) : une seconde instance de l'extension dans le même
 * process ne clone pas de minuterie, elle remplace la même.
 */
export function ensureHeartbeat(ctx: PipelineCtx | undefined, deps: Omit<PublishDeps, "ctx"> = {}): void {
  if (typeof ctx?.setInterval !== "function") return;
  // Un sous-agent rebinde la fabrique dans le même process : son battement
  // remplacerait celui de son parent et mourrait avec lui — le maillon
  // n'apparaîtrait plus comme en cours pour le reste de son tour. Il ne bat pas,
  // et ne devient pas non plus le « dernier contexte vu ».
  if (isSubagentSession(sessionFileOf(ctx))) return;
  if (ctx) liveCtx = ctx;
  runState.heartbeatStop?.();
  const timer = ctx.setInterval(() => {
    for (const cwd of armedCwds()) publishRunning({ ...deps, ctx: liveCtx }, cwd);
  }, PIPELINE_HEARTBEAT_MS);
  runState.heartbeatStop = () => {
    try {
      ctx.clearTimer?.(timer);
    } catch {
      /* minuterie déjà nettoyée par la session : rien à faire */
    }
  };
}


/** Repart à zéro à chaque session : « signalée au plus une fois par session ». */
export function resetStateWriteWarning(): void {
  stateWriteWarned = false;
}


/**
 * Arme un maillon ET le publie : l'entrée apparaît dès la commande, avant toute
 * réponse du modèle (S-3). Remplace `armPhase` partout où un contexte est
 * disponible ; un nouveau maillon réinitialise le temps de l'étape.
 */
export function armPipeline(deps: PublishDeps, cwd: string | undefined, phase: PipelinePhase): void {
  if (!cwd) return;
  armPhase(cwd, phase);
  const st = stateOfCwd(cwd);
  st.phaseStartedAt = (deps.now ?? Date.now)();
  st.entry = undefined;
  // La session du PREMIER contexte armé est retenue : c'est elle que l'entrée
  // publie à défaut de contexte utilisable, et un sous-agent du même process —
  // dont le `session_start` est écarté avant d'arriver ici — ne peut donc pas la
  // remplacer (S-6).
  if (runState.sessionFile === null) {
    const file = sessionFileOf(deps.ctx);
    if (!isSubagentSession(file)) runState.sessionFile = file;
  }
  // Aucun réarmement ici : la notice « état non écrit » vaut AU PLUS UNE FOIS PAR
  // SESSION, et la seule frontière de session est le hook `session_start`. Réarmer
  // à chaque maillon la republiait une fois par maillon.
  ensureHeartbeat(deps.ctx, { notify: deps.notify, stateDir: deps.stateDir });
  publishRunning(deps, cwd);
}


/**
 * Clôt une pipeline : l'historique est écrit PUIS le fichier en cours supprimé,
 * jamais l'inverse — une écriture impossible laisse l'entrée en cours, et l'appel
 * remonte l'erreur à son appelant (qui la signale au plus une fois).
 */
export function closePipeline(deps: PublishDeps, cwd: string, finalState: PipelineFinalState): void {
  // La fin d'un SOUS-AGENT (`task`) n'est pas la fin du maillon : son
  // `session_stop` arrive dans le même process, avec le cwd du worktree. Clore ici
  // écrirait une entrée d'historique par sous-agent et supprimerait l'entrée du
  // run encore vivant — la ligne « terminé » en double que le panneau montrait.
  if (isSubagentSession(sessionFileOf(deps.ctx))) return;
  const st = states.get(path.resolve(cwd));
  const now = (deps.now ?? Date.now)();
  const previous = st?.entry;
  // `endedAt` figé pour un échec (dernier battement), instant de clôture pour une
  // fin de cycle : deux lecteurs qui constatent la même mort écrivent le même id.
  const endedAt = finalState === "failed" ? (previous?.updatedAt ?? now) : now;
  const record: HistoryEntry = {
    id: historyIdFor(cwd, endedAt),
    cwd: path.resolve(cwd),
    label: previous?.label ?? pipelineLabel(cwd),
    phase: st?.phase ?? previous?.phase ?? "req",
    finalState,
    sessionFile: previous?.sessionFile ?? null,
    sessionId: previous?.sessionId ?? null,
    phaseStartedAt: st?.phaseStartedAt ?? previous?.phaseStartedAt ?? now,
    endedAt,
  };
  const stateDir = deps.stateDir ?? pipelineStateDir();
  writeHistoryEntry(stateDir, record);
  deleteRunningEntry(stateDir, runningIdFor(cwd));
  if (st) {
    st.phase = undefined;
    st.entry = undefined;
    st.phaseStartedAt = undefined;
  }
}
