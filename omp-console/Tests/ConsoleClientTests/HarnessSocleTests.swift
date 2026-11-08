// Les tests hermétiques du socle partagé Mac/iOS côté client : la saisie des options de
// lancement, l'historique des features (`GET /v1/runs`, filtres, pages, groupes), la file
// « À traiter », la palette de commandes, la carte des services et la remontée bornée
// des erreurs.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func run(_ id: String, state: String = "queued", priority: Int? = nil, title: String = "T", project: String? = nil, updated: Double = 0) -> HarnessRun {
    HarnessRun(id: id, repo: "demo", slug: id, title: title, request: "r", state: state, priority: priority, projectId: project, createdAt: updated, updatedAt: updated)
}

private final class RecordingTransport: HarnessTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [HarnessCall] = []
    let reply: @Sendable (HarnessCall) -> HarnessReply

    init(_ reply: @escaping @Sendable (HarnessCall) -> HarnessReply) { self.reply = reply }

    var calls: [HarnessCall] { lock.withLock { recorded } }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        lock.withLock { recorded.append(call) }
        return reply(call)
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

/// Un transport dont chaque échange échoue sur `error` : une annulation d'abord.
private final class CancellingTransport: HarnessTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Error = CancellationError()
    var error: Error {
        get { lock.withLock { current } }
        set { lock.withLock { current = newValue } }
    }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        throw error
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

@MainActor private func model(_ transport: RecordingTransport) -> HarnessModel {
    HarnessModel(transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(), retryDelay: .seconds(3600), refreshDelay: .milliseconds(1))
}

private let inbox = #"{"cursor":0,"batches":[],"awaiting":[],"decisions":[],"runs":[]}"#

@Suite("Socle partagé — client")
@MainActor
struct HarnessSocleTests {
    @Test("les options de lancement : vides elles ne disent rien, illisibles elles bloquent")
    func launchDraft() {
        #expect(HarnessLaunchDraft().options == HarnessLaunchOptions())
        let draft = HarnessLaunchDraft(priority: " 40 ", lane: .full, modules: "src/api, docs", req: "  ", budget: "2,5")
        #expect(draft.options == HarnessLaunchOptions(priority: 40, lane: .full, modules: ["src/api", "docs"], req: nil, budgetUsd: 2.5))
        #expect(HarnessLaunchDraft(priority: "1001").problem == .priority)
        #expect(HarnessLaunchDraft(priority: "haut").problem == .priority)
        #expect(HarnessLaunchDraft(budget: "0").problem == .budget)
        #expect(HarnessLaunchDraft(budget: "-3").problem == .budget)
    }

