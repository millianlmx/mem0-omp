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
  "impl_continued",
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
  "challenge",
  "review",
  "verdict",
  "decision_auto_timeout",
  "retried",
  "instructions",
  // tests heavy
  "heavy_started",
  "heavy_done",
  "heavy_cached",
  "heavy_oom_retry",
  "heavy_joined",
  "heavy_fail_retry",
  "heavy_skipped",
  "heavy_flaky",
  "heavy_baseline",
  // git et merge
  "rebased",
  "rebase_conflict",
  "merge_queued",
  "merge_retry",
  "merged",
  "push_failed",
  "reverted",
  "revert_failed",
  // projets, audits et rêves de la mémoire
  "project_created",
  "project_done",
  "audit_state",
  "pilot",
  "dream_state",
  // les Demandes (intake.ts) : dépôt de la demande, null s'il n'y en a pas
  "intake_state",
  // planifications récurrentes (le dépôt de leur cible)
  "schedule_fired",
  "schedule_skipped",
  // configuration du serveur
  "providers_changed",
  // notifications sortantes (ntfy)
  "notify_failed",
  // monitoring : veille, coût
  "stalled",
  "step_slow",
  "fix_loop",
  "budget_exceeded",
  "run_budget",
  "daily_budget_reached",
  "alert_cleared",
  // observabilité : erreurs remontées par les clients, sauvegardes en échec (repo null)
  "client_error",
  "backup_failed",
  // le poste de travail (repo null : seuls les clients qui voient tous les dépôts les reçoivent)
  "workstation_action",
  "workstation_approval",
  "workstation_profile",
  "workstation_meeting",
  "workstation_settings",
  "workstation_shift",
  "workstation_stop",
  "workstation_request",
  "workstation_automation",
  "workstation_browser",
  // l'état d'un compte du navigateur `vps` (domaine, état : jamais un cookie)
  "workstation_account",
  "workstation_channel",
  // la lecture des canaux corpo : un passage a gardé ou retiré des contenus (`{channel, added, removed}`),
  // un canal Slack coché ou décoché comme suivi (`{id, followed}`) ; jamais de contenu
  "workstation_channel_read",
  "workstation_channel_follow",
  // le graphe des personnes du poste : une personne créée, complétée ou corrigée (`{id}` seul)
  "workstation_person",
  // la veille proactive du poste : un élément d'« À traiter » créé ou changé (`{id, kind, state, ready}` seuls)
  "workstation_watch",
  // la vigie (vigie/) : un incident qui bouge (relevé, trié, publié, corrigé, rendu à l'humain),
  // et son silence (plus de battement de cœur depuis vigie.SILENT_MS)
  "vigie_incident",
  "vigie_silent",
  // l'autonomie par paliers : une attente retenue, validée seule ou rendue à l'humain (`autonomy`),
  // et chaque validation ou refus d'une attente humaine, par qui que ce soit (`validation`)
  "autonomy",
  "validation",
  // le pont corpo ↔ usine : l'état d'un signalement d'un collègue (`{id, state}` seulement ; repo null : poste réservé au propriétaire)
  "signal",
  // le pont corpo ↔ usine : l'état d'un brouillon de réponse au collègue (`{id, state}` seulement ; repo null : poste réservé au propriétaire)
  "reply",
  // éphémères
  "activity",
  "session",
  "test_output",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Les événements poussés en direct sans être écrits. */
export const EPHEMERAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["activity", "session", "test_output"]);
