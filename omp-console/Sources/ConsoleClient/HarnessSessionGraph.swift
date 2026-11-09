// La session en graphe vue par les apps : la CARTE d'une question (ce que l'humain lit en
// 30 secondes : `headline`, `stake`, une ligne par option, le schéma de bifurcation établi →
// ambiguïté → options → impacts), le BRIEFING en tête des specs à valider et d'un arbitrage,
// et le GRAPHE de session d'un run (`GET /v1/runs/{id}/graph`) : ce que l'agent a lu,
// cherché, testé, modifié et décidé, relu sur l'événement éphémère `graph`.
//
// Ce fichier est pur côté données : la mise en voies (une par étape, fait / en cours /
// bloqué), le regroupement par dossier et le lien d'un nœud vers l'entrée du direct qui
// lui correspond se calculent ici et se testent sans vue. Les vues vivent dans ConsoleUI
// (`DecisionCardViews.swift`, `SessionGraphViews.swift`).

import Foundation

// MARK: - Carte d'une question

/// Une option de la carte : sa conséquence pour l'humain, sa réversibilité et son coût.
public struct HarnessCardOption: Codable, Equatable, Sendable, Identifiable {
    public var label: String
    public var impact: String
    public var reversible: Bool
    /// `faible`, `moyen` ou `fort` ; `nil` quand l'agent ne l'a pas dit.
    public var cost: String?

    public init(label: String, impact: String, reversible: Bool, cost: String? = nil) {
        self.label = label
        self.impact = impact
        self.reversible = reversible
        self.cost = cost
    }

    public var id: String { label }
}

/// Un nœud du schéma de bifurcation : `established`, `ambiguity`, `option` ou `impact`.
public struct HarnessSchemaNode: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var kind: String
    public var label: String
    public var recommended: Bool

    public init(id: String, kind: String, label: String, recommended: Bool = false) {
        self.id = id
        self.kind = kind
        self.label = label
        self.recommended = recommended
    }
}

/// Un arc du schéma : du nœud `from` au nœud `to`.
public struct HarnessSchemaEdge: Codable, Equatable, Sendable {
    public var from: String
    public var to: String

    public init(from: String, to: String) {
        self.from = from
        self.to = to
    }
}

/// Le schéma de compréhension, en données (jamais une image) : 12 nœuds au plus.
public struct HarnessCardSchema: Codable, Equatable, Sendable {
    public var nodes: [HarnessSchemaNode]
    public var edges: [HarnessSchemaEdge]

    public init(nodes: [HarnessSchemaNode], edges: [HarnessSchemaEdge]) {
        self.nodes = nodes
        self.edges = edges
    }
}

/// Une branche du schéma : l'option et l'impact qu'elle pointe.
public struct HarnessSchemaBranch: Equatable, Sendable, Identifiable {
    public var option: HarnessSchemaNode
    public var impact: HarnessSchemaNode?

    public var id: String { option.id }
}

extension HarnessCardSchema {
    /// Ce qui est établi (le haut du schéma).
    public var established: HarnessSchemaNode? { nodes.first { $0.kind == "established" } }
    /// Le point d'ambiguïté.
    public var ambiguity: HarnessSchemaNode? { nodes.first { $0.kind == "ambiguity" } }

    /// Chaque option dans l'ordre du schéma, avec l'impact que pointe son arc.
    public var branches: [HarnessSchemaBranch] {
        let byId = Dictionary(nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return nodes.filter { $0.kind == "option" }.map { option in
            let impact = edges.lazy
                .filter { $0.from == option.id }
                .compactMap { byId[$0.to] }
                .first { $0.kind == "impact" }
            return HarnessSchemaBranch(option: option, impact: impact)
        }
    }
}

/// La carte d'une question : ce que l'humain lit d'abord, sans connaître le code.
public struct HarnessCard: Codable, Equatable, Sendable {
    /// La question, 15 mots au plus, sans chemin de fichier ni identifiant de code.
    public var headline: String
    /// L'enjeu, une ligne.
    public var stake: String
    public var options: [HarnessCardOption]
    /// Le libellé de l'option recommandée.
    public var recommended: String
    /// `faible`, `moyenne` ou `forte`.
    public var confidence: String
    /// `true` : le relecteur « humain pressé » a relu la carte.
    public var reviewed: Bool
    public var schema: HarnessCardSchema

    public init(headline: String, stake: String, options: [HarnessCardOption], recommended: String, confidence: String, reviewed: Bool, schema: HarnessCardSchema) {
        self.headline = headline
        self.stake = stake
        self.options = options
        self.recommended = recommended
        self.confidence = confidence
        self.reviewed = reviewed
        self.schema = schema
    }

