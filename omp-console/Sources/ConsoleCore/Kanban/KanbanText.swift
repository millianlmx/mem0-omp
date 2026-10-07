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
    /// Le motif d'une carte sans aucun geste, et celui d'une exécution sans boîte
    /// publiée : les deux coques aiguillent par `KanbanActionPresentation.motif`.
    public static let noGesture = "Aucune action possible sur cette pipeline pour l'instant."
    public static let notArmed = "Cette exécution n'accepte pas de message pour l'instant."

    // --- gestes d'une carte (S-5 à S-12), mot pour mot ceux de macOS -----------
    public static let launch = "Lancer"
    public static let resume = "Reprendre"
    public static let stop = "Arrêter…"
    public static let stopConfirm = "Arrêter"
    public static let cancel = "Annuler"
    public static let validateSpecs = "Valider les specs"
    public static let acceptReview = "Accepter la revue"
    public static let questionTitle = "Question de l'agent"
    public static let answerPlaceholder = "Autre réponse…"
    public static let replyPlaceholder = "Votre réponse"
    public static let send = "Envoyer"
    public static let stopConfirmMessage =
        "Le pilote s'arrête et les pipelines en cours dans ce dépôt sont interrompues."

    // --- deux modèles d'une feature (S-13) ------------------------------------
    public static let modelReqSpecsField = "Modèle req+specs"
    public static let modelImplReviewField = "Modèle impl+review"
    public static let modelCatalogLoading = "chargement des modèles…"
    public static let modelCatalogRetry = "Réessayer"

    /// Le titre de la confirmation d'arrêt : l'arrêt vise le dépôt entier.
    public static func stopConfirmTitle(repo: String) -> String {
        "Arrêter les pipelines de \(repo) ?"
    }

    /// Le motif d'un catalogue indisponible : les deux listes se réduisent à
    /// l'option par défaut, l'édition reste possible avec les valeurs courantes.
    public static func modelCatalogUnavailable(_ reason: String) -> String {
        "modèles indisponibles — \(reason)"
    }
    public static let diagnosticTitle = "Problèmes détectés"
    public static let emptyHint = "Lancez une feature avec « Nouvelle feature… » (⌘N)."
    /// L'état vide de la section Pipelines, quand aucune pipeline n'existe : le
    /// même mot pour les deux coques (l'iOS ne peut pas afficher `emptyHint`, qui
    /// nomme un raccourci macOS).
    public static let noPipeline = "Aucune pipeline pour l'instant."

    /// Les cinq étapes de l'avancement, dans l'ordre de la pipeline.
    public static let progressSteps = ["Besoins", "Specs", "Implémentation", "Revue", "PR"]

    public static func marks(_ text: String) -> String { "Marques : \(text)" }

    /// La forme canonique d'une paire de modèles : `req+specs <A> · impl+review <B>`
    /// (un groupe vide s'affiche « défaut OMP »). Formule unique partagée par la
    /// carte Kanban de macOS et le plan du projet des deux coques.
    public static func modelsLine(_ models: ModelSlots) -> String {
        "\(modelGroup(modelReqSpecs, models.reqSpecs)) · \(modelGroup(modelImplReview, models.implReview))"
    }

    private static func modelGroup(_ label: String, _ value: String?) -> String {
        "\(label) \(value ?? modelDefault)"
    }

    /// « 1 problème », « 3 problèmes » : le libellé du bouton de la barre d'outils.
    public static func problems(_ n: Int) -> String { ConsoleFormat.count(n, "problème", "problèmes") }
}
