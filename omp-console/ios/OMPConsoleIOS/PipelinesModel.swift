import ConsoleClient
import ConsoleCore
import SwiftUI

/// L'état de l'écran Pipelines (S-4), dans l'ordre de priorité : chargement,
/// déconnecté sans instantané, puis l'ardoise (absente, vide ou peuplée). Une
/// fonction pure de `(instantané, état de connexion)` — l'écran ne tient AUCUN
/// cache propre (S-3).
enum PipelinesScreenState: Equatable {
    /// L'app est connectée, l'instantané n'est pas encore arrivé.
    case loading
    /// L'app n'est pas connectée et n'a jamais reçu d'instantané.
    case noSnapshot
    /// Un instantané connu : absent, vide, ou l'ardoise.
    case board(KanbanBoardState)
}

/// La cible d'une feuille de l'écran : la carte par son IDENTIFIANT (S-3), ou la
/// feuille « Nouvelle feature… ».
enum PipelinesSheet: Identifiable {
    case card(String)
    case newFeature

    var id: String {
        switch self {
        case .card(let cardId): return PipelinesText.cardSheetId(cardId)
        case .newFeature: return PipelinesText.newFeatureSheetId
        }
    }
}

/// Une voie telle que l'écran Pipelines la rend.
struct PipelinesLaneRow: Identifiable, Equatable {
    /// La voie et TOUTES ses cartes : le compte de l'en-tête reste celui de la voie, repliée ou non.
    let content: KanbanLaneContent
    /// L'en-tête replie et déplie la voie.
    let foldable: Bool
    /// Repliée : seul l'en-tête est rendu.
    let folded: Bool

    var id: String { content.id }
    var lane: KanbanLane { content.lane }
    var visibleCards: [KanbanCard] { folded ? [] : content.cards }
}

/// La logique PURE de l'écran Pipelines (S-3, S-4) : aucune donnée n'est
/// inventée, aucune n'est mise en cache. L'écran dérive tout de l'instantané du
/// client (`ConsoleClientModel.snapshot`), alimenté par la trame `store`.
@MainActor
enum PipelinesModel {
    /// L'état publié de l'ardoise depuis l'instantané du client, ou `nil` tant
    /// qu'aucun instantané n'est arrivé. La vivacité est TRANSPORTÉE par
    /// l'instantané : l'app ne sonde jamais un pid du Mac.
    static func boardState(of client: ConsoleClientModel, nowMs: Double) -> KanbanBoardState? {
        guard let snapshot = client.snapshot else { return nil }
        return KanbanBoardState.derive(
            snapshot: snapshot,
            nowMs: nowMs,
            stateDir: "",
            isAlive: .transported(snapshot)
        )
    }

    /// L'état de l'écran : un instantané connu PRIME (l'ardoise reste affichée si
    /// la connexion est ensuite perdue) ; connectée sans instantané = chargement ;
    /// pas connectée sans instantané = déconnecté explicite.
    static func screen(connection: ClientState, board: KanbanBoardState?) -> PipelinesScreenState {
        if let board { return .board(board) }
        if case .connected = connection { return .loading }
        return .noSnapshot
    }

    /// Le bandeau de l'état de connexion, `nil` quand l'app est connectée.
    static func connectionBanner(connection: ClientState) -> ConsoleStatus? {
        if case .connected = connection { return nil }
        return ConsoleStatus(text: ConnectionText.state(connection), tone: .attention)
    }

    /// Les voies que l'en-tête peut replier : les deux voies terminales.
    static let foldableLanes: Set<KanbanLane> = [.livrees, .arretees]

    /// Les voies telles que l'écran les rend. En largeur régulière (iPad) : une
    /// rangée par voie de `lanes`, voies vides comprises, sans repli — l'affichage
    /// d'avant. En largeur compacte (iPhone) : les voies sans carte sont écartées,
    /// et les voies terminales sont repliées sauf celles de `unfolded`. Les cartes
    /// d'une voie ne sont jamais tronquées (S-1).
    static func laneRows(_ lanes: [KanbanLaneContent], compact: Bool, unfolded: Set<KanbanLane>) -> [PipelinesLaneRow] {
        guard compact else {
            return lanes.map { PipelinesLaneRow(content: $0, foldable: false, folded: false) }
        }
        return lanes.filter { !$0.cards.isEmpty }.map { content in
            let foldable = foldableLanes.contains(content.lane)
            return PipelinesLaneRow(content: content, foldable: foldable, folded: foldable && !unfolded.contains(content.lane))
        }
    }

    /// La largeur d'une voie en largeur régulière (iPad) : `scaled`
    /// (`IOSMetrics.laneWidth` mise à l'échelle par Dynamic Type), plafonnée à la
    /// largeur visible du défilement moins la marge de fin, pour qu'une voie
    /// défilée jusqu'au bout tienne entière à l'écran. Un conteneur pas encore
    /// mesuré (ou plus étroit que la marge) laisse `scaled`. Le contenu de la voie
    /// n'intervient jamais : toutes les voies ont la même largeur.
    nonisolated static func laneWidth(scaled: CGFloat, container: CGFloat, endMargin: CGFloat) -> CGFloat {
        let visible = container - endMargin
        return visible > 0 ? min(scaled, visible) : scaled
    }

    /// L'axe de l'en-tête d'une voie (symbole, titre, compte) : la règle des
    /// rangées de l'Accueil, empilé aux tailles d'accessibilité.
    static func headerAxis(_ size: DynamicTypeSize) -> IOSHomeRowAxis {
        IOSHomeContent.rowAxis(size)
    }
}
