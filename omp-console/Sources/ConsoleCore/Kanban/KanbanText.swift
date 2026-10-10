// Les textes de la section Pipelines : la feuille de détail d'une carte, son
// menu contextuel, l'avancement, les boutons « Activité » et « Problèmes » de
// la barre d'outils et les lignes de la bulle des problèmes (phrase et geste).
// Les textes d'état des cartes viennent du vocabulaire commun (`ConsoleStatus`),
// ceux des voies de `KanbanLane`.

public enum KanbanText {
    public static let showDetails = "Afficher les détails"
    public static let close = "Fermer"
    public static let progress = "Avancement"
    public static let action = "Action"
    public static let information = "Informations"
    public static let technical = "Détails techniques"
    public static let step = "Étape"
    public static let duration = "Durée"
    /// Les deux groupes de modèle d'une feature, MÊMES mots sur Mac et iOS : le
    /// libellé d'une ligne d'affichage (fiche, carte, plan) et le titre d'un
    /// sélecteur (feuilles Nouvelle feature et Modèles).
    public static let modelReqSpecs = "Modèle /req et /specs"
    public static let modelImplReview = "Modèle /impl et /review"
    public static let modelDefault = "défaut OMP"
    public static let editModels = "Modifier les modèles…"
    public static let editModelsShort = "Modifier…"
    public static let pullRequest = "PR"
    public static let repository = "Dépôt"
    public static let activity = "Activité"
    public static let activityHelp = "Les derniers gestes envoyés depuis l’app"
    public static let problemsHelp = "Problèmes détectés dans les données des pipelines"
    /// Le bouton « Rafraîchir » de l'ardoise (Mac et iOS) : il relit l'état des
    /// PR sur GitHub ; le retour visible est le libellé des cartes.
    public static let refresh = "Rafraîchir"
    public static let refreshHelp = "Relire l’état des PR sur GitHub (⌘R)"
    public static let reply = "Répondre…"
    public static let sendMessage = "Envoyer un message…"
    /// Le motif d'une carte sans aucun geste, et celui d'une exécution sans boîte
    /// publiée : les deux coques aiguillent par `KanbanActionPresentation.motif`.
    public static let noGesture = "Aucune action possible sur cette pipeline pour l’instant."
    public static let notArmed = "Cette exécution n’accepte pas de message pour l’instant."

    // --- gestes d'une carte (S-5 à S-12), mot pour mot ceux de macOS -----------
    public static let launch = "Lancer"
    public static let resume = "Reprendre"
    public static let stop = "Arrêter…"
    public static let stopConfirm = "Arrêter"
    public static let cancel = "Annuler"
    public static let validateSpecs = "Valider les specs"
    public static let acceptReview = "Accepter la revue"
    public static let questionTitle = "Question de l’agent"
    public static let answerPlaceholder = "Autre réponse…"
    public static let replyPlaceholder = "Votre réponse"
    public static let send = "Envoyer"
    public static let stopConfirmMessage =
        "Le pilote s’arrête et les pipelines en cours dans ce dépôt sont interrompues."

    // --- deux modèles d'une feature (S-13) ------------------------------------
    public static let modelCatalogLoading = "chargement des modèles…"
    public static let modelCatalogRetry = "Réessayer"

    /// La valeur d'accessibilité de l'en-tête d'une voie repliable (iPhone et
    /// Mac) : SwiftUI n'expose pas l'état replié/déplié d'un bouton, il passe par
    /// la valeur.
    public static let laneFolded = "replié"
    public static let laneUnfolded = "déplié"

    /// Le titre de la confirmation d'arrêt : l'arrêt vise le dépôt entier.
    public static func stopConfirmTitle(repo: String) -> String {
        "Arrêter les pipelines de \(repo) ?"
    }

    /// Le motif d'un catalogue indisponible : les deux listes se réduisent à
    /// l'option par défaut, l'édition reste possible avec les valeurs courantes.
    public static func modelCatalogUnavailable(_ reason: String) -> String {
        "modèles indisponibles — \(reason)"
    }
    public static let diagnosticTitle = "Problèmes détectés"
    public static let emptyHint = "Lancez une feature avec « Nouvelle feature… » (⌘N)."

