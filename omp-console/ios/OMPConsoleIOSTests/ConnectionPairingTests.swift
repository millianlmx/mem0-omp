// L'issue d'un appairage tenté depuis le formulaire Connexion
// (ios-onboarding-et-connexion, S-3) : `ConnectionSheet.attemptPairing`, seule
// fonction d'appairage de la vue, rend `.paired` quand le Mac accepte le code — le
// flux de bienvenue ferme alors sa feuille (`onPaired`) — et le message affiché
// sous le champ quand il le refuse. Le modèle est un vrai `ConsoleClientModel`
// alimenté par un transport scripté (ClientTestDoubles.swift).

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

@MainActor
@Suite("ios-onboarding-et-connexion — issue de l'appairage")
struct ConnectionPairingTests {
    private static let pairPath = ConsoleAPI.Service.basePath + "/pair"
    private static let macAddress = "127.0.0.1:18787"

    @Test("ios-onboarding-et-connexion/AC-5 : un appairage accepté par le Mac termine le flux")
    func successfulPairingFinishesTheFlow() async {
        let transport = ScriptedClientTransport { request in
            guard request.method == "POST", request.path == Self.pairPath else {
                return ClientDoubles.response(status: 404, json: #"{"error":{"code":"not_found"}}"#)
            }
            return ClientDoubles.response(
                status: 200,
                json: #"{"deviceId":"A1B2C3","token":"jeton-secret","protocolVersion":\#(ConsoleAPI.protocolVersion)}"#
            )
        }
        let model = ClientDoubles.model(transport: transport, address: Self.macAddress)
        #expect(model.pairing != .paired)

        // Le code tapé en minuscules, groupes séparés par une espace, part normalisé.
        let outcome = await ConnectionSheet.attemptPairing(model, code: "abcd efgh")

        #expect(outcome == .paired)
        #expect(model.pairing == .paired)
        #expect(model.pairingFailure == nil)
        let pairs = transport.requests.filter { $0.method == "POST" && $0.path == Self.pairPath }
        #expect(pairs.count == 1, "une seule requête d'appairage")
        let sent = pairs.first?.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        #expect(sent?["code"] as? String == "ABCDEFGH")
    }

    @Test("ios-onboarding-et-connexion/AC-5 : un code refusé laisse le flux ouvert avec le message de refus")
    func refusedPairingKeepsTheMessage() async {
        let transport = ScriptedClientTransport { _ in
            ClientDoubles.response(status: 401, json: #"{"error":{"code":"unauthorized","message":"code refusé"}}"#)
        }
        let model = ClientDoubles.model(transport: transport, address: Self.macAddress)

        let outcome = await ConnectionSheet.attemptPairing(model, code: "ABCD-EFGH")

        #expect(outcome == .failed(message: ConnectionText.codeRefused))
        #expect(model.pairing != .paired)
    }

    @Test("ios-onboarding-et-connexion/S-3 : sans Mac connu, l'échec rend un message et aucune requête ne part")
    func pairingWithoutEndpointFails() async {
        let transport = ScriptedClientTransport { _ in
            ClientDoubles.response(status: 200, json: "{}")
        }
        let model = ConsoleClientModel(
            transport: transport,
            discovery: SilentDiscovery(),
            preferences: InMemoryClientPreferences(),
            tokens: InMemoryTokenStore(),
            pacer: ImmediatePacer(),
            pathSource: SilentPathSource(),
            searchPacer: ImmediatePacer()
        )

        let outcome = await ConnectionSheet.attemptPairing(model, code: "ABCD-EFGH")

        #expect(outcome == .failed(message: ConnectionText.pairError(ClientError.notConnected)))
        #expect(transport.requests.isEmpty)
    }
}
