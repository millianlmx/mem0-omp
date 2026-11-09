// Atlassian côté client : le format JSON des routes `/v1/atlassian*` (champs absents
// tolérés), les gestes (connexion, retour collé, publication avec texte édité, rejet) et
// la disponibilité (404 → absent, 403 approbateur → `.approverOnly`).

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private let emptyInbox = #"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":1}"#

private let statusJSON = #"""
{"atlassian":{"enabled":true,"connected":true,"site":{"cloudId":"c1","url":"https://exemple.atlassian.net"},
 "accountId":"712020:abc","connectedAt":1762600000000,"connectedBy":"mac","expiresAt":1762628800000,"lastError":null,
 "redirectUri":"http://127.0.0.1:53682/callback","pasteBack":true,"pending":null,
 "plan":{"hour":8,"weekdaysOnly":true,"lastAt":null},"knowledge":{"everyHours":24,"lastAt":null,"lastSummary":null},"proposed":1}}
"""#

private let writeJSON = #"""
{"id":"w1","kind":"comment","issueKey":"ABC-12","body":"Corrigé en recette.","why":"le ticket attend un retour","state":"proposed",
 "by":"poste:service","error":null,"decidedBy":null,"createdAt":1762600000000,"updatedAt":1762600000000}
"""#

private let planJSON = #"""
{"plan":{"id":"p1","createdAt":1762600000000,"trigger":"auto","by":"poste:plan","summary":"Trois tickets à pousser.",
 "items":[{"title":"Finir ABC-12","why":"échéance demain","next":"relire la PR","source":"jira","key":"ABC-12",
   "url":"https://exemple.atlassian.net/browse/ABC-12","repo":"demo","request":"corrige l'export"},
  {"title":"Préparer la démo"}]}}
