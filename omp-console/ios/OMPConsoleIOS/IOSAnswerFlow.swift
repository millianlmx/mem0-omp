// Le flux pur de la réponse à une carte depuis l'iPhone (feature
// reponse-ios-sans-identifiant-de-question, S-4 et S-5) : la question figée que
// la feuille affiche, le brouillon de saisie, et l'issue d'un envoi refusé parce
// que la question a changé ou n'attend plus de réponse. Les feuilles Répondre de
// l'Accueil et la fiche Pipelines s'y appuient toutes deux ; aucune vue ici.

import ConsoleClient
import ConsoleCore
import Foundation

/// La question en vol d'une carte, telle que la feuille l'affiche et y répond.
struct IOSAnswerQuestion: Equatable, Sendable {
    let toolCallId: String
    let question: String
    let options: [PanelAskOption]

    init(toolCallId: String, question: String, options: [PanelAskOption]) {
        self.toolCallId = toolCallId
        self.question = question
        self.options = options
    }

    /// La question en vol de la carte, ou nil (carte absente, sans zone de réponse,
    /// ou question en TEXTE, qui ne passe pas par la route `answer`).
    init?(card: KanbanCard?) {
        guard let card,
              case .pendingQuestion(let toolCallId, let question, let options)? = MainSheetPolicy.answerZone(for: card)
        else { return nil }
        self.init(toolCallId: toolCallId, question: question, options: options)
    }
}

/// Le choix envoyé : une option de la question, ou un texte libre.
enum IOSAnswerChoice: Equatable, Sendable {
    case option(String)
    case custom(String)
}

/// L'état de saisie d'une feuille de réponse. Invariant : `adopt` ne touche
/// jamais `text`.
struct IOSAnswerDraft: Equatable {
    private(set) var question: IOSAnswerQuestion?
    var selectedOption: String?
    var text: String
    private(set) var notice: String?

    init(question: IOSAnswerQuestion?) {
        self.question = question
        self.selectedOption = nil
        self.text = ""
        self.notice = nil
    }

    /// Passe à la question qui a remplacé celle affichée : bandeau « la question
    /// a changé », sélection gardée seulement si son libellé existe encore, texte
    /// saisi conservé.
    mutating func adopt(_ newQuestion: IOSAnswerQuestion) {
        question = newQuestion
        notice = IOSHomeText.answerQuestionChanged
        if let selected = selectedOption, !newQuestion.options.contains(where: { $0.label == selected }) {
            selectedOption = nil
        }
    }

    /// Ce que « Envoyer » enverrait : l'option choisie d'abord, sinon le texte tel
    /// que saisi s'il n'est pas blanc, sinon rien (envoi désactivé).
    var choice: IOSAnswerChoice? {
        if let selectedOption { return .option(selectedOption) }
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .custom(text) }
        return nil
    }
}

/// L'issue d'un envoi.
enum IOSAnswerOutcome {
    /// Le Mac a accepté la réponse.
    case delivered
    /// Le Mac a refusé : la carte porte désormais une autre question en vol.
    case questionChanged(IOSAnswerQuestion)
    /// Le Mac a refusé : la carte n'a plus de question en vol (ou n'existe plus).
    case questionGone
    /// Tout autre échec, refus inexpliqué par un changement de question compris.
    case failed(any Error)
}

@MainActor
enum IOSAnswerFlow {
    /// Envoie `choice` à `question` (son identifiant, jamais une relecture), puis,
    /// si le Mac juge la question périmée, relit la carte pour dire ce qui l'attend.
    static func submit(
        question: IOSAnswerQuestion,
        choice: IOSAnswerChoice,
        send: @MainActor (_ toolCallId: String, _ choice: IOSAnswerChoice) async throws -> Void,
        reread: @MainActor () async throws -> KanbanCard?
    ) async -> IOSAnswerOutcome {
        do {
            try await send(question.toolCallId, choice)
            return .delivered
        } catch {
            guard isStale(error) else { return .failed(error) }
            let card: KanbanCard?
            do {
                card = try await reread()
            } catch let rereadError {
                return .failed(rereadError)
            }
            return outcome(after: error, sent: question.toolCallId, card: card)
        }
    }

    /// Un refus qui peut venir d'une question périmée : 409 (question changée,
    /// aucune question en vol, carte sans geste) ou 404 (carte inconnue).
    nonisolated static func isStale(_ error: Error) -> Bool {
        if case .api(.conflict) = error as? ClientError { return true }
        if case .api(.notFound) = error as? ClientError { return true }
        return false
    }

    /// L'issue d'un refus « périmé » d'après la carte relue.
    nonisolated static func outcome(after error: Error, sent toolCallId: String, card: KanbanCard?) -> IOSAnswerOutcome {
        guard let current = IOSAnswerQuestion(card: card) else { return .questionGone }
        if current.toolCallId != toolCallId { return .questionChanged(current) }
        return .failed(error)
    }
}
