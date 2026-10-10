import ConsoleClient
import ConsoleCore
import SwiftUI

/// L'état de l'écran Pipelines (S-4), dans l'ordre de priorité : l'ardoise
/// reçue (absente, vide ou peuplée), le chargement, puis le composant d'état de
/// connexion. Une fonction pure de `(instantané, statut de connexion)` — l'écran
/// ne tient AUCUN cache propre (S-3).
enum PipelinesScreenState: Equatable {
    /// L'app est connectée, l'instantané n'est pas encore arrivé.
    case loading
    /// L'app n'est pas connectée et n'a jamais reçu d'instantané : le composant
    /// d'état de connexion en plein écran (etats-non-connecte-heterogenes-ios, S-4).
    case unavailable(IOSConnectionStatus)
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

/// Les deux lignes de modèle de la fiche (S-4) : « req+specs <nom|sélecteur> »
/// et « impl+review … ».
struct PipelinesModelLines: Equatable {
    let reqSpecs: String
    let implReview: String
}

/// La logique PURE de l'écran Pipelines (S-3, S-4) : aucune donnée n'est
/// inventée, aucune n'est mise en cache. L'écran dérive tout de l'instantané du
/// client (`ConsoleClientModel.snapshot`), alimenté par la trame `store`.
@MainActor
enum PipelinesModel {
    /// L'état publié de l'ardoise depuis l'instantané du client, ou `nil` tant
    /// qu'aucun instantané n'est arrivé. La vivacité est TRANSPORTÉE par
    /// l'instantané : l'app ne sonde jamais un pid du Mac. Les faits de PR sont
    /// ceux servis par le Mac (trame `pull-request-states`) ; sans eux, une carte
    /// à PR reste « PR créée ».
    static func boardState(of client: ConsoleClientModel, nowMs: Double) -> KanbanBoardState? {
        guard let snapshot = client.snapshot else { return nil }
        return KanbanBoardState.derive(
            snapshot: snapshot,
            nowMs: nowMs,
            stateDir: "",
            isAlive: .transported(snapshot),
            prFacts: client.pullRequestFacts
        )
    }

    /// Le bouton « Rafraîchir » (S-7) n'est actif que connecté au Mac et hors
    /// d'une relecture déjà en cours.
    static func canRefresh(connection: ClientState, refreshing: Bool) -> Bool {
        guard case .connected = connection else { return false }
        return !refreshing
    }

    /// L'état de l'écran : un instantané connu PRIME (l'ardoise reste affichée,
    /// sous le bandeau de connexion, si la connexion est ensuite perdue) ;
    /// connectée sans instantané = chargement ; pas connectée sans instantané =
    /// le composant d'état de connexion.
    static func screen(connection: IOSConnectionStatus, board: KanbanBoardState?) -> PipelinesScreenState {
        if let board { return .board(board) }
        if connection == .connected { return .loading }
        return .unavailable(connection)
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
        IOSHomeContent.rowAxis(size, width: .regular)
    }

    /// Le nom lisible d'un sélecteur d'après le catalogue servi par le Mac
    /// (correspondance EXACTE) ; le sélecteur tel quel quand le catalogue est
    /// absent, ne le connaît pas ou donne un nom blanc — jamais un nom inventé.
    static func modelName(_ selector: String, names: [String: String]?) -> String {
        guard let name = names?[selector],
              !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return selector }
        return name
    }

    /// Les deux lignes de modèle d'une carte, `nil` quand elle n'en porte pas.
    /// Un groupe vide reste « défaut OMP » (mots partagés, `KanbanCardPresentation`).
    static func modelLines(_ card: KanbanCard, names: [String: String]?) -> PipelinesModelLines? {
        guard let models = card.models else { return nil }
        return PipelinesModelLines(
            reqSpecs: KanbanCardPresentation.modelLine(
                KanbanText.modelReqSpecs,
                models.reqSpecs.map { modelName($0, names: names) }
            ),
            implReview: KanbanCardPresentation.modelLine(
                KanbanText.modelImplReview,
                models.implReview.map { modelName($0, names: names) }
            )
        )
    }

    /// Le catalogue des modèles de la feuille « Nouvelle feature » : le MÊME chemin
    /// pour le premier chargement et pour Réessayer. Un échec rend le message du
    /// traducteur partagé ; sur 401 (`nil`), l'état de connexion « jeton révoqué »
    /// prend la place du message — le parcours de révocation parle seul.
    static func catalog(_ load: @MainActor () async throws -> RemoteModelsPayload) async -> ModelCatalogState {
        do {
            let payload = try await load()
            if let failure = payload.failure {
                return .failed(KanbanText.modelCatalogUnavailable(failure))
            }
            return .loaded(payload.selectors)
        } catch {
            return .failed(IOSMacErrorText.message(for: error) ?? ConnectionText.revoked)
        }
    }

    /// La date et l'heure (à la minute) d'une carte, « 9 oct. 2026 à 14:32 » : la
    /// fin quand la carte est close, sinon le début. `nil` quand l'instant n'est
    /// pas une vraie date (0, négatif, NaN, ∞) : aucune date n'est inventée, et un
    /// `endMs` invalide ne se replie pas sur `startMs`.
    static func cardDate(_ card: KanbanCard, timeZone: TimeZone = .current) -> String? {
        let instant = card.endMs ?? card.startMs
        guard instant.isFinite, instant > 0 else { return nil }
        return ConsoleFormat.dateTime(ms: instant, timeZone: timeZone)
    }
}
