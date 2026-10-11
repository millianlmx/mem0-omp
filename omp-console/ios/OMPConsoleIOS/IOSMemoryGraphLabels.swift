// Les ÉTIQUETTES du graphe de la Mémoire sans chevauchement (ios-statistiques-et-
// graphe-accessibles, S-6, BR-3) : avant de peindre la scène partagée, la coque
// iOS retire les textes qui en recouvriraient un autre.
//
// Pourquoi une fonction pure iOS et pas `MemoryGraphScene` : la scène vit dans
// `ConsoleCore`, partagée avec le Mac qui doit rendre exactement comme avant ; et
// la décision dépend de la taille RÉELLE des textes (police UIKit à la catégorie
// Dynamic Type courante), que seule la coque connaît. Le canevas ne fait donc que
// peindre ce que `declutter` garde, et le test confronte les mêmes cadres sans
// rendre de vue.
//
// La règle vaut à tous les zooms : en zoomant, l'espacement grandit et les textes
// masqués reviennent dès qu'ils ont la place. Une capsule d'étiquette perdante
// n'est pas effacée : son centre devient une pastille (`markers`), si bien que le
// nœud reste visible, touchable et accessible.

import ConsoleCore
import CoreGraphics
import UIKit

/// La police d'un texte du graphe, telle que le canevas la dessine : `.caption`
/// gras pour un nom de grappe, `.caption2` pour un libellé de souvenir et pour le
/// texte d'une capsule d'étiquette.
enum IOSMemoryGraphLabelFont: Equatable, Hashable {
    case cluster, memory, tag
}

/// La scène à peindre une fois les textes décollés.
struct IOSMemoryGraphDecluttered {
    /// La scène, dans l'ordre de dessin, sans les libellés et capsules perdants.
    let shapes: [MemoryGraphShape]
    /// Les centres des nœuds-étiquettes dont la capsule n'a pas eu sa place.
    let markers: [CGPoint]
    /// Les cadres de collision des textes GARDÉS (libellés et capsules).
    let textFrames: [CGRect]
}

enum IOSMemoryGraphLabels {
    /// L'air laissé autour de chaque texte, de chaque côté.
    static let margin: CGFloat = 2
    /// Le côté d'une cellule de la grille de collision.
    static let cell: CGFloat = 64

    /// La taille d'un texte dans la police que le canevas emploie, à la catégorie
    /// Dynamic Type donnée, arrondie au point supérieur.
    static func measure(_ text: String, font: IOSMemoryGraphLabelFont, category: UIContentSizeCategory) -> CGSize {
        let traits = UITraitCollection(preferredContentSizeCategory: category)
        let style: UIFont.TextStyle = font == .cluster ? .caption1 : .caption2
        var uiFont = UIFont.preferredFont(forTextStyle: style, compatibleWith: traits)
        if font == .cluster, let bold = uiFont.fontDescriptor.withSymbolicTraits(.traitBold) {
            uiFont = UIFont(descriptor: bold, size: 0)
        }
        let size = (text as NSString).size(withAttributes: [.font: uiFont])
        return CGSize(width: size.width.rounded(.up), height: size.height.rounded(.up))
    }

