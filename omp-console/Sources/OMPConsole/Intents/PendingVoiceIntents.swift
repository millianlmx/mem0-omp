// Les intents Siri des demandes en attente du Mac (siri-mac-questions-en-attente,
// S-6). Le parcours (annonce, lecture, interprétation, contrôle avant envoi,
// issue, suivante) est celui de `VoiceConversation` (ConsoleCore) ; la coque ne
// fournit que la lecture de la liste, la question posée à Siri et l'envoi par les
// gestes typés de `RemoteActions`.
//
// Titres, descriptions, modes, politique d'authentification et titre du paramètre
// sont des LITTÉRAUX : l'outillage d'extraction des métadonnées App Intents refuse
// toute valeur calculée.

import AppIntents
import ConsoleCore

/// « Qu'est-ce qui m'attend » : annonce le nombre de demandes puis les parcourt,
/// de la plus ancienne à la plus récente.
struct MacPendingIntent: AppIntent, VoiceAnswerIntent {
    static let title: LocalizedStringResource = "Ce qui m’attend"
    static let description = IntentDescription("Annonce les demandes en attente sur ce Mac, lit la plus ancienne et recueille votre réponse.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    static let voiceGestures: [VoiceGesture] = [
        .answerOption, .answerText, .answerProjectDialog, .answerHostedDialog, .answerAuditEscalation,
    ]

    /// Sert UNIQUEMENT à `requestValue` : sa valeur initiale est ignorée.
    @Parameter(title: "Réponse") var answer: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    // Type concret, pas `some IntentResult & ProvidesDialog` : un test peut exécuter
    // l'intent par `callAsFunction(donate:)`, qui refuse un résultat opaque. Aucun
    // `MainWindow.reveal()` ni `NSApp.activate` : l'app reste en arrière-plan.
    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        let phrase = await MacVoiceSession(context: voice, policy: { gesture, target, send in
            try await self.applyVoicePolicy(gesture, target: target, send: send)
        }).run(announcing: true, ask: { prompt in
            try await $answer.requestValue(IntentDialog(stringLiteral: prompt))
        })
        return .result(dialog: IntentDialog(stringLiteral: phrase))
    }
}

/// « Réponds » : le même parcours, sans l'annonce du nombre.
struct MacAnswerIntent: AppIntent, VoiceAnswerIntent {
    static let title: LocalizedStringResource = "Répondre aux demandes"
    static let description = IntentDescription("Lit la plus ancienne demande en attente sur ce Mac, recueille votre réponse puis passe à la suivante.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    static let voiceGestures: [VoiceGesture] = [
        .answerOption, .answerText, .answerProjectDialog, .answerHostedDialog, .answerAuditEscalation,
    ]

    /// Sert UNIQUEMENT à `requestValue` : sa valeur initiale est ignorée.
    @Parameter(title: "Réponse") var answer: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        let phrase = await MacVoiceSession(context: voice, policy: { gesture, target, send in
            try await self.applyVoicePolicy(gesture, target: target, send: send)
        }).run(announcing: false, ask: { prompt in
            try await $answer.requestValue(IntentDialog(stringLiteral: prompt))
        })
        return .result(dialog: IntentDialog(stringLiteral: phrase))
    }
}

/// Une session vocale : le moteur de ConsoleCore branché sur le contexte du Mac.
/// L'envoi applique la politique vocale de l'intent, puis le geste typé de la
/// source de la demande.
@MainActor
struct MacVoiceSession {
    typealias Policy = @MainActor (VoiceGesture, String, @MainActor () async throws -> Void) async throws -> VoiceGestureOutcome

    private let context: MacVoiceContext
    private let policy: Policy

    init(context: MacVoiceContext, policy: @escaping Policy) {
        self.context = context
        self.policy = policy
    }

    /// Rend la dernière phrase de la session, que l'intent dit en résultat.
    func run(announcing: Bool, ask: @escaping @MainActor (String) async throws -> String) async -> String {
        let context = self.context
        return await VoiceConversation(
            read: { await context.read() },
            ask: ask,
            send: { request, answer in await self.send(request, answer) }
        ).run(announcing: announcing)
    }

    /// Applique la politique au geste de la demande puis l'envoie ; un refus du
    /// Mac devient l'issue dite par Siri.
    func send(_ request: PendingRequest, _ answer: VoiceAnswer) async -> VoiceIssue {
        guard let gesture = request.voiceGesture else { return .misconfigured }
        let target = request.subject?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        do {
            let outcome = try await policy(gesture, target) { try await self.deliver(request, answer) }
            return VoiceIssue(outcome, gesture: gesture, target: target)
        } catch let refusal as GestureRefusal {
            return Self.issue(for: refusal)
        } catch {
            return .macRefused(motive: "")
        }
    }

    /// Un refus du Mac dit par Siri : la question ou le dialogue a changé (ou n'est
    /// plus là) → question périmée ; sinon le motif EXACT de la route HTTP du même
    /// geste.
    static func issue(for refusal: GestureRefusal) -> VoiceIssue {
        switch refusal {
        case .staleQuestion, .noQuestionInFlight, .notAwaitingReply, .noPendingDialog, .staleDialog:
            return .staleQuestion
        default:
            return .macRefused(motive: refusal.apiError.message ?? "")
        }
    }

    /// La SEULE voie d'écriture : les méthodes typées de `RemoteActions`, aucun
    /// corps HTTP, aucun appel direct à un modèle.
    private func deliver(_ request: PendingRequest, _ answer: VoiceAnswer) async throws(GestureRefusal) {
        let actions = context.remoteActions
        switch request.reply {
        case let .cardAnswer(cardId, toolCallId):
            switch answer {
            case let .option(_, label):
                try await actions.answer(cardId: cardId, toolCallId: toolCallId, answer: .selected(label: label))
            case let .text(text):
                try await actions.answer(cardId: cardId, toolCallId: toolCallId, answer: .custom(text: text))
            }
        case let .cardReply(cardId):
            try await actions.reply(cardId: cardId, text: Self.said(answer))
        case let .conduiteDialog(dialogId, method):
            try await actions.answerDialog(id: dialogId, answer: Self.dialogAnswer(method, answer))
        case let .sessionDialog(dialogId, method):
            try await actions.answerHostedDialog(id: dialogId, answer: Self.dialogAnswer(method, answer))
        case let .auditEscalation(auditId, slug, key, _):
            try await actions.answerAudit(id: auditId, slug: slug, key: key, answer: Self.said(answer), decision: nil)
        case .cardVerdict, .resume:
            // Inatteignable : ces demandes n'ont aucun geste vocal, `send` s'arrête avant.
            throw .cardWithoutGesture
        }
    }

    /// Le texte d'une réponse : le libellé de l'option, ou le texte dicté.
    private static func said(_ answer: VoiceAnswer) -> String {
        switch answer {
        case let .option(_, label): return label
        case let .text(text): return text
        }
    }

    /// La réponse à un dialogue : une confirmation (rang 0 = « Oui ») pour
    /// `confirm`, sinon la valeur dite.
    private static func dialogAnswer(_ method: RpcDialogMethod, _ answer: VoiceAnswer) -> DialogAnswer {
        switch answer {
        case let .option(index, label):
            return method == .confirm ? .confirmed(index == 0) : .value(label)
        case let .text(text):
            return .value(text)
        }
    }
}
