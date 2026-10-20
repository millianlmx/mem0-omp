// Le verrou de version d'API (S-8) : dans les deux sens, avec les deux numéros, et
// toutes les routes refusées localement.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@Suite("Version d'API")
@MainActor
struct VersionTests {
    @Test("client-distant-ios/AC-14 : une version différente verrouille — les deux numéros, aucune requête")
    func incompatibleVersion() async throws {
        let local = ConsoleAPI.protocolVersion
        let other = ConsoleAPI.protocolVersion + 1
        // Sens 1 : le TXT Bonjour annonce une autre version → verrou SANS tentative.
        let announced = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        announced.model.start()
        #expect(await eventually { announced.model.state != .unpaired })
        announced.discovery.emitProtocolVersion(other)
        #expect(announced.model.state == .incompatibleProtocol(local: local, remote: other))
        #expect(announced.transport.requestCount == 0, "aucune tentative de connexion")
        // Toute méthode de route est refusée localement, sans un octet.
        await #expect(throws: ClientError.incompatibleProtocol(local: local, remote: other)) {
            _ = try await announced.model.version()
        }
        await #expect(throws: ClientError.incompatibleProtocol(local: local, remote: other)) {
            _ = try await announced.model.components()
        }
        #expect(announced.transport.requestCount == 0)
        announced.stop()

        // Sens 2 : c'est la RÉPONSE qui porte une autre version → verrou, deux numéros.
        let answered = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        answered.transport.respond { _ in
            .success(ClientHTTPResponse(
                status: 200,
                protocolVersion: other,
                body: Data(#"{"protocolVersion":\#(other)}"#.utf8)
            ))
        }
        _ = answered.model.setManualAddress("10.0.0.5:9000")
        await #expect(throws: ClientError.incompatibleProtocol(local: local, remote: other)) {
            _ = try await answered.model.version()
        }
        #expect(answered.model.state == .incompatibleProtocol(local: local, remote: other))
        // `retry()` est la seule sortie du verrou.
        answered.model.retry()
        #expect(answered.model.state != .incompatibleProtocol(local: local, remote: other))
        answered.stop()
    }

    @Test("reponse-ios-sans-identifiant-de-question/AC-4 : une app de la version précédente se verrouille face au Mac")
    func previousVersionAppLocksAgainstTheMac() async throws {
        let previous = ConsoleAPI.protocolVersion - 1
        let mac = ConsoleAPI.protocolVersion
        #expect(previous == 2 && mac == 3, "le critère vise l'app 2 face au Mac 3")
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            localProtocolVersion: previous
        )
        harness.transport.respond { _ in
            .success(ClientHTTPResponse(
                status: 200,
                protocolVersion: mac,
                body: Data(#"{"protocolVersion":\#(mac)}"#.utf8)
            ))
        }
        _ = harness.model.setManualAddress("10.0.0.5:9000")
        await #expect(throws: ClientError.incompatibleProtocol(local: previous, remote: mac)) {
            _ = try await harness.model.version()
        }
        #expect(harness.model.state == .incompatibleProtocol(local: previous, remote: mac))
        // Verrouillée, l'app ne lit plus rien : la lecture est refusée localement.
        let sent = harness.transport.requestCount
        await #expect(throws: ClientError.incompatibleProtocol(local: previous, remote: mac)) {
            _ = try await harness.model.components()
        }
        #expect(harness.transport.requestCount == sent, "aucune requête ne part")
        harness.stop()
    }

    @Test("ios-graphe-memoire-405-erreur-brute/AC-3 : le code outdated_service est décodé en .api(.outdatedService), un code inconnu retombe sur le statut")
    func outdatedServiceCodeIsDecoded() {
        let outdated = Data(#"{"error":{"code":"outdated_service","message":"m"}}"#.utf8)
        #expect(
            ClientErrorMapping.translate(status: 503, protocolVersion: 1, body: outdated, localVersion: 1)
                == .api(.outdatedService("m"))
        )
        let unknown = Data(#"{"error":{"code":"futur","message":"m"}}"#.utf8)
        #expect(
            ClientErrorMapping.translate(status: 503, protocolVersion: 1, body: unknown, localVersion: 1)
                == .api(.unavailable("m"))
        )
    }

    /// Une réponse de la doublure : statut, corps, erreur attendue du client.
    struct StatusCase: Sendable, CustomTestStringConvertible {
        let status: Int
        let body: String
        let expected: ClientError
        var testDescription: String { "\(status) \(body)" }
    }

    nonisolated static let statusCases: [StatusCase] = [
        StatusCase(status: 403, body: "oops", expected: .unexpectedStatus(403)),
        StatusCase(status: 404, body: "oops", expected: .unexpectedStatus(404)),
        StatusCase(status: 405, body: "oops", expected: .unexpectedStatus(405)),
        StatusCase(status: 500, body: "oops", expected: .unexpectedStatus(500)),
        StatusCase(status: 503, body: "oops", expected: .unexpectedStatus(503)),
        StatusCase(status: 403, body: "", expected: .unexpectedStatus(403)),
        StatusCase(status: 405, body: #"{"detail":"Method Not Allowed"}"#, expected: .unexpectedStatus(405)),
        StatusCase(status: 418, body: #"{"error":{"code":"teapot"}}"#, expected: .unexpectedStatus(418)),
        StatusCase(status: 403, body: #"{"error":{"code":"forbidden","message":"x"}}"#, expected: .unexpectedStatus(403)),
        StatusCase(status: 404, body: #"{"error":{"code":"futur","message":"m"}}"#, expected: .api(.notFound("m"))),
    ]

    @Test(
        "ios-erreurs-serveur-lisibles/AC-1 : translateKeepsStatusWithoutEnvelope — le statut survit quand l'enveloppe manque ou que le code est inconnu",
        arguments: statusCases
    )
    func translateKeepsStatusWithoutEnvelope(_ row: StatusCase) {
        let error = ClientErrorMapping.translate(
            status: row.status,
            protocolVersion: 1,
            body: Data(row.body.utf8),
            localVersion: 1
        )
        #expect(error == row.expected)
    }

    @Test("un Mac sans en-tête de version donne un verrou à numéro distant nul")
    func missingHeaderLocks() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.respond { _ in
            .success(ClientHTTPResponse(
                status: 200,
                protocolVersion: nil,
                body: Data(#"{"protocolVersion":\#(ConsoleAPI.protocolVersion)}"#.utf8)
            ))
        }
        _ = harness.model.setManualAddress("10.0.0.5:9000")
        await #expect(throws: ClientError.incompatibleProtocol(local: ConsoleAPI.protocolVersion, remote: nil)) {
            _ = try await harness.model.version()
        }
        #expect(harness.model.state == .incompatibleProtocol(local: ConsoleAPI.protocolVersion, remote: nil))
        harness.stop()
    }
}
