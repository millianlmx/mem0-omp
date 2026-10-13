// L'intent Siri de la dictée vers la session OMP du Mac (siri-dictee-session-omp,
// S-4). Le déroulé (message demandé au besoin, un seul envoi, aucun second tour)
// est celui de `VoiceSessionPrompt` (ConsoleCore), le même que sur l'iPhone ; la
// coque ne fournit que l'envoi, par le geste typé `RemoteActions.prompt(message:)`
// qui décide comme le champ de saisie de la Session OMP.
//
// Titre, description, mode, politique d'authentification et titre du paramètre
// sont des LITTÉRAUX : l'outillage d'extraction des métadonnées App Intents refuse
// toute valeur calculée.

import AppIntents
import ConsoleCore

/// « Dis à OMP Console » : envoie le message dicté à la session OMP hébergée et
/// dit s'il a été reçu, sans attendre ni lire la réponse de la session.
struct MacSessionPromptIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Écrire à la session OMP"
    static let description: IntentDescription? = IntentDescription("Siri envoie votre message dicté à la session OMP de ce Mac et dit s’il a été reçu.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    static let voiceGesture: VoiceGesture = .promptHostedSession

    /// Le message dicté, demandé par `requestValue` s'il manque.
    @Parameter(title: "Message") var message: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    // Type concret, pas `some IntentResult & ProvidesDialog` : un test peut exécuter
    // l'intent par `callAsFunction(donate:)`, qui refuse un résultat opaque. Aucun
    // `MainWindow.reveal()` ni `NSApp.activate` : l'app reste en arrière-plan.
    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        guard Self.authenticationPolicy == VoiceGesturePolicy.authenticationPolicy(for: Self.voiceGesture, on: .current) else {
            return .result(dialog: IntentDialog(stringLiteral: VoiceGestureText.misconfigured))
        }
        return .result(dialog: IntentDialog(stringLiteral: try await MacSessionPrompt.run(
            actions: voice.remoteActions,
            message: message,
            ask: { try await $message.requestValue(IntentDialog(stringLiteral: $0)) },
            deliver: { text, send in
                VoiceIssue(try await applyVoicePolicy(target: text, send: send), gesture: Self.voiceGesture, target: text)
            }
        )))
    }
}

/// L'orchestration de la dictée vers la session sur le Mac.
@MainActor
enum MacSessionPrompt {
    /// `VoiceSessionPrompt.run` sans attente de disponibilité (le modèle est
    /// local) ; `deliver` reçoit le message trimé et l'envoi par le geste typé, et
    /// rend son issue. Un refus du geste se dit par la traduction des intents du
    /// Mac ; une annulation est relancée ; toute autre erreur vaut un refus sans
    /// motif.
    static func run(
        actions: RemoteActions,
        message: String?,
        ask: @MainActor (String) async throws -> String,
        deliver: @MainActor (String, @MainActor () async throws -> Void) async throws -> VoiceIssue
    ) async throws -> String {
        try await VoiceSessionPrompt.run(
            message: message,
            ready: { nil },
            ask: ask,
            deliver: { text in
                do {
                    return try await deliver(text) { try await actions.prompt(message: text) }
                } catch let cancellation as CancellationError {
                    throw cancellation
                } catch let refusal as GestureRefusal {
                    return MacVoiceRefusal.issue(for: refusal) ?? .macRefused(motive: "")
                } catch {
                    return .macRefused(motive: "")
                }
            }
        )
    }
}
