// Le modèle observable du SERVEUR DE PIPELINES, partagé par la coque Mac et l'app
// iOS : l'adresse (préférences) et le jeton (trousseau), la boîte de l'humain
// (escalades batchées, verdicts à valider, décisions prises seules, features en
// cours), le flux d'événements qui la tient à jour, et les gestes.
//
// Aucun texte ici : un échec est un `HarnessFailure`, que les écrans traduisent avec
// `PipelineServerText` (noyau partagé).

import Combine
import Foundation

@MainActor
public final class HarnessModel: ObservableObject {
    /// La préférence qui garde l'adresse du serveur.
    public static let addressKey = "harness.address"
    /// Le service et le compte du jeton dans le trousseau.
    public static let keychainService = "com.omp.console.harness"
    public static let tokenAccount = "harness"

    /// L'adresse du serveur configuré, ou `nil`.
    @Published public private(set) var address: String?
    /// La dernière boîte reçue (gardée hors ligne : on l'affiche avec un bandeau).
    @Published public private(set) var inbox: HarnessInbox?
    /// Le dernier échec, effacé par le prochain échange réussi.
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    /// Le flux d'événements est ouvert : la boîte se met à jour seule.
    @Published public private(set) var isLive = false
    /// Les runs dont un geste attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []
    /// Le chargement initial (préférences + trousseau) a eu lieu.
    @Published public private(set) var isLoaded = false

    private let transport: any HarnessTransport
    private let preferences: any ClientPreferences
    private let tokens: any TokenStore
    private let retryDelay: Duration
    private let refreshDelay: Duration
    private var server: HarnessServer?
    private var liveTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?

    public init(
        transport: any HarnessTransport,
        preferences: any ClientPreferences,
        tokens: any TokenStore,
        retryDelay: Duration = .seconds(5),
        refreshDelay: Duration = .milliseconds(300)
    ) {
        self.transport = transport
        self.preferences = preferences
        self.tokens = tokens
        self.retryDelay = retryDelay
        self.refreshDelay = refreshDelay
    }

    /// La production : `URLSession`, `UserDefaults`, le trousseau.
    public static func live() -> HarnessModel {
        HarnessModel(
            transport: URLSessionHarnessTransport(),
            preferences: UserDefaultsClientPreferences(),
            tokens: KeychainTokenStore(service: keychainService)
        )
    }

    public var isConfigured: Bool { server != nil }

    // MARK: - Configuration

    /// L'adresse normalisée d'une saisie : https par défaut, sans barre finale.
    /// `nil` pour une saisie qui n'est pas une adresse http(s) avec un hôte.
    public nonisolated static func normalizedAddress(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(" ") else { return nil }
        if !text.contains("://") { text = "https://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host, !host.isEmpty
        else { return nil }
        return text
    }

    /// Lit l'adresse et le jeton enregistrés, puis la boîte. Sans configuration, rien.
    public func load() async {
        defer { isLoaded = true }
        guard server == nil, let stored = preferences.string(forKey: Self.addressKey),
              let normalized = Self.normalizedAddress(stored), let url = URL(string: normalized)
        else { return }
        guard let token = (try? await tokens.token(for: Self.tokenAccount)) ?? nil, !token.isEmpty else { return }
        server = HarnessServer(baseURL: url, token: token)
        address = normalized
        await refresh()
    }

    /// Configure un serveur : l'adresse et le jeton ne sont enregistrés qu'après une
    /// boîte effectivement lue (une faute de frappe ne s'enregistre pas).
    @discardableResult
    public func configure(address raw: String, token rawToken: String) async -> Bool {
        guard let normalized = Self.normalizedAddress(raw), let url = URL(string: normalized) else {
            failure = .invalidAddress
            return false
        }
        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            failure = .unauthorized
            return false
        }
        let candidate = HarnessServer(baseURL: url, token: token)
        isLoading = true
        defer { isLoading = false }
        do {
            let fetched: HarnessInbox = try await perform(HarnessCall(method: "GET", path: "/v1/inbox"), on: candidate)
            try? await tokens.save(token, for: Self.tokenAccount)
            preferences.set(normalized, forKey: Self.addressKey)
            server = candidate
            address = normalized
            inbox = fetched
            failure = nil
            return true
        } catch {
            failure = Self.failure(of: error)
            return false
        }
    }

    /// Oublie le serveur : adresse, jeton et boîte.
    public func forget() async {
        stopLive()
        server = nil
        address = nil
        inbox = nil
        failure = nil
        preferences.set(nil, forKey: Self.addressKey)
        try? await tokens.remove(deviceId: Self.tokenAccount)
    }

    // MARK: - Lecture

