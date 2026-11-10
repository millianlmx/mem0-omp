// L'ESPACE comme contexte de l'écran, côté pur (`OSSpaces`) : à quel espace appartient un
// fil, une décision, une session locale, une demande ou un envoi du poste ; le filtre d'un
// espace, le groupement par espace, les lots qui ne mêlent jamais deux espaces, la couleur
// stable d'un espace, et le bornage fait dans l'app pour un serveur qui ne le fait pas.

@testable import ConsoleClient
import Foundation
import Testing

private let acme = HarnessSpace(id: "e-acme", name: "Client Acme", repos: ["acme-web", "acme-api"], createdAt: 2)
private let perso = HarnessSpace(id: "e-perso", name: "Perso", repos: ["demo"], createdAt: 1)
private let spaces = [acme, perso]

private let browsers = [
    WorkstationBrowser(id: "b-perso", label: "Perso", isDefault: true, space: "e-perso"),
    WorkstationBrowser(id: "b-acme", label: "Acme", space: "e-acme"),
    WorkstationBrowser(id: "b-libre", label: "Libre"),
]

private func run(_ id: String, repo: String, state: String = "running", step: String = "impl") throws -> HarnessRun {
    try JSONDecoder().decode(HarnessRun.self, from: Data(osRunJSON(id, state: state, step: step, repo: repo).utf8))
}

