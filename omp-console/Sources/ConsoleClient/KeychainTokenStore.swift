// Le jeton d'appareil, derrière une couture injectable : la production écrit au
// trousseau, les tests en mémoire (AUCUN test n'écrit dans le vrai trousseau).
//
// Patron exact de `Sources/OMPConsole/Remote/DeviceTokenStore.swift` : appels
// `SecItem*` hors du fil principal, article `kSecClassGenericPassword` avec
// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (Doc-5) — le jeton ne migre pas
// avec une sauvegarde d'un autre appareil.

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
public struct KeychainTokenStore: TokenStore {
    public static let defaultService = "com.omp.console.ios.remote-api"

    public let service: String

    public init(service: String = KeychainTokenStore.defaultService) {
        self.service = service
    }

    public func save(_ token: String, for deviceId: String) async throws {
        let service = self.service
        try await offMain {
            try Self.saveSync(token: token, service: service, account: deviceId)
        }
    }

    public func token(for deviceId: String) async throws -> String? {
        let service = self.service
        return try await offMain {
            try Self.tokenSync(service: service, account: deviceId)
        }
    }

    public func remove(deviceId: String) async throws {
        let service = self.service
        try await offMain {
            try Self.removeSync(service: service, account: deviceId)
        }
    }

    // MARK: - Appels bloquants

    private static func query(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
    }

    private static func saveSync(token: String, service: String, account: String) throws {
        let base = query(service: service, account: account)
        let data = Data(token.utf8)
        var status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = base
            add[kSecValueData as String] = data
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw TokenStoreFailure(status: status) }
    }

    private static func tokenSync(service: String, account: String) throws -> String? {
        var search = query(service: service, account: account)
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

    private static func removeSync(service: String, account: String) throws {
        let status = SecItemDelete(query(service: service, account: account) as CFDictionary)
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
