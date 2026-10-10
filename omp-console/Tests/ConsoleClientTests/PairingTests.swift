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

    @Test("mac-feuille-appairage-debordante/AC-11 : le code saisi avec ou sans tiret, toute casse, part normalisé")
    func pairingAcceptsGroupedAndLowercaseCodes() async throws {
        for form in ["ABCD-EFGH", "ABCDEFGH", "abcd-efgh"] {
            let harness = ClientHarness()
            harness.transport.respond(pairSucceeds)
            harness.transport.script(.hold)
            harness.model.start()
            harness.discovery.emit([mac])
            try await harness.model.pair(code: form, deviceName: "iPad Pro 13 pouces (M5)")
            #expect(harness.model.pairingFailure == nil, "« \(form) »")
            let bodies = pairBodies(harness)
            #expect(bodies.count == 1, "« \(form) »")
            #expect(bodies.first?["code"] as? String == "ABCDEFGH", "« \(form) »")
            #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
            harness.stop()
        }
    }

    @Test("mac-feuille-appairage-debordante/AC-4 : chaque appairage porte la même identité d'installation, créée au premier, gardée après révocation")
    func everyPairingCarriesTheSameInstallationId() async throws {
        let harness = ClientHarness()
        // Tout sauf l'appairage est refusé : le jeton délivré est aussitôt révoqué.
        harness.transport.respond { request in
            if request.path == "/v1/pair" { return pairSucceeds(request) }
            return .success(ClientHTTPResponse(
                status: 401,
                protocolVersion: 1,
                body: Data(#"{"error":{"code":"unauthorized"}}"#.utf8)
            ))
        }
        harness.model.start()
        harness.discovery.emit([mac])
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.installationId) == nil)

        try await harness.model.pair(code: "ABCD-EFGH", deviceName: "iPhone 17e")
        #expect(harness.model.pairingFailure == nil)
        let created = try #require(harness.preferences.string(forKey: ClientPreferenceKey.installationId))
        #expect(created == created.lowercased())
        #expect(UUID(uuidString: created) != nil)

        // Révocation : `deviceId` est oublié, l'identité d'installation reste.
        _ = try? await harness.model.version()
        #expect(await eventually { harness.model.state == .revoked })
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.deviceId) == nil)
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.installationId) == created)

        try await harness.model.pair(code: "WXYZ-2345", deviceName: "iPhone 17e")
        let keys = pairBodies(harness).map { $0["deviceKey"] as? String }
        #expect(keys == [created, created])
        harness.stop()
    }
}

/// Le Mac accepte tout appairage.
private func pairSucceeds(_ request: ClientHTTPRequest) -> Result<ClientHTTPResponse, Error> {
    if request.path == "/v1/pair" {
        return .success(ClientHTTPResponse(
            status: 200,
            protocolVersion: 1,
            body: Data(#"{"deviceId":"ABC-123","token":"tok-1","protocolVersion":1}"#.utf8)
        ))
    }
    return .failure(ClientError.transport(.unreachable("route non scriptée")))
}

/// Les corps JSON des `POST /v1/pair` émis, dans l'ordre.
@MainActor
private func pairBodies(_ harness: ClientHarness) -> [[String: Any]] {
    harness.transport.requests
        .filter { $0.method == "POST" && $0.path == "/v1/pair" }
        .compactMap { $0.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } }
}
