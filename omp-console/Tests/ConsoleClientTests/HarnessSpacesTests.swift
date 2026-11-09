// ESPACES, BRIEF et CHIFFRES côté client (contrat §3) : chaque forme JSON du contrat,
// les corps des écritures d'un espace (`If-Match`), le rapport, le brief « pendant votre
// absence » et son « vu », les trois indicateurs, et le serveur antérieur (404) — sur la
// doublure de transport.

@testable import ConsoleClient
import Foundation
import Testing

private func spaceJSON(_ id: String, name: String, repos: String, rev: Int = 1, extra: String = "") -> String {
    #"{"id":""# + id + #"","name":""# + name + #"","repos":"# + repos
        + #","poste":false,"jiraProjects":["ACME"],"dailyBudgetUsd":20,"autonomy":"deliver","by":"mac","createdAt":1,"updatedAt":2,"rev":\#(rev)"# + extra + "}"
}

private let stats = #","memoryScopes":["acme/boutique"],"stats":{"working":2,"yours":1,"queued":3,"mergedWeek":7,"failedWeek":1,"cancelledWeek":2,"costToday":4.2,"costWeek":31.5,"budgetLeftToday":15.8}"#

private let spacesJSON = #"{"spaces":["# + [
    spaceJSON("s2", name: "Zeta", repos: #"["docs"]"#, extra: #","memoryScopes":[],"stats":{"working":0,"yours":0,"queued":0,"mergedWeek":0,"failedWeek":0,"cancelledWeek":0,"costToday":0,"costWeek":0,"budgetLeftToday":null}"#),
    spaceJSON("s1", name: "acme", repos: #"["boutique","api"]"#, rev: 3, extra: stats),
].joined(separator: ",") + "]}"

private let briefJSON = #"""
{"brief":{"since":1000,"until":2000,"seenAt":1000,"headline":"1 livrée, 1 vous attend, 2 propositions — 4,20 $",
 "delivered":[{"runId":"r1","repo":"demo","title":"Export CSV","prUrl":"https://forge/pr/1","at":1500,"cost":1.2,"alone":true}],
 "waiting":[{"runId":"r2","repo":"demo","title":"Panier","wait":"specs","since":1600}],
 "failed":[{"runId":"r3","repo":"demo","title":"Cache","reason":"tests rouges","at":1700}],
 "stopped":[{"runId":"r4","repo":"demo","title":"Thème","cause":"too_big","at":1800},{"runId":"r5","repo":"demo","title":"Logo","cause":null,"at":1810}],
 "decided":[{"runId":"r1","repo":"demo","title":"Export CSV","seq":2,"question":"Séparateur ?","chosen":";","status":"auto"}],
 "blocked":[{"runId":"r6","repo":"demo","title":"Suite","cause":"parent","text":"attend la fusion de « Export CSV »"}],
 "proposals":2,"cost":4.2}}
"""#

private let emptyBrief = #"""
{"brief":{"since":1000,"until":2000,"seenAt":null,"headline":"Rien de neuf.","delivered":[],"waiting":[],"failed":[],"stopped":[],
 "decided":[],"blocked":[],"proposals":0,"cost":0}}
"""#

private let scoreboardJSON = #"""
{"scoreboard":{"since":1000,"until":2000,"merged":10,"mergedAlone":4,"aloneRate":0.4,"decisions":6,"medianDecisionMs":540000,
 "started":20,"startedAlone":5,"startedAloneRate":0.25,"cancelled":7,"cancelCauses":{"off_target":3,"none":3,"too_big":1},
 "repos":[{"repo":"demo","merged":8,"mergedAlone":4,"cancelled":5,"failed":1,"successRate":0.57,"suggestion":"raise"},
          {"repo":"docs","merged":2,"mergedAlone":0,"cancelled":2,"failed":0,"successRate":null,"suggestion":null}]}}
"""#

@Suite("Espaces, brief, chiffres — client")
@MainActor
struct HarnessSpacesTests {
    @Test("les espaces se lisent avec leurs chiffres, par nom ; l'espace d'un dépôt est celui qui le compte parmi les siens")
    func list() async throws {
        let model = await osConnected(osTransport(routes: ["GET /v1/spaces": osJSON(spacesJSON)]))
        await model.spaces.refresh()
        #expect(model.spaces.availability == .available)
        #expect(model.spaces.spaces.map(\.name) == ["acme", "Zeta"])
        let acme = try #require(model.spaces.spaces.first)
        #expect(acme.repos == ["boutique", "api"] && acme.jiraProjects == ["ACME"] && acme.rev == 3)
        #expect(acme.dailyBudgetUsd == 20 && acme.autonomy == .deliver && !acme.poste)
        #expect(acme.memoryScopes == ["acme/boutique"])
        #expect(acme.stats == HarnessSpaceStats(
            working: 2, yours: 1, queued: 3, mergedWeek: 7, failedWeek: 1, cancelledWeek: 2, costToday: 4.2, costWeek: 31.5, budgetLeftToday: 15.8
        ))
        #expect(model.spaces.spaces[1].stats.budgetLeftToday == nil)
        #expect(model.spaces.space(ofRepo: "api")?.id == "s1")
        #expect(model.spaces.space(ofRepo: "docs")?.id == "s2")
        #expect(model.spaces.space(ofRepo: "ailleurs") == nil && model.spaces.space(ofRepo: nil) == nil)
    }

    @Test("un espace rendu par une écriture, sans portées ni chiffres, se lit quand même ; un niveau d'autonomie inconnu vaut « règles du dépôt »")
    func bareSpace() throws {
        let bare = try JSONDecoder().decode(
            HarnessSpace.self,
            from: Data(#"{"id":"s3","name":"Perso","repos":[],"poste":true,"jiraProjects":[],"dailyBudgetUsd":null,"autonomy":"futur","by":null,"createdAt":1,"updatedAt":1,"rev":1}"#.utf8)
        )
        #expect(bare.memoryScopes.isEmpty && bare.stats == HarnessSpaceStats())
        #expect(bare.poste && bare.dailyBudgetUsd == nil && bare.autonomy == nil && bare.by == nil)
    }

    @Test("un serveur sans /v1/spaces (404) : les espaces sont absents, sans échec")
    func olderServer() async {
        let model = await osConnected(osTransport(routes: [:]))
        await model.spaces.refresh()
        #expect(model.spaces.availability == .absent && !model.spaces.isServed)
        #expect(model.spaces.spaces.isEmpty && model.spaces.failure == nil)
    }

    @Test("créer un espace envoie nom, dépôts, poste, projets Jira, budget et autonomie — `null` quand ils sont vides ; une saisie invalide ne part pas")
    func create() async throws {
        let transport = osTransport(routes: [
            "GET /v1/spaces": osJSON(spacesJSON),
            "POST /v1/spaces": osJSON(#"{"space":"# + spaceJSON("s9", name: "Client B", repos: #"["site"]"#) + "}", status: 201),
        ])
        let model = await osConnected(transport)

        let draft = HarnessSpaceDraft(name: "  Client B ", repos: [" site ", "site", ""], poste: true, jiraProjects: ["CB"], dailyBudgetUsd: 12.5, autonomy: .ask)
        #expect(await model.spaces.create(draft)?.id == "s9")
        let body = try #require(transport.body("POST", "/v1/spaces"))
        #expect(body["name"] as? String == "Client B")
        #expect(body["repos"] as? [String] == ["site"])
        #expect(body["poste"] as? Bool == true)
        #expect(body["jiraProjects"] as? [String] == ["CB"])
        #expect(body["dailyBudgetUsd"] as? Double == 12.5)
        #expect(body["autonomy"] as? String == "ask")
        #expect(transport.count("GET", "/v1/spaces") == 1, "la liste est relue après la création")

        _ = await model.spaces.create(HarnessSpaceDraft(name: "Vide"))
        let empty = try #require(transport.body("POST", "/v1/spaces"))
        #expect(empty["dailyBudgetUsd"] is NSNull && empty["autonomy"] is NSNull, "vides : `null`, pas absents")

        let before = transport.count("POST", "/v1/spaces")
        #expect(HarnessSpaceDraft(name: " ").problem == .name)
        #expect(HarnessSpaceDraft(name: String(repeating: "n", count: 61)).problem == .name)
        #expect(HarnessSpaceDraft(name: "ok", dailyBudgetUsd: 0).problem == .budget)
        #expect(await model.spaces.create(HarnessSpaceDraft(name: " ")) == nil)
        #expect(transport.count("POST", "/v1/spaces") == before)
    }

    @Test("modifier un espace part avec sa révision (`If-Match`) ; périmé (412), la liste est relue et l'échec le dit ; supprimer appelle DELETE")
    func updateAndDelete() async throws {
        let transport = osTransport { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/spaces"): osJSON(spacesJSON)
            case ("PUT", "/v1/spaces/s1"): osJSON(#"{"space":"# + spaceJSON("s1", name: "acme", repos: #"["boutique"]"#, rev: 4) + "}")
            case ("PUT", "/v1/spaces/s2"): osJSON(#"{"error":"périmé"}"#, status: 412)
            case ("DELETE", "/v1/spaces/s1"): osJSON(#"{"removed":true}"#)
            default: nil
            }
        }
        let model = await osConnected(transport)
        await model.spaces.refresh()
        let acme = try #require(model.spaces.spaces.first { $0.id == "s1" })
        let zeta = try #require(model.spaces.spaces.first { $0.id == "s2" })

        var draft = HarnessSpaceDraft(acme)
        #expect(draft == HarnessSpaceDraft(name: "acme", repos: ["boutique", "api"], jiraProjects: ["ACME"], dailyBudgetUsd: 20, autonomy: .deliver))
        draft.repos = ["boutique"]
        draft.dailyBudgetUsd = nil
        #expect(await model.spaces.update(acme, draft))
        let put = try #require(transport.last("PUT", "/v1/spaces/s1"))
        #expect(put.headers["If-Match"] == "\"3\"")
        let body = try #require(transport.body("PUT", "/v1/spaces/s1"))
        #expect(body["repos"] as? [String] == ["boutique"])
        #expect(body["dailyBudgetUsd"] is NSNull, "un budget effacé part en `null`")

        let reads = transport.count("GET", "/v1/spaces")
        #expect(await model.spaces.update(zeta, HarnessSpaceDraft(zeta)) == false)
        #expect(model.spaces.failure == .stale)
        #expect(transport.count("GET", "/v1/spaces") == reads + 1)

        #expect(await model.spaces.delete(acme))
        #expect(transport.last("DELETE", "/v1/spaces/s1") != nil)
        #expect(model.spaces.busy.isEmpty)
    }

    @Test("le rapport d'un espace se lit sur la fenêtre demandée ; l'événement `space` fait relire les espaces")
    func reportAndLiveReload() async throws {
        let report = #"{"space":{"id":"s1","name":"acme"},"since":1000,"until":2000,"text":"**Livré**\n- Export CSV","counts":{"merged":1,"decisions":2,"waiting":0,"failed":0},"cost":3.4}"#
        let transport = osTransport(routes: [
            "GET /v1/spaces": osJSON(spacesJSON),
            "GET /v1/spaces/s1/report": osJSON(report),
            "GET /v1/spaces/s1/report?since=1000": osJSON(report),
        ])
        let model = await osConnected(transport)
        await model.spaces.refresh()
        let acme = try #require(model.spaces.spaces.first { $0.id == "s1" })
        let zeta = try #require(model.spaces.spaces.first { $0.id == "s2" })

        let read = try #require(await model.spaces.report(acme))
        #expect(read == HarnessSpaceReport(since: 1000, until: 2000, text: "**Livré**\n- Export CSV", counts: HarnessDigestCounts(merged: 1, decisions: 2), cost: 3.4))
        #expect(await model.spaces.report(acme, since: 1000) != nil)
        #expect(transport.last("GET", "/v1/spaces/s1/report?since=1000") != nil)
        #expect(await model.spaces.report(zeta) == nil, "un espace disparu n'a pas de rapport")
        #expect(model.spaces.failure == nil)

        let reads = transport.count("GET", "/v1/spaces")
        transport.push(events: ["space"])
        model.startLive()
        #expect(await eventually { transport.count("GET", "/v1/spaces") > reads })
        model.stopLive()
    }

    @Test("le brief se lit en entier : livré, en attente, en échec, arrêté, décidé seul, retenu, propositions, coût")
    func brief() async throws {
        let transport = osTransport(routes: ["GET /v1/brief": osJSON(briefJSON), "GET /v1/brief?since=500": osJSON(emptyBrief)])
        let model = await osConnected(transport)
        await model.brief.refresh()
        #expect(model.brief.availability == .available)
        let brief = try #require(model.brief.brief)
        #expect(brief.since == 1000 && brief.until == 2000 && brief.seenAt == 1000)
        #expect(brief.headline == "1 livrée, 1 vous attend, 2 propositions — 4,20 $")
        #expect(brief.delivered == [HarnessBriefDelivered(runId: "r1", repo: "demo", title: "Export CSV", prUrl: "https://forge/pr/1", at: 1500, cost: 1.2, alone: true)])
        #expect(brief.deliveredAlone == 1)
        #expect(brief.waiting == [HarnessBriefWaiting(runId: "r2", repo: "demo", title: "Panier", wait: "specs", since: 1600)])
        #expect(brief.failed == [HarnessBriefFailed(runId: "r3", repo: "demo", title: "Cache", reason: "tests rouges", at: 1700)])
        #expect(brief.stopped.map(\.reason) == [.tooBig, nil])
        #expect(brief.decided == [HarnessBriefDecided(runId: "r1", repo: "demo", title: "Export CSV", seq: 2, question: "Séparateur ?", chosen: ";")])
        #expect(brief.decided.first?.id == "r1/2")
        #expect(brief.blocked == [HarnessBriefBlocked(runId: "r6", repo: "demo", title: "Suite", cause: "parent", text: "attend la fusion de « Export CSV »")])
        #expect(brief.proposals == 2 && brief.cost == 4.2 && !brief.isEmpty)

        await model.brief.refresh(since: 500)
        #expect(transport.last("GET", "/v1/brief?since=500") != nil)
        #expect(model.brief.brief?.isEmpty == true && model.brief.brief?.seenAt == nil)
        #expect(model.brief.brief?.headline == "Rien de neuf.")
    }

    @Test("marquer le brief comme vu appelle POST /v1/brief/seen et garde l'instant rendu ; un événement de feature relit la même fenêtre")
    func briefSeenAndLiveReload() async throws {
        let transport = osTransport(routes: [
            "GET /v1/brief?since=500": osJSON(briefJSON),
            "POST /v1/brief/seen": osJSON(#"{"seenAt":2500}"#),
        ])
        let model = await osConnected(transport)
        await model.brief.refresh(since: 500)

        #expect(await model.brief.markSeen())
        #expect(transport.last("POST", "/v1/brief/seen") != nil)
        #expect(model.brief.brief?.seenAt == 2500)
        #expect(model.brief.brief?.delivered.count == 1, "le brief affiché reste")

        let reads = transport.count("GET", "/v1/brief?since=500")
        transport.push(events: ["merged"])
        model.startLive()
        #expect(await eventually { transport.count("GET", "/v1/brief?since=500") > reads })
        model.stopLive()
    }

    @Test("un serveur sans /v1/brief ni /v1/scoreboard (404) : absents, sans échec ni contenu")
    func olderServerBriefAndScoreboard() async {
        let model = await osConnected(osTransport(routes: [:]))
        await model.brief.refresh()
        #expect(model.brief.availability == .absent && model.brief.brief == nil && model.brief.failure == nil)
        await model.scoreboard.refresh()
        #expect(model.scoreboard.availability == .absent && model.scoreboard.scoreboard == nil && model.scoreboard.failure == nil)
        #expect(!model.brief.isServed && !model.scoreboard.isServed)
    }

    @Test("les chiffres se lisent sur la fenêtre demandée, bornée de 1 à 90 jours : les trois indicateurs, les motifs d'annulation classés, les dépôts")
    func scoreboard() async throws {
        let transport = osTransport { call in
            call.method == "GET" && call.path.hasPrefix("/v1/scoreboard?days=") ? osJSON(scoreboardJSON) : nil
        }
        let model = await osConnected(transport)
        await model.scoreboard.refresh()
        #expect(transport.last("GET", "/v1/scoreboard?days=7") != nil)
        let board = try #require(model.scoreboard.scoreboard)
        #expect(board.merged == 10 && board.mergedAlone == 4 && board.aloneRate == 0.4)
        #expect(board.decisions == 6 && board.medianDecisionMs == 540_000)
        #expect(board.started == 20 && board.startedAlone == 5 && board.startedAloneRate == 0.25)
        #expect(board.cancelled == 7 && board.cancelCauses[HarnessScoreboard.noCause] == 3)
        #expect(board.rankedCancelCauses.map(\.cause) == ["none", "off_target", "too_big"])
        #expect(board.repos.map(\.repo) == ["demo", "docs"])
        #expect(board.repos[0].successRate == 0.57 && board.repos[0].suggestion == "raise")
        #expect(board.repos[1].successRate == nil && board.repos[1].suggestion == nil)

        await model.scoreboard.refresh(days: 400)
        #expect(model.scoreboard.days == 90 && transport.last("GET", "/v1/scoreboard?days=90") != nil)
        await model.scoreboard.refresh(days: 0)
        #expect(model.scoreboard.days == 1 && transport.last("GET", "/v1/scoreboard?days=1") != nil)
        await model.scoreboard.refresh()
        #expect(transport.count("GET", "/v1/scoreboard?days=1") == 2, "sans fenêtre donnée, la dernière est relue")
    }
}