private func request(_ id: String, browser: String? = nil, space: String? = nil, instruction: String = "Relancer") throws -> WorkstationRequest {
    var json = #"{"id":""# + id + #"","createdAt":1,"updatedAt":1,"by":"mac","instruction":""# + instruction + #"","automationId":null,"state":"queued","reason":null,"report":null,"startedAt":null,"endedAt":null"#
    json += #","browserId":"# + (browser.map { "\"\($0)\"" } ?? "null")
    if let space { json += #","space":""# + space + "\"" }
    return try JSONDecoder().decode(WorkstationRequest.self, from: Data((json + "}").utf8))
}

private func intake(_ id: String, repo: String? = nil, space: String? = nil, state: String = "planned") throws -> HarnessIntake {
    let owner = space.map { #"{"id":""# + $0 + #"","name":"x"}"# } ?? "null"
    let json = #"{"id":""# + id + #"","text":"t","source":"console","repo":"# + (repo.map { "\"\($0)\"" } ?? "null")
        + #","requestedRepo":null,"context":null,"space":"# + owner + #","state":""# + state
        + #"","kind":null,"plan":{"kind":"feature","repo":"# + (repo.map { "\"\($0)\"" } ?? "null")
        + #","title":"t","statement":"t"},"question":null,"answer":null,"exchanges":[],"statement":"t","created":null,"reason":null,"by":"mac","createdAt":1,"updatedAt":1}"#
    return try JSONDecoder().decode(HarnessIntake.self, from: Data(json.utf8))
}

private func write(_ id: String, space: String?) throws -> AtlassianWrite {
    let owner = space.map { "\"\($0)\"" } ?? "null"
    return try JSONDecoder().decode(AtlassianWrite.self, from: Data((#"{"id":""# + id + #"","space":"# + owner + #","kind":"comment","issueKey":"ACME-1","body":"b","why":"w","state":"proposed","by":"agent","createdAt":1,"updatedAt":1}"#).utf8))
}

private func approval(_ seq: Int, browser: String?) -> WorkstationAction {
    WorkstationAction(seq: seq, kind: "click", rationale: "Envoyer", state: "awaiting_approval", browserId: browser)
}

@Suite("Espaces — appartenance, filtre, groupement (pur)")
struct OSSpacesTests {
    @Test("la couleur d'un espace est un indice 0…5 tiré de son identifiant, le même à chaque lecture ; jusqu'à six espaces, aucune couleur n'est partagée")
    func colors() {
        #expect(OSSpaces.paletteSize == 6)
        // FNV-1a 32 bits sur les octets de l'identifiant, modulo 6 : des valeurs fixes, pas un `hashValue`.
        #expect(OSSpaces.colorIndex(of: "") == 2_166_136_261 % 6)
        #expect(OSSpaces.colorIndex(of: "a") == 0xE40C_292C % 6)
        for id in ["e-acme", "e-perso", "e1", "e_01JABCDEF", "é"] {
            #expect((0 ..< 6).contains(OSSpaces.colorIndex(of: id)))
            #expect(OSSpaces.colorIndex(of: id) == OSSpaces.colorIndex(of: id))
        }

        let six = (1 ... 6).map { HarnessSpace(id: "e\($0)", name: "E\($0)", createdAt: Double($0)) }
        let indexes = OSSpaces.colorIndexes(six)
        #expect(Set(indexes.values).count == 6 && indexes.values.allSatisfy((0 ..< 6).contains))
        #expect(OSSpaces.colorIndexes(six.reversed()) == indexes, "l'ordre de lecture ne change rien")
        #expect(indexes["e1"] == OSSpaces.colorIndex(of: "e1"), "le plus ancien garde la couleur de son identifiant")
        let five = OSSpaces.colorIndexes(Array(six.prefix(5)))
        #expect(five.allSatisfy { indexes[$0.key] == $0.value }, "un espace ajouté ne déplace pas la couleur d'un ancien")
        let seven = OSSpaces.colorIndexes(six + [HarnessSpace(id: "e7", name: "E7", createdAt: 7)])
        #expect(seven["e7"] == OSSpaces.colorIndex(of: "e7"), "au-delà de six, la couleur tirée de l'identifiant")
    }

    @Test("les dépôts et les features d'un espace ; sans espace choisi, tout")
    func reposAndRuns() throws {
        #expect(OSSpaces.repos(of: acme) == ["acme-web", "acme-api"] && OSSpaces.repos(of: nil) == nil)
        #expect(OSSpaces.repos(["demo", "acme-api", "autre", "acme-web"], in: acme) == ["acme-api", "acme-web"])
        #expect(OSSpaces.repos(["demo", "autre"], in: nil) == ["demo", "autre"])
        #expect(OSSpaces.holds("acme-web", in: acme) && !OSSpaces.holds("demo", in: acme) && !OSSpaces.holds(nil, in: acme))
        #expect(OSSpaces.holds("demo", in: nil) && OSSpaces.holds(nil, in: nil))

        let runs = [try run("r1", repo: "acme-web"), try run("r2", repo: "demo"), try run("r3", repo: "autre")]
        #expect(OSSpaces.runs(runs, in: acme).map(\.id) == ["r1"])
        #expect(OSSpaces.runs(runs, in: nil).map(\.id) == ["r1", "r2", "r3"])
        #expect(OSSpaces.space(of: runs[1], spaces: spaces)?.id == "e-perso" && OSSpaces.space(of: runs[2], spaces: spaces) == nil)
        #expect(OSSpaces.space(ofRepo: nil, spaces: spaces) == nil)
    }

    @Test("une demande au poste est de l'espace qu'elle porte, sinon de celui de son navigateur — le navigateur par défaut quand elle n'en désigne aucun")
    func requestsAndBrowsers() throws {
        let given = try request("q1", browser: "b-perso", space: "e-acme")
        let byBrowser = try request("q2", browser: "b-acme")
        let byDefault = try request("q3")
        let free = try request("q4", browser: "b-libre")
        let unknown = try request("q5", browser: "b-oublié")
        #expect(OSSpaces.space(of: given, spaces: spaces, browsers: browsers)?.id == "e-acme")
        #expect(OSSpaces.space(of: byBrowser, spaces: spaces, browsers: browsers)?.id == "e-acme")
        #expect(OSSpaces.space(of: byDefault, spaces: spaces, browsers: browsers)?.id == "e-perso")
        #expect(OSSpaces.space(of: free, spaces: spaces, browsers: browsers) == nil)
        #expect(OSSpaces.space(of: unknown, spaces: spaces, browsers: browsers) == nil)

        let all = [given, byBrowser, byDefault, free, unknown]
        #expect(OSSpaces.requests(all, in: acme, spaces: spaces, browsers: browsers).map(\.id) == ["q1", "q2"])
        #expect(OSSpaces.requests(all, in: nil, spaces: spaces, browsers: browsers).count == 5)
        #expect(OSSpaces.browsers(browsers, in: acme).map(\.id) == ["b-acme"] && OSSpaces.browsers(browsers, in: nil).count == 3)

        // Un envoi à approuver : par le navigateur qui l'exécute ; sans navigateur, hors espace.
        let sends = [approval(1, browser: "b-acme"), approval(2, browser: "b-perso"), approval(3, browser: nil), approval(4, browser: "b-libre")]
        #expect(sends.map { OSSpaces.space(of: $0, spaces: spaces, browsers: browsers)?.id } == ["e-acme", "e-perso", nil, nil])
        #expect(OSSpaces.actions(sends, in: acme, spaces: spaces, browsers: browsers).map(\.seq) == [1])
        #expect(OSSpaces.actions(sends, in: nil, spaces: spaces, browsers: browsers).count == 4)

        // Une réunion : par le navigateur d'où elle vient ; une automatisation : par celui de ses demandes (par défaut sinon).
        let meetings = [
            WorkstationMeeting(id: "m1", title: "Point Acme", startedAt: 1, state: "digested", browserId: "b-acme"),
            WorkstationMeeting(id: "m2", title: "Ancienne", startedAt: 0, state: "digested"),
        ]
        #expect(meetings.map { OSSpaces.space(of: $0, spaces: spaces, browsers: browsers)?.id } == ["e-acme", nil])
        #expect(OSSpaces.meetings(meetings, in: acme, spaces: spaces, browsers: browsers).map(\.id) == ["m1"])
        let automations = try ["b-acme", nil].enumerated().map { index, browser in
            try JSONDecoder().decode(WorkstationAutomation.self, from: Data((#"{"id":"a\#(index)","createdAt":1,"by":"mac","title":"Relance","frequency":"lundi","steps":[],"profileVersion":1,"browserId":"# + (browser.map { "\"\($0)\"" } ?? "null") + #","schedule":null}"#).utf8))
        }
        #expect(automations.map { OSSpaces.space(of: $0, spaces: spaces, browsers: browsers)?.id } == ["e-acme", "e-perso"])
        #expect(OSSpaces.automations(automations, in: perso, spaces: spaces, browsers: browsers).map(\.id) == ["a1"])
    }

    @Test("tant qu'aucun navigateur n'est rattaché à un espace, ce qui vient du poste revient à l'espace qui porte le poste — comme avant le poste par espace")
    func legacyPoste() throws {
        let withPoste = [acme, HarnessSpace(id: "e-moi", name: "Moi", poste: true)]
        let plain = [WorkstationBrowser(id: "b1", isDefault: true), WorkstationBrowser(id: "b2")]
        #expect(OSSpaces.space(of: try request("q1"), spaces: withPoste, browsers: plain)?.id == "e-moi")
        #expect(OSSpaces.space(of: try request("q2", browser: "b2"), spaces: withPoste, browsers: [])?.id == "e-moi")
        #expect(OSSpaces.space(of: approval(1, browser: nil), spaces: withPoste, browsers: plain)?.id == "e-moi")
        #expect(OSSpaces.space(of: try request("q3"), spaces: spaces, browsers: plain) == nil, "aucun espace ne porte le poste")
        // Dès qu'un navigateur est rattaché, seul le rattachement compte.
        let attached = plain + [WorkstationBrowser(id: "b3", space: "e-acme")]
        #expect(OSSpaces.space(of: try request("q4"), spaces: withPoste, browsers: attached) == nil)
    }

    @Test("une session locale, une Demande, une proposition et une consigne se rangent par leur dépôt — la Demande et la consigne d'abord par l'espace qu'elles portent")
    func otherOwners() throws {
        let sessions = [
            HarnessLocalSession(id: "l1", host: "mac", repo: "acme-api", title: "Refonte"),
            HarnessLocalSession(id: "l2", host: "mac", repo: nil, title: "Ailleurs"),
        ]
        #expect(OSSpaces.space(of: sessions[0], spaces: spaces)?.id == "e-acme" && OSSpaces.space(of: sessions[1], spaces: spaces) == nil)
        #expect(OSSpaces.localSessions(sessions, in: acme).map(\.id) == ["l1"] && OSSpaces.localSessions(sessions, in: nil).count == 2)

        let posed = try intake("i1", space: "e-acme")
        let planned = try intake("i2", repo: "demo")
        let elsewhere = try intake("i3", repo: "autre")
        let gone = try intake("i4", repo: "demo", space: "e-disparu")
        #expect(OSSpaces.space(of: posed, spaces: spaces)?.id == "e-acme" && OSSpaces.space(of: planned, spaces: spaces)?.id == "e-perso")
        #expect(OSSpaces.space(of: elsewhere, spaces: spaces) == nil)
        #expect(OSSpaces.space(of: gone, spaces: spaces) == nil, "l'espace qu'elle porte prime sur son dépôt, même disparu")
        #expect(OSSpaces.intakes([posed, planned, elsewhere], in: acme).map(\.id) == ["i1"])
        #expect(OSSpaces.intakes([posed, planned, elsewhere], in: perso).map(\.id) == ["i2"])
        #expect(OSSpaces.intakes([posed, planned, elsewhere], in: nil).count == 3)

        let proposals = [
            HarnessProposal(id: "p1", source: "retry", repo: "acme-web", title: "Relancer"),
            HarnessProposal(id: "p2", source: "signal", repo: nil, title: "Signalement"),
        ]
        #expect(OSSpaces.proposals(proposals, in: acme).map(\.id) == ["p1"] && OSSpaces.proposals(proposals, in: nil).count == 2)
        #expect(OSSpaces.space(of: proposals[0], spaces: spaces)?.id == "e-acme" && OSSpaces.space(of: proposals[1], spaces: spaces) == nil)

        let rules = [
            HarnessStandingRule(id: "c1", space: "e-acme", text: "a"),
            HarnessStandingRule(id: "c2", repo: "demo", text: "b"),
            HarnessStandingRule(id: "c3", text: "c"),
            HarnessStandingRule(id: "c4", repo: "acme-api", text: "d"),
        ]
        #expect(rules.map { OSSpaces.space(of: $0, spaces: spaces)?.id } == ["e-acme", "e-perso", nil, "e-acme"])
        #expect(OSSpaces.rules(rules, in: acme).map(\.id) == ["c1", "c3", "c4"], "les siennes, celles de ses dépôts et celles de partout")
        #expect(OSSpaces.rules(rules, in: nil).count == 4)
        let levels = OSSpaces.ruleLevels(rules, in: acme)
        #expect(levels.space.map(\.id) == ["c1"] && levels.repos.map(\.id) == ["c4"] && levels.everywhere.map(\.id) == ["c3"] && !levels.isEmpty)
        #expect(OSSpaces.ruleLevels([], in: acme).isEmpty)
    }

    @Test("un fil est de l'espace de son dépôt ; une demande au poste, de celui de son navigateur ; le filtre d'un espace ne garde que les siens")
    func threads() throws {
        let threads = OSThreads.build(
            runs: [try run("r1", repo: "acme-web"), try run("r2", repo: "demo"), try run("r3", repo: "autre")],
            inbox: nil,
            requests: [try request("q1", browser: "b-acme", instruction: "Relancer Acme"), try request("q2", browser: "b-libre", instruction: "Trier le courrier")]
        )
        #expect(threads.count == 5)
        let owners = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, OSSpaces.space(of: $0, spaces: spaces, browsers: browsers)?.id) })
        #expect(owners["r:r1"] == "e-acme" && owners["r:r2"] == "e-perso" && owners["r:r3"] == .some(nil))
        #expect(owners["w:q1"] == "e-acme" && owners["w:q2"] == .some(nil))
        #expect(Set(OSSpaces.threads(threads, in: acme, spaces: spaces, browsers: browsers).map(\.id)) == ["r:r1", "w:q1"])
        #expect(OSSpaces.threads(threads, in: perso, spaces: spaces, browsers: browsers).map(\.id) == ["r:r2"])
        #expect(OSSpaces.threads(threads, in: nil, spaces: spaces, browsers: browsers).count == 5)

        let groups = OSSpaces.threadGroups(threads, spaces: spaces, browsers: browsers)
        #expect(groups.map(\.space?.id) == ["e-acme", "e-perso", nil], "dans l'ordre des espaces, puis ce qui n'est dans aucun")
        #expect(groups.map(\.items.count) == [2, 1, 2] && groups.map(\.id) == ["e-acme", "e-perso", ""])
    }

    @Test("une décision est de l'espace de son dépôt, de son navigateur, de sa Demande ou de sa connexion Jira ; les lots ne mêlent jamais deux espaces")
    func decisions() throws {
        let decisions: [OSDecision] = [
            .specs(try run("r1", repo: "acme-web", state: "awaiting_human", step: "specs")),
            .specs(try run("r2", repo: "demo", state: "awaiting_human", step: "specs")),
            .specs(try run("r3", repo: "acme-api", state: "awaiting_human", step: "specs")),
            .verdict(try run("r4", repo: "autre", state: "awaiting_human", step: "review")),
            .approval(approval(7, browser: "b-acme")),
            .approval(approval(8, browser: "b-perso")),
            .intake(try intake("i1", space: "e-acme")),
            .jira(try write("w1", space: "e-acme")),
            .jira(try write("w2", space: nil)),
        ]
        let owners = decisions.map { OSSpaces.space(of: $0, spaces: spaces, browsers: browsers)?.id }
        #expect(owners == ["e-acme", "e-perso", "e-acme", nil, "e-acme", "e-perso", "e-acme", "e-acme", nil])
        #expect(OSSpaces.decisions(decisions, in: acme, spaces: spaces, browsers: browsers).map(\.id) == ["s:r1", "s:r3", "w:7", "i:i1", "j:w1"])
        #expect(OSSpaces.decisions(decisions, in: nil, spaces: spaces, browsers: browsers).count == 9)

        let groups = OSSpaces.decisionGroups(decisions, spaces: spaces, browsers: browsers)
        #expect(groups.map(\.space?.name) == ["Client Acme", "Perso", nil] && groups.map(\.items.count) == [5, 2, 2])

        let lots = OSSpaces.lots(decisions, spaces: spaces, browsers: browsers)
        #expect(lots.map(\.space?.id) == ["e-acme", "e-perso", nil])
        let acmeSpecs = try #require(lots[0].items.first { $0.kind == .specs })
        #expect(acmeSpecs.isBatch && acmeSpecs.runIds == ["r1", "r3"], "les deux specs d'Acme, sans celle de Perso")
        #expect(lots[1].items.first { $0.kind == .specs }?.runIds == ["r2"])
        for group in lots {
            for lot in group.items {
                #expect(lot.items.allSatisfy { OSSpaces.space(of: $0, spaces: spaces, browsers: browsers)?.id == group.space?.id })
            }
        }
        #expect(OSSpaces.lots([], spaces: spaces).isEmpty && OSSpaces.grouped([Int](), spaces: spaces) { _ in acme }.isEmpty)
    }

    @Test("pour un serveur qui ne borne pas à un espace : le brief, les chiffres et les propositions le sont par dépôt, sans rien qui parle des autres espaces")
    func inAppBounds() {
        let brief = HarnessBrief(
            since: 1, until: 2, seenAt: 1, headline: "3 livrées — 9,00 $",
            delivered: [HarnessBriefDelivered(runId: "r1", repo: "acme-web", title: "A", cost: 2), HarnessBriefDelivered(runId: "r2", repo: "demo", title: "B", cost: 7)],
            waiting: [HarnessBriefWaiting(runId: "r3", repo: "acme-api", title: "C", wait: "specs")],
            failed: [HarnessBriefFailed(runId: "r4", repo: "demo", title: "D")],
            stopped: [HarnessBriefStopped(runId: "r5", repo: "acme-web", title: "E")],
            decided: [HarnessBriefDecided(runId: "r6", repo: "demo", title: "F", seq: 1, question: "?", chosen: "x")],
            blocked: [HarnessBriefBlocked(runId: "r7", repo: "acme-api", title: "G", cause: "modules")],
            proposals: 4, cost: 9
        )
        let scoped = OSSpaces.brief(brief, in: acme)
        #expect(scoped.delivered.map(\.runId) == ["r1"] && scoped.waiting.map(\.runId) == ["r3"] && scoped.failed.isEmpty)
        #expect(scoped.stopped.map(\.runId) == ["r5"] && scoped.decided.isEmpty && scoped.blocked.map(\.runId) == ["r7"])
        #expect(scoped.headline.isEmpty && scoped.proposals == 0 && scoped.cost == 2)
        #expect(scoped.since == 1 && scoped.until == 2 && scoped.seenAt == 1)
        #expect(OSSpaces.brief(brief, in: nil) == brief)

        let board = HarnessScoreboard(
            since: 1, until: 2, merged: 9, mergedAlone: 3, aloneRate: 0.33, decisions: 5, medianDecisionMs: 1000, started: 12, startedAlone: 4,
            startedAloneRate: 0.33, cancelled: 6, cancelCauses: ["none": 6],
            repos: [
                HarnessScoreboardRepo(repo: "acme-web", merged: 3, mergedAlone: 1, cancelled: 2, failed: 1, successRate: 0.5),
                HarnessScoreboardRepo(repo: "acme-api", merged: 1, mergedAlone: 1, cancelled: 0, failed: 0, successRate: 1),
                HarnessScoreboardRepo(repo: "demo", merged: 5, mergedAlone: 1, cancelled: 4, failed: 0, successRate: 0.55),
            ]
        )
        let bounded = OSSpaces.scoreboard(board, in: acme)
        #expect(bounded.repos.map(\.repo) == ["acme-web", "acme-api"] && bounded.merged == 4 && bounded.mergedAlone == 2 && bounded.aloneRate == 0.5)
        #expect(bounded.cancelled == 2 && bounded.decisions == 0 && bounded.medianDecisionMs == nil && bounded.started == 0 && bounded.cancelCauses.isEmpty)
        #expect(OSSpaces.scoreboard(board, in: HarnessSpace(id: "vide", name: "Vide")).aloneRate == nil)
        #expect(OSSpaces.scoreboard(board, in: nil) == board)
    }
}
