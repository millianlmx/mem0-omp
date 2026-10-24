// Le contrat du MONITORING du serveur de pipelines : coût et budget d'une feature,
// alertes (agent muet, étape lente, boucle de corrections, budget dépassé), frise,
// fichiers touchés et leurs différences, sortie des tests en direct, santé du serveur,
// comparaison des modèles. Décodé tel que le serveur l'écrit (clés camelCase,
// instants en millisecondes) ; un serveur plus ancien qui n'en écrit rien laisse ces
// champs vides au lieu de faire échouer la boîte.
//
// Aucun texte ici : les écrans traduisent les codes avec `PipelineServerText`.

import ConsoleCore
import Foundation

// MARK: - Coût

/// Une somme de consommation des agents.
public struct HarnessUsageTotals: Codable, Equatable, Sendable {
    public var messages: Int
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    public var cacheWrite: Int
    /// En dollars, d'après omp ; `0` quand le fournisseur ne dit rien du prix.
    public var cost: Double

    public init(messages: Int = 0, input: Int = 0, output: Int = 0, cacheRead: Int = 0, cacheWrite: Int = 0, cost: Double = 0) {
        self.messages = messages
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.cost = cost
    }

    /// Les jetons lus et écrits par les agents.
    public var tokens: Int { input + output + cacheRead + cacheWrite }
}

/// La consommation d'un run : son total, par étape et par modèle.
public struct HarnessRunUsage: Codable, Equatable, Sendable {
    public var total: HarnessUsageTotals
    public var byStep: [String: HarnessUsageTotals]
    public var byModel: [String: HarnessUsageTotals]

    public init(total: HarnessUsageTotals = HarnessUsageTotals(), byStep: [String: HarnessUsageTotals] = [:], byModel: [String: HarnessUsageTotals] = [:]) {
        self.total = total
        self.byStep = byStep
        self.byModel = byModel
    }
}

/// Le budget d'un run : ce qu'il a coûté, le plafond configuré, le seuil du prochain avertissement.
public struct HarnessBudget: Codable, Equatable, Sendable {
    public var cost: Double
    public var budget: Double?
    public var threshold: Double?

    public init(cost: Double = 0, budget: Double? = nil, threshold: Double? = nil) {
        self.cost = cost
        self.budget = budget
        self.threshold = threshold
    }

    /// La part du seuil déjà dépensée (`nil` sans plafond).
    public var ratio: Double? {
        guard let threshold, threshold > 0 else { return nil }
        return cost / threshold
    }
}

// MARK: - Alertes

/// Les sortes d'alertes de la veille du serveur.
public enum HarnessAlertKind: String, Sendable, CaseIterable {
    case stalled
    case stepSlow = "step_slow"
    case fixLoop = "fix_loop"
    case budgetExceeded = "budget_exceeded"
}

/// Ce qu'une alerte dit d'elle-même ; chaque sorte n'en remplit qu'une partie.
public struct HarnessAlertDetail: Codable, Equatable, Sendable {
    public var minutes: Int?
    public var medianMin: Int?
    public var step: String?
    public var tool: String?
    public var fixes: Int?
    public var cost: Double?
    public var budget: Double?
    public var threshold: Double?
    public var paused: Bool?

    public init(minutes: Int? = nil, medianMin: Int? = nil, step: String? = nil, tool: String? = nil, fixes: Int? = nil, cost: Double? = nil, budget: Double? = nil, threshold: Double? = nil, paused: Bool? = nil) {
        self.minutes = minutes
        self.medianMin = medianMin
        self.step = step
        self.tool = tool
        self.fixes = fixes
        self.cost = cost
        self.budget = budget
        self.threshold = threshold
        self.paused = paused
    }
}

/// Une alerte en cours sur une feature.
public struct HarnessAlert: Codable, Equatable, Sendable, Identifiable {
    public var runId: String
    /// La sorte, telle que le serveur l'écrit ; une sorte inconnue de cette version de l'app reste lisible.
    public var kind: String
    /// L'instant où l'alerte est née.
    public var since: Double
    public var detail: HarnessAlertDetail

    public init(runId: String, kind: String, since: Double = 0, detail: HarnessAlertDetail = HarnessAlertDetail()) {
        self.runId = runId
        self.kind = kind
        self.since = since
        self.detail = detail
    }

