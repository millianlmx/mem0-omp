// L'HISTORIQUE des features d'un serveur : toutes, terminées comprises (la boîte n'en
// garde que les vivantes), lues par `GET /v1/runs?state=&repo=` — l'état et le dépôt
// filtrent côté serveur, le projet et la recherche texte côté app. La liste se montre
// par pages (`pageSize`) : « Afficher plus » en ajoute une.
//
// Porté par `HarnessModel` (`server.history`, comme le poste) : même transport, même
// jeton. Tant qu'un écran l'observe (`refresh()` appelé), le flux de la boîte le
// relit avec elle ; un geste (priorité, arrêt…) le relit aussi.
//
// Le tableau Mac (tri par colonne) et le kanban par état lisent `filtered` ;
// `HarnessKanban` range les features en colonnes et calcule la priorité d'un
// glisser-déposer.

import Combine
import Foundation

/// L'ordre de la liste (iOS, palette) ; le tableau Mac trie lui-même par colonne.
public enum HarnessRunsSort: String, CaseIterable, Sendable, Identifiable {
    /// Les plus récemment changées d'abord.
    case updated
    /// Les plus récemment lancées d'abord.
    case created
    /// Les plus prioritaires d'abord, puis les plus anciennes (l'ordre d'admission).
    case priority
    case title

    public var id: String { rawValue }
}

@MainActor
public final class HarnessRunsHistory: ObservableObject {
    /// Une page de la liste.
    public static let pageSize = 50

    /// Les features lues pour les filtres serveur (état, dépôt).
    @Published public private(set) var runs: [HarnessRun] = []
    /// Les états retenus (vide : tous).
    @Published public var states: Set<HarnessRunState> = [] { didSet { if states != oldValue { Task { await refresh() } } } }
    /// Le dépôt retenu (`nil` : tous).
    @Published public var repo: String? { didSet { if repo != oldValue { Task { await refresh() } } } }
    /// Le projet retenu (`nil` : tous).
    @Published public var projectId: String? { didSet { shown = Self.pageSize } }
    /// La recherche texte : titre, demande, identifiant, dépôt, modules.
    @Published public var query = "" { didSet { shown = Self.pageSize } }
    @Published public var sort: HarnessRunsSort = .updated
    /// L'ordre du tableau du Mac (tri par colonne) ; vide : l'ordre de `sort`.
    @Published public var order: [KeyPathComparator<HarnessRun>] = []
    /// Les features sélectionnées dans le tableau du Mac.
    @Published public var selection: Set<String> = []
    /// Le nombre de lignes montrées.
    @Published public private(set) var shown = HarnessRunsHistory.pageSize
    @Published public private(set) var isLoading = false
    /// L'échec de la dernière lecture, effacé par la suivante.
    @Published public private(set) var failure: HarnessFailure?
    /// Un écran a demandé l'historique : le flux de la boîte le relit avec elle.
    public private(set) var isWatched = false

    private unowned let harness: HarnessModel

    init(harness: HarnessModel) {
        self.harness = harness
    }

