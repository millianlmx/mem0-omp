// Harnais des tests de la mémoire (BR-4) : une doublure ENREGISTREUSE du service, un
// protocole d'URL stubé, et des fabriques de lignes.
//
// Aucune socket n'est ouverte et aucun service mem0 n'est requis : la doublure note
// les requêtes et rend une page ou une erreur scriptée, et le stub `URLProtocol`
// capture la requête HTTP réelle (URL, méthode, en-tête, corps) que
// `HTTPMemoryService` produit — c'est ce qui prouve S-1, S-2 et S-7 sans réseau.

import Foundation
@testable import OMPConsole

// MARK: - Doublure du service

/// Un service SCRIPTÉ : ce que le modèle demande, et rien de plus.
final class ScriptedMemoryService: MemoryServing, @unchecked Sendable {
    struct Search: Equatable, Sendable {
        var query: String
        var scope: String
        var pool: Int
    }

    private let lock = NSLock()
    private var healthQueue: [MemoryHealth]
    private var pageResult: Result<MemoryPage, MemoryServiceError>
    private var searchResult: Result<[MemoryRow], MemoryServiceError>
    private var recordedHealth = 0
    private var recordedAllScopes: [String] = []
    private var recordedSearches: [Search] = []

    init(
        health: [MemoryHealth] = [MemoryHealth(isAvailable: true, errorMessage: nil)],
        page: Result<MemoryPage, MemoryServiceError> = .success(MemoryPage(total: 0, rows: [])),
        search: Result<[MemoryRow], MemoryServiceError> = .success([])
    ) {
        healthQueue = health
        pageResult = page
        searchResult = search
    }

    /// `NSLock.lock()`/`unlock()` sont interdits dans un contexte `async` (Swift 6) :
    /// le verrou est pris dans une fonction SYNCHRONE, appelée par les façades.
    private func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    func health() async -> MemoryHealth {
        withLock {
            recordedHealth += 1
            // Une file de plus d'un élément se consomme ; le dernier se rejoue.
            if healthQueue.count > 1 { return healthQueue.removeFirst() }
            return healthQueue.first ?? MemoryHealth(isAvailable: false, errorMessage: nil)
        }
    }

    func all(scope: String) async throws -> MemoryPage {
        try withLock {
            recordedAllScopes.append(scope)
            return try pageResult.get()
        }
    }

    func search(query: String, scope: String, pool: Int) async throws -> [MemoryRow] {
        try withLock {
            recordedSearches.append(Search(query: query, scope: scope, pool: pool))
            return try searchResult.get()
        }
    }

    var healthCalls: Int { withLock { recordedHealth } }
    var allScopes: [String] { withLock { recordedAllScopes } }
    var searches: [Search] { withLock { recordedSearches } }
    var requestCount: Int { withLock { recordedHealth + recordedAllScopes.count + recordedSearches.count } }
}

// MARK: - Fabriques

func memoryRow(
    id: String,
    text: String,
    score: Double? = nil,
    updatedAt: String? = nil,
    tags: [String] = []
) -> MemoryRow {
    MemoryRow(id: id, text: text, updatedAt: updatedAt, semanticScore: score, tags: tags)
}

/// Un modèle réel branché sur la doublure : portée FIXE (le projet ouvert n'est pas
/// celui du poste de test) et environnement VIDE (adresse par défaut).
@MainActor
func memoryModel(
    service: ScriptedMemoryService,
    scope: String? = "memoire-mem0",
    query: String? = nil
) -> MemoryModel {
    let model = MemoryModel(
        service: service,
        scope: { scope },
        environment: [:]
    )
    if let query { model.updateQuery(query) }
    return model
}

// MARK: - Stub HTTP

/// Un `URLProtocol` stubé : il capture la requête réelle et rend la réponse
/// scriptée. C'est la seule façon de prouver l'URL, la méthode, l'en-tête de jeton
/// et le corps EXACT que `HTTPMemoryService` émet — sans ouvrir de socket.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Reply {
        var status: Int = 200
        var body: Data = Data("{}".utf8)
        var error: (any Error)?
    }

    nonisolated(unsafe) private static var replies: [String: Reply] = [:]
    nonisolated(unsafe) private static var recorded: [URLRequest] = []
    private static let lock = NSLock()

    static func reset() {
        lock.lock()
        replies = [:]
        recorded = []
        lock.unlock()
    }

    static func reply(_ path: String, _ reply: Reply) {
        lock.lock()
        replies[path] = reply
        lock.unlock()
    }

    static var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    /// La session qui passe par ce protocole et rien d'autre.
    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // `URLSession` remet le corps en FLUX : on le draine et le repose sur la
        // requête capturée, sinon aucun test ne pourrait figer le corps exact.
        var captured = request
        if let stream = request.httpBodyStream {
            captured.httpBody = Self.drain(stream)
        }

        Self.lock.lock()
        Self.recorded.append(captured)
        let reply = Self.replies[request.url?.path ?? ""]
        Self.lock.unlock()

        guard let reply else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        if let error = reply.error {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let response = HTTPURLResponse(
            url: request.url ?? URL(fileURLWithPath: "/"),
            statusCode: reply.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )
        guard let response else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// Vide un `InputStream` de corps de requête jusqu'à EOF.
    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// Un client HTTP réel sur le stub, sans jeton par défaut.
func stubbedHTTPMemoryService(token: String = "") -> HTTPMemoryService {
    let config = MemoryServiceConfig(
        baseURL: URL(string: "http://localhost:8321")!,
        token: token
    )
    return HTTPMemoryService(config: config, session: StubURLProtocol.session())
}

/// Le JSON d'une réponse, encodé une fois pour toutes.
func memoryJSON(_ object: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed])) ?? Data()
}
