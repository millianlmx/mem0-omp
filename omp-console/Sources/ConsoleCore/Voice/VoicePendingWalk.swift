// La conversation des attentes, SEUL moteur des deux coques (iPhone :
// siri-iphone-questions-en-attente, S-2 à S-4 ; Mac : siri-mac-questions-en-attente) :
// Siri annonce le total, présente les attentes de la plus ancienne à la plus
// récente, recueille la réponse dite, relit la liste pour ne jamais répondre à
// une question périmée, passe la réponse par la porte `VoiceGesturePolicy.apply`
// puis propose la suivante. Les coques ne fournissent qu'un canal (la liste, une
// requête ou un geste typé par livraison, l'issue d'un échec), les gestes qu'elles
// émettent et un adaptateur de dialogue.
//
// Aucune phrase n'est composée ici : elles vivent dans `VoiceSpeechText`.
//
// VIT DANS `ConsoleCore`.

import Foundation

/// La façon dont une attente se règle à la voix.
public enum VoicePendingMode: Equatable, Sendable {
    /// Choisir l'une des `options` (non vides), ou dicter un texte si la question
    /// l'accepte.
    case choose(options: [PanelAskOption], acceptsFreeText: Bool)
    /// Dicter un texte libre.
    case dictate
    /// Jalon de carte : la confirmation de la table EST la question.
    case approve
    /// À traiter dans l'app, pas à la voix.
    case appOnly
}

/// La réponse recueillie pour une attente.
public enum VoiceAnswerChoice: Equatable, Sendable {
    case option(index: Int, label: String)
    case text(String)
    case approve
}

/// Une livraison : UNE requête vers le Mac, par les routes existantes.
public enum VoiceDelivery: Equatable, Sendable {
    case cardOption(cardId: String, toolCallId: String, label: String)
    case cardCustom(cardId: String, toolCallId: String, text: String)
    case cardReply(cardId: String, text: String)
    /// `milestone` vaut `.specs` ou `.review`.
    case cardVerdict(cardId: String, milestone: LotWaitKind)
    case conduiteValue(dialogId: String, value: String)
    case conduiteConfirmed(dialogId: String, confirmed: Bool)
    case sessionValue(dialogId: String, value: String)
    case sessionConfirmed(dialogId: String, confirmed: Bool)
    case auditAnswer(auditId: String, slug: String, key: String, answer: String)
    case auditDecision(auditId: String, slug: String, key: String, decision: AuditMilestoneDecision)
}

/// Le dialogue avec la personne, fourni par la coque (App Intent).
@MainActor public protocol VoiceConversation {
    /// Siri dit `dialog` puis rend la réponse dictée ; lève si la personne abandonne.
    func ask(_ dialog: String) async throws -> String
    /// Siri dit `dialog` (question oui/non) ; rend sur « oui », lève sur « non » ou abandon.
    func confirm(_ dialog: String) async throws
}

/// Le canal vers le Mac, fourni par la coque.
@MainActor public protocol VoicePendingChannel {
    /// La liste des attentes, plus ancienne d'abord.
    func pending() async throws -> [PendingRequest]
    /// UNE requête vers le Mac.
    func deliver(_ delivery: VoiceDelivery) async throws
    /// L'issue d'un échec. `nil` = refus « question périmée » d'une livraison
    /// (`delivery != nil`) ; jamais `nil` pour un échec de `pending()`.
    func issue(of error: Error, delivery: VoiceDelivery?) -> VoiceIssue?
}

public enum VoicePendingWalk {
    /// Réponses non reconnues tolérées pour une même attente, détour par
    /// « autre réponse » compris.
    public static let maxAttempts = 3

    /// Les seuls gestes que `plan` peut rendre.
    public static let gestures: [VoiceGesture] = [
        .answerOption, .answerText, .validateSpecs, .acceptReview,
        .answerProjectDialog, .answerHostedDialog, .answerAuditEscalation,
    ]

    // MARK: - Mode, plan, identité

