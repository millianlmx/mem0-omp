// Les erreurs du client : une cause de transport (injoignable, délai dépassé,
// connexion fermée), une erreur du contrat d'API (le code stable partagé), une
// erreur de décodage, et les verrous locaux.

import ConsoleCore
import Foundation

/// L'échec d'un échange HTTP tel que le client peut l'observer et le distinguer.
public enum ClientTransportFailure: Error, Equatable, Sendable {
    /// Connexion refusée, hôte introuvable, réseau coupé : le Mac est injoignable.
    case unreachable(String)
    /// Le délai de la requête a expiré (`URLError.timedOut`, -1001) : le Mac a
    /// été joint, ou l'est peut-être, mais n'a pas répondu à temps. Hors de la
    /// Mémoire, les surfaces le traitent exactement comme `.unreachable`.
    case timedOut(String)
    /// Connexion fermée par l'autre bout.
    case closed(String)

    /// Le message lisible, jamais une cause inventée.
    public var reason: String {
        switch self {
        case .unreachable(let reason), .timedOut(let reason), .closed(let reason): return reason
        }
    }
}

/// L'erreur d'une méthode du client.
public enum ClientError: Error, Equatable, Sendable {
    /// Aucun endpoint connu : aucune requête n'a été émise.
    case notConnected
    /// Verrou de version : aucune requête n'a été émise.
    case incompatibleProtocol(local: Int, remote: Int?)
    /// Échec de transport.
    case transport(ClientTransportFailure)
    /// Erreur du contrat d'API, reconstruite par son code stable.
    case api(ConsoleAPIError)
    /// Corps de réponse illisible, ou plus gros que la borne servie.
    case decoding(String)
}

/// L'échec d'un appairage : quatre causes, jamais un demi-appairage.
public enum ClientPairingFailure: Error, Equatable, Sendable {
    /// Le code n'a pas 8 caractères de l'alphabet (aucune requête émise).
    case malformedCode
    /// Code expiré, consommé ou verrouillé — indistinguables par construction.
    case refused
    /// Registre illisible côté Mac (503 `unavailable`).
    case unavailable(String)
    /// Échec de transport.
    case transport(ClientTransportFailure)
    /// Le Mac n'a pas la même version d'API.
    case incompatibleProtocol(local: Int, remote: Int?)
}
