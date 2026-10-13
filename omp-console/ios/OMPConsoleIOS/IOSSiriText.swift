// Les mots de Siri dans l’app iOS (feature client-ios-possede-par-la-vue, S-4) :
// les trois réponses de l’intent témoin, l’intent lui-même et ses phrases, puis
// l’intent « demandes en attente » (siri-iphone-questions-en-attente, S-7) et
// l’intent « écrire à la session OMP » (siri-dictee-session-omp, S-5). Le
// titre, la description, les phrases, le titre court et le symbole sont des
// littéraux extraits AU BUILD par l’outillage App Intents : ils vivent donc ici,
// à la déclaration, et non dans des constantes d’un autre type.

import AppIntents
import ConsoleClient
import ConsoleCore

/// Les mots de l’intent témoin.
enum IOSSiriText {
    static let unpaired = "Non appairé"
    static let pairedNotJoined = "Appairé, Mac non joint"
    static func connected(macName: String) -> String { "Connecté à \(macName)" }
}

/// L’intent témoin : lit l’état du client partagé, n’écrit rien. Il ouvre l’app
/// au premier plan et exige un appareil déverrouillé, le jeton étant illisible
/// appareil verrouillé.
struct IOSConnectionStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Statut de la connexion"
    static let description: IntentDescription? = IntentDescription("OMP Console s’ouvre et dit si cet appareil est appairé et connecté à un Mac.")
    static let supportedModes: IntentModes = .foreground
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @AppDependency var client: ConsoleClientModel

    init() {}

    /// Pour les tests : résout le client dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _client = AppDependency(manager: dependencies) }

    // Type concret, pas `some IntentResult & ProvidesDialog` : les tests exécutent
    // l’intent par `callAsFunction(donate:)`, qui refuse un résultat opaque.
    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        .result(dialog: IntentDialog(stringLiteral: await IOSSiriStatus.answer(for: client)))
    }
}

/// Les demandes du Mac en attente : Siri les annonce, de la plus ancienne à la
/// plus récente, et laisse y répondre à la voix (`VoicePendingWalk`). L’app ne
/// s’ouvre pas ; l’intent parle au Mac, donc exige le déverrouillage de CET
/// iPhone, comme la table de politique l’exige pour chacun de ses gestes.
struct IOSPendingRequestsIntent: AppIntent {
    static let title: LocalizedStringResource = "Demandes en attente"
    static let description: IntentDescription? = IntentDescription("Siri annonce les demandes du Mac en attente et vous laisse y répondre à la voix.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    /// La réponse dictée, redemandée à chaque tour par `requestValue`.
    @Parameter(title: "Réponse") var spokenAnswer: String?

    @AppDependency var client: ConsoleClientModel

    init() {}

    /// Pour les tests : résout le client dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _client = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        guard VoiceGesturePolicy.admits(Self.authenticationPolicy, for: VoicePendingWalk.gestures, on: .current) else {
            return .result(dialog: IntentDialog(stringLiteral: VoiceGestureText.misconfigured))
        }
        return .result(dialog: IntentDialog(stringLiteral: try await IOSSiriPending.answer(client: client, conversation: self)))
    }
}

/// Les tours de parole de la conversation : une dictée par `requestValue`, un
/// oui/non par `requestConfirmation` (qui lève sur « non »).
extension IOSPendingRequestsIntent: VoiceConversation {
    @MainActor
    func ask(_ dialog: String) async throws -> String {
        try await $spokenAnswer.requestValue(IntentDialog(stringLiteral: dialog))
    }

    @MainActor
    func confirm(_ dialog: String) async throws {
        try await requestConfirmation(actionName: .continue, dialog: IntentDialog(stringLiteral: dialog))
    }
}

/// « Dis à OMP Console » : Siri envoie le message dicté à la session OMP hébergée
/// du Mac appairé (`VoiceSessionPrompt`) et dit s’il a été reçu, sans attendre ni
/// lire la réponse de la session. L’app ne s’ouvre pas ; l’intent parle au Mac,
/// donc exige le déverrouillage de CET iPhone, comme la table l’exige.
struct IOSSessionPromptIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Écrire à la session OMP"
    static let description: IntentDescription? = IntentDescription("Siri envoie votre message dicté à la session OMP du Mac et dit s’il a été reçu.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let voiceGesture: VoiceGesture = .promptHostedSession

    /// Le message dicté, demandé par `requestValue` s’il manque.
    @Parameter(title: "Message") var message: String?

    @AppDependency var client: ConsoleClientModel

    init() {}

    /// Pour les tests : résout le client dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _client = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        guard Self.authenticationPolicy == VoiceGesturePolicy.authenticationPolicy(for: Self.voiceGesture, on: .current) else {
            return .result(dialog: IntentDialog(stringLiteral: VoiceGestureText.misconfigured))
        }
        return .result(dialog: IntentDialog(stringLiteral: try await IOSSiriPending.dictate(
            client: client,
            message: message,
            ask: { try await $message.requestValue(IntentDialog(stringLiteral: $0)) },
            deliver: { text, send in
                VoiceIssue(try await applyVoicePolicy(target: text, send: send), gesture: Self.voiceGesture, target: text)
            }
        )))
    }
}

/// Les phrases Siri de l’app, toutes avec le nom de l’app.
struct OMPConsoleShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: IOSConnectionStatusIntent(),
            phrases: [
                "Statut de \(.applicationName)",
                "Connexion de \(.applicationName)",
                "Vérifier la connexion de \(.applicationName)",
            ],
            shortTitle: "Statut de la connexion",
            systemImageName: "macbook.and.iphone"
        )
        AppShortcut(
            intent: IOSPendingRequestsIntent(),
            phrases: [
                "Demandes en attente dans \(.applicationName)",
                "Questions en attente dans \(.applicationName)",
                "Répondre aux questions de \(.applicationName)",
                "Ce qui attend dans \(.applicationName)",
            ],
            shortTitle: "Demandes en attente",
            systemImageName: "tray.full"
        )
        AppShortcut(
            intent: IOSSessionPromptIntent(),
            phrases: [
                "Dis à \(.applicationName)",
                "Envoyer un message à \(.applicationName)",
                "Écrire à \(.applicationName)",
            ],
            shortTitle: "Écrire à la session OMP",
            systemImageName: "text.bubble"
        )
    }
}
