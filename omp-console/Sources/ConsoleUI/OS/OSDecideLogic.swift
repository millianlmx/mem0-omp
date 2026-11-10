// L'« OS agentique » : la logique PURE de « Décider » — l'échéance d'une question, ce
// qu'une tâche attend de l'humain et pourquoi (les CODES lus dans la phrase de protocole
// du serveur, jamais son texte), la phrase d'une tâche en attente, les faits d'une revue,
// les étapes du tri (une décision, ou un lot de décisions de même sorte ET de même espace
// à trancher d'un geste), sa position et les cases d'un lot. Aucune vue, aucun réseau :
// les écrans de ce dossier la lisent.

import ConsoleClient
import ConsoleCore
import Foundation

// MARK: - Échéance d'une question

/// L'option qui s'appliquera seule à une question, et dans combien de temps.
struct OSDeadline: Equatable {
    var option: String
    /// Ce qu'il reste, en secondes ; 0 une fois l'échéance passée.
    var seconds: Double

    /// `nil` : la question n'expire pas (irréversible, sans recommandation, feature en « tout
    /// demander », serveur antérieur).
    static func of(_ item: HarnessEscalation, now: Date) -> OSDeadline? {
        guard let date = item.autoDate, let option = item.autoAnswer ?? item.recommended, !option.isEmpty else { return nil }
        return OSDeadline(option: option, seconds: max(0, date.timeIntervalSince(now)))
    }

    /// « « Garder le cache » dans 12 min sauf avis contraire »
    var text: String { OSDecideText.deadline(option: option, seconds: seconds) }
}

// MARK: - Options d'une question

enum OSChoices {
    /// Les options d'une question, la recommandée en tête ; les autres gardent l'ordre de l'agent.
    static func ordered(_ choices: [HarnessChoice]) -> [HarnessChoice] {
        choices.filter(\.isPreferred) + choices.filter { !$0.isPreferred }
    }
}

// MARK: - Faits d'une revue

/// Le décompte des tests d'un rapport, tous critères confondus.
struct OSTestTally: Equatable {
    var passed: Int
    var failed: Int

    init(passed: Int, failed: Int) {
        self.passed = passed
        self.failed = failed
    }

    init(_ report: HarnessTestReport) {
        passed = report.criteria.reduce(report.other.passed) { $0 + $1.passed }
        failed = report.criteria.reduce(report.other.failed) { $0 + $1.failed }
    }

    /// Rien n'a échoué, et la suite n'a pas été interrompue.
    static func isGreen(_ report: HarnessTestReport) -> Bool {
        report.outcome == "pass" && OSTestTally(report).failed == 0
    }
}

enum OSReviewFacts {
    /// Une revue qui se valide en lot : risque faible, verdict ferme, rien de bloquant ni d'invérifié.
    static func isPlain(_ verdict: HarnessVerdict?) -> Bool {
        guard let verdict else { return false }
        return verdict.isLowRisk && !verdict.isWeak && verdict.blockers.isEmpty
    }
}

// MARK: - Ce qu'une tâche attend de l'humain

/// La sorte d'attente d'une tâche arrêtée sur l'humain. Le serveur l'écrit au DÉBUT de la
/// raison de la tâche (`WAIT_REASON`, machine.ts) : ces débuts sont des phrases du
/// protocole, lues ici pour en tirer un code — jamais affichées.
enum OSHumanWait: String, Equatable, CaseIterable {
    case questions, specs, irreversible, verdict, arbitration, budget, failure

    private static let specsPrefix = "specs à valider"
    private static let irreversibleMark = "geste irréversible ("
    private static let verdictPrefix = "validation humaine"
    private static let arbitrationPrefixes = ["plafond de corrections atteint", "le correcteur conteste les bloquants une seconde fois"]
    private static let budgetPrefix = "budget dépassé"

    /// `nil` : la tâche n'attend pas l'humain. Sans raison (serveur antérieur), l'étape
    /// tranche : des specs à valider, sinon une revue.
    static func of(_ run: HarnessRun) -> OSHumanWait? {
        if run.phase == .escalated { return .questions }
        guard run.phase == .awaitingHuman else { return nil }
        let reason = run.reason ?? ""
        if reason.isEmpty { return run.step == "specs" ? .specs : .verdict }
        if reason.hasPrefix(budgetPrefix) { return .budget }
        if run.step == "specs", reason.hasPrefix(specsPrefix) { return reason.contains(irreversibleMark) ? .irreversible : .specs }
        if reason.hasPrefix(verdictPrefix) { return .verdict }
        if arbitrationPrefixes.contains(where: { reason.hasPrefix($0) }) { return .arbitration }
        return .failure
    }

