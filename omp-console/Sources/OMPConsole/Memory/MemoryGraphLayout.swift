// Le placement et la géométrie du graphe (S-5) : Fruchterman-Reingold local,
// déterministe, et la transformation qui relie une position normalisée à l'écran.
//
// Aucune dépendance externe (Package.swift n'en a aucune) et aucun état : le
// placement est une FONCTION PURE de ses entrées, donc deux appels rendent les
// mêmes positions — c'est la graine fixe et le nombre d'itérations fixe qui
// l'imposent, pas l'article (Fruchterman & Reingold 1991).

import CoreGraphics
import Foundation

// MARK: - Style

/// Les constantes de dessin et la palette, déterministes.
enum MemoryGraphStyle {
    /// Le rayon d'un nœud de souvenir, en points d'affichage.
    static let nodeRadius: CGFloat = 5
    /// La tolérance du clic autour d'un nœud, en points.
    static let hitSlack: CGFloat = 4
    /// La marge autour du graphe quand il est recadré (10 %).
    static let margin: CGFloat = 0.10
    /// Les bornes du zoom : au-delà, le geste est ignoré.
    static let minZoom: CGFloat = 0.25
    static let maxZoom: CGFloat = 3.0
    /// Le zoom à partir duquel les libellés des souvenirs sont dessinés.
    static let labelZoom: CGFloat = 1.5

    /// La teinte d'une portée : FNV-1a sur son nom, JAMAIS `hashValue` (qui change
    /// d'un lancement à l'autre). Une portée vide garde une teinte stable.
    static func hue(for scope: String?) -> Double {
        let name = scope ?? ""
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in name.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return Double(hash % 360) / 360
    }
}

// MARK: - Géométrie écran

/// La transformation position normalisée → point écran, partagée par le dessin et
/// par le test de clic : une seule formule, donc le clic ne peut pas dériver du
/// dessin.
struct MemoryGraphViewport: Equatable, Sendable {
    var size: CGSize
    var zoom: CGFloat = 1
    var pan: CGSize = .zero

    /// Le côté du carré utile : le graphe tient dans la plus petite dimension,
    /// avec `margin` de chaque côté.
    var side: CGFloat { min(size.width, size.height) * (1 - 2 * MemoryGraphStyle.margin) }

    var center: CGPoint { CGPoint(x: size.width / 2, y: size.height / 2) }

    /// Le point écran d'une position normalisée (`[0,1]²`).
    func screen(_ normalized: CGPoint) -> CGPoint {
        let base = CGPoint(
            x: center.x + (normalized.x - 0.5) * side,
            y: center.y + (normalized.y - 0.5) * side
        )
        return CGPoint(
            x: center.x + (base.x - center.x) * zoom + pan.width,
            y: center.y + (base.y - center.y) * zoom + pan.height
        )
    }

    /// Le déplacement à poser pour que le point écran `anchor` reste SOUS le geste
    /// quand le zoom passe de la valeur courante à `newZoom` (zoom centré).
    func pan(keeping anchor: CGPoint, zoom newZoom: CGFloat) -> CGSize {
        guard zoom > 0 else { return pan }
        let ratio = 1 - newZoom / zoom
        return CGSize(
            width: pan.width + (anchor.x - center.x - pan.width) * ratio,
            height: pan.height + (anchor.y - center.y - pan.height) * ratio
        )
    }
}

/// La cible d'un clic : le nœud dont la position écran est à ≤ rayon d'affichage
/// + tolérance du clic ; à égalité de distance, le plus proche.
enum MemoryGraphHitTest {
    static func node(
        at point: CGPoint,
        positions: [MemoryGraphNodeID: CGPoint],
        zoom: CGFloat,
        pan: CGSize,
        size: CGSize,
        radius: CGFloat = MemoryGraphStyle.nodeRadius
    ) -> MemoryGraphNodeID? {
        let viewport = MemoryGraphViewport(size: size, zoom: zoom, pan: pan)
        let limit = radius * zoom + MemoryGraphStyle.hitSlack
        var best: (id: MemoryGraphNodeID, distance: CGFloat)?
        for (id, normalized) in positions {
            let screen = viewport.screen(normalized)
            let distance = hypot(screen.x - point.x, screen.y - point.y)
            guard distance <= limit else { continue }
            if let current = best, current.distance <= distance { continue }
            best = (id, distance)
        }
        return best?.id
    }
}

// MARK: - Scène (S-5)

