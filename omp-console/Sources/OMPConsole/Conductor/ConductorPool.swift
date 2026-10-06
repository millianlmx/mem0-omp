// Les conducteurs (S-7 de omp-console-redesign) : l'app fait conduire elle-même
// un dépôt dont aucun pilote vivant ne pompe le canal de commande.
//
// Le fait mesuré qui commande la règle (Doc-4) : un `omp --mode rpc --cwd <dépôt>`
// arme son pilote au `session_start` SEULEMENT s'il y trouve un lot à adopter ou
// une commande déjà déposée. D'où l'ordre imposé aux appelants : la commande est
// DÉPOSÉE, PUIS `ensurePilot` est appelé. « Reprendre » n'a pas de commande : le
// `session_start` adopte le lot au pilote mort.
//
// Un conducteur est une `SessionHost` ordinaire (transport `ProcessTransport`,
// environnement `OmpEnvironment`), jamais une seconde implémentation d'hôte RPC.
// La péremption d'un lot est décidée par `lotIsStale` — la règle unique du dépôt.
// Tout vit sur le `@MainActor` : un hôte au plus par dépôt, sans verrou.

import Combine
import ConsoleCore
import Foundation

/// Qui garantit qu'un dépôt a un pilote vivant.
@MainActor
protocol PipelinePilot: AnyObject {
    func ensurePilot(repoRoot: String) async throws
}

/// Un hôte de conducteur : démarré sur un dépôt, vivant ou non, arrêtable.
@MainActor
protocol ConductorHosting: AnyObject {
    var isAlive: Bool { get }
    var pid: Int32? { get }
    func start(repoRoot: URL) async throws
    func stop() async
}

/// L'hôte réel : un `omp --mode rpc` sans interface. Personne ne répond à ses
/// dialogues — chacun est aussitôt annulé, pour que le pilote ne reste jamais
/// suspendu à une question que nul ne verra.
@MainActor
final class SessionConductorHost: ConductorHosting {
    private let host: SessionHost
    private var dialogs: AnyCancellable?

    init(host: SessionHost = SessionHost()) {
        self.host = host
        dialogs = host.$dialogQueue.sink { [weak self] queue in
            guard !queue.isEmpty else { return }
            // Hors de la publication en cours : `answer` modifie la file observée.
            Task { @MainActor in self?.cancelDialogs() }
        }
    }

    var isAlive: Bool {
        switch host.state {
        case .launching, .running: true
        default: false
        }
    }

    var pid: Int32? { host.pid }

    func start(repoRoot: URL) async throws {
        try await host.start(mode: .rpc, projectRoot: repoRoot, resume: false)
    }

    func stop() async {
        await host.stop()
    }

    private func cancelDialogs() {
        for dialog in host.dialogQueue {
            try? host.answer(.cancelled(id: dialog.id))
        }
    }
}

@MainActor
final class ConductorPool: ObservableObject, PipelinePilot {
    private let readLots: () -> [Lot]
    private let clock: StoreClock
    private let makeHost: @MainActor () -> ConductorHosting
    /// Les hôtes, indexés par `realpathOr(repoRoot)`.
    private var hosts: [String: ConductorHosting] = [:]

    init(
        stateDir: String = PipelineStore.stateDir(),
        clock: StoreClock = .live,
        readLots: (() -> [Lot])? = nil,
        makeHost: @escaping @MainActor () -> ConductorHosting = { SessionConductorHost() }
    ) {
        self.clock = clock
        // Lecture FRAÎCHE à chaque appel : la décision porte sur l'état du magasin
        // à l'heure du geste, jamais sur un instantané.
        self.readLots = readLots ?? { StoreReader(stateDir: stateDir, clock: clock).readLots().lots }
        self.makeHost = makeHost
        AppDelegate.terminateConductors = { [weak self] in await self?.stopAll() }
        AppDelegate.conductorsBusy = { [weak self] in self?.isBusy ?? false }
    }

    /// La règle de S-7, dans cet ordre :
    /// 1. un lot au pilote vivant ⇒ rien ;
    /// 2. notre hôte vivant et aucun lot ⇒ rien (armé par la commande en attente) ;
    /// 3. notre hôte vivant et un lot périmé ⇒ il est arrêté, puis 4 ;
    /// 4. un hôte neuf démarre ; son échec est relancé et l'hôte retiré.
    func ensurePilot(repoRoot: String) async throws {
        let root = realpathOr(repoRoot)
        let lot = readLots().first { realpathOr($0.repoRoot) == root }
        if let lot, !lotIsStale(lot, nowMs: clock.nowMs()) { return }
        if let host = hosts[root], host.isAlive {
            guard lot != nil else { return }
            await host.stop()
        }
        let host = makeHost()
        hosts[root] = host
        do {
            try await host.start(repoRoot: URL(fileURLWithPath: root, isDirectory: true))
        } catch {
            if hosts[root] === host { hosts[root] = nil }
            throw error
        }
    }

    /// Vrai quand un de nos hôtes vivants conduit un lot (il en est le
    /// `owner.pid`, magasin relu) dont au moins une feature est `running` :
    /// quitter interromprait ses maillons.
    var isBusy: Bool {
        let pids = Set(hosts.values.filter(\.isAlive).compactMap { $0.pid.map(Int.init) })
        guard !pids.isEmpty else { return false }
        return readLots().contains { lot in
            guard let owner = lot.owner.pid, pids.contains(owner) else { return false }
            return lot.features.contains { $0.state == .running }
        }
    }

    /// Arrête tous les hôtes (fermeture de l'app).
    func stopAll() async {
        let all = Array(hosts.values)
        hosts.removeAll()
        for host in all { await host.stop() }
    }
}
