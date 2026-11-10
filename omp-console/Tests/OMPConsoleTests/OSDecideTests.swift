// « Décider et agir dans un fil » (OS agentique) : la logique pure des écrans partagés —
// l'échéance d'une question, les gestes permis sur une tâche selon son état, son rôle et
// les capacités du serveur (dont ceux d'un échec), ce qu'une tâche attend de l'humain et
// pourquoi (des codes, jamais la phrase du serveur), la phrase d'une attente et d'un échec
// par code, les étapes du tri (lots par espace, position) et les cases d'un lot, les faits
// d'une revue, la pastille d'un espace, la saisie de « Refaire » et la commande de reprise
// d'une session locale.

import ConsoleClient
import ConsoleCore
@testable import ConsoleUI
import Foundation
import Testing

private let everything: Set<String> = ["os-loop", "os-autonomy", "proposals", "pause"]

private func run(
    _ id: String, _ state: HarnessRunState, repo: String = "demo", step: String? = nil, kind: String? = nil, verdict: HarnessVerdict? = nil,
    reason: String? = nil, failCause: String? = nil
) -> HarnessRun {
    HarnessRun(
        id: id, repo: repo, slug: id, title: id, request: "demande", state: state.rawValue, step: step, verdict: verdict, reason: reason,
        lastFailCause: failCause, createdAt: 1, updatedAt: 2, kind: kind
    )
}