/// Un élément à dessiner. La SCÈNE est pure : elle se confronte en test sans rendre
/// de vue, et le canevas ne fait que la peindre — une seule source de vérité pour ce
/// qui s'affiche.
enum MemoryGraphShape: Equatable, Sendable {
    /// Un lien entre deux points écran. `kind` décide du trait (un lien manuel est
    /// discontinu et accentué, jamais confondu avec un dérivé).
    case line(from: CGPoint, to: CGPoint, kind: MemoryGraphLinkKind, highlighted: Bool)
    /// Un nœud de souvenir : disque teinté par projet, anneau de sélection et de
    /// survol.
    case disc(center: CGPoint, radius: CGFloat, hue: Double, selected: Bool, hovered: Bool)
    /// Un nœud-étiquette : capsule portant `#étiquette`.
    case capsule(center: CGPoint, size: CGSize, label: String)
    /// Le nom d'une grappe, ou le libellé d'un souvenir. `hue` non nul ⇒ nom de
    /// grappe (teinté par son projet).
    case label(center: CGPoint, text: String, hue: Double?)
}

struct MemoryGraphScene: Equatable, Sendable {
    /// Les formes, DANS L'ORDRE DE DESSIN : liens, noms de grappes, nœuds, libellés.
    var shapes: [MemoryGraphShape]

    /// La scène d'un graphe affiché : positions normalisées → points écran, puis
    /// profondeur (liens d'abord, libellés en dernier).
    ///
    /// Les libellés des souvenirs ne sont dessinés qu'au zoom ≥ 1,5, ou pour le
    /// nœud survolé et la sélection — jamais un texte illisible.
    static func build(
        nodes: [MemoryGraphNode],
        links: [MemoryGraphLink],
        positions: [MemoryGraphNodeID: CGPoint],
        viewport: MemoryGraphViewport,
        selection: String?,
        hovered: MemoryGraphNodeID?
    ) -> MemoryGraphScene {
        var shapes: [MemoryGraphShape] = []

        for link in links {
            guard let from = positions[link.a], let to = positions[link.b] else { continue }
            let highlighted = isHighlighted(link, selection: selection, hovered: hovered)
            shapes.append(.line(from: viewport.screen(from), to: viewport.screen(to), kind: link.kind, highlighted: highlighted))
        }

        // Les noms de grappes, au barycentre des souvenirs VISIBLES de chaque projet.
        var clusters: [String: (x: CGFloat, y: CGFloat, count: Int)] = [:]
        for node in nodes {
            guard let scope = node.scope, let position = positions[node.id] else { continue }
            var entry = clusters[scope] ?? (0, 0, 0)
            entry.x += position.x
            entry.y += position.y
            entry.count += 1
            clusters[scope] = entry
        }
        for (scope, entry) in clusters.sorted(by: { $0.key < $1.key }) where entry.count > 0 {
            let center = viewport.screen(CGPoint(x: entry.x / CGFloat(entry.count), y: entry.y / CGFloat(entry.count)))
            shapes.append(.label(center: center, text: MemoryText.scopeLabel(scope), hue: MemoryGraphStyle.hue(for: scope)))
        }

        let radius = MemoryGraphStyle.nodeRadius * viewport.zoom
        for node in nodes {
            guard let position = positions[node.id] else { continue }
            let point = viewport.screen(position)
            switch node.id {
            case .memory:
                shapes.append(
                    .disc(
                        center: point,
                        radius: radius,
                        hue: MemoryGraphStyle.hue(for: node.scope),
                        selected: selection == node.id.memoryId,
                        hovered: hovered == node.id
                    )
                )
            case .tag:
                // La capsule est dimensionnée sur son texte, à la même échelle que le
                // reste : une formule, donc déterministe.
                let size = CGSize(width: CGFloat(node.label.count) * 6.5 + 12, height: 14 * max(1, viewport.zoom))
                shapes.append(.capsule(center: point, size: size, label: node.label))
            }
        }

        for node in nodes {
            guard let memory = node.id.memoryId, let position = positions[node.id], !node.label.isEmpty else { continue }
            let shown = viewport.zoom >= MemoryGraphStyle.labelZoom || hovered == node.id || selection == memory
            guard shown else { continue }
            let point = viewport.screen(position)
            shapes.append(
                .label(
                    center: CGPoint(x: point.x, y: point.y - radius - 8),
                    text: node.label,
                    hue: nil
                )
            )
        }

        return MemoryGraphScene(shapes: shapes)
    }

    /// Un lien est mis en évidence quand il touche le nœud survolé ou le souvenir
    /// sélectionné.
    static func isHighlighted(_ link: MemoryGraphLink, selection: String?, hovered: MemoryGraphNodeID?) -> Bool {
        if let hovered, hovered == link.a || hovered == link.b { return true }
        if let selection, link.a.memoryId == selection || link.b.memoryId == selection { return true }
        return false
    }
}


enum MemoryGraphLayout {
    /// La graine fixe du bruit initial : même graphe ⇒ mêmes positions.
    static let defaultSeed: UInt64 = 0x5EED_0F6B_1E5A_17C3
    /// Le nombre d'itérations par défaut.
    static let defaultIterations = 200

