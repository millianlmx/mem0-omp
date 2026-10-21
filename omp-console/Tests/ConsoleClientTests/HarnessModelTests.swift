// Le client du serveur de pipelines (omp-harness) : contrat JSON, adresse, jeton,
// boîte de l'humain, gestes et flux — sur une doublure de transport, sans réseau ni
// trousseau réel.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

/// La doublure du serveur : une réponse par appel, et un flux scripté.
final class ScriptedHarnessTransport: HarnessTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var handler: @Sendable (HarnessCall) -> HarnessReply = { _ in HarnessReply(status: 404, body: Data()) }
    private var recorded: [HarnessCall] = []
    private var chunks: [Data] = []

    func respond(_ handler: @escaping @Sendable (HarnessCall) -> HarnessReply) {
        lock.withLock { self.handler = handler }
    }

    /// Les octets que le prochain flux livrera avant de se fermer.
    func stream(_ chunks: [Data]) {
        lock.withLock { self.chunks = chunks }
    }

    var calls: [HarnessCall] { lock.withLock { recorded } }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        let handler: @Sendable (HarnessCall) -> HarnessReply = lock.withLock {
            recorded.append(call)
            return self.handler
        }
        return handler(call)
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        let pending = lock.withLock { () -> [Data] in
            recorded.append(call)
            defer { chunks = [] }
            return chunks
        }
        return AsyncThrowingStream { continuation in
            for chunk in pending { continuation.yield(chunk) }
            continuation.finish()
        }
    }
}

/// Une boîte telle que le serveur l'écrit : clés en plus, valeurs `null`.
private let inboxJSON = #"""
{
  "batches": [{
    "run": {"id": "r1", "repo": "demo", "slug": "export", "title": "Export CSV", "request": "Exporter", "state": "escalated",
            "step": "impl", "fixes": 0, "attempts": 0, "branch": "harness/export", "worktree": "/w", "baseSha": "abc",
            "projectId": null, "projectOrder": 0, "modules": ["src/api"], "verdict": null, "mergeSha": null, "prUrl": null,
            "reason": "2 décision(s)", "model": null, "createdAt": 1, "updatedAt": 2},
    "items": [{"id": 7, "runId": "r1", "stepId": 3, "category": "schema", "question": "Où stocker la date ?",
               "options": ["colonne", "table"], "context": "Proposé", "status": "open", "answer": null, "createdAt": 1, "answeredAt": null}]
  }],
  "awaiting": [{"id": "r2", "repo": "demo", "slug": "b", "title": "B", "request": "b", "state": "awaiting_human", "step": null,
                "fixes": 1, "modules": [], "createdAt": 1, "updatedAt": 2,
                "verdict": {"risk": "medium", "summary": "à relire", "blockers": [], "risks": ["perf"], "files": ["a.ts"],
                            "unverified": ["1M lignes"], "confidence": "strong"}}],
  "decisions": [{"id": 4, "runId": "r3", "stepId": 2, "seq": 1, "question": "Séparateur ?", "options": [",", ";"], "chosen": ",",
                 "rationale": "RFC 4180", "category": "reversible", "status": "auto", "checkpointSha": "def",
                 "reversalOption": null, "reversalReason": null, "createdAt": 1, "decidedAt": null}],
  "runs": [{"id": "r4", "repo": "demo", "slug": "c", "title": "C", "request": "c", "state": "running", "step": "review",
            "fixes": 0, "modules": [], "createdAt": 1, "updatedAt": 2},
           {"id": "r5", "repo": "demo", "slug": "d", "title": "D", "request": "d", "state": "nouvel_etat",
            "fixes": 0, "modules": [], "createdAt": 1, "updatedAt": 2}],
  "cursor": 42
}
"""#

@MainActor
private func makeModel(_ transport: ScriptedHarnessTransport, preferences: InMemoryClientPreferences = InMemoryClientPreferences(), tokens: InMemoryTokenStore = InMemoryTokenStore()) -> HarnessModel {
    HarnessModel(transport: transport, preferences: preferences, tokens: tokens, retryDelay: .seconds(3600), refreshDelay: .milliseconds(1))
}

private func ok(_ json: String) -> HarnessReply { HarnessReply(status: 200, body: Data(json.utf8)) }

/// Le catalogue tel que le serveur l'écrit (`/v1/status`, `/v1/projects`,
/// `/v1/audits`, `/v1/stats`) : clés en plus, valeurs `null`.
private let statusJSON = #"{"runs":{"merged":2},"live":[],"scheduler":{},"repos":[{"name":"demo","scope":"src"}],"oracle":{"configured":false,"ok":false}}"#
private let projectsJSON = #"{"projects":[{"id":"p1","repo":"demo","title":"Refonte","status":"active","createdAt":1,"updatedAt":2,"runs":{"total":2,"byState":{"running":1,"merged":1}}}]}"#
private let auditsJSON = #"""
{"audits":[{"id":"a1","repo":"demo","focus":"","state":"proposed","createdAt":1,"updatedAt":2,"projectId":null,"reason":null,
  "proposals":[{"title":"Cache","request":"Ajouter un cache","modules":["src/api"],"kind":"faiblesse","rationale":"lent"}]}]}
