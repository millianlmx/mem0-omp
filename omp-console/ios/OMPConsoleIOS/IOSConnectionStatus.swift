// Le statut de connexion PRÉSENTÉ par l'app iOS (feature
// etats-non-connecte-heterogenes-ios, S-1) : une fonction PURE de l'état du client
// et du fait `attemptFollowsFailure`, lue par les sept sections pour choisir entre
// leurs données, le composant « connexion en cours » et le composant « non
// connecté » avec sa cause.
//
// Une tentative fraîche (lancement, « Réessayer », Mac découvert…) se montre
// « connexion en cours » ; dès qu'une tentative a échoué, l'écran dit « non
// connecté » et le reste pendant les relances automatiques, jusqu'à la connexion
// ou à une autre cause (décision utilisateur du 2026-10-10).

import ConsoleClient
import ConsoleCore

/// La cause d'un « non connecté », chacune avec sa phrase
/// (`IOSConnectionStateText.cause(_:)`).
indirect enum IOSDisconnectCause: Equatable, Sendable {
    /// Aucun appairage sur cet appareil.
    case unpaired
    /// Le Mac a refusé ou révoqué l'appairage.
    case refused
    /// Le Mac ne répond pas (Mac éteint, app fermée, autre réseau, hors réseau).
    case unreachable
    /// Le Mac parle une version d'API plus récente : mettre à jour l'app.
    case updateApp
    /// Le Mac parle une version d'API plus ancienne : mettre à jour le Mac.
    case updateMac
    /// L'adresse saisie est celle de l'autre machine (S-10 de
    /// orchestrator-living-in-a-vps) : aucun geste n'est émis.
    case wrongMachine(expected: RepoMachine, actual: RepoMachine)
    /// La même cause, mais pour le slot VPS : la phrase parle du VPS, pas du Mac.
    case onVps(IOSDisconnectCause)
}

enum IOSConnectionStatus: Equatable, Sendable {
    case connected
    case connecting
    case disconnected(IOSDisconnectCause)

    /// La table exhaustive de S-1. `machine` est la machine du slot du client : la
    /// cause d'un slot VPS est enveloppée (`.onVps`) pour parler du VPS.
    static func resolve(
        _ state: ClientState,
        attemptFollowsFailure: Bool,
        machine: RepoMachine = .mac
    ) -> IOSConnectionStatus {
        func disconnected(_ cause: IOSDisconnectCause) -> IOSConnectionStatus {
            .disconnected(machine == .vps ? .onVps(cause) : cause)
        }
        switch state {
        case .connected:
            return .connected
        case .connecting, .searching:
            return attemptFollowsFailure ? disconnected(.unreachable) : .connecting
        case .macAbsent, .noNetwork:
            return disconnected(.unreachable)
        case .unpaired:
            return disconnected(.unpaired)
        case .revoked:
            return disconnected(.refused)
        case .incompatibleProtocol(let local, let remote):
            if let remote, remote > local { return disconnected(.updateApp) }
            return disconnected(.updateMac)
        case .wrongMachine(let expected, let actual):
            return .disconnected(.wrongMachine(expected: expected, actual: actual))
        }
    }

    /// Le statut présenté du client partagé.
    @MainActor
    static func of(_ client: ConsoleClientModel) -> IOSConnectionStatus {
        resolve(client.state, attemptFollowsFailure: client.attemptFollowsFailure, machine: client.slot.machine)
    }

    /// Le statut présenté quand l'app tient deux clients (Accueil, Pipelines) : connecté
    /// dès qu'UNE machine l'est — l'ardoise unifiée a de quoi s'afficher —, sinon le
    /// statut de la machine qui répond aux écrans (`activeClient`). Sans VPS configuré,
    /// celui du Mac, tel quel.
    @MainActor
    static func of(_ clients: MachineClients) -> IOSConnectionStatus {
        guard clients.vpsConfigured else { return of(clients.mac) }
        if of(clients.mac) == .connected || of(clients.vps) == .connected { return .connected }
        return of(clients.activeClient)
    }

    /// Les gestes qui exigent le Mac ne sont tapables qu'une fois connecté.
    var gesturesEnabled: Bool {
        self == .connected
    }
}
