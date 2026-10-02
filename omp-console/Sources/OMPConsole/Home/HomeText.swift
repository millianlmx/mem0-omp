// TOUS les textes de l'Accueil (S-5 de omp-console-redesign), en UN endroit
// (convention `ActionsText`) : la vue affiche, elle ne compose jamais une phrase.

import Foundation

enum HomeText {
    // --- première fois --------------------------------------------------------
    static let firstRunTitle = "Lancez votre première feature"
    static let firstRunBody =
        "Décrivez un besoin : OMP le clarifie avec vous, le spécifie, l'implémente et ouvre la PR. Vous répondez et validez depuis l'app."
    static let newFeature = "Nouvelle feature…"

    // --- bienvenue ------------------------------------------------------------
    static let welcomeTitle = "Bienvenue dans OMP Console"
    static let welcomePromises: [HomePromise] = [
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
    static let welcomeContinue = "Continuer"
    /// Aide ▸ « Bienvenue dans OMP Console ».
    static let welcomeMenuItem = "Bienvenue dans OMP Console"

    // --- OMP requis -----------------------------------------------------------
    static let ompMissingTitle = "OMP est requis"
    static let ompMissingBody =
        "OMP Console pilote vos pipelines à travers OMP, introuvable sur ce Mac. Installez OMP, ou indiquez où il se trouve, puis vérifiez à nouveau."
    static let searchedDisclosure = "Détails"
    static let searchedIntro = "Emplacements cherchés :"
    static let stillMissing = "OMP est toujours introuvable."
    static let chosenNotExecutable = "Ce fichier n'est pas un programme. Choisissez le programme omp."
    static let recheck = "Vérifier à nouveau"
    static let chooseLocation = "Choisir l'emplacement…"
    static let chooseLocationPrompt = "Choisir"
    static let chooseLocationMessage = "Choisissez le programme omp."
    static let quit = "Quitter"

    // --- notifications désactivées --------------------------------------------
    static let notificationsDenied = "Les notifications sont désactivées."
    static let openSettings = "Ouvrir les Réglages"
    static let ignore = "Ignorer"

    // --- tableau de bord ------------------------------------------------------
    static let attentionHeader = "À vous"
    static let runningHeader = "En cours"
    static let deliveredTitle = "Livrées récemment"
    static let attentionEmpty = "Rien ne vous attend."
    static let runningEmpty = "Aucune pipeline en cours."
    static let deliveredEmpty = "Aucune PR livrée pour l'instant."
    static let allPipelines = "Tout afficher"
    static let questionWithoutText = "L'agent attend une réponse."
    static let specsPrompt = "Validez les specs pour lancer l'implémentation."
    static let reviewPrompt = "Acceptez la revue pour publier la PR."
    static let answerEllipsis = "Répondre…"
    /// Le champ libre à côté des options (jamais « ou … » en minuscule).
    static let answerOtherPlaceholder = "Autre réponse…"
    /// Le champ d'une question sans option.
    static let answerPlaceholder = "Votre réponse"
    static let openInPipelines = "Voir dans Pipelines"
    static let openPR = "Ouvrir la PR"
    static let dismiss = "Masquer"

    static func natureText(_ nature: HomeAttentionNature) -> String {
        switch nature {
        case .question: "Question"
        case .milestoneSpecs: "Specs à valider"
        case .milestoneReview: "Revue à accepter"
        }
    }

    /// La ligne sous le titre d'une carte : « <dépôt> · <étape> ». Le dépôt n'y
    /// figure que si `showsRepo` (plusieurs dépôts à l'écran) ; sans étape,
    /// `noPhase` prend sa place. Rien à dire ⇒ `nil`, la ligne disparaît.
    static func cardSubtitle(_ card: KanbanCard, noPhase: String?, showsRepo: Bool) -> String? {
        let detail = card.phase.map(PhaseText.title) ?? noPhase
        let parts = [showsRepo ? card.repo : nil, detail].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // --- bandeau de lancement -------------------------------------------------
    /// Le texte du bandeau pour l'état de la commande `launch` de titre `title`.
    static func launchBanner(title: String, state: ActionJournalState) -> String {
        switch state {
        case .awaitingAck:
            "Lancement de « \(title) »…"
        case .taken:
            "Pipeline « \(title) » lancée : la collecte des besoins démarre."
        case .refused(let reason?):
            "Lancement de « \(title) » refusé : \(reason)"
        case .refused(nil):
            "Lancement de « \(title) » refusé."
        case .failed(let reason):
            "Lancement de « \(title) » impossible : \(reason)"
        case .unacknowledged:
            "Lancement de « \(title) » : \(ActionsText.unacknowledged)"
        case .delivered:
            // Une commande n'est jamais « déposée » comme une livraison : ce cas
            // n'arrive pas pour un lancement ; l'état brut reste lisible.
            "Lancement de « \(title) » : \(ActionsText.delivered)"
        }
    }
}

/// Une promesse de la bienvenue : un symbole, un titre, une phrase.
struct HomePromise: Equatable {
    let symbol: String
    let title: String
    let detail: String
}
