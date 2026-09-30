// TOUS les textes affichés par la vue « Projet » (S-1 … S-10, BR-3) : un seul
// endroit à corriger, et des constantes pures donc testables sans UI.
//
// Aucun de ces textes n'est un message d'ÉCHEC de session : ceux-là viennent de
// `SessionHostError.userMessage`, seule table de traduction des erreurs du host.

import Foundation

enum ProjectViewText {
    // MARK: - États de la fenêtre

    static let emptyTitle = "Aucune conduite en cours."
    static let emptyHelp = "Choisissez un dépôt pour conduire un projet de bout en bout depuis l'app."
    static let notGitRepository = "Ce dossier n'est pas un dépôt git."
    static let docMissing = "PROJECT.md n'est pas encore publié."
    static let projectMissing = "Projet introuvable dans le magasin d'état."
    static let sessionStarting = "Lancement de la session…"
    static let sessionClosing = "Arrêt de la session…"
    static let waitingBanner = "Le projet attend votre réponse."
    static let refusalTitle = "Conduite déjà en cours"

    // MARK: - Bannières paramétrées

    static func refusal(name: String, path: String) -> String {
        "Une conduite est déjà en cours sur « \(name) » (\(path)). Clore la conduite courante avant d'en démarrer une autre."
    }

    static func doneBanner(m: Int, n: Int) -> String {
        "Projet terminé — \(m)/\(n) feature(s) fusionnée(s)."
    }

    static func waitingCount(_ n: Int) -> String {
        n > 1 ? "\(n) dialogues en attente" : "1 dialogue en attente"
    }

    // MARK: - Libellés de l'en-tête

    static let launchTitle = "Conduire un projet"
    static let launchRepository = "Dépôt"
    static let launchName = "Nom du projet"
    static let launchConduire = "Conduire"
    static let launchCancel = "Annuler"
    static let closeConduite = "Clore la conduite"
    static let chooseRepository = "Choisir…"
    static let startConduite = "Conduire un projet…"

    static let repositoryPlaceholder = "Aucun dépôt choisi."
    static let namePlaceholder = "Nom du projet"

    // MARK: - Vocabulaire d'état (parité avec les labels du pilote)

    static let statusDone = "terminé"
    static let statusRunning = "en cours"
    static let statusStopped = "arrêté"

    static let featurePlanned = "à venir"
    static let featureLaunched = "lancée"
    static let featurePR = "PR ouverte"
    static let featureMerged = "fusionnée"
    static let featureRemoved = "retirée"
    static let featureFailed = "en échec"

    static let segmentMerged = "fusionné"
    static let segmentCurrent = "en cours"
    static let segmentUpcoming = "à venir"

    // MARK: - États de ligne

    static let noPR = "—"
    static let noModel = "—"
    static let removedTitle = "Features retirées"
    static let emptyPlan = "Le plan n'est pas encore publié."

    // MARK: - Volet « PR et CI » (BR-3)

    static let prPaneTitle = "PR et CI"
    static let prEmpty = "Aucune PR ouverte pour ce projet."
    static let prLoading = "Lecture des statuts…"
    static let prUnknownSuffix = " (lecture en cours)"
    static let prStaleSuffix = " (périmé)"
    static let prOpen = "Ouvrir la PR"
    static let prMerge = "Fusionner…"
    static let prMergeHelp = "Fusion indisponible : les trois statuts requis doivent être verts."
    static let prMergeConfirmButton = "Fusionner"
    static let prMergeCancelButton = "Annuler"

    /// Le message de lecture, préfixe du `userMessage` d'une `GhError` (S-7).
    static func prUnavailable(_ message: String) -> String {
        "Statuts indisponibles : \(message)"
    }

    /// Une ligne de statut : « <nom> : <état> ».
    static func prCheckLine(name: String, state: String) -> String {
        "\(name) : \(state)"
    }

    /// Le libellé du lien d'un run rouge : « run <identifiant> ».
    static func prRunLink(_ identifier: String) -> String {
        "run \(identifier)"
    }

    /// L'ouverture est refusée quand l'adresse n'est pas http(s) (S-4).
    static func prNotOpenable(url: String) -> String {
        "L'adresse de cette PR n'est pas ouvrable dans un navigateur : \(url)."
    }

    static func prOpenFailed(number: Int?) -> String {
        guard let number else { return "L'ouverture de la PR dans le navigateur a échoué." }
        return "L'ouverture de la PR #\(number) dans le navigateur a échoué."
    }

    /// Le refus d'une fusion dont les statuts frais ne sont pas tous verts (S-5).
    static func prMergeRefused(number: Int?) -> String {
        guard let number else { return "Fusion refusée : les trois statuts requis ne sont pas verts." }
        return "Fusion refusée : les trois statuts requis ne sont pas verts (PR #\(number))."
    }

    /// L'échec d'une fusion refusée par GitHub (S-6).
    static func prMergeRejected(detail: String, number: Int?) -> String {
        guard let number else { return "Fusion refusée par GitHub : \(detail)." }
        return "Fusion refusée par GitHub : \(detail) (PR #\(number))."
    }

    static func prMergeConfirmTitle(number: Int?) -> String {
        guard let number else { return "Fusionner cette PR ?" }
        return "Fusionner la PR #\(number) ?"
    }

    static func prMergeConfirmMessage(title: String) -> String {
        "\(title) — les trois statuts requis sont verts."
    }
}
