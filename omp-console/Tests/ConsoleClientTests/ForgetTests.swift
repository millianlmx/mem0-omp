// « Oublier ce Mac » côté client (S-4 de connexion-ios-feuille-intrusive-et-sans) :
// la révocation est tentée AU MIEUX, seulement quand le Mac est joint, puis l'oubli
// local se fait quelle que soit l'issue. Aucun 401 reçu pendant ou après l'oubli ne
// fait passer le statut à `.refused`.

@testable import ConsoleClient
import Combine
import ConsoleCore
import Foundation
import Testing

@MainActor
private let manualEndpoint = ClientEndpoint.manual(host: "192.168.1.20", port: 8787)

private func reply(_ status: Int, _ json: String) -> Result<ClientHTTPResponse, Error> {
    .success(ClientHTTPResponse(status: status, protocolVersion: 1, body: Data(json.utf8)))
}

/// 200 aux lectures de fond de l'Accueil ; `other` décide du reste.
private func homeFacts(
    or other: @escaping @Sendable (ClientHTTPRequest) -> Result<ClientHTTPResponse, Error>
) -> @Sendable (ClientHTTPRequest) -> Result<ClientHTTPResponse, Error> {
    { request in
        switch request.path {
        case "/v1/components": return reply(200, #"{"ompInstalled":true}"#)
        case "/v1/journal": return reply(200, #"{"entries":[]}"#)
        default: return other(request)
        }
    }
}

private let unauthorized = reply(401, #"{"error":{"code":"unauthorized"}}"#)

@MainActor
private func pairedHarness(pacerLimit: Int = Int.max) -> ClientHarness {
    ClientHarness(
        tokens: ["d": "tok"],
        preferences: [ClientPreferenceKey.deviceId: "d", ClientPreferenceKey.manualAddress: "192.168.1.20:8787"],
        pacerLimit: pacerLimit
    )
}

/// Vrai si un `.refused` a été publié.
@MainActor
private final class RefusalWatch {
    private(set) var sawRefused = false
    private var cancellable: AnyCancellable?

    init(_ model: ConsoleClientModel) {
        cancellable = model.$pairing.sink { [weak self] value in
            if case .refused = value { self?.sawRefused = true }
        }
    }
}

@Suite("Oublier ce Mac")
@MainActor
struct ForgetTests {
    @Test("connexion-ios-feuille-intrusive-et-sans/AC-10 : connecté, l'oubli émet UN DELETE /v1/devices/self avec le jeton puis efface tout localement")
    func connectedForgetRevokesThenForgets() async {
        let harness = pairedHarness()
        harness.transport.respond(homeFacts { _ in reply(200, #"{"accepted":true}"#) })
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .connected(endpoint: manualEndpoint) })
        #expect(harness.model.pairing == .paired)

        await harness.model.forget()

        #expect(harness.transport.count(method: "DELETE", path: "/v1/devices/self") == 1)
        let index = harness.transport.requests.firstIndex { $0.method == "DELETE" && $0.path == "/v1/devices/self" }
        #expect(index.map { harness.transport.endpoints[$0] } == manualEndpoint, "vers l'endpoint connecté")
        #expect(index.map { harness.transport.tokens[$0] } == "tok", "avec le jeton de l'appareil")
        #expect(await harness.tokens.knownTokens.isEmpty, "jeton retiré du trousseau")
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.deviceId) == nil)
        #expect(harness.model.pairing == .unpaired)
        #expect(harness.model.state == .unpaired)
        #expect(harness.model.pairingFailure == nil)
        // L'adresse manuelle est CONSERVÉE : la feuille la garde pour un nouvel appairage.
        #expect(harness.model.manualAddress?.text == "192.168.1.20:8787")
        #expect(harness.model.effectiveEndpoint == manualEndpoint)

        // Le flux est coupé : aucun nouveau flux n'est ouvert sans jeton.
        let streams = harness.transport.count(method: "GET", path: "/v1/stream")
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(harness.transport.count(method: "GET", path: "/v1/stream") == streams)
        harness.stop()
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-10 : un 401 sur le DELETE, sur le flux ou sur une lecture concurrente ne donne jamais .refused")
    func unauthorizedDuringForgetNeverRefuses() async {
        let harness = pairedHarness()
        harness.transport.respond(homeFacts { _ in reply(200, "{}") })
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .connected(endpoint: manualEndpoint) })
        let watch = RefusalWatch(harness.model)

        // Le Mac a déjà oublié l'appareil : TOUT rend 401, flux compris.
        harness.transport.respond { _ in unauthorized }
        harness.transport.script(.failure(ClientError.api(.unauthorized)))
        async let reading: Int? = try? harness.model.version()
        await harness.model.forget()
        _ = await reading
        // Une lecture après l'oubli rend 401 elle aussi.
        _ = try? await harness.model.version()
        try? await Task.sleep(nanoseconds: 50_000_000)

        #expect(harness.transport.count(method: "DELETE", path: "/v1/devices/self") == 1)
        #expect(!watch.sawRefused, "un 401 pendant ou après l'oubli n'est pas un refus du jeton")
        #expect(harness.model.pairing == .unpaired)
        #expect(harness.model.state == .unpaired)
        #expect(await harness.tokens.knownTokens.isEmpty)
        harness.stop()
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-11 : Mac injoignable, l'oubli n'émet aucune requête et se fait quand même ; un relancement est non appairé")
    func macAbsentForgetIsLocalOnly() async {
        let harness = pairedHarness(pacerLimit: 0)
        harness.transport.respond(homeFacts { _ in reply(200, #"{"accepted":true}"#) })
        harness.transport.script(.failure(ClientError.transport(.unreachable("connexion refusée"))))
        harness.model.start()
        #expect(await eventually { harness.model.state == .macAbsent(endpoint: manualEndpoint) })
        #expect(harness.model.pairing == .paired)
        let before = harness.transport.requestCount

        await harness.model.forget()

        #expect(harness.transport.count(method: "DELETE", path: "/v1/devices/self") == 0)
        #expect(harness.transport.requestCount == before, "aucune requête : la révocation n'est tentée que Mac joint")
        #expect(await harness.tokens.knownTokens.isEmpty)
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.deviceId) == nil)
        #expect(harness.model.pairing == .unpaired)
        #expect(harness.model.state == .unpaired)
        #expect(harness.model.manualAddress?.text == "192.168.1.20:8787")
        harness.stop()

        // Relancement sur les mêmes magasins : non appairé.
        let relaunched = ConsoleClientModel(
            transport: harness.transport,
            discovery: ScriptedDiscovery(),
            preferences: harness.preferences,
            tokens: harness.tokens,
            pacer: RecordingPacer(limit: 0),
            pathSource: ScriptedPathSource()
        )
        relaunched.start()
        #expect(await eventually { relaunched.pairing == .unpaired })
        #expect(relaunched.state == .unpaired)
        relaunched.stop()
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-11 : une panne de transport sur le DELETE n'empêche pas l'oubli local")
    func transportFailureOnDeleteStillForgets() async {
        let harness = pairedHarness()
        harness.transport.respond(homeFacts { request in
            request.method == "DELETE"
                ? .failure(ClientError.transport(.unreachable("délai dépassé")))
                : reply(200, "{}")
        })
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .connected(endpoint: manualEndpoint) })

        await harness.model.forget()

        #expect(harness.transport.count(method: "DELETE", path: "/v1/devices/self") == 1)
        #expect(await harness.tokens.knownTokens.isEmpty)
        #expect(harness.preferences.string(forKey: ClientPreferenceKey.deviceId) == nil)
        #expect(harness.model.pairing == .unpaired)
        #expect(harness.model.state == .unpaired)
        harness.stop()
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-11 : hors appairage l'oubli n'émet rien, et depuis un refus il ramène à .unpaired")
    func forgetOutsidePairedEmitsNothing() async {
        let unpaired = ClientHarness(preferences: [ClientPreferenceKey.manualAddress: "192.168.1.20:8787"])
        unpaired.model.start()
        #expect(await eventually { unpaired.model.pairing == .unpaired })
        let before = unpaired.transport.requestCount
        await unpaired.model.forget()
        #expect(unpaired.transport.requestCount == before)
        #expect(unpaired.model.pairing == .unpaired)
        unpaired.stop()

        // Depuis `.refused` : aucune requête, et seul l'oubli (hors appairage) y met fin.
        let refused = pairedHarness()
        refused.transport.script(.failure(ClientError.api(.unauthorized)))
        refused.model.start()
        #expect(await eventually { refused.model.pairing == .refused(endpoint: manualEndpoint) })
        let sent = refused.transport.requestCount
        await refused.model.forget()
        #expect(refused.transport.requestCount == sent)
        #expect(refused.model.pairing == .unpaired)
        #expect(refused.model.state == .unpaired)
        refused.stop()
    }
}
