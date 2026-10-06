// Le jeton d'appareil au trousseau (S-2, Doc-3) : le jeton n'est JAMAIS dans le
// fichier du registre, et jamais réaffiché.
//
// macOS : on écrit SANS `kSecUseDataProtectionKeychain` dans le trousseau de
// session (fichier) — c'est ce qui rend l'article écrit par l'app lisible par
// `security(1)` (donc par le CLI de preuve, BR-10) et réciproquement, sans aucun
// droit d'accès. Les appels `SecItem*` bloquent le fil appelant : ils tournent
// donc sur une file de fond, jamais sur l'acteur principal.

import Foundation
import Security

protocol DeviceTokenStore: Sendable {
    func save(_ token: String, for deviceId: String) async throws
    func token(for deviceId: String) async throws -> String?
    func remove(deviceId: String) async throws
}

/// L'échec d'un appel au trousseau : le code `OSStatus`, jamais un message deviné.
struct DeviceTokenFailure: Error, Equatable {
    let status: OSStatus
    var reason: String { "trousseau : erreur \(status)" }
}

/// Le vrai trousseau, service `com.omp.console.remote-api`, compte = UUID de
/// l'appareil.
struct KeychainDeviceTokenStore: DeviceTokenStore {
    static let defaultService = "com.omp.console.remote-api"

    let service: String

    init(service: String = KeychainDeviceTokenStore.defaultService) {
        self.service = service
    }

    func save(_ token: String, for deviceId: String) async throws {
        let service = self.service
        try await offMain {
            try Self.saveSync(token: token, service: service, account: deviceId)
        }
    }

    func token(for deviceId: String) async throws -> String? {
        let service = self.service
        return try await offMain {
            try Self.tokenSync(service: service, account: deviceId)
        }
    }

    func remove(deviceId: String) async throws {
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
        ]
    }

    private static func saveSync(token: String, service: String, account: String) throws {
        let base = query(service: service, account: account)
        let data = Data(token.utf8)
        var update = base
        update[kSecValueData as String] = data
        var status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(update as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw DeviceTokenFailure(status: status) }
    }

    private static func tokenSync(service: String, account: String) throws -> String? {
        var search = query(service: service, account: account)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw DeviceTokenFailure(status: status)
        }
        return String(data: data, encoding: .utf8)
    }

    private static func removeSync(service: String, account: String) throws {
        let status = SecItemDelete(query(service: service, account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw DeviceTokenFailure(status: status)
        }
    }
}

/// La doublure des tests : aucun test n'écrit dans le vrai trousseau.
actor InMemoryDeviceTokenStore: DeviceTokenStore {
    private var tokens: [String: String]

    init(_ tokens: [String: String] = [:]) {
        self.tokens = tokens
    }

    func save(_ token: String, for deviceId: String) async throws {
        tokens[deviceId] = token
    }

    func token(for deviceId: String) async throws -> String? {
        tokens[deviceId]
    }

    func remove(deviceId: String) async throws {
        tokens[deviceId] = nil
    }

    var knownTokens: [String: String] { tokens }
}

/// Exécute un appel bloquant hors du fil principal, en propageant son erreur.
private func offMain<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .utility).async {
            continuation.resume(with: Result { try work() })
        }
    }
}
