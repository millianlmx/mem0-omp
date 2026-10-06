// La dérivation PURE du graphe (S-4, S-6) et sa géométrie (S-5) : nœuds, liens,
// visibilité, placement et cible du clic — confrontés sans rendre une vue, sans
// réseau et sans service.

import CoreGraphics
import Foundation
import Testing

@testable import OMPConsole
import ConsoleCore

/// Les identifiants des nœuds, dans l'ordre affiché : un souvenir par son id, une
/// étiquette par `#nom` — la comparaison reste lisible sans littéraux d'énumération.
private func nodeIDs(_ nodes: [MemoryGraphNode]) -> [String] {
    nodes.map { node in
        switch node.id {
        case let .memory(id): id
        case let .tag(name): "#\(name)"
        }
    }
}

/// Les seuls nœuds de souvenirs.
private func memoryIDs(_ nodes: [MemoryGraphNode]) -> [String] {
    nodes.compactMap { $0.id.memoryId }
}

// MARK: - Nœuds (AC-1, AC-7)

@Test("graph-based-memeries-view/AC-1 : chaque souvenir est un nœud, et il porte son projet")
func ac1EveryRowIsANodeCarryingItsProject() {
    let rows = [
        memoryRow(id: "m-1", text: "un", scope: "projet-a"),
        memoryRow(id: "m-2", text: "deux", scope: "projet-b"),
        memoryRow(id: "m-3", text: "trois"),
    ]

    let nodes = MemoryGraph.nodes(rows: rows)

    #expect(nodeIDs(nodes) == ["m-1", "m-2", "m-3"])
    #expect(nodes.map(\.scope) == ["projet-a", "projet-b", nil])
    // Le libellé d'un nœud est le TITRE court du souvenir (même formule que la liste).
    #expect(nodes[0].label == MemoryText.title("un"))
    // Une ligne sans portée reste un nœud : elle n'est jamais perdue.
    #expect(MemoryGraph.scope(of: rows[2]) == "")
}

@Test("graph-based-memeries-view/AC-7 : deux souvenirs qui partagent une étiquette sont reliés par un nœud-étiquette")
func ac7SharedTagBecomesATagNode() {
    let rows = [
        memoryRow(id: "m-1", text: "un", tags: ["t", "seul"]),
        memoryRow(id: "m-2", text: "deux", tags: ["t"]),
        memoryRow(id: "m-3", text: "trois", tags: ["t", "t"]),
    ]

    let nodes = MemoryGraph.nodes(rows: rows)
    let links = MemoryGraph.links(rows: rows, edges: [], manual: [])

    // « t » est portée par trois souvenirs ⇒ un nœud-étiquette, et trois liens.
    #expect(nodeIDs(nodes).contains("#t"))
    #expect(nodes.first { $0.id == .tag("t") }?.label == "#t")
    #expect(links.filter { $0.kind == .tag }.count == 3)
    #expect(links.filter { $0.kind == .tag }.map(\.b) == [.tag("t"), .tag("t"), .tag("t")])
    // « seul » n'est portée que par un souvenir : aucun nœud-étiquette.
    #expect(!nodeIDs(nodes).contains("#seul"))
    // Aucune arête DIRECTE souvenir ↔ souvenir n'est créée par les étiquettes.
    #expect(links.allSatisfy { $0.a.memoryId == nil || $0.b.memoryId == nil })
}

@Test("graph-based-memeries-view/AC-7 : un seul porteur n'a aucun nœud-étiquette, et une étiquette blanche est ignorée")
func ac7SingleCarrierAndBlankTagsAreIgnored() {
    let rows = [
        memoryRow(id: "m-1", text: "un", tags: ["unique", "  ", ""]),
        memoryRow(id: "m-2", text: "deux", tags: ["  "]),
    ]

    let nodes = MemoryGraph.nodes(rows: rows)

    #expect(nodeIDs(nodes) == ["m-1", "m-2"])
    #expect(MemoryGraph.links(rows: rows, edges: [], manual: []).isEmpty)
}

@Test("graph-based-memeries-view/AC-7 : les étiquettes se comparent à l'identique, casse comprise")
func ac7TagsCompareExactly() {
    let rows = [
        memoryRow(id: "m-1", text: "un", tags: ["Tag"]),
        memoryRow(id: "m-2", text: "deux", tags: ["tag"]),
    ]

    let nodes = MemoryGraph.nodes(rows: rows)

    #expect(!nodeIDs(nodes).contains("#Tag"))
    #expect(!nodeIDs(nodes).contains("#tag"))
}

