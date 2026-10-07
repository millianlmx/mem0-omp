import ConsoleCore

/// La nature d'une réponse à une question (corps de `POST /v1/cards/:id/answer`) :
/// le nom du cas EST la valeur du contrat (`selected` / `custom`), aucune seconde
/// écriture du littéral.
enum PipelinesAnswerKind: String {
    case selected
    case custom
}

/// Le verdict d'un jalon (corps de `POST /v1/cards/:id/verdict`).
enum PipelinesVerdict: String {
    case specs
    case review
}

extension LotWaitKind {
    /// Le verdict à envoyer pour valider ce jalon, `nil` pour une question simple.
    var verdict: String? {
        switch self {
        case .specs: return PipelinesVerdict.specs.rawValue
        case .review: return PipelinesVerdict.review.rawValue
        case .answer: return nil
        }
    }
}

/// Un geste offert par la feuille d'une carte (S-5). La liste des gestes offerts
/// est une FONCTION PURE de la carte — la même règle d'aiguillage que macOS
/// (`KanbanActionPresentation.zones(for:)`), étendue par les deux gestes que
/// l'app ajoute : « Lancer » (S-8) et « Fusionner » (S-12).
enum PipelinesGesture: Equatable {
    case answerQuestion(toolCallId: String, question: String, options: [PanelAskOption])
    case answerText(prompt: String?)
    case validateMilestone(kind: LotWaitKind)
    case resume
    case stop
    case launch
    case openPR
    case merge
}

extension PipelinesGesture {
    /// Les gestes d'une carte, DANS L'ORDRE de S-5. Le geste `.steer` de macOS
    /// (message à un run vivant sans question) N'EST PAS offert : il est hors des
    /// sept gestes de B-2.
    static func gestures(of card: KanbanCard) -> [PipelinesGesture] {
        let zones = KanbanActionPresentation.zones(for: card)
        var gestures: [PipelinesGesture] = []
        for zone in zones {
            switch zone {
            case .pendingQuestion(let toolCallId, let question, let options):
                gestures.append(.answerQuestion(toolCallId: toolCallId, question: question, options: options))
            case .textQuestion(_, let prompt):
                gestures.append(.answerText(prompt: prompt))
            case .milestone(_, let kind):
                gestures.append(.validateMilestone(kind: kind))
            case .resume:
                gestures.append(.resume)
            case .stopLot:
                gestures.append(.stop)
            case .steer:
                continue
            }
        }
        let hasResume = zones.contains { if case .resume = $0 { return true } else { return false } }
        if card.column == .enAttente, card.action?.repoRoot != nil, !hasResume {
            gestures.append(.launch)
        }
        if httpURL(card.prUrl ?? "") != nil {
            gestures.append(.openPR)
            if card.action?.slug != nil, card.action?.repoKey != nil {
                gestures.append(.merge)
            }
        }
        return gestures
    }

    /// Le motif d'une carte sans aucun geste — le mot de macOS, jamais recomposé.
    static func motif(of card: KanbanCard) -> String? {
        gestures(of: card).isEmpty ? (KanbanActionPresentation.motif(for: card) ?? KanbanText.noGesture) : nil
    }
}
