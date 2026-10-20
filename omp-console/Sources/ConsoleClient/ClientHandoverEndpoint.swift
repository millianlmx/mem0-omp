// Les quatre gestes de bascule d'une machine JOINTE PAR LE CLIENT (S-5 de
// orchestrator-living-in-a-vps) : l'adaptateur de `ConsoleClientModel` au
// protocole `HandoverEndpoint` de ConsoleCore. Un refus du serveur devient
// `HandoverFailure` portant son MOTIF tel quel.

import ConsoleCore
import Foundation

public struct ClientHandoverEndpoint: HandoverEndpoint {
    private let model: ConsoleClientModel

    public init(_ model: ConsoleClientModel) {
        self.model = model
    }

    public func handover(repoKey: String, to: RepoMachine) async throws -> HandoverCharge {
        do { return try await model.handover(repoKey: repoKey, to: to) } catch { throw Self.failure(error) }
    }

    public func adopt(identity: String, features: [HandoverFeatureCharge]) async throws -> HandoverAdoption {
        do { return try await model.adopt(identity: identity, features: features) } catch { throw Self.failure(error) }
    }

    public func commit(repoKey: String, handoverId: String, slugs: [String]) async throws {
        do { _ = try await model.commitHandover(repoKey: repoKey, id: handoverId, slugs: slugs) } catch { throw Self.failure(error) }
    }

    public func cancel(repoKey: String, handoverId: String) async throws {
        do { _ = try await model.cancelHandover(repoKey: repoKey, id: handoverId) } catch { throw Self.failure(error) }
    }

    /// Le motif du serveur quand il y en a un ; sinon une phrase sur la panne.
    static func failure(_ error: Error) -> HandoverFailure {
        guard let error = error as? ClientError else { return HandoverFailure(String(describing: error)) }
        switch error {
        case .api(let api): return HandoverFailure(api.message ?? api.code)
        case .notConnected: return HandoverFailure("machine injoignable")
        case .transport: return HandoverFailure("machine injoignable")
        case .incompatibleProtocol(let local, let remote):
            return HandoverFailure(ReposText.incompatibleVersion(app: local, vps: remote))
        case .decoding(let message): return HandoverFailure(message)
        case .unexpectedStatus(let status): return HandoverFailure("statut \(status)")
        }
    }
}
