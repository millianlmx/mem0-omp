// L'HISTORIQUE des features d'un serveur : toutes, terminées comprises (la boîte n'en
// garde que les vivantes), lues par `GET /v1/runs`. Les fils de l'OS et la palette le
// lisent avec la boîte.
//
// Porté par `HarnessModel` (`server.history`, comme le poste) : même transport, même
// jeton. Tant qu'un écran l'observe (`refresh()` appelé), le flux de la boîte le
// relit avec elle ; un geste (priorité, arrêt…) le relit aussi.

import Combine
import Foundation

@MainActor
public final class HarnessRunsHistory: ObservableObject {
    /// Les features du serveur.
    @Published public private(set) var runs: [HarnessRun] = []
    /// Un écran a demandé l'historique : le flux de la boîte le relit avec elle.
    public private(set) var isWatched = false

    private unowned let harness: HarnessModel

    init(harness: HarnessModel) {
        self.harness = harness
    }

    /// Relit la liste à la demande d'un écran, qui la fait suivre au flux.
    public func refresh() async {
        isWatched = true
        await reload()
    }

    /// Relit la liste (le flux, un geste) ; rien n'est republié si elle n'a pas changé,
    /// et une lecture en échec garde la précédente.
    func reload() async {
        guard let page: HarnessRunsPage = try? await harness.fetch(HarnessCall(method: "GET", path: "/v1/runs")) else { return }
        update(\.runs, page.runs)
    }

    /// Les événements du journal qui changent une feature de la liste (son état, son
    /// étape, sa priorité, son titre) : les autres ne la font pas relire.
    nonisolated static func changes(_ name: String) -> Bool {
        name.hasPrefix("run_") || name.hasPrefix("step_") || listEvents.contains(name)
    }

    private nonisolated static let listEvents: Set<String> = [
        "priority", "modules", "modules_set", "recovered", "admission_refused", "follow_up", "split",
        "merged", "merge_queued", "reverted", "retried", "escalation", "escalations", "escalation_answered",
        "specs_ready", "verdict", "review", "decision_auto_timeout", "autonomy_level", "project_created",
    ]

    /// Une feature connue de l'historique.
    public func run(_ id: String) -> HarnessRun? { runs.first { $0.id == id } }

    /// Oublie tout (serveur changé ou oublié).
    func reset() {
        runs = []
        isWatched = false
    }
}

extension HarnessRun {
    /// La priorité d'admission, 0 quand le serveur ne la dit pas (son défaut).
    public var admissionPriority: Int { priority ?? 0 }
}

/// La réponse de `GET /v1/runs`.
struct HarnessRunsPage: Decodable {
    var runs: [HarnessRun]
}

// MARK: - Priorité

/// Les groupes d'une feature, dans l'ordre de lecture : d'abord ce qui attend l'humain,
/// puis ce qui tourne, ce qui attend son tour, et ce qui est fini.
public enum HarnessRunGroup: String, CaseIterable, Sendable, Identifiable {
    case needsYou
    case running
    case queued
    case done

    public var id: String { rawValue }

    /// Les états rangés dans le groupe.
    public var states: [HarnessRunState] {
        switch self {
        case .needsYou: [.escalated, .awaitingHuman]
        case .running: [.running, .merging]
        case .queued: [.queued]
        case .done: [.merged, .failed, .cancelled]
        }
    }

    /// Le groupe d'une feature (un état inconnu de cette version : aucun).
    public static func of(_ run: HarnessRun) -> HarnessRunGroup? {
        guard let phase = run.phase else { return nil }
        return allCases.first { $0.states.contains(phase) }
    }
}

public enum HarnessRunGroups {
    /// Les crans du menu de priorité : haute, normale, basse.
    public static let priorityPresets = [100, 0, -100]
}

extension HarnessRun {
    /// La priorité se change tant que la feature n'est pas terminée.
    public var acceptsPriority: Bool {
        guard let group = HarnessRunGroup.of(self) else { return false }
        return group != .done
    }
}
