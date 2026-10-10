// La table de routes de l'API (S-1 … S-15) : UN point de résolution, UN point de
// réponse. Le routeur applique d'abord les gardes (version puis jeton), puis
// résout (méthode, chemin) — une route inconnue est un `404`, jamais un `501`.
//
// Les gestes ne passent JAMAIS par une seconde voie d'écriture : ils appellent les
// méthodes publiques de `ActionsModel`, `ProjectConsoleModel` et
// `SessionConsoleModel` (BR-7), et rien d'autre.

import ConsoleCore
import Foundation

@MainActor
final class RemoteRouter {
    private let reads: RemoteReads
    private let registry: DeviceRegistry
    private let actions: RemoteActions
    private let streams: RemoteStreamHub?

    init(reads: RemoteReads, registry: DeviceRegistry, actions: RemoteActions, streams: RemoteStreamHub?) {
        self.reads = reads
        self.registry = registry
        self.actions = actions
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
        .of("GET", "v1/store", "store"),
        .of("GET", "v1/sessions", "sessions"),
        .of("GET", "v1/sessions/:id", "session.file"),
        .of("GET", "v1/projects", "projects"),
        .of("GET", "v1/projects/:repoKey/documents", "documents"),
        .of("GET", "v1/stats", "stats"),
        .of("GET", "v1/devices", "devices"),
        .of("GET", "v1/models", "models"),
        .of("GET", "v1/components", "components"),
        .of("GET", "v1/journal", "journal"),
        .of("GET", "v1/cards/:id/contract", "card.contract"),
        .of("GET", "v1/memory", "memory"),
        .of("GET", "v1/memory/search", "memory.search"),
        .of("GET", "v1/memory/graph", "memory.graph"),
        .of("GET", "v1/stream", "stream"),
        .of("GET", "v1/repos", "repos"),
        .of("GET", "v1/conduite", "conduite.get"),
        .of("POST", "v1/pair", "pair"),
        .of("DELETE", "v1/devices/self", "devices.forget"),
        .of("POST", "v1/cards/:id/answer", "card.answer"),
        .of("POST", "v1/cards/:id/reply", "card.reply"),
        .of("POST", "v1/cards/:id/text", "card.text"),
        .of("POST", "v1/cards/:id/verdict", "card.verdict"),
        .of("POST", "v1/cards/:id/resume", "card.resume"),
        .of("POST", "v1/cards/:id/stop", "card.stop"),
        .of("POST", "v1/features", "feature.launch"),
        .of("POST", "v1/conduite/dialogs/:id", "conduite.dialog"),
        .of("POST", "v1/projects/:repoKey/conduite", "conduite.start"),
        .of("DELETE", "v1/projects/:repoKey/conduite", "conduite.close"),
        .of("GET", "v1/session", "hosted.get"),
        .of("POST", "v1/session/prompt", "hosted.prompt"),
        .of("POST", "v1/session/launch", "hosted.launch"),
        .of("POST", "v1/session/relaunch", "hosted.relaunch"),
        .of("POST", "v1/session/stop", "hosted.stop"),
        .of("POST", "v1/session/dialogs/:id", "hosted.dialog"),
        .of("GET", "v1/projects/:repoKey/pull-requests", "prs"),
        .of("POST", "v1/projects/:repoKey/pull-requests/:slug/merge", "prs.merge"),
        .of("POST", "v1/pull-request-states/refresh", "prStates.refresh"),
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
        case "store":
            return try json(reads.store())
        case "sessions":
            return try json(reads.sessions())
        case "session.file":
            return try json(reads.session(parameters["id"] ?? ""))
        case "projects":
            return try json(reads.projects())
        case "documents":
            return try json(reads.documents(repoKey: parameters["repoKey"] ?? ""))
        case "stats":
            return try json(reads.statistics(project: request.query["project"]))
        case "devices":
            return try json(reads.devices())
        case "models":
            return try json(await reads.models())
        case "repos":
            return try json(RemoteReposPayload(rows: actions.knownRepos()))
        case "conduite.get":
            return try json(actions.conduite())
        case "components":
            return try json(reads.components())
        case "journal":
            return try json(reads.journal())
        case "card.contract":
            return try json(try reads.cardContract(cardId: parameters["id"] ?? ""))
        case "memory":
            return try json(await reads.memory(scope: request.query["scope"], limit: request.query["limit"]))
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

        // --- gestes de carte --------------------------------------------------
        case "card.answer":
            return try json(try await actions.answer(cardId: parameters["id"] ?? "", body: request.body), code: 202)
        case "card.reply":
            return try json(try await actions.reply(cardId: parameters["id"] ?? "", body: request.body), code: 202)
        case "card.text":
            return try json(try await actions.text(cardId: parameters["id"] ?? "", body: request.body), code: 202)
        case "card.verdict":
            return try json(try await actions.verdict(cardId: parameters["id"] ?? "", body: request.body), code: 202)
        case "card.resume":
            return try json(try await actions.resume(cardId: parameters["id"] ?? ""), code: 202)
        case "card.stop":
            return try json(try await actions.stop(cardId: parameters["id"] ?? ""), code: 202)

        // --- feature, projet, session hébergée, PR ----------------------------
        case "feature.launch":
            return try json(try await actions.launch(body: request.body), code: 202)
        case "conduite.start":
            return try json(try await actions.startConduite(repoKey: parameters["repoKey"] ?? "", body: request.body))
        case "conduite.close":
            return try json(try await actions.closeConduite(repoKey: parameters["repoKey"] ?? ""))
        case "conduite.dialog":
            return try json(try await actions.answerDialog(id: parameters["id"] ?? "", body: request.body), code: 202)
        case "hosted.get":
            return try json(actions.hostedSession())
        case "hosted.prompt":
            return try json(try await actions.prompt(body: request.body))
        case "hosted.launch":
            return try json(try await actions.launchHostedSession(body: request.body))
        case "hosted.relaunch":
            return try json(try await actions.relaunchHostedSession())
        case "hosted.stop":
            return try json(try await actions.stopHostedSession())
        case "hosted.dialog":
            return try json(try await actions.answerHostedDialog(id: parameters["id"] ?? "", body: request.body))
        case "prs":
            return try json(try await actions.pullRequests(repoKey: parameters["repoKey"] ?? ""))
        case "prs.merge":
            return try json(try await actions.merge(
                repoKey: parameters["repoKey"] ?? "",
                slug: parameters["slug"] ?? "",
                body: request.body
            ))
        case "prStates.refresh":
            return try json(actions.refreshPullRequestStates(), code: 202)
        default:
            return respond(.notFound("route inconnue"))
        }
    }

    // MARK: - Appairage

    private func pair(_ request: HTTPRequest) async throws -> RemoteHandlerOutcome {
        let body = try RemoteBody.decode(RemotePairRequest.self, from: request)
        let code = body.code.uppercased()
        let alphabet = Set(ConsoleAPI.Service.pairingCodeAlphabet)
        guard code.count == ConsoleAPI.Service.pairingCodeLength,
              code.allSatisfy({ alphabet.contains($0) }) else {
            throw ConsoleAPIError.badRequest("code d'appairage mal formé")
        }
        let name = body.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 64 else {
            throw ConsoleAPIError.badRequest("nom d'appareil invalide")
        }
        let paired = try await registry.pair(code: code, name: name)
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
