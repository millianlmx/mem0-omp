// Ce que la coque garde des textes de l'Accueil : les trois fonctions qui
// NOMMENT un type de la coque (`HomeAttentionNature`, `KanbanCard`,
// `ActionJournalState`). Les constantes et `HomePromise` vit dans
// `ConsoleCore/Home/HomeText.swift` — un texte, un seul endroit.

import ConsoleCore

extension HomeText {
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
