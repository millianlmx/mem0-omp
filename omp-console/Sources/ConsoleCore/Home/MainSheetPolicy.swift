// La politique des feuilles (S-4, S-5) — ici, la SEULE partie partagée : la zone à
// laquelle la feuille « Répondre » répond. Le calcul de la feuille due (qui nomme
// `SetupState` et `ContractSheet`, types de la coque macOS) reste déclaré par la
// coque, en extension, dans `Sources/OMPConsole/Home/MainSheet.swift`.
//
// VIT DANS `ConsoleCore` : les deux coques répondent au MÊME aiguillage.

import Foundation

public enum MainSheetPolicy {
    /// La zone à laquelle la feuille « Répondre » répond : une question en vol ou
    /// une question en texte, sinon aucune.
    public static func answerZone(for card: KanbanCard) -> KanbanActionZone? {
        KanbanActionPresentation.zones(for: card).first { zone in
            switch zone {
            case .pendingQuestion, .textQuestion: true
            default: false
            }
        }
    }
}
