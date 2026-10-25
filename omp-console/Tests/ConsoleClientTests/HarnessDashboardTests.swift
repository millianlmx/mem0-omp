// Le tableau de bord de l'Accueil : ses KPIs et ses séries se lisent de la boîte et
// des statistiques, et un serveur sans séries donne des blocs vides, jamais un échec.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func run(_ id: String, repo: String, state: String, step: String? = nil, updatedAt: Double = 0) -> HarnessRun {
    HarnessRun(id: id, repo: repo, slug: id, title: id, request: id, state: state, step: step, updatedAt: updatedAt)
}

@Suite("Serveur de pipelines — tableau de bord de l'Accueil")
struct HarnessDashboardTests {
    @Test("ce qui attend se compte par projet et par sorte ; la plus vieille attente vient de la feature bloquée la plus ancienne")
    func waiting() {
        let now = Date(timeIntervalSince1970: 10_000)
        let escalated = run("r1", repo: "site", state: "escalated", step: "impl", updatedAt: 4_000_000)
        let specs = run("r2", repo: "facturation", state: "awaiting_human", step: "specs", updatedAt: 9_000_000)
        let verdict = run("r3", repo: "facturation", state: "awaiting_human", step: "review", updatedAt: 9_500_000)
        let item = HarnessEscalation(id: 1, runId: "r1", category: "schema", question: "Q ?", options: ["a", "b"])
        let inbox = HarnessInbox(
            batches: [HarnessEscalationBatch(run: escalated, items: [item, item])],
            awaiting: [specs, verdict],
            decisions: [HarnessDecision(id: 1, runId: "r4", seq: 1, question: "Q ?", options: ["a", "b"], chosen: "a", rationale: "r")],
            runs: [escalated, specs, verdict, run("r4", repo: "site", state: "running", step: "impl"), run("r5", repo: "site", state: "queued")]
        )
        let board = HarnessDashboard(inbox: inbox, stats: nil, now: now)
        #expect(board.pending == 4, "deux questions, des specs, un verdict")
        #expect(board.toReview == 1)
        #expect(board.active == 2)
        #expect(board.oldestWaitSec == 6_000, "l'escalade, écrite à 4 000 s, attend depuis 6 000 s")
        #expect(board.waiting.map(\.id) == ["facturation/specs", "facturation/verdicts", "site/questions", "site/decisions"])
        #expect(board.waiting.first { $0.kind == .questions }?.count == 2)
        #expect(board.waitingByRepo == [
            HarnessDashboard.Share(label: "facturation", value: 2),
            HarnessDashboard.Share(label: "site", value: 3),
        ])
        #expect(board.activeBySteps.map(\.label) == [PipelineServerText.state("queued"), PipelineServerText.stepImpl])
        #expect(!board.hasStats && board.days.isEmpty && board.mergeRate == nil, "sans statistiques, rien n'est inventé")
    }

    @Test("les séries du serveur donnent le débit et le coût jour par jour, le coût par projet et la santé par étape")
    func series() throws {
        let stats = try JSONDecoder().decode(HarnessStats.self, from: Data(#"""
        {"runs":{"total":3,"byState":{"merged":2,"failed":1},"mergedLast7Days":2,"mergeRate":0.67,"medianLeadSec":3600,"fixesPerMerged":0.5,
                 "byDay":[{"day":"2026-10-24","created":1,"merged":0,"failed":1},{"day":"2026-10-25","created":0,"merged":2,"failed":0}],
                 "byRepo":{"site":{"total":3,"active":0,"merged":2,"failed":1,"mergedLast7Days":2}}},
         "steps":{"impl":{"count":4,"failed":1,"medianSec":900},"review":{"count":2,"failed":0,"medianSec":60}},
         "tests":{"total":0,"cached":0,"byOutcome":{},"retried":0,"flaky":[]},
         "decisions":{},"escalations":{},"audits":{},
         "scheduler":{"runner":{"used":2,"capacity":4},"heavy":{"used":0,"capacity":1},"memAvailableMiB":null},
         "usage":{"total":{"messages":2,"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":3},
                  "last7Days":{"messages":2,"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":3},
                  "byDay":[{"day":"2026-10-25","messages":2,"input":1,"output":1,"cost":3}],
                  "byRepo":{},
                  "byRepoLast7Days":{"site":{"messages":1,"input":1,"output":0,"cacheRead":0,"cacheWrite":0,"cost":1},
                                     "facturation":{"messages":1,"input":0,"output":1,"cacheRead":0,"cacheWrite":0,"cost":2},
                                     "vide":{"messages":0,"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0}}}}
        """#.utf8))
        let board = HarnessDashboard(inbox: HarnessInbox(), stats: stats)
        #expect(board.hasStats && board.hasThroughput && board.hasCost)
        #expect(board.days.map(\.cost) == [0, 3], "un jour sans dépense vaut zéro")
        #expect(board.days.map(\.merged) == [0, 2])
        #expect(board.days.first?.date == Date(timeIntervalSince1970: 1_792_800_000), "minuit UTC du 24 octobre 2026")
        #expect(board.costByRepo.map(\.label) == ["facturation", "site"], "du plus cher au moins cher, sans les projets à zéro")
        #expect(board.stepHealth.map(\.step) == [PipelineServerText.stepImpl, PipelineServerText.stepReview])
        #expect(board.stepHealth.first?.failureRate == 0.25)
        #expect(board.runners == HarnessStats.Slots(used: 2, capacity: 4))
        #expect(board.flaky == 0)
        #expect(board.mergedLast7Days == 2 && board.costLast7Days == 3)
        #expect(stats.runs.byRepo?["site"]?.mergedLast7Days == 2)
    }

    @Test("un serveur plus ancien, sans séries, se lit : blocs vides")
    func olderServer() throws {
        let stats = try JSONDecoder().decode(HarnessStats.self, from: Data(#"""
        {"runs":{"total":0,"byState":{},"mergedLast7Days":0,"mergeRate":null,"medianLeadSec":null,"fixesPerMerged":null},
         "steps":{},"tests":{"total":0,"cached":0,"byOutcome":{},"retried":0},"decisions":{},"escalations":{},"audits":{},
         "scheduler":{"runner":{"used":0,"capacity":1},"heavy":{"used":0,"capacity":1},"memAvailableMiB":null}}
        """#.utf8))
        #expect(stats.runs.byDay == nil && stats.runs.byRepo == nil)
        let board = HarnessDashboard(inbox: HarnessInbox(), stats: stats)
        #expect(board.days.isEmpty && !board.hasThroughput && !board.hasCost)
        #expect(board.costByRepo.isEmpty && board.flaky == nil && board.costLast7Days == nil)
        #expect(HarnessDashboard.date(of: "pas-un-jour") == nil)
    }
}
