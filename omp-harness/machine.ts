// La machine à états d'un run : req → specs → impl → review ⇄ fix, puis merge ou l'humain.
//
// Fonction PURE : elle ne lance rien, ne lit rien. L'orchestrateur lui donne l'issue
// d'une étape et applique la transition rendue. `keepRunner` dit si le runner de
// l'étape reste vivant pour la suivante : req → specs (même rappel, même contexte) et
// review → fix (le correcteur connaît les bloquants) ; fix → review le tue (un
// arbitre ne relit pas sa propre correction) ; partout ailleurs il meurt à la fin de
// l'étape ou à l'escalade.
import type { Tier } from "./config.ts";
import type { IrreversibleCategory } from "./decisions.ts";
import type { MergeDecision, MergeFact } from "./verdict.ts";

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
   * dit pourquoi ; `criteriaMissing` (review) = critères d'acceptation sans verdict ;
   * `continueImpl` (impl) = le reste à livrer, que /impl reprend sur la même branche.
   */
  | {
      kind: "done";
      escalations: number;
      merge?: MergeDecision;
      blockers?: number;
      gateNeeded?: boolean;
      gateReasons?: string[];
      criteriaMissing?: string[];
      continueImpl?: string;
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
 * tolérés avant l'humain. `ask` : le run est en « tout me demander » (`autonomy: "ask"`) —
 * la porte des specs est toujours posée et la revue attend toujours l'humain, quelle que
 * soit la configuration.
 */
export type Limits = {
  fixCap: number;
  retryBackoffSec: number[];
  specsGate: boolean | "auto";
  mergeRetries: number;
  ask?: boolean;
};

/** `lastFailCause` : la cause du dernier échec de la même étape (deux de suite ⇒ l'humain). */
export type RunCursor = { step: StepKind; fixes: number; attempts: number; lastFailCause?: FailCause | null };

/** L'attente avant la relance d'un merge arrêté : 5, 15 puis 60 minutes. */
export const MERGE_BACKOFF_MS: readonly number[] = [300_000, 900_000, 3_600_000];

const NEXT: Record<"req" | "specs" | "impl", StepKind> = { req: "specs", specs: "impl", impl: "review" };

/**
 * Le début de la raison de chaque attente de l'humain qui n'est pas une panne : la
 * transition l'écrit, `humanWaitOf` la relit (le pilote d'un audit en déduit ses gestes).
 */
export const WAIT_REASON = {
  specs: "specs à valider avant /impl",
  verdict: "validation humaine",
  fixCap: "plafond de corrections atteint",
  contest: "le correcteur conteste les bloquants une seconde fois",
  budget: "budget dépassé",
} as const;

/** La raison de porte des specs qui réserve leur validation à l'humain (steps.ts `gateReasons`). */
export const IRREVERSIBLE_GATE = "geste irréversible";

/** La raison d'une attente que seul le curseur du run impose (`autonomy: "ask"`). */
export const ASK_REASON = "autonomie « tout me demander »";

/** La raison d'une reprise de /impl pour livrer son `## Reste` (une fois par run, steps.ts `#closeImpl`). */
const IMPL_CONTINUED = "/impl : reste à livrer sur la même branche";

/**
 * Ce qu'un run `awaiting_human` attend : des specs à valider (`irreversible` si elles
 * portent un geste irréversible), un verdict à valider, un arbitrage entre revue et
 * correction, un budget à accorder, ou une relance après une panne (`failure` : échecs
 * répétés, merge arrêté ou impossible).
 */
export type HumanWait = "specs" | "irreversible" | "verdict" | "arbitration" | "budget" | "failure";

export function humanWaitOf(run: { state: RunState; step: StepKind | null; reason: string | null }): HumanWait | null {
  if (run.state !== "awaiting_human") return null;
  const reason = run.reason ?? "";
  if (reason.startsWith(WAIT_REASON.budget)) return "budget";
  if (run.step === "specs" && reason.startsWith(WAIT_REASON.specs))
    return reason.includes(`${IRREVERSIBLE_GATE} (`) ? "irreversible" : "specs";
  if (reason.startsWith(WAIT_REASON.verdict)) return "verdict";
  if (reason.startsWith(WAIT_REASON.fixCap) || reason.startsWith(WAIT_REASON.contest)) return "arbitration";
  return "failure";
}

/** La fin de la raison d'un merge arrêté au plafond de ses tentatives (`afterMergeStopped`). */
export const MERGE_CAP = "plafond de tentatives de merge atteint";

/**
 * L'étape d'où repart un run arrêté au plafond de ses merges, ou `null` s'il n'en est pas
 * un. Une ligne écrite avant que l'étape soit gardée (`step` null) se lit dans sa raison.
 */
export function mergeStopOf(run: {
  state: RunState;
  step: StepKind | null;
  reason: string | null;
}): "review" | "fix" | null {
  const reason = run.reason ?? "";
  if (run.state !== "awaiting_human" || !reason.endsWith(MERGE_CAP)) return null;
  if (run.step === "review" || run.step === "fix") return run.step;
  return reason.startsWith("suite complète") ? "fix" : "review";
}

/** Le début de la raison d'une étape en échec (`afterFailure`) : ce qui distingue une panne d'étape d'une panne du service. */
function failedHead(step: StepKind): string {
  return `/${step} a échoué`;
}

/** Dans la raison de specs rendues à l'humain (`specsBackToHuman`) : la validation prise seule a été renversée. */
const AUTONOMY_REVERSED = "validation de l'autonomie (#";

/** Le début de la raison d'un merge impossible (`afterMergeFailed`). */
const MERGE_IMPOSSIBLE = "merge impossible";

/** Le début de la raison d'un run arrêté par l'humain (`cancelled`) : les chiffres y reconnaissent un arrêt. */
export const CANCELLED_BY_HUMAN = "annulé par l'humain";

/** Une raison de la porte des specs, en DONNÉES (steps.ts `gateFacts`, `specsGateFacts`). */
export type GateFact =
  | { code: "split_proposed" }
  | { code: "empty_modules" }
  | { code: "irreversible"; category: IrreversibleCategory }
  | { code: "first_of_project" }
  /** Les désaccords restés ouverts avec le contradicteur (`/étape C-n`). */
  | { code: "dispute"; ids: string[] };

/**
 * Un fait à CODE de ce qu'un run attend de l'humain : les apps en écrivent leur phrase, le texte de
 * `run.reason` reste au journal. `other` : un motif que le serveur ne sait pas structurer (jamais son texte).
 */
export type WaitFact =
  | MergeFact
  | GateFact
  /** La porte des specs est systématique sur ce serveur (`review.specsGate: true`), sans autre raison. */
  | { code: "specs_gate" }
  /** Une validation de specs prise seule par l'autonomie a été renversée : elles reviennent à l'humain. */
  | { code: "autonomy_reversed" }
  /** Le run est en « tout me demander » (`autonomy: "ask"`). */
  | { code: "ask_level" }
  | { code: "fix_cap"; fixes: number; cap: number }
  /** Le correcteur a contesté les bloquants deux fois de suite. */
  | { code: "contest" }
  /** `budget` : le seuil franchi (le budget, plus ce que les relances ont accordé) ; `null` s'il n'y en a plus. */
  | { code: "budget"; spent: number; budget: number | null }
  /** `resume` : l'étape d'où le run repartira (`fix` : suite rouge ; `review` : conflit, fusion refusée). */
  | { code: "merge_stopped"; attempts: number; resume: "review" | "fix" }
  | { code: "merge_failed" }
  /** `attempts` : les essais de l'étape, relances comprises ; `oom` : le runner a été tué faute de mémoire. */
  | { code: "step_failed"; step: StepKind; cause: FailCause | null; attempts: number; oom: boolean }
  | { code: "other" };

/** Ce qu'un run attend de l'humain, tel que l'API le rend : la sorte d'attente et ses faits. */
export type HumanWaitView = { kind: HumanWait | "questions"; reasons: WaitFact[] };

/**
 * Ce que le serveur sait d'une attente, lu à la demande (une attente ne lit que ce qui la concerne) :
 * `gate` — les raisons de porte relues des specs ; `merge` — les motifs du refus d'auto-merge relus de
 * l'évidence de la dernière revue, `null` si elle manque ; `budget` — le coût du run et son seuil ;
 * `openQuestions` — ses escalades ouvertes ; `fixCap` — `review.fixCap`.
 */
export type WaitSources = {
  gate: () => GateFact[];
  merge: () => MergeFact[] | null;
  budget: () => { spent: number; budget: number | null };
  openQuestions: () => number;
  fixCap: number;
};

/** Ce qu'il faut d'un run pour dire son attente ou son échec. */
type Stalled = {
  state: RunState;
  step: StepKind | null;
  reason: string | null;
  fixes: number;
  attempts: number;
  mergeRetries: number;
  lastFailCause: FailCause | null;
  autonomy: string | null;
  verdict: { blockers: readonly unknown[] } | null;
};

/**
 * Pourquoi un run attend l'humain, en données : `kind` (`humanWaitOf`, `questions` pour un run
 * `escalated`) et ses faits à code ; `null` hors attente humaine. La SORTE se lit dans la raison du run,
 * comme partout ; les faits viennent de ce que le serveur sait (`sources`), jamais du texte. Des specs
 * relues avec un geste irréversible rendent `irreversible` même quand la raison est nue
 * (`review.specsGate: true`). Jamais de liste vide : sans fait connu, `other`.
 */
export function humanWaitFacts(run: Stalled, sources: WaitSources): HumanWaitView | null {
  if (run.state === "escalated")
    return { kind: "questions", reasons: [{ code: "open_questions", count: sources.openQuestions() }] };
  const wait = humanWaitOf(run);
  if (wait === null) return null;
  const reason = run.reason ?? "";
  const ask: WaitFact[] = run.autonomy === "ask" || reason.includes(ASK_REASON) ? [{ code: "ask_level" }] : [];
  const known = (kind: HumanWait, reasons: WaitFact[]): HumanWaitView => ({
    kind,
    reasons: reasons.length > 0 ? reasons : [{ code: "other" }],
  });
  switch (wait) {
    case "budget":
      return known(wait, [{ code: "budget", ...sources.budget() }]);
    case "specs":
    case "irreversible": {
      const gate = sources.gate();
      const reasons: WaitFact[] = [
        ...gate,
        ...(reason.includes(AUTONOMY_REVERSED) ? [{ code: "autonomy_reversed" } as const] : []),
        ...ask,
      ];
      return known(
        gate.some((fact) => fact.code === "irreversible") ? "irreversible" : wait,
        reasons.length > 0 ? reasons : [{ code: "specs_gate" }],
      );
    }
    case "verdict":
      return known(wait, [...(sources.merge() ?? []), ...ask]);
    case "arbitration": {
      if (reason.startsWith(WAIT_REASON.contest)) return known(wait, [{ code: "contest" }]);
      const blockers = run.verdict?.blockers.length ?? 0;
      return known(wait, [
        { code: "fix_cap", fixes: run.fixes, cap: sources.fixCap },
        ...(blockers > 0 ? [{ code: "blockers", count: blockers } as const] : []),
      ]);
    }
    case "failure": {
      const resume = mergeStopOf(run);
      if (resume !== null) return known(wait, [{ code: "merge_stopped", attempts: run.mergeRetries, resume }]);
      if (reason.startsWith(MERGE_IMPOSSIBLE)) return known(wait, [{ code: "merge_failed" }]);
      if (run.step === null || !reason.startsWith(failedHead(run.step))) return known(wait, []);
      return known(wait, [
        {
          code: "step_failed",
          step: run.step,
          cause: run.lastFailCause,
          attempts: run.attempts + 1,
          oom: isRunnerOom(reason),
        },
      ]);
    }
  }
}

/** Pourquoi un run a échoué, tel que l'API le rend : l'étape en échec et la cause de son dernier échec. */
export type RunFailure = { step: StepKind | null; cause: FailCause | null };

/**
 * L'échec d'un run `failed` (`null` sinon) : son étape, et `lastFailCause` quand c'est bien l'étape qui a
 * échoué — une panne du service (worktree perdu, erreur de conduite) n'a pas de cause d'étape : `null`.
 */
export function failureOf(run: Pick<Stalled, "state" | "step" | "reason" | "lastFailCause">): RunFailure | null {
  if (run.state !== "failed") return null;
  const stepFailed = run.step !== null && (run.reason ?? "").startsWith(failedHead(run.step));
  return { step: run.step, cause: stepFailed ? run.lastFailCause : null };
}

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
      const reasons = outcome.gateReasons ?? [];
      // « Tout me demander » : la porte est posée même sans raison, et ses raisons sont dites (le
      // geste irréversible d'abord : `humanWaitOf` le réserve à l'humain).
      if (limits.ask === true)
        return to("awaiting_human", "specs", cursor, {
          reason: `${WAIT_REASON.specs} : ${[...reasons, ASK_REASON].join(" ; ")}`,
        });
      const gate = limits.specsGate === "auto" ? outcome.gateNeeded === true : limits.specsGate;
      if (gate) {
        return to("awaiting_human", "specs", cursor, {
          reason:
            limits.specsGate === "auto"
              ? reasons.length > 0
                ? `${WAIT_REASON.specs} : ${reasons.join(" ; ")}`
                : `${WAIT_REASON.specs} (découpage, modules ou ${IRREVERSIBLE_GATE})`
              : WAIT_REASON.specs,
        });
      }
      return to("running", NEXT[step], cursor, { reason: "/specs terminé" });
    }
    case "impl":
      // Un reste à livrer : le même run reprend /impl sur sa branche (un runner neuf,
      // relances remises à zéro) au lieu de laisser une feature à moitié livrée en revue.
      if (outcome.continueImpl !== undefined) return to("running", "impl", cursor, { reason: IMPL_CONTINUED });
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
          reason: `${WAIT_REASON.fixCap} (${limits.fixCap}) avec ${blockers} bloquant(s)`,
        });
      }
      const merge = outcome.merge;
      if (merge?.auto && limits.ask !== true)
        return to("merging", null, cursor, { reason: "verdict bas risque et tests verts — auto-merge" });
      return to("awaiting_human", null, cursor, {
        reason: merge?.auto
          ? `${WAIT_REASON.verdict} : ${ASK_REASON}`
          : merge
            ? `${WAIT_REASON.verdict} : ${merge.reasons.join(" ; ")}`
            : `${WAIT_REASON.verdict} requise`,
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
        reason: `${WAIT_REASON.contest} : ${outcome.reason}`,
      });
    }
    return to("running", "review", cursor, {
      keepRunner: false,
      reason: `le correcteur conteste les bloquants (${outcome.reason}) — nouvelle revue`,
    });
  }
  if (!outcome.retryable) {
    return to("failed", step, cursor, { attempts: cursor.attempts, reason: `${failedHead(step)} : ${outcome.reason}` });
  }
  if (cursor.lastFailCause === outcome.cause && !WAITABLE_CAUSES.includes(outcome.cause)) {
    const cause = isRunnerOom(outcome.reason) ? OOM_CAUSE : outcome.cause;
    return to("awaiting_human", step, cursor, {
      attempts: cursor.attempts,
      reason: `${failedHead(step)} deux fois de suite pour la même cause (${cause}) : ${outcome.reason}`,
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
    reason: `${failedHead(step)} ${limits.retryBackoffSec.length + 1} fois (${outcome.cause}), relances épuisées : ${outcome.reason}`,
  });
}

