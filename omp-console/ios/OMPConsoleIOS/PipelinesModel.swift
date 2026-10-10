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
