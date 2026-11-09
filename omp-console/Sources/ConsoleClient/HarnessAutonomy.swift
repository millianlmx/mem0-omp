// L'AUTONOMIE PAR PALIERS vue du client (omp-harness/autonomy-rules.ts, autonomy-gates.ts,
// autonomy-learning.ts) : le type de travail d'un lancement, la validation prise seule
// portée par une décision (`decision.autonomy`) et la page Système › Autonomie
// (`GET /v1/autonomy` : règles par dépôt, validations prises seules, propositions de
// palier avec la modification de configuration suggérée).
//
// Un serveur antérieur ne sert pas la route (404) : `availability == .absent`, et la
// page quitte le hub Système. Une seule écriture : le mode d'une porte pour un type de
// travail (`POST /v1/autonomy/rules`, admin) — « toujours valider seul ce type ».

import Combine
import ConsoleCore
import Foundation

/// Les types de travail du serveur (`WORK_KINDS`) : le choix d'un lancement.
public enum HarnessWorkKind: String, CaseIterable, Identifiable, Sendable {
    case bug
    case feature
    case docs
    case deps
    case test

    public var id: String { rawValue }
}

/// Une porte d'un run : la validation des specs, ou celle de la revue.
public enum HarnessAutonomyGate: String, CaseIterable, Identifiable, Sendable {
    case specs
    case review

    public var id: String { rawValue }
}

/// Le mode d'une porte : l'humain valide, ou le serveur valide seul sur preuves.
public enum HarnessAutonomyMode: String, CaseIterable, Identifiable, Sendable {
    case human
    case auto

    public var id: String { rawValue }
}

/// Le corps de `POST /v1/autonomy/rules`.
private struct AutonomyRuleBody: Encodable {
    var repo: String
    var kind: String
    var gate: String
    var mode: String
}

// MARK: - Contrat

/// Ce qu'une règle exige d'un run : `match.kind` toujours, le reste si la règle le fixe.
public struct HarnessAutonomyMatch: Codable, Equatable, Sendable {
    public var kind: String
    public var maxDiffLines: Int?
    public var paths: [String]?
    public var labels: [String]?

    public init(kind: String, maxDiffLines: Int? = nil, paths: [String]? = nil, labels: [String]? = nil) {
        self.kind = kind
        self.maxDiffLines = maxDiffLines
        self.paths = paths
        self.labels = labels
    }
}

/// Les preuves qu'une règle exige à la revue.
public struct HarnessAutonomyRequire: Codable, Equatable, Sendable {
    public var reproTest: Bool?
    public var greenChecks: Bool?
    public var proofs: Bool?

    public init(reproTest: Bool? = nil, greenChecks: Bool? = nil, proofs: Bool? = nil) {
        self.reproTest = reproTest
        self.greenChecks = greenChecks
        self.proofs = proofs
    }
}

/// Le mode de chaque porte : `human` ou `auto`.
public struct HarnessAutonomyGates: Codable, Equatable, Sendable {
    public var specs: String
    public var review: String

    public init(specs: String = "human", review: String = "human") {
        self.specs = specs
        self.review = review
    }
}

/// Une règle d'un dépôt, telle que la configuration la déclare (normalisée par le serveur).
public struct HarnessAutonomyRule: Codable, Equatable, Sendable {
    public var match: HarnessAutonomyMatch
    public var require: HarnessAutonomyRequire
    public var gates: HarnessAutonomyGates

    public init(match: HarnessAutonomyMatch, require: HarnessAutonomyRequire = HarnessAutonomyRequire(), gates: HarnessAutonomyGates = HarnessAutonomyGates()) {
        self.match = match
        self.require = require
        self.gates = gates
    }
}

/// La règle retenue pour une validation prise seule, avec son rang (à partir de 1).
public struct HarnessAutonomyRuleSnapshot: Codable, Equatable, Sendable {
    public var rank: Int
    public var match: HarnessAutonomyMatch
    public var require: HarnessAutonomyRequire
    public var gates: HarnessAutonomyGates