    /// L'option est la recommandée.
    public func isRecommended(_ option: HarnessCardOption) -> Bool { option.label == recommended }
}

/// La carte en tête des specs à valider ou d'un arbitrage : la ligne « ce que fait la
/// feature », puis les points qui demandent un regard humain.
public struct HarnessBriefing: Codable, Equatable, Sendable {
    public var feature: String
    public var cards: [HarnessCard]

    public init(feature: String, cards: [HarnessCard]) {
        self.feature = feature
        self.cards = cards
    }

    /// Rien à montrer : le run n'attend ni specs ni arbitrage (ou le serveur n'a rien pu écrire).
    public var isEmpty: Bool { feature.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && cards.isEmpty }
}

// MARK: - Graphe de session

/// Un nœud du graphe de session ; les champs sans objet sont `nil`, les compteurs 0.
public struct HarnessGraphNode: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    /// `dir`, `file`, `search`, `test`, `edit`, `decision`, `escalation` ou `step`.
    public var kind: String
    public var label: String
    /// L'id du nœud d'étape (`step:<id>`) d'une recherche, d'un test, d'une modification ou d'une décision.
    public var step: String?
    /// Le dossier d'un fichier ou d'un dossier.
    public var parent: String?
    /// Le chemin relatif au dépôt d'un fichier ou d'un dossier.
    public var path: String?
    /// Le motif d'une recherche.
    public var pattern: String?
    public var reads: Int
    public var edits: Int
    /// Les fichiers qu'un dossier regroupé a absorbés.
    public var files: Int
    /// Le dossier regroupe ses fichiers (ils ne sont plus des nœuds à part).
    public var grouped: Bool
    public var count: Int
    /// L'issue d'un test (`pass`, `fail`, `oom`, `timeout`, `error`, `aborted`).
    public var outcome: String?

    public init(id: String, kind: String, label: String, step: String? = nil, parent: String? = nil, path: String? = nil, pattern: String? = nil, reads: Int = 0, edits: Int = 0, files: Int = 0, grouped: Bool = false, count: Int = 0, outcome: String? = nil) {
        self.id = id
        self.kind = kind
        self.label = label
        self.step = step
        self.parent = parent
        self.path = path
        self.pattern = pattern
        self.reads = reads
        self.edits = edits
        self.files = files
        self.grouped = grouped
        self.count = count
        self.outcome = outcome
    }

    /// Une décision ou une escalade : le point d'où vient une ambiguïté.
    public var isAmbiguity: Bool { kind == "decision" || kind == "escalation" }
}

/// Un arc du graphe : `read`, `searched`, `edited`, `tested`, `led_to` ou `evidence`.
public struct HarnessGraphEdge: Codable, Equatable, Sendable {
    public var from: String
    public var to: String
    public var kind: String
    public var count: Int

    public init(from: String, to: String, kind: String, count: Int = 1) {
        self.from = from
        self.to = to
        self.kind = kind
        self.count = count
    }
}

/// Une décision ou une escalade et les nœuds qui la fondent.
public struct HarnessGraphAmbiguity: Codable, Equatable, Sendable {
    public var node: String
    public var kind: String
    public var evidence: [String]

    public init(node: String, kind: String, evidence: [String]) {
        self.node = node
        self.kind = kind
        self.evidence = evidence
    }
}

/// La réponse de `GET /v1/runs/{id}/graph`.
public struct HarnessGraph: Codable, Equatable, Sendable {
    public var runId: String
    public var version: Int
    /// L'instant de la dernière écriture, en millisecondes ; `nil` pour un graphe vide.
    public var updatedAt: Double?
    public var nodes: [HarnessGraphNode]
    public var edges: [HarnessGraphEdge]
    public var ambiguities: [HarnessGraphAmbiguity]

    public init(runId: String, version: Int, updatedAt: Double? = nil, nodes: [HarnessGraphNode], edges: [HarnessGraphEdge], ambiguities: [HarnessGraphAmbiguity] = []) {
        self.runId = runId
        self.version = version
        self.updatedAt = updatedAt
        self.nodes = nodes
        self.edges = edges
        self.ambiguities = ambiguities
    }

    public var isEmpty: Bool { nodes.isEmpty }

    /// Les nœuds à surligner pour une escalade : son nœud et ses preuves.
    public func highlighted(escalation id: Int) -> Set<String> {
        let node = "escalation:\(id)"
        guard let ambiguity = ambiguities.first(where: { $0.node == node }) else { return [] }
        return Set(ambiguity.evidence).union([node])
    }

    /// Tous les nœuds d'ambiguïté et leurs preuves (l'onglet Carte les met en évidence).
    public var allHighlighted: Set<String> {
        Set(ambiguities.flatMap { [$0.node] + $0.evidence })
    }
}

