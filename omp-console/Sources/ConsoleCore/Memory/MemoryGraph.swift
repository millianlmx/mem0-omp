// Les types PURS du graphe des souvenirs (S-4, S-6) : nœuds, liens et règles de
// visibilité. Aucune vue, aucun réseau, aucun état : tout se dérive des lignes
// chargées et se confronte en test sans rendre quoi que ce soit.
//
// Trois familles de liens, jamais confondues :
//  - `.tag` : dérivé des étiquettes partagées, via un NŒUD-ÉTIQUETTE — jamais une
//    arête directe souvenir ↔ souvenir (S-4) ;
//  - `.semantic(score:)` : dérivé du service (`GET /memory/graph`, S-3) ;
//  - `.manual` : créé à la main par l'utilisateur, persisté dans le fichier local
//    (S-11).
//
// Le noyau est PARTAGÉ par les deux coques (S-2) : il vit dans `ConsoleCore`, donc
// l'app iOS le dérive par le même code que la coque macOS.

import Foundation

// MARK: - Nœuds

/// L'identité d'un nœud : un souvenir du service, ou une étiquette partagée.
public enum MemoryGraphNodeID: Hashable, Sendable {
    case memory(String)
    case tag(String)

    /// L'id du souvenir, ou `nil` pour un nœud-étiquette.
    public var memoryId: String? {
        if case let .memory(id) = self { return id }
        return nil
    }

    /// L'étiquette, ou `nil` pour un nœud de souvenir.
    public var tagName: String? {
        if case let .tag(name) = self { return name }
        return nil
    }
}

/// Un nœud affiché : son libellé (titre du souvenir, ou `#étiquette`) et sa portée
/// (`agent_id` de la ligne ; `nil` pour un nœud-étiquette). `text` et `tags` sont
/// des FAITS du souvenir (texte intégral et étiquettes telles que la ligne les
/// porte) : `nil`/vide pour un nœud-étiquette, jamais un libellé recalculé.
public struct MemoryGraphNode: Equatable, Identifiable, Sendable {
    public var id: MemoryGraphNodeID
    public var label: String
    public var scope: String?
    public var text: String?
    public var tags: [String]

    public init(
        id: MemoryGraphNodeID,
        label: String,
        scope: String?,
        text: String? = nil,
        tags: [String] = []
    ) {
        self.id = id
        self.label = label
        self.scope = scope
        self.text = text
        self.tags = tags
    }
}

// MARK: - Liens

/// La nature d'un lien : c'est elle qui décide du trait à l'écran (plein gris pour
/// un dérivé, discontinu accentué pour un lien manuel).
public enum MemoryGraphLinkKind: Equatable, Sendable {
    case semantic(score: Double)
    case tag
    case manual

    public var isManual: Bool { self == .manual }
}

public struct MemoryGraphLink: Equatable, Sendable {
    public var a: MemoryGraphNodeID
    public var b: MemoryGraphNodeID
    public var kind: MemoryGraphLinkKind

    public init(a: MemoryGraphNodeID, b: MemoryGraphNodeID, kind: MemoryGraphLinkKind) {
        self.a = a
        self.b = b
        self.kind = kind
    }

    /// Les deux extrémités d'un lien de souvenirs, quel que soit son ordre.
    public var memoryEnds: (String, String)? {
        guard let left = a.memoryId, let right = b.memoryId else { return nil }
        return (left, right)
    }
}

// MARK: - Dérivation

public enum MemoryGraph {
    /// Les nœuds d'un jeu de lignes : un par souvenir, dans l'ordre reçu, puis un
    /// par étiquette portée par ≥ 2 souvenirs AFFICHÉS (S-4), triées par nom.
    public static func nodes(rows: [MemoryRow]) -> [MemoryGraphNode] {
        rows.map(memoryNode) + tagNodes(rows: rows, only: nil)
    }

    /// Tous les liens dérivables des lignes : étiquettes partagées (S-4), arêtes du
    /// service (S-3) et liens manuels (S-11). Les liens dont une extrémité n'existe
    /// pas dans `rows` sont ignorés — jamais un nœud fantôme.
    ///
    /// Une étiquette portée par un SEUL souvenir n'émet aucun lien : elle n'a pas de
    /// nœud-étiquette, et « deux souvenirs qui partagent une étiquette » est la seule
    /// relation que les étiquettes expriment.
    public static func links(rows: [MemoryRow], edges: [MemoryGraphEdge], manual: Set<MemoryLink>) -> [MemoryGraphLink] {
        let present = Set(rows.map(\.id))
        let shared = Set(tagCounts(rows: rows).filter { $0.value >= 2 }.keys)
        var links: [MemoryGraphLink] = []
        for row in rows {
            for tag in tags(of: row) where shared.contains(tag) {
                links.append(MemoryGraphLink(a: .memory(row.id), b: .tag(tag), kind: .tag))
            }
        }
        for edge in edges where present.contains(edge.source) && present.contains(edge.target) {
            links.append(
                MemoryGraphLink(
                    a: .memory(edge.source),
                    b: .memory(edge.target),
                    kind: .semantic(score: edge.score)
                )
            )
        }
        for link in manual.sorted() where present.contains(link.a) && present.contains(link.b) {
            links.append(MemoryGraphLink(a: .memory(link.a), b: .memory(link.b), kind: .manual))
        }
        return links
    }

