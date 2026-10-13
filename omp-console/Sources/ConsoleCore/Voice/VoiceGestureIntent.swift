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
            confirm: { prompt in
                try await self.requestConfirmation(dialog: IntentDialog(LocalizedStringResource(stringLiteral: prompt)))
            },
            send: send
        )
    }
}
