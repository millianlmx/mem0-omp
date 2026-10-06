// L'état publié du service d'API distante (S-1). Il nomme les cinq situations que
// la feuille d'appairage affiche, et rien d'autre : les textes exacts vivent dans
// `PairingText` (BR-9).

import Foundation

enum RemoteServiceState: Equatable, Sendable {
    /// L'interrupteur est coupé, ou le service n'a pas encore démarré.
    case off
    /// Le listener écoute mais n'est pas encore `.ready`.
    case starting
    /// Le service répond : `address` est l'adresse d'écoute affichable
    /// (`192.168.1.12:8787`).
    case running(address: String)
    /// Le privilège de réseau local est refusé (Doc-2) : Bonjour en
    /// `kDNSServiceErr_PolicyDenied`, ou chemin `localNetworkDenied`.
    case denied(reason: String)
    /// Port occupé ou autre échec du listener : `reason` porte la cause.
    case failed(reason: String)

    var isRunning: Bool {
        if case .running = self { return true }
        return false
    }

    var isDenied: Bool {
        if case .denied = self { return true }
        return false
    }
}
