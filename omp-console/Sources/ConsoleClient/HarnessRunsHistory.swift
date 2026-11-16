// L'HISTORIQUE des features d'un serveur : toutes, terminées comprises (la boîte n'en
// garde que les vivantes), lues par `GET /v1/runs`. Les fils de l'OS et la palette le
// lisent avec la boîte.
//
// Porté par `HarnessModel` (`server.history`, comme le poste) : même transport, même
// jeton. Tant qu'un écran l'observe (`refresh()` appelé), le flux de la boîte le
// relit avec elle ; un geste (priorité, arrêt…) le relit aussi. Ces relectures sont
// INCRÉMENTALES : `GET /v1/runs?since=<at>` ne rend que les runs écrits depuis la lecture
// précédente (et ceux en file), fusionnés par id ; `refresh()` (ouverture, retour au
// premier plan) relit la liste : les runs vivants et les `recentLimit` terminés les plus
// récents (`?recent=`), pas tout l'historique. Un serveur sans `since` ni `recent` rend
// tout, et la liste est remplacée.

import Combine
import Foundation

@MainActor
public final class HarnessRunsHistory: ObservableObject {
    /// Les features du serveur.
    @Published public private(set) var runs: [HarnessRun] = []
    /// Un écran a demandé l'historique : le flux de la boîte le relit avec elle.
    public private(set) var isWatched = false

    private unowned let harness: HarnessModel
    /// L'instant serveur (`at`) de la dernière lecture : la suivante ne demande que ce qui a
    /// été écrit depuis. `nil` : la prochaine lecture est complète.
    private var syncedAt: Double?
    /// Les features terminées lues à l'ouverture : les plus récentes.
    static let recentLimit = 500

    init(harness: HarnessModel) {
        self.harness = harness
    }

    /// Relit la liste à la demande d'un écran, qui la fait suivre au flux.
    public func refresh() async {
        isWatched = true
        syncedAt = nil
        await reload()
    }

    /// Relit la liste (le flux, un geste) : seulement ce qui a changé depuis la lecture
    /// précédente quand le serveur sait le dire. Rien n'est republié si elle n'a pas changé,
    /// et une lecture en échec garde la précédente.
    func reload() async {
        let path = syncedAt.map { "/v1/runs?since=\(Int64($0))" } ?? "/v1/runs?recent=\(Self.recentLimit)"
        guard let page: HarnessRunsPage = try? await harness.fetch(HarnessCall(method: "GET", path: path)) else { return }
        update(\.runs, page.since == nil ? page.runs : Self.merging(page.runs, into: runs))
        syncedAt = page.at
    }

    /// `current` où chaque run de `changed` remplace celui de même id, à sa place ; les runs
    /// inconnus s'ajoutent à la fin, dans l'ordre du serveur.
    nonisolated static func merging(_ changed: [HarnessRun], into current: [HarnessRun]) -> [HarnessRun] {
        guard !changed.isEmpty else { return current }
        var fresh = Dictionary(changed.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        var merged = current.map { run in fresh.removeValue(forKey: run.id) ?? run }
        merged.append(contentsOf: changed.filter { fresh.removeValue(forKey: $0.id) != nil })
        return merged
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
        syncedAt = nil
    }
}

extension HarnessRun {
    /// La priorité d'admission, 0 quand le serveur ne la dit pas (son défaut).
    public var admissionPriority: Int { priority ?? 0 }
}

/// La réponse de `GET /v1/runs`.
struct HarnessRunsPage: Decodable {
    var runs: [HarnessRun]
    /// L'instant serveur de la lecture, d'où reprendre (absent : serveur sans `since`).
    var at: Double?
    /// Présent : la page ne porte que les runs écrits depuis cet instant (et ceux en file).
    var since: Double?
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
