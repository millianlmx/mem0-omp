// La priorité de l'adresse manuelle (S-4) : elle PRIME et n'est jamais remplacée
// en silence par Bonjour.

@testable import ConsoleClient
import ConsoleCore
import Testing

@MainActor
private let bonjourMac = DiscoveredMac(
    name: "OMP Console",
    endpoint: .bonjour(name: "OMP Console", host: "192.168.1.12", port: 8787)
)

@Suite("Adresse manuelle")
@MainActor
struct AddressTests {
    @Test("client-distant-ios/AC-3 : l'adresse manuelle prime et l'écran d'état la nomme, jamais celle de Bonjour")
    func manualAddressWins() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            pacerLimit: 2
        )
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.transport.script(.failure(ClientError.transport(.unreachable("Mac absent"))))
        #expect(harness.model.setManualAddress("10.0.0.5:9000") == .success(ClientAddress(host: "10.0.0.5", port: 9000)))
        harness.discovery.emit([bonjourMac])
        let manual = ClientEndpoint.manual(host: "10.0.0.5", port: 9000)
        #expect(harness.model.effectiveEndpoint == manual)
        #expect(await eventually { harness.model.state == .macAbsent(endpoint: manual) })
        #expect(harness.model.state.endpoint?.display == "10.0.0.5:9000")
        #expect(harness.model.discovered != nil, "le Mac trouvé reste affiché")
        #expect(harness.transport.endpoints.allSatisfy { $0 == manual })
        harness.stop()
    }

    @Test("client-distant-ios/AC-4 : Bonjour ne remplace jamais une adresse posée")
    func bonjourDoesNotReplace() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            pacerLimit: 2
        )
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        _ = harness.model.setManualAddress("10.0.0.5:9000")
        harness.discovery.emit([bonjourMac])
        #expect(harness.model.manualAddress == ClientAddress(host: "10.0.0.5", port: 9000))
        #expect(harness.model.effectiveEndpoint == .manual(host: "10.0.0.5", port: 9000))
        // Seule « Effacer » retire l'adresse posée.
        harness.model.clearManualAddress()
        #expect(harness.model.manualAddress == nil)
        #expect(harness.model.effectiveEndpoint == bonjourMac.endpoint)
        harness.stop()
    }

    @Test("l'analyse d'adresse accepte les formes valides et refuse les cinq cas")
    func parsing() {
        #expect(ClientAddress.parse("10.0.0.5") == .success(ClientAddress(host: "10.0.0.5", port: 8787)))
        #expect(ClientAddress.parse("10.0.0.5:9000") == .success(ClientAddress(host: "10.0.0.5", port: 9000)))
        #expect(ClientAddress.parse("http://10.0.0.5:9000") == .success(ClientAddress(host: "10.0.0.5", port: 9000)))
        #expect(ClientAddress.parse("") == .failure(.empty))
        #expect(ClientAddress.parse("https://10.0.0.5") == .failure(.scheme))
        #expect(ClientAddress.parse("10.0.0.5/path") == .failure(.hasPath))
        #expect(ClientAddress.parse("10.0.0.5:70000") == .failure(.badPort))
        #expect(ClientAddress.parse("10.0.0 .5:9000") == .failure(.badHost))
    }

    @Test("ios-onboarding-et-connexion/AC-6 : l'adresse manuelle s'affiche sans zone d'interface, la forme persistée la garde")
    func manualAddressDisplayHasNoZone() {
        let ipv4 = ClientAddress(host: "192.168.1.175%en0", port: 8787)
        #expect(ipv4.display == "192.168.1.175:8787")
        // La forme persistée est inchangée : `parse` la relit avec sa zone.
        #expect(ipv4.text == "192.168.1.175%en0:8787")
        #expect(ClientAddress.parse(ipv4.text) == .success(ipv4))

        let ipv6 = ClientAddress(host: "fe80::1%en0", port: 8787)
        #expect(ipv6.display == "[fe80::1]:8787")
        #expect(ipv6.text == "fe80::1%en0:8787")

        let name = ClientAddress(host: "mac.local", port: 9000)
        #expect(name.display == "mac.local:9000")
        #expect(name.display == name.text)
    }
}
