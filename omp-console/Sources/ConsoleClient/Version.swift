// La traduction HTTP → erreur du client (S-1, S-8). La vérification de VERSION
// précède tout décodage de corps : une réponse d'une autre version d'API est un
// verrou, jamais une erreur de requête.

import ConsoleCore
import Foundation

/// La borne de corps servie, miroir de `RemoteLimits.responseBody` : un corps plus
/// gros est refusé en `decoding`, jamais tronqué silencieusement.
public enum ClientLimits {
    public static let responseBody = 2 * 1024 * 1024
}

/// La table unique de traduction d'une réponse en erreur du client.
public enum ClientErrorMapping {
    /// Le corps d'erreur du contrat : `{"error":{"code":…,"message":…}}`.
    struct ErrorEnvelope: Decodable {
        struct Inner: Decodable {
            var code: String
            var message: String?
        }
        var error: Inner
    }

    /// Traduit une réponse NON 2xx. `protocolVersion` vient de l'en-tête de réponse
    /// (`nil` s'il est absent : c'est un verrou, contrat S-8).
    public static func translate(
        status: Int,
        protocolVersion: Int?,
        body: Data,
        localVersion: Int = ConsoleAPI.protocolVersion
    ) -> ClientError {
        if protocolVersion != localVersion {
            return .incompatibleProtocol(local: localVersion, remote: protocolVersion)
        }
        guard let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: body) else {
            return .decoding("corps d'erreur illisible (statut \(status))")
        }
        let code = envelope.error.code
        let message = envelope.error.message ?? ""
        switch code {
        case "incompatible_protocol":
            return .incompatibleProtocol(local: localVersion, remote: protocolVersion)
        case "bad_request": return .api(.badRequest(message))
        case "unauthorized": return .api(.unauthorized)
        case "not_found": return .api(.notFound(message))
        case "conflict": return .api(.conflict(message))
        case "unavailable": return .api(.unavailable(message))
        case "server": return .api(.server(message))
        case "decoding": return .api(.decoding(message))
        default:
            switch status {
            case 400: return .api(.badRequest(message))
            case 401: return .api(.unauthorized)
            case 404: return .api(.notFound(message))
            case 409: return .api(.conflict(message))
            case 503: return .api(.unavailable(message))
            default: return .api(.server(message.isEmpty ? "statut \(status)" : message))
            }
        }
    }
}