// MARK: - Liens sémantiques (AC-8)

@Test("graph-based-memeries-view/AC-8 : une arête du service relie deux souvenirs ; sans étiquette ni arête, aucun lien direct")
func ac8SemanticEdgeIsTheOnlyDirectLink() {
    let rows = [
        memoryRow(id: "m-1", text: "un"),
        memoryRow(id: "m-2", text: "deux"),
        memoryRow(id: "m-3", text: "trois"),
    ]
    let edges = [MemoryGraphEdge(source: "m-1", target: "m-2", score: 0.81)]

    let links = MemoryGraph.links(rows: rows, edges: edges, manual: [])

    #expect(links == [MemoryGraphLink(a: .memory("m-1"), b: .memory("m-2"), kind: .semantic(score: 0.81))])
    // m-3 n'a ni étiquette commune ni proximité : aucune arête directe.
    #expect(!links.contains { $0.a == .memory("m-3") || $0.b == .memory("m-3") })
}

@Test("graph-based-memeries-view/AC-8 : une arête dont une extrémité n'est pas chargée est ignorée, jamais un nœud fantôme")
func ac8EdgesOutsideTheLoadedRowsAreDropped() {
    let rows = [memoryRow(id: "m-1", text: "un")]
    let edges = [
        MemoryGraphEdge(source: "m-1", target: "absent", score: 0.9),
        MemoryGraphEdge(source: "absent-1", target: "absent-2", score: 0.9),
    ]

    let links = MemoryGraph.links(rows: rows, edges: edges, manual: [])

    #expect(links.isEmpty)
}

// MARK: - Visibilité (AC-16, AC-17)

@Test("graph-based-memeries-view/AC-16 : le filtre projet ne garde que ce projet et ses liens")
func ac16ProjectFilterKeepsItsOwnRows() {
    let rows = [
        memoryRow(id: "m-1", text: "un", scope: "a", tags: ["t"]),
        memoryRow(id: "m-2", text: "deux", scope: "a", tags: ["t"]),
        memoryRow(id: "m-3", text: "trois", scope: "b", tags: ["t"]),
    ]
    let edges = [
        MemoryGraphEdge(source: "m-1", target: "m-2", score: 0.9),
        MemoryGraphEdge(source: "m-1", target: "m-3", score: 0.9),
    ]
    let links = MemoryGraph.links(rows: rows, edges: edges, manual: [])

    let visible = MemoryGraph.visibility(rows: rows, links: links, project: "a", tag: nil, searchIds: nil)

    #expect(nodeIDs(visible.nodes) == ["m-1", "m-2", "#t"])
    // Le lien vers « b » disparaît avec son extrémité ; celui de « a » reste.
    #expect(visible.links.contains { $0.kind == .semantic(score: 0.9) && $0.a == .memory("m-1") && $0.b == .memory("m-2") })
    #expect(!visible.links.contains { $0.a == .memory("m-3") || $0.b == .memory("m-3") })
}

@Test("graph-based-memeries-view/AC-16 : le filtre étiquette ne garde que ses porteurs, et son nœud est le SEUL affiché")
func ac16TagFilterKeepsItsCarriersOnly() {
    let rows = [
        memoryRow(id: "m-1", text: "un", tags: ["t", "u"]),
        memoryRow(id: "m-2", text: "deux", tags: ["t", "u"]),
        memoryRow(id: "m-3", text: "trois", tags: ["u"]),
    ]
    let links = MemoryGraph.links(rows: rows, edges: [], manual: [])

    let visible = MemoryGraph.visibility(rows: rows, links: links, project: nil, tag: "t", searchIds: nil)

    #expect(nodeIDs(visible.nodes) == ["m-1", "m-2", "#t"])
    #expect(visible.links.allSatisfy { $0.kind == .tag && $0.b == .tag("t") })
}

