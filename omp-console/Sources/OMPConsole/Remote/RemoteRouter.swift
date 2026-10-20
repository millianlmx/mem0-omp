// La table de routes de l'API (S-1 … S-15) : UN point de résolution, UN point de
// réponse. Le routeur applique d'abord les gardes (version puis jeton), puis
// résout (méthode, chemin) — une route inconnue est un `404`, jamais un `501`.
//
// L'API du Mac ne sert plus que l'appairage, les appareils, les composants et la
// mémoire du projet : les pipelines sont servies par le serveur du VPS, que
// l'iPhone joint directement.

import ConsoleCore
import Foundation

@MainActor
final class RemoteRouter {
    private let reads: RemoteReads
    private let registry: DeviceRegistry
    private let streams: RemoteStreamHub?

    init(reads: RemoteReads, registry: DeviceRegistry, streams: RemoteStreamHub?) {
        self.reads = reads
        self.registry = registry
        self.streams = streams
    }

    // MARK: - Table

    /// Interne (et non privé) à seule fin d'être CONFRONTABLE au catalogue du
    /// client (`ConsoleClient.ClientRoute.all`) : méthode et chemin mis à part,
    /// les deux listes doivent être l'image l'une de l'autre.
    enum Segment: Equatable {
        case literal(String)
        case parameter(String)
    }

    struct Route {
        let method: String
        let segments: [Segment]
        let name: String

        /// Le gabarit de chemin, forme `{param}` — la forme comparée au client.
        var path: String {
            "/" + segments.map { segment in
                switch segment {
                case .literal(let value): return value
                case .parameter(let name): return "{\(name)}"
                }
            }.joined(separator: "/")
        }

        static func of(_ method: String, _ path: String, _ name: String) -> Route {
            let segments = path.split(separator: "/").map { part -> Segment in
                part.hasPrefix(":") ? .parameter(String(part.dropFirst())) : .literal(String(part))
            }
            return Route(method: method, segments: segments, name: name)
        }
    }

    /// L'ORDRE n'a pas d'importance (les motifs sont disjoints) ; c'est la seule
    /// liste des routes servies.
    static let routes: [Route] = [
        .of("GET", "v1/version", "version"),
        .of("GET", "v1/devices", "devices"),
        .of("GET", "v1/components", "components"),
        .of("GET", "v1/memory/page", "memory.page"),
        .of("GET", "v1/memory/search", "memory.search"),
        .of("GET", "v1/memory/graph", "memory.graph"),
        .of("GET", "v1/stream", "stream"),
        .of("POST", "v1/pair", "pair"),
        .of("DELETE", "v1/devices/self", "devices.forget"),
    ]

    // MARK: - Entrée

    func handle(_ request: HTTPRequest, connection: RemoteConnectionHandle) async -> RemoteHandlerOutcome {
        switch RemoteGuard.evaluate(request, registry: registry) {
        case .refused(let error):
            return respond(error)
        case .allowed(let device):
            if let device { registry.touch(id: device.id, at: registry.clock.nowMs()) }
            return await dispatch(request, device: device, connection: connection)
        }
    }

    private func dispatch(
        _ request: HTTPRequest,
        device: DeviceRecord?,
        connection: RemoteConnectionHandle
    ) async -> RemoteHandlerOutcome {
        guard let (route, parameters) = Self.resolve(request) else {
            return respond(.notFound("route inconnue"))
        }
        do {
            return try await run(route.name, parameters: parameters, request: request, device: device, connection: connection)
        } catch let error as ConsoleAPIError {
            return respond(error)
        } catch let error as RemoteServiceFailure {
            return respond(.unavailable(error.reason))
        } catch {
            return respond(.server("erreur inattendue"))
        }
    }

    private static func resolve(_ request: HTTPRequest) -> (Route, [String: String])? {
        let segments = request.segments
        for route in routes where route.method == request.method && route.segments.count == segments.count {
            var parameters: [String: String] = [:]
            var matched = true
            for (pattern, value) in zip(route.segments, segments) {
                switch pattern {
                case .literal(let literal) where literal != value:
                    matched = false
                case .parameter(let name):
                    parameters[name] = value
                default:
                    break
                }
                if !matched { break }
            }
            if matched { return (route, parameters) }
        }
        return nil
    }

    private func run(
        _ name: String,
        parameters: [String: String],
        request: HTTPRequest,
        device: DeviceRecord?,
        connection: RemoteConnectionHandle
    ) async throws -> RemoteHandlerOutcome {
        switch name {
        // --- socle et lectures ------------------------------------------------
        case "version":
            return try json(reads.version())
        case "devices":
            return try json(reads.devices())
        case "components":
            return try json(reads.components())
        case "memory.page":
            return try json(await reads.memoryPage(
                scope: request.query["scope"],
                offset: request.query["offset"],
                limit: request.query["limit"]
            ))
        case "memory.search":
            return try json(await reads.memorySearch(
                query: request.query["q"],
                scope: request.query["scope"],
                limit: request.query["limit"]
            ))
        case "memory.graph":
            return try json(await reads.memoryGraph(scope: request.query["scope"]))

        // --- flux -------------------------------------------------------------
        case "stream":
            guard let device, let streams else {
                return respond(.badRequest("flux indisponible"))
            }
            let subscription = streams.subscribe(deviceId: device.id, connection: connection)
            return .stream(subscription)

        // --- appairage --------------------------------------------------------
        case "pair":
            return try await pair(request)

        // --- oubli de l'appareil porteur du jeton ---------------------------
        // Route authentifiée : le garde a déjà refusé (401) un jeton absent,
        // inconnu ou révoqué. Seul l'appareil du jeton est révoqué, par la
        // révocation EXISTANTE du registre (jeton, fichier, trousseau, flux).
        case "devices.forget":
            guard let device else { return respond(.unauthorized) }
            await registry.revoke(id: device.id)
            return try json(RemoteAcceptedPayload(accepted: true))

        default:
            return respond(.notFound("route inconnue"))
        }
    }

    // MARK: - Appairage

    private func pair(_ request: HTTPRequest) async throws -> RemoteHandlerOutcome {
        let body = try RemoteBody.decode(RemotePairRequest.self, from: request)
        // Le code s'affiche groupé `XXXX-XXXX` : tiret, blancs et casse ne comptent pas.
        let code = PairingCodeFormat.normalize(body.code)
        guard PairingCodeFormat.isWellFormed(code) else {
            throw ConsoleAPIError.badRequest("code d'appairage mal formé")
        }
        let name = body.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 64 else {
            throw ConsoleAPIError.badRequest("nom d'appareil invalide")
        }
        var deviceKey: String?
        if let presented = body.deviceKey {
            let trimmed = presented.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed.count <= 64 else {
                throw ConsoleAPIError.badRequest("identifiant d'appareil invalide")
            }
            deviceKey = trimmed
        }
        let paired = try await registry.pair(code: code, name: name, deviceKey: deviceKey)
        return try json(RemotePairPayload(
            deviceId: paired.device.id.uuidString.lowercased(),
            token: paired.token,
            protocolVersion: ConsoleAPI.protocolVersion
        ))
    }

    // MARK: - Réponses

    private func respond(_ error: ConsoleAPIError) -> RemoteHandlerOutcome {
        .respond(HTTPResponse.error(error))
    }

    private func json(_ value: some Encodable, code: Int = 200) throws -> RemoteHandlerOutcome {
        do {
            return .respond(.json(code: code, payload: try HTTPJSON.encode(value)))
        } catch {
            throw ConsoleAPIError.decoding("charge utile non encodable")
        }
    }
}
