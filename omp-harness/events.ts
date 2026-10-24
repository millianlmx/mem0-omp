// Le catalogue des événements du journal : ce que le flux SSE pousse aux clients.
//
// Un événement JOURNALISÉ est écrit dans la base, rejoué depuis `Last-Event-ID` et
// déclenche une relecture chez les apps. Un événement ÉPHÉMÈRE (l'activité des
// outils d'un runner, le direct de sa session) n'est jamais écrit : il n'est poussé
// qu'aux abonnés qui le demandent (`GET /v1/events?live=1`), pour ne pas faire
// relire la boîte à chaque appel d'outil.

export const EVENT_TYPES = [
  // runs
  "run_created",
  "run_state",
  "priority",
  "worktree",
  "modules",
  "recovered",
  "admission_refused",
  "run_failed",
  "checkpoint",
  "follow_up",
  "split",
  // étapes et runners
  "step_started",
  "step_done",
  "step_timeout",
  "runner_started",
  "runner_stopped",
  "rate_limited",
  "model_failover",
  "provider_error",
  "provider_retry",
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
  "decision_auto_timeout",
  "retried",
  // tests heavy
  "heavy_started",
  "heavy_done",
  "heavy_cached",
  "heavy_oom_retry",
  "heavy_joined",
  "heavy_fail_retry",
  "heavy_skipped",
  "heavy_flaky",
  // git et merge
  "rebased",
  "rebase_conflict",
  "merge_queued",
  "merge_retry",
  "merged",
  "push_failed",
  "reverted",
  "revert_failed",
  // projets et audits
  "project_created",
  "project_done",
  "audit_state",
  // configuration du serveur
  "providers_changed",
  // notifications sortantes (ntfy)
  "notify_failed",
  // monitoring : veille, coût
  "stalled",
  "step_slow",
  "fix_loop",
  "budget_exceeded",
  "alert_cleared",
  // éphémères
  "activity",
  "session",
  "test_output",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Les événements poussés en direct sans être écrits. */
export const EPHEMERAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["activity", "session", "test_output"]);
