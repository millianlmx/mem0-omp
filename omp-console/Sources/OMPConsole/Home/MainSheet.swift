// La feuille de la fenêtre principale (S-4, S-5) : UNE seule à la fois (HIG
// « Display only one sheet at a time »), déduite de l'état par une fonction PURE.
// La racine la présente par `.sheet(item:)` : quand la valeur change, la feuille
// est remplacée ; quand elle devient `nil`, elle se ferme d'elle-même.
//
// La préparation (`.setup`) passe AVANT tout le reste : l'app installe ses
// composants, migre la base mémoire et monte sa pile (S-1, S-3, S-2) ; les gestes
// qui en dépendent n'ont pas de sens avant. Fermer la feuille ne l'interrompt pas
// (l'Accueil reprend le fil avec son bandeau, règle 2 comprise).

import Foundation

enum MainSheet: Identifiable, Equatable {
    case setup
    case welcome
    case newFeature
    case answer(cardID: String)

    var id: String {
        switch self {
        case .setup: "setup"
        case .welcome: "welcome"
        case .newFeature: "newFeature"
        case .answer(let cardID): "answer.\(cardID)"
        }
    }
}

enum MainSheetPolicy {
    /// La zone à laquelle la feuille « Répondre » répond : une question en vol ou
    /// une question en texte, sinon aucune.
    static func answerZone(for card: KanbanCard) -> KanbanActionZone? {
        KanbanActionPresentation.zones(for: card).first { zone in
            switch zone {
            case .pendingQuestion, .textQuestion: true
            default: false
            }
        }
    }

    /// La feuille due, dans l'ordre FIGÉ de S-5 :
    /// 1. préparation en cours (ou en échec) et feuille non ignorée → `.setup` ;
    /// 2. composant OMP manquant et feuille non ignorée → `.setup` ;
    /// 3. la bienvenue redemandée → `.welcome` ;
    /// 4. la bienvenue jamais vue sur un magasin absent ou vide → `.welcome` ;
    /// 5. « Nouvelle feature » → `.newFeature` ;
    /// 6. « Répondre » tant que la carte existe et attend une réponse ;
    /// 7. aucune.
    static func sheet(
        omp: OmpStatus,
        setup: SetupState,
        setupDismissed: Bool,
        board: KanbanBoardState,
        welcomeSeen: Bool,
        welcomeRequested: Bool,
        launchFormShown: Bool,
        answerCardID: String?
    ) -> MainSheet? {
        switch setup {
        case .idle, .preparing, .failed:
            if !setupDismissed { return .setup }
        case .ready:
            break
        }
        if case .missing = omp, !setupDismissed { return .setup }
        if welcomeRequested { return .welcome }
        if !welcomeSeen {
            switch board {
            case .storeAbsent, .storeEmpty: return .welcome
            case .loading, .board: break
            }
        }
        if launchFormShown { return .newFeature }
        if let id = answerCardID, let card = board.card(id), answerZone(for: card) != nil {
            return .answer(cardID: id)
        }
        return nil
    }
}
