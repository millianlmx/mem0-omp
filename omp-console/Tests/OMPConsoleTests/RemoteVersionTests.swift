// Preuves de S-4 : la version du socle sur chaque réponse, et le refus d'un
// client incompatible par le code partagé — sans données.

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

@Suite("Remote version de protocole")
@MainActor
struct RemoteVersionTests {
    @Test("api-distante-du-console/AC-22 : chaque réponse d'une route servie porte la version du socle")
    func everyServedResponseCarriesTheBaseVersion() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Téléphone")

        // Toutes les routes de LECTURE de la table répondent avec l'en-tête, que la
        // réponse soit un succès ou une erreur.
        let readRoutes = [
            "/v1/version",
            "/v1/store",
            "/v1/sessions",
            "/v1/projects",
            "/v1/stats",
            "/v1/devices",
            "/v1/memory/page",
        ]
        for path in readRoutes {
            let reply = try await stack.call("GET", path, token: token)
            #expect(reply.headers["x-console-protocol-version"] == "1", "\(path) → \(reply.status)")
        }

        // La route d'appairage, non authentifiée, la porte aussi.
        let code = try stack.registry.generateCode().value
        let paired = try await stack.call("POST", "/v1/pair", json: ["code": code, "name": "Téléphone"])
        #expect(paired.status == 200)
        #expect(paired.headers["x-console-protocol-version"] == "1")

        // Et les ERREURS aussi : non autorisé, inconnu, version refusée.
        let unauthorized = try await stack.call("GET", "/v1/devices")
        let notFound = try await stack.call("GET", "/v1/route-qui-n-existe-pas", token: token)
        let incompatible = try await stack.call("GET", "/v1/version", token: token, protocolVersion: 2)
        #expect(unauthorized.status == 401)
        #expect(notFound.status == 404)
        #expect(incompatible.status == 400)
        for reply in [unauthorized, notFound, incompatible] {
            #expect(reply.headers["x-console-protocol-version"] == "1", "erreur \(reply.status)")
        }
    }

    @Test("api-distante-du-console/AC-23 : une version incompatible est refusée par le code partagé, sans données")
    func incompatibleVersionIsRefusedByTheSharedCodeWithoutData() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Téléphone")

        // (1) Une route de lecture, AVEC un jeton valide : la version est refusée avant tout.
        let version = try await stack.call("GET", "/v1/version", token: token, protocolVersion: 2)
        #expect(version.status == 400)
        #expect(version.errorCode == "incompatible_protocol")
        let versionObject = try #require(try JSONSerialization.jsonObject(with: version.body) as? [String: Any])
        #expect(Set(versionObject.keys) == ["error"])
        #expect(!version.text.contains("protocolVersion"))

        // (2) La route d'appairage est refusée de la même façon, jeton ou pas.
        let paired = try await stack.call(
            "POST",
            "/v1/pair",
            json: ["code": "ABCDEFGH", "name": "Téléphone"],
            protocolVersion: 2
        )
        #expect(paired.status == 400)
        #expect(paired.errorCode == "incompatible_protocol")
        let pairObject = try #require(try JSONSerialization.jsonObject(with: paired.body) as? [String: Any])
        #expect(Set(pairObject.keys) == ["error"])
    }

    // MARK: - Cas limites de l'en-tête

    @Test func absentHeaderIsBadRequest() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Téléphone")

        let reply = try await stack.call("GET", "/v1/version", token: token, omitProtocolHeader: true)
        #expect(reply.status == 400)
        #expect(reply.errorCode == "bad_request")
    }

    @Test func malformedHeadersAreBadRequest() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Téléphone")

        for raw in ["abc", "+1", "01", "1.0", ""] {
            let reply = try await stack.call(
                "GET",
                "/v1/version",
                token: token,
                headers: [ConsoleAPI.Service.protocolHeader: raw],
                protocolVersion: nil
            )
            #expect(reply.status == 400, "valeur « \(raw) »")
            #expect(reply.errorCode == "bad_request")
        }
    }

    @Test func duplicateHeaderIsBadRequest() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Téléphone")

        // Deux en-têtes de version : `URLRequest` n'en écrit qu'un, on parle brut.
        let request = """
            GET /v1/version HTTP/1.1\r
            Host: 127.0.0.1\r
            X-Console-Protocol-Version: 1\r
            X-Console-Protocol-Version: 1\r
            Authorization: Bearer \(token)\r
            \r

            """
        let response = try await rawConsoleExchange(port: stack.port, request)
        #expect(rawConsoleStatus(response) == 400)
        #expect(response.contains("\"bad_request\""))
    }

    @Test func trailingSpaceIsAcceptedAfterTrim() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Téléphone")

        let request = """
            GET /v1/version HTTP/1.1\r
            Host: 127.0.0.1\r
            X-Console-Protocol-Version: 1 \r
            Authorization: Bearer \(token)\r
            \r

            """
        let response = try await rawConsoleExchange(port: stack.port, request)
        #expect(rawConsoleStatus(response) == 200)
        #expect(response.contains(#"{"protocolVersion":1}"#))
    }

    @Test func versionRouteAnswersTheBaseVersion() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair(name: "Téléphone")

        let reply = try await stack.call("GET", "/v1/version", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteVersionPayload.self)
        #expect(payload.protocolVersion == ConsoleAPI.protocolVersion)
        #expect(reply.text == #"{"protocolVersion":1}"#)
    }
}
