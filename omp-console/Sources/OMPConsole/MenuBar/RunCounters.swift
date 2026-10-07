// Les deux compteurs de l'app et l'état publié qui les porte (BR-3, S-1).
//
// SOURCE UNIQUE : `RunCounters.of(board:)` compte les cartes de l'ardoise que la
// fenêtre affiche (`KanbanBoard.build`), et `AlertsStatus.from(boardState:)` la
// dérive de l'état publié par `KanbanBoardState.derive`. La bande de la fenêtre
// (S-9) et l'item de barre (S-2) lisent donc le MÊME objet : leurs chiffres ne
// peuvent pas diverger (AC-7).

import ConsoleCore
import Foundation

/// « runs occupés » et « runs en attente » : deux catégories EXCLUSIVES (une carte
/// est rangée dans exactement une colonne, S-1 du Kanban).
struct RunCounters: Sendable, Equatable {
    var busy: Int
    var waiting: Int

    static let zero = RunCounters(busy: 0, waiting: 0)

    /// Compte les cartes de l'ardoise : `en-cours` pour « occupés »,
    /// `question-en-vol`/`jalon-specs`/`jalon-review` pour « en attente ». Les autres
    /// colonnes ne sont comptées nulle part — la colonne « En attente » du Kanban
    /// (features `pending`, non lancées) n'est PAS ce compteur.
    static func of(board: KanbanBoard) -> RunCounters {
        var busy = 0
        var waiting = 0
        for card in board.cards {
            switch card.column {
            case .enCours: busy += 1
            case .questionEnVol, .jalonSpecs, .jalonReview: waiting += 1
            default: break
            }
        }
        return RunCounters(busy: busy, waiting: waiting)
    }
}

/// L'état publié par le modèle d'alertes : « rien de reçu encore », « magasin
/// absent », ou les compteurs. « absent » et « zéro » sont DEUX états distincts
/// (convention `StoreAvailability`) : `.storeEmpty` vaut `.ready(.zero)`.
enum AlertsStatus: Sendable, Equatable {
    case loading
    case storeAbsent(dir: String)
    case ready(RunCounters)

    /// Les compteurs, quand ils sont connus ; `nil` pour `.loading` et `.storeAbsent`.
    var counters: RunCounters? {
        if case .ready(let counters) = self { return counters }
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
        case .board(let board): .ready(RunCounters.of(board: board))
        }
    }
}