/// L'avancement d'une étape (et de ce qu'elle a fait) sur la carte.
public enum HarnessGraphProgress: Equatable, Sendable {
    case done, running, blocked
}

/// Une voie de la carte : une étape, son avancement et ce qu'elle a fait.
public struct HarnessGraphLane: Equatable, Sendable, Identifiable {
    public var step: HarnessGraphNode
    public var progress: HarnessGraphProgress
    /// Recherches, tests, modifications, décisions et escalades de l'étape, dans l'ordre du graphe.
    public var actions: [HarnessGraphNode]
    /// Les dossiers et fichiers lus par l'étape.
    public var reads: [HarnessGraphNode]

    public var id: String { step.id }
}

/// Un dossier de la carte et les fichiers qu'il contient (vides s'il les a regroupés).
public struct HarnessGraphFolder: Equatable, Sendable, Identifiable {
    public var node: HarnessGraphNode
    public var files: [HarnessGraphNode]

    public var id: String { node.id }
    /// Le dossier se déplie : il a des fichiers à part.
    public var canExpand: Bool { !files.isEmpty }
}

/// La carte d'un graphe : ses voies (une par étape) et l'arbre des dossiers touchés.
public struct HarnessGraphMap: Equatable, Sendable {
    public var lanes: [HarnessGraphLane]
    public var folders: [HarnessGraphFolder]

    /// La carte entière ; l'état du run donne l'avancement de la dernière étape.
    /// `focus` non vide : seulement les voies et dossiers qui touchent ces nœuds.
    public static func of(_ graph: HarnessGraph, runState: String?, focus: Set<String> = []) -> HarnessGraphMap {
        let byId = Dictionary(graph.nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let steps = graph.nodes.filter { $0.kind == "step" }
        let last = steps.last?.id
        let phase = runState.flatMap(HarnessRunState.init(rawValue:))
        var lanes: [HarnessGraphLane] = steps.map { step in
            let actions = graph.nodes.filter { $0.step == step.id && $0.kind != "step" }
            let edits = Set(actions.filter { $0.kind == "edit" }.map(\.id))
            var seen = Set<String>()
            let reads = graph.edges
                .filter { ($0.from == step.id && $0.kind == "read") || (edits.contains($0.from) && $0.kind == "edited") }
                .compactMap { byId[$0.to] }
                .filter { seen.insert($0.id).inserted }
            let progress: HarnessGraphProgress
            if step.id != last {
                progress = .done
            } else {
                switch phase {
                case .running, .queued, .merging: progress = .running
                case .escalated, .awaitingHuman, .failed: progress = .blocked
                case .merged, .cancelled, nil: progress = .done
                }
            }
            return HarnessGraphLane(step: step, progress: progress, actions: actions, reads: reads)
        }
        var folders: [HarnessGraphFolder] = graph.nodes
            .filter { $0.kind == "dir" }
            .map { dir in HarnessGraphFolder(node: dir, files: graph.nodes.filter { $0.kind == "file" && $0.parent == dir.id }) }
            .filter { $0.canExpand || $0.node.grouped || $0.node.reads > 0 || $0.node.edits > 0 }
            .sorted { ($0.node.path ?? $0.node.label) < ($1.node.path ?? $1.node.label) }
        if !focus.isEmpty {
            lanes = lanes.compactMap { lane in
                let actions = lane.actions.filter { focus.contains($0.id) }
                let reads = lane.reads.filter { focus.contains($0.id) }
                guard !actions.isEmpty || !reads.isEmpty || focus.contains(lane.step.id) else { return nil }
                return HarnessGraphLane(step: lane.step, progress: lane.progress, actions: actions, reads: reads)
            }
            folders = folders.compactMap { folder in
                let files = folder.files.filter { focus.contains($0.id) }
                guard focus.contains(folder.node.id) || !files.isEmpty else { return nil }
                return HarnessGraphFolder(node: folder.node, files: files)
            }
        }
        return HarnessGraphMap(lanes: lanes, folders: folders)
    }

    public var isEmpty: Bool { lanes.isEmpty && folders.isEmpty }
}

// MARK: - Du nœud au direct

/// L'entrée du direct qui correspond à un nœud du graphe, quand le lien existe.
public enum HarnessGraphLink {
    /// Le rang (`seq`) de l'entrée du direct où le nœud est né, ou `nil` sans lien sûr.
    /// - étape : la première entrée de sa n-ième plage d'entrées de même étape ;
    /// - recherche, fichier, dossier : le premier outil dont l'appel cite son motif ou son chemin ;
    /// - test : le premier `run_tests` ; décision, escalade : le premier appel `decision` qui cite son libellé ;
    /// - modification : le premier outil d'écriture ; toujours dans la plage de son étape quand elle est connue.
    public static func entry(for node: HarnessGraphNode, in graph: HarnessGraph, entries: [HarnessSessionEntry]) -> Int? {
        let segments = segments(of: entries)
        let steps = graph.nodes.filter { $0.kind == "step" }
        func segment(of stepId: String?) -> ArraySlice<HarnessSessionEntry>? {
            guard let stepId, let step = steps.first(where: { $0.id == stepId }) else { return nil }
            let rank = steps.prefix { $0.id != stepId }.filter { $0.label == step.label }.count
            let matching = segments.filter { $0.first?.step == step.label }
            return rank < matching.count ? matching[rank] : nil
        }
        if node.kind == "step" { return segment(of: node.id)?.first?.seq }
        let scope = segment(of: node.step) ?? entries[...]
        let tools = scope.filter(\.isTool)
        func citing(_ needle: String?) -> Int? {
            guard let needle, !needle.isEmpty else { return nil }
            return tools.first { ($0.call ?? "").contains(needle) || $0.text.contains(needle) }?.seq
        }
        switch node.kind {
        case "search": return citing(node.pattern)
        case "file", "dir": return citing(node.path)
        case "test": return tools.first { $0.tool == "run_tests" }?.seq
        case "edit": return tools.first { ["edit", "write", "apply_patch"].contains($0.tool ?? "") }?.seq
        case "decision", "escalation":
            let decisions = tools.filter { $0.tool == "decision" }
            let head = String(node.label.prefix(40))
            return (decisions.first { !head.isEmpty && (($0.call ?? "").contains(head) || $0.text.contains(head)) } ?? decisions.first)?.seq
        default: return nil
        }
    }

