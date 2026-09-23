// État de session par cwd : le maillon armé, la collecte en cours.
import * as path from "node:path";
import type { PipelinePhase } from "./contract.ts";
import type { RunningEntry } from "./store.ts";



// ---------------------------------------------------------------------------
// State — CWD-keyed, PAS session-keyed
// ---------------------------------------------------------------------------
// /req remplace la session en cours (newSession + moveTo) pour l'installer dans
// le worktree de la feature : une clé par session perdrait la collecte au moment
// même où elle s'arme. Le cwd est l'identité stable — c'est le worktree de la
// feature, et c'est lui qui porte le contrat.

export type ReqState = {
  reqMode: boolean;
  /** Maillon du pipeline ARMÉ pour ce cwd — absent hors pipeline. */
  phase?: PipelinePhase;
  /** /req : l'utilisateur a dit « fin » — le maillon peut se clore. */
  closing?: boolean;
  /** La suite de ce maillon a déjà été annoncée : une seule annonce par maillon. */
  announced?: boolean;
  /** Instant du lancement du maillon courant : le temps affiché repart de là. */
  phaseStartedAt?: number;
  /** Dernière entrée publiée dans le magasin — la session publiée vient d'elle. */
  entry?: RunningEntry;
};


export const states = new Map<string, ReqState>();


export function stateOfCwd(cwd: string | undefined): ReqState {
  const key = cwd ? path.resolve(cwd) : "session";
  let st = states.get(key);
  if (!st) {
    st = { reqMode: false };
    states.set(key, st);
  }
  return st;
}


/**
 * Arme un maillon : à sa prochaine retombée terminale, la suite sera annoncée.
 * À appeler APRÈS la bascule de session et juste AVANT `sendUserMessage` — armé
 * plus tôt, l'annonce partirait sur la retombée du tour PRÉCÉDENT (l'utilisateur
 * lance /specs pendant que le tour de /req tourne encore).
 */
export function armPhase(cwd: string | undefined, phase: PipelinePhase): void {
  const st = stateOfCwd(cwd);
  st.phase = phase;
  st.closing = false; // le maillon qui s'arme n'a pas dit « fin »
  st.announced = false;
}
