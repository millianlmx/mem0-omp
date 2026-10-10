// Les préférences du client : une couture injectable, jamais `UserDefaults` en
// dur. Le choix du magasin reste dans la couche cliente — les sources de l'app
// iOS ne nomment ni `UserDefaults` ni `FileManager` (garde `coque-ios/AC-8`).

import Foundation

/// Le magasin de préférences du client.
public protocol ClientPreferences: Sendable {
    func string(forKey key: String) -> String?
    func set(_ value: String?, forKey key: String)
    /// La lecture booléenne : `nil` quand la clé n'a jamais été posée (le domaine
    /// Argument de macOS répond « YES », d'où `object(forKey:) != nil` avant
    /// `bool(forKey:)`).
    func bool(forKey key: String) -> Bool?
    func set(_ value: Bool, forKey key: String)
}

/// Les clés de préférences, écrites une seule fois.
public enum ClientPreferenceKey {
    /// L'adresse manuelle posée pour cet appareil.
    public static let manualAddress = "client.manualAddress"
    /// L'identifiant d'appareil appairé (UUID minuscule).
    public static let deviceId = "client.deviceId"
    /// L'identité de cette installation (UUID minuscule), créée au premier
    /// appairage puis envoyée à chacun (`deviceKey`) : le Mac remplace la ligne
    /// de l'appareil qui se réappaire. Jamais effacée, pas même à la révocation.
    public static let installationId = "client.installationId"
    /// La feuille de bienvenue a été vue (le MÊME nom que la préférence macOS).
    public static let welcomeSeen = "home.welcomeSeen"
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

    public func bool(forKey key: String) -> Bool? {
        guard defaults.object(forKey: key) != nil else { return nil }
        return defaults.bool(forKey: key)
    }

    public func set(_ value: Bool, forKey key: String) {
        defaults.set(value, forKey: key)
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

    /// La lecture booléenne : `nil` quand la clé n'a jamais été posée.
    public func bool(forKey key: String) -> Bool? {
        lock.lock()
        defer { lock.unlock() }
        guard let raw = values[key] else { return nil }
        return raw == "true"
    }

    public func set(_ value: Bool, forKey key: String) {
        lock.lock()
        defer { lock.unlock() }
        values[key] = value ? "true" : "false"
    }

    /// Le contenu, pour les assertions de test.
    public var snapshot: [String: String] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}
