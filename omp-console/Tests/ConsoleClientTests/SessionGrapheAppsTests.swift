// Feature session-graphe-apps : la session en graphe côté client (Mac et iOS) — la carte
// d'une escalade et le briefing décodés tels que le serveur les écrit, la carte d'un graphe
// de session (voies par étape, avancement, dossiers dépliables, nœuds mis en évidence),
// l'onglet « Carte » absent sur un 404 et relu sur l'événement `graph`, le lien d'un nœud
// vers l'entrée du direct, et l'alerte locale d'une question réduite à `headline` et `stake`.
// Sur la doublure de transport, avec les formes JSON de omp-harness (card.ts, briefing.ts,
// session-graph.ts) ; le contrat avec le serveur RÉEL est prouvé par
// test/console/session-graphe-apps.test.ts.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private final class Transport: HarnessTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    private var replies: [String: HarnessReply] = [:]

    init(_ replies: [String: HarnessReply]) { self.replies = replies }

    var paths: [String] { lock.withLock { recorded } }

    func set(_ path: String, _ reply: HarnessReply) { lock.withLock { replies[path] = reply } }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        lock.withLock {
            recorded.append(call.path)
            return replies[call.path] ?? HarnessReply(status: 404, body: Data(#"{"error":"route inconnue"}"#.utf8))
        }
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

private func ok(_ json: String) -> HarnessReply { HarnessReply(status: 200, body: Data(json.utf8)) }

@MainActor private func connected(_ transport: Transport) async -> HarnessModel {
    let model = HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1), reporter: .off
    )
    _ = await model.configure(address: "vps.example", token: "t")
    return model
}

/// La carte telle que `buildCard` l'écrit (omp-harness/card.ts).
private let cardJSON = #"""
{"headline":"Où garder la liste des tests qui échouent déjà ?","stake":"Sans elle, chaque revue bloque sur 80 faux échecs.",
 "options":[{"label":"en base","impact":"Une table de plus, relue à chaque revue.","reversible":false,"cost":"moyen"},
            {"label":"en fichier","impact":"Un fichier à garder à jour.","reversible":true}],
 "recommended":"en base","confidence":"forte","reviewed":true,
 "schema":{"nodes":[{"id":"established","kind":"established","label":"La revue relance tous les tests.","recommended":false},
                    {"id":"ambiguity","kind":"ambiguity","label":"Où garder la liste des tests qui échouent déjà ?","recommended":false},
                    {"id":"option:0","kind":"option","label":"en base","recommended":true},
                    {"id":"impact:0","kind":"impact","label":"Une table de plus, relue à chaque revue.","recommended":false},
                    {"id":"option:1","kind":"option","label":"en fichier","recommended":false},
                    {"id":"impact:1","kind":"impact","label":"Un fichier à garder à jour.","recommended":false}],
           "edges":[{"from":"established","to":"ambiguity"},{"from":"ambiguity","to":"option:0"},{"from":"option:0","to":"impact:0"},
                    {"from":"ambiguity","to":"option:1"},{"from":"option:1","to":"impact:1"}]}}
