// Les intents Siri des demandes en attente du Mac (siri-mac-questions-en-attente,
// S-6). La conversation (annonce, lecture, interprétation, contrôle avant envoi,
// issue, suivante) est celle de `VoicePendingWalk` (ConsoleCore), la même que sur
// l'iPhone ; la coque ne fournit que le canal (la liste lue après l'attente bornée
// de `MacVoiceContext`, l'envoi par les gestes typés de `RemoteActions`), les
// gestes qu'elle émet et les tours de parole de Siri.
//
// Titres, descriptions, modes, politique d'authentification et titre du paramètre
// sont des LITTÉRAUX : l'outillage d'extraction des métadonnées App Intents refuse
// toute valeur calculée.

import AppIntents
import ConsoleCore

/// « Qu'est-ce qui m'attend » : annonce le nombre de demandes puis les parcourt,
/// de la plus ancienne à la plus récente.
struct MacPendingIntent: AppIntent {
    static let title: LocalizedStringResource = "Ce qui m’attend"
    static let description = IntentDescription("Annonce les demandes en attente sur ce Mac, lit la plus ancienne et recueille votre réponse.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    /// La réponse dictée, redemandée à chaque tour par `requestValue`.
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
        .result(dialog: IntentDialog(stringLiteral: try await MacSiriPending.answer(self, context: voice, announcing: true)))
    }
}

extension MacPendingIntent: VoiceConversation {
    func ask(_ dialog: String) async throws -> String {
        try await $answer.requestValue(IntentDialog(stringLiteral: dialog))
    }

    func confirm(_ dialog: String) async throws {
        try await requestConfirmation(actionName: .continue, dialog: IntentDialog(stringLiteral: dialog))
    }
}

/// « Réponds » : la même conversation, sans l'annonce du nombre.
struct MacAnswerIntent: AppIntent {
    static let title: LocalizedStringResource = "Répondre aux demandes"
    static let description = IntentDescription("Lit la plus ancienne demande en attente sur ce Mac, recueille votre réponse puis passe à la suivante.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    /// La réponse dictée, redemandée à chaque tour par `requestValue`.
    @Parameter(title: "Réponse") var answer: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        .result(dialog: IntentDialog(stringLiteral: try await MacSiriPending.answer(self, context: voice, announcing: false)))
    }
}

extension MacAnswerIntent: VoiceConversation {
    func ask(_ dialog: String) async throws -> String {
        try await $answer.requestValue(IntentDialog(stringLiteral: dialog))
    }

    func confirm(_ dialog: String) async throws {
        try await requestConfirmation(actionName: .continue, dialog: IntentDialog(stringLiteral: dialog))
    }
}

/// L'orchestration des intents des attentes du Mac.
@MainActor
enum MacSiriPending {
    /// Les seuls gestes qu'émettent les intents du Mac : les réponses. Les jalons
    /// de carte (`validateSpecs`, `acceptReview`) restent à traiter dans l'app.
    nonisolated static let gestures: [VoiceGesture] = [
        .answerOption, .answerText, .answerProjectDialog, .answerHostedDialog, .answerAuditEscalation,
    ]

    /// La politique littérale de `intent` confrontée à la table pour chacun de ses
    /// gestes (dialogue `misconfigured` sans rien lire ni envoyer si elle diverge),
    /// puis la conversation des attentes sur le contexte du Mac.
    static func answer<Intent: AppIntent & VoiceConversation>(
        _ intent: Intent,
        context: MacVoiceContext,
        announcing: Bool
    ) async throws -> String {
        guard VoiceGesturePolicy.admits(Intent.authenticationPolicy, for: gestures, on: .current) else {
            return VoiceGestureText.misconfigured
        }
        return try await walk(context: context, conversation: intent, announcing: announcing)
    }

    /// La conversation des attentes sur le contexte du Mac.
    static func walk(context: MacVoiceContext, conversation: some VoiceConversation, announcing: Bool) async throws -> String {
        try await VoicePendingWalk.run(
            channel: MacPendingChannel(context: context),
            conversation: conversation,
            announcing: announcing,
            admitting: gestures
        )
    }
}

/// Le canal de `VoicePendingWalk.run` sur le Mac même : la liste locale des
/// attentes, et chaque livraison par UN geste typé de `RemoteActions`.
@MainActor
struct MacPendingChannel: VoicePendingChannel {
    let context: MacVoiceContext

    func pending() async throws -> [PendingRequest] {
        try await context.pending()
    }

    /// La SEULE voie d'écriture : les méthodes typées de `RemoteActions` que sert
    /// aussi le routeur HTTP, aucun corps HTTP, aucun appel direct à un modèle.
    func deliver(_ delivery: VoiceDelivery) async throws {
        let actions = context.remoteActions
        switch delivery {
        case let .cardOption(cardId, toolCallId, label):
            try await actions.answer(cardId: cardId, toolCallId: toolCallId, answer: .selected(label: label))
        case let .cardCustom(cardId, toolCallId, text):
            try await actions.answer(cardId: cardId, toolCallId: toolCallId, answer: .custom(text: text))
        case let .cardReply(cardId, text):
            try await actions.reply(cardId: cardId, text: text)
        case let .cardVerdict(cardId, milestone):
            switch milestone {
            case .specs: try await actions.verdict(cardId: cardId, verdict: .specs)
            case .review: try await actions.verdict(cardId: cardId, verdict: .review)
            case .answer: throw GestureRefusal.milestoneNotAwaited
            }
        case let .conduiteValue(dialogId, value):
            try await actions.answerDialog(id: dialogId, answer: .value(value))
        case let .conduiteConfirmed(dialogId, confirmed):
            try await actions.answerDialog(id: dialogId, answer: .confirmed(confirmed))
        case let .sessionValue(dialogId, value):
            try await actions.answerHostedDialog(id: dialogId, answer: .value(value))
        case let .sessionConfirmed(dialogId, confirmed):
            try await actions.answerHostedDialog(id: dialogId, answer: .confirmed(confirmed))
        case let .auditAnswer(auditId, slug, key, answer):
            try await actions.answerAudit(id: auditId, slug: slug, key: key, answer: answer, decision: nil)
        case let .auditDecision(auditId, slug, key, decision):
            try await actions.answerAudit(id: auditId, slug: slug, key: key, answer: nil, decision: decision)
        }
    }

    /// L'issue d'un échec. `pending()` ne lève que `MacStateUnreadable` ; un refus
    /// de livraison rend `nil` quand la question ou le dialogue a changé (ou n'est
    /// plus là), sinon le motif EXACT de la route HTTP du même geste.
    func issue(of error: Error, delivery: VoiceDelivery?) -> VoiceIssue? {
        if error is MacStateUnreadable { return .stateUnreadable }
        guard let refusal = error as? GestureRefusal else { return .macRefused(motive: "") }
        switch refusal {
        case .staleQuestion, .noQuestionInFlight, .notAwaitingReply, .noPendingDialog, .staleDialog:
            return nil
        default:
            return .macRefused(motive: refusal.apiError.message ?? "")
        }
    }
}
