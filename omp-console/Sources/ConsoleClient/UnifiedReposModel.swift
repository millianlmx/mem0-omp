// Le modèle de la section « Dépôts » (S-6 de orchestrator-living-in-a-vps), PARTAGÉ
// par omp-console et l'app iOS : il lit les dépôts des deux machines, les fusionne
// (`UnifiedRepos.merge`), mémorise le dernier relevé de chaque machine (la machine
// injoignable parle par lui) et pilote la bascule (`HandoverFlow`). Les vues ne
// composent ni phrase ni requête.

import Combine
import ConsoleCore
import Foundation

/// L'issue du dernier geste de la section : son texte exact.
public enum ReposMessage: Equatable, Sendable {
    case success(String)
    case failure(String)
}

@MainActor
public final class UnifiedReposModel: ObservableObject {
    public enum Phase: Equatable, Sendable {
        /// Aucun relevé n'est encore arrivé.
        case loading
        case ready
    }

    @Published public private(set) var phase: Phase = .loading
    @Published public private(set) var lines: [UnifiedRepo] = []
    /// Les lignes dont une bascule s'exécute en ce moment.
    @Published public private(set) var busy: Set<String> = []
    @Published public private(set) var message: ReposMessage?
    /// Les bascules à terminer (retrait final refusé), par identifiant de ligne.
    @Published public private(set) var unfinished: [String: PendingHandover] = [:]

    public let mac: any MachineSource
    public let vps: any MachineSource
    private let preferences: any ClientPreferences
    private let sleep: @Sendable (Double) async -> Void
    private var fetched: [RepoMachine: [RepoRow]] = [:]
    private var lastAvailability: [RepoMachine: MachineAvailability] = [:]
    private var cancellables: Set<AnyCancellable> = []
    private var refreshing = false
    private var refreshAgain = false

    public init(
        mac: any MachineSource,
        vps: any MachineSource,
        preferences: any ClientPreferences,
        sleep: @escaping @Sendable (Double) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    ) {
        self.mac = mac
        self.vps = vps
        self.preferences = preferences
        self.sleep = sleep
        for source in [mac, vps] {
            fetched[source.machine] = UnifiedRepos.decodeLastKnown(
                preferences.string(forKey: UnifiedRepos.lastReposKey(source.machine))
            )
        }
        for source in [mac, vps] {
            source.changes
                .sink { [weak self] in self?.sourceChanged() }
                .store(in: &cancellables)
        }
        recompute()
    }

    public func source(_ machine: RepoMachine) -> any MachineSource {
        machine == .mac ? mac : vps
    }

    // MARK: - Lecture

    /// Relit les dépôts de chaque machine JOIGNABLE puis recalcule la vue. Une
    /// lecture qui échoue rend la machine injoignable pour ce relevé : son dernier
    /// relevé mémorisé parle à sa place.
    public func refresh() async {
        if refreshing {
            refreshAgain = true
            return
        }
        refreshing = true
        defer { refreshing = false }
        repeat {
            refreshAgain = false
            for machine in RepoMachine.allCases {
                let source = source(machine)
                lastAvailability[machine] = source.availability
                guard source.availability == .reachable else {
                    reachableOverride[machine] = false
                    continue
                }
                do {
                    let rows = try await source.fetchRepos()
                    fetched[machine] = rows
                    reachableOverride[machine] = true
                    if let text = UnifiedRepos.encodeLastKnown(rows) {
                        preferences.set(text, forKey: UnifiedRepos.lastReposKey(machine))
                    }
                } catch {
                    reachableOverride[machine] = false
                }
            }
            phase = .ready
            recompute()
        } while refreshAgain
    }

    /// Les machines dont la dernière lecture a réussi (ou échoué) : une machine
    /// jointe mais dont `GET /v1/repos` échoue est injoignable pour cette vue.
    private var reachableOverride: [RepoMachine: Bool] = [:]

    private func sourceChanged() {
        let changed = RepoMachine.allCases.contains { lastAvailability[$0] != source($0).availability }
        if changed {
            Task { await refresh() }
        } else {
            recompute()
        }
    }

