// Le flux GLOBAL du magasin (S-9) : l'agrégat des six stores, poussé à ses abonnés
// quand il change. Aucune veille supplémentaire — les six sources de `StoreWatcher`
// sont les seules, et `commands/` n'est pas veillé (hors périmètre).

import Foundation

/// L'agrégat des six veilles. Le premier élément d'un abonnement est l'instantané
/// courant ; ensuite un élément par changement de l'agrégat (le même, jamais un
/// septième descripteur de veille).
///
/// `@unchecked Sendable` : `aggregate` et `subscribers` sont protégés par `lock`,
/// les six veilles portent leur propre file.
final class StoreHub: @unchecked Sendable {
    private let lock = NSLock()
    /// La racine lue et l'horloge des lectures : conservées pour pouvoir recalculer
    /// la disponibilité de la RACINE à chaque mise à jour (S-11), et pour qu'un
    /// appelant puisse reconstruire un hub à l'identique après `stop()`.
    let stateDir: String
    let nowMs: @Sendable () -> Double
    private let running: StoreWatcher<RunningEnvelope>
    private let history: StoreWatcher<HistoryEnvelope>
    private let lots: StoreWatcher<LotEnvelope>
    private let projects: StoreWatcher<ProjectEnvelope>
    private let inbox: StoreWatcher<InboxEnvelope>
    private let audit: StoreWatcher<AuditEnvelope>
    private var aggregate: StoreSnapshot
    private var subscribers: [UUID: AsyncStream<StoreSnapshot>.Continuation] = [:]
    private var tasks: [Task<Void, Never>] = []
    private var stopped = false

    init(
        stateDir: String = PipelineStore.stateDir(),
        nowMs: @escaping @Sendable () -> Double = { StoreClock.live.nowMs() }
    ) {
        self.stateDir = stateDir
        self.nowMs = nowMs
        let running = StoreHub.watcher(.running, stateDir: stateDir, nowMs: nowMs) { reader in
            reader.readRunning()
        }
        let history = StoreHub.watcher(.history, stateDir: stateDir, nowMs: nowMs) { reader in
            reader.readHistory()
        }
        let lots = StoreHub.watcher(.lots, stateDir: stateDir, nowMs: nowMs) { reader in
            reader.readLots()
        }
        let projects = StoreHub.watcher(.projects, stateDir: stateDir, nowMs: nowMs) { reader in
            reader.readProjects()
        }
        let inbox = StoreHub.watcher(.inbox, stateDir: stateDir, nowMs: nowMs) { reader in
            reader.readInbox()
        }
        let audit = StoreHub.watcher(.audit, stateDir: stateDir, nowMs: nowMs) { reader in
            reader.readAudit()
        }
        self.running = running
        self.history = history
        self.lots = lots
        self.projects = projects
        self.inbox = inbox
        self.audit = audit
        // Amorçage depuis les six veilles (chacune a déjà fait « armer puis lire »),
        // puis abonnement : chaque flux pousse son instantané courant à
        // l'abonnement, donc aucun changement survenu entre les deux n'est perdu.
        self.aggregate = StoreSnapshot(
            root: directoryAvailability(stateDir),
            running: running.current(),
            history: history.current(),
            lots: lots.current(),
            projects: projects.current(),
            inbox: inbox.current(),
            audit: audit.current()
        )
        start()
    }

    private static func watcher<S: Sendable & Equatable>(
        _ store: PipelineStore,
        stateDir: String,
        nowMs: @escaping @Sendable () -> Double,
        read: @escaping @Sendable (StoreReader) -> S
    ) -> StoreWatcher<S> {
        StoreWatcher(store: store, stateDir: stateDir, nowMs: nowMs) { dir, clock in
            read(StoreReader(stateDir: dir, clock: clock))
        }
    }

    /// L'agrégat courant, tel que la veille le tient.
    func current() -> StoreSnapshot {
        lock.lock()
        defer { lock.unlock() }
        return aggregate
    }

    /// Un abonnement au flux global ; son premier élément est l'agrégat courant.
    func snapshots() -> AsyncStream<StoreSnapshot> {
        let (stream, continuation) = AsyncStream<StoreSnapshot>.makeStream()
        let id = UUID()
        continuation.onTermination = { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            self.subscribers[id] = nil
            self.lock.unlock()
        }
        lock.lock()
        if stopped {
            lock.unlock()
            continuation.finish()
            return stream
        }
        subscribers[id] = continuation
        let current = aggregate
        lock.unlock()
        continuation.yield(current)
        return stream
    }

    /// Désarme les six veilles, annule les abonnements internes et termine les flux.
    func stop() {
        lock.lock()
        if stopped {
            lock.unlock()
            return
        }
        stopped = true
        let jobs = tasks
        tasks = []
        let continuations = Array(subscribers.values)
        subscribers.removeAll()
        lock.unlock()
        for job in jobs { job.cancel() }
        running.stop()
        history.stop()
        lots.stop()
        projects.stop()
        inbox.stop()
        audit.stop()
        for continuation in continuations { continuation.finish() }
    }

    deinit {
        stop()
    }

    /// Les six abonnements internes qui tiennent l'agrégat à jour. Chacun est une
    /// `Task` de longue durée sur le flux d'un store (doc §5 : un consommateur
    /// unique et durable, jamais une suite d'appels à échéance sur le même flux).
    private func start() {
        // Les veilles sont capturées LOCALEMENT : dans le corps d'une `Task`, `self`
        // est optionnel, et une propriété de `self` exigerait `self?.` — ce qui
        // laisserait un changement du store non appliqué si `self` venait à
        // disparaître entre deux tours de boucle.
        let running = self.running
        let history = self.history
        let lots = self.lots
        let projects = self.projects
        let inbox = self.inbox
        let audit = self.audit
        let jobs: [Task<Void, Never>] = [
            Task { [weak self] in
                for await value in running.snapshots() { self?.apply { $0.running = value } }
            },
            Task { [weak self] in
                for await value in history.snapshots() { self?.apply { $0.history = value } }
            },
            Task { [weak self] in
                for await value in lots.snapshots() { self?.apply { $0.lots = value } }
            },
            Task { [weak self] in
                for await value in projects.snapshots() { self?.apply { $0.projects = value } }
            },
            Task { [weak self] in
                for await value in inbox.snapshots() { self?.apply { $0.inbox = value } }
            },
            Task { [weak self] in
                for await value in audit.snapshots() { self?.apply { $0.audit = value } }
            },
        ]
        lock.lock()
        tasks = jobs
        lock.unlock()
    }

    /// Applique un store de l'agrégat et n'émet que si l'agrégat ENTIER a changé.
    private func apply(_ update: (inout StoreSnapshot) -> Void) {
        lock.lock()
        if stopped {
            lock.unlock()
            return
        }
        var next = aggregate
        update(&next)
        // La disponibilité de la racine est RÉÉVALUÉE à chaque mise à jour (S-11) :
        // un magasin créé (ou retiré) pendant la session se voit sans re-créer le
        // hub, et le changement fait partie de la comparaison qui décide d'émettre.
        next.root = directoryAvailability(stateDir)
        guard next != aggregate else {
            lock.unlock()
            return
        }
        aggregate = next
        let continuations = Array(subscribers.values)
        lock.unlock()
        for continuation in continuations { continuation.yield(next) }
    }
}
