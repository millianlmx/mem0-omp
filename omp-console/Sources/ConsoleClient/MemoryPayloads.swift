// Ce que l'app iOS lit de la mémoire du serveur (`MemoryReader`) : les pages du
// sommaire d'une portée, une recherche sélectionnée comme `mem0_search`, et le
// graphe des souvenirs, dérivé par le noyau partagé (`MemoryGraph`).

import Foundation


public struct RemoteMemoryRow: Codable, Equatable, Sendable {
    public var id: String
    public var text: String
    public var updatedAt: String?
    public var score: Double?
    public var tags: [String]
    public var agentId: String?

    public init(
        id: String,
        text: String,
        updatedAt: String?,
        score: Double?,
        tags: [String],
        agentId: String?
    ) {
        self.id = id
        self.text = text
        self.updatedAt = updatedAt
        self.score = score
        self.tags = tags
        self.agentId = agentId
    }
}

/// Une page du sommaire d'une portée : `scope` vaut `nil` quand aucun projet n'est
/// choisi ; `nextOffset` est le rang de la page suivante, absent quand la portée
/// est épuisée.
public struct RemoteMemoryPagePayload: Codable, Equatable, Sendable {
    public var scope: String?
    public var total: Int
    public var offset: Int
    public var rows: [RemoteMemoryRow]
    public var nextOffset: Int?

    public init(scope: String?, total: Int, offset: Int, rows: [RemoteMemoryRow], nextOffset: Int?) {
        self.scope = scope
        self.total = total
        self.offset = offset
        self.rows = rows
        self.nextOffset = nextOffset
    }
}

public struct RemoteMemorySearchPayload: Codable, Equatable, Sendable {
    public var rows: [RemoteMemoryRow]
    public var candidates: Int
    public var scored: Int

    public init(rows: [RemoteMemoryRow], candidates: Int, scored: Int) {
        self.rows = rows
        self.candidates = candidates
        self.scored = scored
    }
}

public struct RemoteMemoryGraphNode: Codable, Equatable, Sendable {
    public var id: String
    public var label: String
    public var scope: String
    /// Le texte INTÉGRAL du souvenir (champ ADDITIF OPTIONNEL) ; `nil` pour un
    /// nœud-étiquette.
    public var text: String?
    /// Les étiquettes du souvenir (champ ADDITIF OPTIONNEL) ; `nil` pour un
    /// nœud-étiquette.
    public var tags: [String]?

    public init(id: String, label: String, scope: String, text: String? = nil, tags: [String]? = nil) {
        self.id = id
        self.label = label
        self.scope = scope
        self.text = text
        self.tags = tags
    }
}

public struct RemoteMemoryGraphLink: Codable, Equatable, Sendable {
    public var a: String
    public var b: String
    public var kind: String
    public var score: Double?

    public init(a: String, b: String, kind: String, score: Double? = nil) {
        self.a = a
        self.b = b
        self.kind = kind
        self.score = score
    }
}

public struct RemoteMemoryGraphPayload: Codable, Equatable, Sendable {
    /// La portée lue ; `nil` quand aucun projet n'est choisi.
    public var scope: String?
    public var nodes: [RemoteMemoryGraphNode]
    public var links: [RemoteMemoryGraphLink]
    public var total: Int
    public var truncated: Bool

    public init(scope: String?, nodes: [RemoteMemoryGraphNode], links: [RemoteMemoryGraphLink], total: Int, truncated: Bool = false) {
        self.scope = scope
        self.nodes = nodes
        self.links = links
        self.total = total
        self.truncated = truncated
    }
}
