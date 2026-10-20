// Les DEUX clients de l'app iOS, Mac et VPS (S-10 de orchestrator-living-in-a-vps),
// chacun appairé indépendamment : le conteneur choisit, pour chaque geste et chaque
// écran, la machine qui répond. Aucune vue ne choisit un endpoint elle-même.
//
// - ardoise unifiée (`board`) : les cartes des deux machines, les cartes du VPS
//   portant l'identifiant `vps:<id>` (`MachineCardID`) ; sans VPS configuré, ce
//   que le client du Mac publie, tel quel ;
// - geste de carte (`target(forCardId:)`) : le client DE LA CARTE et l'identifiant
//   de cette machine ;
// - écrans mono-machine (`activeMachine`) : Mac par défaut s'il est joignable,
//   sinon VPS ; l'utilisateur peut imposer l'une ou l'autre (`select`).

import Combine
import ConsoleCore
import Foundation

@MainActor
public final class MachineClients: ObservableObject {
    public let mac: ConsoleClientModel
    public let vps: ConsoleClientModel
    /// La section « Dépôts » : les deux machines fusionnées et la bascule.
    public let repos: UnifiedReposModel
    /// Le choix explicite de l'utilisateur pour les écrans mono-machine ; `nil` : le défaut.
    @Published public private(set) var chosen: RepoMachine?

    private let macSource: ClientMachineSource
    private let vpsSource: ClientMachineSource
    private var forwarding: Set<AnyCancellable> = []

    public init(mac: ConsoleClientModel, vps: ConsoleClientModel, preferences: any ClientPreferences) {
        self.mac = mac
        self.vps = vps
        macSource = ClientMachineSource(mac)
        vpsSource = ClientMachineSource(vps)
        repos = UnifiedReposModel(mac: macSource, vps: vpsSource, preferences: preferences)
        for model in [mac, vps] {
            model.objectWillChange
                .sink { [weak self] in self?.objectWillChange.send() }
                .store(in: &forwarding)
        }
    }

    /// La production : le Mac découvert par Bonjour, le VPS saisi à la main.
    public static func live(deviceName: String = ClientDeviceModel.current) -> MachineClients {
        MachineClients(
            mac: ConsoleClientModel.live(deviceName: deviceName, slot: .mac),
            vps: ConsoleClientModel.live(deviceName: deviceName, slot: .vps),
            preferences: UserDefaultsClientPreferences()
        )
    }

    public func client(for machine: RepoMachine) -> ConsoleClientModel {
        machine == .mac ? mac : vps
    }

    public func availability(of machine: RepoMachine) -> MachineAvailability {
        (machine == .mac ? macSource : vpsSource).availability
    }

    /// Un VPS est configuré (appairé) : badges, bandeaux et sélecteurs apparaissent.
    public var vpsConfigured: Bool { availability(of: .vps) != .notConfigured }

    // MARK: - Ardoise unifiée

    public var board: UnifiedBoard {
        let vpsEntry = entry(.vps)
        let macEntry: MachineBoard = vpsEntry == .notConfigured ? .state(mac.board) : entry(.mac)
        return UnifiedBoard.merge(mac: macEntry, vps: vpsEntry)
    }

    private func entry(_ machine: RepoMachine) -> MachineBoard {
        let source = machine == .mac ? macSource : vpsSource
        switch source.availability {
        case .notConfigured: return .notConfigured
        case .unreachable: return .unreachable
        case .reachable: return .state(source.boardState)
        }
    }

    /// Le client et l'identifiant de carte d'une carte de l'ardoise unifiée : le
    /// geste part vers la machine de la carte, avec l'identifiant de CETTE machine.
    public func target(forCardId id: String) -> (client: ConsoleClientModel, cardId: String, machine: RepoMachine) {
        let machine = MachineCardID.machine(of: id)
        return (client(for: machine), MachineCardID.raw(id), machine)
    }

    // MARK: - Écrans mono-machine

    /// La machine qui répond aux écrans mono-machine : le choix de l'utilisateur,
    /// sinon le Mac s'il est joignable, sinon le VPS configuré et joignable.
    public var activeMachine: RepoMachine {
        if let chosen, vpsConfigured || chosen == .mac { return chosen }
        if availability(of: .mac) == .reachable { return .mac }
        if availability(of: .vps) == .reachable { return .vps }
        return .mac
    }

    public var activeClient: ConsoleClientModel { client(for: activeMachine) }

    public func select(_ machine: RepoMachine) {
        chosen = machine
    }
}
