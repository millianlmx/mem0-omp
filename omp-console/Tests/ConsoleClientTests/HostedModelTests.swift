// Le sélecteur de modèle côté client (model-selector-in-embedded-omp-session, S-5,
// S-7) : le catalogue porte les efforts de chaque modèle, la trame `hosted` et la
// réponse du geste remplacent le modèle, le niveau et le tour en cours — recopiés
// par `applyHosted` —, et un refus du Mac lève sans toucher à la valeur affichée.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@MainActor
private let mac = DiscoveredMac(
    name: "OMP Console",
    endpoint: .bonjour(name: "OMP Console", host: "192.168.1.12", port: 8787)
)

@MainActor
private let macEndpoint = ClientEndpoint.bonjour(name: "OMP Console", host: "192.168.1.12", port: 8787)

private func hostedBody(_ state: String, model: String?, level: String?, turn: Bool?) -> Data {
    var object: [String: Any] = [
        "state": state, "stateLabel": "libellé", "dialogs": [], "transcript": [], "truncated": false,
    ]
    if let model { object["model"] = model }
    if let level { object["thinkingLevel"] = level }
    if let turn { object["turnRunning"] = turn }
    return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
}

private func reply(_ status: Int, _ body: Data) -> Result<ClientHTTPResponse, Error> {
    .success(ClientHTTPResponse(status: status, protocolVersion: ConsoleAPI.protocolVersion, body: body))
}

/// Un modèle au Mac connu par son adresse manuelle, non démarré : seules les
/// requêtes du test partent.
@MainActor
private func harness(_ handler: @escaping @Sendable (ClientHTTPRequest) -> Result<ClientHTTPResponse, Error>) -> ClientHarness {
    let harness = ClientHarness(tokens: ["d": "tok"], preferences: [ClientPreferenceKey.deviceId: "d"])
    harness.transport.respond(handler)
    _ = harness.model.setManualAddress("10.0.0.5:9000")
    return harness
}

@Suite("model-selector-in-embedded-omp-session — le client iPhone")
@MainActor
struct HostedModelTests {
    @Test("model-selector-in-embedded-omp-session/AC-6 : le catalogue du Mac porte les efforts ; sans thinking (Mac antérieur) aucun niveau n'est proposé")
    func modelsPayloadDrivesThinkingChoices() throws {
        let wire = Data(#"{"selectors":["a/x","a/y"],"failure":null,"thinking":{"a/x":["low","high"]}}"#.utf8)
        let payload = try JSONDecoder().decode(RemoteModelsPayload.self, from: wire)
        let thinking = payload.thinking ?? [:]
        #expect(ModelCatalog.thinkingChoices(for: "a/x", thinking: thinking) == ["off", "low", "high"])
        #expect(ModelCatalog.thinkingChoices(for: "a/y", thinking: thinking).isEmpty)

        let older = try JSONDecoder().decode(
            RemoteModelsPayload.self,
            from: Data(#"{"selectors":["a/x"],"failure":null}"#.utf8)
        )
        #expect(older.thinking == nil)
        #expect(ModelCatalog.thinkingChoices(for: "a/x", thinking: older.thinking ?? [:]).isEmpty)
        #expect(RemoteModelsPayload(selectors: [], failure: "x").thinking == nil, "init(…, thinking: = nil)")
    }

    @Test("model-selector-in-embedded-omp-session/AC-2 : une trame hosted du Mac remplace modèle, niveau et tour en cours, sans relance")
    func hostedFrameReplacesTheModel() async {
        let harness = ClientHarness(tokens: ["d": "tok"], preferences: [ClientPreferenceKey.deviceId: "d"])
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })

        harness.transport.push(ClientFixtures.frame(
            "hosted",
            #"{"state":"running","dialogs":[],"added":[],"model":"p/a","thinkingLevel":"low","turnRunning":false}"#
        ))
        #expect(await eventually { harness.model.hosted?.model == "p/a" })
        #expect(harness.model.hosted?.thinkingLevel == "low")
        #expect(harness.model.hosted?.turnRunning == false)

        // Le Mac change le modèle : la trame suivante REMPLACE l'état, le tour aussi.
        harness.transport.push(ClientFixtures.frame(
            "hosted",
            #"{"state":"running","dialogs":[],"added":[],"model":"p/b","turnRunning":true}"#
        ))
        #expect(await eventually { harness.model.hosted?.model == "p/b" })
        #expect(harness.model.hosted?.thinkingLevel == nil)
        #expect(harness.model.hosted?.turnRunning == true)

        // Un Mac antérieur : aucun des trois champs, la trame reste lisible.
        harness.transport.push(ClientFixtures.frame("hosted", #"{"state":"idle","dialogs":[],"added":[]}"#))
        #expect(await eventually { harness.model.hosted?.state == "idle" })
        #expect(harness.model.hosted?.model == nil)
        #expect(harness.model.hosted?.turnRunning == nil)
        harness.stop()
    }

    @Test("model-selector-in-embedded-omp-session/AC-4 : setHostedModel poste POST /v1/session/model et publie la valeur rendue par le Mac")
    func setHostedModelPostsAndPublishes() async throws {
        let harness = harness { request in
            switch (request.method, request.path) {
            case ("POST", "/v1/session/model"):
                return reply(200, hostedBody("running", model: "p/b", level: "high", turn: false))
            default:
                return .failure(ClientError.transport(.unreachable("route non scriptée")))
            }
        }

        try await harness.model.setHostedModel(model: "p/b", thinkingLevel: "high")

        let sent = try #require(harness.transport.requests.first { $0.path == "/v1/session/model" })
        #expect(sent.method == "POST")
        let body = try #require(
            sent.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        )
        #expect(body["model"] as? String == "p/b")
        #expect(body["thinkingLevel"] as? String == "high")
        #expect(harness.model.hosted?.model == "p/b")
        #expect(harness.model.hosted?.thinkingLevel == "high")
        #expect(harness.model.hosted?.turnRunning == false)
        #expect(harness.model.hosted?.state == "running")
    }

    @Test("model-selector-in-embedded-omp-session/AC-12 : un refus du Mac lève avec sa raison et laisse la valeur affichée telle quelle")
    func aRefusalThrowsAndKeepsTheValue() async throws {
        let reason = "Modèle inutilisable : OMP n'a pas d'authentification pour p/x."
        let refusal = (try? JSONSerialization.data(
            withJSONObject: ["error": ["code": "conflict", "message": reason]],
            options: [.sortedKeys]
        )) ?? Data()
        let harness = harness { request in
            switch (request.method, request.path) {
            case ("GET", "/v1/session"):
                return reply(200, hostedBody("running", model: "p/a", level: "low", turn: false))
            case ("POST", "/v1/session/model"):
                return reply(409, refusal)
            default:
                return .failure(ClientError.transport(.unreachable("route non scriptée")))
            }
        }
        _ = try await harness.model.hostedSession()
        #expect(harness.model.hosted?.model == "p/a")

        do {
            try await harness.model.setHostedModel(model: "p/x", thinkingLevel: "high")
            Issue.record("le refus du Mac doit lever")
        } catch let error as ClientError {
            #expect(error == .api(.conflict(reason)))
        }
        // L'affichage reste sur ce qui tourne réellement.
        #expect(harness.model.hosted?.model == "p/a")
        #expect(harness.model.hosted?.thinkingLevel == "low")
    }
}
