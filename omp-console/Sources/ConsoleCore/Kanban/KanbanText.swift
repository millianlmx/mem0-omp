// Les textes de la section Pipelines : la feuille de détail d'une carte, son
// menu contextuel, l'avancement et les boutons « Activité » et « Problèmes » de
// la barre d'outils. Les textes d'état des cartes viennent du vocabulaire
// commun (`ConsoleStatus`), ceux des voies de `KanbanLane`, ceux des anomalies
// de `KanbanAnomalies`.

public enum KanbanText {
    public static let showDetails = "Afficher les détails"
    public static let close = "Fermer"
    public static let progress = "Avancement"
    public static let action = "Action"
    public static let information = "Informations"
    public static let technical = "Détails techniques"
    public static let step = "Étape"
    public static let duration = "Durée"
    /// Les deux groupes de modèle d'une feature (B-4) : le libellé court d'une
    /// ligne d'affichage, et le libellé de l'option de choix (en tête des listes).
    public static let modelReqSpecs = "req+specs"
    public static let modelImplReview = "impl+review"
    public static let modelDefault = "défaut OMP"
    public static let editModels = "Modifier les modèles…"
    public static let editModelsShort = "Modifier…"
    public static let pullRequest = "Pull request"
    public static let repository = "Dépôt"
    public static let activity = "Activité"
    public static let activityHelp = "Les derniers gestes envoyés depuis l'app"
    public static let problemsHelp = "Problèmes détectés dans les données des pipelines"
    public static let reply = "Répondre…"
    public static let sendMessage = "Envoyer un message…"
    public static let diagnosticTitle = "Problèmes détectés"
    public static let emptyHint = "Lancez une feature avec « Nouvelle feature… » (⌘N)."

    /// Les cinq étapes de l'avancement, dans l'ordre de la pipeline.
    public static let progressSteps = ["Besoins", "Specs", "Implémentation", "Revue", "PR"]

    public static func marks(_ text: String) -> String { "Marques : \(text)" }

    /// « 1 problème », « 3 problèmes » : le libellé du bouton de la barre d'outils.
    public static func problems(_ n: Int) -> String { ConsoleFormat.count(n, "problème", "problèmes") }
}