    /// Retire de la scène les textes qui en chevaucheraient un autre (glouton,
    /// déterministe) : d'abord les noms de grappe, puis les capsules, puis les
    /// libellés de souvenir, chaque groupe dans l'ordre de la scène. Un texte est
    /// gardé si son cadre ne touche aucun cadre déjà gardé ; un texte hors du
    /// canevas n'est pas peint. Les liens et les disques ne sont jamais retirés.
    static func declutter(
        _ scene: MemoryGraphScene,
        canvas: CGSize,
        measure: (String, IOSMemoryGraphLabelFont) -> CGSize
    ) -> IOSMemoryGraphDecluttered {
        let bounds = CGRect(origin: .zero, size: canvas)
        var candidates: [Candidate] = []
        for (index, shape) in scene.shapes.enumerated() {
            switch shape {
            case let .label(center, text, hue):
                let font: IOSMemoryGraphLabelFont = hue == nil ? .memory : .cluster
                let frame = centered(measure(text, font), on: center).insetBy(dx: -margin, dy: -margin)
                candidates.append(Candidate(index: index, rank: hue == nil ? 2 : 0, frame: frame))
            case let .capsule(center, size, label):
                let frame = centered(size, on: center)
                    .union(centered(measure(label, .tag), on: center))
                    .insetBy(dx: -margin, dy: -margin)
                candidates.append(Candidate(index: index, rank: 1, frame: frame))
            case .line, .disc:
                continue
            }
        }
        // Tri STABLE par priorité : l'ordre de la scène départage un même groupe.
        let ordered = candidates.enumerated()
            .sorted { ($0.element.rank, $0.offset) < ($1.element.rank, $1.offset) }
            .map(\.element)

        var grid = CollisionGrid()
        var dropped = Set<Int>()
        var shrunk = Set<Int>()
        for candidate in ordered {
            guard isFinite(candidate.frame), candidate.frame.intersects(bounds) else {
                dropped.insert(candidate.index)
                continue
            }
            if grid.collides(candidate.frame) {
                dropped.insert(candidate.index)
                if candidate.rank == 1 { shrunk.insert(candidate.index) }
            } else {
                grid.insert(candidate.frame)
            }
        }

        var shapes: [MemoryGraphShape] = []
        var markers: [CGPoint] = []
        shapes.reserveCapacity(scene.shapes.count - dropped.count)
        for (index, shape) in scene.shapes.enumerated() {
            if shrunk.contains(index), case let .capsule(center, _, _) = shape { markers.append(center) }
            if !dropped.contains(index) { shapes.append(shape) }
        }
        return IOSMemoryGraphDecluttered(shapes: shapes, markers: markers, textFrames: grid.kept)
    }

    // MARK: - Détails

    private struct Candidate {
        let index: Int
        /// 0 = nom de grappe, 1 = capsule, 2 = libellé de souvenir.
        let rank: Int
        let frame: CGRect
    }

    private static func centered(_ size: CGSize, on center: CGPoint) -> CGRect {
        CGRect(x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height)
    }

    private static func isFinite(_ rect: CGRect) -> Bool {
        rect.minX.isFinite && rect.minY.isFinite && rect.maxX.isFinite && rect.maxY.isFinite
    }

    /// La grille uniforme de collision : un cadre n'est confronté qu'aux cadres
    /// gardés qui partagent une de ses cellules, jamais à toutes les paires.
    private struct CollisionGrid {
        private struct Cell: Hashable {
            let x: Int
            let y: Int
        }

        private(set) var kept: [CGRect] = []
        private var cells: [Cell: [Int]] = [:]

        func collides(_ frame: CGRect) -> Bool {
            for cell in Self.cells(of: frame) {
                for index in cells[cell] ?? [] where kept[index].intersects(frame) {
                    return true
                }
            }
            return false
        }

        mutating func insert(_ frame: CGRect) {
            let index = kept.count
            kept.append(frame)
            for cell in Self.cells(of: frame) {
                cells[cell, default: []].append(index)
            }
        }

        private static func cells(of frame: CGRect) -> [Cell] {
            let side = IOSMemoryGraphLabels.cell
            let left = Int((frame.minX / side).rounded(.down))
            let right = Int((frame.maxX / side).rounded(.down))
            let top = Int((frame.minY / side).rounded(.down))
            let bottom = Int((frame.maxY / side).rounded(.down))
            var result: [Cell] = []
            result.reserveCapacity((right - left + 1) * (bottom - top + 1))
            for x in left...right {
                for y in top...bottom {
                    result.append(Cell(x: x, y: y))
                }
            }
            return result
        }
    }
}

/// Les tailles mesurées, mémoïsées par texte, police et catégorie Dynamic Type :
/// le canevas se repeint à chaque pas d'un geste, alors que ses textes changent
/// rarement. Tenue en `@State` par `IOSMemoryGraphView`.
final class IOSMemoryGraphLabelSizes {
    private struct Key: Hashable {
        let text: String
        let font: IOSMemoryGraphLabelFont
        let category: UIContentSizeCategory
    }

    private var sizes: [Key: CGSize] = [:]

    func size(_ text: String, font: IOSMemoryGraphLabelFont, category: UIContentSizeCategory) -> CGSize {
        let key = Key(text: text, font: font, category: category)
        if let known = sizes[key] { return known }
        let measured = IOSMemoryGraphLabels.measure(text, font: font, category: category)
        sizes[key] = measured
        return measured
    }
}