    /// Le mode de réponse de `request` quand la coque n'émet que les gestes
    /// `gestures` : une réponse dont le geste n'y figure pas n'est pas proposée
    /// (le texte libre d'une question à options est retiré, une attente qui n'a
    /// plus aucune réponse émissible devient `.appOnly`).
    public static func mode(
        of request: PendingRequest,
        on platform: VoicePlatform = .current,
        admitting gestures: [VoiceGesture] = VoicePendingWalk.gestures
    ) -> VoicePendingMode {
        func admitted(_ choice: VoiceAnswerChoice) -> Bool {
            plan(request, choice).map { gestures.contains($0.gesture) } ?? false
        }
        switch naturalMode(of: request, on: platform) {
        case .appOnly:
            return .appOnly
        case .approve:
            return admitted(.approve) ? .approve : .appOnly
        case .dictate:
            return admitted(.text("")) ? .dictate : .appOnly
        case let .choose(options, acceptsFreeText):
            guard let first = options.first, admitted(.option(index: 0, label: first.label)) else { return .appOnly }
            return .choose(options: options, acceptsFreeText: acceptsFreeText && admitted(.text("")))
        }
    }

    /// Le mode de réponse de `request`, tous gestes admis ; la première règle qui
    /// s'applique l'emporte.
    private static func naturalMode(of request: PendingRequest, on platform: VoicePlatform) -> VoicePendingMode {
        if request.paused { return .appOnly }
        switch request.reply {
        case .cardAnswer:
            return request.options.isEmpty ? .dictate : .choose(options: request.options, acceptsFreeText: true)
        case .cardReply:
            return .dictate
        case let .cardVerdict(_, milestone):
            guard let gesture = verdictGesture(milestone),
                  VoiceGesturePolicy.rule(for: gesture, on: platform).needsConfirmation else { return .appOnly }
            return .approve
        case .resume:
            return .appOnly
        case let .conduiteDialog(_, method), let .sessionDialog(_, method):
            switch method {
            case .select:
                return request.options.isEmpty ? .appOnly : .choose(options: request.options, acceptsFreeText: false)
            case .input:
                return .dictate
            case .confirm:
                return .choose(options: confirmOptions, acceptsFreeText: false)
            case .editor:
                return .appOnly
            }
        case let .auditEscalation(_, _, _, kind):
            switch kind {
            case .ask, .question:
                return request.options.isEmpty ? .dictate : .choose(options: request.options, acceptsFreeText: true)
            case .specs:
                return .choose(options: decisionOptions(AuditText.approveSpecs), acceptsFreeText: false)
            case .review:
                return .choose(options: decisionOptions(AuditText.approveReview), acceptsFreeText: false)
            }
        }
    }

    /// Le geste et la livraison de `choice` pour `request` ; `nil` pour un couple
    /// que `mode` ne produit pas.
    public static func plan(_ request: PendingRequest, _ choice: VoiceAnswerChoice) -> (gesture: VoiceGesture, delivery: VoiceDelivery)? {
        switch (request.reply, choice) {
        case let (.cardAnswer(cardId, toolCallId), .option(_, label)):
            return (.answerOption, .cardOption(cardId: cardId, toolCallId: toolCallId, label: label))
        case let (.cardAnswer(cardId, toolCallId), .text(text)):
            return (.answerText, .cardCustom(cardId: cardId, toolCallId: toolCallId, text: text))
        case let (.cardReply(cardId), .text(text)):
            return (.answerText, .cardReply(cardId: cardId, text: text))
        case let (.cardVerdict(cardId, milestone), .approve):
            guard let gesture = verdictGesture(milestone) else { return nil }
            return (gesture, .cardVerdict(cardId: cardId, milestone: milestone))
        case let (.conduiteDialog(dialogId, method), _):
            guard let delivery = dialogDelivery(
                method, choice,
                value: { .conduiteValue(dialogId: dialogId, value: $0) },
                confirmed: { .conduiteConfirmed(dialogId: dialogId, confirmed: $0) }
            ) else { return nil }
            return (.answerProjectDialog, delivery)
        case let (.sessionDialog(dialogId, method), _):
            guard let delivery = dialogDelivery(
                method, choice,
                value: { .sessionValue(dialogId: dialogId, value: $0) },
                confirmed: { .sessionConfirmed(dialogId: dialogId, confirmed: $0) }
            ) else { return nil }
            return (.answerHostedDialog, delivery)
        case let (.auditEscalation(auditId, slug, key, kind), _):
            let delivery: VoiceDelivery
            switch (kind, choice) {
            case let (.ask, .option(_, answer)), let (.question, .option(_, answer)),
                 let (.ask, .text(answer)), let (.question, .text(answer)):
                delivery = .auditAnswer(auditId: auditId, slug: slug, key: key, answer: answer)
            case let (.specs, .option(index, _)), let (.review, .option(index, _)):
                delivery = .auditDecision(auditId: auditId, slug: slug, key: key, decision: index == 0 ? .approve : .abandon)
            default:
                return nil
            }
            return (.answerAuditEscalation, delivery)
        default:
            return nil
        }
    }