@Test("graph-based-memeries-view/AC-16 : un filtre étiquette porté par un seul souvenir affiché n'a pas de nœud")
func ac16TagNodeNeedsTwoVisibleCarriers() {
    let rows = [
        memoryRow(id: "m-1", text: "un", scope: "a", tags: ["t"]),
        memoryRow(id: "m-2", text: "deux", scope: "b", tags: ["t"]),
    ]
    let links = MemoryGraph.links(rows: rows, edges: [], manual: [])

    let visible = MemoryGraph.visibility(rows: rows, links: links, project: "a", tag: nil, searchIds: nil)

    #expect(nodeIDs(visible.nodes) == ["m-1"])
    #expect(visible.links.isEmpty)
}

@Test("graph-based-memeries-view/AC-16 : projet, étiquette et recherche se COMBINENT (intersection)")
func ac16FiltersAndSearchCombine() {
    let rows = [
        memoryRow(id: "m-1", text: "un", scope: "a", tags: ["t"]),
        memoryRow(id: "m-2", text: "deux", scope: "a", tags: ["t"]),
        memoryRow(id: "m-3", text: "trois", scope: "a", tags: ["t"]),
    ]
    let links = MemoryGraph.links(rows: rows, edges: [], manual: [])

    let visible = MemoryGraph.visibility(rows: rows, links: links, project: "a", tag: "t", searchIds: ["m-2", "m-3"])

    #expect(nodeIDs(visible.nodes) == ["m-2", "m-3", "#t"])
    #expect(visible.links.count == 2)
}

@Test("graph-based-memeries-view/AC-17 : la restriction de recherche garde les souvenirs trouvés et leurs liens, toutes portées")
func ac17SearchRestrictionKeepsFoundRowsAndTheirLinks() {
    let rows = [
        memoryRow(id: "m-1", text: "un", scope: "a"),
        memoryRow(id: "m-2", text: "deux", scope: "b"),
        memoryRow(id: "m-3", text: "trois", scope: "b"),
    ]
    let edges = [MemoryGraphEdge(source: "m-2", target: "m-3", score: 0.9)]
    let links = MemoryGraph.links(rows: rows, edges: edges, manual: [])

    let visible = MemoryGraph.visibility(rows: rows, links: links, project: nil, tag: nil, searchIds: ["m-2", "m-3"])

    #expect(nodeIDs(visible.nodes) == ["m-2", "m-3"])
    #expect(visible.links == [MemoryGraphLink(a: .memory("m-2"), b: .memory("m-3"), kind: .semantic(score: 0.9))])
}

// MARK: - Liens manuels (AC-13, AC-14, AC-15)

@Test("graph-based-memeries-view/AC-13 : un lien manuel est un lien de plein droit, distinct d'un dérivé")
func ac13ManualLinkIsDrawnLikeItsOwnKind() {
    let rows = [memoryRow(id: "m-1", text: "un"), memoryRow(id: "m-2", text: "deux")]
    let manual: Set<MemoryLink> = [MemoryLink(a: "m-1", b: "m-2")]

    let links = MemoryGraph.links(rows: rows, edges: [], manual: manual)

    #expect(links == [MemoryGraphLink(a: .memory("m-1"), b: .memory("m-2"), kind: .manual)])
    #expect(links[0].kind.isManual)
    #expect(!MemoryGraphLinkKind.semantic(score: 0.9).isManual)
}

@Test("graph-based-memeries-view/AC-14 : un lien détaché ne figure plus dans le graphe")
func ac14DetachedLinkDisappears() {
    let rows = [memoryRow(id: "m-1", text: "un"), memoryRow(id: "m-2", text: "deux")]

    #expect(MemoryGraph.links(rows: rows, edges: [], manual: [MemoryLink(a: "m-1", b: "m-2")]).count == 1)
    #expect(MemoryGraph.links(rows: rows, edges: [], manual: []).isEmpty)
}

@Test("graph-based-memeries-view/AC-15 : un lien orphelin n'est jamais dessiné")
func ac15OrphanLinkIsNeverDrawn() {
    let rows = [memoryRow(id: "m-1", text: "un")]
    let manual: Set<MemoryLink> = [MemoryLink(a: "m-1", b: "m-2")]

    #expect(MemoryGraph.links(rows: rows, edges: [], manual: manual).isEmpty)
    let visible = MemoryGraph.visibility(
        rows: rows,
        links: MemoryGraph.links(rows: rows, edges: [], manual: manual),
        project: nil,
        tag: nil,
        searchIds: nil
    )
    #expect(visible.links.isEmpty)
}

// MARK: - Placement (S-5)

