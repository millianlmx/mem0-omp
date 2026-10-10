// Le superviseur d'ownership de la pile (S-5, BR-8 ; AC-5) : tant que l'app tourne,
// il sonde la propriété de `8321` et `6333` à intervalle régulier et publie un
// verdict. Une transition « les deux ports étaient tenus par la pile de l'app » →
// « au moins un ne l'est plus » émet UN SEUL évènement d'alerte ; le livrer (registre
// + notification) appartient à `AlertsModel` — ce fichier ne livre rien.
//
// Ce que ce fichier ne connaît PAS : le registre d'alertes, la fenêtre, l'interface.
// Il ne fait que publier un `AsyncStream<AlertEvent>` (abonnement unique et de longue
// durée) et l'état observable `holders` que la section Mémoire relit.
//
// Règle de transition, FIGÉE par le contrat : `heldByUs` est vrai quand les DEUX
// ports sont `.ours`. Un évènement n'est émis QUE si l'observation PRÉCÉDENTE était
// `heldByUs == true` et la nouvelle ne l'est plus : une absence (pile jamais
// préparée, pile arrêtée au lancement) n'est PAS une perte. `.unknown` compte comme
// une perte (l'app cesse de prouver son ownership, elle ne reste pas verte).

import Combine
import Foundation

/// Le superviseur d'ownership (S-5). UNE instance appartient à l'`AppDelegate`,
/// démarrée par `AlertsModel.start()` (aucune autre surface ne la démarre).
@MainActor
final class StackOwnershipModel: ObservableObject {
    /// Le verdict de la dernière observation, pour `8321` et `6333` uniquement.
    @Published private(set) var holders: [Int: MemoryPortOwnership] = [:]

    /// Le flux d'évènements de perte d'ownership. Un SEUL consommateur (l'abonnement
    /// d'`AlertsModel`) — c'est la sémantique d'`AsyncStream`.
    let events: AsyncStream<AlertEvent>

    /// La période de scrutation (20 s par défaut, S-5). Les tests la raccourcissent.
    var interval: Double = 20

    /// Les ports de la pile mémoire de l'app, dans l'ordre de désignation figé.
    static let ports = [8321, 6333]

    private let paths: AppPaths
    private let environment: [String: String]
    private let run: CommandRunner
    private let nowMs: @Sendable () -> Double
    private let continuation: AsyncStream<AlertEvent>.Continuation
    private var task: Task<Void, Never>?
    /// Le verdict de l'observation PRÉCÉDENTE : c'est lui qui fait foi pour la
    /// transition (une absence d'emblée n'émet rien).
    private var heldByUsPreviously = false

    init(
        paths: AppPaths = .standard(),
        environment: [String: String] = ProcessInfo.processInfo.environment,
        run: CommandRunner = .live,
        nowMs: @escaping @Sendable () -> Double = { StoreClock.live.nowMs() }
    ) {
        self.paths = paths
        self.environment = environment
        self.run = run
        self.nowMs = nowMs
        let (stream, continuation) = AsyncStream<AlertEvent>.makeStream()
        self.events = stream
        self.continuation = continuation
    }

    /// Démarre la scrutation : une observation IMMÉDIATE, puis toutes les
    /// `interval` secondes. Idempotent (un `start()` sans `stop()` ne double pas).
    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                let interval = self.interval
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    /// Arrête la scrutation. Le flux N'EST PAS terminé : un `start()` ultérieur
    /// d'`AlertsModel` peut se réabonner.
    func stop() {
        task?.cancel()
        task = nil
    }

    /// Une observation des DEUX ports, puis la règle de transition figée.
    func refresh() async {
        var observed: [Int: MemoryPortOwnership] = [:]
        for port in Self.ports {
            observed[port] = await StackOwnership.holder(
                ofPort: port,
                paths: paths,
                environment: environment,
                run: run
            )
        }
        holders = observed

        let heldByUs = Self.ports.allSatisfy { Self.isOurs(observed[$0]) }
        defer { heldByUsPreviously = heldByUs }
        // Aucun évènement si l'app n'a jamais PROUVÉ son ownership (S-5).
        guard heldByUsPreviously, !heldByUs else { return }
        guard let (port, ownership) = Self.ports.compactMap({ port -> (Int, MemoryPortOwnership)? in
            guard let holder = observed[port], !Self.isOurs(holder) else { return nil }
            return (port, holder)
        }).first else { return }
        continuation.yield(Self.lossEvent(port: port, ownership: ownership))
    }

    // MARK: - Les règles pures

    /// « Ce port est-il tenu par la pile de l'app ? » — la seule lecture admise de
    /// `MemoryPortOwnership.ours`, dont la charge ne compte pas.
    private static func isOurs(_ ownership: MemoryPortOwnership?) -> Bool {
        if case .ours = ownership { return true }
        return false
    }

    /// L'évènement d'une perte : clé stable `stack-ownership-lost:<port>:<ownerKey>`
    /// et textes figés (S-5). `ownerKey` = `legacy:<conteneur>` | `process:<pid>` |
    /// `unknown` | `free`.
    private static func lossEvent(port: Int, ownership: MemoryPortOwnership) -> AlertEvent {
        AlertEvent(
            key: "stack-ownership-lost:\(port):\(ownerKey(of: ownership))",
            kind: .stackOwnershipLost,
            title: "La pile mémoire d'OMP Console a perdu le port \(port)",
            body: "\(ownership.userDescription) l'occupe désormais : les souvenirs ne passent plus par la pile de l'app."
        )
    }

    private static func ownerKey(of ownership: MemoryPortOwnership) -> String {
        switch ownership {
        case .legacyStack(let container):
            return "legacy:\(container)"
        case .foreign(_, let pid):
            return "process:\(pid)"
        case .unknown:
            return "unknown"
        case .free:
            return "free"
        case .ours:
            // Inatteignable : `lossEvent` n'est appelé que pour un port non `.ours`.
            return "ours"
        }
    }
}
