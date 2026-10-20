// Les DEUX machines de la coque (S-6, S-10 de orchestrator-living-in-a-vps) : le Mac
// (ses modèles et son service local) et le VPS (un client distant appairé, slot
// `.vps`, trousseau `com.omp.console.vps-client`). Le hub est le SEUL endroit qui sait
// où part un geste et d'où vient une carte :
//
// - ardoise unifiée : quand un VPS est configuré, les cartes du VPS (`vps:<id>`) entrent
//   dans l'ardoise que montrent l'Accueil et Pipelines, avec leurs badges et bandeaux ;
//   sans VPS configuré, `KanbanModel.board` est l'ardoise du Mac, inchangée ;
// - geste de carte : `RemoteGestureRelay` envoie le geste d'une carte du VPS à CE
//   client, avec l'identifiant de carte du VPS ;
// - écrans mono-machine : `activeMachine` (Mac par défaut), choisi par le sélecteur.

import Combine
import ConsoleClient
import ConsoleCore
import Foundation

/// Un geste d'une carte du VPS.
enum RemoteCardGesture: Equatable, Sendable {
    case answerSelected(toolCallId: String, label: String)
    case answerCustom(toolCallId: String, text: String)
    case text(String)
    case reply(String)
    case verdict(String)
    case resume
    case stop
}

/// Le relais des gestes vers la machine d'une carte (`ActionsModel.relay`).
@MainActor
protocol RemoteGestureRelay: AnyObject {
    /// Envoie le geste à la machine de la carte ; rend le motif de l'échec, `nil` quand
    /// elle l'a pris en charge.
    func send(_ gesture: RemoteCardGesture, cardId: String) async -> String?

    /// `POST /v1/features` vers la machine conductrice du dépôt ; même retour.
    func launch(repoRoot: String, title: String, description: String, modelReqSpecs: String?, modelImplReview: String?) async -> String?
}

@MainActor
final class MachineHub: ObservableObject, RemoteGestureRelay {
    let local: LocalMacSource
    let vps: ConsoleClientModel
    /// La section « Dépôts » : les deux machines fusionnées et la bascule.
    let repos: UnifiedReposModel
    /// Le bloc de connexion au VPS de la section « Dépôts ».
    let connection: VpsConnectionModel
    /// La Session OMP hébergée sur le VPS (S-8) : la section « Session OMP » la montre
    /// quand le sélecteur « Mac | VPS » est sur « VPS ».
    let session: VpsSessionModel
    /// Le choix de l'utilisateur pour les écrans mono-machine.
    @Published private(set) var chosen: RepoMachine = .mac

    private let vpsSource: ClientMachineSource
    private let kanban: KanbanModel
    private var cancellables: Set<AnyCancellable> = []

