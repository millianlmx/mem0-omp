// « Décider et agir dans un fil » (OS agentique) : la logique pure des écrans partagés —
// l'échéance d'une question, les gestes permis sur une feature selon son état, son rôle et
// les capacités du serveur, les étapes du tri et les cases d'un lot, les faits d'une revue,
// la saisie de « Refaire » et la commande de reprise d'une session locale.

import ConsoleClient
import ConsoleCore
@testable import ConsoleUI
import Foundation
import Testing

private let everything: Set<String> = ["os-loop", "os-autonomy", "proposals", "pause"]

private func run(
    _ id: String, _ state: HarnessRunState, step: String? = nil, kind: String? = nil, verdict: HarnessVerdict? = nil, reason: String? = nil
) -> HarnessRun {
    HarnessRun(
        id: id, repo: "demo", slug: id, title: id, request: "demande", state: state.rawValue, step: step, verdict: verdict, reason: reason,
        createdAt: 1, updatedAt: 2, kind: kind
    )
}

private func verdict(risk: String = "low", confidence: String = "strong", blockers: [String] = [], unverified: [String] = []) -> HarnessVerdict {
    HarnessVerdict(risk: risk, summary: "Résumé", blockers: blockers, risks: [], files: ["a.swift"], unverified: unverified, confidence: confidence)
}

private func question(autoAt: Double?, autoAnswer: String? = nil, recommended: String? = "Garder le cache") -> HarnessEscalation {
    HarnessEscalation(
        id: 1, runId: "r1", category: "reversible", question: "Quel cache ?", options: ["Garder le cache", "Le retirer"],
        recommended: recommended, autoAt: autoAt, autoAnswer: autoAnswer
    )
}

