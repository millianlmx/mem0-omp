// L'avancement d'une carte (S-14 de omp-console-redesign) : les cinq étapes de la
// pipeline, chacune faite, en cours, à venir ou en échec. Fonction PURE de la
// carte — l'inspecteur la rend, le test la vérifie sans vue.

import ConsoleCore

/// L'état d'une étape de l'avancement.

enum PipelineStepState: Equatable {
    case done, current, upcoming, failed
}

/// Une étape de l'avancement : son titre et son état.
struct PipelineStep: Equatable {
    var title: String
    var state: PipelineStepState
}

enum PipelineProgress {
    /// Les cinq étapes (`KanbanText.progressSteps`) d'une carte. L'étape courante
    /// vient du jalon attendu, sinon du maillon ; l'issue de la carte (fusionnée,
    /// PR ouverte ou créée, PR fermée ou terminée, annulée, en échec) décide du
    /// reste. Les règles s'appliquent dans cet ordre.
    static func steps(for card: KanbanCard) -> [PipelineStep] {
        let titles = KanbanText.progressSteps
        func all(_ state: (Int) -> PipelineStepState) -> [PipelineStep] {
            titles.indices.map { PipelineStep(title: titles[$0], state: state($0)) }
        }
        switch card.column {
        case .fusionne:
            return all { _ in .done }
        case .prOuverte, .prCreee:
            return all { $0 < 4 ? .done : .current }
        case .termineeSansPr, .prFermee:
            return all { $0 < 4 ? .done : .upcoming }
        default:
            break
        }
        guard let current = currentIndex(of: card) else {
            return all { _ in .upcoming }
        }
        if card.column == .annuleeRetiree {
            return all { $0 < current ? .done : .upcoming }
        }
        let failed = (card.column == .echec || card.column == .bloquee)
            && !KanbanActionPresentation.resumable(card)
        return all { index in
            if index < current { return .done }
            if index > current { return .upcoming }
            return failed ? .failed : .current
        }
    }

    /// L'index de l'étape courante : le jalon attendu d'abord, sinon le maillon ;
    /// `nil` quand la carte n'en porte aucun.
    private static func currentIndex(of card: KanbanCard) -> Int? {
        switch card.column {
        case .jalonSpecs: return 1
        case .jalonReview: return 3
        default: break
        }
        switch card.phase {
        case .req: return 0
        case .specs: return 1
        case .impl: return 2
        case .review: return 3
        case .release: return 4
        case nil: return nil
        }
    }
}
