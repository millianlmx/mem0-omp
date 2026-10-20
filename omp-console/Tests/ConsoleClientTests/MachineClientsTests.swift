// Les deux clients de l'app (S-10 de orchestrator-living-in-a-vps) : l'ardoise
// unifiée, la machine d'un geste de carte (`target(forCardId:)`) et la machine des
// écrans mono-machine (`activeMachine`). Transports scriptés : aucun réseau.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@MainActor
private let vpsAddress = ClientEndpoint.manual(host: "100.64.0.9", port: 8787)
@MainActor
private let macAddress = ClientEndpoint.manual(host: "192.168.1.20", port: 8787)

private func reply(_ json: String) -> Result<ClientHTTPResponse, Error> {
    .success(ClientHTTPResponse(status: 200, protocolVersion: ConsoleAPI.protocolVersion, body: Data(json.utf8)))
}

@MainActor
private func pairedMac(reachable: Bool) -> ClientHarness {
    let harness = ClientHarness(
        tokens: ["md": "mac-token"],
        preferences: [ClientPreferenceKey.deviceId: "md", ClientPreferenceKey.manualAddress: "192.168.1.20:8787"],
        pacerLimit: 1
    )
    if reachable {
        harness.transport.respond { _ in reply(#"{"accepted":true}"#) }
        harness.transport.script(.hold)
    } else {
        harness.transport.respond { _ in .failure(ClientError.transport(.unreachable("Mac éteint"))) }
        harness.transport.script(.failure(ClientError.transport(.unreachable("Mac éteint"))))
    }
    return harness
}

@MainActor
private func pairedVps() -> ClientHarness {
    let harness = ClientHarness(
        tokens: ["vd": "vps-token"],
        preferences: [ClientPreferenceKey.vpsDeviceId: "vd", ClientPreferenceKey.vpsManualAddress: "100.64.0.9:8787"],
        slot: .vps
    )
    harness.transport.respond { _ in reply(#"{"accepted":true}"#) }
    harness.transport.script(.hold)
    return harness
}

@Suite("MachineClients — deux clients, une app")
@MainActor
struct MachineClientsTests {
    @Test("sans VPS configuré : aucun badge, les cartes du Mac sans préfixe, le Mac par défaut, tout geste vers le Mac")
    func noVpsMeansUnchanged() async {
        let mac = pairedMac(reachable: true)
        mac.model.start()
        #expect(await eventually { mac.model.state == .connected(endpoint: macAddress) })
        let vps = ClientHarness(slot: .vps)
        let clients = MachineClients(mac: mac.model, vps: vps.model, preferences: InMemoryClientPreferences())

        #expect(!clients.vpsConfigured)
        #expect(clients.availability(of: .vps) == .notConfigured)
        let board = clients.board
        #expect(!board.showsBadges && board.unreachable.isEmpty)
        #expect(board.state == mac.model.board)
        #expect(clients.activeMachine == .mac)
        let target = clients.target(forCardId: "c1")
        #expect(target.machine == .mac && target.cardId == "c1" && target.client === mac.model)
        mac.stop()
    }

    @Test("le geste d'une carte du VPS part vers le client du VPS avec l'identifiant de CETTE machine, même Mac éteint")
    func cardGestureFollowsTheCard() async throws {
        let mac = pairedMac(reachable: false)
        mac.model.start()
        #expect(await eventually { mac.model.state == .macAbsent(endpoint: macAddress) })
        let vps = pairedVps()
        vps.model.start()
        #expect(await eventually { vps.model.state == .connected(endpoint: vpsAddress) })
        let clients = MachineClients(mac: mac.model, vps: vps.model, preferences: InMemoryClientPreferences())

        #expect(clients.vpsConfigured)
        #expect(clients.availability(of: .mac) == .unreachable)
        #expect(clients.availability(of: .vps) == .reachable)

        let target = clients.target(forCardId: "vps:feat9")
        #expect(target.machine == .vps)
        #expect(target.cardId == "feat9")
        #expect(target.client === vps.model)
        _ = try await target.client.stop(cardId: target.cardId)
        let index = try #require(vps.transport.requests.firstIndex { $0.path == "/v1/cards/feat9/stop" })
        #expect(vps.transport.endpoints[index] == vpsAddress)
        #expect(vps.transport.tokens[index] == "vps-token")
        #expect(mac.transport.requests.allSatisfy { $0.path != "/v1/cards/feat9/stop" })

        // Une carte du Mac garde son identifiant et son client.
        let macCard = clients.target(forCardId: "feat1")
        #expect(macCard.machine == .mac && macCard.cardId == "feat1" && macCard.client === mac.model)
        mac.stop()
        vps.stop()
    }

    @Test("Mac injoignable et VPS joignable : bandeau « Mac injoignable », badges, écrans mono-machine sur le VPS ; le choix explicite prime")
    func activeMachineAndBanner() async {
        let mac = pairedMac(reachable: false)
        mac.model.start()
        #expect(await eventually { mac.model.state == .macAbsent(endpoint: macAddress) })
        let vps = pairedVps()
        vps.model.start()
        #expect(await eventually { vps.model.state == .connected(endpoint: vpsAddress) })
        let clients = MachineClients(mac: mac.model, vps: vps.model, preferences: InMemoryClientPreferences())

        #expect(clients.board.showsBadges)
        #expect(clients.board.unreachable == [.mac])
        #expect(clients.activeMachine == .vps)
        #expect(clients.activeClient === vps.model)
        clients.select(.mac)
        #expect(clients.activeMachine == .mac)
        #expect(clients.activeClient === mac.model)
        clients.select(.vps)
        #expect(clients.activeMachine == .vps)
        mac.stop()
        vps.stop()
    }

    @Test("sans VPS configuré, le choix explicite du VPS est ignoré")
    func chosenVpsIgnoredWithoutVps() async {
        let mac = pairedMac(reachable: true)
        mac.model.start()
        #expect(await eventually { mac.model.state == .connected(endpoint: macAddress) })
        let clients = MachineClients(mac: mac.model, vps: ClientHarness(slot: .vps).model, preferences: InMemoryClientPreferences())
        clients.select(.vps)
        #expect(clients.activeMachine == .mac)
        mac.stop()
    }
}
