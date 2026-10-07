// La découverte Bonjour (S-3) : au plus un Mac, trié par nom d'instance UTF-8,
// aucune entrée fabriquée.

@testable import ConsoleClient
import ConsoleCore
import Testing

@Suite("Découverte")
@MainActor
struct DiscoveryTests {
    @Test("client-distant-ios/AC-2 : sans coque annoncée, aucun Mac n'est présenté — aucune entrée fabriquée")
    func noMacFound() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.model.start()
        #expect(harness.discovery.started)
        #expect(harness.discovery.requestedServiceType == ConsoleAPI.Service.bonjourType)
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([])
        #expect(harness.model.discovered == nil)
        #expect(harness.model.state == .searching)
        harness.stop()
    }

    @Test("plusieurs coques annoncées : seule la plus petite par nom UTF-8 est conservée")
    func keepsSmallestName() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([
            DiscoveredMac(name: "Zeta", endpoint: .bonjour(name: "Zeta", host: "10.0.0.2", port: 8787)),
            DiscoveredMac(name: "Alpha", endpoint: .bonjour(name: "Alpha", host: "10.0.0.1", port: 8787)),
        ])
        #expect(harness.model.discovered?.name == "Alpha")
        // La disparition de « Alpha » promeut « Zeta ».
        harness.discovery.emit([
            DiscoveredMac(name: "Zeta", endpoint: .bonjour(name: "Zeta", host: "10.0.0.2", port: 8787)),
        ])
        #expect(harness.model.discovered?.name == "Zeta")
        harness.stop()
    }
}
