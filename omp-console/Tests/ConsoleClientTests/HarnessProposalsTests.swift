// PROPOSITIONS et SESSIONS LOCALES côté client (contrat §4 et §5) : les formes JSON,
// accepter ou écarter une proposition, passer le relais d'une session locale à l'usine,
// la retirer, les relectures sur événement, et les serveurs qui ne les servent pas
// (404) ou pas à ce jeton (403) — sur la doublure de transport.

@testable import ConsoleClient
import Foundation
import Testing

private let proposalsJSON = #"""
{"proposals":[
 {"id":"issue.0123456789abcdef","source":"issue","repo":"demo","title":"Le panier se vide","detail":"Issue #42, label harness","url":"https://forge/issues/42","createdAt":300,"action":"fix"},
 {"id":"autonomy.fedcba9876543210","source":"autonomy","repo":"demo","title":"Docs : valider seul la revue","detail":"12 jugées, 0 corrigée","url":null,"createdAt":200,"action":"apply"},
 {"id":"futur.0000000000000000","source":"source_future","repo":null,"title":"Autre","detail":"","url":null,"createdAt":100,"action":"geste_futur"}
]}
"""#

private func sessionJSON(_ id: String, state: String, repo: String? = "demo", runId: String? = nil, updatedAt: Int) -> String {
    #"{"id":""# + id + #"","client":"mac","host":"macbook","cwd":"/Users/moi/demo","repo":"# + (repo.map { "\"\($0)\"" } ?? "null")
        + #","remote":"git@forge:moi/demo.git","branch":"feat/export","title":"Export CSV","intent":"Lit le schéma","tool":"read","state":""# + state
        + #"","model":"opus","cost":0.8,"runId":"# + (runId.map { "\"\($0)\"" } ?? "null") + #","startedAt":1000,"updatedAt":\#(updatedAt),"endedAt":null}"#
}

private let sessionsJSON = #"{"sessions":["# + [
    sessionJSON("s1", state: "idle", updatedAt: 2000),
    sessionJSON("s2", state: "working", repo: nil, updatedAt: 3000),
    sessionJSON("s3", state: "ended", updatedAt: 1500),
].joined(separator: ",") + "]}"

@Suite("Propositions et sessions locales — client")
@MainActor
struct HarnessProposalsTests {
    @Test("les propositions se lisent dans l'ordre du serveur ; une origine ou un geste inconnus de cette version restent lisibles")
    func list() async throws {
        let model = await osConnected(osTransport(routes: ["GET /v1/proposals": osJSON(proposalsJSON)]))
        await model.proposals.refresh()
        #expect(model.proposals.availability == .available)
        #expect(model.proposals.proposals.map(\.id) == ["issue.0123456789abcdef", "autonomy.fedcba9876543210", "futur.0000000000000000"])
        let issue = try #require(model.proposals.proposals.first)
        #expect(issue.origin == .issue && issue.gesture == .fix && issue.repo == "demo")
        #expect(issue.detail == "Issue #42, label harness" && issue.url == "https://forge/issues/42" && issue.createdAt == 300)
        let future = model.proposals.proposals[2]
        #expect(future.origin == nil && future.gesture == nil && future.repo == nil && future.url == nil)
        #expect(HarnessProposalSource.allCases.map(\.rawValue) == ["issue", "vigie", "audit", "signal", "jira", "autonomy", "retry", "pr", "ci"])
        #expect(HarnessProposalAction.allCases.map(\.rawValue) == ["launch", "fix", "apply", "confirm", "retry"])
    }

    @Test("un serveur sans /v1/proposals (404) : les propositions sont absentes, sans échec")
    func olderServer() async {
        let model = await osConnected(osTransport(routes: [:]))
        await model.proposals.refresh()
        #expect(model.proposals.availability == .absent && !model.proposals.isServed)
        #expect(model.proposals.proposals.isEmpty && model.proposals.failure == nil)
    }

    @Test("accepter une proposition rend ce qui en est né et la retire ; la boîte est relue ; une acceptation sans objet créé reste une réussite")
    func accept() async throws {
        let issue = #"{"id":"issue.0123456789abcdef","source":"issue","repo":"demo","title":"Le panier se vide","detail":"","url":null,"createdAt":300,"action":"fix"}"#
        let rule = #"{"id":"autonomy.fedcba9876543210","source":"autonomy","repo":"demo","title":"Docs","detail":"","url":null,"createdAt":200,"action":"apply"}"#
        let transport = osTransport(routes: [
            "GET /v1/proposals": osJSON(proposalsJSON),
            "POST /v1/proposals/issue.0123456789abcdef/accept": osJSON(#"{"proposal":"# + issue + #","created":{"kind":"run","id":"r7"}}"#),
            "POST /v1/proposals/autonomy.fedcba9876543210/accept": osJSON(#"{"proposal":"# + rule + #","created":null}"#),
        ])
        let model = await osConnected(transport)
        await model.proposals.refresh()
        let boxes = transport.count("GET", "/v1/inbox")

        let accepted = try #require(await model.proposals.accept(model.proposals.proposals[0]))
        #expect(accepted.created == HarnessProposalCreated(kind: "run", id: "r7"))
        #expect(accepted.created?.runId == "r7")
        #expect(transport.rawBody("POST", "/v1/proposals/issue.0123456789abcdef/accept") == "{}")
        #expect(model.proposals.proposals.map(\.source) == ["autonomy", "source_future"])
        #expect(transport.count("GET", "/v1/inbox") == boxes + 1)

        let applied = try #require(await model.proposals.accept(model.proposals.proposals[0]))
        #expect(applied.created == nil)
        #expect(HarnessProposalCreated(kind: "rule", id: "x").runId == nil)
        #expect(model.proposals.busy.isEmpty && model.proposals.failure == nil)
    }

    @Test("une proposition disparue (404) ou refusée : l'échec le dit, et la liste relue ne l'efface pas ; écarter appelle dismiss et la retire")
    func refusedAndDismiss() async throws {
        let transport = osTransport(routes: [
            "GET /v1/proposals": osJSON(proposalsJSON),
            "POST /v1/proposals/issue.0123456789abcdef/accept": osJSON(#"{"error":"proposition inconnue"}"#, status: 404),
            "POST /v1/proposals/autonomy.fedcba9876543210/dismiss": osJSON(#"{"dismissed":true}"#),
        ])
        let model = await osConnected(transport)
        await model.proposals.refresh()
        let reads = transport.count("GET", "/v1/proposals")

        #expect(await model.proposals.accept(model.proposals.proposals[0]) == nil)
        #expect(model.proposals.failure == .rejected("proposition inconnue"))
        #expect(transport.count("GET", "/v1/proposals") == reads + 1, "la liste est relue : la proposition a pu disparaître")

        #expect(await model.proposals.dismiss(model.proposals.proposals[1]))
        #expect(transport.last("POST", "/v1/proposals/autonomy.fedcba9876543210/dismiss") != nil)
        #expect(!model.proposals.proposals.contains { $0.source == "autonomy" })

        let before = transport.count("GET", "/v1/proposals")
        transport.push(events: ["proposals"])
        model.startLive()
        #expect(await eventually { transport.count("GET", "/v1/proposals") > before })
        model.stopLive()
    }

    @Test("les sessions locales se lisent, les plus récemment actives d'abord : état, dépôt reconnu ou non, ce que l'agent fait")
    func sessions() async throws {
        let model = await osConnected(osTransport(routes: ["GET /v1/local-sessions": osJSON(sessionsJSON)]))
        await model.localSessions.refresh()
        #expect(model.localSessions.availability == .available)
        #expect(model.localSessions.sessions.map(\.id) == ["s2", "s1", "s3"])
        #expect(model.localSessions.live.map(\.id) == ["s2", "s1"])
        let idle = try #require(model.localSessions.sessions.first { $0.id == "s1" })
        #expect(idle.phase == .idle && idle.isLive && idle.canHandOff)
        #expect(idle.host == "macbook" && idle.cwd == "/Users/moi/demo" && idle.branch == "feat/export" && idle.remote == "git@forge:moi/demo.git")
        #expect(idle.intent == "Lit le schéma" && idle.tool == "read" && idle.model == "opus" && idle.cost == 0.8)
        #expect(idle.startedAt == 1000 && idle.endedAt == nil && idle.runId == nil)
        let working = try #require(model.localSessions.sessions.first)
        #expect(working.phase == .working && !working.canHandOff, "sans dépôt reconnu, l'usine ne peut pas reprendre")
        #expect(model.localSessions.sessions[2].phase == .ended && !model.localSessions.sessions[2].isLive)
        #expect(HarnessLocalSessionState.allCases.map(\.rawValue) == ["working", "idle", "ended"])
    }

    @Test("un serveur sans sessions locales (404) est absent ; un jeton qui n'en est pas le propriétaire (403) n'en voit aucune, sans échec affiché")
    func notServed() async {
        let older = await osConnected(osTransport(routes: [:]))
        await older.localSessions.refresh()
        #expect(older.localSessions.availability == .absent && !older.localSessions.isServed)
        #expect(older.localSessions.failure == nil)

        let narrow = await osConnected(osTransport(routes: [
            "GET /v1/local-sessions": osJSON(#"{"error":"réservé au propriétaire"}"#, status: 403),
        ]))
        await narrow.localSessions.refresh()
        #expect(narrow.localSessions.availability == .forbidden("réservé au propriétaire"))
        #expect(!narrow.localSessions.isServed && narrow.localSessions.sessions.isEmpty && narrow.localSessions.failure == nil)
    }

    @Test("passer le relais crée une feature qui reprend la session : la consigne rognée part si elle est donnée, la session porte la feature ; inconnue du serveur (409), l'échec le dit")
    func handoff() async throws {
        let transport = osTransport { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/local-sessions"): osJSON(sessionsJSON)
            case ("POST", "/v1/local-sessions/s1/handoff"):
                osJSON(#"{"run":"# + osRunJSON("r8", state: "queued", step: "req") + #","session":"# + sessionJSON("s1", state: "idle", runId: "r8", updatedAt: 2000) + "}", status: 201)
            case ("POST", "/v1/local-sessions/s2/handoff"): osJSON(#"{"error":"dépôt inconnu"}"#, status: 409)
            default: nil
            }
        }
        let model = await osConnected(transport)
        await model.localSessions.refresh()
        let idle = try #require(model.localSessions.sessions.first { $0.id == "s1" })
        let orphan = try #require(model.localSessions.sessions.first { $0.id == "s2" })

        let run = try #require(await model.localSessions.handoff(idle, request: "  finis les tests  "))
        #expect(run.id == "r8")
        #expect(transport.rawBody("POST", "/v1/local-sessions/s1/handoff") == #"{"request":"finis les tests"}"#)
        let handed = try #require(model.localSessions.sessions.first { $0.id == "s1" })
        #expect(handed.runId == "r8" && !handed.canHandOff)

        _ = await model.localSessions.handoff(idle)
        #expect(transport.rawBody("POST", "/v1/local-sessions/s1/handoff") == "{}", "sans consigne, le corps est vide")

        #expect(await model.localSessions.handoff(orphan) == nil)
        #expect(model.localSessions.failure == .rejected("dépôt inconnu"))
        #expect(model.localSessions.busy.isEmpty)
    }

    @Test("retirer une session appelle DELETE et l'enlève de la liste ; l'événement `local_session` fait relire")
    func deleteAndLiveReload() async throws {
        let transport = osTransport(routes: [
            "GET /v1/local-sessions": osJSON(sessionsJSON),
            "DELETE /v1/local-sessions/s3": osJSON(#"{"removed":true}"#),
        ])
        let model = await osConnected(transport)
        await model.localSessions.refresh()
        let ended = try #require(model.localSessions.sessions.first { $0.id == "s3" })

        #expect(await model.localSessions.delete(ended))
        #expect(transport.last("DELETE", "/v1/local-sessions/s3") != nil)
        #expect(model.localSessions.sessions.map(\.id) == ["s2", "s1"])

        let reads = transport.count("GET", "/v1/local-sessions")
        transport.push(events: ["local_session"])
        model.startLive()
        #expect(await eventually { transport.count("GET", "/v1/local-sessions") > reads })
        model.stopLive()

        await model.forget()
        #expect(model.localSessions.availability == .unknown && model.localSessions.sessions.isEmpty)
    }
}