"""#
private let statsJSON = #"""
{"runs":{"total":3,"byState":{"merged":2,"failed":1},"mergedLast7Days":2,"mergeRate":0.67,"medianLeadSec":3600,"fixesPerMerged":0.5},
 "steps":{"impl":{"count":3,"failed":1,"medianSec":900}},
 "tests":{"total":4,"cached":1,"byOutcome":{"pass":3,"fail":1},"retried":0},
 "decisions":{"auto":1},"escalations":{"open":0},"audits":{"proposed":1},"projects":{"active":1},
 "scheduler":{"runner":{"used":1,"capacity":5,"labels":["r1"]},"heavy":{"used":0,"capacity":2,"labels":[]},"memAvailableMiB":null,"providers":{}}}
"""#

/// Un serveur qui répond au catalogue, à la boîte et aux lancements.
private func catalogServer(_ call: HarnessCall) -> HarnessReply {
    switch (call.method, call.path) {
    case ("GET", "/v1/status"): ok(statusJSON)
    case ("GET", "/v1/projects"): ok(projectsJSON)
    case ("GET", "/v1/audits"): ok(auditsJSON)
    case ("GET", "/v1/stats"): ok(statsJSON)
    case ("POST", "/v1/projects"), ("POST", "/v1/audits/a1/launch"): HarnessReply(status: 201, body: Data(#"{"projectId":"p2","runs":[]}"#.utf8))
    case ("POST", _): HarnessReply(status: 400, body: Data(#"{"error":"dépôt inconnu : x"}"#.utf8))
    default: ok(inboxJSON)
    }
}

@Suite("Serveur de pipelines — client")
@MainActor
struct HarnessModelTests {
    @Test("la boîte du serveur se décode telle qu'il l'écrit, état inconnu compris")
    func decodesInbox() throws {
        let inbox = try JSONDecoder().decode(HarnessInbox.self, from: Data(inboxJSON.utf8))
        #expect(inbox.batches.first?.run?.title == "Export CSV")
        #expect(inbox.batches.first?.items.first?.options == ["colonne", "table"])
        #expect(inbox.awaiting.first?.verdict?.isWeak == true)
        #expect(inbox.awaiting.first?.verdict?.isLowRisk == false)
        #expect(inbox.decisions.first?.alternatives == [";"])
        #expect(inbox.pendingCount == 3)
        #expect(inbox.cursor == 42)
        #expect(inbox.runs.last?.phase == nil, "un état apparu après cette version se lit sans échouer")
        #expect(inbox.active.map(\.id) == ["r4", "r5"])
        #expect(inbox.runs.first?.stepLabel == PipelineServerText.stepReview)
    }

    @Test("une saisie devient une adresse https sans barre finale ; le reste est refusé")
    func normalizesAddress() {
        #expect(HarnessModel.normalizedAddress("vps.tailnet.ts.net") == "https://vps.tailnet.ts.net")
        #expect(HarnessModel.normalizedAddress("  https://vps.example/harness/ ") == "https://vps.example/harness")
        #expect(HarnessModel.normalizedAddress("http://127.0.0.1:8790") == "http://127.0.0.1:8790")
        #expect(HarnessModel.normalizedAddress("ftp://vps.example") == nil)
        #expect(HarnessModel.normalizedAddress("pas une adresse") == nil)
        #expect(HarnessModel.normalizedAddress("") == nil)
    }

    @Test("le chemin s'ajoute à l'adresse, préfixe de reverse proxy compris")
    func keepsProxyPrefix() throws {
        let server = HarnessServer(baseURL: try #require(URL(string: "https://vps.example/harness")), token: "t")
        #expect(URLSessionHarnessTransport.url("/v1/inbox", server: server)?.absoluteString == "https://vps.example/harness/v1/inbox")
    }

    @Test("une configuration n'est enregistrée qu'après une boîte effectivement lue")
    func configureSavesOnlyOnSuccess() async {
        let transport = ScriptedHarnessTransport()
        let preferences = InMemoryClientPreferences()
        let tokens = InMemoryTokenStore()
        let model = makeModel(transport, preferences: preferences, tokens: tokens)

        transport.respond { _ in HarnessReply(status: 401, body: Data(#"{"error":"jeton absent ou invalide"}"#.utf8)) }
        #expect(await model.configure(address: "vps.example", token: "mauvais") == false)
        #expect(model.failure == .unauthorized)
        #expect(model.isConfigured == false)
        #expect(preferences.string(forKey: HarnessModel.addressKey) == nil)
        #expect(await tokens.knownTokens.isEmpty)

        transport.respond { _ in ok(inboxJSON) }
        #expect(await model.configure(address: "vps.example", token: " bon ") == true)
        #expect(model.isConfigured)
        #expect(model.failure == nil)
        #expect(model.inbox?.cursor == 42)
        #expect(preferences.string(forKey: HarnessModel.addressKey) == "https://vps.example")
        #expect(await tokens.knownTokens[HarnessModel.tokenAccount] == "bon")
        #expect(transport.calls.last?.path == "/v1/inbox")

        #expect(await model.configure(address: "ftp://x", token: "t") == false)
        #expect(model.failure == .invalidAddress)
    }

    @Test("un code d'appairage (harness.sh pair, /pair) se décode comme le plugin l'écrit ; un texte quelconque n'en est pas un")
    func decodesPairingCode() {
        let full = "omp1:aHR0cHM6Ly92cHMudGFpbG5ldC50cy5uZXQKYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQpodHRwczovL3Zwcy50YWlsbmV0LnRzLm5ldDo4NDQzCmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI"
        #expect(HarnessPairing.decode(full) == HarnessPairing(
            address: "https://vps.tailnet.ts.net",
            token: String(repeating: "a", count: 64),
            memoryAddress: "https://vps.tailnet.ts.net:8443",
            memoryToken: String(repeating: "b", count: 64)
        ))
        // Sans mémoire partagée : les deux dernières lignes sont vides.
        let local = HarnessPairing.decode("  omp1:aHR0cDovLzEyNy4wLjAuMTo4NzkwCmpldG9uCgo \n")
        #expect(local?.address == "http://127.0.0.1:8790")
        #expect(local?.token == "jeton")
        #expect(local?.memoryAddress == "")
        #expect(HarnessPairing.decode("https://vps.example") == nil)
        #expect(HarnessPairing.decode("omp1:pas-du-base64!") == nil)
    }

    @Test("coller le code d'appairage dans l'adresse configure le serveur, sans saisir de jeton")
    func configuresFromPairingCode() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { _ in ok(inboxJSON) }
        let tokens = InMemoryTokenStore()
        let model = makeModel(transport, tokens: tokens)
        #expect(await model.configure(address: "omp1:aHR0cDovLzEyNy4wLjAuMTo4NzkwCmpldG9uCgo", token: ""))
        #expect(model.address == "http://127.0.0.1:8790")
        #expect(await tokens.knownTokens[HarnessModel.tokenAccount] == "jeton")
    }

    @Test("sans serveur enregistré, l'app prend celui de la machine (~/.omp/harness.json)")
    func loadsSharedSettings() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("harness-home-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".omp"), withIntermediateDirectories: true)
        try Data(#"{ "url": "https://vps.tailnet.ts.net/", "token": "jeton", "repos": {} }"#.utf8)
            .write(to: home.appendingPathComponent(".omp/harness.json"))
        let shared = try #require(HarnessPairing.sharedSettings(home: home))
        #expect(shared.address == "https://vps.tailnet.ts.net")
        #expect(shared.token == "jeton")

        let transport = ScriptedHarnessTransport()
        transport.respond { _ in ok(inboxJSON) }
        let model = HarnessModel(
            transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
            retryDelay: .seconds(3600), refreshDelay: .milliseconds(1),
            fallback: { HarnessPairing.sharedSettings(home: home) }
        )
        await model.load()
        #expect(model.isConfigured)
        #expect(model.address == "https://vps.tailnet.ts.net")
        #expect(model.inbox?.cursor == 42)
    }

    @Test("un code accepté est écrit pour omp et la mémoire, en gardant les dépôts reliés ; une adresse seule n'écrit rien")
    func writesAcceptedPairing() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("harness-pair-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".omp"), withIntermediateDirectories: true)
        try Data(#"{ "url": "http://ancien", "token": "x", "repos": { "/code/produit": "produit" } }"#.utf8)
            .write(to: home.appendingPathComponent(".omp/harness.json"))
        let transport = ScriptedHarnessTransport()
        transport.respond { _ in ok(inboxJSON) }
        let model = HarnessModel(
            transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
            retryDelay: .seconds(3600), refreshDelay: .milliseconds(1),
            onPaired: { try? $0.writeShared(home: home) }
        )
        #expect(await model.configure(address: "https://autre.example", token: "jeton"))
        #expect(HarnessPairing.sharedSettings(home: home)?.address == "http://ancien")

        let pairing = HarnessPairing(
            address: "https://vps.tailnet.ts.net", token: "jeton",
            memoryAddress: "https://vps.tailnet.ts.net:8443", memoryToken: "memoire"
        )
        try pairing.writeShared(home: home)
        let harnessObject = try JSONSerialization.jsonObject(with: Data(contentsOf: home.appendingPathComponent(".omp/harness.json")))
        let harness = try #require(harnessObject as? [String: Any])
        #expect(harness["url"] as? String == "https://vps.tailnet.ts.net")
        #expect((harness["repos"] as? [String: String]) == ["/code/produit": "produit"])
        let memoryObject = try JSONSerialization.jsonObject(with: Data(contentsOf: home.appendingPathComponent(".omp/mem0.json")))
        let memory = try #require(memoryObject as? [String: String])
        #expect(memory == ["url": "https://vps.tailnet.ts.net:8443", "token": "memoire"])

        #expect(await model.configure(address: "omp1:aHR0cDovLzEyNy4wLjAuMTo4NzkwCmpldG9uCgo", token: ""))
        #expect(HarnessPairing.sharedSettings(home: home)?.address == "http://127.0.0.1:8790")
    }

    @Test("un modèle neuf retrouve le serveur enregistré ; l'oublier efface adresse et jeton")
    func loadsAndForgets() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { _ in ok(inboxJSON) }
        let preferences = InMemoryClientPreferences([HarnessModel.addressKey: "https://vps.example"])
        let tokens = InMemoryTokenStore([HarnessModel.tokenAccount: "t"])
        let model = makeModel(transport, preferences: preferences, tokens: tokens)
        await model.load()
        #expect(model.isLoaded)
        #expect(model.isConfigured)
        #expect(model.inbox?.batches.count == 1)

        await model.forget()
        #expect(model.isConfigured == false)
        #expect(model.inbox == nil)
        #expect(preferences.string(forKey: HarnessModel.addressKey) == nil)
        #expect(await tokens.knownTokens.isEmpty)
    }

    @Test("répondre envoie tout le lot en un geste, puis relit la boîte")
    func answersBatch() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            call.method == "POST" ? ok(#"{"run":{}}"#) : ok(inboxJSON)
        }
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        #expect(await model.answer(runId: "r1", answers: [9: "b", 7: "table"]))
        let post = try #require(transport.calls.first { $0.method == "POST" })
        #expect(post.path == "/v1/runs/r1/escalations")
        let body = try #require(post.body)
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: [[String: Any]]]
        #expect(decoded?["answers"]?.compactMap { $0["id"] as? Int } == [7, 9])
        #expect(transport.calls.last?.path == "/v1/inbox", "la boîte est relue après le geste")
        #expect(model.busy.isEmpty)
    }

    @Test("un geste refusé garde le motif du serveur ; les autres gestes visent leur route")
    func rejectedGesture() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            switch (call.method, call.path) {
            case ("POST", "/v1/runs/r1/cancel"): HarnessReply(status: 409, body: Data(#"{"error":"merge en cours"}"#.utf8))
            case ("POST", _): ok(#"{"decision":{}}"#)
            default: ok(inboxJSON)
            }
        }
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        #expect(await model.cancel(runId: "r1") == false)
        #expect(model.failure == .rejected("merge en cours"))
        #expect(model.failure?.message == PipelineServerText.rejected("merge en cours"))
        #expect(await model.accept(runId: "r3", seq: 1))
        #expect(await model.reverse(runId: "r3", seq: 1, option: ";", reason: "Excel FR"))
        #expect(await model.validate(runId: "r2", approve: false, reason: "trop lent"))
        let paths = transport.calls.filter { $0.method == "POST" }.map(\.path)
        #expect(paths == ["/v1/runs/r1/cancel", "/v1/runs/r3/decisions/1/accept", "/v1/runs/r3/decisions/1/reverse", "/v1/runs/r2/validate"])
    }

    @Test("le flux part du curseur de la boîte, et un événement fait relire la boîte")
    func liveRefreshes() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { _ in ok(inboxJSON) }
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        let before = transport.calls.filter { $0.path == "/v1/inbox" }.count
        transport.stream([Data(": ping\n\n".utf8), Data("id: 43\nevent: run_state\ndata: {}\n\n".utf8)])
        model.startLive()
        #expect(await eventually { transport.calls.contains { $0.path == "/v1/events?after=42" } })
        #expect(await eventually { transport.calls.filter { $0.path == "/v1/inbox" }.count > before })
        model.stopLive()
        #expect(model.isLive == false)
    }

    @Test("le flux ouvert avant la configuration démarre dès qu'un serveur est relié")
    func liveStartsAfterSetup() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { _ in ok(inboxJSON) }
        let model = makeModel(transport)
        await model.load()
        model.startLive()
        #expect(transport.calls.isEmpty, "sans serveur, aucun flux ne part")
        #expect(await model.configure(address: "vps.example", token: "t"))
        model.startLive()
        #expect(await eventually { transport.calls.contains { $0.path.hasPrefix("/v1/events") } })
        model.stopLive()
    }

    @Test("le lecteur du flux ne rend que les événements complets, battements exclus")
    func parsesEvents() {
        var parser = HarnessEventParser()
        #expect(parser.consume(Data(": ping\n\nid: 1\nevent: run_sta".utf8)).isEmpty)
        #expect(parser.consume(Data("te\ndata: {}\n\nid: 2\nevent: merged\ndata: {}\n\n".utf8)) == ["run_state", "merged"])
    }

    @Test("chaque échec a sa phrase : cause, puis remède")
    func failureMessages() {
        #expect(HarnessFailure.unauthorized.message == PipelineServerText.unauthorized)
        #expect(HarnessFailure.unreachable.message == PipelineServerText.unreachable)
        #expect(HarnessFailure.rejected("").message == PipelineServerText.rejected(""))
    }

    @Test("le catalogue se lit tel que le serveur l'écrit : dépôts, projets, audits, statistiques")
    func readsCatalog() async {
        let transport = ScriptedHarnessTransport()
        transport.respond(catalogServer)
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        await model.refreshCatalog()
        #expect(model.failure == nil)
        #expect(model.repos == [HarnessRepo(name: "demo", scope: "src")])
        #expect(model.projects.first?.runs.total == 2)
        #expect(model.audits.first?.isProposed == true)
        #expect(model.audits.first?.proposals.first?.isWeakness == true)
        #expect(model.stats?.runs.mergeRate == 0.67)
        #expect(model.stats?.steps["impl"]?.failed == 1)
        #expect(model.stats?.scheduler.runner.capacity == 5)
    }

    @Test("un lancement poste son corps, relit boîte et catalogue ; un refus garde le motif du serveur")
    func launchesWork() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(catalogServer)
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))

        let features = [HarnessFeatureDraft(title: "A", request: "a"), HarnessFeatureDraft(title: "B", request: "b")]
        #expect(await model.launchProject(repo: "demo", title: "Refonte", features: features) == "p2")
        let post = try #require(transport.calls.first { $0.method == "POST" })
        #expect(post.path == "/v1/projects")
        let body = try JSONSerialization.jsonObject(with: try #require(post.body)) as? [String: Any]
        #expect(body?["repo"] as? String == "demo")
        #expect((body?["features"] as? [[String: Any]])?.compactMap { $0["title"] as? String } == ["A", "B"])
        #expect(transport.calls.contains { $0.path == "/v1/inbox" }, "la boîte est relue après le lancement")
        #expect(transport.calls.last?.path == "/v1/stats", "le catalogue est relu après le lancement")
        #expect(model.isLaunching == false)

        #expect(await model.launchProposals(auditId: "a1", items: [2, 0], title: "Audit") == "p2")
        let launch = try #require(transport.calls.last { $0.path == "/v1/audits/a1/launch" })
        let picked = try JSONSerialization.jsonObject(with: try #require(launch.body)) as? [String: Any]
        #expect(picked?["items"] as? [Int] == [0, 2])
        #expect(model.busyAudits.isEmpty)

        #expect(await model.launchRun(repo: "x", title: "T", request: "r") == nil)
        #expect(model.failure == .rejected("dépôt inconnu : x"))
    }
}