    /// L'humain tranche une porte : il valide, ou il corrige.
    var isGate: Bool { [.specs, .irreversible, .verdict, .arbitration].contains(self) }

    /// L'humain relance : la tâche repart de son étape (`retry`).
    var isRetry: Bool { self == .failure || self == .budget }
}

/// Pourquoi une porte attend l'humain. Les raisons sont lues dans la phrase de protocole du
/// serveur (`mergeDecision`, verdict.ts ; `gateReasons`, steps.ts) et rendues en CODES :
/// l'écran dit chacune avec ses mots (`text`), jamais avec ceux du serveur.
enum OSGateReason: Equatable, Hashable {
    case size(lines: Int, ceiling: Int?)
    case blockers(Int)
    /// Le risque brut du verdict (`medium`, `high`).
    case risk(String)
    case testsRed, testsMissing, questions, criteria, unread, weak
    /// La tâche est en « tout me demander ».
    case ask
    case split, noModules, irreversible, firstOfProject
    case arbitration, budget
    /// Une raison que cette version de l'app ne connaît pas.
    case other

    var text: String {
        switch self {
        case let .size(lines, ceiling): OSDecideText.gateSize(lines: lines, ceiling: ceiling)
        case let .blockers(count): OSDecideText.gateBlockers(count)
        case let .risk(raw): OSDecideText.gate(raw == "medium" ? "risk_medium" : raw == "high" ? "risk_high" : "risk")
        case .testsRed: OSDecideText.gate("tests_red")
        case .testsMissing: OSDecideText.gate("tests_missing")
        case .questions: OSDecideText.gate("questions")
        case .criteria: OSDecideText.gate("criteria")
        case .unread: OSDecideText.gate("unread")
        case .weak: OSDecideText.gate("weak")
        case .ask: OSDecideText.gate("ask")
        case .split: OSDecideText.gate("split")
        case .noModules: OSDecideText.gate("no_modules")
        case .irreversible: OSDecideText.gate("irreversible")
        case .firstOfProject: OSDecideText.gate("first_of_project")
        case .arbitration: OSDecideText.gate("arbitration")
        case .budget: OSDecideText.gate("budget")
        case .other: OSDecideText.gate("")
        }
    }

    /// Les raisons de l'attente d'une tâche, dans l'ordre du serveur, sans doublon. Une
    /// revue sans raison connue en a une, générique ; des specs que le dépôt fait toujours
    /// valider n'en ont aucune ; une relance après échec non plus (sa cause a son code).
    static func of(_ run: HarnessRun) -> [OSGateReason] {
        switch OSHumanWait.of(run) {
        case .arbitration: return [.arbitration]
        case .budget: return [.budget]
        case .specs, .irreversible: return parts(of: run.reason).compactMap(Self.one).uniqued()
        case .verdict:
            let known = parts(of: run.reason).compactMap(Self.one).uniqued()
            return known.isEmpty ? [.other] : known
        case .questions, .failure, nil: return []
        }
    }

