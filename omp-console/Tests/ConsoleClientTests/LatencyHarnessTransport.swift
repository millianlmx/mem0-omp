// La doublure de transport à LATENCE FIXE des tests de chargement : chaque appel répond après `latency`,
// sans échec (sauf les chemins de `failing`), et compte les appels par méthode et chemin. Les flux
// d'événements s'ouvrent après la même latence, rejouent ce qu'on leur a préparé, puis RESTENT OUVERTS
// jusqu'à leur terminaison. Elle n'a pas de file de connexions ni de minuteur : elle mesure la profondeur
// des chaînes de lectures (`chainDepth`, sous une `ReadChain` posée) et les appels en double, pas les
// délais dépassés.

@testable import ConsoleClient
import Foundation

/// Une suite d'appels `await` enchaînés, posée par `LatencyHarnessTransport.$chain.withValue(ReadChain()) { … }`.
/// Elle suit les tâches filles (`async let`) et les `Task {}` qui héritent des valeurs de tâche (le partage des
/// lectures en vol de `HarnessModel.send`, `loadCapabilities`). Un appel qui part y prend la profondeur 1 + la
/// plus longue chaîne déjà FINIE : deux appels lancés ensemble ont la même profondeur, un appel attendu avant
/// l'autre ajoute 1. Le temps à latence fixe vaut cette profondeur × L, sans dépendre de la charge de la machine.
/// Une lecture rejointe en vol (`HarnessModel.send`) ne compte que dans la chaîne qui l'a lancée.
final class ReadChain: @unchecked Sendable {
    private let lock = NSLock()
    private var reached = 0

    /// La profondeur d'un appel qui part maintenant.
    func start() -> Int { lock.withLock { reached + 1 } }

    /// Un appel de cette profondeur a répondu.
    func finish(_ depth: Int) { lock.withLock { reached = max(reached, depth) } }
}

final class LatencyHarnessTransport: HarnessTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let latency: Duration
    private var handler: @Sendable (HarnessCall) -> HarnessReply
    private var sent: [HarnessCall] = []
    private var opens: [String] = []
    private var replays: [String: [Data]] = [:]
    private var live = 0
    private var failingPaths: Set<String> = []
    private var deepest = 0

    /// La chaîne de la tâche courante, s'il y en a une.
    @TaskLocal static var chain: ReadChain?

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

    /// La plus grande profondeur prise par un appel parti sous une `ReadChain` ; 0 sans chaîne.
    var chainDepth: Int { lock.withLock { deepest } }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        let chain = Self.chain
        let depth = chain?.start()
        lock.withLock {
            sent.append(call)
            if let depth { deepest = max(deepest, depth) }
        }
        try await Task.sleep(for: latency)
        if let chain, let depth { chain.finish(depth) }
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
