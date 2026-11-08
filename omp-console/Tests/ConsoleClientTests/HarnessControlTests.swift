// Les tests hermétiques de la TOUR DE CONTRÔLE côté client : consigne, budget et relance
// d'une feature, raison d'une file, arrêt d'urgence, commande, demandes, navigation
// gardée et capture du poste, session d'un job du poste, vigie, planifications,
// administration et issues par le MCP. Chaque test confronte les corps envoyés et les
// réponses décodées à la forme du serveur.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private final class Transport: HarnessTransport, @unchecked Sendable {
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

    func body(of path: String) -> [String: Any]? {
        guard let data = calls.last(where: { $0.path == path })?.body else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

private let runJSON = #"{"id":"r1","repo":"demo","slug":"a","title":"A","request":"a","state":"running","fixes":0,"modules":[],"rev":7,"createdAt":0,"updatedAt":0}"#
private let inbox = #"{"cursor":0,"batches":[],"awaiting":[],"decisions":[],"runs":[\#(runJSON)]}"#
private let status = #"{"online":true,"observedSeconds":0,"thresholdHours":8,"autonomy":{"setting":"auto","effective":"observe"},"paused":false,"selfIdentities":[],"pending":0,"stopped":null,"browsers":[{"id":"b1","label":"Perso","online":true,"lastSeenAt":5,"firstSeenAt":1,"extensionVersion":"0.4.0","isDefault":true}],"defaultBrowser":"b1","allowedHosts":["exemple.fr"],"exfiltrationGuard":true,"navigationSource":{"allowedHosts":"setting","exfiltrationGuard":"config"}}"#

private func ok(_ json: String, status code: Int = 200) -> HarnessReply { HarnessReply(status: code, body: Data(json.utf8)) }

@MainActor private func model(_ transport: Transport) -> HarnessModel {
    HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1), sessionPollDelay: .milliseconds(5), reporter: .off
    )
}

