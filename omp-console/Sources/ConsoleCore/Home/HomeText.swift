// TOUS les textes de l'Accueil (S-5 de omp-console-redesign), en UN endroit
// (convention `ActionsText`) : la vue affiche, elle ne compose jamais une phrase.

import Foundation

public enum HomeText {
    // --- première fois --------------------------------------------------------
    public static let firstRunTitle = "Lancez votre première feature"
    public static let firstRunBody =
        "Décrivez un besoin : OMP le clarifie avec vous, le spécifie, l’implémente et ouvre la PR. Vous répondez et validez depuis l’app."
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
            title: "Recevez la PR",
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
    public static let deliveredEmpty = "Aucune PR livrée pour l’instant."
    public static let allPipelines = "Tout afficher"
    public static let questionWithoutText = "L’agent attend une réponse."
    public static let specsPrompt = "Validez les spécifications pour lancer l’implémentation."
    public static let reviewPrompt = "Acceptez la revue pour publier la PR."
    public static let answerEllipsis = "Répondre…"
    /// Le champ libre à côté des options (jamais « ou … » en minuscule).
    public static let answerOtherPlaceholder = "Autre réponse…"
    /// Le champ d'une question sans option.
    public static let answerPlaceholder = "Votre réponse"
    public static let openInPipelines = "Voir dans Pipelines"
    public static let openPR = "Ouvrir la PR"
    public static let dismiss = "Masquer"

    // --- natures et composition d'une carte (S-3) -----------------------------

    /// Le mot d'une nature d'attente.
    public static func natureText(_ nature: HomeAttentionNature) -> String {
        switch nature {
        case .question: "Question"
        case .milestoneSpecs: "Spécifications à valider"
        case .milestoneReview: "Revue à accepter"
        }
    }

    /// La ligne sous le titre d'une carte : « <dépôt> · <étape> ». Le dépôt n'y
    /// figure que si `showsRepo` (plusieurs dépôts à l'écran) ; sans étape,
    /// `noPhase` prend sa place. Rien à dire ⇒ `nil`, la ligne disparaît.
    public static func cardSubtitle(_ card: KanbanCard, noPhase: String?, showsRepo: Bool) -> String? {
        let detail = card.phase.map(PhaseText.title) ?? noPhase
        let parts = [showsRepo ? card.repo : nil, detail].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // --- bandeau de lancement -------------------------------------------------

    /// Le texte du bandeau pour l'état de la commande `launch` de titre `title`.
    public static func launchBanner(title: String, state: ActionJournalState) -> String {
        switch state {
        case .awaitingAck:
            "Lancement de « \(title) »…"
        case .taken:
            "Pipeline « \(title) » lancée : la collecte des besoins démarre."
        case .refused(let reason?):
            "Lancement de « \(title) » refusé : \(reason)"
        case .refused(nil):
            "Lancement de « \(title) » refusé."
        case .failed(let reason):
            "Lancement de « \(title) » impossible : \(reason)"
        case .unacknowledged:
            "Lancement de « \(title) » : \(ActionsText.unacknowledged)"
        case .delivered:
            // Une commande n'est jamais « déposée » comme une livraison : ce cas
            // n'arrive pas pour un lancement ; l'état brut reste lisible.
            "Lancement de « \(title) » : \(ActionsText.delivered)"
        }
    }
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
