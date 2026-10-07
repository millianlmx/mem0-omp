// L'appairage (S-5) et son refus unique (S-6).

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

@Suite("Appairage")
@MainActor
struct PairingTests {
    @Test("client-distant-ios/AC-5 : un code valide appaire et passe à « connecté »")
    func pairingSucceeds() async throws {
        let harness = ClientHarness()
        harness.transport.respond { request in
            if request.path == "/v1/pair" {
                return .success(ClientHTTPResponse(
                    status: 200,
                    protocolVersion: 1,
                    body: Data(#"{"deviceId":"ABC-123","token":"tok-1","protocolVersion":1}"#.utf8)
                ))
            }
            return .failure(ClientError.transport(.unreachable("route non scriptée")))
        }
        harness.transport.script(.hold)
        harness.model.start()
        harness.discovery.emit([mac])
        try await harness.model.pair(code: "abcd2345", deviceName: "iPhone de test")
        #expect(harness.model.pairingFailure == nil)
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        let stored = await harness.tokens.knownTokens
        #expect(stored["abc-123"] == "tok-1")
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.deviceId) == "abc-123")
        harness.stop()
    }

    @Test("client-distant-ios/AC-6 : au lancement suivant, le jeton du trousseau reconnecte sans appairage")
    func tokenRestoredWithoutPairing() async {
        let harness = ClientHarness(
            tokens: ["abc-123": "tok-1"],
            preferences: [ClientPreferenceKey.deviceId: "abc-123"]
        )
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        #expect(harness.transport.count(method: "POST", path: "/v1/pair") == 0)
        harness.stop()
    }

    @Test("client-distant-ios/AC-7 : un code refusé rend une erreur unique, sans boucle ni appairage")
    func pairingRefused() async throws {
        let harness = ClientHarness()
        harness.transport.respond { request in
            if request.path == "/v1/pair" {
                return .success(ClientHTTPResponse(
                    status: 401,
                    protocolVersion: 1,
                    body: Data(#"{"error":{"code":"unauthorized"}}"#.utf8)
                ))
            }
            return .failure(ClientError.transport(.unreachable("route non scriptée")))
        }
        harness.model.start()
        harness.discovery.emit([mac])
        try await harness.model.pair(code: "ABCD2345", deviceName: "iPhone")
        #expect(harness.model.pairingFailure == .refused)
        #expect(harness.model.state == .unpaired)
        #expect(await harness.tokens.knownTokens.isEmpty)
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.deviceId) == nil)
        // Aucun réessai automatique : une seule requête d'appairage après une attente.
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(harness.transport.count(method: "POST", path: "/v1/pair") == 1)
        harness.stop()
    }

    @Test("un code mal formé est refusé sans aucune requête")
    func malformedCodeIsLocal() async throws {
        let harness = ClientHarness()
        harness.model.start()
        harness.discovery.emit([mac])
        try await harness.model.pair(code: "abc", deviceName: "iPhone")
        #expect(harness.model.pairingFailure == .malformedCode)
        #expect(harness.transport.count(method: "POST", path: "/v1/pair") == 0)
        harness.stop()
    }
}
