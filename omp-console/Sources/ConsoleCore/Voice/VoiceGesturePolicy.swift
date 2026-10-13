import Foundation

/// Un geste que Siri ou Raccourcis peut exécuter par un App Intent, sur l'iPhone
/// comme sur le Mac. Chaque cas a sa ligne dans `VoiceGesturePolicy.rule(for:on:)`,
/// classée par un `switch` sans `default` : un cas ajouté sans ligne ne compile pas.
public enum VoiceGesture: String, CaseIterable, Sendable, Hashable {
    /// Arrêter une feature.
    case stopFeature
    /// Valider les specs d'une feature.
    case validateSpecs
    /// Accepter la revue d'une feature.
    case acceptReview
    /// Lancer une pipeline.
    case launchPipeline
    /// Répondre à une question par l'une de ses options.
    case answerOption
    /// Répondre à une question par un texte libre.
    case answerText
    /// Répondre à un dialogue de conduite de projet.
    case answerProjectDialog
    /// Répondre à un dialogue de la session OMP hébergée.
    case answerHostedDialog
    /// Répondre à une escalade d'audit.
    case answerAuditEscalation
    /// Reprendre une pipeline.
    case resume
    /// Consulter : statut, attentes.
    case consult
}

/// La plateforme qui exécute l'intent : `ios` couvre l'app iOS/iPadOS, `mac` la
/// coque macOS.
public enum VoicePlatform: String, CaseIterable, Sendable {
    case ios
    case mac

    /// La plateforme du binaire en cours d'exécution.
    public static var current: VoicePlatform {
        #if os(macOS)
        .mac
        #else
        .ios
        #endif
    }
}

/// La ligne de la table pour un couple (geste, plateforme).
public struct VoiceGestureRule: Equatable, Sendable {
    /// Siri demande une confirmation explicite avant d'émettre le geste.
    public let needsConfirmation: Bool
    /// L'appareil qui exécute l'intent doit être déverrouillé.
    public let needsUnlock: Bool
}

/// L'issue d'un geste vocal passé par la porte : émis, annulé (refus, absence de
/// réponse, cible sans nom) ou intent mal configuré. Les deux derniers portent le
/// texte que Siri annonce.
public enum VoiceGestureOutcome: Equatable, Sendable {
    case sent
    case cancelled(dialog: String)
    case misconfigured(dialog: String)
}

/// La politique de confirmation et de déverrouillage des gestes vocaux. Elle ne
/// régit que les App Intents : les gestes tactiles des écrans gardent leurs
/// propres confirmations.
public enum VoiceGesturePolicy {
    /// La ligne de la table. Fonction pure : la confirmation ne dépend pas de la
    /// plateforme ; sur iPhone tout intent exige le déverrouillage (le jeton est au
    /// trousseau en WhenUnlocked), sur Mac seuls les gestes à risque l'exigent.
    public static func rule(for gesture: VoiceGesture, on platform: VoicePlatform) -> VoiceGestureRule {
        let risky: Bool
        switch gesture {
        case .stopFeature, .validateSpecs, .acceptReview, .launchPipeline:
            risky = true
        case .answerOption, .answerText, .answerProjectDialog, .answerHostedDialog,
             .answerAuditEscalation, .resume, .consult:
            risky = false
        }
        switch platform {
        case .ios:
            return VoiceGestureRule(needsConfirmation: risky, needsUnlock: true)
        case .mac:
            return VoiceGestureRule(needsConfirmation: risky, needsUnlock: risky)
        }
    }

    /// La porte d'application : un geste sans confirmation part aussitôt ; un geste
    /// à risque n'est émis qu'après une confirmation réussie qui nomme sa cible.
    /// `prompt`, s'il n'est pas blanc, remplace le texte de la table : la phrase
    /// qui dit l'effet réel (l'arrêt de tout un dépôt, le besoin d'un lancement).
    /// Il est ignoré quand le geste part sans confirmation. Toute erreur de
    /// `confirm` vaut refus et n'émet rien ; une erreur de `send` se propage telle
    /// quelle, sans nouvel essai.
    @MainActor
    public static func apply(
        _ gesture: VoiceGesture,
        target: String,
        prompt: String? = nil,
        on platform: VoicePlatform,
        confirm: @MainActor (String) async throws -> Void,
        send: @MainActor () async throws -> Void
    ) async throws -> VoiceGestureOutcome {
        guard rule(for: gesture, on: platform).needsConfirmation else {
            try await send()
            return .sent
        }
        let name = target.trimmingCharacters(in: .whitespacesAndNewlines)
        let explicit = prompt.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        guard !name.isEmpty,
              let question = explicit ?? VoiceGestureText.confirmation(for: gesture, target: name)
        else {
            return .cancelled(dialog: VoiceGestureText.cancelled)
        }
        do {
            try await confirm(question)
        } catch {
            return .cancelled(dialog: VoiceGestureText.cancelled)
        }
        try await send()
        return .sent
    }
}