    /// L'identité de la DEMANDE, distincte de celle de sa question : une même
    /// demande peut porter une nouvelle question.
    public static func slot(of request: PendingRequest) -> String {
        switch request.reply {
        case let .cardAnswer(cardId, _), let .cardReply(cardId), let .cardVerdict(cardId, _), let .resume(cardId):
            return "card:\(cardId)"
        case let .conduiteDialog(dialogId, _):
            return "conduite:\(dialogId)"
        case let .sessionDialog(dialogId, _):
            return "session:\(dialogId)"
        case let .auditEscalation(auditId, slug, _, _):
            return "audit:\(auditId):\(slug)"
        }
    }

    private static func verdictGesture(_ milestone: LotWaitKind) -> VoiceGesture? {
        switch milestone {
        case .specs: return .validateSpecs
        case .review: return .acceptReview
        case .answer, .ci: return nil
        }
    }

    private static let confirmOptions = [
        PanelAskOption(label: VoiceSpeechText.yes, description: nil),
        PanelAskOption(label: VoiceSpeechText.no, description: nil),
    ]

    private static func decisionOptions(_ approve: String) -> [PanelAskOption] {
        [PanelAskOption(label: approve, description: nil), PanelAskOption(label: AuditText.abandonFeature, description: nil)]
    }

    private static func dialogDelivery(
        _ method: RpcDialogMethod,
        _ choice: VoiceAnswerChoice,
        value: (String) -> VoiceDelivery,
        confirmed: (Bool) -> VoiceDelivery
    ) -> VoiceDelivery? {
        switch (method, choice) {
        case let (.confirm, .option(index, _)):
            return confirmed(index == 0)
        case let (.select, .option(_, label)):
            return value(label)
        case let (.input, .text(text)):
            return value(text)
        default:
            return nil
        }
    }

    // MARK: - Conversation

    /// La conversation entière. Rend la phrase FINALE, jamais vide, que l'intent
    /// remet comme dialogue de son résultat. Ne lève que si `conversation.ask` lève
    /// ou sur `CancellationError` ; rien n'est alors envoyé au-delà des livraisons
    /// déjà faites. `announcing` faux omet l'annonce du total ; `gestures` sont les
    /// seuls gestes que la coque émet (`mode(of:on:admitting:)`).
    @MainActor
    public static func run(
        channel: some VoicePendingChannel,
        conversation: some VoiceConversation,
        announcing: Bool = true,
        admitting gestures: [VoiceGesture] = VoicePendingWalk.gestures
    ) async throws -> String {
        try await PendingWalk(channel: channel, conversation: conversation, announcing: announcing, gestures: gestures).run()
    }
}

/// L'état d'une conversation : `speech` porte les phrases pas encore dites,
/// préfixées puis vidées par chaque `ask` ou `confirm`.
@MainActor
private final class PendingWalk<Channel: VoicePendingChannel, Conversation: VoiceConversation> {
    private let channel: Channel
    private let conversation: Conversation
    private let announcing: Bool
    private let gestures: [VoiceGesture]
    private var speech: [String] = []
    private var latest: [PendingRequest] = []
    private var visited: Set<String> = []

    init(channel: Channel, conversation: Conversation, announcing: Bool, gestures: [VoiceGesture]) {
        self.channel = channel
        self.conversation = conversation
        self.announcing = announcing
        self.gestures = gestures
    }

