// L'« OS agentique » : la logique PURE de « Décider » — l'échéance d'une question, les
// faits d'une revue (ampleur, tests), les étapes du tri (une décision, ou un lot de
// décisions de même sorte à trancher d'un geste) et les cases d'un lot. Aucune vue,
// aucun réseau : les écrans de ce dossier la lisent.

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
    /// Les lignes de différences d'une revue, lues dans la raison que le serveur écrit quand
    /// leur nombre réserve la validation à l'humain (« … diff de 412 lignes … » : une phrase
    /// du protocole, pas un texte d'écran). `nil` quand la raison ne le dit pas.
    static func diffLines(reason: String?) -> Int? {
        guard let match = reason?.firstMatch(of: #/diff de (\d+) lignes?/#) else { return nil }
        return Int(match.1)
    }

    /// Une revue qui se valide en lot : risque faible, verdict ferme, rien de bloquant ni d'invérifié.
    static func isPlain(_ verdict: HarnessVerdict?) -> Bool {
        guard let verdict else { return false }
        return verdict.isLowRisk && !verdict.isWeak && verdict.blockers.isEmpty
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
    /// à risque faible sans réserve. Les autres demandent une lecture, une à une.
    static func isBatchable(_ decision: ConsoleClient.OSDecision) -> Bool {
        switch decision {
        case .jira, .approval: true
        case let .verdict(run): OSReviewFacts.isPlain(run.verdict)
        case .questions, .specs, .intake, .audit: false
        }
    }

    /// Les étapes du tri, par sorte (`OSDecisions.lots`) : quand au moins deux décisions d'une
    /// sorte se tranchent en lot, elles arrivent ensemble, avant les autres de la sorte.
    /// `skipped` : les décisions passées, qui ne reviennent pas.
    static func steps(_ decisions: [ConsoleClient.OSDecision], skipped: Set<String> = []) -> [OSTriageStep] {
        OSDecisions.lots(decisions.filter { !skipped.contains($0.id) }).flatMap { lot -> [OSTriageStep] in
            let batch = lot.items.filter(isBatchable)
            guard batch.count > 1 else { return lot.items.map(OSTriageStep.one) }
            return [.lot(OSDecisionLot(kind: lot.kind, items: batch))] + lot.items.filter { !isBatchable($0) }.map(OSTriageStep.one)
        }
    }

    /// Le nombre de décisions qui restent, toutes étapes confondues.
    static func count(_ steps: [OSTriageStep]) -> Int {
        steps.reduce(0) { $0 + $1.decisions.count }
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
