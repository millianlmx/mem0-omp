// Une machine vue par la section « Dépôts » (S-6 de orchestrator-living-in-a-vps) :
// ce dont la vue unifiée a besoin, sans savoir si la machine est jointe par un
// client distant (iOS, ou le VPS depuis omp-console) ou par le service local (le
// Mac depuis omp-console).

import Combine
import ConsoleCore
import Foundation

/// La disponibilité d'une machine.
public enum MachineAvailability: Equatable, Sendable {
    /// Ni adresse ni appairage : la machine n'existe pas pour l'app.
    case notConfigured
    /// Configurée, mais elle ne répond pas (ou ne répond pas pour la bonne machine).
    case unreachable
    case reachable
}

@MainActor
public protocol MachineSource: AnyObject {
    var machine: RepoMachine { get }
    var availability: MachineAvailability { get }
    /// Le dernier instantané du magasin de la machine (les features démarrées en lisent).
    var snapshot: StoreSnapshot? { get }
    /// L'ardoise de la machine, pour l'ardoise unifiée.
    var boardState: KanbanBoardState { get }
    /// Émet quand la disponibilité, l'instantané ou l'ardoise peuvent avoir changé.
    var changes: AnyPublisher<Void, Never> { get }
    func fetchRepos() async throws -> [RepoRow]
    var handoverEndpoint: any HandoverEndpoint { get }
}

/// Une machine jointe par un `ConsoleClientModel`.
@MainActor
public final class ClientMachineSource: MachineSource {
    public let model: ConsoleClientModel

    public init(_ model: ConsoleClientModel) {
        self.model = model
    }

    public var machine: RepoMachine { model.slot.machine }

    public var availability: MachineAvailability {
        switch model.pairing {
        case .unpaired, .restoring: return .notConfigured
        case .refused: return .unreachable
        case .paired: break
        }
        if case .connected = model.state { return .reachable }
        return .unreachable
    }

    public var snapshot: StoreSnapshot? { model.snapshot }
    public var boardState: KanbanBoardState { model.board }

    public var changes: AnyPublisher<Void, Never> {
        model.objectWillChange
            .receive(on: DispatchQueue.main)
            .map { _ in () }
            .eraseToAnyPublisher()
    }

    public func fetchRepos() async throws -> [RepoRow] {
        try await model.repos().rows
    }

    public var handoverEndpoint: any HandoverEndpoint { ClientHandoverEndpoint(model) }
}