    /// Ce qu'il advient d'une attente : passer à la suivante, la présenter à
    /// nouveau sous sa nouvelle question, ou terminer sur une phrase.
    private enum Step {
        case next
        case replaced(PendingRequest)
        case finish(String)
    }

    /// L'attente de même demande dans `latest` : absente, porteuse d'une nouvelle
    /// question, ou inchangée.
    private enum Reread {
        case gone
        case replaced(PendingRequest)
        case unchanged
    }

    func run() async throws -> String {
        do {
            latest = try await channel.pending()
        } catch {
            try rethrowCancellation(error)
            return issuePhrase(error)
        }
        guard var current = latest.first else { return VoiceSpeechText.noPending }

        speech = announcing ? [VoiceSpeechText.walkCount(latest.count)] : []
        var present: (String) -> String = VoiceSpeechText.walkFirst
        while true {
            visited.insert(VoicePendingWalk.slot(of: current))
            speech.append(present(VoicePendingSummary.item(current)))
            switch try await settle(current) {
            case let .finish(phrase):
                return VoiceSpeechText.joined(speech + [phrase])
            case let .replaced(request):
                current = request
                present = VoiceSpeechText.walkReplaced
                continue
            case .next:
                break
            }

            guard let next = latest.first(where: { !visited.contains(VoicePendingWalk.slot(of: $0)) }) else {
                return VoiceSpeechText.joined(speech + [VoiceSpeechText.noPending])
            }
            do {
                try await conversation.confirm(say([VoiceSpeechText.nextPrompt]))
            } catch {
                try rethrowCancellation(error)
                return VoiceSpeechText.walkStopped
            }
            current = next
            present = VoiceSpeechText.walkNext
        }
    }

    /// Recueille la réponse de `request`, la relit sur le Mac puis la livre par la
    /// porte de la table.
    private func settle(_ request: PendingRequest) async throws -> Step {
        let choice: VoiceAnswerChoice
        switch VoicePendingWalk.mode(of: request, admitting: gestures) {
        case .appOnly:
            speech.append(VoiceSpeechText.appOnly)
            return .next
        case .approve:
            choice = .approve
        case let .choose(options, acceptsFreeText):
            guard let answer = try await choose(options, acceptsFreeText: acceptsFreeText) else {
                speech.append(VoiceGestureText.cancelled)
                return .next
            }
            choice = answer
        case .dictate:
            guard let answer = try await dictate() else {
                speech.append(VoiceGestureText.cancelled)
                return .next
            }
            choice = answer
        }

        switch try await reread(request) {
        case let .failed(phrase):
            return .finish(phrase)
        case .ok(.gone):
            speech.append(VoiceIssue.staleQuestion.phrase)
            return .next
        case let .ok(.replaced(newer)):
            speech.append(VoiceIssue.staleQuestion.phrase)
            return .replaced(newer)
        case .ok(.unchanged):
            break
        }

        guard let (gesture, delivery) = VoicePendingWalk.plan(request, choice) else {
            speech.append(VoiceGestureText.cancelled)
            return .next
        }
        let target = request.subject ?? ""
        let outcome: VoiceGestureOutcome
        do {
            outcome = try await VoiceGesturePolicy.apply(
                gesture,
                target: target,
                on: .current,
                confirm: { prompt in try await self.conversation.confirm(self.say([prompt])) },
                send: { try await self.channel.deliver(delivery) }
            )
        } catch {
            try rethrowCancellation(error)
            return try await refused(request, error: error, delivery: delivery)
        }
        switch outcome {
        case .sent:
            speech.append(VoiceIssue.sent(gesture, target: target).phrase)
        case let .cancelled(dialog), let .misconfigured(dialog):
            speech.append(dialog)
        }
        return .next
    }

