// La couture de transport : tout le réseau du client passe par ces deux méthodes,
// doublées en test. Aucun appel direct à `URLSession` hors de
// `URLSessionTransport`.

import Foundation

/// Le profil d'une requête : il choisit la session du transport, donc ses délais
/// et sa borne de corps. `.memory` sert les lectures Mémoire lentes (page de
/// liste, graphe) ; tout le reste est `.standard`.
public enum ClientRequestProfile: Equatable, Sendable {
    case standard
    case memory
}

/// Une requête du client : la méthode, le chemin AVEC sa chaîne de requête, le
/// corps JSON éventuel, le fait qu'elle ouvre un flux SSE, et son profil.
public struct ClientHTTPRequest: Equatable, Sendable {
    public var method: String
    public var path: String
    public var body: Data?
    public var isStream: Bool
    public var profile: ClientRequestProfile

    public init(
        method: String,
        path: String,
        body: Data? = nil,
        isStream: Bool = false,
        profile: ClientRequestProfile = .standard
    ) {
        self.method = method
        self.path = path
        self.body = body
        self.isStream = isStream
        self.profile = profile
    }
}

/// Une réponse HTTP complète : le statut, la version d'API annoncée par le Mac
/// (`nil` si l'en-tête est absent), le corps.
public struct ClientHTTPResponse: Equatable, Sendable {
    public var status: Int
    public var protocolVersion: Int?
    public var body: Data

    public init(status: Int, protocolVersion: Int?, body: Data) {
        self.status = status
        self.protocolVersion = protocolVersion
        self.body = body
    }
}

/// Le transport d'une requête et d'un flux. Les échecs de transport sont des
/// `ClientError` (`.transport(…)`, `.decoding(…)`) — jamais un statut HTTP, qui
/// reste dans la réponse.
public protocol ClientTransport: Sendable {
    /// Envoie une requête et rend la réponse, quel que soit son statut.
    func send(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) async throws -> ClientHTTPResponse

    /// Ouvre un flux SSE et rend ses OCTETS bruts (jamais des lignes).
    func stream(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) async throws -> AsyncThrowingStream<Data, Error>
}
