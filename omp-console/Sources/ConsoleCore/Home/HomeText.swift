// TOUS les textes de l'Accueil (S-5 de omp-console-redesign), en UN endroit
// (convention `ActionsText`) : la vue affiche, elle ne compose jamais une phrase.

import Foundation

public enum HomeText {
    // --- première fois --------------------------------------------------------
    public static let firstRunTitle = "Lancez votre première feature"
    public static let firstRunBody =
        "Décrivez un besoin : OMP le clarifie avec vous, le spécifie, l'implémente et ouvre la PR. Vous répondez et validez depuis l'app."
    public static let newFeature = "Nouvelle feature…"

    // --- bienvenue ------------------------------------------------------------
    public static let welcomeTitle = "Bienvenue dans OMP Console"
    public static let welcomePromises: [HomePromise] = [
        HomePromise(
            symbol: "text.bubble",
            title: "Décrivez un besoin",
            detail: "OMP le clarifie avec vous, puis le spécifie."
        ),
        HomePromise(
            symbol: "checkmark.bubble",
            title: "Répondez et validez",
            detail: "Les questions et les jalons arrivent ici."
        ),
        HomePromise(
            symbol: "arrow.triangle.pull",
            title: "Recevez la pull request",
            detail: "OMP implémente, relit et ouvre la PR."
        ),
    ]
    /// Le seul bouton de la bienvenue : ↩ et Échap la ferment aussi.
    public static let welcomeContinue = "Continuer"
    /// Aide ▸ « Bienvenue dans OMP Console ».
    public static let welcomeMenuItem = "Bienvenue dans OMP Console"

    // --- notifications désactivées --------------------------------------------
    public static let notificationsDenied = "Les notifications sont désactivées."
    public static let openSettings = "Ouvrir les Réglages"
    public static let ignore = "Ignorer"

    // --- tableau de bord ------------------------------------------------------
    public static let attentionHeader = "À vous"
    public static let runningHeader = "En cours"
    public static let deliveredTitle = "Livrées récemment"
    public static let attentionEmpty = "Rien ne vous attend."
    public static let runningEmpty = "Aucune pipeline en cours."
    public static let deliveredEmpty = "Aucune PR livrée pour l'instant."
    public static let allPipelines = "Tout afficher"
    public static let questionWithoutText = "L'agent attend une réponse."
    public static let specsPrompt = "Validez les specs pour lancer l'implémentation."
    public static let reviewPrompt = "Acceptez la revue pour publier la PR."
    public static let answerEllipsis = "Répondre…"
    /// Le champ libre à côté des options (jamais « ou … » en minuscule).
    public static let answerOtherPlaceholder = "Autre réponse…"
    /// Le champ d'une question sans option.
    public static let answerPlaceholder = "Votre réponse"
    public static let openInPipelines = "Voir dans Pipelines"
    public static let openPR = "Ouvrir la PR"
    public static let dismiss = "Masquer"

}

/// Une promesse de la bienvenue : un symbole, un titre, une phrase.
public struct HomePromise: Equatable, Sendable {
    public let symbol: String
    public let title: String
    public let detail: String

    public init(symbol: String, title: String, detail: String) {
        self.symbol = symbol
        self.title = title
        self.detail = detail
    }
}
