// Les jetons (serveur de pipelines, mémoire), derrière une couture injectable : la
// production écrit au trousseau, les tests en mémoire (AUCUN test n'écrit dans le
// vrai trousseau). Appels `SecItem*` hors du fil principal, article
// `kSecClassGenericPassword` avec `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
// (Doc-5) — le jeton ne migre pas avec une sauvegarde d'un autre appareil.

import Foundation
import Security

/// Le magasin du jeton, propre à l'appareil.
public protocol TokenStore: Sendable {
    func save(_ token: String, for deviceId: String) async throws
    func token(for deviceId: String) async throws -> String?
    func remove(deviceId: String) async throws
}

/// L'échec d'un appel au trousseau : le code `OSStatus`, jamais un message deviné.
public struct TokenStoreFailure: Error, Equatable, Sendable {
    public let status: OSStatus

    public init(status: OSStatus) {
        self.status = status
    }

    public var reason: String { "trousseau : erreur \(status)" }
}

/// Exécute un appel bloquant hors du fil principal, en propageant son erreur.
private func offMain<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .utility).async {
            continuation.resume(with: Result { try work() })
        }
    }
}

/// Le vrai trousseau iOS, service `com.omp.console.ios.remote-api`, compte = UUID
/// de l'appareil.
///
/// `accessGroup` partage l'article avec l'extension de widgets (le groupe d'apps sert
/// de groupe d'accès au trousseau) ; `readableWhileLocked` le laisse lisible après le
/// premier déverrouillage, pour un widget qui se relit écran verrouillé.
public struct KeychainTokenStore: TokenStore {
    public static let defaultService = "com.omp.console.ios.remote-api"

    public let service: String
    public let accessGroup: String?
    public let readableWhileLocked: Bool

    public init(service: String = KeychainTokenStore.defaultService, accessGroup: String? = nil, readableWhileLocked: Bool = false) {
        self.service = service
        self.accessGroup = accessGroup
        self.readableWhileLocked = readableWhileLocked
    }

    public func save(_ token: String, for deviceId: String) async throws {
        let base = query(account: deviceId)
        try await offMain {
            try Self.saveSync(token: token, base: base)
        }
    }

    public func token(for deviceId: String) async throws -> String? {
        let base = query(account: deviceId)
        return try await offMain {
            try Self.tokenSync(base: base)
        }
    }

    public func remove(deviceId: String) async throws {
        let base = query(account: deviceId)
        try await offMain {
            try Self.removeSync(base: base)
        }
    }

    // MARK: - Appels bloquants

    /// La requête d'un article, en valeurs `Sendable` (elle traverse vers la file utilitaire).
    private func query(account: String) -> [String: String] {
        var query = [
            kSecClass as String: kSecClassGenericPassword as String,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: (readableWhileLocked
                ? kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                : kSecAttrAccessibleWhenUnlockedThisDeviceOnly) as String,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    private static func saveSync(token: String, base: [String: String]) throws {
        let data = Data(token.utf8)
        var status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add: [String: Any] = base
            add[kSecValueData as String] = data
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw TokenStoreFailure(status: status) }
    }

    private static func tokenSync(base: [String: String]) throws -> String? {
        var search: [String: Any] = base
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw TokenStoreFailure(status: status)
        }
        return String(data: data, encoding: .utf8)
    }

    private static func removeSync(base: [String: String]) throws {
        let status = SecItemDelete(base as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw TokenStoreFailure(status: status)
        }
    }
}

/// La doublure des tests.
public actor InMemoryTokenStore: TokenStore {
    private var tokens: [String: String]

    public init(_ tokens: [String: String] = [:]) {
        self.tokens = tokens
    }

    public func save(_ token: String, for deviceId: String) async throws {
        tokens[deviceId] = token
    }

    public func token(for deviceId: String) async throws -> String? {
        tokens[deviceId]
    }

    public func remove(deviceId: String) async throws {
        tokens[deviceId] = nil
    }

    public var knownTokens: [String: String] { tokens }
}