    /// Les positions NORMALISÉES (`[0,1]²`) de chaque nœud, dans l'ORDRE des nœuds.
    ///
    /// C'est la forme que traverse une frontière d'isolation : un tableau de points
    /// (POD) ne fait hasher aucune `String`, là où un dictionnaire clé par
    /// `MemoryGraphNodeID` le ferait — un piège MESURÉ de ce dépôt en release
    /// (`swift test -c release` corrompt parfois une valeur qui porte des `String`).
    static func points(
        nodes: [MemoryGraphNode],
        links: [MemoryGraphLink],
        seed: UInt64 = defaultSeed,
        iterations: Int = defaultIterations
    ) -> [CGPoint] {
        layout(nodes: nodes, links: links, seed: seed, iterations: iterations)
    }

    /// Les positions NORMALISÉES (`[0,1]²`) de chaque nœud, par identité.
    ///
    /// Les souvenirs d'un même projet démarrent groupés autour d'un centre de
    /// grappe (les projets sont posés sur un cercle, dans l'ordre alphabétique),
    /// les nœuds-étiquettes au barycentre de leurs souvenirs ; puis l'algorithme
    /// de Fruchterman & Reingold (répulsion entre tous, ressorts sur les liens,
    /// refroidissement) sépare les grappes. Le résultat est recadré dans `[0,1]²`.
    static func positions(
        nodes: [MemoryGraphNode],
        links: [MemoryGraphLink],
        seed: UInt64 = defaultSeed,
        iterations: Int = defaultIterations
    ) -> [MemoryGraphNodeID: CGPoint] {
        let points = layout(nodes: nodes, links: links, seed: seed, iterations: iterations)
        var result: [MemoryGraphNodeID: CGPoint] = [:]
        for (index, node) in nodes.enumerated() where index < points.count {
            result[node.id] = points[index]
        }
        return result
    }

