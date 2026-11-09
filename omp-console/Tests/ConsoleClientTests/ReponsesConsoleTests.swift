// Les réponses au collègue côté client (routes `/v1/replies*` et `origin.reply` de
// `GET /v1/runs/{id}/origin` d'omp-harness) : brouillons comptés au badge d'« À traiter »,
// relus à l'événement `reply`, rien pour un jeton qui n'est pas celui du propriétaire,
// gestes modifier/approuver/classer, origine `manual` à copier seulement — sur la
// doublure de transport. Données fictives.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

/// Un brouillon tel que le serveur l'écrit (champs internes compris, clé inconnue).
private func draftJSON(id: String, channel: String, url: String, state: String = "draft", text: String = "Bonjour, c’est corrigé.") -> String {
    #"{"id":"\#(id)","createdAt":1762600000000,"updatedAt":1762600001000,"runId":"r1","signalId":"sg1","kind":"final","state":"\#(state)","#
        + #""text":"\#(text)","requestId":null,"sendSeq":null,"error":null,"approvedBy":null,"approvedAt":null,"sentAt":null,"#
        + #""archivedBy":null,"archivedAt":null,"channel":"\#(channel)","url":"\#(url)","personRef":"lea@exemple.test","inconnu":1}"#
}

private let slackDraft = draftJSON(id: "rp1", channel: "slack", url: "https://acme.slack.example/archives/C0FAKE/p1")
private let manualDraft = draftJSON(id: "rp2", channel: "manual", url: "")
private let listJSON = #"{"replies":["# + slackDraft + "," + manualDraft + "]}"

