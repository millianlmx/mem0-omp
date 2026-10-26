// Le direct de la session OMP d'une feature : le tampon du serveur
// (`GET /v1/runs/{id}/session`), puis les entrées `session` du flux, qui remplacent
// celles de même `seq` — sur la doublure de transport, sans réseau.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private let sessionInbox = #"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":7}"#

/// Le tampon tel que le serveur l'écrit.
private let sessionJSON = #"""
{"runId":"r1","live":true,"cursor":9,"entries":[
  {"seq":1,"at":1700000000000,"step":"impl","kind":"text","text":"Je lis les routes.","tool":null,"status":null,"detail":null},
  {"seq":2,"at":1700000000500,"step":"impl","kind":"tool","text":"npm test","tool":"bash","status":"running","detail":null}
]}
"""#

/// Un événement `session` tel que le flux l'écrit (éphémère : sans ligne `id:`).
private func sessionEvent(_ entry: String) -> Data {
    Data("event: session\ndata: {\"id\":0,\"at\":1,\"runId\":\"r1\",\"repo\":\"demo\",\"type\":\"session\",\"payload\":{\"entry\":\(entry)},\"ephemeral\":true}\n\n".utf8)
}

@MainActor
private func sessionModel(_ transport: ScriptedHarnessTransport) -> HarnessModel {
    HarnessModel(transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(), retryDelay: .seconds(3600), refreshDelay: .milliseconds(1))
}

@Suite("Serveur de pipelines — direct d’une session")
@MainActor
struct HarnessSessionTests {
    @Test("le tampon se décode tel que le serveur l'écrit ; une entrée de même seq remplace, une autre prend sa place dans l'ordre")
    func feedApplies() throws {
        let view = try JSONDecoder().decode(HarnessSessionView.self, from: Data(sessionJSON.utf8))
        var feed = HarnessSessionFeed(target: .run("r1"))
        feed.load(view)
        #expect(feed.isLoaded && feed.isRunning)
        #expect(feed.entries.map(\.seq) == [1, 2])
        #expect(feed.current?.tool == "bash")
        feed.apply(HarnessSessionEntry(seq: 2, kind: "tool", text: "npm test", tool: "bash", status: "error", detail: "1 échec"))
        #expect(feed.entries.count == 2)
        #expect(feed.entries.last?.isFailure == true)
        #expect(feed.current == nil, "l'outil terminé n'est plus en cours")
        feed.apply(HarnessSessionEntry(seq: 4, kind: "text", text: "Je corrige."))
        feed.apply(HarnessSessionEntry(seq: 3, kind: "thinking", text: "Le test attend une virgule."))
        #expect(feed.entries.map(\.seq) == [1, 2, 3, 4])
        for seq in 5...(HarnessSessionFeed.keep + 10) { feed.apply(HarnessSessionEntry(seq: seq, kind: "text", text: "\(seq)")) }
        #expect(feed.entries.count == HarnessSessionFeed.keep)
        #expect(feed.entries.first?.seq == 11, "les plus anciennes partent")
    }

    @Test("un relu en cours de route garde les entrées déjà reçues et met à jour l'état du run")
    func feedMerges() {
        var feed = HarnessSessionFeed(target: .run("r1"), entries: [HarnessSessionEntry(seq: 5, kind: "text", text: "récente")], isRunning: true, isLoaded: true)
        feed.merge(HarnessSessionView(runId: "r1", live: false, entries: [HarnessSessionEntry(seq: 4, kind: "text", text: "ancienne")]))
        #expect(feed.entries.map(\.seq) == [4, 5])
        #expect(feed.isRunning == false)
    }

    @Test("le lecteur du flux rend nom et données ; seul un événement session porte une entrée")
    func parsesSessionEvents() {
        var parser = HarnessEventParser()
        let half = sessionEvent(#"{"seq":3,"at":2,"step":"fix","kind":"text","text":"Ok","tool":null,"status":null,"detail":null}"#)
        #expect(parser.consumeEvents(half.prefix(20)).isEmpty)
        let events = parser.consumeEvents(half.dropFirst(20) + Data("id: 10\nevent: run_state\ndata: {\"runId\":\"r1\"}\n\n".utf8))
        #expect(events.map(\.name) == ["session", "run_state"])
        #expect(events.first?.sessionEntry?.text == "Ok")
        #expect(events.first?.sessionEntry?.step == "fix")
        #expect(events.last?.sessionEntry == nil)
        #expect(events.last?.runId == "r1")
    }

    @Test("suivre une session ouvre le flux du run en direct depuis le curseur de la boîte, lit le tampon, puis applique chaque entrée")
    func followsSession() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            call.path == "/v1/runs/r1/session" ? reply(sessionJSON) : reply(sessionInbox)
        }
        let model = sessionModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        transport.stream([
            sessionEvent(#"{"seq":2,"at":2,"step":"impl","kind":"tool","text":"npm test","tool":"bash","status":"ok","detail":"12 tests verts"}"#),
            sessionEvent(#"{"seq":3,"at":3,"step":"impl","kind":"text","text":"Tests verts.","tool":null,"status":null,"detail":null}"#),
        ])
        model.followSession(runId: "r1")
        #expect(await eventually { model.session?.entries.count == 3 })
        #expect(transport.calls.contains { $0.path == "/v1/events?run=r1&live=1&after=7" })
        #expect(model.session?.entries.map(\.seq) == [1, 2, 3])
        #expect(model.session?.entries[1].detail == "12 tests verts")
        #expect(model.session?.isRunning == true)
        #expect(model.sessionFailure == nil)
        model.stopSession()
        #expect(model.session == nil)
        #expect(model.isSessionLive == false)
    }

    @Test("un outil garde sa commande à côté de son intention, sa durée, et signale son détail ; un serveur plus ancien n'en dit rien")
    func entryCarriesCall() throws {
        let json = #"{"seq":2,"at":1700000000000,"step":"impl","kind":"tool","text":"Lancer les tests","tool":"bash","status":"ok","detail":"12 passing","call":"npm test","endedAt":1700000002500,"hasDetails":true}"#
        let entry = try JSONDecoder().decode(HarnessSessionEntry.self, from: Data(json.utf8))
        #expect(entry.distinctCall == "npm test")
        #expect(entry.durationMs == 2500)
        #expect(entry.canOpenDetails)
        let same = HarnessSessionEntry(seq: 3, kind: "tool", text: "npm test", tool: "bash", status: "running", call: "npm test", hasDetails: true)
        #expect(same.distinctCall == nil, "sans intention, la commande est déjà le texte")
        #expect(same.durationMs == nil, "un outil qui tourne n'a pas de durée")
        let old = try JSONDecoder().decode(HarnessSessionEntry.self, from: Data(#"{"seq":1,"at":2,"step":"impl","kind":"tool","text":"npm test","tool":"bash","status":"ok","detail":null}"#.utf8))
        #expect(old.call == nil && old.endedAt == nil && old.hasDetails == nil)
        #expect(!old.canOpenDetails)
    }

    @Test("le détail d'une entrée se lit à part, sur le run ou l'audit suivi ; une entrée oubliée rend nil")
    func readsEntryDetail() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            switch call.path {
            case "/v1/runs/r1/session/2":
                reply(#"{"runId":"r1","auditId":null,"entry":{"seq":2,"at":1,"step":"impl","kind":"tool","text":"Lancer les tests","tool":"bash","status":"running","detail":"1 passing","call":"npm test","endedAt":null,"hasDetails":true},"args":"command: npm test","output":"1 passing\n2 passing"}"#)
            case "/v1/audits/a1/session/1":
                reply(#"{"runId":null,"auditId":"a1","entry":{"seq":1,"at":1,"step":null,"kind":"text","text":"…fin","tool":null,"status":null,"detail":null,"call":null,"endedAt":null,"hasDetails":true},"args":null,"output":"Début…fin"}"#)
            case "/v1/runs/r1/session/9":
                reply(#"{"error":"entrée de session inconnue : 9"}"#, status: 404)
            default:
                reply(sessionInbox)
            }
        }
        let model = sessionModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        let tool = await model.sessionDetail(.run("r1"), seq: 2)
        #expect(tool?.args == "command: npm test")
        #expect(tool?.output == "1 passing\n2 passing")
        #expect(tool?.entry.isRunning == true)
        let text = await model.sessionDetail(.audit("a1"), seq: 1)
        #expect(text?.output == "Début…fin")
        #expect(text?.args == nil)
        #expect(await model.sessionDetail(.run("r1"), seq: 9) == nil)
    }

    @Test("un serveur qui ne connaît pas le direct l'arrête, avec son motif, sans réessayer")
    func unsupportedServer() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            call.path == "/v1/runs/r1/session" ? reply(#"{"error":"route inconnue"}"#, status: 404) : reply(sessionInbox)
        }
        let model = sessionModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        model.followSession(runId: "r1")
        #expect(await eventually { model.sessionFailure != nil })
        #expect(model.sessionFailure == .rejected("route inconnue"))
        #expect(model.failure == nil, "l'échec du direct ne gagne pas les autres écrans")
        model.stopSession()
        #expect(model.sessionFailure == nil)
    }
}
