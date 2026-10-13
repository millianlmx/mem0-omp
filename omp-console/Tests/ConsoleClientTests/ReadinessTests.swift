// L'attente « prêt à émettre » (client-sans-attente-de-disponibilite, S-1 à S-3) :
// jeton restauré, adresse manuelle exclusive, découverte bornée par l'échéance,
// « prêt » seulement une fois le Mac confirmé par un `hello` de la version locale.
//
// TOUS les tests tiennent l'échéance par un `GatePacer` (le défaut `RecordingPacer`
// la rendrait aussitôt) et le relâchent à la fin : une échéance tardive ne reprend
// rien.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private let manual = ClientEndpoint.manual(host: "10.0.0.5", port: 9000)

@MainActor
private let mac = DiscoveredMac(
    name: "OMP Console",
    endpoint: .bonjour(name: "OMP Console", host: "192.168.1.12", port: 8787)
)

private let unreachable = ClientError.transport(.unreachable("Mac muet"))

private let paired = [ClientPreferenceKey.deviceId: "d"]
private let pairedWithManual = [
    ClientPreferenceKey.deviceId: "d",
    ClientPreferenceKey.manualAddress: "10.0.0.5:9000",
]

/// Une attente lancée en tâche : `done` passe à vrai APRÈS son retour, ce qui
/// prouve qu'elle n'est pas encore rendue tant qu'il est relu à faux.
@MainActor
private final class PendingReadiness {
    private(set) var done = false
    private var task: Task<ClientReadiness, Never>?

    init(_ model: ConsoleClientModel) {
        task = Task { @MainActor [weak self] in
            let verdict = await model.waitUntilReady()
            self?.done = true
            return verdict
        }
    }

    var value: ClientReadiness {
        get async { await task!.value }
    }
}

