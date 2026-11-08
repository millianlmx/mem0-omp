// L'HISTORIQUE des features d'un serveur : toutes, terminées comprises (la boîte n'en
// garde que les vivantes), lues par `GET /v1/runs?state=&repo=` — l'état et le dépôt
// filtrent côté serveur, le projet et la recherche texte côté app. La liste se montre
// par pages (`pageSize`) : « Afficher plus » en ajoute une.
//
// Porté par `HarnessModel` (`server.history`, comme le poste) : même transport, même
// jeton. Tant qu'un écran l'observe (`refresh()` appelé), le flux de la boîte le
// relit avec elle ; un geste (priorité, arrêt…) le relit aussi.
//
// La section Features range `filtered` par groupes (`HarnessRunGroups`) : ce qui
// attend l'humain, ce qui tourne, ce qui attend son tour, ce qui est terminé.

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

    /// Les features retenues par tous les filtres, dans l'ordre choisi.
    public var filtered: [HarnessRun] {
        Self.filter(runs, projectId: projectId, query: query).sorted(by: sort)
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

// MARK: - Groupes

/// Les groupes de la liste des features, dans l'ordre de lecture : d'abord ce qui
/// attend l'humain, puis ce qui tourne, ce qui attend son tour, et ce qui est fini.
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
    /// Les features par groupe, les groupes vides écartés. `live` (la boîte, déjà
    /// filtrée comme l'historique par l'appelant) prime sur l'historique pour une même
    /// feature — c'est l'état le plus frais — et y ajoute celles qu'il ne connaît pas
    /// encore (lancées depuis sa lecture). L'attente et le travail se lisent du plus
    /// ancien au plus récent changement (ce qui attend depuis longtemps d'abord), la
    /// file dans l'ordre d'admission, le fini du plus récent.
    public static func groups(_ runs: [HarnessRun], live: [HarnessRun] = []) -> [(group: HarnessRunGroup, runs: [HarnessRun])] {
        let fresh = Dictionary(live.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        // Une feature peut figurer deux fois dans la boîte (ses questions et sa ligne) :
        // chacune ne compte qu'une fois.
        var known = Set(runs.map(\.id))
        let merged = runs.map { fresh[$0.id] ?? $0 } + live.filter { known.insert($0.id).inserted }
        return HarnessRunGroup.allCases.compactMap { group in
            let members = merged.filter { HarnessRunGroup.of($0) == group }
            guard !members.isEmpty else { return nil }
            let ordered: [HarnessRun] = switch group {
            case .needsYou, .running: members.sorted { $0.updatedAt < $1.updatedAt }
            case .queued: members.sorted(by: .priority)
            case .done: members.sorted(by: .updated)
            }
            return (group, ordered)
        }
    }

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
