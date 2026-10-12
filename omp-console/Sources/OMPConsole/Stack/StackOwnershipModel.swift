// Le superviseur d'ownership du service mémoire (S-5 de bug-embedded-podman-machine,
// S-3 d'omp-console-sans-podman) : tant que l'app tourne, il sonde la propriété du
// port de l'agent mem0-rs (`MemoryAgent.port(environment:)`, 8321 par défaut) à
// intervalle régulier et publie un verdict. Une transition « le port était tenu par
// le mem0-rs embarqué » → « il ne l'est plus » émet UN SEUL évènement d'alerte ; le
// livrer (registre + notification) appartient à `AlertsModel` — ce fichier ne livre
// rien.
//
// Ce que ce fichier ne connaît PAS : le registre d'alertes, la fenêtre, l'interface.
// Il ne fait que publier un `AsyncStream<AlertEvent>` (abonnement unique et de longue
// durée) et l'état observable `holders` que la section Mémoire relit.
//
// Règle de transition, FIGÉE par le contrat : `heldByUs` est vrai quand chaque port
// sondé est `.ours`. Un évènement n'est émis QUE si l'observation PRÉCÉDENTE était
// `heldByUs == true` et la nouvelle ne l'est plus : une absence (service jamais
// préparé, arrêté au lancement) n'est PAS une perte. `.unknown` compte comme une
// perte (l'app cesse de prouver son ownership, elle ne reste pas verte).

import Combine
import Foundation

/// Le superviseur d'ownership (S-5). UNE instance appartient à l'`AppDelegate`,
/// démarrée par `AlertsModel.start()` (aucune autre surface ne la démarre).
@MainActor
final class StackOwnershipModel: ObservableObject {
    /// Le verdict de la dernière observation, pour le port du service seulement.
    @Published private(set) var holders: [Int: MemoryPortOwnership] = [:]

    /// Le flux d'évènements de perte d'ownership. Un SEUL consommateur (l'abonnement
    /// d'`AlertsModel`) — c'est la sémantique d'`AsyncStream`.
    let events: AsyncStream<AlertEvent>

    /// La période de scrutation (20 s par défaut, S-5). Les tests la raccourcissent.
    var interval: Double = 20

    /// Les ports sondés : celui de l'agent mem0-rs, et lui seul.
    let ports: [Int]

    private let ourExecutable: URL
    private let environment: [String: String]
    private let run: CommandRunner
    private let nowMs: @Sendable () -> Double
    private let continuation: AsyncStream<AlertEvent>.Continuation
    private var task: Task<Void, Never>?
    /// Le verdict de l'observation PRÉCÉDENTE : c'est lui qui fait foi pour la
    /// transition (une absence d'emblée n'émet rien).
    private var heldByUsPreviously = false

    init(
        ourExecutable: URL = MemoryAgent.embeddedBinary(),
        environment: [String: String] = ProcessInfo.processInfo.environment,
        run: CommandRunner = .live,
        nowMs: @escaping @Sendable () -> Double = { StoreClock.live.nowMs() }
    ) {
        self.ourExecutable = ourExecutable
        self.environment = environment
        self.ports = [MemoryAgent.port(environment: environment)]
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

    /// Une observation des ports, puis la règle de transition figée.
    func refresh() async {
        var observed: [Int: MemoryPortOwnership] = [:]
        for port in ports {
            observed[port] = await StackOwnership.holder(
                ofPort: port,
                ourExecutable: ourExecutable,
                environment: environment,
                run: run
            )
        }
        holders = observed

        let heldByUs = ports.allSatisfy { Self.isOurs(observed[$0]) }
        defer { heldByUsPreviously = heldByUs }
        // Aucun évènement si l'app n'a jamais PROUVÉ son ownership (S-5).
        guard heldByUsPreviously, !heldByUs else { return }
        guard let (port, ownership) = ports.compactMap({ port -> (Int, MemoryPortOwnership)? in
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
    /// et textes figés (S-5). `ownerKey` = `process:<pid>` | `unknown` | `free`.
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