    /// Relit la boîte. Un échec garde la dernière boîte reçue.
    public func refresh() async {
        guard let server else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            inbox = try await perform(HarnessCall(method: "GET", path: "/v1/inbox"), on: server)
            failure = nil
        } catch {
            failure = Self.failure(of: error)
        }
    }

    /// Ouvre le flux d'événements : chaque événement relit la boîte (regroupés), une
    /// coupure est reprise après `retryDelay`. Idempotent.
    public func startLive() {
        guard liveTask == nil else { return }
        liveTask = Task { [weak self] in
            await self?.liveLoop()
        }
    }

    public func stopLive() {
        liveTask?.cancel()
        liveTask = nil
        refreshTask?.cancel()
        refreshTask = nil
        isLive = false
    }

    private func liveLoop() async {
        while !Task.isCancelled {
            guard let server else { return }
            let cursor = inbox?.cursor ?? 0
            do {
                let stream = try await transport.events(HarnessCall(method: "GET", path: "/v1/events?after=\(cursor)"), server: server)
                isLive = true
                var parser = HarnessEventParser()
                for try await chunk in stream {
                    if !parser.consume(chunk).isEmpty { scheduleRefresh() }
                }
            } catch {
                if let failure = error as? HarnessFailure, failure == .unauthorized { self.failure = failure }
            }
            isLive = false
            if Task.isCancelled { return }
            try? await Task.sleep(for: retryDelay)
            if Task.isCancelled { return }
            await refresh()
        }
    }

    /// Une relecture regroupée : une rafale d'événements ne coûte qu'un appel.
    private func scheduleRefresh() {
        guard refreshTask == nil else { return }
        let delay = refreshDelay
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.refresh()
            self?.refreshTask = nil
        }
    }

    // MARK: - Gestes

    /// Répond à TOUTES les escalades ouvertes d'un run (identifiant → réponse) : le run
    /// reprend son étape quand la dernière est répondue.
    @discardableResult
    public func answer(runId: String, answers: [Int: String]) async -> Bool {
        let items = answers.keys.sorted().map { AnswerBody.Item(id: $0, answer: answers[$0] ?? "") }
        return await gesture(runId, method: "POST", path: "/escalations", body: AnswerBody(answers: items))
    }

    /// Accepte une décision prise seule : elle tient.
    @discardableResult
    public func accept(runId: String, seq: Int) async -> Bool {
        await gesture(runId, method: "POST", path: "/decisions/\(seq)/accept", body: EmptyBody())
    }

    /// Renverse une décision : reprise au point de reprise, la raison rejoint la mémoire du projet.
    @discardableResult
    public func reverse(runId: String, seq: Int, option: String, reason: String) async -> Bool {
        await gesture(runId, method: "POST", path: "/decisions/\(seq)/reverse", body: ReverseBody(option: option, reason: reason))
    }

    /// Valide un verdict (fusion) ou le refuse (correction, raison dans la mémoire du projet).
    @discardableResult
    public func validate(runId: String, approve: Bool, reason: String) async -> Bool {
        await gesture(runId, method: "POST", path: "/validate", body: ValidateBody(approve: approve, reason: reason))
    }

    /// Annule une feature (sa branche reste).
    @discardableResult
    public func cancel(runId: String) async -> Bool {
        await gesture(runId, method: "POST", path: "/cancel", body: EmptyBody())
    }

    private func gesture<Body: Encodable>(_ runId: String, method: String, path: String, body: Body) async -> Bool {
        guard let server else { return false }
        guard let encoded = try? JSONEncoder().encode(body),
              let id = runId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else {
            failure = .unreadable
            return false
        }
        busy.insert(runId)
        defer { busy.remove(runId) }
        do {
            let _: HarnessAck = try await perform(HarnessCall(method: method, path: "/v1/runs/\(id)\(path)", body: encoded), on: server)
            failure = nil
            await refresh()
            return true
        } catch {
            failure = Self.failure(of: error)
            return false
        }
    }

    // MARK: - Échange

    private func perform<T: Decodable>(_ call: HarnessCall, on server: HarnessServer) async throws -> T {
        let reply = try await transport.send(call, server: server)
        switch reply.status {
        case 200, 201:
            guard let value = try? JSONDecoder().decode(T.self, from: reply.body) else { throw HarnessFailure.unreadable }
            return value
        case 401:
            throw HarnessFailure.unauthorized
        default:
            let message = (try? JSONDecoder().decode(HarnessErrorBody.self, from: reply.body))?.error ?? ""
            throw HarnessFailure.rejected(message)
        }
    }

    private static func failure(of error: Error) -> HarnessFailure {
        (error as? HarnessFailure) ?? .unreachable
    }
}

private struct EmptyBody: Encodable {}

private struct AnswerBody: Encodable {
    struct Item: Encodable {
        var id: Int
        var answer: String
    }

    var answers: [Item]
}

private struct ReverseBody: Encodable {
    var option: String
    var reason: String
}

private struct ValidateBody: Encodable {
    var approve: Bool
    var reason: String
}