@Test("graph-based-memeries-view/AC-3 : le placement est déterministe — deux appels rendent les mêmes positions")
func ac3LayoutIsDeterministic() {
    let rows = (0 ..< 12).map { memoryRow(id: "m-\($0)", text: "souvenir \($0)", scope: "p\($0 % 3)") }
    let nodes = MemoryGraph.nodes(rows: rows)
    let links = MemoryGraph.links(
        rows: rows,
        edges: [MemoryGraphEdge(source: "m-0", target: "m-1", score: 0.9)],
        manual: []
    )

    let first = MemoryGraphLayout.positions(nodes: nodes, links: links, seed: 42, iterations: 20)
    let second = MemoryGraphLayout.positions(nodes: nodes, links: links, seed: 42, iterations: 20)

    #expect(first == second)
    #expect(first.count == nodes.count)
    // Les positions restent dans la zone normalisée.
    #expect(first.values.allSatisfy { $0.x >= 0 && $0.x <= 1 && $0.y >= 0 && $0.y <= 1 })
    // Une autre graine donne un autre placement (le bruit initial compte).
    #expect(MemoryGraphLayout.positions(nodes: nodes, links: links, seed: 7, iterations: 20) != first)
}

@Test("graph-based-memeries-view/AC-1 : les souvenirs d'un même projet forment une grappe plus serrée que les projets entre eux")
func ac1ClustersAreTighterThanProjects() {
    var rows: [MemoryRow] = []
    for index in 0 ..< 20 {
        rows.append(memoryRow(id: "a-\(index)", text: "a \(index)", scope: "projet-a"))
        rows.append(memoryRow(id: "b-\(index)", text: "b \(index)", scope: "projet-b"))
    }
    let nodes = MemoryGraph.nodes(rows: rows)
    let positions = MemoryGraphLayout.positions(nodes: nodes, links: [], seed: 9, iterations: 60)

    func averageDistance(_ ids: [String]) -> Double {
        var total = 0.0
        var pairs = 0
        for left in ids {
            for right in ids where left < right {
                guard let one = positions[.memory(left)], let other = positions[.memory(right)] else { continue }
                total += hypot(Double(one.x - other.x), Double(one.y - other.y))
                pairs += 1
            }
        }
        return pairs == 0 ? 0 : total / Double(pairs)
    }

    let insideA = averageDistance((0 ..< 20).map { "a-\($0)" })
    let insideB = averageDistance((0 ..< 20).map { "b-\($0)" })
    var across = 0.0
    var pairs = 0
    for index in 0 ..< 20 {
        for other in 0 ..< 20 {
            guard let one = positions[.memory("a-\(index)")], let two = positions[.memory("b-\(other)")] else { continue }
            across += hypot(Double(one.x - two.x), Double(one.y - two.y))
            pairs += 1
        }
    }
    across /= Double(max(1, pairs))

    #expect(insideA < across)
    #expect(insideB < across)
}

@Test("graph-based-memeries-view/AC-3 : le placement tient la borne de 3 s pour 2 500 nœuds et 7 500 liens")
func ac3LayoutStaysUnderThreeSeconds() {
    var rows: [MemoryRow] = []
    for index in 0 ..< 2500 {
        rows.append(memoryRow(id: "m-\(index)", text: "souvenir \(index)", scope: "projet-\(index % 17)"))
    }
    let nodes = MemoryGraph.nodes(rows: rows)
    let edges = (0 ..< 7500).map { index in
        MemoryGraphEdge(source: "m-\(index % 2500)", target: "m-\((index * 7 + 3) % 2500)", score: 0.8)
    }
    let links = MemoryGraph.links(rows: rows, edges: edges, manual: [])

    let start = Date()
    let positions = MemoryGraphLayout.positions(nodes: nodes, links: links)
    let elapsed = Date().timeIntervalSince(start)

    #expect(positions.count == nodes.count)
    #expect(elapsed < 3.0, "placement mesuré en \(elapsed) s")
}

// MARK: - Cible du clic (AC-2, AC-3)

