// Les FAITS d'entrée du graphe des souvenirs, partagés par les deux coques : une
// ligne de souvenir, une arête de proximité du service, et un lien manuel.
//
// Ils vivaient dans la coque macOS (`MemoryService.swift` pour les deux premiers,
// `MemoryLinkStore.swift` pour le troisième) ; l'app iOS ne liant que `ConsoleCore`
// et `ConsoleClient`, ils déménagent ici pour que le noyau dérivé (S-2) soit
// atteignable des deux côtés. Ce fichier ne porte AUCUN accès disque ni réseau :
// le service HTTP reste dans `OMPConsole/Memory/MemoryService.swift`, le magasin
// des liens manuels dans `OMPConsole/Memory/MemoryLinkStore.swift`.

import Foundation

// MARK: - Ligne de souvenir

/// Une ligne de souvenir, réduite à ce que l'app affiche (S-1, S-3, S-5) : son
/// identifiant, son texte COMPLET, sa date, son cosinus brut s'il en porte, ses
/// étiquettes (`metadata.tags`, omp-console-redesign S-18 R7) et sa portée
/// (`agent_id`, S-2 — la ligne d'un graphe porte la sienne).
public struct MemoryRow: Identifiable, Equatable, Sendable {
    public var id: String
    public var text: String
    public var updatedAt: String?
    public var semanticScore: Double?
    public var tags: [String]
    public var agentId: String?

    public init(
        id: String,
        text: String,
        updatedAt: String? = nil,
        semanticScore: Double? = nil,
        tags: [String] = [],
        agentId: String? = nil
    ) {
        self.id = id
        self.text = text
        self.updatedAt = updatedAt
        self.semanticScore = semanticScore
        self.tags = tags
        self.agentId = agentId
    }
}

// MARK: - Arête de proximité

/// Une arête de proximité sémantique rendue par le service (S-3) : deux ids de
/// souvenirs et leur cosinus. `source < target` est garanti par le service.
public struct MemoryGraphEdge: Equatable, Sendable {
    public var source: String
    public var target: String
    public var score: Double

    public init(source: String, target: String, score: Double) {
        self.source = source
        self.target = target
        self.score = score
    }
}

// MARK: - Lien manuel

/// Un lien manuel : une paire ORDONNÉE (`a < b`, ordre lexicographique) d'ids de
/// souvenirs. L'ordre est ce qui rend un lien unique quelle que soit la façon dont
/// l'utilisateur l'a créé.
public struct MemoryLink: Hashable, Sendable, Comparable {
    public var a: String
    public var b: String

    public init(a: String, b: String) {
        self.a = a
        self.b = b
    }

    public static func < (left: MemoryLink, right: MemoryLink) -> Bool {
        left.a == right.a ? left.b < right.b : left.a < right.a
    }
}
