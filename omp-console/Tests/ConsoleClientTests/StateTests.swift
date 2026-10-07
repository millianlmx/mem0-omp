// L'état HONNÊTE (S-10) : la table de priorité rend un état déterministe, et ce
// que le client ne peut pas distinguer se dit en un seul état.

@testable import ConsoleClient
import ConsoleCore
import Testing

@MainActor
private let mac = DiscoveredMac(
    name: "OMP Console",
    endpoint: .bonjour(name: "OMP Console", host: "192.168.1.12", port: 8787)
)

@MainActor
private let macEndpoint = ClientEndpoint.bonjour(name: "OMP Console", host: "192.168.1.12", port: 8787)

@Suite("État honnête")
@MainActor
struct StateTests {
    @Test("client-distant-ios/AC-16 : sans réseau, l'état est « hors réseau », jamais « Mac absent » ni « connecté »")
    func noNetwork() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.path.emit(false)
        #expect(harness.model.state == .noNetwork)
        #expect(harness.model.state != .macAbsent(endpoint: macEndpoint))
        harness.stop()
    }

    @Test("client-distant-ios/AC-17 : coque injoignable → « Mac absent » nommant l'endpoint tenté")
    func macAbsentNamesEndpoint() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            pacerLimit: 2
        )
        harness.transport.script(.failure(ClientError.transport(.unreachable("connexion refusée"))))
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        _ = harness.model.setManualAddress("10.0.0.5:9000")
        let wanted = ClientEndpoint.manual(host: "10.0.0.5", port: 9000)
        #expect(await eventually { harness.model.state == .macAbsent(endpoint: wanted) })
        #expect(harness.model.state.endpoint?.display == "10.0.0.5:9000")
        harness.stop()
    }

    @Test("client-distant-ios/AC-18 : une fermeture silencieuse rend le MÊME état honnête qu'un Mac absent")
    func silentCloseIsSameAsAbsent() async {
        func settled(_ error: ClientError) async -> ClientState {
            let harness = ClientHarness(
                tokens: ["d": "tok"],
                preferences: [ClientPreferenceKey.deviceId: "d"],
                pacerLimit: 2
            )
            harness.transport.script(.failure(error))
            harness.model.start()
            _ = await eventually { harness.model.state == .searching }
            _ = harness.model.setManualAddress("10.0.0.5:9000")
            let wanted = ClientEndpoint.manual(host: "10.0.0.5", port: 9000)
            _ = await eventually { harness.model.state == .macAbsent(endpoint: wanted) }
            let state = harness.model.state
            harness.stop()
            return state
        }
        let closed = await settled(.transport(.closed("flux fermé par l'autre bout")))
        let unreachable = await settled(.transport(.unreachable("hôte muet")))
        #expect(closed == unreachable)
        #expect(closed == .macAbsent(endpoint: .manual(host: "10.0.0.5", port: 9000)))
        #expect(closed.endpoint?.display == "10.0.0.5:9000")
    }

    @Test("la table de priorité : réseau puis jeton, jamais une cause inventée")
    func priorityTable() {
        let withToken = ClientFacts(hasNetwork: false, hasToken: true)
        #expect(ClientStateMachine.resolve(withToken) == .noNetwork)
        let revoked = ClientFacts(revoked: true, incompatible: ClientIncompatibility(local: 1, remote: 2))
        #expect(ClientStateMachine.resolve(revoked) == .revoked)
        let locked = ClientFacts(incompatible: ClientIncompatibility(local: 1, remote: nil), hasToken: true)
        #expect(ClientStateMachine.resolve(locked) == .incompatibleProtocol(local: 1, remote: nil))
        let idle = ClientFacts(hasToken: false, lastFailure: .manual(host: "1.2.3.4", port: 8787))
        #expect(ClientStateMachine.resolve(idle) == .unpaired)
    }
}