@Test("graph-based-memeries-view/AC-2 : un clic sur la position écran d'un nœud le cible")
func ac2HitTestFindsTheNodeUnderThePoint() {
    let size = CGSize(width: 400, height: 300)
    let positions: [MemoryGraphNodeID: CGPoint] = [.memory("m-1"): CGPoint(x: 0.25, y: 0.75)]
    let viewport = MemoryGraphViewport(size: size)
    let screen = viewport.screen(CGPoint(x: 0.25, y: 0.75))

    #expect(
        MemoryGraphHitTest.node(at: screen, positions: positions, zoom: 1, pan: .zero, size: size)
            == .memory("m-1")
    )
    // À plus de rayon + tolérance, le vide ne cible rien.
    let far = CGPoint(x: screen.x + 40, y: screen.y)
    #expect(MemoryGraphHitTest.node(at: far, positions: positions, zoom: 1, pan: .zero, size: size) == nil)
}

@Test("graph-based-memeries-view/AC-3 : après zoom et déplacement, le clic reste exact")
func ac3HitTestSurvivesZoomAndPan() {
    let size = CGSize(width: 400, height: 300)
    let pan = CGSize(width: 37, height: -21)
    let normalized = CGPoint(x: 0.3, y: 0.6)
    let positions: [MemoryGraphNodeID: CGPoint] = [.memory("m-1"): normalized]

    for zoom in [0.5, 1.0, 2.0] as [CGFloat] {
        let screen = MemoryGraphViewport(size: size, zoom: zoom, pan: pan).screen(normalized)
        #expect(
            MemoryGraphHitTest.node(at: screen, positions: positions, zoom: zoom, pan: pan, size: size)
                == .memory("m-1"),
            "zoom \(zoom)"
        )
    }
    // Le clic à la position SANS transformation ne touche plus rien : au zoom 3, le
    // nœud en est trop loin.
    let untransformed = MemoryGraphViewport(size: size).screen(normalized)
    #expect(
        MemoryGraphHitTest.node(at: untransformed, positions: positions, zoom: 3, pan: pan, size: size) == nil
    )
}

@Test("graph-based-memeries-view/AC-3 : à égalité de distance, le clic prend le nœud le plus proche")
func ac3HitTestTakesTheClosest() {
    let size = CGSize(width: 400, height: 300)
    let viewport = MemoryGraphViewport(size: size)
    let target = viewport.screen(CGPoint(x: 0.5, y: 0.5))
    let positions: [MemoryGraphNodeID: CGPoint] = [
        .memory("loin"): CGPoint(x: 0.52, y: 0.5),
        .memory("proche"): CGPoint(x: 0.501, y: 0.5),
    ]

    #expect(
        MemoryGraphHitTest.node(at: target, positions: positions, zoom: 1, pan: .zero, size: size)
            == .memory("proche")
    )
}

// MARK: - Scène (S-5)