/// Une tâche en file, retenue par `cause`.
private func held(
    _ cause: String?, blockedBy: [HarnessRunBlocker] = [], until: Date? = nil, notBefore: Date? = nil, reason: String? = "phrase brute du serveur"
) -> HarnessRun {
    HarnessRun(
        id: "q", repo: "boutique", slug: "q", title: "q", request: "demande", state: HarnessRunState.queued.rawValue, reason: reason,
        notBefore: notBefore, createdAt: 1, updatedAt: 2, waitCause: cause, blockedBy: blockedBy, waitUntil: until
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

    @Test("une tâche en file peut voir ses modules restreints ; un fil fini (livré, arrêté) se refait ; il ne se relance ni ne se corrige")
    func gesturesByState() {
        #expect(OSRunGestures.of(run("q", .queued), canAct: true, isAdmin: false, features: everything).modules)
        let merged = OSRunGestures.of(run("m", .merged), canAct: true, isAdmin: false, features: everything)
        #expect(merged.redo && !merged.amend && !merged.stop && !merged.autonomy && !merged.retry)
        let cancelled = OSRunGestures.of(run("c", .cancelled), canAct: true, isAdmin: false, features: everything)
        #expect(cancelled.redo && !cancelled.amend && !cancelled.retry)
        #expect(OSRunGestures.of(run("g", .merging), canAct: true, isAdmin: true, features: everything) == OSRunGestures(causes: true))
    }

    @Test("un échec se relance d'abord et se corrige ensuite ; il ne se « refait » pas ; un serveur antérieur garde la relance, un lecteur n'a rien")
    func gesturesOfFailure() {
        let failed = OSRunGestures.of(run("f", .failed, step: "impl", failCause: "provider"), canAct: true, isAdmin: false, features: everything)
        #expect(failed.retry && failed.amend && !failed.redo && !failed.stop && !failed.autonomy)
        let old = OSRunGestures.of(run("f", .failed), canAct: true, isAdmin: true, features: [])
        #expect(old.retry && !old.amend, "sans `os-loop`, corriger ne relance pas une tâche en échec : il reste « Relancer »")
        #expect(!OSRunGestures.of(run("f", .failed), canAct: false, isAdmin: false, features: everything).retry)

        // Arrêtée sur l'humain par ses échecs répétés, ou par son budget : elle se relance aussi.
        let stuck = run("a", .awaitingHuman, step: "impl", reason: "/impl a échoué deux fois de suite pour la même cause (runner) : code 1")
        let again = OSRunGestures.of(stuck, canAct: true, isAdmin: true, features: everything)
        #expect(again.retry && again.amend && again.stop && again.rule == nil)
        let budget = run("b", .awaitingHuman, step: "impl", kind: "bug", reason: "budget dépassé : 5.20 $ pour un plafond de 5.00 $")
        #expect(OSRunGestures.of(budget, canAct: true, isAdmin: true, features: everything).retry)
        #expect(OSRunGestures.of(budget, canAct: true, isAdmin: true, features: everything).rule == nil, "un budget ne se confie pas à une règle de palier")
        // Une revue ou des specs à valider ne se « relancent » pas.
        #expect(!OSRunGestures.of(run("v", .awaitingHuman, step: "review"), canAct: true, isAdmin: true, features: everything).retry)
        #expect(!OSRunGestures.of(run("r", .running), canAct: true, isAdmin: true, features: everything).retry)
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
        // L'irréversible et l'arbitrage reviennent toujours à l'humain : aucune règle ne les lève.
        let irreversible = run("i", .awaitingHuman, step: "specs", kind: "bug", reason: "specs à valider avant /impl : geste irréversible (schema)")
        #expect(OSRunGestures.of(irreversible, canAct: true, isAdmin: true, features: everything).rule == nil)
        let contest = run("c", .awaitingHuman, step: "fix", kind: "bug", reason: "plafond de corrections atteint (3) avec 2 bloquant(s)")
        #expect(OSRunGestures.of(contest, canAct: true, isAdmin: true, features: everything).rule == nil)
    }

    @Test("un serveur antérieur ne garde que corriger et arrêter, sans motif ; un lecteur n'a aucun geste")
    func oldServerAndViewer() {
        let old = OSRunGestures.of(run("r1", .awaitingHuman, step: "review", kind: "bug"), canAct: true, isAdmin: true, features: [])
        #expect(old == OSRunGestures(amend: true, stop: true))
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

    @Test("les tests d'un rapport se comptent tous critères confondus ; une suite interrompue n'est pas verte")
    func reviewFacts() {
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

    // MARK: Ce qu'attend une tâche, et pourquoi

    @Test("la sorte d'attente d'une tâche se lit au début de la phrase de protocole du serveur ; sans raison, l'étape tranche")
    func humanWait() {
        #expect(OSHumanWait.of(run("q", .escalated, reason: "2 décision(s) irréversible(s) à trancher")) == .questions)
        #expect(OSHumanWait.of(run("s", .awaitingHuman, step: "specs", reason: "specs à valider avant /impl : découpage proposé")) == .specs)
        #expect(OSHumanWait.of(run("i", .awaitingHuman, step: "specs", reason: "specs à valider avant /impl : geste irréversible (schema)")) == .irreversible)
        #expect(OSHumanWait.of(run("v", .awaitingHuman, reason: "validation humaine : diff de 412 lignes (> 300)")) == .verdict)
        #expect(OSHumanWait.of(run("a", .awaitingHuman, reason: "plafond de corrections atteint (3) avec 2 bloquant(s)")) == .arbitration)
        #expect(OSHumanWait.of(run("c", .awaitingHuman, step: "fix", reason: "le correcteur conteste les bloquants une seconde fois : rien à changer")) == .arbitration)
        #expect(OSHumanWait.of(run("b", .awaitingHuman, step: "impl", reason: "budget dépassé : 5.20 $ pour un plafond de 5.00 $")) == .budget)
        #expect(OSHumanWait.of(run("f", .awaitingHuman, step: "impl", reason: "/impl a échoué 4 fois (provider), relances épuisées : 503")) == .failure)
        #expect(OSHumanWait.of(run("f2", .awaitingHuman, step: "specs", reason: "/specs a échoué deux fois de suite pour la même cause (context) : trop long")) == .failure, "des specs en échec ne sont pas des specs à valider")
        #expect(OSHumanWait.of(run("m", .awaitingHuman, reason: "merge impossible : push refusé")) == .failure)
        // Un serveur antérieur, sans raison : l'étape dit ce qui attend.
        #expect(OSHumanWait.of(run("s0", .awaitingHuman, step: "specs")) == .specs)
        #expect(OSHumanWait.of(run("v0", .awaitingHuman, step: "review")) == .verdict)
        for state in [HarnessRunState.queued, .running, .merging, .merged, .failed, .cancelled] {
            #expect(OSHumanWait.of(run("x", state, reason: "validation humaine : risque medium")) == nil)
        }
        #expect(OSHumanWait.allCases.filter(\.isGate) == [.specs, .irreversible, .verdict, .arbitration])
        #expect(OSHumanWait.allCases.filter(\.isRetry) == [.budget, .failure])
    }

    @Test("pourquoi on vous demande : chaque raison du serveur devient un code, dit par une phrase de l'app — jamais le texte du serveur")
    func gateReasons() {
        let review = run(
            "v", .awaitingHuman,
            reason: "validation humaine : 2 bloquant(s) ; risque medium ; suite complète rouge ; diff de 412 lignes (> 300) ; 1 escalade(s) ouverte(s) ; critère(s) non prouvé(s) : AC-2 absent ; critère(s) absent(s) du verdict : AC-3 ; fichier(s) touchés non relus : a.ts ; verdict faible"
        )
        #expect(OSGateReason.of(review) == [
            .blockers(2), .risk("medium"), .testsRed, .size(lines: 412, ceiling: 300), .questions, .criteria, .unread, .weak,
        ], "dans l'ordre du serveur, un code par famille (les critères une seule fois)")
        #expect(OSGateReason.size(lines: 412, ceiling: 300).text == L10n.format("Le changement fait %@, le plafond est %lld", ConsoleFormat.count(412, L10n.text("ligne"), L10n.text("lignes")), 300))
        #expect(OSGateReason.size(lines: 412, ceiling: 300).text.contains("412") && OSGateReason.size(lines: 412, ceiling: 300).text.contains("300"))
        // L'ancienne tournure du serveur donne le même code.
        #expect(OSGateReason.of(run("o", .awaitingHuman, reason: "validation humaine : diff de 412 lignes au-delà de review.maxDiffLines (300)")) == [.size(lines: 412, ceiling: 300)])
        #expect(OSGateReason.of(run("l", .awaitingHuman, reason: "validation humaine : diff de 1 ligne")) == [.size(lines: 1, ceiling: nil)])
        #expect(OSGateReason.of(run("n", .awaitingHuman, reason: "validation humaine : suite complète non lancée sur cet arbre ; risque high")) == [.testsMissing, .risk("high")])
        #expect(OSGateReason.of(run("k", .awaitingHuman, reason: "validation humaine : autonomie « tout me demander »")) == [.ask])

        // Une revue sans raison connue garde une phrase, générique ; jamais le texte brut.
        let unknown = run("u", .awaitingHuman, reason: "validation humaine : une raison que l'app ne connaît pas")
        #expect(OSGateReason.of(unknown) == [.other])
        #expect(OSGateReason.other.text == OSDecideText.gate("code-inconnu") && !OSGateReason.other.text.contains("raison que"))
        #expect(OSGateReason.of(run("r", .awaitingHuman, reason: "validation humaine requise")) == [.other])
        #expect(OSGateReason.of(run("v0", .awaitingHuman, step: "review")) == [.other])

        // Des specs : leurs raisons de porte ; aucune quand le dépôt les fait toujours valider.
        let specs = run("s", .awaitingHuman, step: "specs", reason: "specs à valider avant /impl : découpage proposé ; modules vides ; geste irréversible (schema) ; première feature d'un projet ; autonomie « tout me demander »")
        #expect(OSGateReason.of(specs) == [.split, .noModules, .irreversible, .firstOfProject, .ask])
        #expect(OSGateReason.of(run("s1", .awaitingHuman, step: "specs", reason: "specs à valider avant /impl")).isEmpty)
        #expect(OSGateReason.of(run("s2", .awaitingHuman, step: "specs", reason: "specs à valider avant /impl (découpage, modules ou geste irréversible)")).isEmpty)

        #expect(OSGateReason.of(run("a", .awaitingHuman, reason: "plafond de corrections atteint (3) avec 2 bloquant(s)")) == [.arbitration])
        #expect(OSGateReason.of(run("b", .awaitingHuman, step: "impl", reason: "budget dépassé : 5.20 $ pour un plafond de 5.00 $")) == [.budget])
        #expect(OSGateReason.of(run("f", .awaitingHuman, step: "impl", reason: "/impl a échoué 4 fois (provider), relances épuisées : 503")).isEmpty, "un échec a sa cause en code, pas une raison de porte")
        #expect(OSGateReason.of(run("x", .running, reason: "validation humaine : risque medium")).isEmpty)

        // Chaque code a sa phrase, distincte de la générique.
        let all: [OSGateReason] = [
            .size(lines: 2, ceiling: nil), .blockers(1), .risk("medium"), .risk("high"), .risk("inconnu"), .testsRed, .testsMissing, .questions,
            .criteria, .unread, .weak, .ask, .split, .noModules, .irreversible, .firstOfProject, .arbitration, .budget,
        ]
        #expect(Set(all.map(\.text)).count == all.count)
        #expect(!all.map(\.text).contains(OSGateReason.other.text))
        #expect(OSGateReason.blockers(2).text.contains("2") && OSGateReason.risk("medium").text == OSDecideText.gate("risk_medium"))
    }

    // MARK: Phrases par code

    @Test("une tâche en attente dit pourquoi par une phrase de l'app tirée du code de sa cause, et qu'il n'y a rien à faire ; jamais la phrase du serveur")
    func waitLines() {
        let acme = HarnessSpace(id: "s1", name: "Client Acme", repos: ["boutique"], dailyBudgetUsd: 50)
        let time: (Date) -> String = { _ in "14:05" }
        let blocker = HarnessRunBlocker(runId: "r7", title: "Suite de « Filtrer les commandes »", state: "running", modules: ["src/api"])
        let other = HarnessRunBlocker(runId: "r8", title: "Trier", state: "queued")

        let one = OSWaitLine.of(held("modules", blockedBy: [blocker]), space: acme, globalPause: false, time: time)
        #expect(one == OSWaitLine(headline: OSDecideText.waitsFor("Filtrer les commandes"), hint: OSDecideText.leavesAlone), "le titre du fil attendu, nettoyé")
        #expect(!one.headline.contains("src/api"))
        #expect(OSWaitLine.of(held("modules", blockedBy: [blocker, other]), space: acme, globalPause: false, time: time).headline == OSDecideText.waitsForMany(2))
        #expect(OSWaitLine.of(held("modules"), space: nil, globalPause: false, time: time).headline == OSDecideText.waitCause("modules"))
        #expect(OSWaitLine.of(held("parent", blockedBy: [blocker]), space: nil, globalPause: false, time: time).headline == OSDecideText.waitsForParent("Filtrer les commandes"))

        let later = Date(timeIntervalSince1970: 5_000)
        #expect(OSWaitLine.of(held("backoff", until: later), space: nil, globalPause: false, time: time).headline == OSDecideText.resumesAt("14:05"))
        #expect(OSWaitLine.of(held("backoff", notBefore: later), space: nil, globalPause: false, time: time).headline == OSDecideText.resumesAt("14:05"))
        #expect(OSWaitLine.of(held("backoff"), space: nil, globalPause: false, time: time).headline == OSDecideText.waitCause("backoff"))

        // La pause : celle de tout le serveur, sinon celle de l'espace du dépôt.
        let global = OSWaitLine.of(held("paused"), space: acme, globalPause: true, time: time)
        #expect(global == OSWaitLine(headline: OSDecideText.allSuspended, hint: OSDecideText.leavesOnResume))
        #expect(OSWaitLine.of(held("paused"), space: acme, globalPause: false, time: time).headline == OSDecideText.spaceSuspended("Client Acme"))
        #expect(OSWaitLine.of(held("paused"), space: nil, globalPause: false, time: time).headline == OSDecideText.allSuspended)

        let budget = OSWaitLine.of(held("space_budget"), space: acme, globalPause: false, time: time)
        #expect(budget.headline == OSDecideText.spaceBudget("Client Acme", ceiling: 50) && budget.headline.contains("Client Acme"))
        #expect(OSWaitLine.of(held("space_budget"), space: nil, globalPause: false, time: time).headline == OSDecideText.waitCause("space_budget"))

        // Un dépôt retiré du serveur ne partira pas seul : aucune promesse.
        #expect(OSWaitLine.of(held("unknown_repo"), space: nil, globalPause: false, time: time).hint == nil)

        // Chaque code connu a sa phrase ; un code inconnu, ou aucun, donne la générique — jamais le texte brut.
        let codes = ["modules", "parent", "backoff", "inferring", "paused", "space_budget", "slots", "memory", "repo_cap", "daily_budget", "unknown_repo"]
        let generic = OSDecideText.waitCause(nil)
        #expect(Set(codes.map { OSDecideText.waitCause($0) }).count == codes.count)
        #expect(!codes.map { OSDecideText.waitCause($0) }.contains(generic))
        for cause in ["cause_de_demain", nil] {
            let line = OSWaitLine.of(held(cause), space: acme, globalPause: false, time: time)
            #expect(line == OSWaitLine(headline: generic, hint: OSDecideText.leavesAlone))
            #expect(line.headline != cause && !line.headline.contains("phrase brute"))
        }
    }

    @Test("un échec dit sa cause par une phrase de l'app tirée du code ; sans code ou d'un code inconnu, la phrase générique ; un motif d'arrêt inconnu se dit « Autre »")
    func failureAndStopPhrases() {
        let codes = ["timeout", "rate_limit", "server_error", "network", "provider", "context", "runner", "missing_output", "aborted"]
        let generic = OSDecideText.failCause(nil)
        #expect(Set(codes.map { OSDecideText.failCause($0) }).count == codes.count, "une phrase par cause")
        #expect(!codes.map { OSDecideText.failCause($0) }.contains(generic))
        #expect(OSDecideText.failCause("other") == generic && OSDecideText.failCause("cause_de_demain") == generic)
        #expect(!generic.isEmpty && generic != "cause_de_demain")

        let causes = ["off_target", "too_big", "obsolete", "duplicate", "too_costly", "other"]
        #expect(Set(causes.map(OSDecideText.cause)).count == causes.count)
        #expect(OSDecideText.cause("motif_de_demain") == OSDecideText.cause("other"))
    }

    // MARK: Espaces

    @Test("au tri, les décisions vont espace après espace et un lot ne mêle jamais deux espaces ; l'espace de l'étape est annoncé quand il y en a plusieurs")
    func triageBySpace() throws {
        let spaces = [
            HarnessSpace(id: "s1", name: "Client Acme", repos: ["boutique"], jiraProjects: ["ACME"]),
            HarnessSpace(id: "s2", name: "Perso", repos: ["demo"], poste: true),
        ]
        func review(_ id: String, _ repo: String) -> ConsoleClient.OSDecision {
            .verdict(run(id, .awaitingHuman, repo: repo, step: "review", verdict: verdict()))
        }
        let decisions: [ConsoleClient.OSDecision] = [
            review("a1", "boutique"), review("p1", "demo"), review("a2", "boutique"), review("p2", "demo"), review("x1", "ailleurs"),
            .specs(run("p3", .awaitingHuman, repo: "demo", step: "specs")), try jira("w1"), approval(9),
        ]
        let steps = OSTriage.steps(decisions, spaces: spaces)
        #expect(steps.map(\.id) == ["lot:s1/verdict", "j:w1", "s:p3", "lot:s2/verdict", "w:9", "v:x1"])
        #expect(steps[0].decisions.map(\.id) == ["v:a1", "v:a2"] && steps[3].decisions.map(\.id) == ["v:p1", "v:p2"])
        for step in steps {
            let ids = Set(step.decisions.map { OSDecisions.space(of: $0, spaces: spaces)?.id })
            #expect(ids.count == 1, "une étape n'a qu'un espace")
        }
        // Sans espace sur le serveur, les quatre revues ordinaires forment un seul lot, comme avant.
        #expect(OSTriage.steps(decisions).first { $0.id == "lot:verdict" }?.decisions.count == 5)

        let first = try #require(OSTriage.group(of: steps[0], in: steps, spaces: spaces))
        #expect(first.space?.id == "s1" && first.count == 3, "Client Acme — 3 : ses deux revues et son commentaire")
        let last = try #require(OSTriage.group(of: steps[5], in: steps, spaces: spaces))
        #expect(last.space == nil && last.count == 1)
        let alone = OSTriage.steps([review("a1", "boutique"), review("a2", "boutique")], spaces: spaces)
        #expect(OSTriage.group(of: alone[0], in: alone, spaces: spaces) == nil, "un seul espace : rien à annoncer")

        // Une tâche qui attend autre chose qu'une revue ne part jamais dans un lot.
        let stuck = ConsoleClient.OSDecision.verdict(run("f1", .awaitingHuman, repo: "demo", step: "impl", verdict: verdict(), reason: "/impl a échoué 4 fois (runner), relances épuisées : code 1"))
        #expect(!OSTriage.isBatchable(stuck) && OSTriage.isBatchable(review("a1", "boutique")))
    }

    @Test("la position du tri compte tout ce qui a été vu : « 1 sur 3 », puis « 2 sur 3 » ; un lot couvre ses décisions")
    func triagePosition() {
        #expect(OSTriage.position(total: 3, remaining: 3, size: 1) == 1...1)
        #expect(OSTriage.position(total: 3, remaining: 2, size: 1) == 2...2)
        #expect(OSTriage.position(total: 3, remaining: 1, size: 1) == 3...3)
        #expect(OSTriage.position(total: 5, remaining: 5, size: 3) == 1...3)
        #expect(OSTriage.position(total: 2, remaining: 3, size: 1) == 1...1, "un total en retard ne donne jamais une position nulle")
        #expect(OSDecideText.position(first: 1, last: 1, total: 3) == L10n.format("%lld sur %lld", 1, 3))
        #expect(OSDecideText.position(first: 1, last: 3, total: 5) == L10n.format("%lld–%lld sur %lld", 1, 3, 5))
    }

    @Test("la pastille d'un espace tire sa teinte de son identifiant : stable, dans la palette de six")
    func spaceMark() {
        #expect(OSSpacePalette.colors.count == 6)
        let ids = (0..<200).map { "espace-\($0)" }
        #expect(ids.allSatisfy { (0..<6).contains(OSSpacePalette.slot(of: $0)) })
        #expect(Set(ids.map(OSSpacePalette.slot)).count == 6, "les six teintes servent")
        #expect(OSSpacePalette.slot(of: "s1") == OSSpacePalette.slot(of: "s1") && OSSpacePalette.slot(of: "") == OSSpacePalette.slot(of: ""))
        // Une empreinte fixe (FNV-1a), pas le hachage du processus : la même à chaque lancement.
        #expect(OSSpacePalette.slot(of: "a") == Int(UInt32(0xE40C_292C) % 6))
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
