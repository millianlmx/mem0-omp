// La machine à états d'un run : req → specs → impl → review ⇄ fix, puis merge ou l'humain.
//
// Fonction PURE : elle ne lance rien, ne lit rien. L'orchestrateur lui donne l'issue
// d'une étape et applique la transition rendue. `keepRunner` dit si le runner de
// l'étape reste vivant pour la suivante : req → specs (même rappel, même contexte) et
// review → fix (le correcteur connaît les bloquants) ; fix → review le tue (un
// arbitre ne relit pas sa propre correction) ; partout ailleurs il meurt à la fin de
// l'étape ou à l'escalade.
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

/** La cause d'un échec d'étape : décide de la relance, du backoff et du passage à l'humain. */
export type FailCause =
  | "timeout"
  | "rate_limit"
  | "server_error"
  | "network"
  | "provider"
  | "context"
  | "runner"
  | "missing_output"
  | "aborted"
  | "other";

export type StepOutcome =
  /**
   * L'étape a rendu ce qu'elle devait ; `escalations` = escalades ouvertes en fin
   * d'étape ; `gateNeeded` (specs) = la relecture humaine vaut la peine, `gateReasons`
   * dit pourquoi ; `criteriaMissing` (review) = critères d'acceptation sans verdict.
   */
  | {
      kind: "done";
      escalations: number;
      merge?: MergeDecision;
      blockers?: number;
      gateNeeded?: boolean;
      gateReasons?: string[];
      criteriaMissing?: string[];
    }
  | { kind: "failed"; reason: string; retryable: boolean; cause: FailCause };

export type Transition = {
  state: RunState;
  step: StepKind | null;
  fixes: number;
  attempts: number;
  keepRunner: boolean;
  /** Le rebase sur `main` est dû avant l'étape suivante (entrée en review). */
  rebase: boolean;
  /** Le run n'est pas admis avant cet instant (epoch ms) ; `null` : tout de suite. */
  notBefore: number | null;
  reason: string;
};

/**
 * `specsGate` : après /specs, la feature attend l'accord humain avant /impl (`"auto"` :
 * seulement si l'étape l'a jugé utile). `retryBackoffSec` : l'attente avant chaque
 * relance d'une étape échouée, et son nombre. `mergeRetries` : les merges arrêtés
 * tolérés avant l'humain.
 */
export type Limits = {
  fixCap: number;
  retryBackoffSec: number[];
  specsGate: boolean | "auto";
  mergeRetries: number;
};

/** `lastFailCause` : la cause du dernier échec de la même étape (deux de suite ⇒ l'humain). */
export type RunCursor = { step: StepKind; fixes: number; attempts: number; lastFailCause?: FailCause | null };

/** L'attente avant la relance d'un merge arrêté : 5, 15 puis 60 minutes. */
export const MERGE_BACKOFF_MS: readonly number[] = [300_000, 900_000, 3_600_000];

const NEXT: Record<"req" | "specs" | "impl", StepKind> = { req: "specs", specs: "impl", impl: "review" };

function to(
  state: RunState,
  step: StepKind | null,
  cursor: RunCursor,
  patch: Partial<Transition> & { reason: string },
): Transition {
  return {
    state,
    step,
    fixes: cursor.fixes,
    attempts: 0,
    keepRunner: false,
    rebase: false,
    notBefore: null,
    ...patch,
  };
}

/**
 * La transition qui suit l'issue d'une étape. `now` sert au backoff des relances ;
 * la fonction reste pure (l'instant lui est donné).
 */
