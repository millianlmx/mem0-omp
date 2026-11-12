// La SOBRIÉTÉ du client avec beaucoup de données : rien n'est republié à l'identique (la
// boîte au curseur près), le direct publie à part, les fils se calculent hors des rendus
// (`OSThreadStore`), un tour de relecture ne relit que ce que ses événements changent, et
// `OSThreads.build` rend un ordre stable — sur la doublure de transport, sans réseau.

import Combine
@testable import ConsoleClient
import Foundation
import Testing

/// Compte les publications d'un modèle observable.
@MainActor
private final class PublishCounter {
    private(set) var count = 0
    private var subscription: AnyCancellable?

    init(_ publisher: some Publisher<Void, Never>) {
        subscription = publisher.sink { [weak self] in self?.count += 1 }
    }
}

private func sessionEntryEvent(_ seq: Int, _ text: String) -> Data {
    let entry = #"{"seq":\#(seq),"at":\#(seq),"step":"impl","kind":"text","text":"\#(text)","tool":null,"status":null,"detail":null}"#
    return Data("event: session\ndata: {\"id\":0,\"at\":1,\"runId\":\"r1\",\"repo\":\"demo\",\"type\":\"session\",\"payload\":{\"entry\":\(entry)},\"ephemeral\":true}\n\n".utf8)
}

private let emptySession = #"{"runId":"r1","live":true,"cursor":9,"entries":[]}"#

