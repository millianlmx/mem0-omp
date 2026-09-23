// Publication de l'état d'un process : armement, battement, clôture.
import * as path from "node:path";
import type { PipelinePhase } from "./contract.ts";
import { armPhase, stateOfCwd, states } from "./state.ts";
import { runState } from "./runState.ts";
import { PIPELINE_HEARTBEAT_MS, asStringOrNull, deleteRunningEntry, historyIdFor, pipelineLabel, pipelineStateDir, runningIdFor, writeHistoryEntry, writeRunningEntry } from "./store.ts";
import type { HistoryEntry, PipelineCtx, PipelineFinalState, PipelineRunState, RunningEntry } from "./store.ts";



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

export let heartbeatStop: (() => void) | null = null;


// La boîte armée et la question en vol de ce process vivent dans `runState`
// (partagé par `globalThis`, cf. `runState.ts`) : un process qui charge
// l'extension deux fois n'a qu'une seule pompe et une seule question publiée.


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
    sessionFile: same ? (sessionFileOf(ctx) ?? previous?.sessionFile ?? null) : (previous?.sessionFile ?? null),
    sessionId: same ? (sessionIdOf(ctx) ?? previous?.sessionId ?? null) : (previous?.sessionId ?? null),
    owner: { pid: process.pid },
    // La boîte et la question en vol décrivent CE process : elles ne se reprennent
    // pas de l'entrée précédente (une boîte n'est armée qu'au démarrage, et une
    // question ne survit pas à la fin de son appel).
    inbox: runState.inbox,
    pendingAsk: runState.pendingAsk,
  };
  st.entry = entry;
  try {
    writeRunningEntry(deps.stateDir ?? pipelineStateDir(), entry);
  } catch (err) {
    reportStateWriteFailure(deps, err);
  }
}


/** Republie l'entrée du cwd courant, s'il est armé : le chemin des six événements. */
export function publishCurrentCwd(deps: PublishDeps): void {
  // Une publication est un effet de bord : elle ne doit jamais faire échouer le
  // tour qui l'a déclenchée, quelle que soit la panne.
  try {
    const ctx = deps.ctx;
    if (!ctx?.cwd) return;
    liveCtx = ctx;
    publishRunning(deps, ctx.cwd);
  } catch (err) {
    reportStateWriteFailure(deps, err);
  }
}


/**
 * Un seul intervalle de battement par processus : réarmer REMPLACE le précédent.
 * Réarmé à chaque armement parce qu'un changement de session (newSession) nettoie
 * les minuteries gérées de la session quittée.
 */
export function ensureHeartbeat(ctx: PipelineCtx | undefined, deps: Omit<PublishDeps, "ctx"> = {}): void {
  if (typeof ctx?.setInterval !== "function") return;
  if (ctx) liveCtx = ctx;
  heartbeatStop?.();
  const timer = ctx.setInterval(() => {
    for (const cwd of armedCwds()) publishRunning({ ...deps, ctx: liveCtx }, cwd);
  }, PIPELINE_HEARTBEAT_MS);
  heartbeatStop = () => {
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
