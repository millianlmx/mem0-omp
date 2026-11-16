// La doublure de transport à LATENCE FIXE des tests de chargement : chaque appel répond après `latency`,
// sans échec (sauf les chemins de `failing`), et compte les appels par méthode et chemin. Les flux
// d'événements s'ouvrent après la même latence, rejouent ce qu'on leur a préparé, puis RESTENT OUVERTS
// jusqu'à leur terminaison. Elle n'a pas de file de connexions ni de minuteur : elle mesure la profondeur
// des chaînes de lectures et les appels en double, pas les délais dépassés.

@testable import ConsoleClient
import Foundation

final class LatencyHarnessTransport: HarnessTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let latency: Duration
    private var handler: @Sendable (HarnessCall) -> HarnessReply
    private var sent: [HarnessCall] = []
    private var opens: [String] = []
    private var replays: [String: [Data]] = [:]
    private var live = 0
    private var failingPaths: Set<String> = []

    init(latency: Duration, _ handler: @escaping @Sendable (HarnessCall) -> HarnessReply) {
        self.latency = latency
        self.handler = handler
    }

    /// Remplace les réponses.
    func respond(_ handler: @escaping @Sendable (HarnessCall) -> HarnessReply) {
        lock.withLock { self.handler = handler }
    }

    /// Ce que le prochain flux ouvert sur `path` livre dès son ouverture.
    func replay(_ chunks: [Data], on path: String) {
        lock.withLock { replays[path] = chunks }
    }

    /// Les chemins rendus en 500 `{"error":"panne"}`.
    var failing: Set<String> {
        get { lock.withLock { failingPaths } }
        set { lock.withLock { failingPaths = newValue } }
    }

    /// L'index courant des appels : `gets(after:)` ne compte que ceux d'après.
    func mark() -> Int { lock.withLock { sent.count } }

    /// Le nombre d'appels partis vers cette route.
    func count(_ method: String, _ path: String) -> Int {
        lock.withLock { sent.filter { $0.method == method && $0.path == path }.count }
    }

    /// Le nombre de GET par chemin depuis la marque.
    func gets(after mark: Int) -> [String: Int] {
        lock.withLock {
            sent.dropFirst(mark).filter { $0.method == "GET" }.reduce(into: [:]) { counts, call in counts[call.path, default: 0] += 1 }
        }
    }

    /// Le nombre d'ouvertures de flux sur ce chemin.
    func opened(_ path: String) -> Int { lock.withLock { opens.filter { $0 == path }.count } }

    /// Les chemins de tous les flux ouverts, dans l'ordre.
    var openedPaths: [String] { lock.withLock { opens } }

    /// Les flux ouverts et pas encore terminés.
    var openStreams: Int { lock.withLock { live } }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        lock.withLock { sent.append(call) }
        try await Task.sleep(for: latency)
        return lock.withLock { () -> HarnessReply in
            if failingPaths.contains(call.path) { return HarnessReply(status: 500, body: Data(#"{"error":"panne"}"#.utf8)) }
            return handler(call)
        }
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        lock.withLock { opens.append(call.path) }
        try await Task.sleep(for: latency)
        let chunks = lock.withLock { () -> [Data] in
            live += 1
            return replays[call.path] ?? []
        }
        return AsyncThrowingStream { continuation in
            for chunk in chunks { continuation.yield(chunk) }
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.withLock { self.live -= 1 }
            }
        }
    }
}
