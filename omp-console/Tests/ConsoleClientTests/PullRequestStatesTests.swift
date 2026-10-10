// L'état des PR côté client (S-6, BR-3) : la trame `pull-request-states` est
// décodée, publiée et re-dérive l'ardoise ; aucune trame ⇒ « PR créée » ; le
// client demande une relecture à chaque ouverture du flux et sur le geste
// « Rafraîchir ».
//
// Fixture : `HomeParity.snapshot` (deux livraisons à PR : une feature de projet
// `.pr` et une feature de lot `.done`), horloge FIXE.

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

private let fixedNowMs: Double = 1_700_000_000_000
private let dayMs: Double = 86_400_000
private let refreshPath = "/v1/pull-request-states/refresh"

/// La PR de la feature de LOT `terminee` du fixture.
private let lotPrUrl = "https://example.com/pr/43"

@Suite("État des PR côté client")
@MainActor
struct PullRequestStatesTests {
    private func connectedHarness() async -> ClientHarness {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            nowMs: { fixedNowMs }
        )
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        harness.transport.push(ClientFixtures.storeFrame(HomeParity.snapshot))
        #expect(await eventually { harness.model.board != .loading })
        return harness
    }

    private func push(_ harness: ClientHarness, _ facts: [PullRequestFact], refreshing: Bool = false) throws {
        let payload = RemotePullRequestStatesPayload(facts: facts, refreshing: refreshing)
        let json = String(decoding: try JSONEncoder().encode(payload), as: UTF8.self)
        harness.transport.push(ClientFixtures.frame("pull-request-states", json))
    }

    /// La pastille de la carte de la voie « Livrées » qui porte `url`, ou nil si
    /// la carte n'est pas sur l'ardoise.
    private func label(_ harness: ClientHarness, _ url: String) -> String? {
        harness.model.board.kanbanBoard?.cards
            .first { $0.prUrl == url && KanbanLane.of($0) == .livrees }
            .map { ConsoleStatus.of(card: $0).text }
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-1 : iOS — une PR fusionnée servie par le Mac porte « PR fusionnée », jamais « PR ouverte »")
    func mergedFrameReadsMerged() async throws {
        let harness = await connectedHarness()
        try push(harness, [PullRequestFact(url: lotPrUrl, state: .merged, closedAtMs: fixedNowMs - dayMs)])
        #expect(await eventually { label(harness, lotPrUrl) == "PR fusionnée" })
        #expect(harness.model.pullRequestFacts[lotPrUrl]?.state == .merged)
        // Fusionnée depuis des semaines : la borne des 7 jours la retire, elle
        // ne montre donc jamais « PR ouverte ».
        try push(harness, [PullRequestFact(url: lotPrUrl, state: .merged, closedAtMs: fixedNowMs - 21 * dayMs)])
        #expect(await eventually { harness.model.board.kanbanBoard?.cards.contains { $0.prUrl == lotPrUrl } == false })
        harness.stop()
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-2 : iOS — une PR fermée servie par le Mac porte « PR fermée »")
    func closedFrameReadsClosed() async throws {
        let harness = await connectedHarness()
        try push(harness, [PullRequestFact(url: lotPrUrl, state: .closed, closedAtMs: fixedNowMs - dayMs)])
        #expect(await eventually { label(harness, lotPrUrl) == "PR fermée" })
        harness.stop()
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-3 : iOS — une PR ouverte servie par le Mac porte « PR ouverte »")
    func openFrameReadsOpen() async throws {
        let harness = await connectedHarness()
        try push(harness, [PullRequestFact(url: lotPrUrl, state: .open, closedAtMs: nil)])
        #expect(await eventually { label(harness, lotPrUrl) == "PR ouverte" })
        harness.stop()
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-4 : iOS — sans trame (ou trame sans fait), les cartes à PR portent « PR créée »")
    func noFrameReadsCreated() async throws {
        let harness = await connectedHarness()
        #expect(harness.model.pullRequestStates == nil)
        let urls = PullRequestFacts.urls(in: HomeParity.snapshot)
        #expect(urls.count == 2)
        for url in urls { #expect(label(harness, url) == "PR créée") }

        // Un Mac sans `gh` sert une trame vide : rien ne change.
        try push(harness, [], refreshing: false)
        #expect(await eventually { harness.model.pullRequestStates?.facts == [] })
        for url in urls { #expect(label(harness, url) == "PR créée") }
        harness.stop()
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-5 : iOS — « PR ouverte » puis Rafraîchir puis trame fusionnée ⇒ « PR fusionnée »")
    func refreshThenMergedFrame() async throws {
        let harness = await connectedHarness()
        harness.transport.respond { request in
            if request.method == "POST", request.path == refreshPath {
                return .success(ClientHTTPResponse(status: 202, protocolVersion: 1, body: Data(#"{"accepted":true}"#.utf8)))
            }
            return .failure(ClientError.transport(.unreachable("route non scriptée")))
        }
        try push(harness, [PullRequestFact(url: lotPrUrl, state: .open, closedAtMs: nil)])
        #expect(await eventually { label(harness, lotPrUrl) == "PR ouverte" })

        let before = harness.transport.count(method: "POST", path: refreshPath)
        let accepted = try await harness.model.refreshPullRequestStates()
        #expect(accepted.accepted)
        #expect(harness.transport.count(method: "POST", path: refreshPath) == before + 1)
        #expect(harness.transport.requests.last { $0.path == refreshPath }?.body == nil, "la route ne porte aucun corps")

        try push(harness, [PullRequestFact(url: lotPrUrl, state: .open, closedAtMs: nil)], refreshing: true)
        #expect(await eventually { harness.model.pullRequestStates?.refreshing == true })
        #expect(label(harness, lotPrUrl) == "PR ouverte")
        try push(harness, [PullRequestFact(url: lotPrUrl, state: .merged, closedAtMs: fixedNowMs - dayMs)])
        #expect(await eventually { label(harness, lotPrUrl) == "PR fusionnée" })
        #expect(harness.model.pullRequestStates?.refreshing == false)
        harness.stop()
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-5 : iOS — chaque ouverture du flux (lancement, reconnexion) demande une relecture")
    func everyStreamOpeningRequestsRefresh() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            pacerLimit: 5,
            nowMs: { fixedNowMs }
        )
        // Le premier flux se termine aussitôt, le second reste ouvert.
        harness.transport.script(.sequence([.chunks([]), .hold]))
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.transport.count(method: "POST", path: refreshPath) >= 2 })
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        harness.stop()
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-12 : iOS — une « PR créée » ancienne disparaît quand le Mac la révèle fusionnée il y a plus de 7 jours")
    func unknownThenMergedLongAgoDisappears() async throws {
        let harness = await connectedHarness()
        #expect(label(harness, lotPrUrl) == "PR créée")
        try push(harness, [PullRequestFact(url: lotPrUrl, state: .merged, closedAtMs: fixedNowMs - 10 * dayMs)])
        #expect(await eventually { harness.model.board.kanbanBoard?.cards.contains { $0.prUrl == lotPrUrl } == false })
        harness.stop()
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-4 : la trame pull-request-states se décode ; illisible, elle est ignorée")
    func frameDecoding() {
        var parser = ClientStreamParser()
        let events = parser.consume(ClientFixtures.frame(
            "pull-request-states",
            #"{"facts":[{"url":"https://example.com/pr/1","state":"MERGED","closedAtMs":1700000000000}],"refreshing":true}"#
        ))
        #expect(events == [.pullRequestStates(RemotePullRequestStatesPayload(
            facts: [PullRequestFact(url: "https://example.com/pr/1", state: .merged, closedAtMs: 1_700_000_000_000)],
            refreshing: true
        ))])
        #expect(events.first?.name == "pull-request-states")
        let unreadable = parser.consume(ClientFixtures.frame("pull-request-states", #"{"facts":[{"state":"DRAFT"}]}"#))
        #expect(unreadable == [.unknown("pull-request-states")])
    }
}
