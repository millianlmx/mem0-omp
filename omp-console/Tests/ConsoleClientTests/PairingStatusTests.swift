// Le statut d'appairage publié par le client (S-1 de connexion-ios-feuille-intrusive-et-sans) :
// la seule source de l'ouverture automatique de la feuille Connexion. Une panne de
// transport ne le change jamais ; seul un 401 sur une route authentifiée ou sur le
// flux le fait passer à `.refused`, qui n'est pas persisté.

@testable import ConsoleClient
import Combine
import ConsoleCore
import Foundation
import Testing

@MainActor
private let manualEndpoint = ClientEndpoint.manual(host: "192.168.1.20", port: 8787)

@MainActor
private let bonjourMac = DiscoveredMac(
    name: "OMP Console",
    endpoint: .bonjour(name: "OMP Console", host: "192.168.1.12", port: 8787)
)

/// Rend 200 aux lectures de fond de l'Accueil (202 à la relecture des PR demandée
/// à chaque ouverture du flux), 401 à tout le reste.
private func homeFactsOr401(_ request: ClientHTTPRequest) -> Result<ClientHTTPResponse, Error> {
    switch request.path {
    case "/v1/components":
        return .success(ClientHTTPResponse(status: 200, protocolVersion: 1, body: Data(#"{"ompInstalled":true}"#.utf8)))
    case "/v1/journal":
        return .success(ClientHTTPResponse(status: 200, protocolVersion: 1, body: Data(#"{"entries":[]}"#.utf8)))
    case "/v1/pull-request-states/refresh":
        return .success(ClientHTTPResponse(status: 202, protocolVersion: 1, body: Data(#"{"accepted":true}"#.utf8)))
    case "/v1/pair":
        return .success(ClientHTTPResponse(
            status: 200,
            protocolVersion: 1,
            body: Data(#"{"deviceId":"FRESH-1","token":"tok-2","protocolVersion":1}"#.utf8)
        ))
    default:
        return .success(ClientHTTPResponse(
            status: 401,
            protocolVersion: 1,
            body: Data(#"{"error":{"code":"unauthorized"}}"#.utf8)
        ))
    }
}

/// Enregistre chaque valeur publiée de `pairing`, valeur initiale comprise.
@MainActor
private final class PairingRecorder {
    private(set) var values: [ClientPairingStatus] = []
    private var cancellable: AnyCancellable?

    init(_ model: ConsoleClientModel) {
        cancellable = model.$pairing.sink { [weak self] value in self?.values.append(value) }
    }
}

@Suite("Statut d'appairage")
@MainActor
struct PairingStatusTests {
    @Test("connexion-ios-feuille-intrusive-et-sans/AC-1 : un appareil appairé publie .restoring puis .paired, sans .unpaired intermédiaire")
    func pairedLaunchNeverPublishesUnpaired() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d", ClientPreferenceKey.manualAddress: "192.168.1.20:8787"]
        )
        harness.transport.respond { request in
            request.path == "/v1/components" || request.path == "/v1/journal"
                ? homeFactsOr401(request)
                : .success(ClientHTTPResponse(status: 200, protocolVersion: 1, body: Data("{}".utf8)))
        }
        harness.transport.script(.hold)
        let recorder = PairingRecorder(harness.model)
        #expect(harness.model.pairing == .restoring, "avant start(), le trousseau n'est pas lu")

        harness.model.start()
        #expect(harness.model.pairing == .restoring, "start() lance la lecture sans la conclure")
        #expect(await eventually { harness.model.state == .connected(endpoint: manualEndpoint) })
        #expect(harness.model.pairing == .paired)
        #expect(recorder.values == [.restoring, .paired], "la feuille ne doit voir aucun passage à .unpaired")
        harness.stop()
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-2 : une panne de transport laisse l'appareil .paired, état macAbsent")
    func transportFailureKeepsPaired() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d", ClientPreferenceKey.manualAddress: "192.168.1.20:8787"],
            pacerLimit: 0
        )
        harness.transport.script(.failure(ClientError.transport(.unreachable("connexion refusée"))))
        let recorder = PairingRecorder(harness.model)
        harness.model.start()
        #expect(await eventually { harness.model.state == .macAbsent(endpoint: manualEndpoint) })
        #expect(harness.model.pairing == .paired)
        #expect(!recorder.values.contains(.unpaired))
        #expect(!recorder.values.contains { if case .refused = $0 { return true } else { return false } })

        // L'absence de réseau ne le change pas davantage.
        harness.path.emit(false)
        #expect(harness.model.state == .noNetwork)
        #expect(harness.model.pairing == .paired)
        harness.stop()
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-3 : sans jeton, le statut passe de .restoring à .unpaired")
    func noTokenIsUnpaired() async {
        let harness = ClientHarness()
        let recorder = PairingRecorder(harness.model)
        harness.model.start()
        #expect(await eventually { harness.model.pairing == .unpaired })
        #expect(recorder.values == [.restoring, .unpaired])

        // Un `deviceId` mémorisé sans jeton au trousseau compte comme une absence.
        let orphan = ClientHarness(preferences: [ClientPreferenceKey.deviceId: "d"])
        orphan.model.start()
        #expect(await eventually { orphan.model.pairing == .unpaired })
        harness.stop()
        orphan.stop()
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-4 : un 401 sur le flux donne .refused vers l'endpoint refusé, et un relancement donne .unpaired")
    func streamRefusalThenRelaunch() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d", ClientPreferenceKey.manualAddress: "192.168.1.20:8787"]
        )
        harness.transport.script(.failure(ClientError.api(.unauthorized)))
        let recorder = PairingRecorder(harness.model)
        harness.model.start()
        #expect(await eventually { harness.model.pairing == .refused(endpoint: manualEndpoint) })
        #expect(harness.model.state == .revoked)
        #expect(await harness.tokens.knownTokens.isEmpty, "l'ancien jeton est effacé")
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.deviceId) == nil)
        #expect(
            recorder.values.filter { if case .refused = $0 { return true } else { return false } }.count == 1,
            "un seul passage à .refused"
        )
        // L'adresse préremplie de la feuille : `hôte:port`, sans nom Bonjour.
        #expect(manualEndpoint.address == "192.168.1.20:8787")
        harness.stop()

        // Relancement : nouveau modèle sur les MÊMES trousseau et préférences.
        let relaunched = ConsoleClientModel(
            transport: harness.transport,
            discovery: ScriptedDiscovery(),
            preferences: harness.preferences,
            tokens: harness.tokens,
            pacer: RecordingPacer(),
            pathSource: ScriptedPathSource()
        )
        let after = PairingRecorder(relaunched)
        relaunched.start()
        #expect(await eventually { relaunched.pairing == .unpaired })
        #expect(after.values == [.restoring, .unpaired], "le refus n'est pas persisté")
        relaunched.stop()
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-4 : un 401 sur une lecture donne .refused, et l'appairage depuis le refus part vers l'endpoint refusé")
    func pairFromRefusedTargetsRefusedEndpoint() async throws {
        let harness = ClientHarness(tokens: ["d": "tok"], preferences: [ClientPreferenceKey.deviceId: "d"])
        harness.transport.respond(homeFactsOr401)
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([bonjourMac])
        #expect(await eventually { harness.model.state == .connected(endpoint: bonjourMac.endpoint) })

        // Deux 401 concurrents : un seul passage à `.refused`.
        let recorder = PairingRecorder(harness.model)
        async let first: Int? = try? harness.model.version()
        async let second: Int? = try? harness.model.version()
        _ = await (first, second)
        #expect(await eventually { harness.model.pairing == .refused(endpoint: bonjourMac.endpoint) })
        #expect(recorder.values.filter { $0 == .refused(endpoint: bonjourMac.endpoint) }.count == 1)
        #expect(bonjourMac.endpoint.address == "192.168.1.12:8787", "le préremplissage ne porte pas le nom Bonjour")

        // Le Mac n'est plus découvert et aucune adresse n'est posée : l'appairage
        // part quand même vers l'endpoint refusé.
        harness.discovery.emit([])
        #expect(harness.model.effectiveEndpoint == nil)
        #expect(harness.model.pairing == .refused(endpoint: bonjourMac.endpoint), "seul forget() ou un appairage met fin au refus")
        try await harness.model.pair(code: "ABCD2345", deviceName: "iPhone de test")
        #expect(harness.model.pairingFailure == nil)
        let pairIndex = harness.transport.requests.lastIndex { $0.path == "/v1/pair" }
        #expect(pairIndex.map { harness.transport.endpoints[$0] } == bonjourMac.endpoint)
        #expect(harness.model.pairing == .paired, "un appairage réussi met fin au refus")
        harness.stop()
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-4 : l'adresse préremplie est hôte:port, IPv6 entre crochets, sans zone ni nom d'instance")
    func endpointAddress() {
        #expect(ClientEndpoint.manual(host: "mac.local", port: 8787).address == "mac.local:8787")
        #expect(ClientEndpoint.manual(host: "mac.local", port: 8787).address
            == ClientEndpoint.manual(host: "mac.local", port: 8787).display)
        #expect(ClientEndpoint.bonjour(name: "OMP Console", host: "10.0.0.2", port: 9000).address == "10.0.0.2:9000")
        #expect(ClientEndpoint.bonjour(name: "OMP Console", host: "fe80::1%en0", port: 8787).address == "[fe80::1]:8787")
        #expect(ClientEndpoint.bonjour(name: "OMP Console", host: "192.168.1.175%en0", port: 8787).address == "192.168.1.175:8787")
    }
}
