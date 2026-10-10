// Le crochet de RECETTE `-memoire.recipe <graphe|zoom|fiche|liste>` (BR-7) : il force le
// mode graphe de la section Mémoire sur la fixture PARTAGÉE `MemoryGraphParity`
// (ConsoleCore), sans réseau et sans écran fabriqué — les API réelles du modèle
// (`apply`, `magnify`, `drag`, `select`) sont employées telles quelles. La recette
// `liste` (feuilles-ios-presentation-et-depots) charge la même fixture SANS montrer le
// graphe : l'écran reste en mode LISTE et ouvre la fiche d'un souvenir par le
// présentateur de la liste (`listSelection`).
//
// Sans l'argument : aucun effet. Comme `IOSSection.resolve` et `IOSHomeRecipe`, la
// DERNIÈRE paire reconnue gagne ; une valeur inconnue est ignorée.
//
// Le fichier ne nomme AUCUN type du magasin (jeton interdit des sources iOS) et
// aucun littéral alphabétique (les mots viennent d'`IOSMemoryText`).

import ConsoleClient
import ConsoleCore
import CoreGraphics
import Foundation

/// Le crochet lu dans les arguments de lancement.
enum IOSMemoryGraphRecipe: Equatable {
    case graphe
    case zoom
    case fiche
    case liste

    /// La recette lue dans les arguments de lancement, ou aucune.
    static func resolve(_ arguments: [String]) -> IOSMemoryGraphRecipe? {
        var resolved: IOSMemoryGraphRecipe?
        var index = 0
        while index < arguments.count {
            if arguments[index] == IOSMemoryText.graphRecipeFlag,
               index + 1 < arguments.count,
               let recipe = named(arguments[index + 1]) {
                resolved = recipe
            }
            index += 1
        }
        return resolved
    }

    /// Les valeurs reconnues, lues dans le vocabulaire de l'app (aucun littéral ici).
    private static func named(_ value: String) -> IOSMemoryGraphRecipe? {
        switch value {
        case IOSMemoryText.graphRecipePlate: return .graphe
        case IOSMemoryText.graphRecipeZoom: return .zoom
        case IOSMemoryText.graphRecipeSheet: return .fiche
        case IOSMemoryText.graphRecipeList: return .liste
        default: return nil
        }
    }

    /// La charge utile EXACTE de la fixture, mise en forme par le vocabulaire du fil
    /// (`MemoryGraphWire`) : le modèle la relit par le même chemin que la route.
    var payload: RemoteMemoryGraphPayload {
        let facts = MemoryGraphParity.facts
        let nodes = facts.nodes.map { node in
            RemoteMemoryGraphNode(
                id: MemoryGraphWire.id(node.id),
                label: node.label,
                scope: node.scope ?? "",
                text: node.text,
                tags: node.text == nil ? nil : node.tags
            )
        }
        let links = facts.links.map { link in
            RemoteMemoryGraphLink(
                a: MemoryGraphWire.id(link.a),
                b: MemoryGraphWire.id(link.b),
                kind: MemoryGraphWire.name(link.kind),
                score: score(link.kind)
            )
        }
        // La portée de la charge : celle du premier nœud-souvenir qui en porte une,
        // comme la coque la résout pour la route.
        let scope = facts.nodes.first { $0.id.memoryId != nil && $0.scope != nil }?.scope
        return RemoteMemoryGraphPayload(scope: scope, nodes: nodes, links: links, total: nodes.count)
    }

    /// L'état forcé : le graphe affiché sur la charge utile de la fixture, puis —
    /// selon la recette — un pincement et un glissement RÉELS, ou la sélection d'un
    /// souvenir. `liste` publie la fixture sans activer le graphe.
    @MainActor func activate(_ model: IOSMemoryGraphModel) async {
        await model.apply(payload)
        guard self != .liste else { return }
        await model.activate()
        let center = CGPoint(x: 195, y: 350)
        let size = CGSize(width: 390, height: 700)
        switch self {
        case .graphe, .liste:
            break
        case .zoom:
            model.magnify(by: 2, at: center, size: size)
            model.endMagnify()
            model.drag(by: CGSize(width: 60, height: 40))
            model.endDrag()
        case .fiche:
            model.select(IOSMemoryText.graphRecipeMemory)
        }
        announce(model)
    }

    /// La fiche que la recette `liste` ouvre depuis la LISTE : le souvenir de la
    /// fixture, lu dans le graphe publié par `activate`. `nil` pour les autres recettes,
    /// ou si la fixture ne porte pas ce souvenir.
    @MainActor func listSelection(_ model: IOSMemoryGraphModel) -> IOSMemorySelection? {
        guard self == .liste, let row = model.row(IOSMemoryText.graphRecipeMemory) else { return nil }
        return IOSMemorySelection(row: row)
    }

    /// Le signal de PRÊT sur la sortie d'erreur du lancement (`--stderr`), lu par
    /// `scripts/ios-shots.sh` : il n'est émis que si l'état forcé est réellement affiché (graphe
    /// monté, zoom appliqué, fiche ouverte sur le souvenir de la recette). Un état non
    /// atteint n'émet rien, et le script refuse la capture.
    @MainActor private func announce(_ model: IOSMemoryGraphModel) {
        guard model.shown, case .graph = model.state else { return }
        switch self {
        case .graphe, .liste:
            break
        case .zoom:
            guard model.zoom != 1 else { return }
        case .fiche:
            guard model.selection == IOSMemoryText.graphRecipeMemory else { return }
        }
        FileHandle.standardError.write(Data(IOSMemoryText.graphRecipeReady.utf8))
    }

    private func score(_ kind: MemoryGraphLinkKind) -> Double? {
        if case let .semantic(value) = kind { return value }
        return nil
    }
}