export function nextAfter(cursor: RunCursor, outcome: StepOutcome, limits: Limits, now = 0): Transition {
  const step = cursor.step;
  if (outcome.kind === "failed") return afterFailure(cursor, outcome, limits, now);

  // Les escalades d'une étape sont BATCHÉES : elles partent toutes ensemble, en fin
  // d'étape, et le runner meurt — la reprise se fera sur le checkpoint courant.
  if (outcome.escalations > 0) {
    return to("escalated", step, cursor, { reason: `${outcome.escalations} décision(s) irréversible(s) à trancher` });
  }

  switch (step) {
    case "req":
      return to("running", NEXT[step], cursor, { keepRunner: true, reason: "/req terminé" });
    case "specs": {
      const gate = limits.specsGate === "auto" ? outcome.gateNeeded === true : limits.specsGate;
      if (gate) {
        return to("awaiting_human", "specs", cursor, {
          reason:
            limits.specsGate === "auto"
              ? (outcome.gateReasons ?? []).length > 0
                ? `specs à valider avant /impl : ${(outcome.gateReasons ?? []).join(" ; ")}`
                : "specs à valider avant /impl (découpage, modules ou geste irréversible)"
              : "specs à valider avant /impl",
        });
      }
      return to("running", NEXT[step], cursor, { reason: "/specs terminé" });
    }
    case "impl":
      return to("running", "review", cursor, { rebase: true, reason: "/impl terminé — rebase sur main avant /review" });
    case "fix":
      return to("running", "review", cursor, { keepRunner: false, reason: "/impl --fix terminé" });
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
        return to("awaiting_human", null, cursor, {
          reason: `plafond de corrections atteint (${limits.fixCap}) avec ${blockers} bloquant(s)`,
        });
      }
      const merge = outcome.merge;
      if (merge?.auto) return to("merging", null, cursor, { reason: "verdict bas risque et tests verts — auto-merge" });
      return to("awaiting_human", null, cursor, {
        reason:
          merge && !merge.auto ? `validation humaine : ${merge.reasons.join(" ; ")}` : "validation humaine requise",
      });
    }
  }
}

/**
 * Les causes qui se résolvent en attendant (quota, réseau, fournisseur, délai) : la
 * liste de backoff se consomme entière, même cause répétée comprise. Les autres
 * (contexte, runner, sortie manquante, inconnu) passent à l'humain dès qu'elles
 * frappent deux fois de suite.
 */
export const WAITABLE_CAUSES: readonly FailCause[] = ["rate_limit", "network", "provider", "server_error", "timeout"];

/**
 * L'issue d'une étape qui a échoué : relance différée (backoff) tant qu'il en reste ;
 * liste épuisée ⇒ l'humain (il peut relancer), jamais `failed`, réservé au non
 * relançable. Un correcteur qui ne change rien n'est pas une panne : il conteste, la
 * revue reprend.
 */
function afterFailure(
  cursor: RunCursor,
  outcome: Extract<StepOutcome, { kind: "failed" }>,
  limits: Limits,
  now: number,
): Transition {
  const step = cursor.step;
  if (step === "fix" && outcome.cause === "missing_output") {
    if (cursor.lastFailCause === "missing_output") {
      return to("awaiting_human", "fix", cursor, {
        reason: `le correcteur conteste les bloquants une seconde fois : ${outcome.reason}`,
      });
    }
    return to("running", "review", cursor, {
      keepRunner: false,
      reason: `le correcteur conteste les bloquants (${outcome.reason}) — nouvelle revue`,
    });
  }
  if (!outcome.retryable) {
    return to("failed", step, cursor, { attempts: cursor.attempts, reason: `/${step} a échoué : ${outcome.reason}` });
  }
  if (cursor.lastFailCause === outcome.cause && !WAITABLE_CAUSES.includes(outcome.cause)) {
    return to("awaiting_human", step, cursor, {
      attempts: cursor.attempts,
      reason: `/${step} a échoué deux fois de suite pour la même cause (${outcome.cause}) : ${outcome.reason}`,
    });
  }
  const backoffSec = limits.retryBackoffSec[cursor.attempts];
  if (backoffSec !== undefined) {
    return to("queued", step, cursor, {
      attempts: cursor.attempts + 1,
      notBefore: now + backoffSec * 1000,
      reason: `relance de /${step} dans ${backoffSec} s (${outcome.cause}) : ${outcome.reason}`,
    });
  }
  return to("awaiting_human", step, cursor, {
    attempts: cursor.attempts,
    reason: `/${step} a échoué ${limits.retryBackoffSec.length + 1} fois (${outcome.cause}), relances épuisées : ${outcome.reason}`,
  });
}

