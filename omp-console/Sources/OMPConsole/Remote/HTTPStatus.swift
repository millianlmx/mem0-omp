// La table de statuts de la feature : le seul endroit qui traduit un
// `ConsoleAPIError` en code HTTP, et le seul qui compose le corps d'erreur JSON
// `{"error":{"code":…,"message":…}}` (la clé `message` est OMISE quand le cas n'en
// porte pas — `unauthorized`).

import ConsoleCore
import Foundation

enum HTTPStatus {
    /// La table UNIQUE de S-1.
    static func of(_ error: ConsoleAPIError) -> Int {
        switch error {
        case .badRequest, .incompatibleProtocol: return 400
        case .unauthorized: return 401
        case .notFound: return 404
        case .conflict: return 409
        case .unavailable, .outdatedService: return 503
        case .server, .decoding: return 500
        }
    }

    static func reason(_ code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 202: return "Accepted"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 409: return "Conflict"
        case 413: return "Payload Too Large"
        case 500: return "Internal Server Error"
        case 503: return "Service Unavailable"
        default: return "Status"
        }
    }

    /// Le corps d'erreur : le code stable, le message quand il existe.
    static func body(for error: ConsoleAPIError) -> Data {
        let envelope = ErrorEnvelope(error: ErrorEnvelope.Inner(code: error.code, message: error.message))
        return (try? HTTPJSON.encoder.encode(envelope)) ?? Data(#"{"error":{"code":"server"}}"#.utf8)
    }

    struct ErrorEnvelope: Encodable, Equatable {
        struct Inner: Encodable, Equatable {
            var code: String
            var message: String?
        }
        var error: Inner
    }
}

/// L'encodeur partagé des réponses : clés triées, pour que deux réponses de même
/// contenu soient octet pour octet identiques (tests et comparaison de flux).
enum HTTPJSON {
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    static let decoder = JSONDecoder()

    static func encode<T: Encodable>(_ value: T) throws -> Data {
        try encoder.encode(value)
    }
}
