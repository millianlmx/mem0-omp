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

/// La cause d'un « non connecté », chacune avec sa phrase
/// (`IOSConnectionStateText.cause(_:)`).
enum IOSDisconnectCause: Equatable, Sendable {
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
}

enum IOSConnectionStatus: Equatable, Sendable {
    case connected
    case connecting
    case disconnected(IOSDisconnectCause)

    /// La table exhaustive de S-1.
    static func resolve(_ state: ClientState, attemptFollowsFailure: Bool) -> IOSConnectionStatus {
        switch state {
        case .connected:
            return .connected
        case .connecting, .searching:
            return attemptFollowsFailure ? .disconnected(.unreachable) : .connecting
        case .macAbsent, .noNetwork:
            return .disconnected(.unreachable)
        case .unpaired:
            return .disconnected(.unpaired)
        case .revoked:
            return .disconnected(.refused)
        case .incompatibleProtocol(let local, let remote):
            if let remote, remote > local { return .disconnected(.updateApp) }
            return .disconnected(.updateMac)
        }
    }

    /// Le statut présenté du client partagé.
    @MainActor
    static func of(_ client: ConsoleClientModel) -> IOSConnectionStatus {
        resolve(client.state, attemptFollowsFailure: client.attemptFollowsFailure)
    }

    /// Les gestes qui exigent le Mac ne sont tapables qu'une fois connecté.
    var gesturesEnabled: Bool {
        self == .connected
    }
}
