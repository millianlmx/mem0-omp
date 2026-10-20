// Le MIROIR des charges utiles du contrat d'API (S-1). Chaque `struct Remote…`
// de `Sources/OMPConsole/Remote/Payloads.swift` est recopié ici sous le MÊME nom,
// avec les MÊMES noms de propriétés stockées — les clés JSON sont celles du dépôt.

import ConsoleCore
import Foundation

// MARK: - Lectures

public struct RemoteVersionPayload: Codable, Equatable, Sendable {
    public var protocolVersion: Int
}

public struct RemoteDeviceRow: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var pairedAtMs: Double
    public var lastSeenAtMs: Double
    public var connected: Bool
}

public struct RemoteDevicesPayload: Codable, Equatable, Sendable {
    public var devices: [RemoteDeviceRow]
}

public struct RemoteComponentsPayload: Codable, Equatable, Sendable {
    public var ompInstalled: Bool
    public var ompPath: String?
    public var setupBanner: String?
    /// Le dossier personnel du Mac ; `nil` quand un Mac antérieur ne l'envoie pas.
    public var homeDirectory: String?

    public init(ompInstalled: Bool, ompPath: String?, setupBanner: String?, homeDirectory: String? = nil) {
        self.ompInstalled = ompInstalled
        self.ompPath = ompPath
        self.setupBanner = setupBanner
        self.homeDirectory = homeDirectory
    }
}

// MARK: - Mémoire

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

/// Une page du sommaire d'une portée (miroir de `remote.RemoteMemoryPagePayload`,
/// S-1) : `scope` vaut `nil` quand aucun projet n'est ouvert ; `nextOffset` est
/// le rang de la page suivante, absent quand la portée est épuisée.
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
    /// La portée résolue par la coque ; `nil` quand aucun projet n'est ouvert.
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

extension RemoteMemoryGraphPayload {
    /// `truncated` est un champ ADDITIF : un Mac d'avant la feature graphe ne
    /// l'émet pas, et la charge reste lisible (absent ⇒ faux).
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        scope = try container.decodeIfPresent(String.self, forKey: .scope)
        nodes = try container.decode([RemoteMemoryGraphNode].self, forKey: .nodes)
        links = try container.decode([RemoteMemoryGraphLink].self, forKey: .links)
        total = try container.decode(Int.self, forKey: .total)
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

// MARK: - Gestes

public struct RemoteAcceptedPayload: Codable, Equatable, Sendable {
    public var accepted: Bool
}

public struct RemotePairPayload: Codable, Equatable, Sendable {
    public var deviceId: String
    public var token: String
    public var protocolVersion: Int
}

// MARK: - Corps de requête

public struct RemotePairRequest: Codable, Equatable, Sendable {
    public var code: String
    public var name: String
    /// L'identité de l'installation : le Mac remplace la ligne qui la porte déjà.
    public var deviceKey: String?
    public var protocolVersion: Int?
}

// MARK: - Évènements du flux temps réel

public struct RemoteHelloEvent: Codable, Equatable, Sendable {
    public var protocolVersion: Int
}

public struct RemoteDevicesEvent: Codable, Equatable, Sendable {
    public var devices: [RemoteDeviceRow]
}
