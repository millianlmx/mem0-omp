// Le Mac vu comme une machine de la section « Dépôts » (S-6 de
// orchestrator-living-in-a-vps) : ses dépôts, son magasin et son ardoise viennent
// des modèles de la coque, ses gestes de bascule du service local — par les MÊMES
// gestes typés de `RemoteActions` que les routes distantes servent à l'iPhone. Rien
// ne passe par le réseau : le Mac s'appelle lui-même.

import Combine
import ConsoleClient
import ConsoleCore
import Foundation

/// Les quatre gestes de bascule du Mac. Un refus devient `HandoverFailure` portant
/// son MOTIF tel que le service l'a donné (le VPS les sert avec les mêmes).
struct ServiceHandoverEndpoint: HandoverEndpoint {
    let actions: RemoteActions

    func handover(repoKey: String, to: RepoMachine) async throws -> HandoverCharge {
        do { return try await actions.handover(repoKey: repoKey, to: to.rawValue) } catch { throw Self.failure(error) }
    }

    func adopt(identity: String, features: [HandoverFeatureCharge]) async throws -> HandoverAdoption {
        do {
            let encoded = try JSONEncoder().encode(features)
            let list = JSONValue.parse(encoded)?.arrayValue ?? []
            return try await actions.adopt(identity: identity, features: list)
        } catch { throw Self.failure(error) }
    }

    func commit(repoKey: String, handoverId: String, slugs: [String]) async throws {
        do { _ = try await actions.commitHandover(repoKey: repoKey, id: handoverId, slugs: slugs) } catch { throw Self.failure(error) }
    }

    func cancel(repoKey: String, handoverId: String) async throws {
        do { try await actions.cancelHandover(repoKey: repoKey, id: handoverId) } catch { throw Self.failure(error) }
    }

    private static func failure(_ error: Error) -> HandoverFailure {
        if let refusal = error as? GestureRefusal { return HandoverFailure(refusal.apiError.message ?? refusal.apiError.code) }
        return HandoverFailure(String(describing: error))
    }
}

@MainActor
final class LocalMacSource: MachineSource {
    private let actions: RemoteActions
    private let hub: StoreHub
    private let kanban: KanbanModel

    init(actions: RemoteActions, hub: StoreHub, kanban: KanbanModel) {
        self.actions = actions
        self.hub = hub
        self.kanban = kanban
    }

    var machine: RepoMachine { .mac }

    /// Le Mac est la machine qui fait tourner l'app : il répond toujours.
    var availability: MachineAvailability { .reachable }

    var snapshot: StoreSnapshot? { hub.current() }

    var boardState: KanbanBoardState { kanban.state }

    var changes: AnyPublisher<Void, Never> {
        kanban.$state
            .receive(on: DispatchQueue.main)
            .map { _ in () }
            .eraseToAnyPublisher()
    }

    func fetchRepos() async throws -> [RepoRow] {
        await actions.repoRows()
    }

    var handoverEndpoint: any HandoverEndpoint { ServiceHandoverEndpoint(actions: actions) }
}