    private static func layout(
        nodes: [MemoryGraphNode],
        links: [MemoryGraphLink],
        seed: UInt64,
        iterations: Int
    ) -> [CGPoint] {
        guard !nodes.isEmpty else { return [] }
        let count = nodes.count
        var index: [MemoryGraphNodeID: Int] = [:]
        for (position, node) in nodes.enumerated() { index[node.id] = position }

        var random = SplitMix64(seed: seed)
        var xs = [Double](repeating: 0, count: count)
        var ys = [Double](repeating: 0, count: count)

        // 1. Les grappes : un centre par portée, sur un cercle.
        let scopes = Array(Set(nodes.compactMap(\.scope))).sorted()
        var centers: [String: (Double, Double)] = [:]
        for (position, scope) in scopes.enumerated() {
            let angle = 2 * Double.pi * Double(position) / Double(max(1, scopes.count))
            centers[scope] = (0.5 + 0.32 * cos(angle), 0.5 + 0.32 * sin(angle))
        }
        for (position, node) in nodes.enumerated() {
            switch node.id {
            case let .memory(_):
                let center = centers[node.scope ?? ""] ?? (0.5, 0.5)
                xs[position] = center.0 + (random.nextUnit() - 0.5) * 0.08
                ys[position] = center.1 + (random.nextUnit() - 0.5) * 0.08
            case .tag:
                xs[position] = 0.5 + (random.nextUnit() - 0.5) * 0.08
                ys[position] = 0.5 + (random.nextUnit() - 0.5) * 0.08
            }
        }
        // Les nœuds-étiquettes démarrent au barycentre de leurs souvenirs.
        for (position, node) in nodes.enumerated() {
            guard case let .tag(name) = node.id else { continue }
            var sumX = 0.0
            var sumY = 0.0
            var attached = 0
            for link in links where link.kind == .tag {
                let other: MemoryGraphNodeID? = link.a == .tag(name) ? link.b : (link.b == .tag(name) ? link.a : nil)
                guard let other, let neighbor = index[other] else { continue }
                sumX += xs[neighbor]
                sumY += ys[neighbor]
                attached += 1
            }
            guard attached > 0 else { continue }
            xs[position] = sumX / Double(attached)
            ys[position] = sumY / Double(attached)
        }

        // 2. Les ressorts, sur les liens dont les DEUX extrémités existent.
        let springs: [(Int, Int)] = links.compactMap { link in
            guard let a = index[link.a], let b = index[link.b], a != b else { return nil }
            return (a, b)
        }

        let area = 1.0
        let k = (area / Double(count)).squareRoot()
        // Le travail par itération croît avec le carré du nombre de nœuds (la
        // répulsion) et avec le nombre de liens (les ressorts) : au-delà de quelques
        // centaines de nœuds, le nombre d'itérations est borné pour tenir la borne de
        // 3 s de S-5 (mesure : 2 500 nœuds / 7 500 liens restent sous la seconde).
        let effective = min(max(1, iterations), max(30, 150_000 / max(1, count)))
        var temperature = 0.1
        var dx = [Double](repeating: 0, count: count)
        var dy = [Double](repeating: 0, count: count)

        // La répulsion est exacte dans un rayon de 2k (grille de cellules de 2k) et
        // négligée au-delà : c'est ce qui la rend linéaire en pratique, et c'est un
        // choix de coût, jamais de hasard — la même entrée rend les mêmes positions.
        let cell = 2 * k
        let reach = 2 * k

        for step in 0 ..< effective {
            for position in 0 ..< count {
                dx[position] = 0
                dy[position] = 0
            }
            var buckets: [Int64: [Int]] = [:]
            buckets.reserveCapacity(count)
            for position in 0 ..< count {
                buckets[SplitMix64.cell(x: xs[position], y: ys[position], size: cell), default: []].append(position)
            }
            for position in 0 ..< count {
                let cx = Int64((xs[position] / cell).rounded(.down))
                let cy = Int64((ys[position] / cell).rounded(.down))
                for ox in -1 ... 1 {
                    for oy in -1 ... 1 {
                        guard let bucket = buckets[SplitMix64.cell(cx: cx + Int64(ox), cy: cy + Int64(oy))] else { continue }
                        for other in bucket where other != position {
                            var deltaX = xs[position] - xs[other]
                            var deltaY = ys[position] - ys[other]
                            var distance = (deltaX * deltaX + deltaY * deltaY).squareRoot()
                            if distance > reach { continue }
                            if distance < 0.0001 {
                                // Deux nœuds confondus : un écart minuscule, mais
                                // déterministe, les sépare.
                                deltaX = Double(position - other) * 0.0001
                                deltaY = 0.0001
                                distance = (deltaX * deltaX + deltaY * deltaY).squareRoot()
                            }
                            let force = k * k / distance
                            dx[position] += deltaX / distance * force
                            dy[position] += deltaY / distance * force
                        }
                    }
                }
            }
            // Attraction : chaque lien tire ses deux extrémités l'une vers l'autre.
            for (a, b) in springs {
                var deltaX = xs[a] - xs[b]
                var deltaY = ys[a] - ys[b]
                var distance = (deltaX * deltaX + deltaY * deltaY).squareRoot()
                if distance < 0.0001 {
                    deltaX = 0.0001
                    deltaY = 0
                    distance = 0.0001
                }
                let force = distance * distance / k
                let unitX = deltaX / distance
                let unitY = deltaY / distance
                dx[a] -= unitX * force
                dy[a] -= unitY * force
                dx[b] += unitX * force
                dy[b] += unitY * force
            }
            // Déplacement borné par la température, puis refroidissement.
            temperature = 0.1 * (1 - Double(step) / Double(effective))
            for position in 0 ..< count {
                let length = (dx[position] * dx[position] + dy[position] * dy[position]).squareRoot()
                guard length > 0.0000001 else { continue }
                let step = min(length, temperature)
                xs[position] = clamp(xs[position] + dx[position] / length * step)
                ys[position] = clamp(ys[position] + dy[position] / length * step)
            }
        }

        return normalize(xs: xs, ys: ys)
    }

    /// Recadre les positions dans `[0,1]²` : le graphe occupe toute la zone utile,
    /// ce qui rend « Recentrer » (⌘0) indépendant de l'échelle interne.
    private static func normalize(xs: [Double], ys: [Double]) -> [CGPoint] {
        let minX = xs.min() ?? 0
        let maxX = xs.max() ?? 1
        let minY = ys.min() ?? 0
        let maxY = ys.max() ?? 1
        let width = maxX - minX
        let height = maxY - minY
        return xs.indices.map { position in
            let x = width > 0.0000001 ? (xs[position] - minX) / width : 0.5
            let y = height > 0.0000001 ? (ys[position] - minY) / height : 0.5
            return CGPoint(x: x, y: y)
        }
    }

    private static func clamp(_ value: Double) -> Double {
        min(1, max(0, value))
    }
}

/// Un générateur déterministe (SplitMix64) : deux placements partent du même bruit
/// initial, donc rendent les mêmes positions.
private struct SplitMix64 {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    /// Un réel de `[0,1[`.
    mutating func nextUnit() -> Double {
        Double(next() >> 11) * (1.0 / 9_007_199_254_740_992.0)
    }

    /// La clé de la cellule d'une position (coordonnées déjà divisées par la
    /// taille de cellule).
    static func cell(x: Double, y: Double, size: Double) -> Int64 {
        cell(cx: Int64((x / size).rounded(.down)), cy: Int64((y / size).rounded(.down)))
    }

    static func cell(cx: Int64, cy: Int64) -> Int64 {
        cx &* 73_856_093 ^ cy &* 19_349_663
    }
}
