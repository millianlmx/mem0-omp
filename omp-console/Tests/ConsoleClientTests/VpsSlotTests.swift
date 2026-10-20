// Le client à deux machines (S-10 de orchestrator-living-in-a-vps) : un slot `vps`
// appairé joint le VPS avec SON jeton, le Mac éteint ne reçoit aucun geste, et une
// adresse qui est celle de l'AUTRE machine verrouille le client. Transports
// scriptés : aucun réseau, aucun Mac réel.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@MainActor
private let vpsAddress = ClientEndpoint.manual(host: "100.64.0.9", port: 8787)
@MainActor
private let macAddress = ClientEndpoint.manual(host: "192.168.1.20", port: 8787)

private func reply(_ json: String, status: Int = 200) -> Result<ClientHTTPResponse, Error> {
    .success(ClientHTTPResponse(status: status, protocolVersion: ConsoleAPI.protocolVersion, body: Data(json.utf8)))
}

/// Les routes du VPS scripté : chaque geste de la liste de S-10 reçoit une réponse décodable.
private func vpsRoutes(machine: String = "vps") -> @Sendable (ClientHTTPRequest) -> Result<ClientHTTPResponse, Error> {
    { request in
        let path = request.path.split(separator: "?").first.map(String.init) ?? request.path
        switch (request.method, path) {
        case ("GET", "/v1/version"):
            return reply(#"{"protocolVersion":\#(ConsoleAPI.protocolVersion),"machine":{"kind":"\#(machine)","name":"hôte"}}"#)
        case ("GET", "/v1/components"): return reply(#"{"ompInstalled":true}"#)
        case ("GET", "/v1/journal"): return reply(#"{"entries":[]}"#)
        case ("POST", "/v1/session/prompt"): return reply(#"{"sent":true}"#)
        case ("GET", "/v1/memory/page"): return reply(#"{"scope":null,"total":0,"offset":0,"rows":[],"nextOffset":null}"#)
        case ("GET", "/v1/stats"):
            return reply(#"{"projectKey":null,"project":"","projects":[],"features":[],"hiddenPlanFeatures":0}"#)
        case ("GET", "/v1/projects/k/pull-requests"): return reply(#"{"rows":[],"failure":null,"stale":false}"#)
        case ("POST", "/v1/projects/k/conduite"): return reply(#"{"state":"idle"}"#)
        default: return reply(#"{"accepted":true}"#)
        }
    }
}

private func helloFrame(machine: String) -> Data {
    ClientFixtures.frame(
        "hello",
        #"{"protocolVersion":\#(ConsoleAPI.protocolVersion),"machine":{"kind":"\#(machine)","name":"hôte"}}"#
    )
}

/// Un client du slot `vps` appairé (jeton `vps-token`), adresse Tailscale saisie.
@MainActor
private func pairedVps(machine: String = "vps") -> ClientHarness {
    let harness = ClientHarness(
        tokens: ["vd": "vps-token"],
        preferences: [ClientPreferenceKey.vpsDeviceId: "vd", ClientPreferenceKey.vpsManualAddress: "100.64.0.9:8787"],
        slot: .vps
    )
    harness.transport.respond(vpsRoutes(machine: machine))
    harness.transport.script(.hold)
    return harness
}

/// Un Mac appairé dont l'adresse ne répond plus : l'état est `.macAbsent`.
@MainActor
private func absentMac() -> ClientHarness {
    let harness = ClientHarness(
        tokens: ["md": "mac-token"],
        preferences: [ClientPreferenceKey.deviceId: "md", ClientPreferenceKey.manualAddress: "192.168.1.20:8787"],
        pacerLimit: 1
    )
    harness.transport.respond { _ in .failure(ClientError.transport(.unreachable("Mac éteint"))) }
    harness.transport.script(.failure(ClientError.transport(.unreachable("Mac éteint"))))
    return harness
}

/// Les routes de gestes : aucune ne doit atteindre le Mac éteint.
private let gesturePaths: Set<String> = [
    "/v1/cards/c1/answer", "/v1/cards/c1/verdict", "/v1/features", "/v1/session/prompt",
    "/v1/memory/page", "/v1/stats", "/v1/projects/k/pull-requests", "/v1/projects/k/conduite",
]

@Suite("Client à deux machines — le slot VPS")
@MainActor
struct VpsSlotTests {
    @Test("orchestrator-living-in-a-vps/AC-12 : Mac éteint (.macAbsent) et VPS appairé, chaque geste — réponse, verdict specs, verdict review, lancement, prompt hébergé, mémoire, statistiques, pull requests, conduite — part vers l'endpoint du VPS avec le jeton du VPS, jamais vers le Mac")
    func everyGestureGoesToTheVps() async throws {
        let mac = absentMac()
        mac.model.start()
        #expect(await eventually { mac.model.state == .macAbsent(endpoint: macAddress) })

        let vps = pairedVps()
        vps.model.start()
        #expect(await eventually { vps.model.state == .connected(endpoint: vpsAddress) })
        vps.transport.push(helloFrame(machine: "vps"))

        let clients = MachineClients(mac: mac.model, vps: vps.model, preferences: InMemoryClientPreferences())
        // Les gestes de carte partent par l'identifiant de l'ardoise unifiée : la carte du VPS.
        let card = clients.target(forCardId: "vps:c1")
        #expect(card.machine == .vps && card.cardId == "c1")

        _ = try await card.client.answer(cardId: card.cardId, kind: "option", label: "oui", text: nil, toolCallId: "t1")
        _ = try await card.client.verdict(cardId: card.cardId, verdict: "y")
        _ = try await card.client.verdict(cardId: card.cardId, verdict: "n")
        _ = try await clients.vps.launch(repoRoot: "/srv/repos/o/n", title: "t", description: "d", modelReqSpecs: nil, modelImplReview: nil)
        _ = try await clients.vps.prompt(message: "bonjour")
        _ = try await clients.vps.memoryPage(scope: nil, offset: 0, limit: 20)
        _ = try await clients.vps.statistics()
        _ = try await clients.vps.pullRequests(repoKey: "k")
        _ = try await clients.vps.startConduite(repoKey: "k", name: "conduite")

        let sent = vps.transport.requests
        let expected: [(String, String)] = [
            ("POST", "/v1/cards/c1/answer"), ("POST", "/v1/cards/c1/verdict"), ("POST", "/v1/features"),
            ("POST", "/v1/session/prompt"), ("GET", "/v1/memory/page?offset=0&limit=20"), ("GET", "/v1/stats"),
            ("GET", "/v1/projects/k/pull-requests"), ("POST", "/v1/projects/k/conduite"),
        ]
        for (method, path) in expected {
            let index = try #require(sent.firstIndex { $0.method == method && $0.path == path }, "\(method) \(path) non émise")
            #expect(vps.transport.endpoints[index] == vpsAddress, "\(path) : vers l'endpoint du VPS")
            #expect(vps.transport.tokens[index] == "vps-token", "\(path) : avec le jeton du VPS")
        }
        #expect(sent.filter { $0.path == "/v1/cards/c1/verdict" }.count == 2, "verdict specs et verdict review")
        // Toute requête du client VPS, de fond comprise, porte son endpoint et son jeton.
        #expect(vps.transport.endpoints.allSatisfy { $0 == vpsAddress })
        #expect(vps.transport.tokens.allSatisfy { $0 == "vps-token" })
        // Le Mac éteint n'a reçu aucun geste.
        #expect(mac.transport.requests.allSatisfy { !gesturePaths.contains($0.path.split(separator: "?").first.map(String.init) ?? $0.path) })
        #expect(mac.transport.tokens.allSatisfy { $0 != "vps-token" })
        mac.stop()
        vps.stop()
    }

    @Test("un hello du VPS annonçant le Mac verrouille le client : wrongMachine(vps, mac) et aucun geste émis")
    func helloAnnouncingTheMacLocksTheVpsSlot() async {
        let vps = pairedVps()
        vps.model.start()
        #expect(await eventually { vps.model.state == .connected(endpoint: vpsAddress) })
        vps.transport.push(helloFrame(machine: "mac"))
        #expect(await eventually { vps.model.state == .wrongMachine(expected: .vps, actual: .mac) })

        let before = vps.transport.requestCount
        await #expect(throws: ClientError.self) { _ = try await vps.model.statistics() }
        await #expect(throws: ClientError.self) {
            _ = try await vps.model.verdict(cardId: "c1", verdict: "y")
        }
        await #expect(throws: ClientError.self) { _ = try await vps.model.prompt(message: "x") }
        #expect(vps.transport.requestCount == before, "aucun geste n'est émis")
        #expect(ReposText.wrongMachine(expected: .vps, actual: .mac) == "Cette adresse est le Mac, pas le VPS")
        vps.stop()
    }

    @Test("/v1/version annonçant le Mac verrouille aussi le slot VPS ; et inversement pour le slot Mac")
    func versionAnnouncingTheOtherMachine() async throws {
        let vps = pairedVps(machine: "mac")
        vps.model.start()
        #expect(await eventually { vps.model.state == .connected(endpoint: vpsAddress) })
        _ = try await vps.model.version()
        #expect(await eventually { vps.model.state == .wrongMachine(expected: .vps, actual: .mac) })
        vps.stop()

        let mac = ClientHarness(
            tokens: ["md": "mac-token"],
            preferences: [ClientPreferenceKey.deviceId: "md", ClientPreferenceKey.manualAddress: "192.168.1.20:8787"]
        )
        mac.transport.script(.hold)
        mac.model.start()
        #expect(await eventually { mac.model.state == .connected(endpoint: macAddress) })
        mac.transport.push(helloFrame(machine: "vps"))
        #expect(await eventually { mac.model.state == .wrongMachine(expected: .mac, actual: .vps) })
        #expect(ReposText.wrongMachine(expected: .mac, actual: .vps) == "Cette adresse est le VPS, pas le Mac")
        mac.stop()
    }

    @Test("un serveur qui n'annonce aucune machine (d'avant le protocole 3) n'est pas refusé")
    func unannouncedMachineIsAccepted() async {
        let vps = pairedVps()
        vps.model.start()
        #expect(await eventually { vps.model.state == .connected(endpoint: vpsAddress) })
        vps.transport.push(ClientFixtures.helloFrame())
        _ = await eventually { vps.model.state == .connected(endpoint: vpsAddress) }
        #expect(vps.model.state == .connected(endpoint: vpsAddress))
        vps.stop()
    }

    @Test("le slot VPS a ses propres clés de préférences et son propre compte de trousseau ; seul le Mac se découvre")
    func slotKeys() {
        #expect(ClientMachineSlot.mac.manualAddressKey == "client.manualAddress")
        #expect(ClientMachineSlot.mac.deviceIdKey == "client.deviceId")
        #expect(ClientMachineSlot.mac.installationIdKey == "client.installationId")
        #expect(ClientMachineSlot.vps.manualAddressKey == "client.vps.manualAddress")
        #expect(ClientMachineSlot.vps.deviceIdKey == "client.vps.deviceId")
        #expect(ClientMachineSlot.vps.installationIdKey == "client.vps.installationId")
        #expect(ClientMachineSlot.mac.keychainService == "com.omp.console.ios.remote-api")
        #expect(ClientMachineSlot.vps.keychainService == "com.omp.console.ios.remote-api.vps")
        #expect(ClientMachineSlot.mac.usesDiscovery)
        #expect(!ClientMachineSlot.vps.usesDiscovery)
        #expect(ClientMachineSlot.mac.machine == .mac && ClientMachineSlot.vps.machine == .vps)
    }

    @Test("appairer le slot VPS écrit client.vps.* et jamais les clés du Mac ; l'adresse manuelle va à sa clé")
    func pairingWritesTheVpsKeys() async throws {
        let harness = ClientHarness(slot: .vps)
        harness.transport.respond { _ in
            reply(#"{"deviceId":"ABCD","token":"jeton-vps","protocolVersion":\#(ConsoleAPI.protocolVersion)}"#)
        }
        harness.transport.script(.hold)
        _ = harness.model.setManualAddress("100.64.0.9")
        #expect(harness.preferences.string(forKey: "client.vps.manualAddress") == "100.64.0.9:8787", "port par défaut 8787")
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.manualAddress) == nil)

        try await harness.model.pair(code: "ABCD-EFGH")
        #expect(harness.preferences.string(forKey: "client.vps.deviceId") == "abcd")
        #expect(harness.preferences.string(forKey: "client.vps.installationId")?.isEmpty == false)
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.deviceId) == nil)
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.installationId) == nil)
        #expect(await harness.tokens.knownTokens == ["abcd": "jeton-vps"])
        harness.stop()
    }
}