@Suite("Tour de contrôle — client")
@MainActor
struct HarnessControlTests {
    @Test("la consigne part avec If-Match et dit si l'agent l'a reçue ; le budget envoie null pour revenir au serveur ; la relance porte sa consigne")
    func runGestures() async throws {
        let transport = Transport { call in
            switch call.path {
            case "/v1/inbox": ok(inbox)
            case "/v1/runs/r1/instructions": ok(#"{"run":\#(runJSON),"delivered":"session"}"#)
            case "/v1/runs/r1/budget": ok(#"{"run":\#(runJSON),"budget":{"cost":1.5,"budget":null,"threshold":null,"source":null}}"#)
            case "/v1/runs/r1/retry": ok(#"{"run":\#(runJSON)}"#)
            default: ok("{}", status: 404)
            }
        }
        let server = model(transport)
        #expect(await server.configure(address: "vps.example", token: "t"))
        #expect(await server.instruct(runId: "r1", text: "  garde le format  ") == .session)
        let sent = transport.calls.last { $0.path == "/v1/runs/r1/instructions" }
        #expect(sent?.headers["If-Match"] == "\"7\"")
        #expect(transport.body(of: "/v1/runs/r1/instructions")?["text"] as? String == "garde le format")
        #expect(await server.instruct(runId: "r1", text: "   ") == nil, "une consigne vide ne part pas")

        let budget = await server.setBudget(runId: "r1", budgetUsd: nil)
        #expect(budget == HarnessBudget(cost: 1.5))
        let raw = try #require(transport.calls.last { $0.path == "/v1/runs/r1/budget" }?.body)
        #expect(String(decoding: raw, as: UTF8.self) == #"{"budgetUsd":null}"#)

        #expect(await server.retry(runId: "r1", instructions: " reprends depuis les tests "))
        #expect(transport.body(of: "/v1/runs/r1/retry")?["instructions"] as? String == "reprends depuis les tests")
        #expect(await server.retry(runId: "r1"))
        #expect(transport.body(of: "/v1/runs/r1/retry")?["instructions"] == nil, "sans consigne, le corps d'avant")
    }

    @Test("un run en file porte la cause qui le retient, et le statut la file par cause")
    func queueReason() throws {
        let held = try JSONDecoder().decode(HarnessRun.self, from: Data(#"{"id":"r","repo":"d","slug":"s","title":"T","request":"r","state":"queued","fixes":0,"modules":[],"reason":"slots runner pleins 5/5","waitCause":"slots","createdAt":0,"updatedAt":0}"#.utf8))
        #expect(held.waitCause == "slots" && held.reason == "slots runner pleins 5/5")
        let status = try JSONDecoder().decode(HarnessStatus.self, from: Data(#"{"repos":[],"queue":{"held":3,"byCause":{"slots":2,"memory":1},"dominant":{"cause":"slots","text":"slots runner pleins 5/5"}}}"#.utf8))
        #expect(status.queue == HarnessQueueStatus(held: 3, byCause: ["slots": 2, "memory": 1], dominant: HarnessQueueWait(cause: "slots", text: "slots runner pleins 5/5")))
        let old = try JSONDecoder().decode(HarnessStatus.self, from: Data(#"{"repos":[]}"#.utf8))
        #expect(old.queue == nil, "un serveur antérieur n'a pas de file")
    }

    @Test("le poste : arrêt d'urgence, annulation, commande, demande, navigation gardée, navigateur par défaut et capture")
    func workstation() async throws {
        let action = #"{"seq":9,"createdAt":1,"updatedAt":2,"origin":"session","kind":"open","params":{"url":"https://exemple.fr"},"rationale":"voir","state":"queued","approved":false}"#
        let request = #"{"id":"q1","createdAt":1,"updatedAt":1,"instruction":"Ouvre les factures","state":"queued"}"#
        let transport = Transport { call in
            switch (call.method, call.path) {
            case (_, "/v1/inbox"): ok(inbox)
            case ("GET", "/v1/workstation"), ("PUT", "/v1/workstation/settings"): ok(status)
            case ("POST", "/v1/workstation/stop"): ok(#"{"status":\#(status),"cancelled":[9]}"#)
            case ("POST", "/v1/workstation/actions/9/cancel"), ("POST", "/v1/workstation/actions"): ok(#"{"action":\#(action)}"#, status: call.method == "POST" && call.path.hasSuffix("actions") ? 201 : 200)
            case ("POST", "/v1/workstation/requests"): ok(#"{"request":\#(request)}"#, status: 201)
            case ("GET", "/v1/workstation/actions/9/capture"): ok(#"{"seq":9,"at":3,"mimeType":"image/jpeg","image":"/9j/4A=="}"#)
            case ("GET", _) where call.path.hasPrefix("/v1/workstation/actions"): ok(#"{"actions":[]}"#)
            default: ok("{}", status: 404)
            }
        }
        let server = model(transport)
        #expect(await server.configure(address: "vps.example", token: "t"))
        let workstation = server.workstation
        await workstation.refresh()
        let read = try #require(workstation.status)
        #expect(read.browsers.map(\.name) == ["Perso"] && read.defaultBrowser == "b1")
        #expect(read.allowedHosts == ["exemple.fr"] && read.navigationSource?.hostsAreSet == true && read.navigationSource?.guardIsSet == false)

        #expect(await workstation.stop())
        #expect(transport.calls.contains { $0.method == "POST" && $0.path == "/v1/workstation/stop" })

        let shown = try JSONDecoder().decode(WorkstationAction.self, from: Data(action.utf8))
        #expect(await workstation.cancel(shown))

        var draft = WorkstationCommandDraft(kind: .navigate, url: "exemple.fr/a", rationale: "voir")
        #expect(!draft.isComplete, "naviguer vise un onglet")
        draft.tabId = "12"
        #expect(draft.isComplete)
        #expect(await workstation.command(draft)?.seq == 9)
        let command = try #require(transport.body(of: "/v1/workstation/actions"))
        #expect(command["kind"] as? String == "navigate")
        #expect((command["params"] as? [String: Any])?["url"] as? String == "https://exemple.fr/a")
        #expect((command["params"] as? [String: Any])?["tabId"] as? Int == 12)
        #expect(command["browserId"] == nil)

        #expect(await workstation.createRequest("  Ouvre les factures ", browserId: "b1")?.state == .queued)
        #expect(transport.body(of: "/v1/workstation/requests")?["instruction"] as? String == "Ouvre les factures")

        #expect(await workstation.setAllowedHosts(nil))
        let reset = try #require(transport.calls.last { $0.path == "/v1/workstation/settings" }?.body)
        #expect(String(decoding: reset, as: UTF8.self) == #"{"allowedHosts":null}"#)
        #expect(await workstation.setDefaultBrowser("b1"))
        #expect(transport.body(of: "/v1/workstation/settings")?["defaultBrowser"] as? String == "b1")
        #expect(WorkstationModel.hosts(from: "https://Exemple.fr/x, crm.exemple.fr:443\nexemple.fr") == ["exemple.fr", "crm.exemple.fr"])

        let capture = try #require(await workstation.capture(9))
        #expect(capture.data?.isEmpty == false)
    }

    @Test("la session d'un job du poste se relit par job et `since`, sans flux filtré")
    func workstationSession() async throws {
        let transport = Transport { call in
            if call.path == "/v1/inbox" { return ok(inbox) }
            if call.path.hasPrefix("/v1/workstation/session?job=service") {
                let entries = call.path.contains("since=") ? "[]" : #"[{"seq":4,"at":1,"step":null,"kind":"text","text":"je lis la page","tool":null,"status":null,"detail":null}]"#
                return ok(#"{"runId":null,"auditId":null,"job":"service","live":true,"cursor":0,"entries":\#(entries),"more":false}"#)
            }
            return ok("{}", status: 404)
        }
        let server = model(transport)
        #expect(await server.configure(address: "vps.example", token: "t"))
        server.followSession(workstation: .service)
        for _ in 0 ..< 200 where !transport.calls.contains(where: { $0.path.contains("since=4") }) {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(server.session?.entries.map(\.seq) == [4])
        #expect(transport.calls.contains { $0.path == "/v1/workstation/session?job=service&since=4" })
        #expect(await server.sessionDetail(.workstation(.service), seq: 4) == nil, "le poste n'a pas de détail d'entrée")
        server.stopSession()
    }

    @Test("la vigie, les planifications et l'administration décodent le serveur ; les issues passent par le MCP")
    func operations() async throws {
        let schedule = #"{"id":"s1","name":"Audit","cron":"0 8 * * 1","target":{"kind":"audit","repo":"demo","focus":""},"repo":"demo","enabled":true,"nextRunAt":10,"lastRunAt":null,"lastOutcome":null,"lastFired":null,"createdBy":null,"createdAt":1,"updatedAt":1,"rev":2}"#
        let transport = Transport { call in
            switch (call.method, call.path) {
            case (_, "/v1/inbox"): ok(inbox)
            case ("GET", "/v1/me"): ok(#"{"client":{"name":"admin","role":"admin","repos":"*","createdAt":0,"approver":false}}"#)
            case ("GET", "/v1/vigie"): ok(#"{"settings":{"mode":"shadow","maxIssuesPerDay":5,"maxLiveRuns":2,"dailyBudgetUsd":10,"repos":[]},"heartbeat":{"at":1,"version":null,"client":"vigie","silent":true,"silentSince":2},"today":{"since":0,"issues":0,"liveRuns":0,"spentUsd":0},"incidents":{"new":1}}"#)
            case ("GET", _) where call.path.hasPrefix("/v1/vigie/incidents"): ok(#"{"incidents":[{"fingerprint":"abcdef0123456789","source":"log","location":"x.ts","message":"boom","repo":null,"runId":null,"status":"reported","count":3,"firstAt":1,"lastAt":2,"triage":{"verdict":"bug","title":"Plantage","symptom":"s","evidence":[],"hypothesis":"h","files":[],"criteria":["AC-1"]},"issueNumber":12,"issueUrl":"https://github.com/o/r/issues/12","fixRunId":null,"note":null,"updatedAt":2}]}"#)
            case ("GET", "/v1/schedules"): ok(#"{"timezone":"Europe/Paris","schedules":[\#(schedule)]}"#)
            case ("PUT", "/v1/schedules/s1"): ok(#"{"schedule":\#(schedule)}"#)
            case ("GET", "/v1/clients"): ok(#"{"clients":[{"name":"admin","role":"admin","repos":"*","createdAt":0,"approver":false},{"name":"ipad","role":"viewer","repos":["demo"],"createdAt":1,"approver":false,"pilot":false}]}"#)
            case ("GET", "/v1/repos"): ok(#"{"repos":[{"name":"demo","scope":"perso","mainBranch":"main","merge":"squash","maxParallel":1}]}"#)
            case ("POST", "/v1/repos"): ok(#"{"repo":"neuf","added":false,"message":"posez la clé","deployKey":{"publicKey":"ssh-ed25519 AAAA","url":"https://github.com/o/neuf/settings/keys"},"reload":null}"#)
            case ("POST", "/v1/mcp"): ok(#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"…"}],"structuredContent":{"repo":"demo","issues":[{"number":3,"title":"Bug","url":"u","labels":["omp:fix"],"author":"paul","createdAt":"2026-11-01","run":{"id":"r1","state":"running","slug":"a"}}]}}}"#)
            default: ok("{}", status: 404)
            }
        }
        let server = model(transport)
        #expect(await server.configure(address: "vps.example", token: "t"))
        #expect(server.isAdmin)

        await server.vigie.load()
        #expect(server.vigie.isSilent)
        #expect(server.vigie.incidents.first?.issueNumber == 12 && server.vigie.incidents.first?.triage?.title == "Plantage")

        await server.schedules.refresh()
        #expect(server.schedules.timezone == "Europe/Paris" && server.schedules.schedules.first?.kind == .audit)
        let first = try #require(server.schedules.schedules.first)
        #expect(await server.schedules.setEnabled(first, false))
        #expect(transport.calls.last { $0.path == "/v1/schedules/s1" }?.headers["If-Match"] == "\"2\"")
        var draft = HarnessScheduleDraft()
        draft.name = "Nuit"
        draft.cron = "0 2 * *"
        draft.repo = "demo"
        draft.title = "T"
        draft.request = "R"
        #expect(draft.problem == .cron)
        draft.cron = "0 2 * * *"
        draft.budget = "0"
        #expect(draft.problem == .budget)
        draft.budget = "3,5"
        #expect(draft.problem == nil && draft.target.budgetUsd == 3.5)

        await server.admin.refresh()
        #expect(server.admin.clients.map(\.repos) == [nil, ["demo"]], "« * » : tous les dépôts")
        #expect(server.admin.repos.first?.name == "demo")
        #expect(server.admin.clientErrors == nil, "un serveur sans /v1/client-errors ne les montre pas")
        let declared = await server.admin.declareRepo(url: "git@github.com:o/neuf.git")
        #expect(declared?.deployKey?.publicKey == "ssh-ed25519 AAAA" && declared?.added == false)

        await server.issues.refresh(repo: "demo")
        #expect(server.issues.issues.first?.isCarried == true)
        let mcp = try #require(transport.body(of: "/v1/mcp"))
        #expect(mcp["method"] as? String == "tools/call")
        #expect((mcp["params"] as? [String: Any])?["name"] as? String == "issues_list")
    }

    @Test("un outil du MCP en échec devient l'échec de l'écran, avec son texte")
    func toolError() async {
        let transport = Transport { call in
            switch call.path {
            case "/v1/inbox": ok(inbox)
            case "/v1/mcp": ok(#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"issue fermée"}],"isError":true}}"#)
            default: ok("{}", status: 404)
            }
        }
        let server = model(transport)
        #expect(await server.configure(address: "vps.example", token: "t"))
        await server.issues.fix(HarnessIssue(number: 3, title: "Bug"))
        #expect(server.issues.failure == nil, "sans dépôt lu, rien ne part")
        await server.issues.refresh(repo: "demo")
        #expect(server.issues.failure == .rejected("issue fermée"))
    }
}
