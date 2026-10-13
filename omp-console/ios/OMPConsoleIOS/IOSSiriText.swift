// Les mots de Siri dans l’app iOS (feature client-ios-possede-par-la-vue, S-4) :
// les trois réponses de l’intent témoin, l’intent lui-même et ses phrases,
// l’intent « demandes en attente » (siri-iphone-questions-en-attente, S-7),
// l’intent « écrire à la session OMP » (siri-dictee-session-omp, S-5), puis
// les cinq intents du pilotage des pipelines — lancer, reprendre, arrêter,
// valider les specs, accepter la revue — et leurs App Shortcuts
// (siri-iphone-pilotage-pipelines, S-9). Le titre, la description, les phrases,
// le titre court et le symbole sont des littéraux extraits AU BUILD par
// l’outillage App Intents : ils vivent donc ici, à la déclaration, et non dans
// des constantes d’un autre type.

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

// Conformité déclarée en extension : `IOSSiriDictation` raffine
// `VoiceConversation`, isolé `@MainActor` ; déclarée sur le type, elle isolerait
// tout l’intent sur l’acteur principal, et ses App Shortcuts (non isolés) ne
// pourraient plus le construire.
extension IOSPendingRequestsIntent: IOSSiriDictation {
    var spokenAnswerParameter: IntentParameter<String?> { $spokenAnswer }
}

/// Les tours de parole d’une conversation Siri : une dictée par `requestValue`
/// sur le paramètre de réponse, un oui/non par `requestConfirmation` (qui lève
/// sur « non »).
protocol IOSSiriDictation: AppIntent, VoiceConversation {
    var spokenAnswerParameter: IntentParameter<String?> { get }
}

extension IOSSiriDictation {
    @MainActor
    func ask(_ dialog: String) async throws -> String {
        try await spokenAnswerParameter.requestValue(IntentDialog(stringLiteral: dialog))
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

/// Lancer une feature sur le Mac : dépôt, titre et besoin dictés, modèles par
/// défaut, confirmation relue. L’app ne s’ouvre pas ; l’intent parle au Mac, donc
/// exige le déverrouillage de CET iPhone.
struct IOSLaunchFeatureIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Lancer une feature"
    static let description: IntentDescription? = IntentDescription("Siri lance une nouvelle feature sur le Mac, avec le dépôt, le titre et le besoin dictés et les modèles par défaut.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let voiceGesture: VoiceGesture = .launchPipeline

    @Parameter(title: "Réponse") var spokenAnswer: String?

    @AppDependency var client: ConsoleClientModel

    init() {}

    /// Pour les tests : résout le client dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _client = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        guard VoiceGesturePolicy.admits(Self.authenticationPolicy, for: [Self.voiceGesture], on: .current) else {
            return .result(dialog: IntentDialog(stringLiteral: VoiceGestureText.misconfigured))
        }
        return .result(dialog: IntentDialog(stringLiteral: try await IOSSiriPilot.launch(client: client, conversation: self)))
    }
}

extension IOSLaunchFeatureIntent: IOSSiriDictation {
    var spokenAnswerParameter: IntentParameter<String?> { $spokenAnswer }
}

/// Reprendre ou relancer une feature arrêtée sur le Mac.
struct IOSResumeFeatureIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Reprendre une feature"
    static let description: IntentDescription? = IntentDescription("Siri reprend ou relance une feature arrêtée sur le Mac.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let pilotGesture: VoicePilotGesture = .resume
    static var voiceGesture: VoiceGesture { pilotGesture.voiceGesture }

    @Parameter(title: "Réponse") var spokenAnswer: String?

    @AppDependency var client: ConsoleClientModel

    init() {}

    /// Pour les tests : résout le client dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _client = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        guard VoiceGesturePolicy.admits(Self.authenticationPolicy, for: [Self.voiceGesture], on: .current) else {
            return .result(dialog: IntentDialog(stringLiteral: VoiceGestureText.misconfigured))
        }
        return .result(dialog: IntentDialog(stringLiteral: try await IOSSiriPilot.perform(Self.pilotGesture, client: client, conversation: self)))
    }
}

extension IOSResumeFeatureIntent: IOSSiriDictation {
    var spokenAnswerParameter: IntentParameter<String?> { $spokenAnswer }
}

