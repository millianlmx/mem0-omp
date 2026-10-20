// Le transport du SERVEUR DE PIPELINES : `URLSession`, en https (Tailscale ou un
// reverse proxy TLS), jeton en `Authorization: Bearer`. Distinct du transport du Mac :
// pas d'en-tête de version du protocole du Mac, pas d'appairage, une adresse
// complète au lieu d'un hôte et d'un port.

import Foundation

/// Un serveur configuré : son adresse de base et son jeton.
public struct HarnessServer: Equatable, Sendable {
    public var baseURL: URL
    public var token: String

    public init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
    }
}

/// Un appel : méthode, chemin (requête comprise), corps JSON éventuel.
public struct HarnessCall: Equatable, Sendable {
    public var method: String
    public var path: String
    public var body: Data?

    public init(method: String, path: String, body: Data? = nil) {
        self.method = method
        self.path = path
        self.body = body
    }
}

/// La réponse brute d'un appel, quel que soit son statut.
public struct HarnessReply: Equatable, Sendable {
    public var status: Int
    public var body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

/// Ce qui a empêché un échange avec le serveur — jamais un texte : les mots sont
/// ceux de `PipelineServerText`, dans le noyau partagé.
public enum HarnessFailure: Error, Equatable, Sendable {
    /// L'adresse saisie n'est pas une adresse http(s) complète.
    case invalidAddress
    /// Le serveur refuse le jeton.
    case unauthorized
    /// Le serveur ne répond pas.
    case unreachable
    /// Le serveur a mis trop longtemps à répondre.
    case timedOut
    /// Le serveur a refusé le geste ; son motif, tel qu'il l'a écrit.
    case rejected(String)
    /// Une réponse que cette version de l'app ne sait pas lire.
    case unreadable
}

/// La couture de transport du serveur de pipelines, doublée en test.
public protocol HarnessTransport: Sendable {
    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply
    /// Ouvre le flux d'événements et rend ses OCTETS bruts.
    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error>
}

/// Le transport de production.
public struct URLSessionHarnessTransport: HarnessTransport {
    private let session: URLSession
    private let streamSession: URLSession

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        let plain = configuration.copy() as! URLSessionConfiguration
        plain.urlCache = nil
        plain.requestCachePolicy = .reloadIgnoringLocalCacheData
        plain.timeoutIntervalForRequest = 15
        plain.timeoutIntervalForResource = 60
        session = URLSession(configuration: plain)

        let streaming = configuration.copy() as! URLSessionConfiguration
        streaming.urlCache = nil
        streaming.requestCachePolicy = .reloadIgnoringLocalCacheData
        // Le serveur envoie un battement toutes les 15 s.
        streaming.timeoutIntervalForRequest = 60
        streaming.timeoutIntervalForResource = 24 * 3600
        streamSession = URLSession(configuration: streaming)
    }

    public func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        let request = try Self.request(call, server: server, stream: false)
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw HarnessFailure.unreadable }
            return HarnessReply(status: http.statusCode, body: data)
        } catch let failure as HarnessFailure {
            throw failure
        } catch {
            throw Self.failure(of: error)
        }
    }

    public func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        let request = try Self.request(call, server: server, stream: true)
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await streamSession.bytes(for: request)
        } catch {
            throw Self.failure(of: error)
        }
        guard let http = response as? HTTPURLResponse else { throw HarnessFailure.unreadable }
        guard http.statusCode == 200 else {
            throw http.statusCode == 401 ? HarnessFailure.unauthorized : HarnessFailure.rejected("")
        }
        return AsyncThrowingStream { continuation in
            let task = Task {
                var buffer = Data()
                var previousWasNewline = false
                do {
                    for try await byte in bytes {
                        buffer.append(byte)
                        // Une trame complète (`\n\n`) part tout de suite, sans attendre d'autres octets.
                        let frameEnd = byte == 0x0A && previousWasNewline
                        previousWasNewline = byte == 0x0A
                        if frameEnd || buffer.count >= 4096 {
                            continuation.yield(buffer)
                            buffer.removeAll(keepingCapacity: true)
                        }
                    }
                    if !buffer.isEmpty { continuation.yield(buffer) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: HarnessFailure.unreachable)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// L'URL d'un appel : l'adresse du serveur PUIS le chemin (un préfixe de reverse
    /// proxy dans l'adresse est gardé, contrairement à une résolution relative).
    static func url(_ path: String, server: HarnessServer) -> URL? {
        var base = server.baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + path)
    }

    private static func request(_ call: HarnessCall, server: HarnessServer, stream: Bool) throws -> URLRequest {
        guard let target = Self.url(call.path, server: server) else { throw HarnessFailure.invalidAddress }
        var request = URLRequest(url: target)
        request.httpMethod = call.method
        request.setValue("Bearer \(server.token)", forHTTPHeaderField: "Authorization")
        request.setValue(stream ? "text/event-stream" : "application/json", forHTTPHeaderField: "Accept")
        if let body = call.body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private static func failure(of error: Error) -> HarnessFailure {
        if let urlError = error as? URLError, urlError.code == .timedOut { return .timedOut }
        return .unreachable
    }
}

/// Le lecteur du flux SSE du serveur : il ne rend que les NOMS des événements
/// complets — l'app relit la boîte au lieu de rejouer chaque événement.
public struct HarnessEventParser: Sendable {
    private var buffer = Data()

    public init() {}

    /// Ajoute des octets reçus ; rend les noms des événements complets, dans l'ordre.
    /// Un commentaire (`: ping`) n'est pas un événement.
    public mutating func consume(_ data: Data) -> [String] {
        buffer.append(data)
        var names: [String] = []
        let separator = Data("\n\n".utf8)
        while let range = buffer.range(of: separator) {
            let frame = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            guard let text = String(data: frame, encoding: .utf8) else { continue }
            var name: String?
            for line in text.split(separator: "\n") where line.hasPrefix("event:") {
                name = line.dropFirst("event:".count).trimmingCharacters(in: .whitespaces)
            }
            if let name, !name.isEmpty { names.append(name) }
        }
        return names
    }
}
