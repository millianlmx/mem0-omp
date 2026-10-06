// Le SOCLE du contrat de l'API distante du console : la version du protocole, les
// constantes de SERVICE (port, type Bonjour, en-tête de version, réglages du code
// d'appairage) et le type d'erreur à codes stables. Rien de plus : les charges
// utiles des routes (requêtes, réponses) vivent dans la coque qui les sert
// (`Sources/OMPConsole/Remote/Payloads.swift`), pas ici — figer un contrat que
// personne n'exécute n'a pas de valeur.
//
// Ce fichier est le POINT UNIQUE de la version du protocole : la coque macOS et
// la coque iOS (autre paquet) la lisent ici, jamais d'un second littéral.

/// Le socle du contrat de l'API distante du console.
public enum ConsoleAPI {
    /// La version du protocole de l'API distante du console (première version).
    public static let protocolVersion = 1

    /// Les constantes de SERVICE : ce que le serveur annonce et ce que le client
    /// doit connaître pour le joindre — partagées macOS/iOS, jamais dupliquées.
    public enum Service {
        /// Le port d'écoute par défaut (injectable : `0` = port éphémère, tests).
        public static let defaultPort = 8787
        /// La base de tous les chemins servis.
        public static let basePath = "/v1"
        /// Le type de service Bonjour (annoncé et cherché).
        public static let bonjourType = "_ompconsole._tcp"
        /// Le nom d'instance Bonjour proposé (Bonjour le renomme en cas de conflit).
        public static let bonjourName = "OMP Console"
        /// L'en-tête qui porte la version du protocole, requête comme réponse.
        public static let protocolHeader = "X-Console-Protocol-Version"
        /// La longueur du code d'appairage, en caractères.
        public static let pairingCodeLength = 8
        /// L'alphabet du code d'appairage : Crockford base32, sans `I` `L` `O` `U`
        /// (confusion avec `1` `1` `0` `V`), 32 symboles.
        public static let pairingCodeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        /// La durée de vie d'un code d'appairage, en secondes.
        public static let pairingCodeTTLSeconds = 120
        /// Le nombre d'échecs tolérés avant verrouillage du code actif.
        public static let pairingAttemptLimit = 5
    }
}

/// L'erreur d'une route de l'API distante : un code STABLE, un message lisible.
///
/// `code` ne change pas quand `message` change — c'est lui que le client teste.
/// `Equatable` compare le cas ET le message : deux erreurs de même cas et même
/// message sont égales.
public enum ConsoleAPIError: Error, Equatable, Sendable {
    case badRequest(String)
    case unauthorized
    /// La version de protocole présentée n'est pas celle du socle : refus par le
    /// code PARTAGÉ, sans servir de données (la seule extension de ce socle faite
    /// par la feature `api-distante-du-console`).
    case incompatibleProtocol(String)
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
        case .incompatibleProtocol: return "incompatible_protocol"
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
             .incompatibleProtocol(let message),
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
