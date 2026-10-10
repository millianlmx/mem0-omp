// L'état publié par le modèle d'alertes, que l'item de barre de menus recopie
// (S-6 de accueil-en-cours-melange-pause-et-compte).
//
// SOURCE UNIQUE : `AlertsStatus.from(boardState:)` compte l'ardoise de
// `KanbanBoardState.derive` avec `HomePresentation.counts`, c'est-à-dire les listes
// « À vous » et « En cours » de l'Accueil (`HomePresentation.dashboard`). Le chiffre
// de la barre et les sections de l'Accueil ne peuvent donc pas diverger (AC-7) ; les
// cartes en pause et les features pas commencées ne comptent jamais.

import ConsoleCore
import Foundation

/// « rien de reçu encore », « magasin absent », ou les comptes de l'Accueil.
/// « absent » et « zéro » sont DEUX états distincts (convention
/// `StoreAvailability`) : `.storeEmpty` vaut `.ready(.zero)`.
enum AlertsStatus: Sendable, Equatable {
    case loading
    case storeAbsent(dir: String)
    case ready(HomeCounts)

    /// Les comptes, quand ils sont connus ; `nil` pour `.loading` et `.storeAbsent`.
    var counts: HomeCounts? {
        if case .ready(let counts) = self { return counts }
        return nil
    }

    /// Dérivé de `KanbanBoardState.derive` — aucune seconde règle de rangement.
    /// `derive` ne rend jamais `.loading` : cet état n'est que l'état INITIAL du
    /// modèle, avant le premier instantané.
    static func from(boardState: KanbanBoardState) -> AlertsStatus {
        switch boardState {
        case .loading: .loading
        case .storeAbsent(let dir): .storeAbsent(dir: dir)
        case .storeEmpty: .ready(.zero)
        case .board(let board): .ready(HomePresentation.counts(board))
        }
    }
}
