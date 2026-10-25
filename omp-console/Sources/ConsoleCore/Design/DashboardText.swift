// Le vocabulaire du TABLEAU DE BORD de l'Accueil (feature accueil-tableau-de-bord),
// partagé par la coque Mac et l'app iOS : les titres des blocs, les tuiles de KPI, les
// séries et les axes des graphiques. Ce qui existe ailleurs (taux de fusion, délai,
// coût, capacité) se reprend de `PipelineServerText` et `MonitoringText`.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?) et glossaire GLOSSAIRE.md.

public enum DashboardText {
    // MARK: - Blocs

    public static let waitingTitle = L10n.text("Ce qui vous attend")
    public static let waitingHint = L10n.text("Par projet : questions à trancher, specs et verdicts à valider, décisions à relire.")
    public static let waitingNone = L10n.text("Aucun projet n’attend votre décision.")
    public static let throughputTitle = L10n.text("Débit")
    public static let throughputHint = L10n.text("Les features lancées, fusionnées et échouées, jour par jour sur 14 jours, puis celles en cours par étape.")
    public static let throughputNone = L10n.text("Aucune feature lancée ni terminée sur 14 jours.")
    public static let costTitle = L10n.text("Coût des agents")
    public static let costHint = L10n.text("Jour par jour sur 14 jours, puis par projet sur 7 jours.")
    public static let healthTitle = L10n.text("Santé")
    public static let healthHint = L10n.text("La part des passages en échec par étape, et l’occupation du serveur.")
    public static let noStats = L10n.text("Les graphiques arrivent avec les statistiques du serveur.")

    // MARK: - Tuiles

    public static let kpiPending = L10n.text("À traiter")
    public static let kpiToReview = L10n.text("À relire")
    public static let kpiActive = L10n.text("En cours")
    public static let kpiOldest = L10n.text("Plus vieille attente")
    public static let kpiCost = L10n.text("Coût sur 7 jours")
    public static let kpiMerged = PipelineServerText.mergedWeek
    public static let kpiMergeRate = PipelineServerText.mergeRate
    public static let kpiLeadTime = PipelineServerText.leadTime
    public static let kpiAlerts = MonitoringText.alertsTitle
    public static let kpiAudits = L10n.text("Audits à trier")
    public static let auditsSymbol = "checklist"
    public static let pendingSymbol = "tray.full"
    public static let toReviewSymbol = "arrow.uturn.backward.circle"
    public static let activeSymbol = "gearshape.2"
    public static let oldestSymbol = "hourglass"
    public static let mergedSymbol = "checkmark.seal"
    public static let mergeRateSymbol = "percent"
    public static let leadTimeSymbol = "clock"
    public static let costSymbol = "dollarsign.circle"
    public static let alertsSymbol = "exclamationmark.triangle"

    // MARK: - Séries et axes

    public static let kindQuestions = L10n.text("Questions")
    public static let kindSpecs = L10n.text("Specs")
    public static let kindVerdicts = L10n.text("Verdicts")
    public static let kindDecisions = L10n.text("Décisions")
    public static let seriesCreated = L10n.text("Lancées")
    public static let seriesMerged = L10n.text("Fusionnées")
    public static let seriesFailed = L10n.text("Échouées")
    public static let axisProject = L10n.text("Projet")
    public static let axisCount = L10n.text("Nombre")
    public static let axisStep = L10n.text("Étape")
    public static let axisFailures = L10n.text("Part en échec")
    public static let axisSeries = L10n.text("Série")
    public static let activeBySteps = L10n.text("En cours par étape")
    public static let costByDay = L10n.text("Jour par jour")
    public static let costByRepo = L10n.text("Par projet, sur 7 jours")
    public static let stepFailures = L10n.text("Échecs par étape")
    public static let capacity = L10n.text("Occupation")
    public static let axisDay = MonitoringText.usageDayAxis
    public static let axisCost = MonitoringText.costLabel

    /// Le nom d'une sorte d'attente, dans la légende du bloc « Ce qui vous attend ».
    public static func kind(_ raw: String) -> String {
        switch raw {
        case "questions": kindQuestions
        case "specs": kindSpecs
        case "verdicts": kindVerdicts
        case "decisions": kindDecisions
        default: raw
        }
    }

    /// « Questions : 3 », la valeur d'une barre pour VoiceOver.
    public static func kindCount(_ kind: String, _ count: Int) -> String { L10n.format("%@ : %lld", kind, count) }

    /// « 3 sur 5 » : une capacité occupée.
    public static func occupancy(used: Int, capacity: Int) -> String { PipelineServerText.slots(used: used, capacity: capacity) }
}
