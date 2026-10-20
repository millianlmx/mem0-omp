// Le modèle observable du flux temps réel (S-2) : les trames mettent à jour les
// valeurs publiées SANS aucun rechargement (AC-11).

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

@Suite("Flux et modèle")
@MainActor
struct StreamModelTests {
    @Test("client-distant-ios/AC-11 : une trame components met à jour les composants sans rechargement")
    func componentsFrameUpdatesWithoutReload() async {
        let harness = await Self.connectedHarness()
        let before = harness.transport.requestCount
        let payload = RemoteComponentsPayload(ompInstalled: false, ompPath: nil, setupBanner: "Préparation en cours")
        harness.transport.push(ClientFixtures.componentsFrame(payload))
        #expect(await eventually { harness.model.components == payload })
        #expect(harness.transport.requestCount == before, "aucune requête émise à la réception d'une trame")
        harness.stop()
    }

    @Test("le flux décode la trame devices et l'applique")
    func devicesFrameApplied() async {
        let harness = await Self.connectedHarness()
        harness.transport.push(ClientFixtures.frame(
            "devices",
            #"{"devices":[{"id":"a","name":"iPhone","pairedAtMs":1,"lastSeenAtMs":2,"connected":true}]}"#
        ))
        #expect(await eventually { harness.model.devices.count == 1 })
        #expect(harness.model.devices.first?.name == "iPhone")
        harness.stop()
    }

    /// Un harnais DÉJÀ connecté au flux (les trames n'arrivent que là).
    private static func connectedHarness() async -> ClientHarness {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.script(.hold)
        harness.model.start()
        _ = await eventually { harness.model.state == .searching }
        harness.discovery.emit([mac])
        _ = await eventually { harness.model.state == .connected(endpoint: macEndpoint) }
        // La connexion lit les composants (S-8) : on attend cette lecture, puis on
        // mesure les trames seules.
        _ = await eventually { harness.transport.count(method: "GET", path: "/v1/components") >= 1 }
        return harness
    }
}