    public var id: String { "\(runId)/\(kind)" }
    public var sort: HarnessAlertKind? { HarnessAlertKind(rawValue: kind) }
}

// MARK: - Frise

/// Une étape sur la frise.
public struct HarnessTimelineStep: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var kind: String
    public var attempt: Int
    public var status: String
    public var model: String?
    public var startedAt: Double
    public var endedAt: Double?

    public init(id: Int, kind: String, attempt: Int = 0, status: String, model: String? = nil, startedAt: Double, endedAt: Double? = nil) {
        self.id = id
        self.kind = kind
        self.attempt = attempt
        self.status = status
        self.model = model
        self.startedAt = startedAt
        self.endedAt = endedAt
    }
}

/// L'issue d'une étape, telle qu'une frise la colore.
public enum HarnessStepPhase: Sendable {
    case running, done, failed, escalated, other
}

extension HarnessTimelineStep {
    public var phase: HarnessStepPhase {
        switch status {
        case "running": .running
        case "done": .done
        case "failed": .failed
        case "escalated": .escalated
        default: .other
        }
    }
}

extension HarnessTestJob {
    /// Le job s'est terminé au vert.
    public var passed: Bool { outcome == "pass" }
}

/// Un job de tests sur la frise.
public struct HarnessTimelineTest: Codable, Equatable, Sendable {
    public var at: Double
    public var scope: String
    public var outcome: String
    public var cached: Bool
    public var attempts: Int
}

/// Une décision de l'agent sur la frise.
public struct HarnessTimelineDecision: Codable, Equatable, Sendable {
    public var at: Double
    public var seq: Int
    public var question: String
    public var chosen: String
    public var status: String
}

/// Un événement marquant sur la frise.
public struct HarnessTimelineEvent: Codable, Equatable, Sendable {
    public var at: Double
    public var type: String
    public var step: String?
    /// Ce que l'événement dit de plus parlant (raison, modèles, commit…), tel que le serveur l'écrit.
    public var summary: String?
    public var by: String?
}

/// La frise d'une feature (`GET /v1/runs/{id}/timeline`).
public struct HarnessTimeline: Codable, Equatable, Sendable {
    public var runId: String
    public var title: String
    public var state: String
    public var live: Bool
    public var createdAt: Double
    public var updatedAt: Double
    /// L'heure du serveur à la lecture : la fin d'une étape en cours.
    public var now: Double
    public var steps: [HarnessTimelineStep]
    public var tests: [HarnessTimelineTest]
    public var decisions: [HarnessTimelineDecision]
    public var events: [HarnessTimelineEvent]
    public var cost: Double
    public var costByStep: [String: Double]

    /// La durée d'une étape, en secondes (jusqu'à `now` pour une étape en cours).
    public func duration(of step: HarnessTimelineStep) -> Double {
        max(0, ((step.endedAt ?? now) - step.startedAt) / 1000)
    }
}

// MARK: - Fichiers touchés

/// Un fichier touché par une feature ; `added`/`removed` valent `nil` pour un binaire.
public struct HarnessFileChange: Codable, Equatable, Sendable, Identifiable {
    public var path: String
    /// `A` ajouté, `M` modifié, `D` supprimé.
    public var status: String
    public var added: Int?
    public var removed: Int?

    public init(path: String, status: String, added: Int? = nil, removed: Int? = nil) {
        self.path = path
        self.status = status
        self.added = added
        self.removed = removed
    }

    public var id: String { path }
    public var isBinary: Bool { added == nil && removed == nil }
}

/// Les fichiers touchés par une feature (`GET /v1/runs/{id}/changes`).
public struct HarnessChanges: Codable, Equatable, Sendable {
    public var runId: String
    /// `worktree` (en cours), `merge` (le commit fusionné), ou `nil` : rien à lire.
    public var source: String?
    public var files: [HarnessFileChange]
    public var added: Int
    public var removed: Int

    /// Les fichiers touchés (le nom que lit l'app iOS, qui n'a pas de section « Fichiers »).
    public var touched: [HarnessFileChange] { files }
}

/// Les différences d'un fichier (`GET /v1/runs/{id}/diff?path=…`).
public struct HarnessFileDiff: Codable, Equatable, Sendable {
    public var runId: String
    public var path: String
    public var diff: String
    public var truncated: Bool

