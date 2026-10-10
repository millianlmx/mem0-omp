import ConsoleClient
import ConsoleCore

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
}