@Suite("Sobriété du client : publier seulement ce qui change")
@MainActor
struct ConsoleSobrietyTests {
    @Test("une boîte identique au curseur près n'est pas republiée ; le curseur suit quand même")
    func inboxCursorOnly() async {
        let transport = osTransport(routes: [:])
        let model = await osConnected(transport)
        #expect(model.eventCursor == 42)
        let counter = PublishCounter(model.objectWillChange)
        let moved = osInboxJSON.replacingOccurrences(of: #""cursor":42"#, with: #""cursor":57"#)
        transport.respond { call in
            call.path == "/v1/inbox" ? osJSON(moved) : osJSON(#"{"error":"route inconnue"}"#, status: 404)
        }
        await model.refreshInbox()
        #expect(model.eventCursor == 57, "le flux reprendra du dernier curseur lu")
        #expect(model.inbox?.cursor == 42, "la boîte affichée n'a pas bougé")
        #expect(counter.count == 0, "rien n'a changé pour les écrans")
    }

    @Test("une relecture demandée dit qu'elle charge ; celle du flux ne publie rien quand rien ne change")
    func quietStreamRefresh() async {
        let transport = osTransport(routes: [:])
        let model = await osConnected(transport)
        let counter = PublishCounter(model.objectWillChange)
        let reads = transport.count("GET", "/v1/inbox")
        transport.push(events: ["run_state"])
        model.startLive()
        #expect(await eventually { transport.count("GET", "/v1/inbox") > reads })
        model.stopLive()
        // `isLive` passe à vrai puis à faux : deux publications, aucune pour la boîte relue à l'identique.
        #expect(counter.count == 2)
        await model.refresh()
        #expect(counter.count == 4, "« Actualiser » montre sa lecture (isLoading vrai, puis faux)")
    }

    @Test("un tour de relecture ne relit que ce que ses événements changent")
    func eventFilters() async {
        #expect(HarnessModel.changesInbox("run_state") && HarnessModel.changesInbox("escalation") && HarnessModel.changesInbox("progress"))
        #expect(!HarnessModel.changesInbox("workstation_action") && !HarnessModel.changesInbox("vigie_incident"))
        #expect(!HarnessModel.changesInbox("local_session") && !HarnessModel.changesInbox("heavy_started"))
        #expect(HarnessRunsHistory.changes("run_state") && HarnessRunsHistory.changes("step_done") && HarnessRunsHistory.changes("priority"))
        #expect(!HarnessRunsHistory.changes("progress") && !HarnessRunsHistory.changes("heavy_done") && !HarnessRunsHistory.changes("workstation_action"))

        let transport = osTransport(routes: [:])
        let model = await osConnected(transport)
        let reads = transport.count("GET", "/v1/inbox")
        transport.push(events: ["workstation_action", "vigie_incident"])
        model.startLive()
        #expect(await eventually { transport.calls.contains { $0.path.hasPrefix("/v1/events") } })
        try? await Task.sleep(for: .milliseconds(50))
        model.stopLive()
        #expect(transport.count("GET", "/v1/inbox") == reads, "un événement du poste ou de la vigie ne relit pas la boîte")
    }

    @Test("les entrées du direct publient par HarnessDirect, regroupées, jamais par le modèle")
    func directPublishesApart() async {
        let transport = osTransport(routes: ["GET /v1/runs/r1/session": osJSON(emptySession)])
        let model = await osConnected(transport)
        transport.stream((1 ... 30).map { sessionEntryEvent($0, "paragraphe \($0)") })
        let modelCounter = PublishCounter(model.objectWillChange)
        let directCounter = PublishCounter(model.direct.objectWillChange)
        model.followSession(runId: "r1")
        #expect(await eventually { model.session?.entries.count == 30 })
        #expect(modelCounter.count == 0, "toute l'app ne se redessine pas à chaque entrée")
        try? await Task.sleep(for: HarnessDirect.interval + .milliseconds(100))
        #expect(directCounter.count < 30, "trente entrées ne coûtent pas trente rendus")
        #expect(directCounter.count > 0)
        model.stopSession()
        #expect(model.session == nil && !model.direct.isLive)
    }

    @Test("une entrée qui revient (même seq), en retard ou nouvelle se pose à sa place ; les tronçons suivent les étapes")
    func feedApplyAndSegments() {
        var feed = HarnessSessionFeed(target: .run("r1"))
        for (seq, step) in [(1, "req"), (2, "req"), (4, "impl"), (5, "impl"), (7, "review")] {
            feed.apply(HarnessSessionEntry(seq: seq, step: step, kind: "text", text: "\(seq)"))
        }
        feed.apply(HarnessSessionEntry(seq: 7, step: "review", kind: "text", text: "7 bis"))
        feed.apply(HarnessSessionEntry(seq: 3, step: "req", kind: "text", text: "3"))
        feed.apply(HarnessSessionEntry(seq: 4, step: "impl", kind: "text", text: "4 bis"))
        #expect(feed.entries.map(\.seq) == [1, 2, 3, 4, 5, 7])
        #expect(feed.entries.map(\.text) == ["1", "2", "3", "4 bis", "5", "7 bis"])
        #expect(feed.stepSegments.map(\.id) == [1, 4, 7])
        #expect(feed.stepSegments.map(\.step) == ["req", "impl", "review"])
        #expect(feed.stepSegments.map(\.range) == [0 ..< 3, 3 ..< 5, 5 ..< 6])
        #expect(feed.toolsDone == 0)
    }

    @Test("les fils sont tenus à part : calculés à l'ouverture, recalculés quand une entrée change, publiés seulement s'ils changent")
    func threadStore() async {
        let transport = osTransport(routes: [:])
        let model = await osConnected(transport)
        let store = OSThreadStore(server: model, debounce: .milliseconds(5))
        #expect(store.threads == OSThreads.build(runs: model.history.runs, inbox: model.inbox))
        #expect(store.threads.map { $0.runs.map(\.id) } == [["r1"]])
        #expect(store.decisionCount == 0)
        let counter = PublishCounter(store.objectWillChange)

        // La même boîte relue : rien ne bouge.
        await model.refreshInbox()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(counter.count == 0)

        // Une feature attend des specs : un fil de plus, une décision de plus.
        let inbox = #"{"cursor":43,"batches":[],"decisions":[],"runs":["# + osRunJSON("r1", extra: #","rev":4"#) + "],"
            + #""awaiting":["# + osRunJSON("r2", state: "awaiting_human", step: "specs", title: "Export CSV") + "]}"
        transport.respond { call in call.path == "/v1/inbox" ? osJSON(inbox) : osJSON(#"{"error":"route inconnue"}"#, status: 404) }
        await model.refreshInbox()
        #expect(await eventually { store.threads.count == 2 })
        #expect(store.decisionCount == 1)
        #expect(store.threads.first?.phase == .yours, "ce qui vous attend d'abord")
        #expect(counter.count == 2, "les fils et le compte, une fois chacun")
    }

    @Test("les fils gardent leur ordre d'une construction à l'autre, à égalité de date")
    func stableOrder() throws {
        let runs = try ["c", "a", "b", "d"].map { id in
            try JSONDecoder().decode(HarnessRun.self, from: Data(osRunJSON(id, state: "merged", title: "Titre \(id)").utf8))
        }
        let first = OSThreads.build(runs: runs, inbox: nil).map(\.id)
        #expect(first == ["r:a", "r:b", "r:c", "r:d"])
        for _ in 0 ..< 20 {
            #expect(OSThreads.build(runs: runs.shuffled(), inbox: nil).map(\.id) == first)
        }
    }

    @Test("le pouls regroupe ses publications et ne republie pas une ligne inchangée")
    func pulseCoalesces() async {
        let transport = osTransport(routes: [:])
        let model = await osConnected(transport)
        transport.stream((0 ..< 20).map { index in
            Data(#"event: activity\#ndata: {"at":\#(1_700_000_000_000 + index),"runId":"r1","payload":{"tool":"bash","intent":"Lance les tests"}}\#n\#n"#.utf8)
        })
        let pulse = OSPulse(harness: model, interval: .seconds(10))
        let counter = PublishCounter(pulse.objectWillChange)
        pulse.start()
        #expect(await eventually { pulse.activity[.run("r1")] != nil })
        try? await Task.sleep(for: .milliseconds(50))
        pulse.stop()
        #expect(pulse.activity[.run("r1")]?.line == "Lance les tests")
        // La première ligne (et `isLive` ouvert puis fermé) : vingt événements identiques, pas vingt rendus.
        #expect(counter.count <= 4)
    }
}