    /// Les lignes, chacune avec sa sorte : ajout, retrait, en-tête de bloc ou contexte.
    public var lines: [HarnessDiffLine] {
        diff.split(separator: "\n", omittingEmptySubsequences: false).enumerated().compactMap { index, raw in
            let text = String(raw)
            if text.hasPrefix("diff --git") || text.hasPrefix("index ") || text.hasPrefix("--- ") || text.hasPrefix("+++ ") || text.hasPrefix("new file mode") || text.hasPrefix("deleted file mode") {
                return nil
            }
            let kind: HarnessDiffLine.Kind = text.hasPrefix("@@") ? .hunk : text.hasPrefix("+") ? .added : text.hasPrefix("-") ? .removed : .context
            return HarnessDiffLine(id: index, kind: kind, text: text)
        }
    }
}

/// Une ligne de différences.
public struct HarnessDiffLine: Equatable, Sendable, Identifiable {
    public enum Kind: Sendable { case added, removed, hunk, context }
    public var id: Int
    public var kind: Kind
    public var text: String
}

// MARK: - Tests en direct

/// Un job de tests d'une feature, sa sortie et son issue (`nil` tant qu'il tourne).
public struct HarnessTestJob: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var scope: String
    public var attempt: Int
    public var startedAt: Double
    public var endedAt: Double?
    public var outcome: String?
    public var output: String

    public init(id: Int, scope: String, attempt: Int = 1, startedAt: Double = 0, endedAt: Double? = nil, outcome: String? = nil, output: String = "") {
        self.id = id
        self.scope = scope
        self.attempt = attempt
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.outcome = outcome
        self.output = output
    }

    public var isRunning: Bool { outcome == nil }
}

/// Les derniers jobs de tests d'une feature (`GET /v1/runs/{id}/tests/live`).
public struct HarnessLiveTests: Codable, Equatable, Sendable {
    public var runId: String
    public var cursor: Int
    public var jobs: [HarnessTestJob]
}

/// Un morceau de sortie poussé sur le flux (`test_output`).
public struct HarnessTestOutput: Codable, Equatable, Sendable {
    public var jobId: Int
    public var scope: String
    public var attempt: Int
    public var chunk: String
    public var done: Bool
    public var outcome: String?
}

/// La sortie gardée d'un job par l'app (la fin, comme le serveur).
public enum HarnessTestOutputLimit {
    public static let characters = 16_000
}

extension Array where Element == HarnessTestJob {
    /// Un morceau reçu : il s'ajoute à son job (créé au besoin), qui se clôt sur `done`.
    public mutating func apply(_ output: HarnessTestOutput, at now: Double = Date().timeIntervalSince1970 * 1000) {
        if let index = firstIndex(where: { $0.id == output.jobId }) {
            self[index].output = String((self[index].output + output.chunk).suffix(HarnessTestOutputLimit.characters))
            if output.done {
                self[index].outcome = output.outcome
                self[index].endedAt = now
            }
        } else {
            append(HarnessTestJob(id: output.jobId, scope: output.scope, attempt: output.attempt, startedAt: now, endedAt: output.done ? now : nil, outcome: output.done ? output.outcome : nil, output: output.chunk))
        }
        sort { $0.id < $1.id }
        if count > 8 { removeFirst(count - 8) }
    }
}

// MARK: - Santé du serveur

/// Un point de la santé du serveur.
public struct HarnessMetricSample: Codable, Equatable, Sendable, Identifiable {
    public struct Slots: Codable, Equatable, Sendable {
        public var used: Int
        public var capacity: Int
        public var waiting: Int
    }

    public var at: Double
    public var runner: Slots
    public var heavy: Slots
    public var memAvailableMiB: Double?
    public var liveRuns: Int
    public var queuedRuns: Int
    public var admissionRefused: Int
    public var rateLimited: Int
    public var failovers: Int
    public var providerErrors: Int

