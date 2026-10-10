// La doublure du Mac côté paquet : ce que le client lève pour chaque réponse d'erreur
// qu'une lecture peut recevoir (statut conservé, S-1), et le parcours 401 inchangé.

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

/// Ce que la doublure du Mac répond à la lecture visée.
private enum MacReply: Sendable, CustomTestStringConvertible {
    case http(status: Int, body: String)
    case refusedConnection

    var testDescription: String {
        switch self {
        case .http(let status, let body): return "\(status) \(body)"
        case .refusedConnection: return "connexion refusée"
        }
    }
}

private struct MacRow: Sendable, CustomTestStringConvertible {
    let reply: MacReply
    let expected: ClientError
    var testDescription: String { reply.testDescription }
}

/// Un corps d'erreur du contrat, construit par `JSONSerialization` (aucun
/// échappement à la main).
private func envelope(_ code: String, _ message: String? = nil) -> String {
    var inner: [String: Any] = ["code": code]
    if let message { inner["message"] = message }
    let data = (try? JSONSerialization.data(withJSONObject: ["error": inner], options: [.sortedKeys])) ?? Data()
    return String(decoding: data, as: UTF8.self)
}

private let relayDetail = "localhost:8321\nréponse 405 du service ({\"detail\":\"Method Not Allowed\"})"

private let rows: [MacRow] = [
    MacRow(
        reply: .http(status: 404, body: envelope("not_found", "route inconnue")),
        expected: .api(.notFound("route inconnue"))
    ),
    MacRow(
        reply: .http(status: 405, body: #"{"detail":"Method Not Allowed"}"#),
        expected: .unexpectedStatus(405)
    ),
    MacRow(reply: .http(status: 403, body: envelope("forbidden", "x")), expected: .unexpectedStatus(403)),
    MacRow(reply: .http(status: 403, body: "<html></html>"), expected: .unexpectedStatus(403)),
    MacRow(
        reply: .http(status: 503, body: envelope("unavailable", relayDetail)),
        expected: .api(.unavailable(relayDetail))
    ),
    MacRow(
        reply: .http(status: 500, body: envelope("server", "erreur inattendue")),
        expected: .api(.server("erreur inattendue"))
    ),
    MacRow(reply: .http(status: 500, body: "oops"), expected: .unexpectedStatus(500)),
    MacRow(reply: .http(status: 418, body: envelope("teapot")), expected: .unexpectedStatus(418)),
    MacRow(
        reply: .refusedConnection,
        expected: .transport(.unreachable("Could not connect to the server."))
    ),
]

@MainActor
private func connectedHarness(answering reply: MacReply) async -> ClientHarness {
    let harness = ClientHarness(
        tokens: ["d": "tok"],
        preferences: [ClientPreferenceKey.deviceId: "d"]
    )
    // Les lectures de fond de l'Accueil répondent 200 (et la relecture des PR,
    // demandée à chaque ouverture du flux, 202) : seule la lecture visée échoue.
    harness.transport.respond { request in
        if request.path == "/v1/components" {
            return .success(ClientHTTPResponse(
                status: 200, protocolVersion: 1, body: Data(#"{"ompInstalled":true}"#.utf8)
            ))
        }
        if request.path == "/v1/journal" {
            return .success(ClientHTTPResponse(
                status: 200, protocolVersion: 1, body: Data(#"{"entries":[]}"#.utf8)
            ))
        }
        if request.path == "/v1/pull-request-states/refresh" {
            return .success(ClientHTTPResponse(
                status: 202, protocolVersion: 1, body: Data(#"{"accepted":true}"#.utf8)
            ))
        }
        switch reply {
        case .http(let status, let body):
            return .success(ClientHTTPResponse(status: status, protocolVersion: 1, body: Data(body.utf8)))
        case .refusedConnection:
            return .failure(ClientError.transport(.unreachable("Could not connect to the server.")))
        }
    }
    harness.transport.script(.hold)
    harness.model.start()
    #expect(await eventually { harness.model.state == .searching })
    harness.discovery.emit([mac])
    #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
    return harness
}

@Suite("ios-erreurs-serveur-lisibles — la doublure du Mac")
@MainActor
struct ReadFailureTests {
    @Test(
        "ios-erreurs-serveur-lisibles/AC-1 : macDoubleFailuresReachTheCaller — chaque réponse d'erreur du Mac atteint l'appelant avec son statut",
        arguments: rows
    )
    fileprivate func macDoubleFailuresReachTheCaller(_ row: MacRow) async {
        let harness = await connectedHarness(answering: row.reply)
        await #expect(throws: row.expected) {
            _ = try await harness.model.memory(scope: nil, limit: nil)
        }
        harness.stop()
    }

    @Test("ios-erreurs-serveur-lisibles/AC-5 : unauthorizedReadRevokes — un 401 sur une lecture révoque le jeton comme avant")
    func unauthorizedReadRevokes() async {
        let harness = await connectedHarness(
            answering: .http(status: 401, body: envelope("unauthorized"))
        )
        await #expect(throws: ClientError.api(.unauthorized)) {
            _ = try await harness.model.memory(scope: nil, limit: nil)
        }
        #expect(await eventually { harness.model.state == .revoked })
        #expect(await harness.tokens.knownTokens.isEmpty, "le secret est effacé du trousseau")
        // Les appels suivants n'émettent plus rien.
        await #expect(throws: ClientError.notConnected) {
            _ = try await harness.model.memory(scope: nil, limit: nil)
        }
        harness.stop()
    }
}
