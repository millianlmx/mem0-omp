// Le lien profond d'une notification : ce qu'elle porte pour que son clic retrouve
// la carte qu'elle concerne, la destination calculée sur l'ardoise courante, et son
// application à la fenêtre.
//
// `AlertOpening` est posé dans `content.userInfo` à la livraison et relu au clic.
// Le payload est un dictionnaire property list de `String` seulement (deux clés) :
// une notification livrée par une version antérieure, sans payload, ou un payload
// illisible se décodent en `nil`, et le clic mène alors à l'Accueil.
//
// `AlertRoute.destination` est PURE ; `AlertRouter` l'applique, sur le patron des
// commandes de menu (« ramener la fenêtre puis muter un modèle »). Aucune règle
// d'état n'est réécrite ici : « en attente de réponse » = `MainSheetPolicy.answerZone`,
// « jalon specs » = `ContractDocument.moment`. `KanbanModel` ignore `ConsoleModel` :
// c'est le routeur qui orchestre la section et la fiche.

import Combine
import ConsoleCore
import Foundation

/// La famille et la carte d'une notification : de quoi calculer la destination du
/// clic sur l'ardoise courante.
struct AlertOpening: Sendable, Equatable {
    static let kindKey = "kind"
    static let cardIDKey = "cardID"

    var kind: AlertKind
    /// `KanbanCard.id` de la carte concernée ; jamais vide.
    var cardID: String

    /// Le payload posé sur la notification (types property list : `String` seulement).
    var userInfo: [String: String] {
        [Self.kindKey: kind.rawValue, Self.cardIDKey: cardID]
    }

    init(kind: AlertKind, cardID: String) {
        self.kind = kind
        self.cardID = cardID
    }

    /// Relit le payload d'une notification : `nil` si une clé manque, si une valeur
    /// n'est pas une `String`, si la famille est inconnue ou si la carte est vide.
    init?(userInfo: [AnyHashable: Any]) {
        guard let rawKind = userInfo[Self.kindKey] as? String,
              let kind = AlertKind(rawValue: rawKind),
              let cardID = userInfo[Self.cardIDKey] as? String,
              !cardID.isEmpty
        else { return nil }
        self.init(kind: kind, cardID: cardID)
    }
}

/// Où mène le clic : une feuille d'action, la fiche d'une carte, ou l'Accueil.
enum AlertDestination: Equatable {
    case answer(cardID: String)
    case contract(cardID: String)
    case detail(cardID: String)
    case home
}

enum AlertRoute {
    /// La destination d'un clic sur l'ardoise courante, `nil` = « attendre » :
    /// SEULEMENT quand l'ardoise est en chargement et que la notification porte
    /// une carte. Une carte encore dans l'état notifié ouvre sa feuille d'action ;
    /// une notification périmée ouvre la fiche, une carte disparue l'Accueil.
    static func destination(for opening: AlertOpening?, board: KanbanBoardState) -> AlertDestination? {
        guard let opening else { return .home }
        if case .loading = board { return nil }
        guard let card = board.card(opening.cardID) else { return .home }
        switch opening.kind {
        case .pendingAnswer:
            return MainSheetPolicy.answerZone(for: card) != nil
                ? .answer(cardID: opening.cardID)
                : .detail(cardID: opening.cardID)
        case .milestoneSpecs:
            return ContractDocument.moment(for: card) == .specs
                ? .contract(cardID: opening.cardID)
                : .detail(cardID: opening.cardID)
        case .milestoneReview, .failedLot, .failedRun, .mergedPullRequest:
            return .detail(cardID: opening.cardID)
        }
    }
}

/// Applique le clic d'une notification à la fenêtre principale.
///
/// Ordre : la fenêtre revient TOUJOURS au premier plan ; une feuille déjà attachée
/// n'est jamais remplacée (aucune saisie perdue) ; sinon la destination est
/// appliquée aux modèles. Ardoise encore en chargement : UNE seule ouverture
/// attend (la plus récente), appliquée à la première ardoise publiée.
@MainActor
final class AlertRouter {
    private weak var console: ConsoleModel?
    private weak var home: HomeModel?
    private weak var kanban: KanbanModel?
    private weak var contract: ContractModel?
    private weak var actions: ActionsModel?
    private let reveal: @MainActor () -> Void
    private let sheetAttached: @MainActor () -> Bool

    /// L'ouverture en attente de la première ardoise, et l'abonnement qui l'attend.
    private var pending: AlertOpening?
    private var waiting: AnyCancellable?

    init(
        console: ConsoleModel,
        home: HomeModel,
        kanban: KanbanModel,
        contract: ContractModel,
        actions: ActionsModel,
        reveal: @escaping @MainActor () -> Void = MainWindow.reveal,
        sheetAttached: @escaping @MainActor () -> Bool = MainWindow.hasAttachedSheet
    ) {
        self.console = console
        self.home = home
        self.kanban = kanban
        self.contract = contract
        self.actions = actions
        self.reveal = reveal
        self.sheetAttached = sheetAttached
    }

    /// Le clic d'une notification (`nil` : payload absent ou illisible).
    func open(_ opening: AlertOpening?) {
        reveal()
        guard let kanban else { return }
        route(opening, board: kanban.state)
    }

    /// Étapes 2 à 4, sans `reveal()` : rejouées telles quelles quand l'ardoise
    /// attendue arrive.
    private func route(_ opening: AlertOpening?, board: KanbanBoardState) {
        pending = nil
        if sheetAttached() {
            waiting = nil
            return
        }
        guard let destination = AlertRoute.destination(for: opening, board: board) else {
            pending = opening
            awaitBoard()
            return
        }
        waiting = nil
        apply(destination, board: board)
    }

    /// `@Published` émet AVANT d'écrire la propriété : l'ardoise utilisée est donc
    /// la valeur émise, jamais `kanban.state` relu dans le récepteur.
    private func awaitBoard() {
        guard waiting == nil, let kanban else { return }
        waiting = kanban.$state
            .first { state in
                if case .loading = state { return false }
                return true
            }
            .sink { [weak self] board in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.waiting = nil
                    guard let opening = self.pending else { return }
                    self.route(opening, board: board)
                }
            }
    }

    private func apply(_ destination: AlertDestination, board: KanbanBoardState) {
        switch destination {
        case .home:
            console?.select(.home)
        case .answer(let id):
            guard let actions else { return }
            home?.openAnswer(id, actions: actions)
        case .contract(let id):
            // La carte À JOUR de l'ardoise courante (mem0 41b4a4d7).
            guard let card = board.card(id) else { return }
            contract?.open(card)
        case .detail(let id):
            console?.select(.kanban)
            kanban?.openDetail(id)
        }
    }
}
