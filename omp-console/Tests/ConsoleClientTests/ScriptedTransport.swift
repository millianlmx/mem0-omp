// Les doublures des tests hermétiques de la couche cliente : transport scripté,
// horloge de repli enregistreuse, découverte et chemin réseau scriptés. AUCUN
// réseau, AUCUN Mac réel, AUCUN trousseau réel.

@testable import ConsoleClient
import ConsoleCore
import Foundation

// MARK: - Transport

/// Le transport scripté : enregistre chaque requête (et son endpoint), et rend
/// des réponses et des flux décidés par le test.
final class ScriptedTransport: ClientTransport, @unchecked Sendable {
    enum StreamStep {
        case chunks([Data])
        case failure(Error)
        /// Une trame livrée puis le flux RESTE ouvert.
        case hold
    }

    enum StreamMode {
        /// Une trame est livrée puis le flux RESTE ouvert (push manuel).
        case hold
        /// Le flux échoue immédiatement.
        case failure(Error)
        /// Un pas par appel de `stream`, dans l'ordre.
        case sequence([StreamStep])
    }

    private let lock = NSLock()
    private var recorded: [ClientHTTPRequest] = []
    private var recordedEndpoints: [ClientEndpoint] = []
    private var recordedTokens: [String?] = []
    private var responder: (@Sendable (ClientHTTPRequest) -> Result<ClientHTTPResponse, Error>)?
    private var streamMode: StreamMode = .hold
    private var pendingSteps: [StreamStep] = []
    private var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []

    init() {}

    // MARK: Script

    func respond(_ handler: @escaping @Sendable (ClientHTTPRequest) -> Result<ClientHTTPResponse, Error>) {
        lock.withLock { responder = handler }
    }

    func script(_ mode: StreamMode) {
        lock.withLock {
            streamMode = mode
            if case .sequence(let steps) = mode { pendingSteps = steps }
        }
    }

    /// Pousse une trame dans tous les flux tenus ouverts.
    func push(_ data: Data) {
        let current = lock.withLock { continuations }
        for continuation in current { continuation.yield(data) }
    }

    func finishStreams() {
        let current = lock.withLock { let all = continuations; continuations.removeAll(); return all }
        for continuation in current { continuation.finish() }
    }

    var requests: [ClientHTTPRequest] { lock.withLock { recorded } }

    var endpoints: [ClientEndpoint] { lock.withLock { recordedEndpoints } }

    var tokens: [String?] { lock.withLock { recordedTokens } }

    var requestCount: Int { requests.count }

    func count(method: String, path: String) -> Int {
        requests.filter { $0.method == method && $0.path == path }.count
    }

    // MARK: ClientTransport

    func send(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) async throws -> ClientHTTPResponse {
        let handler = lock.withLock {
            recorded.append(request)
            recordedEndpoints.append(endpoint)
            recordedTokens.append(token)
            return responder
        }
        guard let handler else {
            throw ClientError.transport(.unreachable("script de transport vide"))
        }
        switch handler(request) {
        case .success(let response): return response
        case .failure(let error): throw error
        }
    }

    func stream(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) async throws -> AsyncThrowingStream<Data, Error> {
        let (mode, step): (StreamMode, StreamStep?) = lock.withLock {
            recorded.append(request)
            recordedEndpoints.append(endpoint)
            recordedTokens.append(token)
            let mode = streamMode
            var step: StreamStep?
            if case .sequence = mode {
                step = pendingSteps.isEmpty ? nil : pendingSteps.removeFirst()
            }
            return (mode, step)
        }

        switch mode {
        case .failure(let error):
            throw error
        case .sequence:
            switch step {
            case .failure(let error): throw error
            case .chunks(let chunks): return Self.stream(chunks: chunks)
            case .hold: return makeHold()
            case .none: return Self.stream(chunks: [])
            }
        case .hold:
            return makeHold()
        }
    }

    private func makeHold() -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            lock.withLock { continuations.append(continuation) }
        }
    }

    private static func stream(chunks: [Data]) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            for chunk in chunks { continuation.yield(chunk) }
            continuation.finish()
        }
    }
}

// MARK: - Horloge de repli

/// Enregistre les délais demandés SANS attendre ; `limit` interrompt la boucle de
/// reconnexion au-delà de N enregistrements (sinon les tests boucleraient).
actor RecordingPacer: ClientPacer {
    private var delays: [Double] = []
    private let limit: Int

    init(limit: Int = Int.max) {
        self.limit = limit
    }

    func sleep(seconds: Double) async throws {
        delays.append(seconds)
        if delays.count > limit { throw CancellationError() }
    }

    func recorded() -> [Double] { delays }
}

// MARK: - Découverte

@MainActor
final class ScriptedDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?

    private(set) var started = false
    private(set) var stopped = false
    private(set) var requestedServiceType: String?

    func start(serviceType: String) {
        started = true
        requestedServiceType = serviceType
    }

    func stop() {
        stopped = true
        started = false
    }

    func emit(_ macs: [DiscoveredMac]) { onChange?(macs) }
    func emitProtocolVersion(_ version: Int) { onProtocolVersion?(version) }
    func emitDenied(_ denied: Bool) { onDenied?(denied) }
}

// MARK: - Chemin réseau

@MainActor
final class ScriptedPathSource: ClientPathSource {
    var onChange: ((Bool) -> Void)?

    private(set) var started = false

    func start() { started = true }
    func stop() { started = false }

    func emit(_ satisfied: Bool) { onChange?(satisfied) }
}

// MARK: - Fixtures

enum ClientFixtures {
    /// Un instantané du magasin minimal, décodé depuis sa forme JSON (la forme que
    /// la coque sérialise).
    static func snapshot(root: String = "present") -> StoreSnapshot {
        let json = """
        {"root":"\(root)","running":{"availability":"present","entries":[],"discardedEntries":[]},\
        "history":{"availability":"present","entries":[],"discardedEntries":[]},\
        "lots":{"availability":"present","lots":[],"discardedEntries":[]},\
        "projects":{"availability":"present","projects":[],"discardedEntries":[]},\
        "inbox":{"availability":"present","boxes":[],"discardedEntries":[]},\
        "audit":{"availability":"present","relays":[],"discardedEntries":[]}}
        """
        return try! JSONDecoder().decode(StoreSnapshot.self, from: Data(json.utf8))
    }

    /// Une trame SSE, exactement comme le serveur l'écrit.
    static func frame(_ event: String, _ json: String) -> Data {
        Data("event: \(event)\ndata: \(json)\n\n".utf8)
    }

    static func storeFrame(_ snapshot: StoreSnapshot) -> Data {
        let data = try! JSONEncoder().encode(snapshot)
        return Data("event: store\ndata: ".utf8) + data + Data("\n\n".utf8)
    }
}

// MARK: - Attente

/// Attend qu'une condition devienne vraie, sans dormir plus que nécessaire.
@MainActor
func eventually(timeout: Double = 3, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return condition()
}
