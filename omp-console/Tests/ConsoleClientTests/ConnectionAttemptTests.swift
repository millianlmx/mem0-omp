// Les faits de connexion que l'iOS présente (S-1 de etats-non-connecte-heterogenes-ios) :
// `attemptFollowsFailure` distingue une tentative FRAÎCHE (« connexion en cours »)
// d'une relance après échec (« non connecté » reste affiché), et les composants
// reçus sont conservés hors `.connected`.

import Combine
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

private let unreachable = ClientError.transport(.unreachable("Mac éteint"))

/// Un couple publié ensemble par `publishState()`.
private struct Published: Equatable {
    let state: ClientState
    let follows: Bool
}

/// Relève chaque passage de `publishState()`. `publishState()` affecte `state`
/// AVANT `attemptFollowsFailure`, et `@Published` émet à CHAQUE affectation : au
/// moment où `$attemptFollowsFailure` émet, `state` porte déjà la valeur du même
/// passage. Les états transitoires (une relance qui dure le temps d'un appel)
/// sont donc tous relevés, sans course.
@MainActor
private final class PublishedTrace {
    private(set) var steps: [Published] = []
    private var cancellable: AnyCancellable?

    init(_ model: ConsoleClientModel) {
        cancellable = model.$attemptFollowsFailure.sink { [weak self, unowned model] follows in
            self?.steps.append(Published(state: model.state, follows: follows))
        }
    }
}

@Suite("Faits de connexion présentés")
@MainActor
struct ConnectionAttemptTests {
    @Test("etats-non-connecte-heterogenes-ios/AC-6 : la première tentative en cours est `.connecting` sans échec qui la précède")
    func freshAttemptIsConnecting() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            pacerLimit: 0
        )
        harness.transport.script(.failure(unreachable))
        await harness.startWithToken()
        #expect(harness.model.state == .searching)

        harness.discovery.emit([mac])
        // `beginConnection` publie la tentative avant que la boucle ne tourne.
        #expect(harness.model.state == .connecting(endpoint: macEndpoint))
        #expect(harness.model.attemptFollowsFailure == false)
        harness.stop()
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-7 : après un échec, `.macAbsent` suit un échec, et la relance automatique le garde")
    func relaunchKeepsFailure() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            pacerLimit: 1
        )
        harness.transport.script(.failure(unreachable))
        await harness.startWithToken()
        let trace = PublishedTrace(harness.model)

        harness.discovery.emit([mac])
        // Une relance, puis le second sommeil interrompt la boucle (limite 1).
        #expect(await eventually { harness.transport.count(method: "GET", path: "/v1/stream") == 2 })
        #expect(await eventually { harness.model.state == .macAbsent(endpoint: macEndpoint) })
        #expect(await harness.pacer.recorded() == [0.5, 1])

        let fromAttempt = Array(trace.steps.drop { $0.state != .connecting(endpoint: macEndpoint) })
        #expect(fromAttempt == [
            Published(state: .connecting(endpoint: macEndpoint), follows: false),
            Published(state: .macAbsent(endpoint: macEndpoint), follows: true),
            Published(state: .connecting(endpoint: macEndpoint), follows: true),
            Published(state: .macAbsent(endpoint: macEndpoint), follows: true),
        ])
        harness.stop()
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-6 : `retry()` après un échec repart d'une tentative fraîche")
    func retryIsFresh() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            pacerLimit: 0
        )
        harness.transport.script(.failure(unreachable))
        await harness.startWithToken()
        harness.discovery.emit([mac])
        #expect(await eventually {
            harness.model.state == .macAbsent(endpoint: macEndpoint) && harness.model.attemptFollowsFailure
        })

        harness.model.retry()
        #expect(harness.model.state == .connecting(endpoint: macEndpoint))
        #expect(harness.model.attemptFollowsFailure == false)
        harness.stop()
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-7 : une recherche sans Mac compte comme un échec passé `searchGrace`, et plus dès qu'un Mac est trouvé")
    func searchGraceExpires() async {
        let gate = GatePacer()
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            searchPacer: gate
        )
        harness.transport.script(.hold)
        await harness.startWithToken()
        #expect(harness.model.state == .searching)
        #expect(harness.model.attemptFollowsFailure == false)

        // Le délai demandé est `searchGrace` ; tant qu'il court, rien ne change.
        #expect(await gate.untilWaiting())
        #expect(await gate.requested == [ClientRetry.searchGrace])
        #expect(harness.model.state == .searching)
        #expect(harness.model.attemptFollowsFailure == false)

        await gate.release()
        #expect(await eventually { harness.model.attemptFollowsFailure })
        #expect(harness.model.state == .searching)

        harness.discovery.emit([mac])
        #expect(harness.model.state == .connecting(endpoint: macEndpoint))
        #expect(harness.model.attemptFollowsFailure == false)
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        #expect(harness.model.attemptFollowsFailure == false)
        harness.stop()
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-4 : quitter `.connected` conserve les derniers composants reçus")
    func componentsKeptOffline() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.script(.hold)
        await harness.startWithToken()
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })

        let payload = RemoteComponentsPayload(ompInstalled: true, ompPath: "/omp", setupBanner: nil)
        harness.transport.push(ClientFixtures.componentsFrame(payload))
        #expect(await eventually { harness.model.components == payload })

        harness.discovery.emit([])
        #expect(await eventually { harness.model.state == .searching })
        #expect(harness.model.components == payload)
        harness.stop()
    }
}
