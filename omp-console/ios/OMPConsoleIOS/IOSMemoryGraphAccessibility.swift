// Le graphe de la Mémoire parcouru par VoiceOver (ios-statistiques-et-graphe-accessibles,
// S-5). Le `Canvas` ne dessine que des pixels : sans aide, VoiceOver n'y voit qu'un
// seul élément. Cette fonction PURE dit quels éléments synthétiques la vue doit
// poser par-dessus (`accessibilityChildren`) : un par nœud que le graphe affiche
// réellement — visible par le filtre ET dans le cadre au zoom courant —, plus le
// retour à la vue entière quand un filtre est posé.
//
// Les éléments ne sont jamais dessinés ; ils se recalculent à chaque rendu, donc
// suivent le zoom, le déplacement, le filtre et la sélection. Leur activation passe
// par `IOSMemoryGraphModel.activate(_:)`, la voie du toucher.

import ConsoleCore
import CoreGraphics

/// Un élément VoiceOver du canevas du graphe.
struct IOSMemoryGraphElement: Equatable, Identifiable {
    enum Target: Equatable {
        case showAll
        case memory(String)
        case tag(String)
    }

    /// L'identifiant d'accessibilité.
    let id: String
    let target: Target
    let label: String
    let hint: String
    /// Les titres des extrémités liées, sans doublon, dans l'ordre de `links(of:)` ;
    /// vide hors `.memory`.
    let linked: [String]
    /// Le cadre de focus, dans le repère du canevas.
    let frame: CGRect
    let isSelected: Bool
}

extension IOSMemoryGraphModel {
    /// Les éléments VoiceOver du canevas de taille `size` : `[]` hors graphe ; sinon
    /// « Toutes les étiquettes » en tête si un filtre est posé, puis un élément par
    /// nœud affiché, dans l'ordre de lecture (haut en bas, puis gauche à droite).
    func accessibilityElements(size: CGSize) -> [IOSMemoryGraphElement] {
        guard case .graph = state else { return [] }
        let shown = visible
        let viewport = MemoryGraphViewport(size: size, zoom: zoom, pan: pan)
        let labels = nodeLabels

        var placed: [(node: MemoryGraphNode, point: CGPoint)] = []
        for node in shown.nodes {
            guard let position = positions[node.id] else { continue }
            let point = viewport.screen(position)
            // Bords compris : un nœud posé sur le bord du canevas est affiché.
            guard point.x >= 0, point.y >= 0, point.x <= size.width, point.y <= size.height else { continue }
            placed.append((node, point))
        }

        var elements: [IOSMemoryGraphElement] = []
        if tagFilter != nil {
            elements.append(IOSMemoryGraphElement(
                id: IOSMemoryAccessibility.graphShowAll,
                target: .showAll,
                label: MemoryText.allTags,
                hint: IOSMemoryText.graphShowAllHint,
                linked: [],
                frame: CGRect(origin: .zero, size: size),
                isSelected: false
            ))
        }

        var nodes: [IOSMemoryGraphElement] = []
        for (node, point) in placed {
            let side = IOSMetrics.minimumTarget
            let frame = CGRect(x: point.x - side / 2, y: point.y - side / 2, width: side, height: side)
            switch node.id {
            case let .memory(id):
                let incident = links(of: id)
                var linked: [String] = []
                for link in incident {
                    let other = link.a.memoryId == id ? link.b : link.a
                    let name: String
                    switch other {
                    case let .tag(tag): name = MemoryText.tagLabel(tag)
                    case .memory: name = Self.title(labels[other] ?? "")
                    }
                    if !linked.contains(name) { linked.append(name) }
                }
                nodes.append(IOSMemoryGraphElement(
                    id: IOSMemoryAccessibility.graphMemory(id),
                    target: .memory(id),
                    label: IOSMemoryText.graphMemoryLabel(title: Self.title(node.label), links: incident.count),
                    hint: IOSMemoryText.graphMemoryHint,
                    linked: linked,
                    frame: frame,
                    isSelected: selection == id
                ))
            case let .tag(name):
                var members = Set<String>()
                for link in shown.links where link.kind == .tag {
                    if link.a == node.id, let id = link.b.memoryId { members.insert(id) }
                    if link.b == node.id, let id = link.a.memoryId { members.insert(id) }
                }
                nodes.append(IOSMemoryGraphElement(
                    id: IOSMemoryAccessibility.graphTagOption(name),
                    target: .tag(name),
                    label: IOSMemoryText.graphTagLabel(tag: name, memories: members.count),
                    hint: IOSMemoryText.graphTagHint,
                    linked: [],
                    frame: frame,
                    isSelected: tagFilter == name
                ))
            }
        }
        // L'ordre de lecture : ligne arrondie au point, puis abscisse, puis id (stable).
        nodes.sort { lhs, rhs in
            let ly = lhs.frame.midY.rounded(), ry = rhs.frame.midY.rounded()
            if ly != ry { return ly < ry }
            if lhs.frame.midX != rhs.frame.midX { return lhs.frame.midX < rhs.frame.midX }
            return lhs.id < rhs.id
        }
        return elements + nodes
    }

    /// Le titre d'un souvenir, ou « Souvenir sans titre » quand son texte est vide.
    private static func title(_ label: String) -> String {
        label.isEmpty ? IOSMemoryText.untitledMemory : label
    }
}