    /// Ce qui s'affiche : filtres projet et étiquette et recherche s'appliquent
    /// ENSEMBLE (intersection, S-6/S-7), puis les nœuds-étiquettes sont recalculés
    /// sur les souvenirs VISIBLES — une étiquette qui ne relie plus deux souvenirs
    /// affichés perd son nœud, et un lien dont une extrémité disparaît n'est pas
    /// dessiné (sans être supprimé de sa source).
    public static func visibility(
        rows: [MemoryRow],
        links: [MemoryGraphLink],
        project: String?,
        tag: String?,
        searchIds: Set<String>?
    ) -> (nodes: [MemoryGraphNode], links: [MemoryGraphLink]) {
        let visibleRows = rows.filter { row in
            if let project, scope(of: row) != project { return false }
            if let tag, !tags(of: row).contains(tag) { return false }
            if let searchIds, !searchIds.contains(row.id) { return false }
            return true
        }
        let nodes = visibleRows.map(memoryNode) + tagNodes(rows: visibleRows, only: tag)
        let visible = Set(nodes.map(\.id))
        let visibleLinks = links.filter { visible.contains($0.a) && visible.contains($0.b) }
        return (nodes, visibleLinks)
    }

    /// La famille d'une étiquette sur un graphe DÉJÀ dérivé : les nœuds-souvenirs qui
    /// portent l'étiquette, le nœud-étiquette `.tag(nom)`, et les liens dont les DEUX
    /// extrémités survivent. L'app iOS n'a que le graphe du fil ; c'est la règle de
    /// `visibility(project: nil, tag: nom, searchIds: nil)`, et l'égalité est prouvée
    /// en test sur la fixture.
    public static func tagFamily(
        nodes: [MemoryGraphNode],
        links: [MemoryGraphLink],
        tag: String
    ) -> (nodes: [MemoryGraphNode], links: [MemoryGraphLink]) {
        guard nodes.contains(where: { $0.id == .tag(tag) }) else { return (nodes, links) }
        let kept = nodes.filter { node in
            switch node.id {
            case .memory:
                return node.tags.contains(tag)
            case let .tag(name):
                return name == tag
            }
        }
        let visible = Set(kept.map(\.id))
        let visibleLinks = links.filter { visible.contains($0.a) && visible.contains($0.b) }
        return (kept, visibleLinks)
    }

    // MARK: - Détails

    /// La portée d'une ligne : `agent_id`, ou la chaîne vide pour « Sans projet »
    /// (une ligne sans portée reste un nœud, jamais une ligne perdue).
    public static func scope(of row: MemoryRow) -> String {
        row.agentId ?? ""
    }

    /// Les étiquettes d'une ligne : segments vides écartés, doublons retirés
    /// (l'ordre d'apparition est conservé), comparaison à l'identique — la casse
    /// comprise.
    public static func tags(of row: MemoryRow) -> [String] {
        var seen: Set<String> = []
        var kept: [String] = []
        for tag in row.tags where !tag.trimmingCharacters(in: .whitespaces).isEmpty {
            if seen.insert(tag).inserted { kept.append(tag) }
        }
        return kept
    }

    private static func memoryNode(_ row: MemoryRow) -> MemoryGraphNode {
        MemoryGraphNode(
            id: .memory(row.id),
            label: MemoryText.title(row.text),
            scope: row.agentId,
            text: row.text,
            tags: tags(of: row)
        )
    }

    /// Le nombre de souvenirs qui portent chaque étiquette (chaque ligne compte une
    /// fois par étiquette, doublons dédoublonnés).
    private static func tagCounts(rows: [MemoryRow]) -> [String: Int] {
        var counts: [String: Int] = [:]
        for row in rows {
            for name in tags(of: row) { counts[name, default: 0] += 1 }
        }
        return counts
    }

    /// Les nœuds-étiquettes : les étiquettes portées par ≥ 2 souvenirs des lignes
    /// données (`only` restreint au filtre d'étiquette actif — il est alors le SEUL
    /// nœud-étiquette affiché).
    private static func tagNodes(rows: [MemoryRow], only tag: String?) -> [MemoryGraphNode] {
        tagCounts(rows: rows)
            .filter { $0.value >= 2 && (tag == nil || $0.key == tag) }
            .keys
            .sorted()
            .map { MemoryGraphNode(id: .tag($0), label: MemoryText.tagLabel($0), scope: nil) }
    }
}
