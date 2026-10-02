// La feuille de la fenêtre principale (S-4, S-5 de omp-console-redesign) : UNE
// seule à la fois (HIG « Display only one sheet at a time »), déduite de l'état
// par une fonction PURE. La racine la présente par `.sheet(item:)` : quand la
// valeur change, la feuille est remplacée ; quand elle devient `nil`, elle se
// ferme d'elle-même.

import Foundation

enum MainSheet: Identifiable, Equatable {
    case ompRequired
    case welcome
    case newFeature
    case answer(cardID: String)

    var id: String {
        switch self {
        case .ompRequired: "ompRequired"
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

    /// La feuille due, dans l'ordre des règles : (1) OMP introuvable ; (2) la
    /// bienvenue redemandée ; (3) la bienvenue jamais vue sur un magasin absent ou
    /// vide ; (4) « Nouvelle feature » ; (5) « Répondre » tant que la carte existe et
    /// attend une réponse ; (6) aucune.
    static func sheet(
        omp: OmpStatus,
        board: KanbanBoardState,
        welcomeSeen: Bool,
        welcomeRequested: Bool,
        launchFormShown: Bool,
        answerCardID: String?
    ) -> MainSheet? {
        if case .missing = omp { return .ompRequired }
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