    private func entry(_ machine: RepoMachine) -> MachineRepos {
        let source = source(machine)
        switch source.availability {
        case .notConfigured: return .notConfigured
        case .unreachable: return .unreachable(lastKnown: fetched[machine] ?? [])
        case .reachable:
            if reachableOverride[machine] == false { return .unreachable(lastKnown: fetched[machine] ?? []) }
            return .reachable(fetched[machine] ?? [])
        }
    }

    private func recompute() {
        let macEntry = entry(.mac)
        let vpsEntry = entry(.vps)
        var finishing: [RepoMachine: [String: Int]] = [:]
        finishing[.mac] = UnifiedRepos.finishingCounts(rows: macEntry.rows, snapshot: mac.snapshot)
        finishing[.vps] = UnifiedRepos.finishingCounts(rows: vpsEntry.rows, snapshot: vps.snapshot)
        let merged = UnifiedRepos.merge(
            mac: macEntry,
            vps: vpsEntry,
            finishing: finishing,
            toFinish: Set(unfinished.keys)
        )
        if merged != lines { lines = merged }
    }

    // MARK: - Geste « Confier »

    /// La phrase de confirmation : le nom, la cible et le nombre de features pas
    /// encore démarrées, lu dans l'instantané de la source.
    public func confirmation(for line: UnifiedRepo, offer: HandoverOffer) -> String {
        let count = line.row(on: offer.from).map {
            UnifiedRepos.notStarted(in: source(offer.from).snapshot, repoRoot: $0.repoRoot)
        } ?? 0
        return ReposText.confirmation(name: line.name, to: offer.to, pending: count)
    }

    /// Confie le dépôt à `offer.to` : bascule en trois temps (`HandoverFlow`).
    public func handOver(_ line: UnifiedRepo, offer: HandoverOffer) async {
        guard offer.isEnabled, !busy.contains(line.id), let row = line.row(on: offer.from) else { return }
        busy.insert(line.id)
        message = nil
        let flow = HandoverFlow(
            source: source(offer.from).handoverEndpoint,
            target: source(offer.to).handoverEndpoint,
            sleep: sleep
        )
        let outcome = await flow.run(from: offer.from, to: offer.to, repoKey: row.repoKey, name: line.name)
        apply(outcome, line: line, to: offer.to)
        busy.remove(line.id)
        await refresh()
    }

    /// « Réessayer » : refait le retrait final d'une bascule à terminer.
    public func retry(_ line: UnifiedRepo) async {
        guard let pending = unfinished[line.id], !busy.contains(line.id) else { return }
        busy.insert(line.id)
        message = nil
        let flow = HandoverFlow(
            source: source(pending.from).handoverEndpoint,
            target: source(pending.to).handoverEndpoint,
            sleep: sleep
        )
        let outcome = await flow.finish(pending)
        apply(outcome, line: line, to: pending.to)
        busy.remove(line.id)
        await refresh()
    }

    /// « Annuler la bascule » : rouvre la source (bascule gelée seulement).
    public func cancelHandover(_ line: UnifiedRepo) async {
        guard let frozen = line.frozenHandover, unfinished[line.id] == nil, !busy.contains(line.id),
              let row = line.row(on: frozen.source) else { return }
        busy.insert(line.id)
        message = nil
        let flow = HandoverFlow(
            source: source(frozen.source).handoverEndpoint,
            target: source(frozen.handover.to).handoverEndpoint,
            sleep: sleep
        )
        if case .failure(let failure) = await flow.cancel(repoKey: row.repoKey, handoverId: frozen.handover.id) {
            message = .failure(failure.message)
        }
        busy.remove(line.id)
        await refresh()
    }

    private func apply(_ outcome: HandoverOutcome, line: UnifiedRepo, to machine: RepoMachine) {
        switch outcome {
        case .completed(let launched, _):
            unfinished[line.id] = nil
            message = .success(ReposText.success(name: line.name, to: machine, launched: launched))
        case .failed(let reason):
            message = .failure(reason)
        case .toFinish(let pending):
            unfinished[line.id] = pending
            message = .failure(pending.message)
        }
    }

    public func dismissMessage() {
        message = nil
    }
}
