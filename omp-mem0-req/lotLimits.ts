// Bornes du lot : plafonds, délais, seuils de contexte et lecture d'environnement.
import type { PipelinePhase } from "./contract.ts";

/** Borne des relances de l'arbitre par motif et par feature : non configurable. */
export const ARBITER_RELAUNCH_MAX = 2;

/** Bornes (par la fin) de la sortie d'un run échoué conservée pour l'arbitre. */
export const LOT_FAILURE_STDERR_MAX = 2000;
export const LOT_FAILURE_STDOUT_MAX = 4000;


/** Plafond des enregistrements de run conservés par feature (S-12). */
export const LOT_RUNS_MAX = 100;


/** Au plus neuf options sélectionnables (S-3) : au-delà, la question reste lisible. */
export const MAX_REPLY_OPTIONS = 9;


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