/**
 * Le plafond de coût atteint (`monitoring.pauseOnBudget`) : avant sa prochaine étape, la
 * feature attend l'humain, qui la relance (`retry`) pour lui accorder un budget de plus.
 */
export function pausedForBudget(cursor: RunCursor, cost: number, threshold: number): Transition {
  return to("awaiting_human", cursor.step, cursor, {
    attempts: cursor.attempts,
    reason: `budget dépassé : ${cost.toFixed(2)} $ pour un plafond de ${threshold.toFixed(2)} $ — relance la feature pour continuer`,
  });
}

/** La relance par l'humain d'un run échoué ou en attente : même étape, compteur de relances à zéro, tout de suite. */
export function retried(cursor: RunCursor): Transition {
  return to("queued", cursor.step, cursor, { attempts: 0, notBefore: null, reason: "relancé par l'humain" });
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
  const illegal = from.filter((state) => !canTransition(state, to));
  if (illegal.length > 0) throw new Error(`transition interdite : ${illegal.join(", ")} → ${to}`);
}

/**
 * Le merge s'arrête (conflit avec main, suite rouge après rebase, fusion refusée) :
 * retour en revue ou en correction après un délai (5, 15 puis 60 min), compté dans
 * `mergeRetries` — jamais dans `fixes`, qui ne compte que les corrections de revue ;
 * au plafond, l'humain. Le merger incrémente lui-même `mergeRetries` sur le run.
 */
export function afterMergeStopped(
  cursor: Pick<RunCursor, "fixes"> & { mergeRetries: number },
  step: "fix" | "review",
  reason: string,
  limits: Pick<Limits, "mergeRetries">,
  now: number,
): Transition {
  const at = { step, fixes: cursor.fixes, attempts: 0 };
  if (cursor.mergeRetries >= limits.mergeRetries)
    return to("awaiting_human", null, at, { reason: `${reason} — plafond de tentatives de merge atteint` });
  const wait = MERGE_BACKOFF_MS[Math.min(cursor.mergeRetries, MERGE_BACKOFF_MS.length - 1)] ?? 0;
  return to("queued", step, at, { notBefore: now + wait, reason });
}

/** Le merge est fait dans git : l'état suit, toujours. */
export function afterMerged(cursor: Pick<RunCursor, "fixes">): Transition {
  return to("merged", null, { step: "review", fixes: cursor.fixes, attempts: 0 }, { reason: "mergé" });
}

/** Un merge impossible (push refusé par gh, erreur git) : l'humain reprend la main. */
export function afterMergeFailed(cursor: Pick<RunCursor, "fixes">, reason: string): Transition {
  return to(
    "awaiting_human",
    null,
    { step: "review", fixes: cursor.fixes, attempts: 0 },
    { reason: `merge impossible : ${reason}` },
  );
}

/** L'annulation par l'humain : l'étape courante est gardée pour l'historique. */
export function cancelled(cursor: RunCursor | { step: StepKind | null; fixes: number; attempts: number }): Transition {
  return {
    state: "cancelled",
    step: cursor.step,
    fixes: cursor.fixes,
    attempts: cursor.attempts,
    keepRunner: false,
    rebase: false,
    notBefore: null,
    reason: "annulé par l'humain",
  };
}

/** Une panne qui empêche le run d'avancer (worktree perdu, erreur du service). */
export function crashed(
  cursor: { step: StepKind | null; fixes: number; attempts: number },
  reason: string,
): Transition {
  return {
    state: "failed",
    step: cursor.step,
    fixes: cursor.fixes,
    attempts: cursor.attempts,
    keepRunner: false,
    rebase: false,
    notBefore: null,
    reason,
  };
}

/** Le service a redémarré pendant l'étape : elle repart de son dernier checkpoint, nouveau runner. */
export function recovered(cursor: RunCursor): Transition {
  return to("queued", cursor.step, cursor, {
    attempts: cursor.attempts,
    reason: "service redémarré — reprise au dernier checkpoint",
  });
}
