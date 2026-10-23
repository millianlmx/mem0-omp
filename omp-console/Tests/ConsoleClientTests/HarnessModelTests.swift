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

/// Attend qu'une condition du fil principal devienne vraie, au plus `timeout` secondes.
@MainActor
func eventually(timeout: Double = 3, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return condition()
}

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
        #expect(inbox.pendingCount == 2, "escalades et attentes seulement : les décisions prises seules ne bloquent rien")
        #expect(inbox.decisionRunIds == ["r3"])
        #expect(inbox.cursor == 42)
        #expect(inbox.runs.last?.phase == nil, "un état apparu après cette version se lit sans échouer")
        #expect(inbox.active.map(\.id) == ["r4", "r5"])
        #expect(inbox.runs.first?.stepLabel == PipelineServerText.stepReview)
    }

    @Test("un serveur antérieur n'écrit ni recommandation, ni options, ni fusions retentées : nil, vide, zéro")
    func decodesWithoutNewFields() throws {
        let inbox = try JSONDecoder().decode(HarnessInbox.self, from: Data(inboxJSON.utf8))
        let item = try #require(inbox.batches.first?.items.first)
        #expect(item.recommended == nil)
        #expect(item.context == "Proposé")
        let run = try #require(inbox.batches.first?.run)
        #expect(run.mergeRetries == 0)
        #expect(run.notBefore == nil)
        #expect(run.lastFailCause == nil)
        let bare = try JSONDecoder().decode(HarnessEscalation.self, from: Data(#"{"id":1,"runId":"r1","category":"schema","question":"Q ?","status":"open"}"#.utf8))
        #expect(bare.options == [])
        #expect(bare.context == nil)
        #expect(bare.shownContext == nil)
    }

    @Test("recommandation, options, contexte, fusions retentées, reprise différée et cause d'échec se décodent et se réencodent")
    func decodesNewFields() throws {
        let json = inboxJSON
            .replacingOccurrences(of: #""context": "Proposé""#, with: #""context": "Proposé", "recommended": "colonne""#)
            .replacingOccurrences(of: #""reason": "2 décision(s)""#, with: #""reason": "2 décision(s)", "mergeRetries": 2, "notBefore": 1700000000000, "lastFailCause": "rate_limit""#)
        let inbox = try JSONDecoder().decode(HarnessInbox.self, from: Data(json.utf8))
        let item = try #require(inbox.batches.first?.items.first)
        #expect(item.recommended == "colonne")
        #expect(item.options == ["colonne", "table"])
        #expect(item.shownContext == "Proposé")
        let run = try #require(inbox.batches.first?.run)
        #expect(run.mergeRetries == 2)
        #expect(run.notBefore == Date(timeIntervalSince1970: 1_700_000_000))
        #expect(run.lastFailCause == "rate_limit")
        let again = try JSONDecoder().decode(HarnessRun.self, from: JSONEncoder().encode(run))
        #expect(again == run, "l'instant repart en millisecondes")

        var queued = run
        queued.state = "queued"
        #expect(queued.detailLine(now: Date(timeIntervalSince1970: 1_699_999_000)) == PipelineServerText.resumeAt(Date(timeIntervalSince1970: 1_700_000_000).formatted(date: .omitted, time: .shortened)))
        #expect(queued.detailLine(now: Date(timeIntervalSince1970: 1_700_000_001)) == nil, "une échéance passée ne se dit plus")
        var failed = run
        failed.state = "failed"
        #expect(failed.detailLine() == PipelineServerText.lastFailure(PipelineServerText.failCause("rate_limit")))
        #expect(failed.canRetry && !failed.canRevert)
        var merged = run
        merged.state = "merged"
        #expect(merged.canRevert && !merged.canRetry)
        #expect(merged.detailLine() == nil)
    }

    @Test("une décision tranchée à l'échéance se dit ; une décision ordinaire est un choix de l'agent")
    func decisionStatusLabels() {
        #expect(HarnessDecision(id: 1, runId: "r", seq: 1, question: "q", options: [], chosen: "a", rationale: "", status: "auto_timeout").decidedAtDeadline)
        #expect(PipelineServerText.decisionStatus("auto_timeout") == PipelineServerText.decidedAtDeadline)
        #expect(PipelineServerText.decisionStatus("auto") == PipelineServerText.decidedByAgent)
        #expect(PipelineServerText.decisionStatus("accepted") == nil)
    }

    @Test("les brouillons d'escalade partent de la recommandation ; une saisie la remplace ; « Accepter les recommandations » exige une recommandation par escalade")
    func draftsPreselectRecommended() {
        let first = HarnessEscalation(id: 7, runId: "r1", category: "schema", question: "Où ?", options: ["colonne", "table"], recommended: "colonne")
        let second = HarnessEscalation(id: 9, runId: "r1", category: "deletion", question: "Supprimer ?", options: ["oui", "non"])
        let drafts = HarnessDrafts()
        let withReco = HarnessEscalationBatch(run: nil, items: [first])
        #expect(drafts.answer(for: first) == "colonne")
        #expect(drafts.isRecommended(first))
        #expect(drafts.canAnswer(withReco))
        #expect(drafts.answers(for: withReco) == [7: "colonne"])
        #expect(HarnessDrafts.recommendedAnswers(for: withReco) == [7: "colonne"])

        let mixed = HarnessEscalationBatch(run: nil, items: [first, second])
        #expect(drafts.canAnswer(mixed) == false, "la seconde n'a ni saisie ni recommandation")
        #expect(HarnessDrafts.recommendedAnswers(for: mixed) == nil)
        drafts.answers[9] = " non "
        drafts.answers[7] = "table"
        drafts.reasons[7] = " déjà une table "
        drafts.reasons[9] = "  "
        #expect(drafts.isRecommended(first) == false)
        #expect(drafts.canAnswer(mixed))
        #expect(drafts.answers(for: mixed) == [7: "table", 9: "non"])
        #expect(drafts.reasons(for: mixed) == [7: "déjà une table"], "une raison vide ne part pas")
        #expect(HarnessDrafts.recommendedAnswers(for: mixed) == nil, "une saisie ne tient pas lieu de recommandation")
        drafts.clearAnswers(for: mixed)
        #expect(drafts.answers.isEmpty && drafts.reasons.isEmpty)
        #expect(drafts.answer(for: first) == "colonne", "la recommandation revient après l'envoi")
        #expect(HarnessDrafts.recommendedAnswers(for: HarnessEscalationBatch(run: nil, items: [])) == nil)
    }

    @Test("une réponse porte sa raison quand il y en a une ; sans raison, le corps est celui d'avant")
    func answersCarryReasons() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in call.method == "POST" ? ok(#"{"run":{}}"#) : ok(inboxJSON) }
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        #expect(await model.answer(runId: "r1", answers: [7: "table", 9: "non"], reasons: [7: " déjà une table ", 9: " "]))
        let post = try #require(transport.calls.first { $0.method == "POST" })
        let decoded = try JSONSerialization.jsonObject(with: try #require(post.body)) as? [String: [[String: Any]]]
        let answers = try #require(decoded?["answers"])
        #expect(answers.map { $0["id"] as? Int } == [7, 9])
        #expect(answers[0]["reason"] as? String == "déjà une table")
        #expect(answers[1]["reason"] == nil, "une raison vide n'est pas envoyée")
    }

    @Test("relancer, tout accepter et annuler visent leur route, avec la révision lue")
    func retryAcceptAllRevertRoutes() async throws {
        let transport = ScriptedHarnessTransport()
        let withRev = inboxJSON.replacingOccurrences(of: #""reason": "2 décision(s)""#, with: #""reason": "2 décision(s)", "rev": 7"#)
        transport.respond { call in
            switch (call.method, call.path) {
            case ("POST", "/v1/runs/r1/retry"): ok(#"{"run":{}}"#)
            case ("POST", "/v1/runs/r1/decisions/accept"): ok(#"{"accepted":2}"#)
            case ("POST", "/v1/runs/r1/revert"): ok(#"{"run":{}}"#)
            case ("POST", "/v1/runs/r4/retry"): HarnessReply(status: 409, body: Data(#"{"error":"ni en échec ni en attente"}"#.utf8))
            default: ok(withRev)
            }
        }
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        #expect(await model.retry(runId: "r1"))
        #expect(await model.acceptAllDecisions(runId: "r1"))
        #expect(await model.revert(runId: "r1"))
        let posts = transport.calls.filter { $0.method == "POST" }
        #expect(posts.map(\.path) == ["/v1/runs/r1/retry", "/v1/runs/r1/decisions/accept", "/v1/runs/r1/revert"])
        #expect(posts.allSatisfy { $0.headers["If-Match"] == "\"7\"" })
        #expect(transport.calls.last?.path == "/v1/inbox", "la boîte est relue après le geste")
        #expect(await model.retry(runId: "r4") == false)
        #expect(model.failure == .rejected("ni en échec ni en attente"))
        #expect(model.busy.isEmpty)
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
        // La boîte d'abord (la preuve), puis le client du jeton ; un serveur sans /v1/me ne gêne rien.
        #expect(transport.calls.suffix(2).map(\.path) == ["/v1/inbox", "/v1/me"])
        #expect(model.client == nil)
        #expect(model.canAct)

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

    @Test("chaque geste porte la révision lue : un autre appareil a agi entre-temps, le geste est refusé et la boîte relue")
    func staleGesture() async throws {
        let transport = ScriptedHarnessTransport()
        let withRev = inboxJSON.replacingOccurrences(of: #""reason": "2 décision(s)""#, with: #""reason": "2 décision(s)", "rev": 7, "priority": 2, "createdBy": "mac""#)
        transport.respond { call in
            switch (call.method, call.path) {
            case ("POST", "/v1/runs/r1/cancel"): HarnessReply(status: 412, body: Data(#"{"error":"le run a changé"}"#.utf8))
            case ("POST", _): ok(#"{"run":{}}"#)
            default: ok(withRev)
            }
        }
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        let run = try #require(model.inbox?.batches.first?.run)
        #expect(run.rev == 7)
        #expect(run.priority == 2)
        #expect(run.createdBy == "mac")

        let inboxReads = transport.calls.filter { $0.path == "/v1/inbox" }.count
        #expect(await model.cancel(runId: "r1") == false)
        let post = try #require(transport.calls.last { $0.method == "POST" })
        #expect(post.headers["If-Match"] == "\"7\"")
        #expect(model.failure == .stale)
        #expect(model.failure?.message == PipelineServerText.stale)
        #expect(transport.calls.filter { $0.path == "/v1/inbox" }.count == inboxReads + 1, "la boîte est relue")

        // Un run absent de la boîte (lu ailleurs) part sans révision : le serveur n'impose rien.
        #expect(await model.accept(runId: "inconnu", seq: 1))
        #expect(transport.calls.last { $0.method == "POST" }?.headers.isEmpty == true)
    }

    @Test("un jeton en lecture seule le sait (/v1/me) ; un geste refusé par le rôle garde le motif du serveur")
    func viewerClient() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/me"): ok(#"{"client":{"name":"ipad","role":"viewer","repos":["demo"],"createdAt":1}}"#)
            case ("POST", _): HarnessReply(status: 403, body: Data(#"{"error":"le rôle viewer ne permet pas cela"}"#.utf8))
            default: ok(inboxJSON)
            }
        }
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        #expect(model.client == HarnessClient(name: "ipad", role: "viewer", repos: ["demo"]))
        #expect(model.canAct == false)
        #expect(await model.validate(runId: "r2", approve: true, reason: "") == false)
        #expect(model.failure == .forbidden("le rôle viewer ne permet pas cela"))
        #expect(model.failure?.message == PipelineServerText.forbidden("le rôle viewer ne permet pas cela"))
        // Un administrateur, lui, voit tous les dépôts (`"*"`).
        let admin = try? JSONDecoder().decode(HarnessMe.self, from: Data(#"{"client":{"name":"admin","role":"admin","repos":"*","createdAt":0}}"#.utf8))
        #expect(admin?.client.repos == nil)
        #expect(admin?.client.canAct == true)
    }

    @Test("priorité, modules et projet : les corps portent ce qui est saisi, et rien de plus pour un serveur ancien")
    func priorityAndModules() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            switch (call.method, call.path) {
            case ("POST", "/v1/runs"): HarnessReply(status: 201, body: Data(#"{"run":{"id":"r9","repo":"demo","slug":"x","title":"T","request":"r","state":"queued","fixes":0,"modules":["src/api"],"createdAt":1,"updatedAt":1}}"#.utf8))
            case ("POST", "/v1/projects"): HarnessReply(status: 201, body: Data(#"{"projectId":"p2","runs":[]}"#.utf8))
            case ("POST", _): ok(#"{"run":{}}"#)
            default: catalogServer(call)
            }
        }
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))

        #expect(await model.setPriority(runId: "r4", priority: 10))
        let bump = try #require(transport.calls.last { $0.method == "POST" })
        #expect(bump.path == "/v1/runs/r4/priority")
        #expect((try JSONSerialization.jsonObject(with: try #require(bump.body)) as? [String: Int]) == ["priority": 10])

        #expect(await model.launchRun(repo: "demo", title: "T", request: "r", modules: ["src/api"], priority: 3)?.id == "r9")
        let run = try JSONSerialization.jsonObject(with: try #require(transport.calls.last { $0.method == "POST" && $0.path == "/v1/runs" }?.body)) as? [String: Any]
        #expect(run?["modules"] as? [String] == ["src/api"])
        #expect(run?["priority"] as? Int == 3)

        _ = await model.launchRun(repo: "demo", title: "T", request: "r")
        let plain = try JSONSerialization.jsonObject(with: try #require(transport.calls.last { $0.method == "POST" && $0.path == "/v1/runs" }?.body)) as? [String: Any]
        #expect(plain.map { Set($0.keys) } == ["repo", "title", "request"], "un serveur ancien reçoit le même corps qu'avant")

        let draft = HarnessFeatureDraft(title: "A", request: "a", modules: " src/api, docs src/api ")
        #expect(draft.moduleList == ["src/api", "docs"])
        #expect(await model.launchProject(repo: "demo", title: "Refonte", features: [draft, HarnessFeatureDraft(title: "B", request: "b")], priority: 1) == "p2")
        let project = try JSONSerialization.jsonObject(with: try #require(transport.calls.last { $0.method == "POST" && $0.path == "/v1/projects" }?.body)) as? [String: Any]
        #expect(project?["priority"] as? Int == 1)
        let features = project?["features"] as? [[String: Any]]
        #expect(features?.first?["modules"] as? [String] == ["src/api", "docs"])
        #expect(features?.last?["modules"] == nil, "une feature sans modules laisse le serveur les chercher")
    }

    @Test("un admin lit les fournisseurs et déclare une clé qui ne revient jamais ; les champs vides ne partent pas")
    func providers() async throws {
        let catalog = #"""
        {"providers":[
          {"name":"openai","kind":"openai","source":"api","baseUrl":null,"api":null,"models":[],"capacity":null,"refillPerMinute":null,
           "keyVariable":"OPENAI_API_KEY","hasKey":true,"keyHint":"9f3c","updatedBy":"admin"},
          {"name":"vps-ollama","kind":"openai-compatible","source":"api","baseUrl":"http://127.0.0.1:11434/v1","api":"openai-completions",
           "models":[{"id":"qwen3-coder","contextWindow":32768}],"capacity":5,"refillPerMinute":10,
           "keyVariable":"VPS_OLLAMA_API_KEY","hasKey":false,"keyHint":null,"updatedBy":"admin"},
          {"name":"anthropic","kind":"anthropic","source":"config","baseUrl":null,"api":null,"models":[],"capacity":null,"refillPerMinute":null,
           "keyVariable":"ANTHROPIC_API_KEY","hasKey":false,"keyHint":null,"updatedBy":null}],
         "models":{"fast":[],"standard":[{"provider":"anthropic","model":"claude-sonnet-5-5"}],"heavy":[{"provider":"vps-ollama","model":"qwen3-coder"}]},
         "modelsSource":"api","kinds":["anthropic","openai","openai-compatible"],"apis":["openai-completions"]}
        """#
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/me"): ok(#"{"client":{"name":"admin","role":"admin","repos":"*","createdAt":0}}"#)
            case ("GET", "/v1/providers"), ("PUT", "/v1/models"): ok(catalog)
            case ("PUT", "/v1/providers/openai"): ok(#"{"provider":{"name":"openai","kind":"openai","hasKey":true,"keyHint":"wxyz"}}"#)
            case ("DELETE", "/v1/providers/vps-ollama"): HarnessReply(status: 409, body: Data(#"{"error":"fournisseur utilisé par les chaînes heavy"}"#.utf8))
            default: ok(inboxJSON)
            }
        }
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        #expect(model.isAdmin)
        await model.refreshProviders()
        let read = try #require(model.providerCatalog)
        #expect(read.providers.map(\.name) == ["openai", "vps-ollama", "anthropic"])
        #expect(read.providers[1].isCompatible && read.providers[1].models.first?.contextWindow == 32768)
        #expect(read.providers[2].isEditable == false, "un fournisseur de la configuration se lit seulement")
        #expect(read.modelsFromApps)
        #expect(PipelineServerText.keyState(hasKey: true, hint: read.providers[0].keyHint) == "Clé ••••9f3c")

        // La modification garde la clé tant qu'on n'en saisit pas une neuve.
        let drafts = HarnessDrafts()
        drafts.beginProvider(read.providers[0])
        var draft = try #require(drafts.provider)
        #expect(draft.keyHint == "9f3c" && draft.apiKey.isEmpty)
        #expect(await model.saveProvider(draft))
        let kept = try JSONSerialization.jsonObject(with: try #require(transport.calls.last { $0.method == "PUT" }?.body)) as? [String: Any]
        #expect(kept?["kind"] as? String == "openai")
        #expect(kept?["apiKey"] == nil, "un champ de clé vide garde la clé déclarée")
        #expect(kept?["baseUrl"] == nil && kept?["models"] == nil, "un fournisseur connu n'envoie ni adresse ni modèles")
        #expect(kept?["capacity"] is NSNull, "un débit vide retire la limite")

        draft.apiKey = " sk-test-wxyz "
        #expect(await model.saveProvider(draft))
        let fresh = try JSONSerialization.jsonObject(with: try #require(transport.calls.last { $0.method == "PUT" }?.body)) as? [String: Any]
        #expect(fresh?["apiKey"] as? String == "sk-test-wxyz")
        draft.apiKey = ""
        draft.removeKey = true
        #expect(await model.saveProvider(draft))
        let cleared = try JSONSerialization.jsonObject(with: try #require(transport.calls.last { $0.method == "PUT" }?.body)) as? [String: Any]
        #expect(cleared?["apiKey"] as? String == "", "effacer la clé envoie une clé vide")

        // Retirer un fournisseur encore nommé : le motif du serveur reste.
        #expect(await model.removeProvider("vps-ollama") == false)
        #expect(model.failure == .rejected("fournisseur utilisé par les chaînes heavy"))
    }

    @Test("un fournisseur compatible demande nom, adresse et modèles ; les modèles par niveau se saisissent fournisseur/modèle")
    func compatibleProviderAndChains() async throws {
        var draft = HarnessProviderDraft(kind: HarnessProviderDraft.compatible)
        #expect(draft.problem == .name)
        draft.name = "VPS-Ollama"
        #expect(draft.effectiveName == "vps-ollama")
        #expect(draft.problem == .address)
        draft.baseUrl = "http://127.0.0.1:11434/v1"
        #expect(draft.problem == .models)
        draft.models = "qwen3-coder, llama3.3 qwen3-coder"
        #expect(draft.modelList == ["qwen3-coder", "llama3.3"])
        draft.capacity = "5"
        #expect(draft.problem == .limit)
        draft.refillPerMinute = "10"
        draft.apiKey = "court"
        #expect(draft.problem == .key)
        #expect(draft.problem?.message == PipelineServerText.providerKeyProblem)
        draft.apiKey = ""
        #expect(draft.problem == nil)
        draft.name = "omlx"
        #expect(draft.problem == .reservedName)
        draft.name = "vps-ollama"
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.body)) as? [String: Any]
        #expect(body?["kind"] as? String == "openai-compatible")
        #expect(body?["api"] as? String == "openai-completions")
        #expect((body?["models"] as? [[String: Any]])?.compactMap { $0["id"] as? String } == ["qwen3-coder", "llama3.3"])
        #expect(body?["capacity"] as? Int == 5 && body?["refillPerMinute"] as? Int == 10)

        #expect(HarnessModelChains.parse("anthropic/claude-opus-5-5, vps-ollama/qwen3-coder")
            == [HarnessModelChoice(provider: "anthropic", model: "claude-opus-5-5"), HarnessModelChoice(provider: "vps-ollama", model: "qwen3-coder")])
        #expect(HarnessModelChains.parse("") == [])
        #expect(HarnessModelChains.parse("claude-opus") == nil)

        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            switch (call.method, call.path) {
            case ("PUT", "/v1/models"): ok(#"{"providers":[],"models":{"fast":[],"standard":[],"heavy":[]},"modelsSource":"config","kinds":[],"apis":[]}"#)
            default: ok(inboxJSON)
            }
        }
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        let drafts = HarnessDrafts()
        drafts.chains = ["fast": "", "standard": "vps-ollama/qwen3-coder", "heavy": "anthropic/claude-opus-5-5, vps-ollama/qwen3-coder"]
        let chains = try #require(drafts.parsedChains)
        #expect(await model.saveChains(chains))
        let sent = try JSONSerialization.jsonObject(with: try #require(transport.calls.last?.body)) as? [String: Any]
        let heavy = (sent?["models"] as? [String: Any])?["heavy"] as? [[String: String]]
        #expect(heavy?.map { $0["provider"] ?? "" } == ["anthropic", "vps-ollama"])
        #expect(await model.saveChains(nil))
        let reset = try JSONSerialization.jsonObject(with: try #require(transport.calls.last?.body)) as? [String: Any]
        #expect(reset?["models"] is NSNull, "revenir aux modèles du serveur envoie null")
        #expect(model.providerCatalog?.modelsFromApps == false)
        drafts.chains["heavy"] = "sans-barre"
        #expect(drafts.parsedChains == nil)
    }

    @Test("un abonnement se connecte depuis l'app : la page à ouvrir, le code rapporté, puis les fournisseurs relus")
    func subscriptionLogin() async throws {
        final class Steps: @unchecked Sendable {
            let lock = NSLock()
            var reads = 0
            var answered = false
            func read() -> Int { lock.withLock { reads += 1; return reads } }
            func answer() { lock.withLock { answered = true } }
            var wasAnswered: Bool { lock.withLock { answered } }
        }
        let steps = Steps()
        let waiting = #"{"login":{"id":"l1","provider":"openai-codex","state":"waiting","url":"https://auth.example.com/authorize?s=1","instructions":"Complete login","prompt":"Paste the code","progress":[],"error":null}}"#
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/me"): return ok(#"{"client":{"name":"admin","role":"admin","repos":"*","createdAt":0}}"#)
            case ("GET", "/v1/oauth"):
                return ok(#"{"providers":[{"id":"openai-codex","name":"ChatGPT Plus/Pro","available":true,"authenticated":false},{"id":"anthropic","name":"Claude Pro/Max","available":true,"authenticated":true},{"id":"retired","name":"Ancien","available":false,"authenticated":false}],"login":null}"#)
            case ("POST", "/v1/oauth/openai-codex/login"):
                return HarnessReply(status: 201, body: Data(#"{"login":{"id":"l1","provider":"openai-codex","state":"starting","url":null,"prompt":null,"progress":[],"error":null}}"#.utf8))
            case ("GET", "/v1/oauth/logins/l1"):
                if steps.wasAnswered { return ok(#"{"login":{"id":"l1","provider":"openai-codex","state":"done","url":null,"prompt":null,"progress":[],"error":null}}"#) }
                _ = steps.read()
                return ok(waiting)
            case ("POST", "/v1/oauth/logins/l1/answer"):
                steps.answer()
                return ok(#"{"login":{"id":"l1","provider":"openai-codex","state":"verifying","url":null,"prompt":null,"progress":[],"error":null}}"#)
            case ("GET", "/v1/providers"):
                return ok(#"{"providers":[{"name":"openai-codex","kind":"oauth","source":"api","models":[],"keyVariable":"OPENAI_CODEX_API_KEY","hasKey":false}],"models":{"fast":[],"standard":[],"heavy":[]},"modelsSource":"config","kinds":["oauth"],"apis":[]}"#)
            default: return ok(inboxJSON)
            }
        }
        let model = HarnessModel(transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
                                 retryDelay: .seconds(3600), refreshDelay: .milliseconds(1), loginPollDelay: .milliseconds(5))
        #expect(await model.configure(address: "vps.example", token: "t"))
        await model.refreshLogins()
        let logins = try #require(model.loginProviders)
        #expect(logins.map(\.id) == ["openai-codex", "anthropic", "retired"])
        #expect(HarnessDrafts.connectable(logins).map(\.id) == ["openai-codex"], "ni un abonnement connecté, ni un indisponible")
        let drafts = HarnessDrafts()
        #expect(drafts.chosenLogin(in: logins) == "openai-codex")
        drafts.loginProvider = "anthropic"
        #expect(drafts.chosenLogin(in: logins) == "openai-codex", "un abonnement déjà connecté ne se choisit pas")

        #expect(await model.startLogin("openai-codex"))
        #expect(await eventually { model.login?.awaitsCode == true })
        let shown = try #require(model.login)
        #expect(shown.phase == .waiting)
        #expect(shown.link == URL(string: "https://auth.example.com/authorize?s=1"))

        #expect(await model.answerLogin("  code-42 \n"))
        let sent = try JSONSerialization.jsonObject(with: try #require(transport.calls.last { $0.path == "/v1/oauth/logins/l1/answer" }?.body)) as? [String: Any]
        #expect(sent?["value"] as? String == "code-42", "le code part sans les espaces copiés autour")
        #expect(await eventually { model.login?.succeeded == true })
        #expect(await eventually { model.providerCatalog?.providers.first?.isSubscription == true }, "les fournisseurs sont relus à la réussite")
        #expect(PipelineServerText.providerKind("oauth") == "Abonnement")
        model.dismissLogin()
        #expect(model.login == nil)
    }

    @Test("un abonnement déclaré se modifie sans clé ; un serveur sans abonnements cache la section sans échec")
    func subscriptionDraftAndOlderServer() async throws {
        let provider = HarnessProvider(name: "openai-codex", kind: HarnessProviderDraft.subscription)
        var draft = HarnessProviderDraft(editing: provider)
        #expect(draft.isSubscription && draft.effectiveName == "openai-codex")
        draft.apiKey = "x"
        #expect(draft.problem == nil, "un abonnement n'a pas de clé à vérifier")
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(draft.body)) as? [String: Any]
        #expect(body?["kind"] as? String == "oauth")
        #expect(body?["apiKey"] == nil, "aucune clé ne part pour un abonnement")

        let unknown = try JSONDecoder().decode(HarnessLogin.self, from: Data(#"{"id":"l","provider":"p","state":"etat_futur"}"#.utf8))
        #expect(unknown.phase == .waiting && !unknown.isFinished && unknown.link == nil)
        let unsafe = HarnessLogin(id: "l", provider: "p", state: "waiting", url: "javascript:alert(1)")
        #expect(unsafe.link == nil, "seule une page http(s) s'ouvre")

        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            call.path == "/v1/oauth" ? HarnessReply(status: 404, body: Data(#"{"error":"route inconnue"}"#.utf8)) : ok(inboxJSON)
        }
        let model = makeModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        await model.refreshLogins()
        #expect(model.loginProviders == nil)
        #expect(model.failure == nil)
    }
}
