// Les textes de la section Pipelines : la feuille de détail d'une carte, son
// menu contextuel, l'avancement et les boutons « Activité » et « Problèmes » de
// la barre d'outils. Les textes d'état des cartes viennent du vocabulaire
// commun (`ConsoleStatus`), ceux des voies de `KanbanLane`, ceux des anomalies
// de `KanbanAnomalies`.

enum KanbanText {
    static let showDetails = "Afficher les détails"
    static let close = "Fermer"
    static let progress = "Avancement"
    static let action = "Action"
    static let information = "Informations"
    static let technical = "Détails techniques"
    static let step = "Étape"
    static let duration = "Durée"
    static let model = "Modèle"
    static let pullRequest = "Pull request"
    static let repository = "Dépôt"
    static let activity = "Activité"
    static let activityHelp = "Les derniers gestes envoyés depuis l'app"
    static let problemsHelp = "Problèmes détectés dans les données des pipelines"
    static let reply = "Répondre…"
    static let sendMessage = "Envoyer un message…"
    static let diagnosticTitle = "Problèmes détectés"
    static let emptyHint = "Lancez une feature avec « Nouvelle feature… » (⌘N)."

    /// Les cinq étapes de l'avancement, dans l'ordre de la pipeline.
    static let progressSteps = ["Besoins", "Specs", "Implémentation", "Revue", "PR"]

    static func marks(_ text: String) -> String { "Marques : \(text)" }

    /// « 1 problème », « 3 problèmes » : le libellé du bouton de la barre d'outils.
    static func problems(_ n: Int) -> String { ConsoleFormat.count(n, "problème", "problèmes") }
}
