// L'AUTONOMIE PAR PALIERS, côté client : le contrat de `GET /v1/autonomy` (règles par
// dépôt, validations prises seules, propositions de palier) et de `decision.autonomy`
// (la porte, la règle et les preuves d'une validation prise seule), puis le modèle
// observable de la page Système › Autonomie.
//
// Tout est en LECTURE : le serveur ne change jamais une règle, et l'app non plus. Une
// proposition porte la modification de configuration à faire (`changes`) ; l'humain la
// fait dans la configuration du serveur. Aucun texte ici : les écrans traduisent
// (`AutonomyText`).

import Combine
import ConsoleCore
import Foundation

/// Les types de travail que reconnaît le serveur (`POST /v1/runs`, `kind`).
public enum HarnessWorkKind: String, CaseIterable, Sendable, Identifiable {
    case bug
    case feature
    case docs
    case deps
    case test

    public var id: String { rawValue }
}

/// Ce qu'une règle compare à un run : son type, la taille de son diff, ses fichiers et ses labels.
public struct HarnessAutonomyMatch: Codable, Equatable, Sendable {
    public var kind: String
    public var maxDiffLines: Int?
    public var paths: [String]
    public var labels: [String]

    public init(kind: String, maxDiffLines: Int? = nil, paths: [String] = [], labels: [String] = []) {
        self.kind = kind
        self.maxDiffLines = maxDiffLines
        self.paths = paths
        self.labels = labels
    }

    private enum CodingKeys: String, CodingKey {
        case kind, maxDiffLines, paths, labels
    }

    /// Le serveur n'écrit ni `paths` ni `labels` quand la règle n'en pose pas : listes vides.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(String.self, forKey: .kind)
        maxDiffLines = try container.decodeIfPresent(Int.self, forKey: .maxDiffLines)
        paths = try container.decodeIfPresent([String].self, forKey: .paths) ?? []
        labels = try container.decodeIfPresent([String].self, forKey: .labels) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encodeIfPresent(maxDiffLines, forKey: .maxDiffLines)
        if !paths.isEmpty { try container.encode(paths, forKey: .paths) }
        if !labels.isEmpty { try container.encode(labels, forKey: .labels) }
    }
}

/// Ce qu'une règle exige d'être prouvé avant de valider seule.
public struct HarnessAutonomyRequire: Codable, Equatable, Sendable {
    public var reproTest: Bool
    public var greenChecks: Bool
    public var proofs: Bool

    public init(reproTest: Bool = false, greenChecks: Bool = false, proofs: Bool = false) {
        self.reproTest = reproTest
        self.greenChecks = greenChecks
        self.proofs = proofs
    }

    private enum CodingKeys: String, CodingKey {
        case reproTest, greenChecks, proofs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reproTest = try container.decodeIfPresent(Bool.self, forKey: .reproTest) ?? false
        greenChecks = try container.decodeIfPresent(Bool.self, forKey: .greenChecks) ?? false
        proofs = try container.decodeIfPresent(Bool.self, forKey: .proofs) ?? false
    }
}

/// Qui franchit chaque porte : `human` (l'humain) ou `auto` (le serveur, preuves faites).
public struct HarnessAutonomyGates: Codable, Equatable, Sendable {
    public var specs: String
    public var review: String

    public init(specs: String = "human", review: String = "human") {
        self.specs = specs
        self.review = review
    }

    private enum CodingKeys: String, CodingKey {
        case specs, review
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        specs = try container.decodeIfPresent(String.self, forKey: .specs) ?? "human"
        review = try container.decodeIfPresent(String.self, forKey: .review) ?? "human"
    }
}

/// Une règle d'autonomie d'un dépôt ; la première qui correspond à un run s'applique.
public struct HarnessAutonomyRule: Codable, Equatable, Sendable {
    public var match: HarnessAutonomyMatch
    public var require: HarnessAutonomyRequire
    public var gates: HarnessAutonomyGates

    public init(match: HarnessAutonomyMatch, require: HarnessAutonomyRequire = HarnessAutonomyRequire(), gates: HarnessAutonomyGates = HarnessAutonomyGates()) {
        self.match = match
        self.require = require
        self.gates = gates
    }

    private enum CodingKeys: String, CodingKey {
        case match, require, gates
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        match = try container.decode(HarnessAutonomyMatch.self, forKey: .match)
        require = try container.decodeIfPresent(HarnessAutonomyRequire.self, forKey: .require) ?? HarnessAutonomyRequire()
        gates = try container.decodeIfPresent(HarnessAutonomyGates.self, forKey: .gates) ?? HarnessAutonomyGates()
    }
}

/// La règle d'une validation prise seule, telle qu'elle était quand le serveur l'a retenue.
public struct HarnessAutonomyRuleSnapshot: Codable, Equatable, Sendable {
    /// Son rang dans la liste du dépôt, à partir de 1.
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

    private enum CodingKeys: String, CodingKey {
        case rank, match, require, gates
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        rank = try container.decode(Int.self, forKey: .rank)
        match = try container.decode(HarnessAutonomyMatch.self, forKey: .match)
        require = try container.decodeIfPresent(HarnessAutonomyRequire.self, forKey: .require) ?? HarnessAutonomyRequire()
        gates = try container.decodeIfPresent(HarnessAutonomyGates.self, forKey: .gates) ?? HarnessAutonomyGates()
    }
}

