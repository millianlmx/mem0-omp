// La preuve Swift de l'intent témoin (feature client-ios-possede-par-la-vue, S-3) :
// sur de VRAIS `ConsoleClientModel` câblés à des doublures (aucun réseau, aucun
// trousseau réel), l'intent attend la relecture du jeton puis énonce l'une des
// trois phrases, sans appairage ni connexion de plus.
//
// Un `AppDependency` ne se lit que DANS le déroulé d'exécution d'un intent :
// l'intent est donc exécuté par `callAsFunction(donate:)` contre un gestionnaire
// AUTONOME, jamais `.shared`, et `intent.client` n'est jamais lu depuis le test.

import AppIntents
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

/// Le résultat d'une réponse lancée en tâche : `nil` tant qu'elle n'a pas rendu.
@MainActor
private final class AnswerOutcome {
    var value: String?
}

/// Un transport qui ne sert aucune route : 404 partout, flux injoignable.
private func silentTransport() -> ScriptedClientTransport {
    ScriptedClientTransport { _ in ClientDoubles.response(status: 404, json: #"{"error":{"code":"not_found"}}"#) }
}

/// Le nombre de flux temps réel ouverts vers le Mac.
private func streamCount(_ transport: OpenStreamTransport) -> Int {
    transport.requests.filter { $0.method == "GET" && $0.path == "/v1/stream" }.count
}

/// Le nombre d'appairages tentés.
private func pairCount(_ transport: OpenStreamTransport) -> Int {
    transport.requests.filter { $0.method == "POST" && $0.path == ConsoleAPI.Service.basePath + "/pair" }.count
}

private let lanEndpoint = ClientEndpoint.manual(host: "192.168.1.20", port: 8787)

/// Les sept états du client hors connexion.
private let notConnectedStates: [ClientState] = [
    .unpaired,
    .searching,
    .connecting(endpoint: lanEndpoint),
    .noNetwork,
    .macAbsent(endpoint: lanEndpoint),
    .revoked,
    .incompatibleProtocol(local: 1, remote: 2),
    .wrongMachine(expected: .vps, actual: .mac),
]

/// Les neuf états du client.
private let allStates: [ClientState] = notConnectedStates + [.connected(endpoint: lanEndpoint)]

@Suite("client-ios-possede-par-la-vue — l'intent témoin")
@MainActor
struct IOSSiriStatusTests {
    @Test("client-ios-possede-par-la-vue/AC-1 : les vues et l'intent témoin reçoivent la même instance, et le trousseau n'est lu qu'une fois")
    func intentAndViewsShareOneRead() async throws {
        let manager = AppDependencyManager()
        let tokens = CountingTokenStore(["dev-1": "tok-1"])
        let client = ClientDoubles.pairedModel(tokens: tokens, transport: silentTransport())

        let shared = IOSSharedClient.install(client, in: manager)
        let intent = IOSConnectionStatusIntent(dependencies: manager)
        let _: Void = try await intent(donate: false)

        // L'intent a démarré et attendu CE client-là.
        #expect(await tokens.reads == 1)
        #expect(shared.pairing == .paired)

        // Ce que fait `RootView.onAppear`, puis une seconde réponse : aucune
        // nouvelle lecture du trousseau.
        shared.start()
        let answer = await IOSSiriStatus.answer(for: shared)
        #expect(await tokens.reads == 1)
        #expect(answer == IOSSiriText.pairedNotJoined)
        #expect(answer == "Appairé, Mac non joint")
        shared.stop()
    }

    @Test("client-ios-possede-par-la-vue/AC-3 : connecté au Mac « X », l'intent répond « Connecté à X » sans appairage ni seconde connexion")
    func connectedNamesTheMac() async throws {
        let mac = DiscoveredMac(
            name: "Mac de Léa",
            endpoint: .bonjour(name: "Mac de Léa", host: "127.0.0.1", port: 8787)
        )
        let tokens = CountingTokenStore(["dev-1": "tok-1"])
        let transport = OpenStreamTransport()
        let client = ClientDoubles.pairedModel(
            tokens: tokens,
            transport: transport,
            discovery: AnnouncingDiscovery(mac)
        )
        client.start()
        await ClientDoubles.until(client, state: { $0 == .connected(endpoint: mac.endpoint) })
        #expect(streamCount(transport) == 1)

        let answer = await IOSSiriStatus.answer(for: client)

        #expect(answer == IOSSiriText.connected(macName: "Mac de Léa"))
        #expect(answer == "Connecté à Mac de Léa")
        #expect(streamCount(transport) == 1)
        #expect(pairCount(transport) == 0)
        #expect(await tokens.reads == 1)
        #expect(client.state == .connected(endpoint: mac.endpoint))
        client.stop()

        // Table pure : une adresse manuelle, ou un nom Bonjour blanc, se dit
        // `hôte:port`.
        let manual = IOSSiriStatus.resolve(pairing: .paired, state: .connected(endpoint: lanEndpoint))
        #expect(manual == .connected(macName: "192.168.1.20:8787"))
        #expect(manual.phrase == IOSSiriText.connected(macName: "192.168.1.20:8787"))
        #expect(manual.phrase == "Connecté à 192.168.1.20:8787")
        let blank = IOSSiriStatus.resolve(
            pairing: .paired,
            state: .connected(endpoint: .bonjour(name: "  ", host: "192.168.1.12", port: 8787))
        )
        #expect(blank.phrase == IOSSiriText.connected(macName: "192.168.1.12:8787"))
        #expect(blank.phrase == "Connecté à 192.168.1.12:8787")
    }

    @Test("client-ios-possede-par-la-vue/AC-4 : sans jeton, lancé à froid, l'intent répond « Non appairé », jamais pendant la lecture")
    func unpairedNeverAnswersWhileRestoring() async throws {
        // Préférence d'appareil posée, trousseau vide, lecture retenue.
        let tokens = CountingTokenStore([:], held: true)
        let client = ClientDoubles.pairedModel(tokens: tokens, transport: silentTransport())
        let outcome = AnswerOutcome()
        let task = Task { @MainActor in
            outcome.value = await IOSSiriStatus.answer(for: client)
        }
        await tokens.readsReached(1)
        #expect(outcome.value == nil)
        #expect(client.pairing == .restoring)

        await tokens.open()
        await task.value
        #expect(outcome.value == IOSSiriText.unpaired)
        #expect(outcome.value == "Non appairé")
        #expect(await tokens.reads == 1)
        client.stop()

        // Sans préférence d'appareil : aucune lecture du trousseau.
        let untouched = CountingTokenStore()
        let fresh = ConsoleClientModel(
            transport: silentTransport(),
            discovery: SilentDiscovery(),
            preferences: InMemoryClientPreferences(),
            tokens: untouched,
            pacer: ImmediatePacer(),
            pathSource: SilentPathSource(),
            deviceName: "iPhone",
            searchPacer: ImmediatePacer()
        )
        let answer = await IOSSiriStatus.answer(for: fresh)
        #expect(answer == IOSSiriText.unpaired)
        #expect(answer == "Non appairé")
        #expect(await untouched.reads == 0)
        fresh.stop()

        // Table pure : refusé ou non appairé, quel que soit l'état.
        for pairing in [ClientPairingStatus.refused(endpoint: nil), .unpaired] {
            for state in allStates {
                let status = IOSSiriStatus.resolve(pairing: pairing, state: state)
                #expect(status == .unpaired, "\(pairing) × \(state)")
                #expect(status.phrase == "Non appairé")
            }
        }
    }

    @Test("client-ios-possede-par-la-vue/AC-5 : jeton présent et Mac éteint, l'intent lancé à froid répond « Appairé, Mac non joint »")
    func pairedWithoutMacSaysNotJoined() async throws {
        // Aucun Mac découvert, aucune adresse.
        let tokens = CountingTokenStore(["dev-1": "tok-1"])
        let client = ClientDoubles.pairedModel(tokens: tokens, transport: silentTransport())
        let answer = await IOSSiriStatus.answer(for: client)
        #expect(answer == IOSSiriText.pairedNotJoined)
        #expect(answer == "Appairé, Mac non joint")
        client.stop()

        // Adresse manuelle, Mac éteint : le flux est injoignable.
        let offTokens = CountingTokenStore(["dev-1": "tok-1"])
        let off = ClientDoubles.pairedModel(
            tokens: offTokens,
            transport: silentTransport(),
            address: "127.0.0.1:8787"
        )
        let offAnswer = await IOSSiriStatus.answer(for: off)
        #expect(offAnswer == IOSSiriText.pairedNotJoined)
        #expect(offAnswer == "Appairé, Mac non joint")
        await ClientDoubles.until(off, state: { if case .macAbsent = $0 { return true } else { return false } })
        #expect(await IOSSiriStatus.answer(for: off) == "Appairé, Mac non joint")
        off.stop()

        // Table pure : appairé, les sept états hors connexion.
        for state in notConnectedStates {
            let status = IOSSiriStatus.resolve(pairing: .paired, state: state)
            #expect(status == .pairedNotJoined, "\(state)")
            #expect(status.phrase == "Appairé, Mac non joint")
        }
    }
}
