// Le SOCLE du contrat de l'API distante du console : la version du protocole et
// le type d'erreur à codes stables, et rien de plus.
//
// Les charges utiles des routes (requêtes, réponses, chemins) naîtront avec le
// serveur qui les sert — feature `api-distante-du-console`, segment 2. Les figer
// ici, sans serveur, figerait un contrat que personne n'exécute.
//
// Ce fichier est le POINT UNIQUE de la version du protocole : la coque macOS et
// la coque iOS (autre paquet) la lisent ici, jamais d'un second littéral.

/// Le socle du contrat de l'API distante du console.
public enum ConsoleAPI {
    /// La version du protocole de l'API distante du console (première version).
    public static let protocolVersion = 1
}

/// L'erreur d'une route de l'API distante : un code STABLE, un message lisible.
///
/// `code` ne change pas quand `message` change — c'est lui que le client teste.
/// `Equatable` compare le cas ET le message : deux erreurs de même cas et même
/// message sont égales.
public enum ConsoleAPIError: Error, Equatable, Sendable {
    case badRequest(String)
    case unauthorized
    case notFound(String)
    case conflict(String)
    case unavailable(String)
    case server(String)
    case decoding(String)

    /// Le code stable du contrat : jamais traduit, jamais reformulé.
    public var code: String {
        switch self {
        case .badRequest: return "bad_request"
        case .unauthorized: return "unauthorized"
        case .notFound: return "not_found"
        case .conflict: return "conflict"
        case .unavailable: return "unavailable"
        case .server: return "server"
        case .decoding: return "decoding"
        }
    }

    /// Le message lisible, quand le cas en porte un : `nil` pour `unauthorized`.
    public var message: String? {
        switch self {
        case .badRequest(let message),
             .notFound(let message),
             .conflict(let message),
             .unavailable(let message),
             .server(let message),
             .decoding(let message):
            return message
        case .unauthorized:
            return nil
        }
    }
}