    // --- bulle des problèmes : une phrase de conséquence, puis un geste ---------
    // Aucune phrase ne cite de fichier, de pid ni de format : le détail brut de
    // chaque anomalie (`KanbanAnomaly.detail`) ne sort que par « Copier le
    // diagnostic » (`diagnosticReport`).
    public static let anomalyUnreadable =
        "Les données d’une pipeline sont illisibles : elle peut manquer au tableau ou y paraître incomplète."
    public static let anomalyUnreadableGesture =
        "Copiez le diagnostic pour retrouver le fichier en cause, puis réparez-le ou supprimez-le."
    public static let anomalyDeadRunGesture = "Relancez-la depuis OMP, dans son dépôt."
    public static let anomalyDeadLotNothingToResume =
        "Aucune de ses pipelines n’attend de reprise : rien n’est à relancer."
    public static let anomalyDuplicateGesture =
        "Copiez le diagnostic pour retrouver les deux fichiers, puis supprimez celui qui est en trop."

    /// Un run dont le propriétaire est mort ; `label` est le nom de la pipeline,
    /// celui que porte sa carte.
    public static func anomalyDeadRun(label: String) -> String {
        "\(label) s’est arrêtée de façon inattendue et n’avance plus."
    }

    /// Un lot dont le pilote est mort ; `repo` est le nom du dépôt.
    public static func anomalyDeadLot(repo: String) -> String {
        "Le pilote de \(repo) s’est arrêté : ses pipelines n’avancent plus."
    }

    /// Deux sources pour une même pipeline, nommée quand l'identité en désigne une.
    public static func anomalyDuplicate(name: String?) -> String {
        guard let name else { return "Deux sources décrivent la même pipeline. Le tableau n’en montre qu’une." }
        return "Deux sources décrivent la même pipeline : \(name). Le tableau n’en montre qu’une."
    }

    /// Le texte de « Copier le diagnostic » de la bulle : le détail brut de chaque
    /// anomalie, une par ligne, dans l'ordre de la bulle.
    public static func diagnosticReport(_ anomalies: [KanbanAnomaly]) -> String {
        anomalies.map(\.detail).joined(separator: "\n")
    }

    /// L'état vide de la section Pipelines, quand aucune pipeline n'existe : le
    /// même mot pour les deux coques (l'iOS ne peut pas afficher `emptyHint`, qui
    /// nomme un raccourci macOS).
    public static let noPipeline = "Aucune pipeline pour l’instant."

    /// Les cinq étapes de l'avancement, dans l'ordre de la pipeline.
    public static let progressSteps = ["Besoins", "Spécifications", "Implémentation", "Revue", "PR"]

    public static func marks(_ text: String) -> String { "Marques : \(text)" }

    /// La phrase lisible d'une marque, pour une carte de l'iOS : jamais la marque
    /// brute (`KanbanMark.rawValue`).
    public static func markSentence(_ mark: KanbanMark) -> String {
        switch mark {
        case .mort: return "Elle s’est arrêtée de façon inattendue."
        case .illisible: return "Une partie de ses données est illisible."
        case .doublon: return "Deux sources la décrivent."
        }
    }

    /// Les phrases des marques d'une carte, dans l'ordre des marques, jointes par
    /// une espace ; `nil` pour une carte saine (aucune ligne affichée).
    public static func marksSentence(_ marks: [KanbanMark]) -> String? {
        marks.isEmpty ? nil : marks.map(markSentence).joined(separator: " ")
    }

    /// La forme canonique d'une paire de modèles :
    /// `Modèle /req et /specs : <A> · Modèle /impl et /review : <B>` (un groupe
    /// vide s'affiche « défaut OMP »). Formule unique partagée par le plan du
    /// projet des deux coques.
    public static func modelsLine(_ models: ModelSlots) -> String {
        let reqSpecs = KanbanCardPresentation.modelLine(modelReqSpecs, models.reqSpecs)
        let implReview = KanbanCardPresentation.modelLine(modelImplReview, models.implReview)
        return "\(reqSpecs) · \(implReview)"
    }

    /// « 1 problème », « 3 problèmes » : le libellé du bouton de la barre d'outils.
    public static func problems(_ n: Int) -> String { ConsoleFormat.count(n, "problème", "problèmes") }
}