    public init(rank: Int, match: HarnessAutonomyMatch, require: HarnessAutonomyRequire = HarnessAutonomyRequire(), gates: HarnessAutonomyGates = HarnessAutonomyGates()) {
        self.rank = rank
        self.match = match
        self.require = require
        self.gates = gates
    }
}

/// Les preuves constatées au moment de la validation. Celles des specs ne portent que le
/// type, les labels et les raisons de porte ; celles de la revue, le diff et les tests.
public struct HarnessAutonomyProofs: Codable, Equatable, Sendable {
    public var kind: String?
    public var labels: [String]?
    public var gateReasons: [String]?
    public var diffLines: Int?
    public var reviewMaxDiffLines: Int?
    public var ruleMaxDiffLines: Int?
    public var fullTests: String?
    public var reproTests: [String]?
    public var provenCriteria: [String]?
    public var reviewSha: String?

    public init(
        kind: String? = nil, labels: [String]? = nil, gateReasons: [String]? = nil, diffLines: Int? = nil,
        reviewMaxDiffLines: Int? = nil, ruleMaxDiffLines: Int? = nil, fullTests: String? = nil,
        reproTests: [String]? = nil, provenCriteria: [String]? = nil, reviewSha: String? = nil
    ) {
        self.kind = kind
        self.labels = labels
        self.gateReasons = gateReasons
        self.diffLines = diffLines
        self.reviewMaxDiffLines = reviewMaxDiffLines
        self.ruleMaxDiffLines = ruleMaxDiffLines
        self.fullTests = fullTests
        self.reproTests = reproTests
        self.provenCriteria = provenCriteria
        self.reviewSha = reviewSha
    }
}

/// Une validation prise seule (`decision.autonomy`) : la porte franchie, la règle, les preuves.
public struct HarnessAutonomyProof: Codable, Equatable, Sendable {
    public var gate: String
    public var rule: HarnessAutonomyRuleSnapshot
    public var proofs: HarnessAutonomyProofs

    public init(gate: String, rule: HarnessAutonomyRuleSnapshot, proofs: HarnessAutonomyProofs) {
        self.gate = gate
        self.rule = rule
        self.proofs = proofs
    }
}

/// Les règles d'un dépôt visible (vides : chaque porte attend l'humain).
public struct HarnessAutonomyRepo: Codable, Equatable, Sendable, Identifiable {
    public var repo: String
    public var rules: [HarnessAutonomyRule]

    public var id: String { repo }

    public init(repo: String, rules: [HarnessAutonomyRule] = []) {
        self.repo = repo
        self.rules = rules
    }
}

/// Une modification de configuration suggérée : le chemin et la valeur à y écrire.
public struct HarnessAutonomyChange: Codable, Equatable, Sendable {
    public var path: String
    public var value: JSONValue

    public init(path: String, value: JSONValue) {
        self.path = path
        self.value = value
    }

    /// La valeur en JSON compact, clés triées (une chaîne garde ses guillemets).
    public var valueText: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
}

/// Une proposition de palier pour (dépôt, type, porte) : monter à l'autonomie ou rendre à l'humain.
public struct HarnessAutonomyProposal: Codable, Equatable, Sendable, Identifiable {
    public var repo: String
    public var kind: String
    public var gate: String
    public var direction: String
    public var current: String
    public var rule: Int?
    public var runs: Int
    public var passages: Int
    public var corrections: Int
    public var rate: Double
    public var changes: [HarnessAutonomyChange]

    public var id: String { "\(repo)/\(kind)/\(gate)" }

    public init(
        repo: String, kind: String, gate: String, direction: String, current: String, rule: Int? = nil,
        runs: Int = 0, passages: Int = 0, corrections: Int = 0, rate: Double = 0, changes: [HarnessAutonomyChange] = []
    ) {
        self.repo = repo
        self.kind = kind
        self.gate = gate
        self.direction = direction
        self.current = current
        self.rule = rule
        self.runs = runs
        self.passages = passages
        self.corrections = corrections
        self.rate = rate
        self.changes = changes
    }
}

