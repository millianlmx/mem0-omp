import AppIntents

/// Un App Intent vocal : un intent = un geste de la table. C'est le seul fichier du
/// noyau qui importe AppIntents.
///
/// Un intent conforme déclare son geste et un LITTÉRAL `authenticationPolicy` :
/// l'outillage d'extraction des métadonnées App Intents refuse toute valeur
/// calculée (« 'IntentAuthenticationPolicy' must be initialized with a literal
/// value »), donc la table ne peut pas la fournir. `applyVoicePolicy` confronte ce
/// littéral à la table à chaque exécution.
public protocol VoiceGestureIntent: AppIntent {
    static var voiceGesture: VoiceGesture { get }
}

/// Un App Intent vocal qui répond aux demandes en attente : un intent, plusieurs
/// gestes de la table (un par source de demande). Même contrainte de LITTÉRAL
/// `authenticationPolicy` que `VoiceGestureIntent`, confrontée à la table pour le
/// geste de chaque envoi.
public protocol VoiceAnswerIntent: AppIntent {
    static var voiceGestures: [VoiceGesture] { get }
}

extension VoiceGesturePolicy {
    /// La politique d'authentification qu'exige la table : déverrouillage de
    /// l'appareil qui exécute l'intent, ou aucune.
    public static func authenticationPolicy(for gesture: VoiceGesture, on platform: VoicePlatform) -> IntentAuthenticationPolicy {
        rule(for: gesture, on: platform).needsUnlock ? .requiresLocalDeviceAuthentication : .alwaysAllowed
    }
}

extension VoiceGestureIntent {
    /// Applique la table au geste de l'intent : rien n'est émis si sa politique
    /// d'authentification diverge de la table ; sinon la porte demande, au besoin,
    /// la confirmation à Siri avant d'appeler `send`.
    @MainActor
    public func applyVoicePolicy(target: String, send: @MainActor () async throws -> Void) async throws -> VoiceGestureOutcome {
        guard Self.authenticationPolicy == VoiceGesturePolicy.authenticationPolicy(for: Self.voiceGesture, on: .current) else {
            return .misconfigured(dialog: VoiceGestureText.misconfigured)
        }
        return try await VoiceGesturePolicy.apply(
            Self.voiceGesture,
            target: target,
            on: .current,
            confirm: { prompt in try await requestVoiceConfirmation(self, prompt) },
            send: send
        )
    }
}

extension VoiceAnswerIntent {
    /// Applique la table à `gesture` : rien n'est émis si l'intent ne déclare pas
    /// ce geste ou si sa politique d'authentification diverge de la table ; sinon
    /// la porte demande, au besoin, la confirmation à Siri avant d'appeler `send`.
    @MainActor
    public func applyVoicePolicy(
        _ gesture: VoiceGesture,
        target: String,
        send: @MainActor () async throws -> Void
    ) async throws -> VoiceGestureOutcome {
        guard Self.voiceGestures.contains(gesture),
              Self.authenticationPolicy == VoiceGesturePolicy.authenticationPolicy(for: gesture, on: .current) else {
            return .misconfigured(dialog: VoiceGestureText.misconfigured)
        }
        return try await VoiceGesturePolicy.apply(
            gesture,
            target: target,
            on: .current,
            confirm: { prompt in try await requestVoiceConfirmation(self, prompt) },
            send: send
        )
    }
}

/// La confirmation demandée à Siri par la porte, commune aux deux adaptateurs.
@MainActor
fileprivate func requestVoiceConfirmation(_ intent: some AppIntent, _ prompt: String) async throws {
    try await intent.requestConfirmation(dialog: IntentDialog(LocalizedStringResource(stringLiteral: prompt)))
}
