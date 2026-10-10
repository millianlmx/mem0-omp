// La normalisation du nom d'appareil d'un appairage (S-5, S-6). Le code, lui,
// passe par `PairingCodeFormat` (ConsoleCore), partagé avec le Mac.

import ConsoleCore
import Foundation

/// Le nom d'appareil d'un appairage.
public enum ClientPairing {
    /// Le nom d'appareil : rogné, jamais vide (repli sur le modèle de
    /// l'appareil), tronqué à 64 caractères.
    public static func normalizeDeviceName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = trimmed.isEmpty ? ClientDeviceModel.current : trimmed
        return String(value.prefix(64))
    }
}