@Test("graph-based-memeries-view/AC-1 : la scène dessine les liens d'abord, puis les grappes et les nœuds")
func ac1SceneOrdersLinksClustersThenNodes() {
    let rows = [
        memoryRow(id: "m-1", text: "un", scope: "projet-a", tags: ["t"]),
        memoryRow(id: "m-2", text: "deux", scope: "projet-a", tags: ["t"]),
    ]
    let nodes = MemoryGraph.nodes(rows: rows)
    let links = MemoryGraph.links(rows: rows, edges: [MemoryGraphEdge(source: "m-1", target: "m-2", score: 0.9)], manual: [])
    let positions: [MemoryGraphNodeID: CGPoint] = [
        .memory("m-1"): CGPoint(x: 0.2, y: 0.2),
        .memory("m-2"): CGPoint(x: 0.3, y: 0.3),
        .tag("t"): CGPoint(x: 0.25, y: 0.25),
    ]

    let scene = MemoryGraphScene.build(
        nodes: nodes,
        links: links,
        positions: positions,
        viewport: MemoryGraphViewport(size: CGSize(width: 400, height: 300)),
        selection: nil,
        hovered: nil
    )

    // Ordre de profondeur : les traits d'abord, le nom de grappe ensuite, les nœuds
    // (disque et capsule) après, les libellés en dernier.
    var seenNodes = false
    var seenLabels = false
    for shape in scene.shapes {
        switch shape {
        case .line:
            #expect(!seenNodes, "un lien est dessiné APRÈS un nœud")
        case .disc, .capsule:
            seenNodes = true
            #expect(!seenLabels, "un nœud est dessiné APRÈS un libellé")
        case let .label(_, text, hue):
            if hue == nil { seenLabels = true }
            if hue != nil { #expect(text == "projet-a") }
        }
    }
    #expect(scene.shapes.contains { if case .line = $0 { return true } else { return false } })
    #expect(scene.shapes.contains { if case .capsule = $0 { return true } else { return false } })
    #expect(scene.shapes.contains { if case .disc = $0 { return true } else { return false } })
    // Au zoom 1, aucun libellé de souvenir : seul le nom de grappe est écrit.
    #expect(!scene.shapes.contains { if case let .label(_, _, hue) = $0 { return hue == nil } else { return false } })
}

@Test("graph-based-memeries-view/AC-13 : un lien manuel se dessine comme tel, un dérivé comme le sien")
func ac13SceneKeepsLinkKindsApart() {
    let rows = [memoryRow(id: "m-1", text: "un"), memoryRow(id: "m-2", text: "deux")]
    let links = MemoryGraph.links(
        rows: rows,
        edges: [MemoryGraphEdge(source: "m-1", target: "m-2", score: 0.9)],
        manual: [MemoryLink(a: "m-1", b: "m-2")]
    )
    let positions: [MemoryGraphNodeID: CGPoint] = [
        .memory("m-1"): CGPoint(x: 0.2, y: 0.2),
        .memory("m-2"): CGPoint(x: 0.8, y: 0.8),
    ]

    let scene = MemoryGraphScene.build(
        nodes: MemoryGraph.nodes(rows: rows),
        links: links,
        positions: positions,
        viewport: MemoryGraphViewport(size: CGSize(width: 400, height: 300)),
        selection: nil,
        hovered: nil
    )

    let kinds = scene.shapes.compactMap { shape -> MemoryGraphLinkKind? in
        if case let .line(_, _, kind, _) = shape { return kind }
        return nil
    }
    #expect(kinds.contains(.manual))
    #expect(kinds.contains(.semantic(score: 0.9)))
}

@Test("graph-based-memeries-view/AC-3 : les libellés de souvenirs n'apparaissent qu'au zoom ≥ 1,5, au survol ou à la sélection")
func ac3SceneShowsLabelsOnlyWhenReadable() {
    let rows = [memoryRow(id: "m-1", text: "un souvenir lisible", scope: "p")]
    let nodes = MemoryGraph.nodes(rows: rows)
    let positions: [MemoryGraphNodeID: CGPoint] = [.memory("m-1"): CGPoint(x: 0.5, y: 0.5)]

    func labels(zoom: CGFloat, selection: String? = nil, hovered: MemoryGraphNodeID? = nil) -> [String] {
        MemoryGraphScene.build(
            nodes: nodes,
            links: [],
            positions: positions,
            viewport: MemoryGraphViewport(size: CGSize(width: 400, height: 300), zoom: zoom),
            selection: selection,
            hovered: hovered
        ).shapes.compactMap { shape in
            if case let .label(_, text, hue) = shape, hue == nil { return text }
            return nil
        }
    }

    #expect(labels(zoom: 1).isEmpty)
    #expect(labels(zoom: MemoryGraphStyle.labelZoom) == [MemoryText.title("un souvenir lisible")])
    #expect(labels(zoom: 1, selection: "m-1") == [MemoryText.title("un souvenir lisible")])
    #expect(labels(zoom: 1, hovered: .memory("m-1")) == [MemoryText.title("un souvenir lisible")])
}

@Test("graph-based-memeries-view/AC-3 : la sélection et le survol marquent le nœud et ses liens")
func ac3SceneMarksSelectionAndHover() {
    let rows = [memoryRow(id: "m-1", text: "un"), memoryRow(id: "m-2", text: "deux")]
    let nodes = MemoryGraph.nodes(rows: rows)
    let links = MemoryGraph.links(rows: rows, edges: [MemoryGraphEdge(source: "m-1", target: "m-2", score: 0.9)], manual: [])
    let positions: [MemoryGraphNodeID: CGPoint] = [
        .memory("m-1"): CGPoint(x: 0.2, y: 0.2),
        .memory("m-2"): CGPoint(x: 0.8, y: 0.8),
    ]

    let scene = MemoryGraphScene.build(
        nodes: nodes,
        links: links,
        positions: positions,
        viewport: MemoryGraphViewport(size: CGSize(width: 400, height: 300)),
        selection: "m-1",
        hovered: .memory("m-2")
    )

    let discs = scene.shapes.compactMap { shape -> (Bool, Bool)? in
        if case let .disc(_, _, _, selected, hovered) = shape { return (selected, hovered) }
        return nil
    }
    #expect(discs.contains { $0.0 && !$0.1 })
    #expect(discs.contains { !$0.0 && $0.1 })
    // Le lien touche les deux : il est mis en évidence.
    #expect(scene.shapes.contains { if case let .line(_, _, _, highlighted) = $0 { return highlighted } else { return false } })
}

@Test("graph-based-memeries-view/AC-3 : la scène suit le zoom et le déplacement de la vue")
func ac3SceneFollowsZoomAndPan() {
    let rows = [memoryRow(id: "m-1", text: "un")]
    let nodes = MemoryGraph.nodes(rows: rows)
    let positions: [MemoryGraphNodeID: CGPoint] = [.memory("m-1"): CGPoint(x: 0.5, y: 0.5)]

    let plain = MemoryGraphScene.build(
        nodes: nodes, links: [], positions: positions,
        viewport: MemoryGraphViewport(size: CGSize(width: 400, height: 300)),
        selection: nil, hovered: nil
    )
    let moved = MemoryGraphScene.build(
        nodes: nodes, links: [], positions: positions,
        viewport: MemoryGraphViewport(size: CGSize(width: 400, height: 300), zoom: 2, pan: CGSize(width: 40, height: -10)),
        selection: nil, hovered: nil
    )

    func discCenter(_ scene: MemoryGraphScene) -> CGPoint? {
        for shape in scene.shapes {
            if case let .disc(center, _, _, _, _) = shape { return center }
        }
        return nil
    }

    let one = try! #require(discCenter(plain))
    let two = try! #require(discCenter(moved))
    #expect(one == CGPoint(x: 200, y: 150))
    #expect(two == CGPoint(x: 240, y: 140))
    // Le rayon suit le zoom.
    #expect(moved.shapes.contains { if case let .disc(_, radius, _, _, _) = $0 { return radius == MemoryGraphStyle.nodeRadius * 2 } else { return false } })
}

@Test("graph-based-memeries-view/AC-3 : le zoom centré garde le point du geste sous le geste, et les bornes sont respectées")
func ac3ViewportKeepsTheAnchorAndClampsTheZoom() {
    let size = CGSize(width: 400, height: 300)
    let anchor = CGPoint(x: 120, y: 90)
    let viewport = MemoryGraphViewport(size: size, zoom: 1, pan: .zero)

    let newPan = viewport.pan(keeping: anchor, zoom: 2)
    let zoomed = MemoryGraphViewport(size: size, zoom: 2, pan: newPan)

    // La position normalisée qui était SOUS l'ancre avant le geste y est encore.
    let anchored = CGPoint(
        x: (anchor.x - size.width / 2) / viewport.side + 0.5,
        y: (anchor.y - size.height / 2) / viewport.side + 0.5
    )
    #expect(abs(viewport.screen(anchored).x - anchor.x) < 0.001)
    let afterAnchor = zoomed.screen(anchored)
    #expect(abs(afterAnchor.x - anchor.x) < 0.001)
    #expect(abs(afterAnchor.y - anchor.y) < 0.001)

    // Un nœud éloigné de l'ancre, lui, s'écarte du centre.
    let far = CGPoint(x: 0.9, y: 0.9)
    #expect(hypot(zoomed.screen(far).x - size.width / 2, zoomed.screen(far).y - size.height / 2)
        > hypot(viewport.screen(far).x - size.width / 2, viewport.screen(far).y - size.height / 2))

    #expect(MemoryGraphStyle.minZoom == 0.25)
    #expect(MemoryGraphStyle.maxZoom == 3.0)
}

@Test("graph-based-memeries-view/AC-1 : la teinte d'un projet est déterministe, sans hashValue")
func ac1ScopeHueIsDeterministic() {
    #expect(MemoryGraphStyle.hue(for: "projet-a") == MemoryGraphStyle.hue(for: "projet-a"))
    #expect(MemoryGraphStyle.hue(for: "projet-a") != MemoryGraphStyle.hue(for: "projet-b"))
    #expect(MemoryGraphStyle.hue(for: nil) == MemoryGraphStyle.hue(for: nil))
    #expect((0 ... 1).contains(MemoryGraphStyle.hue(for: "projet-a")))
}
