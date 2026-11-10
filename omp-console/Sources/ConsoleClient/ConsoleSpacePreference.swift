// L'espace choisi, gardé d'un lancement à l'autre PAR SERVEUR : chaque adresse de serveur a
// le sien (un espace n'existe que sur son serveur). `HarnessModel` le lit quand les espaces
// sont lus et l'écrit à chaque `setScope` ; les apps ne nomment jamais le magasin (garde
// `coque-ios/AC-8`).

import Foundation

public struct ConsoleSpacePreference: Sendable {
    /// Le préfixe de la clé du réglage ; l'adresse du serveur la complète.
    public static let keyPrefix = "os.space."

    private let preferences: any ClientPreferences

    public init(preferences: any ClientPreferences = UserDefaultsClientPreferences()) {
        self.preferences = preferences
    }

    /// La clé du réglage pour un serveur.
    public static func key(forServer address: String) -> String {
        keyPrefix + address
    }

    /// L'identifiant de l'espace choisi sur ce serveur ; `nil` : tous les espaces.
    public func spaceId(forServer address: String) -> String? {
        let stored = preferences.string(forKey: Self.key(forServer: address)) ?? ""
        return stored.isEmpty ? nil : stored
    }

    /// Garde le choix pour les prochains lancements ; `nil` : tous les espaces (le réglage est retiré).
    public func choose(_ spaceId: String?, forServer address: String) {
        preferences.set(spaceId, forKey: Self.key(forServer: address))
    }
}
