// Le monitoring du serveur de pipelines vu du client : alertes et coûts dans la boîte,
// consommation et budget d'une feature, frise, fichiers touchés et leurs différences,
// sortie des tests en direct, santé du serveur, statistiques des modèles — décodés tels
// que le serveur les écrit — et le direct d'un audit, page par page, sur la doublure
// de transport.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private let emptyInbox = #"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":3}"#

@MainActor
private func monitoringModel(_ transport: ScriptedHarnessTransport) -> HarnessModel {
    HarnessModel(transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(), retryDelay: .seconds(3600), refreshDelay: .milliseconds(1))
}

@Suite("Serveur de pipelines — monitoring")
@MainActor
struct HarnessMonitoringTests {
    @Test("la boîte porte les alertes et le coût de chaque feature ; un serveur plus ancien n'en écrit rien")
    func inboxAlertsAndCosts() throws {
        let json = #"""
        {"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":1,
         "alerts":[{"runId":"r1","kind":"stalled","since":1700000000000,"detail":{"minutes":20,"step":"impl","tool":null}},
                   {"runId":"r1","kind":"budget_exceeded","since":1,"detail":{"cost":1.5,"budget":1,"threshold":1,"paused":true}},
                   {"runId":"r2","kind":"nouvelle_sorte","since":2,"detail":{}}],
         "costs":{"r1":1.5}}
        """#
        let inbox = try JSONDecoder().decode(HarnessInbox.self, from: Data(json.utf8))
        #expect(inbox.alerts(of: "r1").count == 2)
        #expect(inbox.costs["r1"] == 1.5)
        #expect(inbox.alerts[0].sort == .stalled)
        #expect(inbox.alerts[0].line == MonitoringText.alertStalled(minutes: 20, tool: nil))
        #expect(inbox.alerts[1].line == MonitoringText.alertBudget(cost: 1.5, threshold: 1, paused: true))
        #expect(inbox.alerts[2].sort == nil)
        #expect(inbox.alerts[2].line == MonitoringText.alertUnknown)
        let old = try JSONDecoder().decode(HarnessInbox.self, from: Data(emptyInbox.utf8))
        #expect(old.alerts.isEmpty && old.costs.isEmpty)
    }

    @Test("la vue d'une feature porte sa consommation, son budget et ses alertes ; les statistiques, la consommation, les modèles et les tests instables")
    func runViewAndStats() throws {
        let view = try JSONDecoder().decode(HarnessRunView.self, from: Data(#"""
        {"run":{"id":"r1","repo":"demo","slug":"a","title":"A","request":"a","state":"running","step":"impl","fixes":0,"modules":[],"createdAt":1,"updatedAt":2},
         "artifacts":[],
         "usage":{"total":{"messages":3,"input":3000,"output":600,"cacheRead":150,"cacheWrite":30,"cost":1.75},
                  "byStep":{"impl":{"messages":2,"input":2000,"output":400,"cacheRead":100,"cacheWrite":20,"cost":0.75}},"byModel":{}},
         "budget":{"cost":1.75,"budget":2,"threshold":2},"alerts":[]}
        """#.utf8))
        #expect(view.usage?.total.tokens == 3780)
        #expect(view.usage?.byStep["impl"]?.cost == 0.75)
        #expect(view.budget?.ratio == 0.875)
        let stats = try JSONDecoder().decode(HarnessStats.self, from: Data(#"""
        {"runs":{"total":1,"byState":{},"mergedLast7Days":0},"steps":{},"tests":{"total":0,"cached":0,"byOutcome":{},"retried":0,
          "flaky":[{"repo":"demo","scope":"full","command":"npm test","count":2,"lastAt":1700000000000}]},
         "decisions":{},"escalations":{},"audits":{},"scheduler":{"runner":{"used":0,"capacity":5},"heavy":{"used":0,"capacity":2}},
         "usage":{"total":{"messages":1,"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":0.5},
                  "last7Days":{"messages":1,"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":0.5},
                  "byDay":[{"day":"2026-10-24","messages":1,"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":0.5}],"byRepo":{}},
         "models":[{"model":"a/rapide","steps":3,"failed":0,"medianSec":240,"impls":2,"correctedRate":0.5,"mergedRuns":1,"cost":0.4,"input":10,"output":5,"messages":2}]}
        """#.utf8))
        #expect(stats.usage?.byDay.first?.cost == 0.5)
        #expect(stats.models?.first?.stepsLine == MonitoringText.modelSteps(steps: 3, failed: 0, median: PipelineServerText.duration(240)))
        #expect(stats.tests.flaky?.first?.count == 2)
        // Un serveur plus ancien : ni consommation, ni modèles, ni tests instables.
        let old = try JSONDecoder().decode(HarnessStats.self, from: Data(#"""
        {"runs":{"total":0,"byState":{},"mergedLast7Days":0},"steps":{},"tests":{"total":0,"cached":0,"byOutcome":{},"retried":0},
         "decisions":{},"escalations":{},"audits":{},"scheduler":{"runner":{"used":0,"capacity":5},"heavy":{"used":0,"capacity":2}}}
        """#.utf8))
        #expect(old.usage == nil && old.models == nil && old.tests.flaky == nil)
    }

    @Test("la frise se décode et mesure une étape en cours jusqu'à l'heure du serveur")
    func timeline() throws {
        let timeline = try JSONDecoder().decode(HarnessTimeline.self, from: Data(#"""
        {"runId":"r1","title":"A","state":"running","live":true,"createdAt":0,"updatedAt":0,"now":600000,
         "steps":[{"id":1,"kind":"impl","attempt":0,"status":"done","model":"a/b","startedAt":0,"endedAt":240000},
                  {"id":2,"kind":"review","attempt":0,"status":"running","model":null,"startedAt":300000,"endedAt":null}],
         "tests":[{"at":1,"scope":"full","outcome":"pass","cached":false,"attempts":1}],
         "decisions":[{"at":2,"seq":1,"question":"Séparateur ?","chosen":",","status":"auto"}],
         "events":[{"at":3,"type":"merged","step":null,"summary":"abcdef123456","by":null}],
         "cost":1.2,"costByStep":{"impl":1.2}}
        """#.utf8))
        #expect(timeline.duration(of: timeline.steps[0]) == 240)
        #expect(timeline.duration(of: timeline.steps[1]) == 300)
        #expect(timeline.steps[1].phase == .running)
        #expect(timeline.costLine(for: timeline.steps[0]) == MonitoringText.cost(1.2))
        #expect(timeline.costLine(for: timeline.steps[1]).isEmpty)
        #expect(timeline.chartLabel(position: 2, step: timeline.steps[1]) == MonitoringText.chartStep(position: 2, label: PipelineServerText.stepReview))
    }

    @Test("les différences d'un fichier se lisent ligne à ligne, sans les en-têtes de git")
    func diffLines() {
        let diff = HarnessFileDiff(runId: "r1", path: "a.ts", diff: "diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n contexte\n-avant\n+après\n", truncated: false)
        #expect(diff.lines.map(\.kind) == [.hunk, .context, .removed, .added, .context])
        #expect(diff.lines.map(\.text).dropLast() == ["@@ -1,2 +1,2 @@", " contexte", "-avant", "+après"])
        let binary = HarnessFileChange(path: "logo.png", status: "A")
        #expect(binary.isBinary)
        #expect(binary.line == MonitoringText.fileLine(status: "A", added: nil, removed: nil))
    }

    @Test("la sortie d'un job de tests s'ajoute à son job, qui se clôt sur done ; les jobs restent bornés")
    func testOutput() {
        var jobs: [HarnessTestJob] = []
        jobs.apply(HarnessTestOutput(jobId: 1, scope: "full", attempt: 1, chunk: "", done: false, outcome: nil), at: 10)
        jobs.apply(HarnessTestOutput(jobId: 1, scope: "full", attempt: 1, chunk: "ok 1\n", done: false, outcome: nil), at: 20)
        #expect(jobs.first?.isRunning == true)
        jobs.apply(HarnessTestOutput(jobId: 1, scope: "full", attempt: 1, chunk: "fin\n", done: true, outcome: "pass"), at: 30)
        #expect(jobs.first?.output == "ok 1\nfin\n")
        #expect(jobs.first?.passed == true)
        #expect(jobs.first?.endedAt == 30)
        for id in 2...12 { jobs.apply(HarnessTestOutput(jobId: id, scope: "touched", attempt: 1, chunk: "x", done: true, outcome: "fail")) }
        #expect(jobs.count == 8)
        #expect(jobs.first?.id == 5)
    }

    @Test("le direct d'un audit lit son tampon et suit le flux filtré par audit ; une page plus ancienne passe devant")
    func auditSessionAndEarlierPages() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            switch call.path {
            case "/v1/audits/a1/session":
                reply(#"{"runId":null,"auditId":"a1","live":true,"cursor":3,"more":true,"entries":[{"seq":5,"at":1,"step":"audit","kind":"text","text":"cinq","tool":null,"status":null,"detail":null}]}"#)
            case "/v1/audits/a1/session?before=5&limit=200":
                reply(#"{"runId":null,"auditId":"a1","live":true,"cursor":3,"more":false,"entries":[{"seq":3,"at":1,"step":"audit","kind":"text","text":"trois","tool":null,"status":null,"detail":null},{"seq":4,"at":1,"step":"audit","kind":"text","text":"quatre","tool":null,"status":null,"detail":null}]}"#)
            default:
                reply(emptyInbox)
            }
        }
        let model = monitoringModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        model.followSession(auditId: "a1")
        #expect(await eventually { model.session?.entries.count == 1 })
        #expect(transport.calls.contains { $0.path == "/v1/events?audit=a1&live=1&after=3" })
        #expect(!transport.calls.contains { $0.path.contains("tests/live") }, "un audit n'a pas de tests en direct")
        #expect(model.session?.hasEarlier == true)
        await model.loadEarlierSession()
        #expect(model.session?.entries.map(\.text) == ["trois", "quatre", "cinq"])
        #expect(model.session?.hasEarlier == false)
        model.stopSession()
    }

    @Test("le direct d'une feature lit aussi la sortie de ses tests et l'applique au fil du flux")
    func runSessionTests() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            switch call.path {
            case "/v1/runs/r1/session":
                reply(#"{"runId":"r1","auditId":null,"live":true,"cursor":3,"more":false,"entries":[]}"#)
            case "/v1/runs/r1/tests/live":
                reply(#"{"runId":"r1","cursor":3,"jobs":[{"id":7,"scope":"full","attempt":1,"startedAt":1,"endedAt":null,"outcome":null,"output":"ok 1\n"}]}"#)
            default:
                reply(emptyInbox)
            }
        }
        transport.stream([
            Data("event: test_output\ndata: {\"id\":0,\"at\":1,\"runId\":\"r1\",\"repo\":\"demo\",\"type\":\"test_output\",\"payload\":{\"jobId\":7,\"scope\":\"full\",\"attempt\":1,\"chunk\":\"ok 2\\n\",\"done\":true,\"outcome\":\"pass\"},\"ephemeral\":true}\n\n".utf8),
        ])
        let model = monitoringModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        model.followSession(runId: "r1")
        #expect(await eventually { model.session?.tests.first?.outcome == "pass" })
        #expect(model.session?.tests.first?.output == "ok 1\nok 2\n")
        model.stopSession()
    }

    @Test("la santé, la frise, les fichiers et les différences se lisent par leurs routes ; un jeton d'activité s'enregistre")
    func readsMonitoringRoutes() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/metrics"):
                reply(#"{"sampleSec":15,"samples":[{"at":1700000000000,"runner":{"used":2,"capacity":5,"waiting":1},"heavy":{"used":0,"capacity":2,"waiting":0},"memAvailableMiB":8000,"liveRuns":2,"queuedRuns":1,"admissionRefused":0,"rateLimited":1,"failovers":0,"providerErrors":0,"providers":{}}]}"#)
            case ("GET", "/v1/runs/r1/changes"):
                reply(#"{"runId":"r1","source":"worktree","files":[{"path":"src/a.ts","status":"M","added":3,"removed":1}],"added":3,"removed":1}"#)
            case ("GET", "/v1/runs/r1/diff?path=src%2Fa%2Ets"):
                reply(#"{"runId":"r1","path":"src/a.ts","diff":"@@ -1 +1 @@\n-a\n+b\n","truncated":false}"#)
            case ("POST", "/v1/push/activities"):
                HarnessReply(status: 201, body: Data(#"{"registered":true,"pushes":true}"#.utf8))
            default:
                reply(emptyInbox)
            }
        }
        let model = monitoringModel(transport)
        #expect(await model.configure(address: "vps.example", token: "t"))
        await model.refreshMetrics()
        #expect(model.metrics?.samples.first?.runner.waiting == 1)
        #expect(await model.changes(runId: "r1")?.touched.first?.line == MonitoringText.fileLine(status: "M", added: 3, removed: 1))
        #expect(await model.fileDiff(runId: "r1", path: "src/a.ts")?.lines.map(\.kind) == [.hunk, .removed, .added, .context])
        #expect(await model.timeline(runId: "r1") == nil, "une route qui ne répond pas laisse la frise vide, sans échec global")
        #expect(model.failure == nil)
        #expect(await model.registerActivity(runId: "r1", token: "abcd"))
        let body = transport.calls.last { $0.path == "/v1/push/activities" }?.body ?? Data()
        #expect(String(decoding: body, as: UTF8.self).contains(#""token":"abcd""#))
    }

    @Test("le vocabulaire du monitoring compte en français : dollars, jetons groupés, lignes de fichier")
    func vocabulary() {
        #expect(MonitoringText.cost(0.4) == "0,40\u{00A0}$")
        #expect(MonitoringText.cost(12.345) == "12,35\u{00A0}$")
        #expect(MonitoringText.grouped(1234567) == "1\u{00A0}234\u{00A0}567")
        #expect(MonitoringText.tokens(1) == "1 jeton")
        #expect(MonitoringText.lines(added: 12, removed: 3) == "+12 −3")
        #expect(MonitoringText.event(MonitoringCodes.merged) == "Fusionnée")
        #expect(MonitoringText.event("inconnu") == "Événement")
    }
}