/// Arrêter les pipelines du dépôt d’une feature, comme le bouton « Arrêter ».
struct IOSStopFeatureIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Arrêter une feature"
    static let description: IntentDescription? = IntentDescription("Siri arrête les pipelines du dépôt d’une feature, après confirmation.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let pilotGesture: VoicePilotGesture = .stop
    static var voiceGesture: VoiceGesture { pilotGesture.voiceGesture }

    @Parameter(title: "Réponse") var spokenAnswer: String?

    @AppDependency var client: ConsoleClientModel

    init() {}

    /// Pour les tests : résout le client dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _client = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        guard VoiceGesturePolicy.admits(Self.authenticationPolicy, for: [Self.voiceGesture], on: .current) else {
            return .result(dialog: IntentDialog(stringLiteral: VoiceGestureText.misconfigured))
        }
        return .result(dialog: IntentDialog(stringLiteral: try await IOSSiriPilot.perform(Self.pilotGesture, client: client, conversation: self)))
    }
}

extension IOSStopFeatureIntent: IOSSiriDictation {
    var spokenAnswerParameter: IntentParameter<String?> { $spokenAnswer }
}

/// Valider les specs d’une feature arrivée à ce jalon (verdict positif seul).
struct IOSValidateSpecsIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Valider les specs"
    static let description: IntentDescription? = IntentDescription("Siri valide les specs d’une feature arrivée à ce jalon, après confirmation.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let pilotGesture: VoicePilotGesture = .validateSpecs
    static var voiceGesture: VoiceGesture { pilotGesture.voiceGesture }

    @Parameter(title: "Réponse") var spokenAnswer: String?

    @AppDependency var client: ConsoleClientModel

    init() {}

    /// Pour les tests : résout le client dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _client = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        guard VoiceGesturePolicy.admits(Self.authenticationPolicy, for: [Self.voiceGesture], on: .current) else {
            return .result(dialog: IntentDialog(stringLiteral: VoiceGestureText.misconfigured))
        }
        return .result(dialog: IntentDialog(stringLiteral: try await IOSSiriPilot.perform(Self.pilotGesture, client: client, conversation: self)))
    }
}

extension IOSValidateSpecsIntent: IOSSiriDictation {
    var spokenAnswerParameter: IntentParameter<String?> { $spokenAnswer }
}

/// Accepter la revue d’une feature arrivée à ce jalon (verdict positif seul).
struct IOSAcceptReviewIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Accepter la revue"
    static let description: IntentDescription? = IntentDescription("Siri accepte la revue d’une feature arrivée à ce jalon, après confirmation.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let pilotGesture: VoicePilotGesture = .acceptReview
    static var voiceGesture: VoiceGesture { pilotGesture.voiceGesture }

    @Parameter(title: "Réponse") var spokenAnswer: String?

    @AppDependency var client: ConsoleClientModel

    init() {}

    /// Pour les tests : résout le client dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _client = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        guard VoiceGesturePolicy.admits(Self.authenticationPolicy, for: [Self.voiceGesture], on: .current) else {
            return .result(dialog: IntentDialog(stringLiteral: VoiceGestureText.misconfigured))
        }
        return .result(dialog: IntentDialog(stringLiteral: try await IOSSiriPilot.perform(Self.pilotGesture, client: client, conversation: self)))
    }
}

extension IOSAcceptReviewIntent: IOSSiriDictation {
    var spokenAnswerParameter: IntentParameter<String?> { $spokenAnswer }
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
        AppShortcut(
            intent: IOSLaunchFeatureIntent(),
            phrases: [
                "Lancer une feature dans \(.applicationName)",
                "Nouvelle feature dans \(.applicationName)",
                "Lancer une pipeline avec \(.applicationName)",
            ],
            shortTitle: "Lancer une feature",
            systemImageName: "plus.circle"
        )
        AppShortcut(
            intent: IOSResumeFeatureIntent(),
            phrases: [
                "Reprendre une feature dans \(.applicationName)",
                "Relancer une feature dans \(.applicationName)",
                "Reprendre une pipeline avec \(.applicationName)",
            ],
            shortTitle: "Reprendre une feature",
            systemImageName: "play.circle"
        )
        AppShortcut(
            intent: IOSStopFeatureIntent(),
            phrases: [
                "Arrêter une feature dans \(.applicationName)",
                "Arrêter une pipeline avec \(.applicationName)",
            ],
            shortTitle: "Arrêter une feature",
            systemImageName: "stop.circle"
        )
        AppShortcut(
            intent: IOSValidateSpecsIntent(),
            phrases: [
                "Valider les specs dans \(.applicationName)",
                "Valider des specs avec \(.applicationName)",
            ],
            shortTitle: "Valider les specs",
            systemImageName: "checkmark.seal"
        )
        AppShortcut(
            intent: IOSAcceptReviewIntent(),
            phrases: [
                "Accepter la revue dans \(.applicationName)",
                "Accepter une revue avec \(.applicationName)",
            ],
            shortTitle: "Accepter la revue",
            systemImageName: "checkmark.bubble"
        )
    }
}