/** La cause nommée à l'humain quand le runner est tué faute de mémoire. */
export const OOM_CAUSE = "mémoire du runner (code 137)";

/** Un runner tué faute de mémoire : son processus est sorti en code 137 (SIGKILL de l'OOM killer). */
export function isRunnerOom(reason: string): boolean {
  return /runner arrêté : code 137\b/.test(reason);
}

/**
 * Le plafond de coût atteint (`monitoring.pauseOnBudget`) : avant sa prochaine étape, la
 * feature attend l'humain, qui la relance (`retry`) pour lui accorder un budget de plus.
 */
export function pausedForBudget(cursor: RunCursor, cost: number, threshold: number): Transition {
  return to("awaiting_human", cursor.step, cursor, {
    attempts: cursor.attempts,
    reason: `${WAIT_REASON.budget} : ${cost.toFixed(2)} $ pour un plafond de ${threshold.toFixed(2)} $ — relance la feature pour continuer`,
  });
}

/**
 * Le plafond journalier du serveur atteint (`monitoring.dailyBudgetUsd`) : avant sa prochaine
 * étape, la feature rend son slot et retourne en file, où l'admission la retient jusqu'à
 * minuit UTC ou un plafond relevé. Elle reprend seule, à la même étape.
 */
export function heldForDailyBudget(cursor: RunCursor, spent: number, ceiling: number): Transition {
  return to("queued", cursor.step, cursor, {
    attempts: cursor.attempts,
    reason: `plafond journalier atteint : ${spent.toFixed(2)} $ dépensés aujourd'hui (UTC) pour ${ceiling.toFixed(2)} $ — reprise à minuit UTC ou plafond relevé`,
  });
}

