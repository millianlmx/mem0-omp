// La révocation du jeton (S-9) : 401 sur une route authentifiée = secret effacé,
// état `revoked`, code frais requis, plus aucun échange.

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

@Suite("Révocation")
@MainActor
struct RevocationTests {
    @Test("client-distant-ios/AC-15 : un jeton révoqué est effacé et l'app revient exiger un code frais")
    func revoked() async throws {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        // Les lectures des faits de l'Accueil (S-8, rafraîchies à la connexion)
        // et la demande de relecture des PR (envoyée à l'ouverture du flux)
        // répondent normalement : la révocation de ce test est déclenchée par
        // `version()`, pas par une requête de fond.
        harness.transport.respond { request in
            if request.path == "/v1/components" {
                return .success(ClientHTTPResponse(
                    status: 200,
                    protocolVersion: 1,
                    body: Data(#"{"ompInstalled":true}"#.utf8)
                ))
            }
            if request.path == "/v1/journal" {
                return .success(ClientHTTPResponse(
                    status: 200,
                    protocolVersion: 1,
                    body: Data(#"{"entries":[]}"#.utf8)
                ))
            }
            if request.path == "/v1/pull-request-states/refresh" {
                return .success(ClientHTTPResponse(
                    status: 202,
                    protocolVersion: 1,
                    body: Data(#"{"accepted":true}"#.utf8)
                ))
            }
            return .success(ClientHTTPResponse(
                status: 401,
                protocolVersion: 1,
                body: Data(#"{"error":{"code":"unauthorized"}}"#.utf8)
            ))
        }
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })

        await #expect(throws: ClientError.api(.unauthorized)) {
            _ = try await harness.model.version()
        }
        #expect(await eventually { harness.model.state == .revoked })
        #expect(await harness.tokens.knownTokens.isEmpty, "le secret est effacé du trousseau")
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.deviceId) == nil)

        // Aucune requête n'est émise tant qu'un nouvel appairage n'a pas réussi.
        let before = harness.transport.requestCount
        await #expect(throws: ClientError.notConnected) {
            _ = try await harness.model.version()
        }
        #expect(harness.transport.requestCount == before)

        // Un code frais est la SEULE issue : `POST /v1/pair` échappe au verrou
        // `revoked`, un succès écrit un jeton neuf et quitte l'état `revoked`.
        harness.transport.respond { request in
            if request.path == "/v1/pair" {
                return .success(ClientHTTPResponse(
                    status: 200,
                    protocolVersion: 1,
                    body: Data(#"{"deviceId":"FRESH-1","token":"tok-2","protocolVersion":1}"#.utf8)
                ))
            }
            if request.path == "/v1/components" {
                return .success(ClientHTTPResponse(
                    status: 200,
                    protocolVersion: 1,
                    body: Data(#"{"ompInstalled":true}"#.utf8)
                ))
            }
            if request.path == "/v1/journal" {
                return .success(ClientHTTPResponse(
                    status: 200,
                    protocolVersion: 1,
                    body: Data(#"{"entries":[]}"#.utf8)
                ))
            }
            if request.path == "/v1/pull-request-states/refresh" {
                return .success(ClientHTTPResponse(
                    status: 202,
                    protocolVersion: 1,
                    body: Data(#"{"accepted":true}"#.utf8)
                ))
            }
            return .success(ClientHTTPResponse(
                status: 401,
                protocolVersion: 1,
                body: Data(#"{"error":{"code":"unauthorized"}}"#.utf8)
            ))
        }
        try await harness.model.pair(code: "ABCD2345", deviceName: "iPhone de test")
        #expect(harness.model.pairingFailure == nil)
        #expect(harness.transport.count(method: "POST", path: "/v1/pair") == 1, "l'appairage est bien émis")
        #expect(await harness.tokens.knownTokens == ["fresh-1": "tok-2"])
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.deviceId) == "fresh-1")
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        harness.stop()
    }
}
