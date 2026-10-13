// L'issue d'un geste vocal (noyau-vocal-partage, S-5) : les issues de la porte de
// confirmation, les refus du Mac et les causes de connexion, chacune avec la phrase
// que Siri prononce. Le nom ne commence pas par `VoiceGesture` : la garde
// `gestes-vocaux-sans-politique-de-confirma/AC-9` vise ces citations dans les coques.
//
// VIT DANS `ConsoleCore`.

import Foundation

public enum VoiceIssue: Equatable, Sendable {
    case sent(VoiceGesture, target: String)
    case cancelled
    case misconfigured
    /// Refus du Mac : la question a changé (409).
    case staleQuestion
    /// Refus du Mac : libellé hors des options (400).
    case invalidOption
    /// Tout autre refus motivé du Mac.
    case macRefused(motive: String)
    case notPaired
    case macUnreachable
    case incompatibleVersion(local: Int, remote: Int?)
    /// L'appareil est verrouillé : le jeton d'appairage est illisible.
    case deviceLocked

    /// Le pont depuis la porte `VoiceGesturePolicy.apply` : le dialogue d'une
    /// annulation ou d'une mauvaise configuration est celui de `VoiceGestureText`.
    public init(_ outcome: VoiceGestureOutcome, gesture: VoiceGesture, target: String) {
        switch outcome {
        case .sent:
            self = .sent(gesture, target: target)
        case .cancelled:
            self = .cancelled
        case .misconfigured:
            self = .misconfigured
        }
    }

    /// La phrase que Siri prononce, jamais vide.
    public var phrase: String { VoiceSpeechText.issue(self) }

    /// Vrai pour une cause de connexion : aucune requête suivante n'aboutirait,
    /// la conversation s'arrête sur cette phrase.
    public var endsConversation: Bool {
        switch self {
        case .notPaired, .macUnreachable, .incompatibleVersion, .deviceLocked:
            return true
        case .sent, .cancelled, .misconfigured, .staleQuestion, .invalidOption, .macRefused:
            return false
        }
    }
}
