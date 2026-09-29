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
}