@Suite("Attente « prêt à émettre »")
@MainActor
struct ReadinessTests {
    @Test("client-sans-attente-de-disponibilite/AC-1 : à froid, trousseau en cours de lecture et adresse manuelle, l'attente rend « prêt » au lieu de « non connecté »")
    func coldStartWithManualAddress() async {
        let store = GatedTokenStore(token: "tok")
        let gate = GatePacer()
        let harness = ClientHarness(
            preferences: pairedWithManual,
            readinessPacer: gate,
            tokenStore: store
        )
        harness.transport.script(.hold)

        // Modèle NON démarré : l'attente le démarre et arme son échéance.
        let pending = PendingReadiness(harness.model)
        #expect(await gate.untilWaiting())
        #expect(harness.model.pairing == .restoring)
        #expect(harness.transport.requestCount == 0)
        #expect(pending.done == false)

        await store.release()
        #expect(await eventually {
            harness.transport.count(method: "GET", path: "/v1/stream") == 1
                && harness.model.state == .connected(endpoint: manual)
        })
        #expect(harness.transport.endpoints.first == manual)
        // Flux ouvert sans `hello` : pas encore prêt.
        #expect(pending.done == false)

        harness.transport.push(ClientFixtures.helloFrame())
        let verdict = await pending.value
        #expect(verdict == .ready(endpoint: manual))
        await gate.release()
        harness.stop()
    }

    @Test("client-sans-attente-de-disponibilite/AC-2 : sans adresse manuelle, un Mac découvert par Bonjour avant l'échéance rend « prêt »")
    func bonjourMacBeforeDeadline() async {
        let gate = GatePacer()
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: paired,
            readinessPacer: gate
        )
        harness.transport.script(.hold)
        await harness.startWithToken()
        #expect(harness.model.state == .searching)

        let pending = PendingReadiness(harness.model)
        #expect(await gate.untilWaiting())
        #expect(pending.done == false)

        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: mac.endpoint) })
        harness.transport.push(ClientFixtures.helloFrame())
        // L'échéance n'est jamais relâchée avant le résultat.
        #expect(await pending.value == .ready(endpoint: mac.endpoint))
        #expect(await gate.requested == [ClientRetry.readinessTimeout])
        await gate.release()
        harness.stop()
    }

    @Test("client-sans-attente-de-disponibilite/AC-3 : sans adresse ni Mac découvert, « Mac injoignable » à l'échéance de 5 s, jamais au-delà")
    func noMacTimesOut() async {
        let gate = GatePacer()
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: paired,
            readinessPacer: gate
        )
        harness.transport.script(.hold)
        await harness.startWithToken()
        #expect(harness.model.state == .searching)

        let pending = PendingReadiness(harness.model)
        #expect(await gate.untilWaiting())
        #expect(await gate.requested == [ClientRetry.readinessTimeout])
        #expect(ClientRetry.readinessTimeout == 5)
        #expect(pending.done == false)

        await gate.release()
        #expect(await pending.value == .macUnreachable)
        #expect(harness.transport.requestCount == 0)
        harness.stop()
    }

    @Test("client-sans-attente-de-disponibilite/AC-4 : une adresse manuelle muette rend « Mac injoignable » sans aucune tentative vers le Mac Bonjour")
    func silentManualAddressIsExclusive() async {
        let gate = GatePacer()
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: pairedWithManual,
            pacerLimit: 2,
            readinessPacer: gate
        )
        harness.transport.script(.failure(unreachable))
        await harness.startWithToken()
        harness.discovery.emit([mac])

        let pending = PendingReadiness(harness.model)
        #expect(await gate.untilWaiting())
        #expect(await eventually { harness.transport.count(method: "GET", path: "/v1/stream") >= 1 })
        #expect(pending.done == false)

        await gate.release()
        #expect(await pending.value == .macUnreachable)
        #expect(!harness.transport.endpoints.isEmpty)
        #expect(harness.transport.endpoints.allSatisfy { $0 == manual })
        harness.stop()
    }

    @Test("client-sans-attente-de-disponibilite/AC-5 : trousseau sans jeton, « non appairé » dès la lecture finie, sans échéance ni requête")
    func emptyKeychainIsNotPaired() async {
        let store = GatedTokenStore(token: nil)
        let gate = GatePacer()
        let harness = ClientHarness(
            preferences: paired,
            readinessPacer: gate,
            tokenStore: store
        )
        harness.transport.script(.hold)

        let pending = PendingReadiness(harness.model)
        #expect(await gate.untilWaiting())
        #expect(harness.model.pairing == .restoring)
        #expect(pending.done == false)

        // L'échéance reste tenue : le verdict ne lui doit rien.
        await store.release()
        #expect(await pending.value == .notPaired)
        #expect(harness.transport.requestCount == 0)
        await gate.release()
        harness.stop()
    }

    @Test("client-sans-attente-de-disponibilite/AC-6 : un Mac qui refuse le jeton rend « appairage refusé », distinct de « non appairé »")
    func revokedTokenIsRefused() async {
        let gate = GatePacer()
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: pairedWithManual,
            readinessPacer: gate
        )
        harness.transport.script(.failure(ClientError.api(.unauthorized)))

        let verdict = await PendingReadiness(harness.model).value
        #expect(verdict == .pairingRefused)
        #expect(verdict != .notPaired)
        if case .refused = harness.model.pairing {} else {
            Issue.record("pairing attendu .refused, obtenu \(harness.model.pairing)")
        }
        await gate.release()
        harness.stop()
    }

    @Test("client-sans-attente-de-disponibilite/AC-7 : un Mac d'une autre version d'API rend « version incompatible » avec les deux numéros")
    func incompatibleHelloIsReported() async {
        let gate = GatePacer()
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: pairedWithManual,
            readinessPacer: gate
        )
        harness.transport.script(.hold)

        let pending = PendingReadiness(harness.model)
        #expect(await eventually { harness.model.state == .connected(endpoint: manual) })
        harness.transport.push(ClientFixtures.helloFrame(2))
        #expect(await pending.value == .incompatibleVersion(local: 1, remote: 2))
        await gate.release()
        harness.stop()
    }

    @Test("client-sans-attente-de-disponibilite/AC-8 : en attente de relance automatique, l'attente relance aussitôt et rend « prêt » sans subir le délai")
    func failedClientRetriesAtOnce() async {
        let gate = GatePacer()
        let retry = GatePacer()
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: pairedWithManual,
            readinessPacer: gate,
            retryPacer: retry
        )
        harness.transport.script(.sequence([.failure(unreachable), .hold]))
        await harness.startWithToken()
        // Premier échec : la relance automatique dort, tenue par le test.
        #expect(await retry.untilWaiting())
        #expect(harness.model.state == .macAbsent(endpoint: manual))

        let pending = PendingReadiness(harness.model)
        #expect(await eventually {
            harness.transport.count(method: "GET", path: "/v1/stream") == 2
                && harness.model.state == .connected(endpoint: manual)
        })
        harness.transport.push(ClientFixtures.helloFrame())
        #expect(await pending.value == .ready(endpoint: manual))
        // Aucun second délai : la relance tenue n'a jamais été relâchée.
        #expect(await retry.requested == [ClientRetry.delay(attempt: 1)])
        #expect(await retry.requested == [0.5])
        await retry.release()
        await gate.release()
        harness.stop()
    }

    @Test("client-sans-attente-de-disponibilite/AC-9 : déjà connecté à un Mac compatible, « prêt » aussitôt et sans nouvelle connexion")
    func confirmedClientIsReadyAtOnce() async {
        let gate = GatePacer()
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: pairedWithManual,
            readinessPacer: gate
        )
        harness.transport.script(.hold)
        await harness.startWithToken()
        #expect(await eventually { harness.model.state == .connected(endpoint: manual) })
        // `hello` puis `store` dans la même trame : l'instantané reçu prouve que le
        // `hello` qui le précède a été appliqué.
        harness.transport.push(ClientFixtures.helloFrame() + ClientFixtures.storeFrame(ClientFixtures.snapshot()))
        #expect(await eventually { harness.model.snapshot != nil })

        #expect(await harness.model.waitUntilReady() == .ready(endpoint: manual))
        #expect(await gate.requested == [])
        #expect(harness.transport.count(method: "GET", path: "/v1/stream") == 1)
        await gate.release()
        harness.stop()
    }
}