/// Les preuves constatées par le serveur : à la porte des specs, le type et les labels
/// seuls ; à la porte de revue, aussi le diff, la suite, les tests et les critères.
public struct HarnessAutonomyProofs: Codable, Equatable, Sendable {
    public var kind: String?
    public var labels: [String]
    /// Les raisons de porte des specs : toujours vides pour une validation seule.
    public var gateReasons: [String]
    public var diffLines: Int?
    /// Le seuil de diff du serveur (`review.maxDiffLines`).
    public var reviewMaxDiffLines: Int?
    /// Le seuil de diff de la règle (`match.maxDiffLines`).
    public var ruleMaxDiffLines: Int?
    /// Le résultat de la suite complète sur l'arbre relu (`pass`).
    public var fullTests: String?
    public var reproTests: [String]
    public var provenCriteria: [String]
    public var reviewSha: String?

    public init(
        kind: String? = nil, labels: [String] = [], gateReasons: [String] = [], diffLines: Int? = nil,
        reviewMaxDiffLines: Int? = nil, ruleMaxDiffLines: Int? = nil, fullTests: String? = nil,
        reproTests: [String] = [], provenCriteria: [String] = [], reviewSha: String? = nil
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

    private enum CodingKeys: String, CodingKey {
        case kind, labels, gateReasons, diffLines, reviewMaxDiffLines, ruleMaxDiffLines, fullTests, reproTests, provenCriteria, reviewSha
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
        labels = try container.decodeIfPresent([String].self, forKey: .labels) ?? []
        gateReasons = try container.decodeIfPresent([String].self, forKey: .gateReasons) ?? []
        diffLines = try container.decodeIfPresent(Int.self, forKey: .diffLines)
        reviewMaxDiffLines = try container.decodeIfPresent(Int.self, forKey: .reviewMaxDiffLines)
        ruleMaxDiffLines = try container.decodeIfPresent(Int.self, forKey: .ruleMaxDiffLines)
        fullTests = try container.decodeIfPresent(String.self, forKey: .fullTests)
        reproTests = try container.decodeIfPresent([String].self, forKey: .reproTests) ?? []
        provenCriteria = try container.decodeIfPresent([String].self, forKey: .provenCriteria) ?? []
        reviewSha = try container.decodeIfPresent(String.self, forKey: .reviewSha)
    }
}

/// `decision.autonomy` : la porte franchie seule, la règle retenue et les preuves.
public struct HarnessAutonomyProof: Codable, Equatable, Sendable {
    /// `specs` ou `review`.
    public var gate: String
    public var rule: HarnessAutonomyRuleSnapshot
    public var proofs: HarnessAutonomyProofs

    public init(gate: String, rule: HarnessAutonomyRuleSnapshot, proofs: HarnessAutonomyProofs = HarnessAutonomyProofs()) {
        self.gate = gate
        self.rule = rule
        self.proofs = proofs
    }

    /// La porte des specs (avant l'implémentation), sinon celle de la revue (avant le merge).
    public var isSpecsGate: Bool { gate == "specs" }
}

/// Les règles d'un dépôt, dans l'ordre où le serveur les essaie.
public struct HarnessAutonomyRepo: Codable, Equatable, Sendable, Identifiable {
    public var repo: String
    public var rules: [HarnessAutonomyRule]

    public init(repo: String, rules: [HarnessAutonomyRule] = []) {
        self.repo = repo
        self.rules = rules
    }

    public var id: String { repo }
}

/// Une modification de configuration suggérée : le chemin à régler et la valeur à y mettre.
public struct HarnessAutonomyChange: Codable, Equatable, Sendable, Identifiable {
    public var path: String
    public var value: JSONValue

    public init(path: String, value: JSONValue) {
        self.path = path
        self.value = value
    }

    public var id: String { path }

    /// La valeur telle qu'on la saisit : le texte brut d'une chaîne, sinon le JSON compact.
    public var valueText: String {
        if case .string(let text) = value { return text }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else { return "" }
        return text
    }
}

/// Une proposition de palier : monter (`raise`) ou baisser (`lower`) la porte d'un type de travail.
public struct HarnessAutonomyProposal: Codable, Equatable, Sendable, Identifiable {
    public var repo: String
    public var kind: String
    /// `specs` ou `review`.
    public var gate: String
    /// `raise` ou `lower`.
    public var direction: String
    /// La porte telle que la configuration la règle aujourd'hui : `human` ou `auto`.
    public var current: String
    /// Le rang de la règle qui la règle, `nil` : aucune règle ne s'applique.
    public var rule: Int?
    public var runs: Int
    public var passages: Int
    public var corrections: Int
    /// La part des runs corrigés, de 0 à 1.
    public var rate: Double
    public var changes: [HarnessAutonomyChange]

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

    public var id: String { [repo, kind, gate, direction].joined(separator: "/") }