/** Le début de la raison d'un run que la pause globale retient (`POST /v1/pause`), en base comme en file. */
export const PAUSE_REASON = "en pause : suspendu par";

/**
 * La pause globale (« Tout suspendre ») : comme au plafond journalier, avant sa prochaine étape
 * la feature rend son slot et retourne en file, où l'admission la retient jusqu'à la reprise.
 * Rien n'est annulé : elle repart seule, à la même étape.
 */
export function heldForPause(cursor: RunCursor, who: string): Transition {
  return to("queued", cursor.step, cursor, { attempts: cursor.attempts, reason: `${PAUSE_REASON} ${who}` });
}

/** La relance par l'humain (ou `who`) d'un run échoué ou en attente : même étape, compteur de relances à zéro, tout de suite. */
export function retried(cursor: RunCursor, who = "l'humain"): Transition {
  return to("queued", cursor.step, cursor, { attempts: 0, notBefore: null, reason: `relancé par ${who}` });
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

/** La validation humaine d'un verdict : accepter → merge, refuser → une correction (hors plafond). `who` : qui tranche. */
export function afterHumanValidation(
  cursor: RunCursor,
  approve: boolean,
  reason: string,
  who = "l'humain",
): Transition {
  if (approve) return to("merging", null, cursor, { reason: reason || `validé par ${who}` });
  return to("queued", "fix", cursor, { fixes: cursor.fixes + 1, reason: `refusé par ${who} : ${reason}` });
}

/** La validation humaine des specs : accepter → /impl, refuser → /specs refait avec la raison. `who` : qui tranche. */
export function afterSpecsValidation(
  cursor: RunCursor,
  approve: boolean,
  reason: string,
  who = "l'humain",
): Transition {
  if (approve) return to("queued", "impl", cursor, { reason: reason || `specs validées par ${who}` });
  return to("queued", "specs", cursor, { reason: `specs refusées par ${who} : ${reason}` });
}

/** Une validation de specs prise seule par l'autonomie est renversée avant le merge : les specs reviennent à l'humain. */
export function specsBackToHuman(cursor: RunCursor, seq: number): Transition {
  return to("awaiting_human", "specs", cursor, {
    reason: `${WAIT_REASON.specs} : ${AUTONOMY_REVERSED}${seq}) renversée par l'humain`,
  });
}

/**
 * Les specs sont-elles ACCEPTÉES par cette transition ? Le passage de /specs à /impl : sans
 * porte (`nextAfter`), ou validées par l'humain ou le pilote (`afterSpecsValidation`). Leur
 * `## Découpage` part alors en projet (split.ts), jamais à la seule clôture de /specs.
 */
export function acceptsSpecs(from: StepKind | null, transition: Pick<Transition, "state" | "step">): boolean {
  return from === "specs" && transition.step === "impl" && !isTerminal(transition.state);
}

/** Une feature découpée dont le parent est mergé : elle quitte l'attente, l'admission la fera partir. */
export function splitReleased(
  cursor: { step: StepKind | null; fixes: number; attempts: number },
  parent: string,
): Transition {
  return {
    state: "queued",
    step: cursor.step,
    fixes: cursor.fixes,
    attempts: cursor.attempts,
    keepRunner: false,
    rebase: false,
    notBefore: null,
    reason: `« ${parent} » mergé : part à son tour`,
  };
}

/** Une feature découpée qui ne partira pas : son parent annulé, en échec, ou son découpage remplacé. */
export function splitAbandoned(
  cursor: { step: StepKind | null; fixes: number; attempts: number },
  why: string,
): Transition {
  return { ...cancelled(cursor), reason: why };
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
  // → awaiting_human depuis queued, escalated, awaiting_human et failed : le renversement, avant le
  // merge, d'une validation de specs prise seule rend les specs à l'humain (`specsBackToHuman`).
  queued: ["queued", "running", "awaiting_human", "cancelled", "failed"],
  running: ["running", "queued", "escalated", "awaiting_human", "merging", "failed", "cancelled"],
  escalated: ["queued", "awaiting_human", "cancelled", "failed"],
  awaiting_human: ["queued", "awaiting_human", "merging", "cancelled", "failed"],
  merging: ["merged", "queued", "awaiting_human", "failed"],
  merged: [],
  // Un run échoué peut être rouvert (décision renversée) ou annulé.
  failed: ["queued", "awaiting_human", "cancelled"],
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
  // Au plafond, l'étape est gardée : la validation ou la relance de l'humain y reprend.
  if (cursor.mergeRetries >= limits.mergeRetries)
    return to("awaiting_human", step, at, { reason: `${reason} — ${MERGE_CAP}` });
  const wait = MERGE_BACKOFF_MS[Math.min(cursor.mergeRetries, MERGE_BACKOFF_MS.length - 1)] ?? 0;
  return to("queued", step, at, { notBefore: now + wait, reason });
}

/**
 * La validation d'un run arrêté au plafond de ses merges : refaire le même merge buterait
 * sur la même cause. Il repart à l'étape qui la lève (revue : conflit ; correction :
 * suite rouge), tout de suite ; le geste remet `mergeRetries` à zéro.
 */
export function resumeAfterMergeStop(cursor: RunCursor, who = "l'humain"): Transition {
  return to("queued", cursor.step, cursor, {
    reason: `validé par ${who} — le merge arrêté repart par /${cursor.step === "fix" ? "impl --fix" : "review"}`,
  });
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
    { reason: `${MERGE_IMPOSSIBLE} : ${reason}` },
  );
}

/**
 * L'annulation par l'humain : l'étape courante est gardée pour l'historique. `motive` : le
 * motif qu'il donne (libellé, note), à la suite du préfixe que les lecteurs reconnaissent.
 */
export function cancelled(
  cursor: RunCursor | { step: StepKind | null; fixes: number; attempts: number },
  motive = "",
): Transition {
  return {
    state: "cancelled",
    step: cursor.step,
    fixes: cursor.fixes,
    attempts: cursor.attempts,
    keepRunner: false,
    rebase: false,
    notBefore: null,
    reason: motive === "" ? CANCELLED_BY_HUMAN : `${CANCELLED_BY_HUMAN} : ${motive}`,
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
