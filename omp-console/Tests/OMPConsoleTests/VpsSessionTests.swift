// La Session OMP du VPS conduite depuis omp-console (S-8 de orchestrator-living-in-a-vps) :
// le modèle parle le protocole distant par le client du VPS (slot `.vps`), affiche la réponse
// de l'agent poussée par le flux, et n'envoie JAMAIS d'arrêt au VPS à la fermeture. Transport
// scripté : aucun réseau, aucun VPS réel.

import Combine
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

// MARK: - Doublure de transport

/// Le transport scripté du VPS : enregistre chaque requête avec son endpoint et son jeton,
/// rend les réponses du script et tient le flux SSE ouvert pour que le test y pousse ses trames.
private final class VpsTransport: ClientTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [(request: ClientHTTPRequest, endpoint: ClientEndpoint, token: String?)] = []
    private var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private let responder: @Sendable (ClientHTTPRequest) -> String

    init(_ responder: @escaping @Sendable (ClientHTTPRequest) -> String) {
        self.responder = responder
    }

    var requests: [ClientHTTPRequest] { lock.withLock { recorded.map(\.request) } }
    var endpoints: [ClientEndpoint] { lock.withLock { recorded.map(\.endpoint) } }
    var tokens: [String?] { lock.withLock { recorded.map(\.token) } }

    func send(_ request: ClientHTTPRequest, to endpoint: ClientEndpoint, token: String?) async throws -> ClientHTTPResponse {
        lock.withLock { recorded.append((request, endpoint, token)) }
        return ClientHTTPResponse(
            status: 200,
            protocolVersion: ConsoleAPI.protocolVersion,
            body: Data(responder(request).utf8)
        )
    }

    func stream(_ request: ClientHTTPRequest, to endpoint: ClientEndpoint, token: String?) async throws -> AsyncThrowingStream<Data, Error> {
        lock.withLock { recorded.append((request, endpoint, token)) }
        return AsyncThrowingStream { continuation in
            lock.withLock { continuations.append(continuation) }
        }
    }

    func push(event: String, _ json: String) {
        let current = lock.withLock { continuations }
        let frame = Data("event: \(event)\ndata: \(json)\n\n".utf8)
        for continuation in current { continuation.yield(frame) }
    }
}

private let vpsAddress = ClientEndpoint.manual(host: "100.64.0.9", port: 8787)
private let sessionFile = "/srv/repos/o/depot/session.jsonl"

private func hosted(_ state: String, file: String? = nil, turn: Bool = false) -> String {
    var object: [String: Any] = ["state": state, "stateLabel": state, "dialogs": [], "transcript": [], "truncated": false, "turnRunning": turn]
    if let file {
        object["sessionFile"] = file
        object["projectName"] = "depot"
    }
    return String(decoding: (try? JSONSerialization.data(withJSONObject: object)) ?? Data(), as: UTF8.self)
}