    public var isRaise: Bool { direction == "raise" }
}

/// `GET /v1/autonomy`.
public struct HarnessAutonomyView: Codable, Equatable, Sendable {
    public var repos: [HarnessAutonomyRepo]
    /// Les décisions prises seules par l'autonomie de la fenêtre, les plus récentes d'abord.
    public var validations: [HarnessDecision]
    public var proposals: [HarnessAutonomyProposal]

    public init(repos: [HarnessAutonomyRepo] = [], validations: [HarnessDecision] = [], proposals: [HarnessAutonomyProposal] = []) {
        self.repos = repos
        self.validations = validations
        self.proposals = proposals
    }

    /// Aucune règle, aucune validation, aucune proposition : l'autonomie n'est pas configurée.
    public var isEmpty: Bool {
        repos.allSatisfy { $0.rules.isEmpty } && validations.isEmpty && proposals.isEmpty
    }
}

/// La page Système › Autonomie : lue à la demande, relue quand le flux annonce un
/// événement `autonomy` ou `validation`. Aucun geste n'écrit une règle.
@MainActor
public final class HarnessAutonomy: ObservableObject {
    @Published public private(set) var availability: HarnessFeatureAvailability = .unknown
    @Published public private(set) var view: HarnessAutonomyView?
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    public private(set) var isWatched = false

    private unowned let harness: HarnessModel

    init(harness: HarnessModel) {
        self.harness = harness
    }

    public func refresh() async {
        isWatched = true
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

    /// Les événements du flux : une validation ou une décision de l'autonomie font relire la page observée.
    func receive(_ names: [String]) {
        guard isWatched, availability != .absent, names.contains(where: { $0 == "autonomy" || $0 == "validation" }) else { return }
        Task { await refresh() }
    }

    func reset() {
        availability = .unknown
        view = nil
        failure = nil
        isWatched = false
    }
}

// MARK: - Lecture

/// Une ligne « libellé, valeur » de la porte franchie, de la règle ou d'une preuve, en français.
public struct HarnessAutonomyFact: Equatable, Sendable, Identifiable {
    public var label: String
    public var value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }

    public var id: String { label }
}

extension HarnessAutonomyMatch {
    /// « Bug, au plus 80 lignes de différences, fichiers : src/ ».
    public var summary: String {
        AutonomyText.matchSummary(kind: kind, maxDiffLines: maxDiffLines, paths: paths, labels: labels)
    }
}

extension HarnessAutonomyRequire {
    public var summary: String {
        AutonomyText.requireSummary(reproTest: reproTest, greenChecks: greenChecks, proofs: proofs)
    }
}

extension HarnessAutonomyGates {
    public var summary: String { AutonomyText.gatesSummary(specs: specs, review: review) }
}

extension HarnessAutonomyProof {
    /// Ce que l'humain relit d'une validation prise seule : la porte franchie, la règle (rang, `match`,
    /// exigences, portes), puis chaque preuve avec sa valeur. À la porte des specs, le type, les
    /// étiquettes et l'absence de raison de porte ; à la porte de revue, aussi les différences, la
    /// suite complète, les tests de reproduction et les critères prouvés.
    public var facts: [HarnessAutonomyFact] {
        let list = { (items: [String]) in items.isEmpty ? AutonomyText.noneMasculine : items.joined(separator: ", ") }
        var facts = [
            HarnessAutonomyFact(label: AutonomyText.factGate, value: AutonomyText.gateCrossed(gate)),
            HarnessAutonomyFact(label: AutonomyText.factRule(rank: rule.rank), value: rule.match.summary),
            HarnessAutonomyFact(label: AutonomyText.factRequire, value: rule.require.summary),
            HarnessAutonomyFact(label: AutonomyText.factRuleGates, value: rule.gates.summary),
        ]
        if let kind = proofs.kind {
            facts.append(HarnessAutonomyFact(label: AutonomyText.factKind, value: AutonomyText.kindName(kind)))
        }
        facts.append(HarnessAutonomyFact(label: AutonomyText.factLabels, value: proofs.labels.isEmpty ? AutonomyText.none : proofs.labels.joined(separator: ", ")))
        if isSpecsGate {
            facts.append(HarnessAutonomyFact(label: AutonomyText.factGateReasons, value: proofs.gateReasons.isEmpty ? AutonomyText.none : proofs.gateReasons.joined(separator: ", ")))
            return facts
        }
        if let lines = proofs.diffLines {
            facts.append(HarnessAutonomyFact(
                label: AutonomyText.factDiff,
                value: AutonomyText.diffFigures(lines: lines, serverLimit: proofs.reviewMaxDiffLines, ruleLimit: proofs.ruleMaxDiffLines)
            ))
        }
        if let tests = proofs.fullTests {
            facts.append(HarnessAutonomyFact(label: AutonomyText.factTests, value: AutonomyText.testsResult(tests, sha: proofs.reviewSha)))
        }
        facts.append(HarnessAutonomyFact(label: AutonomyText.factRepro, value: list(proofs.reproTests)))
        facts.append(HarnessAutonomyFact(label: AutonomyText.factCriteria, value: list(proofs.provenCriteria)))
        return facts
    }
}
