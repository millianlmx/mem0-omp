// L'accès de l'app iOS à la mémoire du serveur : son adresse (préférences) et son
// jeton (trousseau), posés par le code d'appairage (`HarnessPairing`), et la portée
// lue — celle que l'utilisateur a choisie, sinon la plus récemment écrite.

import Combine
import ConsoleCore
import Foundation

/// Une lecture complète que `MemoryAccess` vient de garder, avec la première page de sa portée.
public struct MemoryKeptRead: Sendable, Equatable {
    public let number: Int
    public let firstPage: RemoteMemoryPagePayload

    public init(number: Int, firstPage: RemoteMemoryPagePayload) {
        self.number = number
        self.firstPage = firstPage
    }
}

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

    /// La lecture complète de la portée lue : ses pages et son graphe la partagent jusqu'à la
    /// prochaine actualisation (une portée entière pèse lourd sur le réseau mobile). `number` : la
    /// lecture qui l'a donnée ; `graphTook` : le graphe l'a déjà prise, le suivant relit.
    private struct Snapshot {
        let scope: String
        let page: MemoryPage
        var graphTook: Bool
        let number: Int
    }

    /// La dernière lecture de toute la mémoire qui n'a trouvé aucune portée : le graphe la prend une
    /// fois (« aucun projet »), comme `graphTook` d'un `Snapshot`.
    private struct EmptyRead {
        let number: Int
        var graphTook: Bool
    }

    private enum ReadKey: Hashable {
        case everything
        case scope(String)
    }

    /// Une lecture en vol, partagée par tous ceux qui l'attendent (patron `HarnessModel.capabilitiesTask`).
    @MainActor
    private final class SharedRead {
        let number: Int
        let server: MemoryServer
        let task: Task<MemoryPage, Error>
        var waiters = 0

        init(number: Int, server: MemoryServer, task: Task<MemoryPage, Error>) {
            self.number = number
            self.server = server
            self.task = task
        }
    }

    /// Une attente d'une lecture, quittée une seule fois (en succès, en échec ou par annulation).
    @MainActor
    private final class Waiter {
        var left = false
    }

    private var snapshot: Snapshot?
    private var emptyRead: EmptyRead?
    private var reads: [ReadKey: SharedRead] = [:]
    private var readCount = 0
    private let keptReadsSubject = PassthroughSubject<MemoryKeptRead, Never>()
    /// Les portées de l'adresse courante ont été lues (par une lecture de toute la mémoire).
    private var scopesKnown = false

    /// Le nombre de codes d'appairage acceptés depuis le lancement : l'écran relit à chaque nouveau (un code
    /// vers la même adresse ne change aucune autre valeur publiée).
    @Published public private(set) var pairings = 0

    /// Chaque lecture complète gardée, après qu'elle l'est : la liste se recale dessus.
    public var keptReads: AnyPublisher<MemoryKeptRead, Never> {
        keptReadsSubject.eraseToAnyPublisher()
    }

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

    /// Les deux écritures permises depuis la liste (corriger, supprimer).
    public var writer: MemoryWriter? {
        server.map { MemoryWriter(server: $0, transport: transport) }
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
        // Une lecture partie vers l'ancienne mémoire ne sert plus personne ; l'écran relit (`pairings`).
        cancelReads()
        if server?.baseURL != url {
            scopes = []
            scopesKnown = false
        }
        snapshot = nil
        emptyRead = nil
        server = MemoryServer(baseURL: url, token: token)
        pairings &+= 1
    }

    public func forget() async {
        preferences.set(nil, forKey: Self.addressKey)
        try? await tokens.remove(deviceId: Self.tokenAccount)
        cancelReads()
        server = nil
        scopes = []
        scopesKnown = false
        snapshot = nil
        emptyRead = nil
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
        scopesKnown = true
    }

    /// La portée à lire : celle demandée, sinon celle choisie, sinon la plus récente
    /// (les portées sont alors lues une fois par adresse, par une lecture partagée).
    public func scope(_ requested: String?) async throws -> String? {
        try await resolve(requested).scope
    }

    // MARK: - Lectures

    /// La première page (ouverture, actualisation, choix d'une portée) relit la portée
    /// du serveur, toujours à neuf ; les suivantes tranchent la lecture gardée, sans rien
    /// télécharger.
    public func memoryPage(scope requested: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        guard server != nil else { throw MemoryReadError.unreachable }
        if offset == 0 {
            if scopesKnown, let wanted = target(requested) {
                let taken = try await read(.scope(wanted), fresh: true)
                return MemoryReader.slice(taken.page, scope: wanted, offset: 0, limit: limit)
            }
            // Portées inconnues, ou mémoire qui n'en a aucune (une neuve a pu naître) : la lecture de
            // toute la mémoire donne les portées ET, sans second téléchargement, les lignes de la plus récente.
            let taken = try await read(.everything, fresh: true)
            guard let resolved = Self.named(requested) ?? chosenScope ?? MemoryReader.scopes(in: taken.page).first else {
                return Self.noProject
            }
            return MemoryReader.slice(MemoryReader.restricted(taken.page, to: resolved), scope: resolved, offset: 0, limit: limit)
        }
        let (resolved, seed) = try await resolve(requested)
        guard let resolved else { return Self.noProject }
        if let snapshot, snapshot.scope == resolved {
            return MemoryReader.slice(snapshot.page, scope: resolved, offset: offset, limit: limit)
        }
        let taken = try await lines(of: resolved, seed: seed)
        return MemoryReader.slice(taken.page, scope: resolved, offset: offset, limit: limit)
    }

    public func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        guard let reader else { throw MemoryReadError.unreachable }
        return try await reader.search(query: query, scope: try await self.scope(scope), limit: limit)
    }

    /// Le graphe prend les lignes de la lecture gardée (ou en vol) et ne lit que ses arêtes ;
    /// le passage suivant (⌘R, retour) relit la portée.
    public func memoryGraph(scope requested: String?) async throws -> RemoteMemoryGraphPayload {
        guard let reader else { throw MemoryReadError.unreachable }
        var (found, seed) = try await resolve(requested)
        if found == nil {
            if seed == nil {
                // Mémoire sans portée connue : la lecture qui l'a dit sert le premier passage ; ensuite,
                // chaque passage est une actualisation qui relit toute la mémoire.
                if emptyRead?.graphTook != true, reads[.everything] == nil, emptyRead != nil {
                    emptyRead?.graphTook = true
                    return Self.noProjectGraph
                }
                seed = try await read(.everything, fresh: emptyRead?.graphTook == true)
            }
            found = seed.flatMap { chosenScope ?? MemoryReader.scopes(in: $0.page).first }
        }
        guard let scope = found else {
            if let seed, emptyRead?.number == seed.number { emptyRead?.graphTook = true }
            return Self.noProjectGraph
        }
        let taken: Taken
        if let seed {
            taken = Self.restricted(seed, to: scope)
        } else {
            taken = try await graphLines(of: scope)
        }
        let payload = try await reader.graph(scope: scope, rows: taken.page.rows)
        if snapshot?.number == taken.number { snapshot?.graphTook = true }
        return payload
    }

    // MARK: - Lectures partagées

    private typealias Taken = (page: MemoryPage, number: Int)

    private static let noProject = RemoteMemoryPagePayload(scope: nil, total: 0, offset: 0, rows: [], nextOffset: nil)
    private static let noProjectGraph = RemoteMemoryGraphPayload(scope: nil, nodes: [], links: [], total: 0)

    private static func named(_ scope: String?) -> String? {
        scope.flatMap { $0.isEmpty ? nil : $0 }
    }

    private static func restricted(_ taken: Taken, to scope: String) -> Taken {
        (MemoryReader.restricted(taken.page, to: scope), taken.number)
    }

    /// La portée visée sans rien lire : demandée, sinon choisie, sinon la plus récente si les portées sont connues.
    private func target(_ requested: String?) -> String? {
        Self.named(requested) ?? chosenScope ?? (scopesKnown ? scopes.first : nil)
    }

    /// La portée visée ; inconnue faute de portées lues, elle rejoint (ou lance) la lecture de toute la
    /// mémoire, rendue en `seed` : elle contient déjà les lignes de la portée.
    private func resolve(_ requested: String?) async throws -> (scope: String?, seed: Taken?) {
        if let wanted = target(requested) { return (wanted, nil) }
        guard !scopesKnown, server != nil else { return (nil, nil) }
        let taken = try await read(.everything, fresh: false)
        return (Self.named(requested) ?? chosenScope ?? MemoryReader.scopes(in: taken.page).first, taken)
    }

    /// La lecture qui sert `scope` : la sienne quand les portées sont connues, sinon celle de toute la mémoire.
    private func readKey(for scope: String) -> ReadKey {
        scopesKnown ? .scope(scope) : .everything
    }

    /// Les lignes de `scope` : celles de `seed`, sinon d'une lecture rejointe ou lancée.
    private func lines(of scope: String, seed: Taken?, fresh: Bool = false) async throws -> Taken {
        if let seed { return Self.restricted(seed, to: scope) }
        // La clé se fixe AVANT la lecture : une lecture de toute la mémoire rend les portées connues.
        let key = readKey(for: scope)
        let taken = try await read(key, fresh: fresh)
        if case .everything = key { return Self.restricted(taken, to: scope) }
        return taken
    }

    /// Les lignes du graphe : un deuxième passage relit, une lecture en vol se rejoint, sinon la lecture gardée sert.
    private func graphLines(of scope: String) async throws -> Taken {
        if let snapshot, snapshot.scope == scope {
            if snapshot.graphTook { return try await lines(of: scope, seed: nil, fresh: true) }
            if reads[readKey(for: scope)] == nil { return (snapshot.page, snapshot.number) }
        }
        return try await lines(of: scope, seed: nil)
    }

    /// Une lecture d'une clé : `fresh` la relance (l'ancienne est annulée, ses attentes passent sur la neuve),
    /// sinon elle rejoint celle qui est en vol.
    private func read(_ key: ReadKey, fresh: Bool) async throws -> Taken {
        guard let server else { throw MemoryReadError.unreachable }
        var shared: SharedRead
        if !fresh, let running = reads[key], running.server == server {
            shared = running
        } else {
            shared = launch(key, server: server)
        }
        while true {
            let joined = shared
            let task = joined.task
            let waiter = Waiter()
            joined.waiters += 1
            do {
                let page = try await withTaskCancellationHandler {
                    try await task.value
                } onCancel: {
                    Task { @MainActor in self.leave(joined, waiter, key) }
                }
                release(joined, waiter)
                try Task.checkCancellation()
                return (page, joined.number)
            } catch {
                release(joined, waiter)
                // Un appelant annulé quitte la lecture ; une lecture annulée au profit d'une plus neuve
                // (actualisation) passe ses attentes sur celle-ci.
                try Task.checkCancellation()
                guard error is CancellationError, let next = reads[key], next.number > joined.number, next.server == server else { throw error }
                shared = next
            }
        }
    }

    private func launch(_ key: ReadKey, server: MemoryServer) -> SharedRead {
        readCount &+= 1
        let number = readCount
        let reader = MemoryReader(server: server, transport: transport)
        let task = Task { @MainActor [weak self] () throws -> MemoryPage in
            let page: MemoryPage
            do {
                switch key {
                case .everything: page = try await reader.everything()
                case .scope(let scope): page = try await reader.read(scope: scope)
                }
            } catch {
                self?.finish(key, number)
                throw error
            }
            self?.keep(key, number, server: server, page: page)
            self?.finish(key, number)
            return page
        }
        let shared = SharedRead(number: number, server: server, task: task)
        reads[key]?.task.cancel()
        reads[key] = shared
        return shared
    }

    /// La lecture finie, en succès ou en échec, quitte la table si elle y est encore.
    private func finish(_ key: ReadKey, _ number: Int) {
        if reads[key]?.number == number { reads[key] = nil }
    }

    /// Garde une lecture finie, si elle est encore la seule en vol de sa clé, du même serveur, et pour la portée visée.
    private func keep(_ key: ReadKey, _ number: Int, server: MemoryServer, page: MemoryPage) {
        guard !Task.isCancelled, reads[key]?.number == number, self.server == server else { return }
        switch key {
        case .scope(let scope):
            guard scope == (chosenScope ?? scopes.first) else { return }
            keepSnapshot(scope: scope, page: page, number: number)
        case .everything:
            scopes = MemoryReader.scopes(in: page)
            scopesKnown = true
            if let scope = chosenScope ?? scopes.first {
                keepSnapshot(scope: scope, page: MemoryReader.restricted(page, to: scope), number: number)
            } else {
                snapshot = nil
                emptyRead = EmptyRead(number: number, graphTook: false)
            }
        }
    }

    private func keepSnapshot(scope: String, page: MemoryPage, number: Int) {
        snapshot = Snapshot(scope: scope, page: page, graphTook: false, number: number)
        emptyRead = nil
        keptReadsSubject.send(MemoryKeptRead(
            number: number,
            firstPage: MemoryReader.slice(page, scope: scope, offset: 0, limit: nil)
        ))
    }

    @discardableResult
    private func release(_ read: SharedRead, _ waiter: Waiter) -> Bool {
        guard !waiter.left else { return false }
        waiter.left = true
        read.waiters -= 1
        return true
    }

    /// L'appelant annulé quitte la lecture ; sans plus personne, elle est annulée et oubliée.
    private func leave(_ read: SharedRead, _ waiter: Waiter, _ key: ReadKey) {
        guard release(read, waiter), read.waiters == 0, reads[key] === read else { return }
        read.task.cancel()
        reads[key] = nil
    }

    private func cancelReads() {
        for read in reads.values { read.task.cancel() }
        reads = [:]
    }
}
