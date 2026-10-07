// L'état publié de la connexion iOS au Mac (S-10). Ce que le client ne peut pas
// distinguer se dit en UN SEUL état honnête : huit cas, aucun « inconnu ».
//
// `Equatable` : deux états de mêmes faits sont égaux (les tests de table de
// priorité comparent l'état rendu, jamais un libellé).

import Foundation

/// L'état observable du client distant.
public enum ClientState: Equatable, Sendable {
    /// Aucun jeton conservé : il faut appairer.
    case unpaired
    /// Aucun Mac résolu : la découverte est en cours.
    case searching
    /// Une tentative de connexion est en vol vers cet endpoint.
    case connecting(endpoint: ClientEndpoint)
    /// Le flux temps réel est ouvert vers cet endpoint.
    case connected(endpoint: ClientEndpoint)
    /// Le chemin réseau est insatisfait (mode avion, aucun réseau) — quel que soit
    /// le jeton conservé.
    case noNetwork
    /// Endpoint connu, dernier échec de transport : refus, hôte muet, délai
    /// dépassé ou fermeture silencieuse. Cause indistinguable par construction.
    case macAbsent(endpoint: ClientEndpoint)
    /// Le Mac a révoqué l'appareil : le secret est effacé, un code frais est requis.
    case revoked
    /// La version d'API du Mac n'est pas celle de l'app : aucun échange autorisé.
    case incompatibleProtocol(local: Int, remote: Int?)

    /// L'endpoint nommé par l'état, quand il en porte un.
    public var endpoint: ClientEndpoint? {
        switch self {
        case .connecting(let endpoint), .connected(let endpoint), .macAbsent(let endpoint):
            return endpoint
        case .unpaired, .searching, .noNetwork, .revoked, .incompatibleProtocol:
            return nil
        }
    }
}