    @Test("l'historique lit GET /v1/runs avec l'état et le dépôt, puis filtre projet et texte et pagine")
    func history() async throws {
        let many = (0 ..< 120).map { #"{"id":"r\#($0)","repo":"demo","slug":"s","title":"Feature \#($0)","request":"r","state":"merged","fixes":0,"modules":[],"projectId":\#($0 % 2 == 0 ? "\"p1\"" : "null"),"createdAt":\#($0),"updatedAt":\#($0)}"# }
        let transport = RecordingTransport { call in
            switch call.path {
            case "/v1/inbox": HarnessReply(status: 200, body: Data(inbox.utf8))
            default: HarnessReply(status: call.path.hasPrefix("/v1/runs") ? 200 : 404, body: Data(#"{"runs":[\#(many.joined(separator: ","))]}"#.utf8))
            }
        }
        let server = model(transport)
        #expect(await server.configure(address: "vps.example", token: "t"))
        let history = server.history
        await history.refresh()
        #expect(history.page.count == HarnessRunsHistory.pageSize)
        #expect(history.hasMore)
        #expect(history.page.first?.id == "r119", "les plus récemment changées d'abord")
        history.showMore()
        history.showMore()
        #expect(history.page.count == 120 && !history.hasMore)
        history.projectId = "p1"
        #expect(history.filtered.count == 60)
        history.query = "feature 11"
        #expect(Set(history.filtered.map(\.id)) == ["r110", "r112", "r114", "r116", "r118"])
        #expect(HarnessRunsHistory.path(states: [.merged, .failed], repo: "mon dépôt") == "/v1/runs?state=failed,merged&repo=mon%20d%C3%A9p%C3%B4t")
        #expect(HarnessRunsHistory.path(states: [], repo: nil) == "/v1/runs")
    }

    @Test("les groupes : ce qui vous attend, puis ce qui tourne, la file par priorité, le fini du plus récent ; la boîte prime et complète l'historique")
    func groups() {
        let old = run("w1", state: "awaiting_human", updated: 10)
        let recent = run("w2", state: "escalated", updated: 20)
        let high = run("q1", priority: 5)
        let low = run("q2", priority: 0)
        let merged = run("m1", state: "merged", updated: 30)
        let failed = run("f1", state: "failed", updated: 40)
        // L'historique croit q2 en file ; la boîte la sait déjà en cours, et connaît une
        // feature lancée depuis la lecture de l'historique.
        let fresh = run("q2", state: "running", updated: 50)
        let launched = run("n1", state: "queued", priority: 1)
        let groups = HarnessRunGroups.groups([recent, merged, low, old, failed, high], live: [fresh, launched])
        #expect(groups.map(\.group) == [.needsYou, .running, .queued, .done])
        #expect(groups[0].runs.map(\.id) == ["w1", "w2"], "la plus vieille attente d'abord")
        #expect(groups[1].runs.map(\.id) == ["q2"])
        #expect(groups[2].runs.map(\.id) == ["q1", "n1"], "l'ordre d'admission")
        #expect(groups[3].runs.map(\.id) == ["f1", "m1"])
        #expect(HarnessRunGroups.groups([merged]).map(\.group) == [.done], "aucun groupe vide")
        #expect(!merged.acceptsPriority && high.acceptsPriority)
    }

    @Test("la file « À traiter » : les portes de la plus vieille à la plus récente, puis alertes, audits et décisions par feature ; une question d'une feature terminée n'y est plus")
    func inboxFeed() {
        let specs = run("s", state: "awaiting_human", updated: 30)
        var verdict = run("v", state: "awaiting_human", updated: 10)
        verdict.step = "review"
        var waitingSpecs = specs
        waitingSpecs.step = "specs"
        let asked = run("q", state: "escalated", updated: 20)
        let batch = HarnessEscalationBatch(run: asked, items: [HarnessEscalation(id: 1, runId: "q", category: "reversible", question: "?", options: ["a", "b"])])
        let empty = HarnessEscalationBatch(run: run("e", state: "escalated"), items: [])
        // Un serveur plus ancien sert encore la question d'une feature annulée : plus rien ne l'attend.
        let stale = HarnessEscalationBatch(run: run("c", state: "cancelled"), items: [HarnessEscalation(id: 9, runId: "c", category: "reversible", question: "?", options: ["a"])])
        let decisions = [
            HarnessDecision(id: 1, runId: "d", seq: 1, question: "?", options: ["a"], chosen: "a", rationale: "r", createdAt: 5),
            HarnessDecision(id: 2, runId: "d", seq: 2, question: "?", options: ["a"], chosen: "a", rationale: "r", createdAt: 6),
        ]
        let inbox = HarnessInbox(
            batches: [batch, empty, stale], awaiting: [waitingSpecs, verdict], decisions: decisions,
            audits: [HarnessAudit(id: "a1", repo: "demo", state: "proposed"), HarnessAudit(id: "a2", repo: "demo", state: "analysing")],
            alerts: [HarnessAlert(runId: "x", kind: "stalled", since: 1)]
        )
        let items = HarnessInboxFeed.items(inbox)
        #expect(items.map(\.id) == ["verdict/v", "questions/q", "specs/s", "alert/x/stalled", "audit/a1", "decisions/d"])
        let gates = items.prefix(3).filter(\.isGate).count
        #expect(gates == 3)
        #expect(HarnessInboxFeed.first(.specs, in: items)?.runId == "s")
        #expect(inbox.pendingCount == 3, "une question et deux validations ; la question orpheline ne compte pas")
        #expect(HarnessInboxFeed.items(HarnessInbox()).isEmpty, "une boîte vide ne montre rien")
    }

    @Test("une annulation n'est pas une panne : changer d'écran n'allume pas le bandeau « injoignable »")
    func cancellationIsNotAFailure() async {
        let transport = RecordingTransport { _ in HarnessReply(status: 200, body: Data(inbox.utf8)) }
        let server = model(transport)
        let cancelled = CancellingTransport()
        let other = HarnessModel(transport: cancelled, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(), retryDelay: .seconds(3600), refreshDelay: .milliseconds(1))
        #expect(await server.configure(address: "vps.example", token: "t"))
        #expect(await other.configure(address: "vps.example", token: "t") == false)
        #expect(other.failure == nil, "un échange annulé ne se dit pas injoignable")
        cancelled.error = URLError(.notConnectedToInternet)
        #expect(await other.configure(address: "vps.example", token: "t") == false)
        #expect(other.failure == .unreachable)
    }

    @Test("la palette retient les entrées qui contiennent chaque mot, la meilleure d'abord ; ⌘F ne garde que features et mémoire")
    func palette() {
        let history = [run("r1", state: "merged", title: "Export CSV des souvenirs"), run("r2", title: "Refonte de la liste")]
        let all = HarnessPalette.items(query: "", search: false, sections: [.inbox, .runs, .memory], systemPages: [.vigie], inbox: HarnessInbox(), history: history, canAct: true, memory: true)
        #expect(all.contains { $0.command == .newFeature })
        #expect(all.contains { $0.command == .section(.memory) })
        #expect(all.contains { $0.command == .system(.vigie) })
        let found = HarnessPalette.items(query: "export csv", search: false, sections: [.inbox], inbox: nil, history: history, canAct: true, memory: true)
        #expect(found.first?.command == .run("r1"))
        #expect(found.last?.command == .searchMemory("export csv"))
        let search = HarnessPalette.items(query: "liste", search: true, sections: ConsoleSection.allCases, systemPages: SystemPage.allCases, inbox: nil, history: history, canAct: true, memory: true)
        #expect(search.first?.command == .searchMemory("liste"))
        #expect(!search.contains { if case .section = $0.command { true } else { false } })
        #expect(!search.contains { if case .system = $0.command { true } else { false } })
        #expect(search.contains { $0.command == .run("r2") })
        let reader = HarnessPalette.items(query: "", search: false, sections: [], inbox: nil, history: [], canAct: false, memory: false)
        #expect(!reader.contains { $0.command == .newFeature }, "un lecteur ne lance rien")
    }

    @Test("la carte des services : chaque sonde a sa ligne, un service absent du serveur n'en a pas")
    func services() {
        let health = HarnessHealth(ok: false, version: "1.16.0", checks: HarnessHealthChecks(
            db: HarnessHealthCheck(ok: true),
            scheduler: HarnessSchedulerCheck(ok: false, ageSec: 900),
            disk: HarnessDiskCheck(ok: true, freeMiB: 2048)
        ))
        let status = HarnessStatus(oracle: HarnessOracleStatus(configured: true, ok: true, lostWrites: HarnessLostWrites(count: 2, lastError: "timeout")))
        let lines = HarnessServices.lines(health: health, status: status, workstation: nil, reachable: true)
        #expect(lines.map(\.kind) == [.server, .database, .scheduler, .disk, .oracle])
        #expect(lines.first(where: { $0.kind == .scheduler })?.level == .warning)
        #expect(lines.first(where: { $0.kind == .oracle })?.level == .warning)
        #expect(HarnessServices.worst(lines) == .warning)
        let down = HarnessServices.lines(health: nil, status: nil, workstation: nil, reachable: false)
        #expect(down.map(\.level) == [.down])
        let memory = HarnessStatus(memory: HarnessMemoryStatus(configured: true, ok: false), backups: HarnessBackupsStatus(lastAt: 10, lastError: "disque plein", lastErrorAt: 20))
        let more = HarnessServices.lines(health: nil, status: memory, workstation: nil, reachable: true)
        #expect(more.first(where: { $0.kind == .memory })?.level == .down)
        #expect(more.first(where: { $0.kind == .backups })?.error == "disque plein")
    }

    @Test("la remontée d'erreurs : seuls les imprévus partent, chemin sans requête, débit et répétition bornés")
    func reporter() async throws {
        #expect(HarnessErrorReporter.kind(ofStatus: 500) == "http")
        #expect(HarnessErrorReporter.kind(ofStatus: 302) == "http")
        for expected in [200, 400, 401, 403, 404, 409, 412, 428] { #expect(HarnessErrorReporter.kind(ofStatus: expected) == nil) }
        let error = try #require(HarnessErrorReporter.error(httpStatus: 503, call: HarnessCall(method: "GET", path: "/v1/runs/r1/diff?path=secret.txt"), serverMessage: "occupé"))
        #expect(error.context["path"] == "/v1/runs/r1/diff")
        #expect(!error.message.contains("secret"))

        var reporter = HarnessErrorReporter(source: "mac", version: "1")
        let first = reporter.admit(kind: "http", context: ["path": "/a"], now: 0)
        let repeated = reporter.admit(kind: "http", context: ["path": "/a"], now: 10)
        let later = reporter.admit(kind: "http", context: ["path": "/a"], now: 700)
        #expect(first && later)
        #expect(!repeated, "la même erreur ne repart pas avant dix minutes")
        for index in 0 ..< 20 { _ = reporter.admit(kind: "http", context: ["path": "/b\(index)"], now: 1000) }
        let flooded = reporter.admit(kind: "http", context: ["path": "/z"], now: 1001)
        #expect(!flooded, "dix par minute au plus")
        reporter.received(status: 404)
        #expect(reporter.muted)

        // Bout en bout : un 500 sur la boîte part en POST /v1/client-errors, une seule fois.
        let transport = RecordingTransport { call in
            switch call.path {
            case "/v1/client-errors": HarnessReply(status: 202, body: Data("{}".utf8))
            case "/v1/inbox" where call.method == "GET": HarnessReply(status: 200, body: Data(inbox.utf8))
            default: HarnessReply(status: 500, body: Data(#"{"error":"boum"}"#.utf8))
            }
        }
        let server = model(transport)
        #expect(await server.configure(address: "vps.example", token: "t"))
        await server.refreshCatalog()
        await server.refreshCatalog()
        try await Task.sleep(for: .milliseconds(100))
        let reports = transport.calls.filter { call in
            guard call.path == HarnessErrorReporter.route, let body = call.body,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
            else { return false }
            return (json["context"] as? [String: String])?["path"] == "/v1/status"
        }
        #expect(reports.count == 1, "deux échecs identiques : une seule remontée")
        let body = try JSONSerialization.jsonObject(with: try #require(reports.first?.body)) as? [String: Any]
        #expect(body?["source"] as? String == "mac")
        #expect(body?["kind"] as? String == "http")
        #expect((body?["context"] as? [String: String])?["status"] == "500")
    }
}
