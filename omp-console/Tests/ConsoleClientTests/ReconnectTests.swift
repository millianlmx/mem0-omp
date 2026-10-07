// La reconnexion BORNÉE et la reprise au premier plan (S-7).

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

@Suite("Reconnexion")
@MainActor
struct ReconnectTests {
    @Test("client-distant-ios/AC-8 : après une coupure réseau, repli borné puis « connecté » et données reprises")
    func networkCutAndRestored() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            pacerLimit: 5
        )
        harness.transport.script(.sequence([
            .hold,
            .failure(ClientError.transport(.unreachable("réseau coupé"))),
            .hold,
        ]))
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })

        harness.path.emit(false)
        #expect(harness.model.state == .noNetwork)

        harness.path.emit(true)
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        // Le repli demandé suit la table.
        let delays = await harness.pacer.recorded()
        #expect(delays == [0.5])

        // Les données reprennent : l'instantané de la nouvelle session est publié.
        let snapshot = ClientFixtures.snapshot()
        harness.transport.push(ClientFixtures.storeFrame(snapshot))
        #expect(await eventually { harness.model.snapshot == snapshot })
        harness.stop()
    }

    @Test("client-distant-ios/AC-9 : coque arrêtée puis relancée — échecs espacés selon la table, reconnexion seule")
    func macStoppedAndRestarted() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            pacerLimit: 3
        )
        harness.transport.script(.sequence([
            .failure(ClientError.transport(.unreachable("coque arrêtée"))),
            .failure(ClientError.transport(.unreachable("coque arrêtée"))),
            .failure(ClientError.transport(.unreachable("coque arrêtée"))),
            .failure(ClientError.transport(.unreachable("coque arrêtée"))),
            .failure(ClientError.transport(.unreachable("coque arrêtée"))),
        ]))
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .macAbsent(endpoint: macEndpoint) })
        try? await Task.sleep(nanoseconds: 200_000_000)
        let delays = await harness.pacer.recorded()
        #expect(Array(delays.prefix(3)) == [0.5, 1, 2])
        #expect(delays.allSatisfy { ClientRetry.delays.contains($0) })
        harness.stop()
    }

    @Test("client-distant-ios/AC-10 : suspend() n'affirme jamais « connecté » ; resume() resynchronise")
    func suspendAndResume() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })

        harness.model.suspend()
        #expect(harness.model.state == .connecting(endpoint: macEndpoint))
        #expect(harness.model.state != .connected(endpoint: macEndpoint))

        harness.model.resume()
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        harness.stop()
    }
}