private func jira(_ id: String) throws -> ConsoleClient.OSDecision {
    .jira(try JSONDecoder().decode(AtlassianWrite.self, from: Data((#"{"id":""# + id + #"","issueKey":"ACME-1","body":"Fait."}"#).utf8)))
}

private func choices(_ options: [String], recommended: String?) -> [HarnessChoice] {
    HarnessEscalation(id: 1, runId: "r1", category: "reversible", question: "Q", options: options, recommended: recommended).choices
}

private func approval(_ seq: Int) -> ConsoleClient.OSDecision {
    .approval(WorkstationAction(seq: seq, kind: "type", rationale: "r", state: "awaiting_approval"))
}

@Suite("Décider — logique des écrans")
struct OSDecideTests {
    // MARK: Échéance

    @Test("l'échéance d'une question dit l'option qui s'appliquera et le temps qui reste ; passée, elle dit que l'option s'applique")
    func deadline() {
        let now = Date(timeIntervalSince1970: 1_000)
        let soon = OSDeadline.of(question(autoAt: 1_000_000 + 12 * 60_000, autoAnswer: "Le retirer"), now: now)
        #expect(soon == OSDeadline(option: "Le retirer", seconds: 720))
        #expect(soon?.text == L10n.format("«\u{a0}%@\u{a0}» dans %@ sauf avis contraire", "Le retirer", "12 min"))
        #expect(OSDeadline.of(question(autoAt: 1_045_000), now: now)?.text.contains("45 s") == true)
        let hours = OSDecideText.deadline(option: "A", seconds: 2 * 3600 + 5 * 60)
        #expect(hours.contains("2 h 5 min"))

        let past = OSDeadline.of(question(autoAt: 999_000), now: now)
        #expect(past?.seconds == 0)
        #expect(past?.text == L10n.format("«\u{a0}%@\u{a0}» s’applique", "Garder le cache"))
    }

    @Test("une question sans échéance, ou sans option à appliquer, n'en montre aucune")
    func noDeadline() {
        let now = Date(timeIntervalSince1970: 1_000)
        #expect(OSDeadline.of(question(autoAt: nil), now: now) == nil)
        #expect(OSDeadline.of(question(autoAt: 2_000_000, recommended: nil), now: now) == nil)
        #expect(OSDeadline.of(question(autoAt: 2_000_000, autoAnswer: "", recommended: nil), now: now) == nil)
    }

    @Test("l'option recommandée passe en tête, les autres gardent l'ordre de l'agent")
    func recommendedFirst() {
        #expect(OSChoices.ordered(choices(["A", "B", "C"], recommended: "C")).map(\.option) == ["C", "A", "B"])
        #expect(OSChoices.ordered(choices(["A", "B"], recommended: nil)).map(\.option) == ["A", "B"])
    }

    // MARK: Gestes

    @Test("une feature qui travaille se corrige, s'arrête avec un motif et suit le curseur d'autonomie ; elle ne se refait pas")
    func gesturesOfRunning() {
        let gestures = OSRunGestures.of(run("r1", .running, step: "impl"), canAct: true, isAdmin: true, features: everything)
        #expect(gestures.amend && gestures.stop && gestures.causes && gestures.autonomy && gestures.always)
        #expect(!gestures.redo && !gestures.modules)
        #expect(gestures.rule == nil)
    }

    @Test("une feature en file peut voir ses modules restreints ; une feature finie se refait, et seule une feature en échec se corrige encore")
    func gesturesByState() {
        #expect(OSRunGestures.of(run("q", .queued), canAct: true, isAdmin: false, features: everything).modules)
        let merged = OSRunGestures.of(run("m", .merged), canAct: true, isAdmin: false, features: everything)
        #expect(merged.redo && !merged.amend && !merged.stop && !merged.autonomy)
        let failed = OSRunGestures.of(run("f", .failed), canAct: true, isAdmin: false, features: everything)
        #expect(failed.redo && failed.amend && !failed.stop)
        let cancelled = OSRunGestures.of(run("c", .cancelled), canAct: true, isAdmin: false, features: everything)
        #expect(cancelled.redo && !cancelled.amend)
        #expect(OSRunGestures.of(run("g", .merging), canAct: true, isAdmin: true, features: everything) == OSRunGestures(causes: true))
    }

    @Test("« Toujours valider seul » n'est offert qu'à un administrateur, sur une porte en attente d'une feature typée")
    func alwaysRule() {
        let specs = run("s", .awaitingHuman, step: "specs", kind: "bug")
        #expect(OSRunGestures.of(specs, canAct: true, isAdmin: true, features: everything).rule == OSAlwaysRule(repo: "demo", kind: .bug, gate: .specs))
        let review = run("v", .awaitingHuman, step: "review", kind: "docs")
        #expect(OSRunGestures.of(review, canAct: true, isAdmin: true, features: everything).rule == OSAlwaysRule(repo: "demo", kind: .docs, gate: .review))
        #expect(OSRunGestures.of(specs, canAct: true, isAdmin: false, features: everything).rule == nil)
        #expect(OSRunGestures.of(run("u", .awaitingHuman, step: "specs"), canAct: true, isAdmin: true, features: everything).rule == nil)
        #expect(OSRunGestures.of(run("x", .awaitingHuman, step: "specs", kind: "inconnu"), canAct: true, isAdmin: true, features: everything).rule == nil)
        #expect(OSRunGestures.of(run("r", .running, kind: "bug"), canAct: true, isAdmin: true, features: everything).rule == nil)
        #expect(OSRunGestures.of(specs, canAct: true, isAdmin: true, features: ["os-loop"]).rule == nil)
    }

    @Test("un serveur antérieur ne garde que corriger et arrêter, sans motif ; un lecteur n'a aucun geste")
    func oldServerAndViewer() {
        let old = OSRunGestures.of(run("r1", .awaitingHuman, step: "review", kind: "bug"), canAct: true, isAdmin: true, features: [])
        #expect(old == OSRunGestures(amend: true, stop: true))
        #expect(!OSRunGestures.of(run("f", .failed), canAct: true, isAdmin: true, features: []).amend)
        #expect(!OSRunGestures.of(run("m", .merged), canAct: true, isAdmin: true, features: ["os-loop", "os-autonomy"]).redo)
        #expect(OSRunGestures.of(run("r1", .running), canAct: false, isAdmin: false, features: everything) == OSRunGestures())
    }

    // MARK: Tri

    @Test("les commentaires Jira, les envois du poste et les revues à risque faible sans réserve arrivent en lot ; le reste une à une")
    func triageLots() throws {
        let plain = run("v1", .awaitingHuman, step: "review", verdict: verdict())
        let plainToo = run("v2", .awaitingHuman, step: "review", verdict: verdict())
        let risky = run("v3", .awaitingHuman, step: "review", verdict: verdict(risk: "medium"))
        let weak = run("v4", .awaitingHuman, step: "review", verdict: verdict(confidence: "weak"))
        let blocked = run("v5", .awaitingHuman, step: "review", verdict: verdict(blockers: ["une faille"]))
        let specs = run("s1", .awaitingHuman, step: "specs")
        let decisions: [ConsoleClient.OSDecision] = [
            .verdict(risky), .verdict(plain), .specs(specs), .verdict(weak), .verdict(plainToo), .verdict(blocked),
            approval(9), approval(10), try jira("w1"), try jira("w2"), try jira("w3"),
        ]
        let steps = OSTriage.steps(decisions)
        #expect(steps.map(\.id) == ["s:s1", "lot:verdict", "v:v3", "v:v4", "v:v5", "lot:approval", "lot:jira"])
        #expect(steps[1].decisions.map(\.id) == ["v:v1", "v:v2"])
        #expect(steps[6].decisions.count == 3)
        #expect(OSTriage.count(steps) == decisions.count)
    }

    @Test("une seule décision regroupable reste une carte ; une décision passée ne revient pas, et un lot réduit à une décision redevient une carte")
    func triageSingleAndSkipped() throws {
        let alone = OSTriage.steps([try jira("w1"), approval(9)])
        #expect(alone.map(\.id) == ["w:9", "j:w1"])

        let decisions = [try jira("w1"), try jira("w2"), try jira("w3")]
        #expect(OSTriage.steps(decisions, skipped: ["j:w2"]).first?.decisions.map(\.id) == ["j:w1", "j:w3"])
        #expect(OSTriage.steps(decisions, skipped: ["j:w2", "j:w3"]).map(\.id) == ["j:w1"])
        #expect(OSTriage.steps(decisions, skipped: ["j:w1", "j:w2", "j:w3"]).isEmpty)
    }

    @Test("un lot arrive tout coché ; le geste ne tranche que les cases restées cochées, dans l'ordre du lot")
    func lotChecks() throws {
        let items = [try jira("w1"), try jira("w2"), try jira("w3")]
        let lot = OSDecisionLot(kind: .jira, items: items)
        var checks = OSLotChecks()
        #expect(checks.checked(in: lot).map(\.id) == ["j:w1", "j:w2", "j:w3"])

        checks.toggle(items[1])
        #expect(!checks.isChecked(items[1]))
        #expect(checks.checked(in: lot).map(\.id) == ["j:w1", "j:w3"])

        checks.toggle(items[1])
        checks.toggle(items[0])
        checks.toggle(items[2])
        #expect(checks.checked(in: lot).map(\.id) == ["j:w2"])
    }

    // MARK: Revue

    @Test("l'ampleur d'une revue se lit dans la raison du serveur ; les tests d'un rapport se comptent tous critères confondus")
    func reviewFacts() {
        #expect(OSReviewFacts.diffLines(reason: "validation humaine : diff de 412 lignes au-delà de review.maxDiffLines (300)") == 412)
        #expect(OSReviewFacts.diffLines(reason: "validation humaine : diff de 1 ligne") == 1)
        #expect(OSReviewFacts.diffLines(reason: "validation humaine : risque moyen") == nil)
        #expect(OSReviewFacts.diffLines(reason: nil) == nil)

        let green = HarnessTestReport(
            step: "impl", criteria: [HarnessTestCriterion(id: "AC-1", ac: "AC-1", tests: 3, passed: 3), HarnessTestCriterion(id: "AC-2", ac: "AC-2", tests: 2, passed: 2)],
            other: HarnessTestCount(tests: 4, passed: 4)
        )
        #expect(OSTestTally(green) == OSTestTally(passed: 9, failed: 0))
        #expect(OSTestTally.isGreen(green))
        var red = green
        red.criteria[1].failed = 1
        red.criteria[1].passed = 1
        #expect(OSTestTally(red) == OSTestTally(passed: 8, failed: 1))
        #expect(!OSTestTally.isGreen(red))
        var interrupted = green
        interrupted.outcome = "timeout"
        #expect(!OSTestTally.isGreen(interrupted))
    }

    // MARK: Refaire

    @Test("« Refaire » reprend la demande et ses options ; ailleurs, les modules du dépôt d'origine ne suivent pas")
    func redoDrafts() {
        let template = HarnessRunTemplate(
            repo: "demo", title: "Exporter en CSV", request: "Exporter les commandes.", kind: "feature", labels: ["export", "csv"],
            modules: ["src/api", "docs"], lane: "full", budgetUsd: 12.5, autonomy: .deliver
        )
        let same = OSRedo.launchDraft(template, repo: "demo")
        #expect(same.options == template.options)
        #expect(same.modules == "src/api, docs" && same.budget == "12.5" && same.lane == .full && same.autonomy == .deliver)

        let elsewhere = OSRedo.launchDraft(template, repo: "acme-web")
        #expect(elsewhere.modules.isEmpty)
        #expect(elsewhere.options?.kind == .feature && elsewhere.options?.labels == ["export", "csv"])
        #expect(OSRedo.amount(12) == "12")
    }

    @Test("« En faire une routine » prépare une planification de feature à laquelle il ne manque que son horaire")
    func routineDraft() {
        let template = HarnessRunTemplate(repo: "demo", title: "Exporter en CSV", request: "Exporter les commandes.", budgetUsd: 3)
        var draft = OSRedo.scheduleDraft(template)
        #expect(draft.problem == .cron)
        draft.cron = "0 7 * * 1"
        #expect(draft.problem == nil)
        #expect(draft.target == HarnessScheduleTarget(kind: "run", repo: "demo", title: "Exporter en CSV", request: "Exporter les commandes.", budgetUsd: 3))
    }

    // MARK: Session locale

    @Test("la commande de reprise cite la branche ; un nom inhabituel est mis entre apostrophes, un nom dangereux n'en donne aucune")
    func resumeCommand() {
        #expect(OSLocalSessionCommand.resume(branch: "feat/inscription") == "git fetch && git switch feat/inscription")
        #expect(OSLocalSessionCommand.resume(branch: "feat/a b;rm -rf ~") == "git fetch && git switch 'feat/a b;rm -rf ~'")
        #expect(OSLocalSessionCommand.resume(branch: "it's") == #"git fetch && git switch 'it'\''s'"#)
        #expect(OSLocalSessionCommand.resume(branch: "$(reboot)") == "git fetch && git switch '$(reboot)'")
        #expect(OSLocalSessionCommand.resume(branch: nil) == nil)
        #expect(OSLocalSessionCommand.resume(branch: "  ") == nil)
        #expect(OSLocalSessionCommand.resume(branch: "--help") == nil)
        #expect(OSLocalSessionCommand.resume(branch: "main\nrm -rf ~") == nil)
    }
}