    /// Les raisons d'une phrase « <attente> : raison ; raison » (ou « <attente> (raison, raison) »).
    private static func parts(of reason: String?) -> [String] {
        guard let reason, let colon = reason.range(of: " : ") else { return [] }
        return reason[colon.upperBound...].components(separatedBy: " ; ").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func one(_ part: String) -> OSGateReason? {
        if let match = part.firstMatch(of: #/^diff de (\d+) lignes?(?:\D*(\d+))?/#) {
            return Int(match.1).map { .size(lines: $0, ceiling: match.2.flatMap { Int($0) }) }
        }
        if let match = part.firstMatch(of: #/^(\d+) bloquant/#) { return Int(match.1).map(OSGateReason.blockers) }
        if let match = part.firstMatch(of: #/^risque (\w+)/#) { return .risk(String(match.1)) }
        if part.hasPrefix("suite complète rouge") { return .testsRed }
        if part.hasPrefix("suite complète") { return .testsMissing }
        if part.contains("escalade") { return .questions }
        if part.hasPrefix("critère") { return .criteria }
        if part.hasPrefix("fichier") { return .unread }
        if part.hasPrefix("verdict faible") { return .weak }
        if part.hasPrefix("autonomie") { return .ask }
        if part.hasPrefix("découpage") { return .split }
        if part.hasPrefix("modules vides") { return .noModules }
        if part.hasPrefix("geste irréversible") { return .irreversible }
        if part.hasPrefix("première feature") { return .firstOfProject }
        return nil
    }
}

private extension Array where Element: Hashable {
    /// Les éléments dans leur ordre, chacun une fois.
    func uniqued() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}

// MARK: - En attente

/// Ce que dit la carte d'une tâche en attente : pourquoi elle attend (`headline`), et ce
/// qu'il y a à faire (`hint` : rien, le plus souvent). Tiré du CODE de la cause de file
/// (`waitCause`), de ce qui la retient (`blockedBy`, `waitUntil`) et de l'espace du dépôt.
struct OSWaitLine: Equatable {
    var headline: String
    var hint: String?

    /// `space` : l'espace du dépôt de la tâche. `globalPause` : tout est suspendu (sinon une
    /// cause `paused` vient de la pause de l'espace). `time` : l'heure d'un instant, telle
    /// que l'écran l'écrit.
    static func of(
        _ run: HarnessRun, space: HarnessSpace?, globalPause: Bool,
        time: (Date) -> String = { ConsoleFormat.time(ms: $0.timeIntervalSince1970 * 1000) }
    ) -> OSWaitLine {
        let titles = run.blockedBy.map { OSThreads.clean($0.title).title }
        switch run.waitCause {
        case "modules":
            if titles.count > 1 { return OSWaitLine(headline: OSDecideText.waitsForMany(titles.count), hint: OSDecideText.leavesAlone) }
            return OSWaitLine(headline: titles.first.map(OSDecideText.waitsFor) ?? OSDecideText.waitCause("modules"), hint: OSDecideText.leavesAlone)
        case "parent":
            return OSWaitLine(headline: titles.first.map(OSDecideText.waitsForParent) ?? OSDecideText.waitCause("parent"), hint: OSDecideText.leavesAlone)
        case "backoff":
            let until = run.waitUntil ?? run.notBefore
            return OSWaitLine(headline: until.map { OSDecideText.resumesAt(time($0)) } ?? OSDecideText.waitCause("backoff"), hint: OSDecideText.leavesAlone)
        case "paused":
            let headline = globalPause ? OSDecideText.allSuspended : space.map { OSDecideText.spaceSuspended($0.name) } ?? OSDecideText.allSuspended
            return OSWaitLine(headline: headline, hint: OSDecideText.leavesOnResume)
        case "space_budget":
            let headline = space.map { OSDecideText.spaceBudget($0.name, ceiling: $0.dailyBudgetUsd) } ?? OSDecideText.waitCause("space_budget")
            return OSWaitLine(headline: headline, hint: OSDecideText.leavesAlone)
        case "unknown_repo":
            // Un dépôt retiré du serveur : la tâche ne partira plus seule.
            return OSWaitLine(headline: OSDecideText.waitCause("unknown_repo"), hint: nil)
        case let cause:
            return OSWaitLine(headline: OSDecideText.waitCause(cause), hint: OSDecideText.leavesAlone)
        }
    }
}

// MARK: - Tri

/// Une étape du tri : une décision seule, ou un lot de décisions de même sorte.
enum OSTriageStep: Identifiable, Equatable {
    case one(ConsoleClient.OSDecision)
    case lot(OSDecisionLot)

    var id: String {
        switch self {
        case let .one(decision): decision.id
        case let .lot(lot): "lot:" + lot.id
        }
    }

    /// Les décisions de l'étape : passer l'étape les passe toutes.
    var decisions: [ConsoleClient.OSDecision] {
        switch self {
        case let .one(decision): [decision]
        case let .lot(lot): lot.items
        }
    }
}

enum OSTriage {
    /// Une décision qui se tranche en lot : un commentaire Jira, un envoi du poste, une revue
    /// à risque faible sans réserve. Les autres demandent une lecture, une à une — dont une
    /// tâche qui attend autre chose qu'une revue (arbitrage, budget, relance).
    static func isBatchable(_ decision: ConsoleClient.OSDecision) -> Bool {
        switch decision {
        case .jira, .approval: true
        case let .verdict(run): OSHumanWait.of(run) == .verdict && OSReviewFacts.isPlain(run.verdict)
        case .questions, .specs, .intake: false
        }
    }

    /// Les étapes du tri, espace après espace (l'ordre de `spaces`, puis ce qui n'est dans
    /// aucun), et par sorte dans un espace (`OSDecisions.lots`) : quand au moins deux
    /// décisions d'une sorte se tranchent en lot, elles arrivent ensemble, avant les autres de
    /// la sorte. Un lot ne réunit jamais les décisions de deux espaces. `skipped` : les
    /// décisions remises à plus tard, qui ne reviennent pas.
    static func steps(_ decisions: [ConsoleClient.OSDecision], skipped: Set<String> = [], spaces: [HarnessSpace] = []) -> [OSTriageStep] {
        OSDecisions.bySpace(decisions.filter { !skipped.contains($0.id) }, spaces: spaces).flatMap { group in
            OSDecisions.lots(group.items).flatMap { lot -> [OSTriageStep] in
                let batch = lot.items.filter(isBatchable)
                guard batch.count > 1 else { return lot.items.map(OSTriageStep.one) }
                return [.lot(OSDecisionLot(kind: lot.kind, items: batch, spaceId: group.space?.id))]
                    + lot.items.filter { !isBatchable($0) }.map(OSTriageStep.one)
            }
        }
    }

    /// Le nombre de décisions qui restent, toutes étapes confondues.
    static func count(_ steps: [OSTriageStep]) -> Int {
        steps.reduce(0) { $0 + $1.decisions.count }
    }

    /// La position de l'étape montrée parmi les `total` décisions vues depuis l'ouverture du
    /// tri (tranchées et remises comprises) : « 1 » pour une décision, « 1…3 » pour un lot.
    static func position(total: Int, remaining: Int, size: Int) -> ClosedRange<Int> {
        let first = max(1, total - remaining + 1)
        return first...(first + max(1, size) - 1)
    }

    /// L'espace de l'étape montrée et ce qu'il reste à trancher pour lui ; `nil` quand toutes
    /// les décisions du tri sont du même espace (rien à annoncer).
    static func group(of step: OSTriageStep, in steps: [OSTriageStep], spaces: [HarnessSpace]) -> (space: HarnessSpace?, count: Int)? {
        let groups = OSDecisions.bySpace(steps.flatMap(\.decisions), spaces: spaces)
        guard groups.count > 1, let decision = step.decisions.first, let match = groups.first(where: { $0.items.contains(decision) }) else { return nil }
        return (match.space, match.items.count)
    }
}

/// Les cases d'un lot : tout est coché d'emblée, l'humain décoche ce qu'il garde pour plus tard.
struct OSLotChecks: Equatable {
    private(set) var unchecked: Set<String> = []

    func isChecked(_ decision: ConsoleClient.OSDecision) -> Bool {
        !unchecked.contains(decision.id)
    }

    mutating func toggle(_ decision: ConsoleClient.OSDecision) {
        if unchecked.remove(decision.id) == nil { unchecked.insert(decision.id) }
    }

    /// Les décisions cochées du lot, dans son ordre : celles que le geste tranche.
    func checked(in lot: OSDecisionLot) -> [ConsoleClient.OSDecision] {
        lot.items.filter(isChecked)
    }
}

// MARK: - Refaire

enum OSRedo {
    /// La saisie d'un lancement qui refait la feature sur `repo`. Ailleurs que sur son dépôt,
    /// ses modules ne suivent pas : ce sont des chemins du dépôt d'origine.
    static func launchDraft(_ template: HarnessRunTemplate, repo: String) -> HarnessLaunchDraft {
        HarnessLaunchDraft(
            lane: template.options.lane, modules: repo == template.repo ? template.modules.joined(separator: ", ") : "",
            budget: template.budgetUsd.map(amount) ?? "", kind: template.options.kind, labels: template.labels.joined(separator: ", "),
            autonomy: template.autonomy
        )
    }

    /// La saisie d'une planification qui relance la feature : il ne reste qu'à dire quand.
    static func scheduleDraft(_ template: HarnessRunTemplate) -> HarnessScheduleDraft {
        var draft = HarnessScheduleDraft()
        draft.name = template.title
        draft.kind = .run
        draft.repo = template.repo
        draft.title = template.title
        draft.request = template.request
        draft.budget = template.budgetUsd.map(amount) ?? ""
        return draft
    }

    /// Un montant tel que la saisie le relit : « 12 », « 12.5 ».
    static func amount(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }
}

// MARK: - Session locale

enum OSLocalSessionCommand {
    /// La commande qui récupère la branche d'une session locale sur une autre machine. `nil`
    /// sans branche, ou pour un nom qu'aucun dépôt git ne porte (tiret en tête, caractère de
    /// contrôle) : la commande finit dans un terminal, elle ne cite qu'un nom sûr, entre apostrophes.
    static func resume(branch: String?) -> String? {
        guard let branch = branch?.trimmingCharacters(in: .whitespaces), !branch.isEmpty, !branch.hasPrefix("-"),
              !branch.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || CharacterSet.newlines.contains($0) })
        else { return nil }
        let plain = branch.unicodeScalars.allSatisfy { safe.contains($0) }
        let quoted = plain ? branch : "'" + branch.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
        return "git fetch && git switch " + quoted
    }

    private static let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._/-")
}
