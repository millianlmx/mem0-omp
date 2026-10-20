// Le bloc « VPS » de la section « Dépôts » (S-6 de orchestrator-living-in-a-vps) :
// l'adresse Tailscale du VPS, le code d'appairage que `omp-orchestrator pair` affiche
// sur le VPS, « Oublier ce VPS » et l'état de la connexion. Le client est celui du
// slot `.vps` ; ce modèle ne fait que porter la saisie et traduire son état en un
// cas que la vue montre — la vue ne compose aucune phrase.

import Combine
import ConsoleClient
import ConsoleCore
import Foundation

/// Ce que le bloc dit de la connexion au VPS.
enum VpsBlockState: Equatable {
    /// Aucun appairage : la saisie de l'adresse et du code est offerte.
    case notPaired
    case connecting(address: String)
    case connected(address: String)
    /// Appairé mais muet : l'adresse est rappelée.
    case unreachable(address: String)
    case noNetwork
    /// L'adresse saisie est celle du Mac, pas celle du VPS.
    case wrongMachine(expected: RepoMachine, actual: RepoMachine)
    case incompatible(app: Int, vps: Int?)
    /// Le VPS a refusé ou révoqué cet appareil : il faut appairer de nouveau.
    case refused
}

@MainActor
final class VpsConnectionModel: ObservableObject {
    let client: ConsoleClientModel
    @Published var addressText: String
    @Published var codeText = ""
    @Published private(set) var pairingInFlight = false
    @Published private(set) var error: String?
    private var forwarding: AnyCancellable?

    init(client: ConsoleClientModel) {
        self.client = client
        addressText = client.manualAddress?.display ?? ""
        forwarding = client.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
    }

    /// Le cas affiché, lu des seuls faits du client.
    var state: VpsBlockState {
        let address = client.manualAddress?.display ?? ""
        switch client.pairing {
        case .unpaired, .restoring:
            return .notPaired
        case .refused:
            return .refused
        case .paired:
            break
        }
        switch client.state {
        case .unpaired: return .notPaired
        case .searching, .connecting: return .connecting(address: address)
        case .connected: return .connected(address: address)
        case .macAbsent: return .unreachable(address: address)
        case .noNetwork: return .noNetwork
        case .revoked: return .refused
        case .incompatibleProtocol(let local, let remote): return .incompatible(app: local, vps: remote)
        case .wrongMachine(let expected, let actual): return .wrongMachine(expected: expected, actual: actual)
        }
    }

    /// Les deux champs sont remplis et rien n'est en vol.
    var canPair: Bool {
        !pairingInFlight
            && !addressText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !codeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// « Appairer » : pose l'adresse puis envoie le code. Un échec laisse la saisie et
    /// dit sa cause ; un succès vide le code.
    func pair() async {
        guard canPair else { return }
        error = nil
        switch client.setManualAddress(addressText) {
        case .failure(let failure):
            error = ReposViewText.addressFailure(failure)
            return
        case .success:
            break
        }
        pairingInFlight = true
        defer { pairingInFlight = false }
        do {
            try await client.pair(code: codeText)
        } catch {
            self.error = ReposViewText.transport
            return
        }
        if let failure = client.pairingFailure {
            error = ReposViewText.pairingFailure(failure)
        } else {
            codeText = ""
        }
    }

    /// « Oublier ce VPS » : révoque au mieux, oublie le jeton puis l'adresse.
    func forget() async {
        await client.forget()
        client.clearManualAddress()
        addressText = ""
        codeText = ""
        error = nil
    }
}