private let ownerOnly = reply(#"{"error":"le poste est réservé au propriétaire"}"#, status: 403)
private let approverOnly = reply(#"{"error":"seul l'appareil approbateur (OMP Console appairée avec le code de `harness.sh approver`) peut approuver, refuser ou régler le poste"}"#, status: 403)

private func originJSON(_ state: String) -> String {
    #"{"origin":{"signalId":"sg1","channel":"slack","url":"https://acme.slack.example/archives/C0FAKE/p1","personRef":null,"#
        + #""excerpt":"Export cassé.","issue":{"repo":"demo","number":3,"url":"https://github.com/moi/demo/issues/3"},"#
        + #""confirmedBy":"app-approbateur","confirmedAt":1,"reply":"\#(state)"}}"#
}

private func replyServer(_ overrides: [String: HarnessReply] = [:]) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        if let forced = overrides["\(call.method) \(call.path)"] { return forced }
        switch (call.method, call.path) {
        case ("GET", "/v1/inbox"): return reply(#"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":1}"#)
        case ("GET", "/v1/signals?state=proposed&limit=200"): return reply(#"{"signals":[]}"#)
        case ("GET", "/v1/replies?state=draft&limit=200"): return reply(listJSON)
        case ("PUT", "/v1/replies/rp1"): return reply(#"{"reply":"# + draftJSON(id: "rp1", channel: "slack", url: "u", text: "Texte modifié") + "}")
        case ("POST", "/v1/replies/rp1/approve"):
            return reply(#"{"reply":"# + draftJSON(id: "rp1", channel: "slack", url: "u", state: "pending") + #","request":{"id":"wr1"}}"#, status: 201)
        case ("POST", "/v1/replies/rp2/archive"): return reply(#"{"reply":"# + draftJSON(id: "rp2", channel: "manual", url: "", state: "archived") + "}")
        case ("GET", "/v1/runs/r1/origin"): return reply(originJSON("en attente d'approbation"))
        case ("GET", "/v1/runs/r2/origin"): return reply(originJSON("relue"))
        default: return reply(#"{"error":"route inconnue"}"#, status: 404)
        }
    }
}

@MainActor
private func connected(_ transport: ScriptedHarnessTransport) async -> HarnessModel {
    let model = HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1)
    )
    _ = await model.configure(address: "vps.example", token: "t")
    return model
}

private func body(_ call: HarnessCall?) throws -> [String: Any] {
    let data = try #require(call?.body)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Suite("Réponses au collègue — client")
@MainActor
struct ReponsesConsoleTests {
    @Test("reponses-console/AC-1 : les brouillons sont décodés et comptés au badge, relus à l'événement reply ; 403 propriétaire ou 404 n'affichent rien, sans échec")
    func draftsAreListedAndCounted() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(replyServer())
        let server = await connected(transport)
        let signals = server.signals
        #expect(signals.pendingCount == 0 && signals.repliesAvailability == .unknown)

        await signals.refresh()
        #expect(signals.repliesAvailability == .available)
        #expect(signals.replies.map(\.id) == ["rp1", "rp2"])
        let first = try #require(signals.replies.first)
        #expect(first.channel == "slack" && first.kind == "final" && first.personRef == "lea@exemple.test" && first.text == "Bonjour, c’est corrigé.")
        #expect(signals.pendingCount == 2, "les brouillons s'ajoutent au badge d'À traiter")

        let before = transport.calls.filter { $0.path.hasPrefix("/v1/replies") }.count
        signals.receive(["reply"])
        try await Task.sleep(for: .milliseconds(100))
        #expect(transport.calls.filter { $0.path.hasPrefix("/v1/replies") }.count == before + 1)

        transport.respond(replyServer(["GET /v1/replies?state=draft&limit=200": ownerOnly]))
        await signals.refresh()
        #expect(signals.repliesAvailability == .reserved && signals.replies.isEmpty && signals.pendingCount == 0)
        #expect(signals.failure == nil && server.failure == nil)

        transport.respond(replyServer(["GET /v1/replies?state=draft&limit=200": reply(#"{"error":"route inconnue"}"#, status: 404)]))
        await signals.refresh()
        #expect(signals.repliesAvailability == .absent && signals.pendingCount == 0 && signals.failure == nil)
    }

    @Test("reponses-console/AC-2 : modifier, approuver et classer envoient le texte ; un refus d'approbateur revient au geste")
    func gesturesSendText() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(replyServer())
        let server = await connected(transport)
        let signals = server.signals
        await signals.refresh()
        let slack = try #require(signals.replies.first { $0.id == "rp1" })
        let manual = try #require(signals.replies.first { $0.id == "rp2" })

        let edited = try await signals.edit(slack, text: "Texte modifié")
        #expect(edited.text == "Texte modifié")
        #expect(try body(transport.calls.last { $0.method == "PUT" && $0.path == "/v1/replies/rp1" })["text"] as? String == "Texte modifié")

        let approved = try await signals.approve(slack, text: "Texte modifié")
        #expect(approved.state == "pending")
        #expect(try body(transport.calls.last { $0.path == "/v1/replies/rp1/approve" })["text"] as? String == "Texte modifié")

        try await signals.archive(manual)
        #expect(transport.calls.contains { $0.method == "POST" && $0.path == "/v1/replies/rp2/archive" })
        #expect(signals.busy.isEmpty)

        transport.respond(replyServer(["POST /v1/replies/rp1/approve": approverOnly]))
        await #expect(throws: HarnessFailure.approverOnly) {
            _ = try await signals.approve(slack, text: "x")
        }
        #expect(server.failure == nil, "aucun bandeau global")
        #expect(!SignalText.replyApproverOnly.isEmpty)
    }

    @Test("reponses-console/AC-3 : une origine manual se copie seulement ; les autres canaux s'envoient par le poste")
    func manualIsCopyOnly() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(replyServer())
        let server = await connected(transport)
        await server.signals.refresh()
        let byId = Dictionary(uniqueKeysWithValues: server.signals.replies.map { ($0.id, $0) })
        #expect(byId["rp2"]?.isCopyOnly == true)
        #expect(byId["rp1"]?.isCopyOnly == false)
        #expect(!SignalText.copyOnlyHint.isEmpty && !SignalText.copyReply.isEmpty)
    }

    @Test("reponses-console/AC-4 : origin.reply se décode en état fermé, un état inconnu se lit sans échouer")
    func originReplyState() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(replyServer())
        let server = await connected(transport)
        await server.signals.loadOrigin(runId: "r1")
        #expect(server.signals.origins["r1"]?.reply == .awaitingApproval)
        await server.signals.loadOrigin(runId: "r2")
        #expect(server.signals.origins["r2"]?.reply == .other("relue"))

        for (raw, state) in [("aucune", CorporateReplyStatus.none), ("brouillon", .draft), ("en attente d'approbation", .awaitingApproval), ("envoyée", .sent)] {
            let decoded = try JSONDecoder().decode(CorporateReplyStatus.self, from: Data("\"\(raw)\"".utf8))
            #expect(decoded == state && decoded.raw == raw)
        }
        #expect(!SignalText.replyAwaiting.isEmpty && !SignalText.replySent.isEmpty)
    }
}