/// `GET /v1/autonomy`.
public struct HarnessAutonomyView: Codable, Equatable, Sendable {
    public var repos: [HarnessAutonomyRepo]
    public var validations: [HarnessDecision]
    public var proposals: [HarnessAutonomyProposal]

    public init(repos: [HarnessAutonomyRepo] = [], validations: [HarnessDecision] = [], proposals: [HarnessAutonomyProposal] = []) {
        self.repos = repos
        self.validations = validations
        self.proposals = proposals
    }
}

// MARK: - Lecture

/// Les mots des codes du serveur : porte, mode d'une porte, état de la suite complète.
enum HarnessAutonomyWords {
    static func gate(_ raw: String) -> String {
        switch raw {
        case "specs": AutonomyText.gateSpecs
        case "review": AutonomyText.gateReview
        default: raw
        }
    }

    static func mode(_ raw: String) -> String {
        switch raw {
        case "human": AutonomyText.modeHuman
        case "auto": AutonomyText.modeAuto
        default: raw
        }
    }

    static func suite(_ raw: String) -> String {
        switch raw {
        case "pass": AutonomyText.suiteGreen
        case "fail": AutonomyText.suiteRed
        case "not_run": AutonomyText.suiteNotRun
        default: raw
        }
    }
}

extension HarnessAutonomyMatch {
    /// « Bogue · 50 lignes de différences au plus · sous docs/ · labels : urgent ».
    public var summary: String {
        var parts = [AutonomyText.kind(kind)]
        if let maxDiffLines { parts.append(AutonomyText.maxDiffLines(maxDiffLines)) }
        if let paths, !paths.isEmpty { parts.append(AutonomyText.paths(paths.joined(separator: ", "))) }
        if let labels, !labels.isEmpty { parts.append(AutonomyText.labels(labels.joined(separator: ", "))) }
        return parts.joined(separator: " · ")
    }
}

extension HarnessAutonomyRequire {
    /// « Exige : test de reproduction, suite complète verte », ou `nil` sans exigence.
    public var summary: String? {
        var parts: [String] = []
        if reproTest == true { parts.append(AutonomyText.requireReproTest) }
        if greenChecks == true { parts.append(AutonomyText.requireGreenChecks) }
        if proofs == true { parts.append(AutonomyText.requireProofs) }
        return parts.isEmpty ? nil : AutonomyText.requires(parts.joined(separator: ", "))
    }
}

extension HarnessAutonomyGates {
    /// « Specs : humain · revue : autonomie ».
    public var summary: String { AutonomyText.gates(specs: HarnessAutonomyWords.mode(specs), review: HarnessAutonomyWords.mode(review)) }
}

extension HarnessAutonomyProof {
    /// « Porte franchie : revue ».
    public var gateLine: String { AutonomyText.gateCrossed(HarnessAutonomyWords.gate(gate)) }

    /// « Règle 2 : Bogue · 50 lignes de différences au plus ».
    public var ruleLine: String { AutonomyText.rule(rule.rank, rule.match.summary) }

    /// Chaque preuve constatée avec sa valeur, une ligne chacune, dans l'ordre du serveur.
    public var proofLines: [String] {
        let list = { (values: [String]?) in values.flatMap { $0.isEmpty ? nil : $0.joined(separator: ", ") } ?? AutonomyText.none }
        var lines: [String] = []
        if let kind = proofs.kind { lines.append(AutonomyText.proofKind(AutonomyText.kind(kind))) }
        lines.append(AutonomyText.proofLabels(list(proofs.labels)))
        if gate == "specs" {
            let reasons = proofs.gateReasons ?? []
            lines.append(reasons.isEmpty ? AutonomyText.proofNoGateReason : AutonomyText.proofGateReasons(reasons.joined(separator: ", ")))
            return lines
        }
        if let diff = proofs.diffLines, let server = proofs.reviewMaxDiffLines, let ruleMax = proofs.ruleMaxDiffLines {
            lines.append(AutonomyText.proofDiff(diff, server: server, rule: ruleMax))
        }
        if let suite = proofs.fullTests {
            if suite == "pass", let sha = proofs.reviewSha {
                lines.append(AutonomyText.proofSuiteGreen(String(sha.prefix(8))))
            } else {
                lines.append(AutonomyText.proofSuite(HarnessAutonomyWords.suite(suite)))
            }
        }
        lines.append(AutonomyText.proofRepro(list(proofs.reproTests)))
        lines.append(AutonomyText.proofCriteria(list(proofs.provenCriteria)))
        return lines
    }
}

