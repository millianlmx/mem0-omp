// Ce que l'intent témoin énonce de l'état du client partagé (feature
// client-ios-possede-par-la-vue, S-3) : une table PURE du statut d'appairage et de
// l'état du client, plus l'attente de la relecture du jeton. Aucune requête,
// aucun appairage, aucune connexion de plus que celles du client lui-même. Les
// mots vivent dans `IOSSiriText`.

import ConsoleClient
import Foundation

enum IOSSiriStatus: Equatable, Sendable {
    /// Aucun jeton, ou jeton refusé par le Mac.
    case unpaired
    /// Un jeton est détenu, mais le flux vers le Mac n'est pas ouvert (recherche,
    /// connexion en cours, Mac injoignable, hors réseau, version incompatible).
    case pairedNotJoined
    /// Le flux temps réel est ouvert vers le Mac nommé.
    case connected(macName: String)

    /// La table exhaustive de S-3. `.restoring` n'est pas atteignable après
    /// `awaitPairingRestored()` ; il vaut « non appairé », jamais une attente.
    static func resolve(pairing: ClientPairingStatus, state: ClientState) -> IOSSiriStatus {
        switch pairing {
        case .unpaired, .refused, .restoring:
            return .unpaired
        case .paired:
            switch state {
            case .connected(let endpoint):
                return .connected(macName: macName(endpoint))
            case .unpaired, .searching, .connecting, .noNetwork, .macAbsent, .revoked, .incompatibleProtocol:
                return .pairedNotJoined
            }
        }
    }

    /// Le nom énoncé d'un Mac : le nom d'instance Bonjour ; `endpoint.address`
    /// (`hôte:port`, sans zone) pour une adresse manuelle ou un nom Bonjour blanc.
    /// Jamais `endpoint.display`, qui accole le nom et l'adresse.
    static func macName(_ endpoint: ClientEndpoint) -> String {
        switch endpoint {
        case .bonjour(let name, _, _):
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? endpoint.address : trimmed
        case .manual:
            return endpoint.address
        }
    }

    /// La phrase énoncée.
    var phrase: String {
        switch self {
        case .unpaired:
            return IOSSiriText.unpaired
        case .pairedNotJoined:
            return IOSSiriText.pairedNotJoined
        case .connected(let macName):
            return IOSSiriText.connected(macName: macName)
        }
    }

    /// Démarre le client s'il ne tourne pas, attend la fin de la relecture du
    /// jeton (jamais la découverte ni la connexion), puis énonce l'état publié à
    /// cet instant. Ne lève jamais.
    @MainActor
    static func answer(for client: ConsoleClientModel) async -> String {
        let pairing = await client.awaitPairingRestored()
        return resolve(pairing: pairing, state: client.state).phrase
    }
}
