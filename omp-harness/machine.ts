// La machine à états d'un run : req → specs → impl → review ⇄ fix, puis merge ou l'humain.
//
// Fonction PURE : elle ne lance rien, ne lit rien. L'orchestrateur lui donne l'issue
// d'une étape et applique la transition rendue. `keepRunner` dit si le runner de
// l'étape reste vivant pour la suivante — seule la boucle review ⇄ fix le garde
// (cache de prompt) ; partout ailleurs il meurt à la fin de l'étape ou à l'escalade.
import type { Tier } from "./config.ts";
import type { MergeDecision } from "./verdict.ts";


export type StepKind = "req" | "specs" | "impl" | "review" | "fix";

export type RunState =
  | "queued"
  | "running"
  | "escalated"
  | "awaiting_human"
  | "merging"
  | "merged"
  | "failed"
  | "cancelled";

export const STEP_KINDS: readonly StepKind[] = ["req", "specs", "impl", "review", "fix"];

/**
 * Le tier de modèle d'une étape, d'après la configuration : la dernière correction
 * autorisée (et toute correction demandée au-delà du plafond) passe en heavy — un
 * modèle moyen qui n'a pas su corriger ne réessaie pas une fois de plus.
 */
export function stepTier(tiers: Record<StepKind, Tier>, step: StepKind, fixes: number, fixCap: number): Tier {
  if (step === "fix" && fixes >= fixCap) return "heavy";
  return tiers[step];
}

/** Les états où un run occupe encore son worktree et ses modules (planificateur). */
export const ACTIVE_STATES: readonly RunState[] = ["running", "escalated", "awaiting_human", "merging"];

export const TERMINAL_STATES: readonly RunState[] = ["merged", "failed", "cancelled"];


export type StepOutcome =
  /** L'étape a rendu ce qu'elle devait ; `escalations` = escalades ouvertes en fin d'étape. */
  | { kind: "done"; escalations: number; merge?: MergeDecision; blockers?: number }
  | { kind: "failed"; reason: string; retryable: boolean };

export type Transition = {
  state: RunState;
  step: StepKind | null;
  fixes: number;
  attempts: number;
  keepRunner: boolean;
  /** Le rebase sur `main` est dû avant l'étape suivante (entrée en review). */
  rebase: boolean;
  reason: string;
};

/** `specsGate` : après /specs, la feature attend l'accord humain avant /impl. */
export type Limits = { fixCap: number; stepRetries: number; specsGate: boolean };

export type RunCursor = { step: StepKind; fixes: number; attempts: number };


const NEXT: Record<"req" | "specs" | "impl", StepKind> = { req: "specs", specs: "impl", impl: "review" };


function to(state: RunState, step: StepKind | null, cursor: RunCursor, patch: Partial<Transition> & { reason: string }): Transition {
  return { state, step, fixes: cursor.fixes, attempts: 0, keepRunner: false, rebase: false, ...patch };
}


/** La transition qui suit l'issue d'une étape. */
export function nextAfter(cursor: RunCursor, outcome: StepOutcome, limits: Limits): Transition {
  const step = cursor.step;
  if (outcome.kind === "failed") {
    if (outcome.retryable && cursor.attempts < limits.stepRetries) {
      return to("running", step, cursor, { attempts: cursor.attempts + 1, reason: `relance de /${step} : ${outcome.reason}` });
    }
    return to("failed", step, cursor, { attempts: cursor.attempts, reason: `/${step} a échoué : ${outcome.reason}` });
  }

  // Les escalades d'une étape sont BATCHÉES : elles partent toutes ensemble, en fin
  // d'étape, et le runner meurt — la reprise se fera sur le checkpoint courant.
  if (outcome.escalations > 0) {
    return to("escalated", step, cursor, { reason: `${outcome.escalations} décision(s) irréversible(s) à trancher` });
  }

  switch (step) {
    case "req":
      return to("running", NEXT[step], cursor, { reason: "/req terminé" });
    case "specs":
      if (limits.specsGate) return to("awaiting_human", "specs", cursor, { reason: "specs à valider avant /impl" });
      return to("running", NEXT[step], cursor, { reason: "/specs terminé" });
    case "impl":
      return to("running", "review", cursor, { rebase: true, reason: "/impl terminé — rebase sur main avant /review" });
    case "fix":
      return to("running", "review", cursor, { keepRunner: true, reason: "/impl --fix terminé" });
    case "review": {
      const blockers = outcome.blockers ?? 0;
      if (blockers > 0) {
        if (cursor.fixes < limits.fixCap) {
          return to("running", "fix", cursor, {
            fixes: cursor.fixes + 1,
            keepRunner: true,
            reason: `${blockers} bloquant(s) — correction ${cursor.fixes + 1}/${limits.fixCap}`,
          });
        }
        return to("awaiting_human", null, cursor, { reason: `plafond de corrections atteint (${limits.fixCap}) avec ${blockers} bloquant(s)` });
      }
      const merge = outcome.merge;
      if (merge && merge.auto) return to("merging", null, cursor, { reason: "verdict bas risque et tests verts — auto-merge" });
      return to("awaiting_human", null, cursor, {
        reason: merge && !merge.auto ? `validation humaine : ${merge.reasons.join(" ; ")}` : "validation humaine requise",
      });
    }
  }
}