"""#

private let approverRefusal = #"{"error":"seul l'appareil approbateur peut le faire"}"#

private func atlassianServer(_ overrides: [String: HarnessReply] = [:]) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        if let forced = overrides["\(call.method) \(call.path)"] { return forced }
        switch (call.method, call.path) {
        case ("GET", "/v1/inbox"): return reply(emptyInbox)
        case ("GET", "/v1/atlassian"): return reply(statusJSON)
        case ("GET", "/v1/atlassian/writes?state=proposed&limit=200"): return reply(#"{"writes":[\#(writeJSON)]}"#)
        case ("GET", "/v1/atlassian/plan"): return reply(planJSON)
        default: return reply(#"{"error":"route inconnue"}"#, status: 404)
        }
    }
}

@MainActor
private func connectedServer(_ transport: ScriptedHarnessTransport) async -> HarnessModel {
    let model = HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1), reporter: .off
    )
    _ = await model.configure(address: "vps.example", token: "t")
    return model
}

private func body(of call: HarnessCall) -> String {
    call.body.map { String(decoding: $0, as: UTF8.self) } ?? ""
}

@Suite("Atlassian") @MainActor struct AtlassianTests {
    @Test("décode le statut, le plan et une écriture ; les champs absents prennent leur valeur neutre")
    func decodes() throws {
        let status = try JSONDecoder().decode(AtlassianStatusReply.self, from: Data(statusJSON.utf8)).atlassian
        #expect(status.connected && status.pasteBack && status.proposed == 1)
        #expect(status.site?.url == "https://exemple.atlassian.net" && status.plan.hour == 8 && status.knowledge.everyHours == 24)
        let bare = try JSONDecoder().decode(AtlassianStatus.self, from: Data(#"{"connected":false}"#.utf8))
        #expect(bare.enabled && !bare.pasteBack && bare.site == nil && bare.plan.hour == nil && bare.proposed == 0)

        let plan = try #require(try JSONDecoder().decode(AtlassianPlanReply.self, from: Data(planJSON.utf8)).plan)
        #expect(plan.items.count == 2)
        #expect(plan.items[0].launch?.repo == "demo" && plan.items[0].link?.host == "exemple.atlassian.net")
        #expect(plan.items[1].launch == nil && plan.items[1].link == nil && plan.items[1].source == "autre")
        #expect(try JSONDecoder().decode(AtlassianPlanReply.self, from: Data(#"{"plan":null}"#.utf8)).plan == nil)

        let write = try JSONDecoder().decode(AtlassianWrite.self, from: Data(writeJSON.utf8))
        #expect(write.issueKey == "ABC-12" && write.state == "proposed" && write.error == nil)
        let minimal = try JSONDecoder().decode(AtlassianWrite.self, from: Data(#"{"id":"w2"}"#.utf8))
        #expect(minimal.kind == "comment" && minimal.body.isEmpty && minimal.decidedBy == nil)
    }

    @Test("relit statut, propositions et plan ; 404 rend la page absente")
    func refreshesAndHidesOn404() async {
        let transport = ScriptedHarnessTransport()
        transport.respond(atlassianServer())
        let server = await connectedServer(transport)
        let atlassian = server.atlassian
        await atlassian.refresh()
        #expect(atlassian.availability == .available && atlassian.pendingCount == 1 && atlassian.plan?.id == "p1")

        transport.respond(atlassianServer(["GET /v1/atlassian": reply(#"{"error":"Atlassian désactivé"}"#, status: 404)]))
        await atlassian.refresh()
        #expect(atlassian.availability == .absent && atlassian.status == nil && atlassian.pendingCount == 0 && atlassian.failure == nil)
    }

    @Test("connect envoie POST /v1/atlassian/connect et rend le lien d'autorisation")
    func connects() async throws {
        let transport = ScriptedHarnessTransport()
        let authorize = "https://auth.atlassian.com/authorize?client_id=x&state=s"
        transport.respond(atlassianServer([
            "POST /v1/atlassian/connect": reply(#"{"authorizeUrl":"\#(authorize)","redirectUri":"http://127.0.0.1:53682/callback","expiresAt":1,"pasteBack":true}"#),
        ]))
        let server = await connectedServer(transport)
        let url = await server.atlassian.connect()
        #expect(url?.absoluteString == authorize)
        let call = try #require(transport.calls.last { $0.method == "POST" })
        #expect(call.path == "/v1/atlassian/connect" && body(of: call) == "{}")
    }

    @Test("submitCallback envoie l'adresse collée à POST /v1/atlassian/callback")
    func submitsCallback() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(atlassianServer(["POST /v1/atlassian/callback": reply(statusJSON)]))
        let server = await connectedServer(transport)
        let pasted = "http://127.0.0.1:53682/callback?code=c&state=s"
        #expect(await server.atlassian.submitCallback("  \(pasted)\n"))
        let call = try #require(transport.calls.last { $0.method == "POST" })
        #expect(call.path == "/v1/atlassian/callback")
        let sent = try JSONDecoder().decode([String: String].self, from: try #require(call.body))
        #expect(sent == ["url": pasted])
        #expect(server.atlassian.status?.connected == true)
    }

    @Test("approve publie le texte édité ; dismiss écarte")
    func approvesAndDismisses() async throws {
        let transport = ScriptedHarnessTransport()
        let sent = writeJSON.replacingOccurrences(of: #""state":"proposed""#, with: #""state":"sent""#)
        transport.respond(atlassianServer([
            "POST /v1/atlassian/writes/w1/approve": reply(#"{"write":\#(sent)}"#),
            "POST /v1/atlassian/writes/w1/dismiss": reply(#"{"write":\#(sent)}"#),
        ]))
        let server = await connectedServer(transport)
        await server.atlassian.refresh()
        #expect(await server.atlassian.approve("w1", body: "Corrigé et vérifié en recette."))
        let approve = try #require(transport.calls.last { $0.method == "POST" })
        #expect(approve.path == "/v1/atlassian/writes/w1/approve")
        let edited = try JSONDecoder().decode([String: String].self, from: try #require(approve.body))
        #expect(edited == ["body": "Corrigé et vérifié en recette."])

        #expect(await server.atlassian.dismiss("w1"))
        let dismiss = try #require(transport.calls.last { $0.method == "POST" })
        #expect(dismiss.path == "/v1/atlassian/writes/w1/dismiss" && body(of: dismiss) == "{}")
    }

    @Test("un jeton non approbateur : le geste échoue en .approverOnly")
    func approverOnly() async {
        let transport = ScriptedHarnessTransport()
        transport.respond(atlassianServer(["POST /v1/atlassian/writes/w1/approve": reply(approverRefusal, status: 403)]))
        let server = await connectedServer(transport)
        await server.atlassian.refresh()
        #expect(await server.atlassian.approve("w1", body: nil) == false)
        #expect(server.atlassian.failure == .approverOnly)
        #expect(server.atlassian.availability == .available && server.atlassian.pendingCount == 1)
    }
}
