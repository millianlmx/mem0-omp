// Le catalogue des événements du journal : ce que le flux SSE pousse aux clients.
//
// Un événement JOURNALISÉ est écrit dans la base, rejoué depuis `Last-Event-ID` et
// déclenche une relecture chez les apps. Un événement ÉPHÉMÈRE (l'activité des
// outils d'un runner) n'est jamais écrit : il n'est poussé qu'aux abonnés qui le
// demandent (`GET /v1/events?live=1`), pour ne pas faire relire la boîte à chaque
// appel d'outil.


export const EVENT_TYPES = [
  // runs
  "run_created",
  "run_state",
  "priority",
  "worktree",
  "modules",
  "recovered",
  "admission_refused",
  // étapes et runners
  "step_started",
  "step_done",
  "step_timeout",
  "runner_started",
  "runner_stopped",
  "rate_limited",
  "model_failover",
  "model_tier",
  "progress",
  // décisions et boucle humaine
  "decision",
  "decision_accepted",
  "decision_reversed",
  "escalation",
  "escalations",
  "escalation_answered",
  "specs_ready",
  "review",
  "verdict",
  // tests heavy
  "heavy_started",
  "heavy_done",
  "heavy_cached",
  "heavy_oom_retry",
  // git et merge
  "rebased",
  "rebase_conflict",
  "merge_queued",
  "merge_retry",
  "merged",
  "push_failed",
  // projets et audits
  "project_created",
  "project_done",
  "audit_state",
  // éphémères
  "activity",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Les événements poussés en direct sans être écrits. */
export const EPHEMERAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["activity"]);
