// Le décodage des charges utiles miroir : les clés JSON sont celles du dépôt, et
// les modèles publics de `ConsoleCore` se décodent tels quels.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@Suite("Charges utiles")
@MainActor
struct PayloadDecodingTests {
    @Test("un instantané du magasin se décode dans la charge utile miroir")
    func storePayload() throws {
        let snapshot = ClientFixtures.snapshot()
        let inner = try JSONEncoder().encode(snapshot)
        let data = Data(#"{"snapshot":"#.utf8) + inner + Data("}".utf8)
        let payload = try JSONDecoder().decode(RemoteStorePayload.self, from: data)
        #expect(payload.snapshot == snapshot)
    }

    @Test("les évènements du flux se décodent depuis les trames du serveur")
    func streamEvents() {
        var parser = ClientStreamParser()
        let hello = ClientFixtures.frame("hello", #"{"protocolVersion":1}"#)
        let devices = ClientFixtures.frame(
            "devices",
            #"{"devices":[{"id":"a","name":"iPhone","pairedAtMs":1,"lastSeenAtMs":2,"connected":true}]}"#
        )
        let events = parser.consume(hello + devices)
        #expect(events.count == 2)
        #expect(events.first == .hello(RemoteHelloEvent(protocolVersion: 1)))
        if case .devices(let event) = events.last {
            #expect(event.devices.count == 1)
            #expect(event.devices[0].name == "iPhone")
        } else {
            Issue.record("trame devices non décodée")
        }
    }

    @Test("les miroirs conduite et dépôts se décodent, et les libellés de contrôle sont ceux de la coque")
    func conduiteAndReposPayloads() throws {
        let repos = try JSONDecoder().decode(
            RemoteReposPayload.self,
            from: Data(#"{"rows":[{"repoKey":"k","repoRoot":"/tmp/r","name":"r"}]}"#.utf8)
        )
        #expect(repos.rows.first == RemoteRepoRow(repoKey: "k", repoRoot: "/tmp/r", name: "r"))

        let conduite = try JSONDecoder().decode(
            RemoteConduiteStatePayload.self,
            from: Data(
                #"{"state":"live","repoKey":"k","name":"P","repoRoot":"/tmp/r","status":{"text":"Active","tone":"success"},"dialogs":[]}"#
                    .utf8
            )
        )
        #expect(conduite.state == "live")
        #expect(conduite.repoKey == "k")
        #expect(conduite.name == "P")
        #expect(conduite.repoRoot == "/tmp/r")
        #expect(conduite.status == ConsoleStatus(text: "Active", tone: .success))
        #expect(conduite.dialogs.isEmpty)

        // Le miroir réduit tolère l'absence de l'identité (`none`/`closed`).
        let empty = try JSONDecoder().decode(
            RemoteConduiteStatePayload.self,
            from: Data(#"{"state":"none","dialogs":[]}"#.utf8)
        )
        #expect(empty.repoKey == nil && empty.name == nil && empty.status == nil)

        #expect(RequiredCheck.ubuntu.id == "ubuntu")
        #expect(RequiredCheck.macos.id == "macos")
        #expect(RequiredCheck.releaseSimulation.id == "release-simulation")
        #expect(PRCheckState.green.label == "vert")
        #expect(PRCheckState.red.label == "rouge")
        #expect(PRCheckState.pending.label == "en cours")
        #expect(PRCheckState.ignored.label == "ignoré")
    }

    @Test("une trame de nom inconnu est ignorée sans couper le flux")
    func unknownFrame() {
        var parser = ClientStreamParser()
        let events = parser.consume(
            ClientFixtures.frame("futur", #"{"x":1}"#) + ClientFixtures.frame("hello", #"{"protocolVersion":1}"#)
        )
        #expect(events == [.unknown("futur"), .hello(RemoteHelloEvent(protocolVersion: 1))])
    }
}
