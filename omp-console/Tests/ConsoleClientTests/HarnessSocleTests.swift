// Les tests hermétiques du socle partagé Mac/iOS côté client : la saisie des options de
// lancement, l'historique des features (`GET /v1/runs`, filtres, pages, kanban), la
// palette de commandes, la carte des services et la remontée bornée des erreurs.

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

    @Test("le kanban range par état et un dépôt place la feature devant sa cible, sauf colonne terminée")
    func kanban() {
        let a = run("a", priority: 5)
        let b = run("b", priority: 0)
        let done = run("d", state: "merged")
        let columns = HarnessKanban.columns([b, a, done, run("w", state: "awaiting_human")])
        #expect(columns.first(where: { $0.column == .queued })?.runs.map(\.id) == ["a", "b"])
        #expect(columns.first(where: { $0.column == .waiting })?.runs.map(\.id) == ["w"])
        #expect(HarnessKanban.priority(moving: b, before: a) == 6)
        #expect(HarnessKanban.priority(moving: a, before: b) == 1)
        #expect(HarnessKanban.priority(moving: a, before: a) == nil)
        #expect(HarnessKanban.priority(moving: done, before: a) == nil)
        #expect(HarnessKanban.priority(moving: run("x", priority: 1000), before: run("y", priority: 1000)) == nil, "bornée à 1000")
    }

    @Test("la palette retient les entrées qui contiennent chaque mot, la meilleure d'abord ; ⌘F ne garde que features et mémoire")
    func palette() {
        let history = [run("r1", state: "merged", title: "Export CSV des souvenirs"), run("r2", title: "Refonte du kanban")]
        let all = HarnessPalette.items(query: "", search: false, sections: [.home, .kanban, .memory], inbox: HarnessInbox(), history: history, canAct: true, memory: true)
        #expect(all.contains { $0.command == .newFeature })
        #expect(all.contains { $0.command == .section(.memory) })
        let found = HarnessPalette.items(query: "export csv", search: false, sections: [.home], inbox: nil, history: history, canAct: true, memory: true)
        #expect(found.first?.command == .run("r1"))
        #expect(found.last?.command == .searchMemory("export csv"))
        let search = HarnessPalette.items(query: "kanban", search: true, sections: ConsoleSection.allCases, inbox: nil, history: history, canAct: true, memory: true)
        #expect(search.first?.command == .searchMemory("kanban"))
        #expect(!search.contains { if case .section = $0.command { true } else { false } })
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
