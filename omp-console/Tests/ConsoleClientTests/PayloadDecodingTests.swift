// Le décodage des trames du flux : les clés JSON sont celles du Mac, et une trame
// inconnue est ignorée sans couper le flux.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@Suite("Charges utiles")
@MainActor
struct PayloadDecodingTests {
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

    @Test("une trame de nom inconnu est ignorée sans couper le flux")
    func unknownFrame() {
        var parser = ClientStreamParser()
        let events = parser.consume(
            ClientFixtures.frame("futur", #"{"x":1}"#) + ClientFixtures.frame("hello", #"{"protocolVersion":1}"#)
        )
        #expect(events == [.unknown("futur"), .hello(RemoteHelloEvent(protocolVersion: 1))])
    }

    @Test("la trame `components` se décode dans son miroir")
    func componentsFrame() {
        var parser = ClientStreamParser()
        let components = ClientFixtures.frame(
            "components",
            #"{"ompInstalled":false,"ompPath":null,"setupBanner":"Préparation en cours"}"#
        )
        let events = parser.consume(components)
        #expect(events == [.components(RemoteComponentsPayload(
            ompInstalled: false, ompPath: nil, setupBanner: "Préparation en cours"
        ))])
    }
}