/// Le VPS scripté : une session `idle` qui passe `running` au lancement.
private func vpsRoutes() -> @Sendable (ClientHTTPRequest) -> String {
    let launched = LockedFlag()
    return { request in
        let path = request.path.split(separator: "?").first.map(String.init) ?? request.path
        switch (request.method, path) {
        case ("GET", "/v1/version"):
            return #"{"protocolVersion":\#(ConsoleAPI.protocolVersion),"machine":{"kind":"vps","name":"VPS de test"}}"#
        case ("GET", "/v1/session"):
            return launched.value ? hosted("running", file: sessionFile) : hosted("idle")
        case ("POST", "/v1/session/launch"):
            launched.set()
            return hosted("running", file: sessionFile)
        case ("POST", "/v1/session/prompt"):
            return #"{"sent":true}"#
        case ("POST", "/v1/session/stop"):
            return hosted("stopped", file: sessionFile)
        case ("GET", "/v1/repos"):
            return #"{"rows":[{"repoKey":"k1","repoRoot":"/srv/repos/o/depot","name":"depot"}]}"#
        case ("GET", _) where path.hasPrefix("/v1/sessions/"):
            return #"{"entries":[],"skipped":[],"truncated":false}"#
        default:
            return #"{"accepted":true}"#
        }
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    var value: Bool { lock.withLock { flag } }
    func set() { lock.withLock { flag = true } }
}

/// Un client du slot `.vps` appairé (jeton `vps-token`), adresse Tailscale saisie.
@MainActor
private func pairedVpsClient(_ transport: VpsTransport) -> ConsoleClientModel {
    ConsoleClientModel(
        transport: transport,
        discovery: ContractDiscovery(),
        preferences: InMemoryClientPreferences([
            ClientPreferenceKey.vpsDeviceId: "vd",
            ClientPreferenceKey.vpsManualAddress: "100.64.0.9:8787",
        ]),
        tokens: InMemoryTokenStore(["vd": "vps-token"]),
        pacer: LiveClientPacer(),
        pathSource: ContractPath(),
        deviceName: "Tests",
        slot: .vps
    )
}

@MainActor
private func unpairedVpsClient() -> ConsoleClientModel {
    ConsoleClientModel(
        transport: VpsTransport { _ in "{}" },
        discovery: ContractDiscovery(),
        preferences: InMemoryClientPreferences(),
        tokens: InMemoryTokenStore(),
        pacer: LiveClientPacer(),
        pathSource: ContractPath(),
        deviceName: "Tests",
        slot: .vps
    )
}

@Suite("Session OMP du VPS — omp-console")
@MainActor
struct VpsSessionTests {
    @Test("orchestrator-living-in-a-vps/AC-13 : lancement sur le VPS, message envoyé à l'endpoint du VPS, réponse de l'agent affichée dans le fil, puis terminateForQuit sans /v1/session/stop")
    func hostedVpsSessionLivesOnTheVps() async throws {
        let transport = VpsTransport(vpsRoutes())
        let client = pairedVpsClient(transport)
        client.start()
        #expect(await awaitMainTrue { client.state == .connected(endpoint: vpsAddress) })

        let model = VpsSessionModel(client: client)
        model.appeared()
        #expect(await awaitMainTrue { model.surface == .empty }, "aucune session sur le VPS : « Lancer… »")
        #expect(ReposText.sessionNone == "Aucune session sur le VPS")
        #expect(model.canLaunch)

        // Lancement sur un dépôt du VPS : `POST /v1/session/launch {repoKey}`.
        await model.loadRepos()
        let repoKey = try #require(model.repos.first?.repoKey)
        #expect(await model.launch(repoKey: repoKey) == nil)
        let launch = try #require(transport.requests.first { $0.path == "/v1/session/launch" })
        #expect(launch.method == "POST")
        #expect(String(decoding: launch.body ?? Data(), as: UTF8.self).contains("\"repoKey\":\"k1\""))
        #expect(await awaitMainTrue { model.surface == .live })
        #expect(await awaitMainTrue { model.conversation?.target.sessionFile == sessionFile }, "le fil est celui du fichier du VPS")

        // Envoi d'un message : la requête prompt part vers l'endpoint du VPS avec son jeton.
        model.prompt = "fais avancer le lot"
        #expect(model.canSendPrompt)
        await model.sendPrompt()
        let promptIndex = try #require(transport.requests.firstIndex { $0.path == "/v1/session/prompt" })
        #expect(transport.endpoints[promptIndex] == vpsAddress)
        #expect(transport.tokens[promptIndex] == "vps-token")
        #expect(String(decoding: transport.requests[promptIndex].body ?? Data(), as: UTF8.self).contains("fais avancer le lot"))
        #expect(model.prompt.isEmpty, "le champ n'est vidé que sur succès")

        // La réponse de l'agent arrive par une trame `sessions` : elle s'affiche dans le fil.
        let conversation = try #require(model.conversation)
        transport.push(
            event: "sessions",
            #"{"file":"\#(sessionFile)","added":[{"index":2,"offset":120,"kind":"assistant","text":"Lot avancé."}]}"#
        )
        #expect(await awaitMainTrue {
            conversation.rows.contains { row in
                if case .assistant(let assistant) = row.kind { return assistant.text == "Lot avancé." }
                return false
            }
        }, "la réponse de l'agent s'affiche dans le fil")

        // Fermer l'app : aucune requête d'arrêt, la session continue sur le VPS.
        let before = transport.requests.count
        await model.terminateForQuit()
        #expect(transport.requests.count == before, "terminateForQuit n'émet aucune requête")
        #expect(!transport.requests.contains { $0.path == "/v1/session/stop" }, "jamais d'arrêt envoyé au VPS à la fermeture")
        #expect(model.conversation == nil)

        // À la réouverture, `GET /v1/session` retrouve la session en cours et son fil.
        model.appeared()
        #expect(await awaitMainTrue { model.surface == .live && model.conversation != nil })
        #expect(!transport.requests.contains { $0.path == "/v1/session/stop" })
        client.stop()
    }

    @Test("« Arrêter » est le seul geste qui poste /v1/session/stop")
    func stopIsTheOnlyPathToStop() async {
        let transport = VpsTransport(vpsRoutes())
        let client = pairedVpsClient(transport)
        client.start()
        #expect(await awaitMainTrue { client.state == .connected(endpoint: vpsAddress) })
        let model = VpsSessionModel(client: client)
        _ = await model.launch(repoKey: "k1")
        #expect(await awaitMainTrue { model.canStop })
        await model.stop()
        #expect(transport.requests.filter { $0.path == "/v1/session/stop" }.count == 1)
        #expect(await awaitMainTrue { model.surface == .stopped })
        client.stop()
    }

    @Test("les états de S-8 : non appairé, injoignable, aucune session, tour en cours")
    func surfaces() {
        #expect(VpsSessionModel.surface(availability: .notConfigured, hosted: nil) == .notPaired)
        #expect(ReposText.sessionNotPaired == "Appairez le VPS dans Dépôts")
        #expect(VpsSessionModel.surface(availability: .unreachable, hosted: nil) == .unreachable)
        #expect(ReposText.sessionUnreachable == "VPS injoignable — la session continue sur le VPS.")
        #expect(VpsSessionModel.surface(availability: .reachable, hosted: nil) == .loading)
        let idle = try? JSONDecoder().decode(ConsoleClient.RemoteHostedEvent.self, from: Data(#"{"state":"idle","dialogs":[],"added":[]}"#.utf8))
        #expect(VpsSessionModel.surface(availability: .reachable, hosted: idle) == .empty)
        // Injoignable : la saisie est désactivée, même avec une session connue.
        #expect(!VpsSessionModel.canSendPrompt(surface: .unreachable, dialogs: [], text: "x"))
        #expect(VpsSessionModel.canSendPrompt(surface: .live, dialogs: [], text: "x"))
        #expect(!VpsSessionModel.canSendPrompt(surface: .live, dialogs: [], text: "   "))
    }

    @Test("un VPS non appairé : la section dit « Appairez le VPS dans Dépôts », aucune requête partie")
    func notPairedSurface() async {
        let client = unpairedVpsClient()
        client.start()
        let model = VpsSessionModel(client: client)
        #expect(await awaitMainTrue { model.surface == .notPaired })
        model.appeared()
        #expect(!model.canLaunch)
        client.stop()
    }
}