    public var id: Double { at }
    public var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

/// La santé du serveur au fil du temps (`GET /v1/metrics`).
public struct HarnessMetrics: Codable, Equatable, Sendable {
    public var sampleSec: Int
    public var samples: [HarnessMetricSample]
}

// MARK: - Statistiques

/// La consommation des agents dans les statistiques.
public struct HarnessUsageStats: Codable, Equatable, Sendable {
    public struct Day: Codable, Equatable, Sendable, Identifiable {
        public var day: String
        public var messages: Int
        public var input: Int
        public var output: Int
        public var cost: Double

        public var id: String { day }
    }

    public var total: HarnessUsageTotals
    public var last7Days: HarnessUsageTotals
    /// Les 14 derniers jours qui ont consommé quelque chose.
    public var byDay: [Day]
    public var byRepo: [String: HarnessUsageTotals]
}

/// Un modèle, dans la comparaison des statistiques.
public struct HarnessModelStats: Codable, Equatable, Sendable, Identifiable {
    public var model: String
    public var steps: Int
    public var failed: Int
    public var medianSec: Double?
    public var impls: Int
    /// La part de ses implémentations qu'une revue a renvoyées en correction.
    public var correctedRate: Double?
    public var mergedRuns: Int
    public var cost: Double
    public var input: Int
    public var output: Int
    public var messages: Int

    public var id: String { model }
}

/// Une commande de tests instable : verte après un rouge sur le même arbre.
public struct HarnessFlakyTest: Codable, Equatable, Sendable, Identifiable {
    public var repo: String
    public var scope: String
    public var command: String
    public var count: Int
    public var lastAt: Double

    public var id: String { "\(repo)/\(command)" }
}

// MARK: - Lecture

extension HarnessAlert {
    /// L'alerte en une ligne, d'après sa sorte et ce qu'elle dit d'elle-même.
    public var line: String {
        switch sort {
        case .stalled:
            MonitoringText.alertStalled(minutes: detail.minutes, tool: detail.tool)
        case .stepSlow:
            MonitoringText.alertSlow(step: HarnessRun.label(forStep: detail.step ?? ""), minutes: detail.minutes, medianMin: detail.medianMin)
        case .fixLoop:
            MonitoringText.alertFixLoop(fixes: detail.fixes)
        case .budgetExceeded:
            MonitoringText.alertBudget(cost: detail.cost, threshold: detail.threshold, paused: detail.paused ?? false)
        case nil:
            MonitoringText.alertUnknown
        }
    }

    public var symbol: String { MonitoringText.alertSymbol(kind) }
}

extension HarnessTimeline {
    /// « /impl · terminée · 4 min · claude-sonnet » : une étape de la frise en une ligne.
    public func line(for step: HarnessTimelineStep) -> String {
        MonitoringText.stepLine(
            label: HarnessRun.label(forStep: step.kind),
            status: step.status,
            duration: PipelineServerText.duration(duration(of: step)),
            model: step.model
        )
    }

    /// « 2. /specs » : la ligne d'une étape sur l'axe du graphique.
    public func chartLabel(position: Int, step: HarnessTimelineStep) -> String {
        MonitoringText.chartStep(position: position, label: HarnessRun.label(forStep: step.kind))
    }

    /// Le coût d'une étape, ou rien si elle n'a rien coûté.
    public func costLine(for step: HarnessTimelineStep) -> String {
        costByStep[step.kind].map(MonitoringText.cost) ?? ""
    }
}

extension HarnessModelStats {
    /// « 12 étapes · 1 en échec · médiane 4 min »
    public var stepsLine: String {
        MonitoringText.modelSteps(steps: steps, failed: failed, median: medianSec.map(PipelineServerText.duration))
    }

    /// « 25 % corrigées · 3 fusionnées · 1,20 $ »
    public var outcomeLine: String {
        MonitoringText.modelOutcome(corrected: correctedRate.map(PipelineServerText.percent), merged: mergedRuns, cost: cost)
    }
}

extension HarnessFlakyTest {
    /// « demo · Suite complète · 3 fois, dernière le 24/10/2026 »
    public var line: String {
        MonitoringText.flakyRow(
            repo: repo,
            scope: scope,
            count: count,
            last: Date(timeIntervalSince1970: lastAt / 1000).formatted(date: .numeric, time: .omitted)
        )
    }
}

extension HarnessFileChange {
    /// « modifié · +12 −3 »
    public var line: String { MonitoringText.fileLine(status: status, added: added, removed: removed) }
}
