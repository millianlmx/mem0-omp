// L'accès de l'app iOS à la mémoire du serveur : son adresse (préférences) et son
// jeton (trousseau), posés par le code d'appairage (`HarnessPairing`), et la portée
// lue — celle que l'utilisateur a choisie, sinon la plus récemment écrite.

import Combine
import ConsoleCore
import Foundation

@MainActor
public final class MemoryAccess: ObservableObject {
    public static let addressKey = "memory.address"
    public static let scopeKey = "memory.scope"
    public static let tokenAccount = "memory"

    /// La mémoire configurée, ou `nil` (aucun code d'appairage, ou un code sans mémoire).
    @Published public private(set) var server: MemoryServer?
    /// Les portées connues, de la plus récente à la plus ancienne.
    @Published public private(set) var scopes: [String] = []
    /// La portée choisie ; `nil` ⇒ la plus récente.
    @Published public private(set) var chosenScope: String?
    /// La lecture des préférences et du trousseau a eu lieu.
    @Published public private(set) var isLoaded = false

    private let preferences: any ClientPreferences
    private let tokens: any TokenStore
    private let transport: any MemoryTransport

    public init(preferences: any ClientPreferences, tokens: any TokenStore, transport: any MemoryTransport = URLSessionMemoryTransport()) {
        self.preferences = preferences
        self.tokens = tokens
        self.transport = transport
    }

    /// La production : `UserDefaults` et le trousseau de l'app.
    public static func live() -> MemoryAccess {
        MemoryAccess(
            preferences: UserDefaultsClientPreferences(),
            tokens: KeychainTokenStore(service: HarnessModel.keychainService)
        )
    }

    public var isConfigured: Bool { server != nil }

    /// Le lecteur de la mémoire configurée.
    public var reader: MemoryReader? {
        server.map { MemoryReader(server: $0, transport: transport) }
    }

    /// Relit l'adresse, le jeton et la portée choisie.
    public func load() async {
        defer { isLoaded = true }
        chosenScope = preferences.string(forKey: Self.scopeKey)
        guard let raw = preferences.string(forKey: Self.addressKey), let url = URL(string: raw) else { return }
        let token = (try? await tokens.token(for: Self.tokenAccount)) ?? nil
        server = MemoryServer(baseURL: url, token: token ?? "")
    }

    /// Enregistre la mémoire d'un code d'appairage ; une adresse vide l'oublie.
    public func configure(address: String, token: String) async {
        guard let normalized = HarnessModel.normalizedAddress(address), let url = URL(string: normalized) else {
            await forget()
            return
        }
        preferences.set(normalized, forKey: Self.addressKey)
        try? await tokens.save(token, for: Self.tokenAccount)
        if server?.baseURL != url { scopes = [] }
        server = MemoryServer(baseURL: url, token: token)
    }

    public func forget() async {
        preferences.set(nil, forKey: Self.addressKey)
        try? await tokens.remove(deviceId: Self.tokenAccount)
        server = nil
        scopes = []
    }

    /// Choisit la portée lue, gardée d'un lancement à l'autre.
    public func choose(scope: String) {
        chosenScope = scope
        preferences.set(scope, forKey: Self.scopeKey)
    }

    /// Relit les portées de la mémoire.
    public func refreshScopes() async throws {
        guard let reader else { return }
        scopes = try await reader.scopes()
    }

    /// La portée à lire : celle demandée, sinon celle choisie, sinon la plus récente
    /// (les portées sont alors lues une fois).
    public func scope(_ requested: String?) async throws -> String? {
        if let requested, !requested.isEmpty { return requested }
        if let chosenScope { return chosenScope }
        if scopes.isEmpty { try await refreshScopes() }
        return scopes.first
    }

    // MARK: - Lectures

    public func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        guard let reader else { throw MemoryReadError.unreachable }
        return try await reader.page(scope: try await self.scope(scope), offset: offset, limit: limit)
    }

    public func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        guard let reader else { throw MemoryReadError.unreachable }
        return try await reader.search(query: query, scope: try await self.scope(scope), limit: limit)
    }

    public func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        guard let reader else { throw MemoryReadError.unreachable }
        return try await reader.graph(scope: try await self.scope(scope))
    }
}
