// La normalisation des entrées d'appairage (S-5, S-6) : le code et le nom
// d'appareil, écrits une seule fois.

import ConsoleCore
import Foundation

/// Le code et le nom d'appareil d'un appairage.
public enum ClientPairing {
    /// Normalise un code : majuscules, sans espaces de bord.
    public static func normalizeCode(_ code: String) -> String {
        code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    /// Le code est-il bien formé (8 caractères de l'alphabet Crockford) ?
    public static func isValidCode(_ code: String) -> Bool {
        let alphabet = Set(ConsoleAPI.Service.pairingCodeAlphabet)
        return code.count == ConsoleAPI.Service.pairingCodeLength && code.allSatisfy { alphabet.contains($0) }
    }

    /// Le nom d'appareil : rogné, jamais vide, tronqué à 64 caractères.
    public static func normalizeDeviceName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = trimmed.isEmpty ? "iPhone" : trimmed
        return String(value.prefix(64))
    }
}
