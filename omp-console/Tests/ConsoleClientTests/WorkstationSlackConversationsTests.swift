// Les canaux Slack suivis côté client (routes `/v1/workstation/channels/slack/conversations*`
// d'omp-harness) : la liste de l'espace avec la case « suivi » de chacun, le geste de
// l'appareil approbateur avec son corps exact, le refus d'un jeton ordinaire rendu au geste,
// et aucune liste sur un serveur sans la route ou sans Slack lisible — sur la doublure de
// transport. Aucune donnée réelle : canaux et identifiants inventés.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private let listJSON = #"""
{"conversations":[
  {"id":"G1","name":"equipe-privee","kind":"private","archived":false,"followed":false},
  {"id":"C1","name":"projet-alpha","kind":"public","archived":false,"followed":false,"inconnu":1}]}
"""#
private let followedJSON = #"{"conversation":{"id":"C1","name":"projet-alpha","kind":"public","archived":false,"followed":true}}"#
private let approverOnly = reply(#"{"error":"seul l'appareil approbateur (OMP Console appairée avec le code de `harness.sh approver`) peut approuver, refuser ou régler le poste"}"#, status: 403)

private func slackServer(_ overrides: [String: HarnessReply] = [:]) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        if let forced = overrides["\(call.method) \(call.path)"] { return forced }
        switch (call.method, call.path) {
        case ("GET", "/v1/inbox"): return reply(#"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":1}"#)
        case ("GET", "/v1/me"): return reply(#"{"client":{"name":"app","role":"admin","repos":"*","createdAt":0,"approver":true}}"#)
        case ("GET", "/v1/workstation/channels/slack/conversations"): return reply(listJSON)
        case ("PUT", "/v1/workstation/channels/slack/conversations/C1"): return reply(followedJSON)
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

@Suite("Canaux Slack suivis — client")
@MainActor
struct WorkstationSlackConversationsTests {
    @Test("lecture-canaux/AC-9 : la liste des canaux de l'espace se lit avec la case « suivi » ; cocher envoie {followed: true} à la route du canal et la ligne prend la réponse")
    func followsAChannel() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(slackServer())
        let server = await connected(transport)
        let slack = server.channels.slackConversations
        #expect(slack.availability == .unknown)

        await slack.refresh()
        #expect(slack.availability == .available && slack.failure == nil)
        #expect(slack.conversations.map(\.id) == ["G1", "C1"])
        #expect(slack.conversations.map(\.followed) == [false, false])
        #expect(slack.conversations.first?.kind == "private")

        try await slack.setFollowed("C1", true)
        let sent = try #require(transport.calls.last { $0.method == "PUT" })
        let data = try #require(sent.body)
        let body = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body.count == 1 && body["followed"] as? Bool == true)
        #expect(slack.conversations.map(\.followed) == [false, true])
        #expect(slack.busy.isEmpty)
    }

    @Test("lecture-canaux/AC-9 : un jeton ordinaire reçoit le refus du serveur au geste, sans rien changer")
    func refusalReturnsToTheGesture() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(slackServer(["PUT /v1/workstation/channels/slack/conversations/C1": approverOnly]))
        let server = await connected(transport)
        let slack = server.channels.slackConversations
        await slack.refresh()

        await #expect(throws: HarnessFailure.approverOnly) { try await slack.setFollowed("C1", true) }
        #expect(slack.conversations.map(\.followed) == [false, false])
        #expect(slack.failure == nil)
    }

    @Test("lecture-canaux/AC-9 : un serveur sans la route (404) ou un Slack non lisible (409) n'a pas de liste, sans échec ; oublier le serveur oublie la liste")
    func absentWithoutTheRoute() async throws {
        for status in [404, 409] {
            let transport = ScriptedHarnessTransport()
            transport.respond(slackServer([
                "GET /v1/workstation/channels/slack/conversations": reply(#"{"error":"non"}"#, status: status),
            ]))
            let server = await connected(transport)
            let slack = server.channels.slackConversations
            await slack.refresh()
            #expect(slack.availability == .absent)
            #expect(slack.conversations.isEmpty && slack.failure == nil)
        }

        let transport = ScriptedHarnessTransport()
        transport.respond(slackServer())
        let server = await connected(transport)
        let slack = server.channels.slackConversations
        await slack.refresh()
        server.channels.reset()
        #expect(slack.availability == .unknown && slack.conversations.isEmpty)
    }
}
