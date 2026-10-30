// Les codes que le serveur de pipelines écrit dans le monitoring (types d'événements,
// sortes d'alertes, provenance des fichiers) : des identifiants de son protocole, pas
// des mots affichés. `MonitoringText` les traduit ; aucun écran ne les écrit en dur.

public enum MonitoringCodes {
    // MARK: - Événements de la frise

    public static let created = "run_created"
    public static let stepTimeout = "step_timeout"
    public static let retried = "retried"
    public static let rateLimited = "rate_limited"
    public static let modelFailover = "model_failover"
    public static let providerRetry = "provider_retry"
    public static let providerError = "provider_error"
    public static let escalations = "escalations"
    public static let escalationAnswered = "escalation_answered"
    public static let specsReady = "specs_ready"
    public static let verdict = "verdict"
    public static let decisionAutoTimeout = "decision_auto_timeout"
    public static let heavyOomRetry = "heavy_oom_retry"
    public static let heavyFailRetry = "heavy_fail_retry"
    public static let heavyFlaky = "heavy_flaky"
    public static let rebased = "rebased"
    public static let rebaseConflict = "rebase_conflict"
    public static let mergeQueued = "merge_queued"
    public static let mergeRetry = "merge_retry"
    public static let merged = "merged"
    public static let pushFailed = "push_failed"
    public static let reverted = "reverted"
    public static let failed = "run_failed"
    public static let recovered = "recovered"
    public static let pilot = "pilot"

    // MARK: - Alertes

    public static let stalled = "stalled"
    public static let stepSlow = "step_slow"
    public static let fixLoop = "fix_loop"
    public static let budgetExceeded = "budget_exceeded"

    // MARK: - Provenance des fichiers touchés

    public static let sourceWorkingCopy = "worktree"
    public static let sourceMerge = "merge"
}
