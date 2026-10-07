// Les préférences du client : une couture injectable, jamais `UserDefaults` en
// dur. Le choix du magasin reste dans la couche cliente — les sources de l'app
// iOS ne nomment ni `UserDefaults` ni `FileManager` (garde `coque-ios/AC-8`).

import Foundation

/// Le magasin de préférences du client.
public protocol ClientPreferences: Sendable {
    func string(forKey key: String) -> String?
    func set(_ value: String?, forKey key: String)
}

/// Les clés de préférences, écrites une seule fois.
public enum ClientPreferenceKey {
    /// L'adresse manuelle posée pour cet appareil.
    public static let manualAddress = "client.manualAddress"
    /// L'identifiant d'appareil appairé (UUID minuscule).
    public static let deviceId = "client.deviceId"
}

/// La production : `UserDefaults.standard`. `UserDefaults` est documenté
/// sûr entre fils ; on l'annote `@unchecked Sendable`.
public struct UserDefaultsClientPreferences: ClientPreferences, @unchecked Sendable {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func string(forKey key: String) -> String? {
        defaults.string(forKey: key)
    }

    public func set(_ value: String?, forKey key: String) {
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}

/// La doublure des tests : en mémoire, sûre entre tâches.
public final class InMemoryClientPreferences: ClientPreferences, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String]

    public init(_ values: [String: String] = [:]) {
        self.values = values
    }

    public func string(forKey key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    public func set(_ value: String?, forKey key: String) {
        lock.lock()
        defer { lock.unlock() }
        if let value {
            values[key] = value
        } else {
            values[key] = nil
        }
    }

    /// Le contenu, pour les assertions de test.
    public var snapshot: [String: String] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}