    /// Une livraison refusée. Un refus « question périmée » relit la liste et
    /// n'envoie jamais à nouveau ; une cause de connexion termine.
    private func refused(_ request: PendingRequest, error: Error, delivery: VoiceDelivery) async throws -> Step {
        if let issue = channel.issue(of: error, delivery: delivery) {
            if issue.endsConversation { return .finish(issue.phrase) }
            speech.append(issue.phrase)
            return .next
        }
        switch try await reread(request) {
        case let .failed(phrase):
            return .finish(phrase)
        case .ok(.gone), .ok(.unchanged):
            speech.append(VoiceIssue.staleQuestion.phrase)
            return .next
        case let .ok(.replaced(newer)):
            speech.append(VoiceIssue.staleQuestion.phrase)
            return .replaced(newer)
        }
    }

    private enum RereadResult {
        case ok(Reread)
        case failed(String)
    }

    /// Relit la liste (`latest` remplacée) et y classe la demande de `request`.
    private func reread(_ request: PendingRequest) async throws -> RereadResult {
        do {
            latest = try await channel.pending()
        } catch {
            try rethrowCancellation(error)
            return .failed(issuePhrase(error))
        }
        let slot = VoicePendingWalk.slot(of: request)
        guard let same = latest.first(where: { VoicePendingWalk.slot(of: $0) == slot }) else { return .ok(.gone) }
        if same.id != request.id || same.reply != request.reply { return .ok(.replaced(same)) }
        return .ok(.unchanged)
    }

    // MARK: - Réponse dite (S-3)

    /// Une attente à options ; `nil` après `maxAttempts` réponses non reconnues.
    private func choose(_ options: [PanelAskOption], acceptsFreeText free: Bool) async throws -> VoiceAnswerChoice? {
        let labels = options.map(\.label)
        let offer = free ? VoiceSpeechText.otherAnswerOffer : ""
        let other = VoiceSpeech.normalized(VoiceSpeechText.otherAnswer)
        let otherIsOption = options.contains { VoiceSpeech.normalized($0.label) == other }
        var prefix = ""
        for _ in 0..<VoicePendingWalk.maxAttempts {
            // Le rappel d'une option non reconnue énumère déjà tous les choix.
            let question = prefix == VoiceSpeechText.optionNotFound(labels: labels)
                ? [prefix, offer]
                : [prefix, VoiceSpeechText.choices(labels), offer]
            let spoken = try await conversation.ask(say(question))
            if free, !otherIsOption, VoiceSpeech.normalized(spoken) == other {
                let dictated = try await conversation.ask(say([VoiceSpeechText.dictate]))
                switch VoiceAnswerMatcher.match(dictated, options: [], acceptsFreeText: true) {
                case let .freeText(text):
                    return .text(text)
                case let .notFound(prompt):
                    prefix = prompt
                case let .option(index, label):
                    return .option(index: index, label: label)
                }
                continue
            }
            switch VoiceAnswerMatcher.match(spoken, options: options, acceptsFreeText: false) {
            case let .option(index, label):
                return .option(index: index, label: label)
            case let .notFound(prompt):
                prefix = prompt
            case let .freeText(text):
                return .text(text)
            }
        }
        return nil
    }

    /// Une attente en texte libre ; `nil` après `maxAttempts` réponses non reconnues.
    private func dictate() async throws -> VoiceAnswerChoice? {
        var prefix = ""
        for _ in 0..<VoicePendingWalk.maxAttempts {
            let spoken = try await conversation.ask(say([prefix, VoiceSpeechText.dictate]))
            switch VoiceAnswerMatcher.match(spoken, options: [], acceptsFreeText: true) {
            case let .freeText(text):
                return .text(text)
            case let .notFound(prompt):
                prefix = prompt
            case let .option(index, label):
                return .option(index: index, label: label)
            }
        }
        return nil
    }

    // MARK: - Outils

    /// Le dialogue d'un tour : `speech` suivi de `parts`, puis `speech` vidé.
    private func say(_ parts: [String]) -> String {
        let dialog = VoiceSpeechText.joined(speech + parts)
        speech = []
        return dialog
    }

    private func issuePhrase(_ error: Error) -> String {
        (channel.issue(of: error, delivery: nil) ?? .macRefused(motive: "")).phrase
    }

    private func rethrowCancellation(_ error: Error) throws {
        if error is CancellationError { throw error }
    }
}