    init(
        local: LocalMacSource,
        vps: ConsoleClientModel,
        kanban: KanbanModel,
        actions: ActionsModel,
        preferences: any ClientPreferences
    ) {
        self.local = local
        self.vps = vps
        self.kanban = kanban
        vpsSource = ClientMachineSource(vps)
        repos = UnifiedReposModel(mac: local, vps: vpsSource, preferences: preferences)
        connection = VpsConnectionModel(client: vps)
        session = VpsSessionModel(client: vps)
        actions.relay = self
        for changes in [local.changes, vpsSource.changes] {
            changes
                .sink { [weak self] in self?.publishBoard() }
                .store(in: &cancellables)
        }
        vps.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &cancellables)
    }

    /// La production : le VPS saisi à la main, son jeton au trousseau
    /// `com.omp.console.vps-client`.
    static let keychainService = "com.omp.console.vps-client"

    static func live(local: LocalMacSource, kanban: KanbanModel, actions: ActionsModel) -> MachineHub {
        MachineHub(
            local: local,
            vps: ConsoleClientModel.live(slot: .vps, keychainService: keychainService),
            kanban: kanban,
            actions: actions,
            preferences: UserDefaultsClientPreferences()
        )
    }

    /// Démarre le client du VPS (relit le trousseau, se connecte s'il est appairé) puis
    /// lit les dépôts des deux machines. Idempotent.
    func start() {
        vps.start()
        publishBoard()
        Task { await repos.refresh() }
    }

    // MARK: - État

    var availability: MachineAvailability { vpsSource.availability }

    /// Un VPS est configuré (appairé) : badges, bandeaux et sélecteurs apparaissent.
    var vpsConfigured: Bool { availability != .notConfigured }

    /// La machine qui répond aux écrans mono-machine : le Mac, sauf choix du VPS configuré.
    var activeMachine: RepoMachine { vpsConfigured ? chosen : .mac }

    func select(_ machine: RepoMachine) {
        chosen = machine
    }

    // MARK: - Ardoise unifiée

    /// L'ardoise unifiée, ou `nil` sans VPS configuré (le tableau est alors celui du Mac).
    var unifiedBoard: UnifiedBoard? {
        guard vpsConfigured else { return nil }
        let vpsEntry: MachineBoard
        switch availability {
        case .notConfigured: vpsEntry = .notConfigured
        case .unreachable: vpsEntry = .unreachable
        case .reachable: vpsEntry = .state(vps.board)
        }
        var board = UnifiedBoard.merge(mac: .state(kanban.state), vps: vpsEntry)
        board.state = Self.stamped(board.state)
        return board
    }

    func publishBoard() {
        kanban.setUnified(unifiedBoard)
    }

    /// Chaque carte du VPS porte son identifiant unifié dans son geste : c'est lui qui
    /// route le geste vers le VPS (`ActionsModel.relay`).
    static func stamped(_ state: KanbanBoardState) -> KanbanBoardState {
        guard case .board(let board) = state else { return state }
        let cards = board.cards.map { card -> KanbanCard in
            guard MachineCardID.machine(of: card.id) == .vps, var action = card.action else { return card }
            action.cardId = card.id
            var stamped = card
            stamped.action = action
            return stamped
        }
        return .board(KanbanBoard(cards: cards, anomalies: board.anomalies))
    }

    // MARK: - Gestes vers le VPS

    func send(_ gesture: RemoteCardGesture, cardId: String) async -> String? {
        let raw = MachineCardID.raw(cardId)
        do {
            switch gesture {
            case .answerSelected(let toolCallId, let label):
                _ = try await vps.answer(cardId: raw, kind: "selected", label: label, text: nil, toolCallId: toolCallId)
            case .answerCustom(let toolCallId, let text):
                _ = try await vps.answer(cardId: raw, kind: "custom", label: nil, text: text, toolCallId: toolCallId)
            case .text(let text):
                _ = try await vps.text(cardId: raw, text: text)
            case .reply(let text):
                _ = try await vps.reply(cardId: raw, text: text)
            case .verdict(let verdict):
                _ = try await vps.verdict(cardId: raw, verdict: verdict)
            case .resume:
                _ = try await vps.resume(cardId: raw)
            case .stop:
                _ = try await vps.stop(cardId: raw)
            }
            return nil
        } catch {
            return Self.reason(error)
        }
    }

    func launch(repoRoot: String, title: String, description: String, modelReqSpecs: String?, modelImplReview: String?) async -> String? {
        do {
            _ = try await vps.launch(
                repoRoot: repoRoot, title: title, description: description,
                modelReqSpecs: modelReqSpecs, modelImplReview: modelImplReview
            )
            return nil
        } catch {
            return Self.reason(error)
        }
    }

    /// Le motif du refus du VPS tel quel, sinon une phrase sur la panne.
    static func reason(_ error: Error) -> String {
        if case ClientError.api(let api) = error { return api.message ?? api.code }
        return ReposText.vpsUnreachable
    }

    // MARK: - Nouvelle feature

    /// Les dépôts proposés par la feuille « Nouvelle feature » : un par dépôt unifié
    /// pilotable, avec la machine conductrice et SA racine.
    var launchChoices: [(name: String, machine: RepoMachine, root: String)] {
        repos.lines.compactMap { line in
            guard let target = line.launchTarget else { return nil }
            return (line.name, target.machine, target.row.repoRoot)
        }
    }
}