"""#

private func run(_ id: String, state: String, step: String?, briefing: String? = nil) -> String {
    let step = step.map { #""\#($0)""# } ?? "null"
    let brief = briefing.map { #","briefing":\#($0)"# } ?? ""
    return #"{"id":"\#(id)","repo":"demo","slug":"a","title":"A","request":"a","state":"\#(state)","step":\#(step),"fixes":0,"modules":[],"createdAt":0,"updatedAt":0\#(brief)}"#
}

private func node(_ id: String, _ kind: String, _ label: String, step: String? = nil, parent: String? = nil, path: String? = nil, pattern: String? = nil, reads: Int = 0, outcome: String? = nil) -> String {
    func value(_ text: String?) -> String { text.map { #""\#($0)""# } ?? "null" }
    return #"{"id":"\#(id)","kind":"\#(kind)","label":"\#(label)","step":\#(value(step)),"parent":\#(value(parent)),"path":\#(value(path)),"pattern":\#(value(pattern)),"reads":\#(reads),"edits":0,"files":0,"grouped":false,"count":1,"outcome":\#(value(outcome))}"#
}

/// Un graphe tel que `SessionGraphs.view` le rend : deux étapes, des lectures, une recherche, un test, une escalade.
private func graphJSON(version: Int) -> String {
    let nodes = [
        node("step:1", "step", "specs"),
        node("dir:src", "dir", "src", path: "src"),
        node("file:src/a.ts", "file", "src/a.ts", parent: "dir:src", path: "src/a.ts", reads: 2),
        node("step:2", "step", "impl"),
        node("search:1", "search", "relance — src", step: "step:2", pattern: "relance"),
        node("file:src/b.ts", "file", "src/b.ts", parent: "dir:src", path: "src/b.ts", reads: 1),
        node("test:2:touched", "test", "touched", step: "step:2", outcome: "fail"),
        node("escalation:7", "escalation", "Où garder la liste ?", step: "step:2"),
    ].joined(separator: ",")
    let edges = #"[{"from":"step:1","to":"file:src/a.ts","kind":"read","count":2},{"from":"step:1","to":"step:2","kind":"led_to","count":1},{"from":"step:2","to":"search:1","kind":"searched","count":1},{"from":"step:2","to":"file:src/b.ts","kind":"read","count":1},{"from":"escalation:7","to":"file:src/b.ts","kind":"evidence","count":1}]"#
    return #"{"runId":"r1","version":\#(version),"updatedAt":1000,"nodes":[\#(nodes)],"edges":\#(edges),"ambiguities":[{"node":"escalation:7","kind":"escalation","evidence":["file:src/b.ts"]}]}"#
}

@Suite("Session en graphe — client")
@MainActor
struct SessionGrapheAppsTests {
    @Test("session-graphe-apps/AC-90 : une escalade porte sa carte (headline, stake, options avec impact, réversibilité, coût, recommandée, schéma établi → ambiguïté → options → impacts) ; sans carte, l'affichage historique reste")
    func decodesCardAndBriefing() throws {
        let item = #"{"id":7,"runId":"r1","category":"schema","question":"Où garder la liste des tests qui échouent déjà ?","options":["en base","en fichier"],"context":"Le détail.","status":"open","card":\#(cardJSON)}"#
        let old = #"{"id":8,"runId":"r1","category":"schema","question":"Q ?","options":["a","b"],"impacts":["ia","ib"],"recommended":"a","status":"open"}"#
        let briefing = #"{"feature":"Elle exporte les factures en CSV.","cards":[\#(cardJSON)]}"#
        let inbox = #"{"cursor":3,"batches":[{"run":\#(run("r1", state: "escalated", step: "impl")),"items":[\#(item),\#(old)]}],"awaiting":[\#(run("r2", state: "awaiting_human", step: "specs", briefing: briefing))],"decisions":[],"runs":[]}"#
        let decoded = try JSONDecoder().decode(HarnessInbox.self, from: Data(inbox.utf8))
        let escalation = try #require(decoded.batches.first?.items.first)
        let card = try #require(escalation.card)
        #expect(card.headline == "Où garder la liste des tests qui échouent déjà ?")
        #expect(card.stake == "Sans elle, chaque revue bloque sur 80 faux échecs.")
        #expect(card.options.map(\.label) == ["en base", "en fichier"])
        #expect(card.options.map(\.reversible) == [false, true])
        #expect(card.options.map(\.cost) == ["moyen", nil])
        #expect(card.isRecommended(card.options[0]) && !card.isRecommended(card.options[1]))
        #expect(card.schema.established?.label == "La revue relance tous les tests.")
        #expect(card.schema.ambiguity?.kind == "ambiguity")
        #expect(card.schema.branches.map(\.option.label) == ["en base", "en fichier"])
        #expect(card.schema.branches.map { $0.impact?.label } == ["Une table de plus, relue à chaque revue.", "Un fichier à garder à jour."])
        #expect(card.schema.branches.first?.option.recommended == true)
        // Une escalade sans carte (serveur ancien) garde ses champs historiques.
        let legacy = try #require(decoded.batches.first?.items.last)
        #expect(legacy.card == nil)
        #expect(legacy.choices.map(\.impact) == ["ia", "ib"])
        // Le briefing des specs à valider : la ligne de la feature, puis ses cartes.
        let awaiting = try #require(decoded.awaiting.first)
        #expect(awaiting.briefing?.feature == "Elle exporte les factures en CSV.")
        #expect(awaiting.briefing?.cards.first?.headline == card.headline)
        #expect(awaiting.briefing?.isEmpty == false)
        #expect(HarnessBriefing(feature: "", cards: []).isEmpty)
        // Un run sans briefing (autre route, serveur ancien) : `nil`, rien à montrer.
        let plain = try JSONDecoder().decode(HarnessRun.self, from: Data(run("r3", state: "running", step: "impl").utf8))
        #expect(plain.briefing == nil)
    }

    @Test("session-graphe-apps/AC-91 : la carte d'un graphe — une voie par étape (faite, puis bloquée quand la feature attend), dossiers dépliables sur leurs fichiers, preuves de l'escalade mises en évidence, focus sur ce qui fonde la question")
    func mapsLanesFoldersAndFocus() throws {
        let graph = try JSONDecoder().decode(HarnessGraph.self, from: Data(graphJSON(version: 4).utf8))
        let map = HarnessGraphMap.of(graph, runState: "escalated")
        #expect(map.lanes.map(\.step.label) == ["specs", "impl"])
        #expect(map.lanes.map(\.progress) == [.done, .blocked])
        #expect(HarnessGraphMap.of(graph, runState: "running").lanes.last?.progress == .running)
        #expect(HarnessGraphMap.of(graph, runState: "merged").lanes.last?.progress == .done)
        #expect(map.lanes[1].actions.map(\.id) == ["search:1", "test:2:touched", "escalation:7"])
        #expect(map.lanes[0].reads.map(\.id) == ["file:src/a.ts"])
        #expect(map.lanes[1].reads.map(\.id) == ["file:src/b.ts"])
        #expect(map.folders.map(\.id) == ["dir:src"])
        #expect(map.folders.first?.files.map(\.id) == ["file:src/a.ts", "file:src/b.ts"])
        #expect(map.folders.first?.canExpand == true)
        // L'escalade et sa preuve : ce que la carte d'une question surligne.
        let highlighted = graph.highlighted(escalation: 7)
        #expect(highlighted == ["escalation:7", "file:src/b.ts"])
        #expect(graph.highlighted(escalation: 99).isEmpty)
        #expect(graph.allHighlighted == highlighted)
        let focused = HarnessGraphMap.of(graph, runState: "escalated", focus: highlighted)
        #expect(focused.lanes.map(\.step.label) == ["impl"])
        #expect(focused.lanes.first?.actions.map(\.id) == ["escalation:7"])
        #expect(focused.lanes.first?.reads.map(\.id) == ["file:src/b.ts"])
        #expect(focused.folders.first?.files.map(\.id) == ["file:src/b.ts"])
        #expect(graph.nodes.first { $0.id == "escalation:7" }?.isAmbiguity == true)
    }

    @Test("session-graphe-apps/AC-92 : l'onglet « Carte » est absent d'un serveur sans graphe (404), lu sinon, et relu seulement quand l'événement `graph` annonce une version plus récente")
    func graphTabFollowsCapabilityAndEvents() async throws {
        let absent = Transport(["/v1/inbox": ok(#"{"cursor":0,"batches":[],"awaiting":[],"decisions":[],"runs":[]}"#)])
        let old = await connected(absent)
        let none = HarnessRunGraph(harness: old, runId: "r1")
        #expect(!none.showsTab)
        await none.load()
        #expect(none.availability == .absent)
        #expect(!none.showsTab)
        await none.receive(version: 9)
        #expect(absent.paths.filter { $0 == "/v1/runs/r1/graph" }.count == 1, "un serveur sans graphe n'est pas relu")

        let served = Transport([
            "/v1/inbox": ok(#"{"cursor":0,"batches":[],"awaiting":[],"decisions":[],"runs":[]}"#),
            "/v1/runs/r1/graph": ok(graphJSON(version: 4)),
        ])
        let server = await connected(served)
        let graph = HarnessRunGraph(harness: server, runId: "r1")
        await graph.load()
        #expect(graph.showsTab)
        #expect(graph.graph?.version == 4)
        await graph.receive(version: 4)
        #expect(served.paths.filter { $0 == "/v1/runs/r1/graph" }.count == 1, "la même version n'est pas relue")
        served.set("/v1/runs/r1/graph", ok(graphJSON(version: 5)))
        await graph.receive(version: 5)
        #expect(graph.graph?.version == 5)
        // Le corps de l'événement éphémère `graph` : `{version, nodes, edges}`.
        let event = HarnessStreamEvent(name: "graph", data: Data(#"{"runId":"r1","type":"graph","payload":{"version":6,"nodes":8,"edges":5}}"#.utf8))
        #expect(event.graphVersion == 6)
        #expect(HarnessStreamEvent(name: "session", data: event.data).graphVersion == nil)
        // Une réponse illisible se montre (l'onglet reste, avec l'échec).
        served.set("/v1/runs/r1/graph", ok(#"{"nodes":"illisible"}"#))
        await graph.receive(version: 7)
        #expect(graph.showsTab)
        if case .failed = graph.availability {} else { Issue.record("échec attendu : \(graph.availability)") }
    }

    @Test("session-graphe-apps/AC-93 : un nœud de la carte ouvre l'entrée du direct où il est né — l'étape, la recherche par son motif, le fichier par son chemin, l'escalade par son appel `decision` ; aucun lien inventé")
    func linksNodesToLiveEntries() throws {
        let graph = try JSONDecoder().decode(HarnessGraph.self, from: Data(graphJSON(version: 4).utf8))
        let entries = [
            HarnessSessionEntry(seq: 1, step: "specs", kind: "text", text: "Je lis la demande."),
            HarnessSessionEntry(seq: 2, step: "specs", kind: "tool", text: "lire", tool: "read", status: "ok", call: "read src/a.ts"),
            HarnessSessionEntry(seq: 3, step: "impl", kind: "text", text: "J'implémente."),
            HarnessSessionEntry(seq: 4, step: "impl", kind: "tool", text: "chercher", tool: "grep", status: "ok", call: "grep relance src"),
            HarnessSessionEntry(seq: 5, step: "impl", kind: "tool", text: "lire", tool: "read", status: "ok", call: "read src/b.ts:10-20"),
            HarnessSessionEntry(seq: 6, step: "impl", kind: "tool", text: "tests", tool: "run_tests", status: "error"),
            HarnessSessionEntry(seq: 7, step: "impl", kind: "tool", text: "Où garder la liste ?", tool: "decision", status: "ok"),
        ]
        let links = HarnessGraphLink.links(in: graph, entries: entries)
        #expect(links["step:1"] == 1)
        #expect(links["step:2"] == 3)
        #expect(links["search:1"] == 4)
        #expect(links["file:src/a.ts"] == 2)
        #expect(links["file:src/b.ts"] == 5)
        #expect(links["test:2:touched"] == 6)
        #expect(links["escalation:7"] == 7)
        // Sans le direct (rejoué plus tard, ou une autre feature) : aucun lien.
        #expect(HarnessGraphLink.links(in: graph, entries: [])[graph.nodes[0].id] == nil)
        #expect(HarnessGraphLink.links(in: graph, entries: Array(entries.prefix(3)))[graph.nodes[4].id] == nil)
    }

    @Test("session-graphe-apps/AC-94 : l'alerte locale d'une question à carte porte sa headline en titre et son stake en corps, rien d'autre ; sans carte, le texte générique reste")
    func localAlertCarriesHeadlineAndStake() throws {
        let carded = HarnessStreamEvent(name: "escalations", data: Data(#"{"id":12,"runId":"r1","repo":"demo","payload":{"step":"impl","items":[{"id":7,"category":"schema","question":"Où garder la liste ?","options":["a","b"],"stake":"Sans elle, chaque revue bloque."},{"id":8,"category":"schema","question":"Autre ?","options":["a","b"],"stake":null}]}}"#.utf8))
        let alert = try #require(HarnessNotificationRouting.localAlert(for: carded, client: nil))
        #expect(alert.title == "Où garder la liste ?")
        #expect(alert.body(runTitle: "Export") == "Sans elle, chaque revue bloque. · " + NotificationText.otherQuestions(1))
        #expect(!alert.body(runTitle: "Export").contains("a, b"))
        let plain = HarnessStreamEvent(name: "escalations", data: Data(#"{"id":13,"runId":"r1","repo":"demo","payload":{"items":[{"id":9,"category":"schema","question":"Q brute ?","options":["a","b"],"stake":null}]}}"#.utf8))
        let generic = try #require(HarnessNotificationRouting.localAlert(for: plain, client: nil))
        #expect(generic.title == NotificationText.questions(1))
        #expect(!generic.title.contains("Q brute"))
        #expect(!generic.body(runTitle: "Export").contains("Q brute"))
    }
}
