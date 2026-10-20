// Les doublures de la bascule et de la vue unifiée des dépôts : deux machines
// factices (extrémité de bascule + source de dépôts) et des lignes de dépôt
// prêtes à l'emploi. AUCUN réseau.

import Combine
@testable import ConsoleClient
import ConsoleCore
import Foundation

/// Le journal ORDONNÉ des appels de plusieurs extrémités : la séquence 1-2-3 d'une
/// bascule se lit d'un coup.
final class CallLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []

    func add(_ entry: String) { lock.withLock { items.append(entry) } }
    var entries: [String] { lock.withLock { items } }
}

/// Une extrémité de bascule scriptée : chaque geste est journalisé, puis réussit ou
/// échoue selon le script. `commitFailures` = nombre d'échecs de `commit` avant le
/// premier succès (`Int.max` : n'aboutit jamais).
final class FakeEndpoint: HandoverEndpoint, @unchecked Sendable {
    let name: String
    private let log: CallLog
    private let lock = NSLock()
    private var commitFailuresLeft: Int
    private let handoverError: HandoverFailure?
    private let adoptError: HandoverFailure?
    private let cancelError: HandoverFailure?
    private let commitError: HandoverFailure
    private let charge: HandoverCharge
    private let adoption: HandoverAdoption
    private var committed: [[String]] = []

    init(
        _ name: String,
        log: CallLog,
        charge: HandoverCharge = FakeEndpoint.defaultCharge,
        adoption: HandoverAdoption = FakeEndpoint.defaultAdoption,
        handoverError: HandoverFailure? = nil,
        adoptError: HandoverFailure? = nil,
        cancelError: HandoverFailure? = nil,
        commitFailures: Int = 0,
        commitError: HandoverFailure = HandoverFailure("machine injoignable")
    ) {
        self.name = name
        self.log = log
        self.charge = charge
        self.adoption = adoption
        self.handoverError = handoverError
        self.adoptError = adoptError
        self.cancelError = cancelError
        self.commitFailuresLeft = commitFailures
        self.commitError = commitError
    }

    static let defaultCharge = HandoverCharge(
        id: "h-1",
        identity: "github.com/o/n",
        features: [
            HandoverFeatureCharge(slug: "a", description: "première"),
            HandoverFeatureCharge(slug: "b", description: "seconde", deps: ["a"], modelReqSpecs: "p/m"),
        ]
    )

    static let defaultAdoption = HandoverAdoption(
        repoKey: "k-vps", repoRoot: "/srv/repos/o/n", cloned: true, launched: ["a", "b"], refused: []
    )

    var commits: [[String]] { lock.withLock { committed } }

    func handover(repoKey: String, to: RepoMachine) async throws -> HandoverCharge {
        log.add("\(name).handover(\(repoKey),\(to.rawValue))")
        if let handoverError { throw handoverError }
        return charge
    }

    func adopt(identity: String, features: [HandoverFeatureCharge]) async throws -> HandoverAdoption {
        log.add("\(name).adopt(\(identity),\(features.map(\.slug).joined(separator: "+")))")
        if let adoptError { throw adoptError }
        return adoption
    }

    func commit(repoKey: String, handoverId: String, slugs: [String]) async throws {
        log.add("\(name).commit(\(repoKey),\(handoverId),\(slugs.joined(separator: "+")))")
        let failing = lock.withLock { () -> Bool in
            committed.append(slugs)
            guard commitFailuresLeft > 0 else { return false }
            if commitFailuresLeft != Int.max { commitFailuresLeft -= 1 }
            return true
        }
        if failing { throw commitError }
    }

    func cancel(repoKey: String, handoverId: String) async throws {
        log.add("\(name).cancel(\(repoKey),\(handoverId))")
        if let cancelError { throw cancelError }
    }
}

/// L'attente injectée : enregistre les délais demandés, sans attendre.
final class SleepRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Double] = []

    var delays: [Double] { lock.withLock { items } }

    var sleep: @Sendable (Double) async -> Void {
        { [self] seconds in lock.withLock { items.append(seconds) } }
    }
}

/// Une machine factice de la section « Dépôts ».
@MainActor
final class FakeMachineSource: MachineSource {
    let machine: RepoMachine
    var availability: MachineAvailability { didSet { changed.send() } }
    var snapshot: StoreSnapshot? { didSet { changed.send() } }
    var boardState: KanbanBoardState = .loading
    /// Ce que `fetchRepos()` rend ; `nil` : la lecture échoue.
    var repos: [RepoRow]?
    private(set) var fetchCount = 0
    let endpoint: FakeEndpoint
    private let changed = PassthroughSubject<Void, Never>()

    init(_ machine: RepoMachine, availability: MachineAvailability, repos: [RepoRow]? = [], endpoint: FakeEndpoint) {
        self.machine = machine
        self.availability = availability
        self.repos = repos
        self.endpoint = endpoint
    }

    var changes: AnyPublisher<Void, Never> { changed.eraseToAnyPublisher() }

    func fetchRepos() async throws -> [RepoRow] {
        fetchCount += 1
        guard let repos else { throw HandoverFailure("lecture impossible") }
        return repos
    }

    var handoverEndpoint: any HandoverEndpoint { endpoint }
}

// MARK: - Lignes de dépôt

enum RepoFixtures {
    static func row(
        _ key: String,
        root: String? = nil,
        name: String = "n",
        identity: String? = "github.com/o/n",
        handover: RepoHandover? = nil
    ) -> RepoRow {
        RepoRow(repoKey: key, repoRoot: root ?? "/work/\(key)", name: name, identity: identity, handover: handover)
    }

    static func feature(_ slug: String, state: LotFeatureState, worktree: String) -> LotFeature {
        LotFeature(
            slug: slug, name: slug, branch: "feat/\(slug)", worktree: worktree, deps: [], origin: .panneau,
            state: state, phase: .impl, waitKind: nil, waitPrompt: nil, sessionFile: nil, pendingTexts: [],
            prUrl: nil, stopReason: nil, fixes: 0, reviewRuns: 0, unreadableRuns: 0, reviewHash: nil,
            lastVerdict: nil, lastBlockers: 0, lastRunSessionFile: nil, launched: nil, auditSession: nil,
            relayKind: nil, base: nil, model: nil, modelReqSpecs: nil, modelImplReview: nil, held: nil,
            contractHash: nil, addedAt: 0, sinceAt: 0, updatedAt: 0, endedAt: nil
        )
    }

    /// Un instantané dont le lot du dépôt `root` porte ces features.
    static func snapshot(root: String, features: [LotFeature]) -> StoreSnapshot {
        var snapshot = ClientFixtures.snapshot()
        let lot = Lot(
            id: "lot", repoRoot: root, status: .running, reviewCap: 3, slotCap: 2,
            recapAt: nil, owner: LotOwner(pid: nil, sessionFile: nil, sessionId: nil, heartbeatAt: nil),
            createdAt: 0, launchedAt: 0, features: features, isStale: false
        )
        snapshot.lots = LotEnvelope(availability: .present, lots: [lot], discardedEntries: [])
        return snapshot
    }
}