extension HarnessAutonomyProposal {
    /// « Bogue · revue : passer à l'autonomie ».
    public var title: String {
        let kind = AutonomyText.kind(kind)
        let gate = HarnessAutonomyWords.gate(gate)
        return direction == "raise" ? AutonomyText.proposalRaise(kind: kind, gate: gate) : AutonomyText.proposalLower(kind: kind, gate: gate)
    }

    /// « Jugées : 12 · corrigées : 0 (0 %) ».
    public var stats: String {
        AutonomyText.proposalStats(runs: runs, corrections: corrections, rate: PipelineServerText.percent(rate))
    }
}

// MARK: - Modèle

/// La page Système › Autonomie : lue à la demande de son écran (et du hub, qui la masque
/// sur un serveur qui ne la sert pas), relue quand le flux annonce une validation.
@MainActor
public final class HarnessAutonomy: ObservableObject {
    @Published public private(set) var availability: HarnessFeatureAvailability = .unknown
    @Published public private(set) var view: HarnessAutonomyView?
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    /// L'écriture d'une règle de palier attend la réponse du serveur.
    @Published public private(set) var isSaving = false

    private unowned let harness: HarnessModel

    init(harness: HarnessModel) {
        self.harness = harness
    }

    /// Le serveur relié sert la page (inconnu compris : la rangée ne clignote pas).
    public var isServed: Bool { availability != .absent }

    /// Relit les règles, les validations prises seules et les propositions.
    public func refresh() async {
        guard harness.isConfigured else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            guard let read: HarnessAutonomyView = try await harness.readIfServed("/v1/autonomy") else {
                availability = .absent
                view = nil
                return
            }
            view = read
            availability = .available
            failure = nil
        } catch {
            availability = HarnessControlFailure.availability(after: error, current: availability)
            failure = HarnessModel.failure(of: error)
        }
    }

    /// Écrit le mode d'une porte pour un type de travail d'un dépôt (admin) : la règle du
    /// type change de porte, ou une règle prudente est ajoutée. Les règles du dépôt telles
    /// que le serveur les tient désormais remplacent celles de la page.
    @discardableResult
    public func setRule(repo: String, kind: HarnessWorkKind, gate: HarnessAutonomyGate, mode: HarnessAutonomyMode) async -> Bool {
        isSaving = true
        defer { isSaving = false }
        do {
            let written: HarnessAutonomyRepo = try await harness.write(
                "POST", "/v1/autonomy/rules", body: AutonomyRuleBody(repo: repo, kind: kind.rawValue, gate: gate.rawValue, mode: mode.rawValue)
            )
            if let index = view?.repos.firstIndex(where: { $0.repo == written.repo }) { view?.repos[index] = written }
            failure = nil
            // Une proposition de palier appliquée disparaît : la page entière est relue.
            await refresh()
            return true
        } catch {
            failure = HarnessModel.failure(of: error)
            return false
        }
    }

    /// Les événements du flux : une validation (humaine ou prise seule) change les comptes,
    /// une règle écrite (ici ou ailleurs) change les règles.
    func receive(_ names: [String]) {
        guard availability == .available, names.contains(where: { $0 == "autonomy" || $0 == "validation" || $0 == "autonomy_rule" }) else { return }
        Task { await refresh() }
    }

    func reset() {
        availability = .unknown
        view = nil
        failure = nil
    }
}