/** La reprise d'un run escaladé, une fois TOUTES ses escalades répondues : même étape, nouveau runner. */
export function resumeAfterEscalations(cursor: RunCursor): Transition {
  return to("queued", cursor.step, cursor, { reason: "escalades répondues — reprise de l'étape" });
}


/** Le renversement d'une décision : reprise à l'étape du checkpoint, nouveau runner. */
export function resumeAtCheckpoint(cursor: RunCursor, step: StepKind, seq: number): Transition {
  return to("queued", step, cursor, { reason: `décision ${seq} renversée — reprise au checkpoint ${seq}` });
}


/** Le renversement d'une décision dont rien ne dépend : l'étape reprend sur l'état courant, sans retour arrière. */
export function reworkAfterReversal(cursor: RunCursor, step: StepKind, seq: number): Transition {
  return to("queued", step, cursor, { reason: `décision ${seq} renversée — correction sur l'état courant` });
}


/** La validation humaine d'un verdict : accepter → merge, refuser → une correction (hors plafond). */
export function afterHumanValidation(cursor: RunCursor, approve: boolean, reason: string): Transition {
  if (approve) return to("merging", null, cursor, { reason: reason || "validé par l'humain" });
  return to("queued", "fix", cursor, { fixes: cursor.fixes + 1, reason: `refusé par l'humain : ${reason}` });
}


/** La validation humaine des specs : accepter → /impl, refuser → /specs refait avec la raison. */
export function afterSpecsValidation(cursor: RunCursor, approve: boolean, reason: string): Transition {
  if (approve) return to("queued", "impl", cursor, { reason: reason || "specs validées par l'humain" });
  return to("queued", "specs", cursor, { reason: `specs refusées par l'humain : ${reason}` });
}


/** Un état d'où le run peut encore bouger. */
export function isTerminal(state: RunState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}


// -- merge, annulation, reprise, panne -----------------------------------------
//
// Ces issues ne suivent pas une étape, mais elles passent par la même table : le
// service n'écrit jamais un état à la main.

/**
 * Les transitions permises : état courant → états suivants. Toute écriture d'état
 * du service passe par `assertTransition` ; une transition absente d'ici est un bug.
 */
export const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["queued", "running", "cancelled", "failed"],
  running: ["running", "queued", "escalated", "awaiting_human", "merging", "failed", "cancelled"],
  escalated: ["queued", "cancelled", "failed"],
  awaiting_human: ["queued", "merging", "cancelled", "failed"],
  merging: ["merged", "queued", "awaiting_human", "failed"],
  merged: [],
  // Un run échoué peut être rouvert (décision renversée) ou annulé.
  failed: ["queued", "cancelled"],
  cancelled: [],
};

/** Les états d'où l'humain peut annuler (un merge en cours ne s'interrompt pas). */
export const CANCELLABLE: readonly RunState[] = ["queued", "running", "escalated", "awaiting_human", "failed"];


export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}


/** Lève si l'une des transitions `from → to` n'est pas dans la table. */
export function assertTransition(from: readonly RunState[], to: RunState): void {
  const illegal = from.filter(state => !canTransition(state, to));
  if (illegal.length > 0) throw new Error(`transition interdite : ${illegal.join(", ")} → ${to}`);
}


/**
 * Le merge s'arrête (conflit avec main, suite rouge après rebase) : retour en revue
 * ou en correction, une correction de plus au compteur ; au plafond, l'humain.
 */
export function afterMergeStopped(cursor: Pick<RunCursor, "fixes">, step: "fix" | "review", reason: string, fixCap: number): Transition {
  const at = { step, fixes: cursor.fixes, attempts: 0 };
  if (cursor.fixes >= fixCap) return to("awaiting_human", null, at, { reason: `${reason} — plafond de corrections atteint` });
  return to("queued", step, at, { fixes: cursor.fixes + 1, reason });
}


/** Le merge est fait dans git : l'état suit, toujours. */
export function afterMerged(cursor: Pick<RunCursor, "fixes">): Transition {
  return to("merged", null, { step: "review", fixes: cursor.fixes, attempts: 0 }, { reason: "mergé" });
}


/** Un merge impossible (push refusé par gh, erreur git) : l'humain reprend la main. */
export function afterMergeFailed(cursor: Pick<RunCursor, "fixes">, reason: string): Transition {
  return to("awaiting_human", null, { step: "review", fixes: cursor.fixes, attempts: 0 }, { reason: `merge impossible : ${reason}` });
}


/** L'annulation par l'humain : l'étape courante est gardée pour l'historique. */
export function cancelled(cursor: RunCursor | { step: StepKind | null; fixes: number; attempts: number }): Transition {
  return { state: "cancelled", step: cursor.step, fixes: cursor.fixes, attempts: cursor.attempts, keepRunner: false, rebase: false, reason: "annulé par l'humain" };
}


/** Une panne qui empêche le run d'avancer (worktree perdu, erreur du service). */
export function crashed(cursor: { step: StepKind | null; fixes: number; attempts: number }, reason: string): Transition {
  return { state: "failed", step: cursor.step, fixes: cursor.fixes, attempts: cursor.attempts, keepRunner: false, rebase: false, reason };
}


/** Le service a redémarré pendant l'étape : elle repart de son dernier checkpoint, nouveau runner. */
export function recovered(cursor: RunCursor): Transition {
  return to("queued", cursor.step, cursor, { attempts: cursor.attempts, reason: "service redémarré — reprise au dernier checkpoint" });
}
