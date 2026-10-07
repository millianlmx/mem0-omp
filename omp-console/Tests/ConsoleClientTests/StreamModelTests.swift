// Le modèle observable du flux temps réel (S-2) : les trames mettent à jour les
// valeurs publiées SANS aucun rechargement (AC-11), et un geste rend le résultat
// typé de la route puis la trame `store` qui suit (AC-12).

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
    @Test("client-distant-ios/AC-11 : une trame store met à jour snapshot sans rechargement")
    func storeFrameUpdatesSnapshot() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        let before = harness.transport.requestCount
        let snapshot = ClientFixtures.snapshot()
        harness.transport.push(ClientFixtures.storeFrame(snapshot))
        #expect(await eventually { harness.model.snapshot == snapshot })
        #expect(harness.transport.requestCount == before, "aucune requête émise à la réception d'une trame")
        harness.stop()
    }

    @Test("client-distant-ios/AC-12 : un geste rend le résultat typé et la trame store qui suit")
    func gestureThenStore() async throws {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.respond { request in
            if request.path == "/v1/cards/c1/reply" {
                return .success(ClientHTTPResponse(
                    status: 202,
                    protocolVersion: 1,
                    body: Data(#"{"accepted":true}"#.utf8)
                ))
            }
            return .failure(ClientError.transport(.unreachable("route non scriptée")))
        }
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        let accepted = try await harness.model.reply(cardId: "c1", text: "ok")
        #expect(accepted.accepted)
        let snapshot = ClientFixtures.snapshot()
        harness.transport.push(ClientFixtures.storeFrame(snapshot))
        #expect(await eventually { harness.model.snapshot == snapshot })
        harness.stop()
    }

    @Test("le flux décode les trames devices et sessions, et borne les mises à jour")
    func streamEventsApplied() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        harness.transport.push(ClientFixtures.frame(
            "devices",
            #"{"devices":[{"id":"a","name":"iPhone","pairedAtMs":1,"lastSeenAtMs":2,"connected":true}]}"#
        ))
        #expect(await eventually { harness.model.devices.count == 1 })
        harness.transport.push(ClientFixtures.frame("sessions", #"{"file":"/tmp/x.jsonl"}"#))
        #expect(await eventually { harness.model.sessionUpdates.count == 1 })
        harness.stop()
    }
}