    /// Le chemin de la lecture : les filtres serveur, en requête.
    public nonisolated static func path(states: Set<HarnessRunState>, repo: String?) -> String {
        var items: [String] = []
        if !states.isEmpty { items.append("state=" + states.map(\.rawValue).sorted().joined(separator: ",")) }
        if let repo, let encoded = repo.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) {
            items.append("repo=" + encoded)
        }
        return items.isEmpty ? "/v1/runs" : "/v1/runs?" + items.joined(separator: "&")
    }

    /// Relit la liste avec les filtres serveur.
    public func refresh() async {
        isWatched = true
        isLoading = true
        defer { isLoading = false }
        do {
            let page: HarnessRunsPage = try await harness.fetch(HarnessCall(method: "GET", path: Self.path(states: states, repo: repo)))
            runs = page.runs
            failure = nil
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Les features retenues par tous les filtres, dans l'ordre choisi (celui du
    /// tableau quand une colonne trie).
    public var filtered: [HarnessRun] {
        let kept = Self.filter(runs, projectId: projectId, query: query)
        return order.isEmpty ? kept.sorted(by: sort) : kept.sorted(using: order)
    }

    /// La page montrée.
    public var page: [HarnessRun] { Array(filtered.prefix(shown)) }

    /// Il reste des lignes au-delà de la page.
    public var hasMore: Bool { filtered.count > shown }

    public func showMore() { shown += Self.pageSize }

    /// Un filtre au moins est posé.
    public var isFiltered: Bool { !states.isEmpty || repo != nil || projectId != nil || !query.trimmingCharacters(in: .whitespaces).isEmpty }

    /// Lève tous les filtres.
    public func clearFilters() {
        projectId = nil
        query = ""
        repo = nil
        states = []
    }

    /// Une feature connue de l'historique.
    public func run(_ id: String) -> HarnessRun? { runs.first { $0.id == id } }

    /// Oublie tout (serveur changé ou oublié).
    func reset() {
        runs = []
        failure = nil
        isWatched = false
        shown = Self.pageSize
    }

    /// Le filtre côté app : le projet, puis chaque mot de la recherche (sans casse ni
    /// accents) dans le titre, la demande, l'identifiant, le slug, le dépôt ou un module.
    public nonisolated static func filter(_ runs: [HarnessRun], projectId: String?, query: String) -> [HarnessRun] {
        let words = query.split(whereSeparator: \.isWhitespace).map { fold(String($0)) }
        return runs.filter { run in
            if let projectId, run.projectId != projectId { return false }
            guard !words.isEmpty else { return true }
            let haystack = fold([run.title, run.request, run.id, run.slug, run.repo, run.modules.joined(separator: " ")].joined(separator: " "))
            return words.allSatisfy { haystack.contains($0) }
        }
    }

    nonisolated static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }
}

extension Array where Element == HarnessRun {
    /// La liste dans l'ordre demandé.
    public func sorted(by sort: HarnessRunsSort) -> [HarnessRun] {
        switch sort {
        case .updated: sorted { $0.updatedAt > $1.updatedAt }
        case .created: sorted { $0.createdAt > $1.createdAt }
        case .priority: sorted { ($0.admissionPriority, -$0.createdAt) > ($1.admissionPriority, -$1.createdAt) }
        case .title: sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        }
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

// MARK: - Kanban

/// Les colonnes du kanban, dans l'ordre de la vie d'une feature.
public enum HarnessKanbanColumn: String, CaseIterable, Sendable, Identifiable {
    case queued
    case running
    case waiting
    case merged
    case stopped

    public var id: String { rawValue }

    /// Les états rangés dans la colonne.
    public var states: [HarnessRunState] {
        switch self {
        case .queued: [.queued]
        case .running: [.running, .merging]
        case .waiting: [.escalated, .awaitingHuman]
        case .merged: [.merged]
        case .stopped: [.failed, .cancelled]
        }
    }

    /// La colonne d'une feature (un état inconnu de cette version : aucune).
    public static func of(_ run: HarnessRun) -> HarnessKanbanColumn? {
        guard let phase = run.phase else { return nil }
        return allCases.first { $0.states.contains(phase) }
    }

    /// La priorité se change tant que la feature n'est pas terminée.
    public var acceptsPriority: Bool { self != .merged && self != .stopped }
}

public enum HarnessKanban {
    /// Les features par colonne, chaque colonne dans l'ordre d'admission.
    public static func columns(_ runs: [HarnessRun]) -> [(column: HarnessKanbanColumn, runs: [HarnessRun])] {
        let ordered = runs.sorted(by: .priority)
        return HarnessKanbanColumn.allCases.map { column in
            (column, ordered.filter { HarnessKanbanColumn.of($0) == column })
        }
    }

    /// La priorité qui place `moved` juste devant `target` dans l'ordre d'admission
    /// (bornée à -1000…1000) — plus haute ou plus basse que la sienne —, ou `nil`
    /// quand le dépôt ne change rien : même feature, colonne terminée, même priorité.
    public static func priority(moving moved: HarnessRun, before target: HarnessRun) -> Int? {
        guard moved.id != target.id,
              let column = HarnessKanbanColumn.of(moved), column.acceptsPriority,
              HarnessKanbanColumn.of(target)?.acceptsPriority == true
        else { return nil }
        let wanted = min(target.admissionPriority + 1, HarnessLaunchOptions.priorityRange.upperBound)
        return moved.admissionPriority == wanted ? nil : wanted
    }

    /// Les crans du menu de priorité : haute, normale, basse.
    public static let presets = [100, 0, -100]
}