    /// Les plages d'entrées consécutives de même étape.
    static func segments(of entries: [HarnessSessionEntry]) -> [ArraySlice<HarnessSessionEntry>] {
        var result: [ArraySlice<HarnessSessionEntry>] = []
        var start = entries.startIndex
        for index in entries.indices where index > entries.startIndex && entries[index].step != entries[index - 1].step {
            result.append(entries[start..<index])
            start = index
        }
        if start < entries.endIndex { result.append(entries[start..<entries.endIndex]) }
        return result
    }
}

// MARK: - Lecture

/// Ce que l'onglet « Carte » a lu du serveur.
public enum HarnessGraphAvailability: Equatable, Sendable {
    /// La lecture est en cours : l'onglet n'est pas encore montré.
    case loading
    /// Le serveur ne sert pas le graphe (404, sans la capacité `session-graph`) : pas d'onglet.
    case absent
    /// La lecture a échoué : l'onglet le dit.
    case failed(HarnessFailure)
    case loaded(HarnessGraph)
}

/// Le graphe de session d'UNE feature : lu à l'ouverture, relu quand l'événement `graph`
/// annonce une version plus récente.
@MainActor
public final class HarnessRunGraph: ObservableObject {
    public let runId: String
    @Published public private(set) var availability: HarnessGraphAvailability = .loading

    private let harness: HarnessModel

    public init(harness: HarnessModel, runId: String) {
        self.harness = harness
        self.runId = runId
    }

    /// L'onglet existe : le serveur sert le graphe (une lecture en échec se montre).
    public var showsTab: Bool {
        switch availability {
        case .loading, .absent: false
        case .failed, .loaded: true
        }
    }

    public var graph: HarnessGraph? {
        if case let .loaded(graph) = availability { return graph }
        return nil
    }

    public func load() async {
        do {
            guard let read = try await harness.sessionGraph(runId: runId) else {
                availability = .absent
                return
            }
            availability = .loaded(read)
        } catch {
            guard let failure = HarnessModel.failure(of: error) else { return }
            availability = .failed(failure)
        }
    }

    /// L'événement `graph` a annoncé `version` : relu seulement s'il est plus récent que celui montré.
    public func receive(version: Int?) async {
        guard let version, availability != .absent else { return }
        if let graph, graph.version >= version { return }
        await load()
    }
}

/// Le corps d'un événement `graph` : `{version, nodes, edges}` (des nombres).
struct HarnessGraphSignal: Decodable {
    var runId: String?
    var payload: Payload

    struct Payload: Decodable {
        var version: Int
    }
}

extension HarnessStreamEvent {
    /// La version annoncée par un événement `graph` ; `nil` pour tout autre événement.
    public var graphVersion: Int? {
        guard name == "graph" else { return nil }
        return (try? JSONDecoder().decode(HarnessGraphSignal.self, from: data))?.payload.version
    }
}
