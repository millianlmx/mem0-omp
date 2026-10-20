// Le contrat du SERVEUR DE PIPELINES (omp-harness, sur le VPS) : les formes JSON de
// son protocole REST, décodées telles quelles (clés camelCase, instants en
// millisecondes). Les états restent des chaînes : un état que cette version de l'app
// ne connaît pas encore s'affiche « inconnu » au lieu de faire échouer tout le
// décodage.

import Foundation

/// Les états d'un run du serveur, dans l'ordre du chemin nominal.
public enum HarnessRunState: String, CaseIterable, Sendable {
    case queued
    case running
    case escalated
    case awaitingHuman = "awaiting_human"
    case merging
    case merged
    case failed
    case cancelled
}

/// Le verdict structuré d'une revue.
public struct HarnessVerdict: Codable, Equatable, Sendable {
    public var risk: String
    public var summary: String
    public var blockers: [String]
    public var risks: [String]
    public var files: [String]
    public var unverified: [String]
    public var confidence: String

    public init(risk: String, summary: String, blockers: [String], risks: [String], files: [String], unverified: [String], confidence: String) {
        self.risk = risk
        self.summary = summary
        self.blockers = blockers
        self.risks = risks
        self.files = files
        self.unverified = unverified
        self.confidence = confidence
    }

    /// Le risque est faible (la seule teinte calme du verdict).
    public var isLowRisk: Bool { risk == "low" }

    /// Le verdict est faible : l'humain lit le code, pas seulement le verdict.
    public var isWeak: Bool { confidence == "weak" || !unverified.isEmpty }
}

/// Une feature conduite par le serveur.
public struct HarnessRun: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var repo: String
    public var slug: String
    public var title: String
    public var request: String
    public var state: String
    public var step: String?
    public var fixes: Int
    public var modules: [String]
    public var verdict: HarnessVerdict?
    public var mergeSha: String?
    public var prUrl: String?
    public var reason: String?
    public var model: String?
    public var createdAt: Double
    public var updatedAt: Double

    public init(
        id: String, repo: String, slug: String, title: String, request: String, state: String, step: String? = nil,
        fixes: Int = 0, modules: [String] = [], verdict: HarnessVerdict? = nil, mergeSha: String? = nil,
        prUrl: String? = nil, reason: String? = nil, model: String? = nil, createdAt: Double = 0, updatedAt: Double = 0
    ) {
        self.id = id
        self.repo = repo
        self.slug = slug
        self.title = title
        self.request = request
        self.state = state
        self.step = step
        self.fixes = fixes
        self.modules = modules
        self.verdict = verdict
        self.mergeSha = mergeSha
        self.prUrl = prUrl
        self.reason = reason
        self.model = model
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// L'état connu, ou `nil` pour un état apparu après cette version de l'app.
    public var phase: HarnessRunState? { HarnessRunState(rawValue: state) }
}

/// Une décision prise seule par un runner : un point de reprise.
public struct HarnessDecision: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var runId: String
    public var seq: Int
    public var question: String
    public var options: [String]
    public var chosen: String
    public var rationale: String
    public var category: String
    public var status: String
    public var createdAt: Double

    public init(id: Int, runId: String, seq: Int, question: String, options: [String], chosen: String, rationale: String, category: String = "reversible", status: String = "auto", createdAt: Double = 0) {
        self.id = id
        self.runId = runId
        self.seq = seq
        self.question = question
        self.options = options
        self.chosen = chosen
        self.rationale = rationale
        self.category = category
        self.status = status
        self.createdAt = createdAt
    }

    /// Les options que l'humain peut choisir à la place.
    public var alternatives: [String] { options.filter { $0 != chosen } }
}

/// Une décision irréversible qu'un runner n'a pas prise : elle attend l'humain.
public struct HarnessEscalation: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var runId: String
    public var category: String
    public var question: String
    public var options: [String]
    public var context: String
    public var status: String

    public init(id: Int, runId: String, category: String, question: String, options: [String], context: String = "", status: String = "open") {
        self.id = id
        self.runId = runId
        self.category = category
        self.question = question
        self.options = options
        self.context = context
        self.status = status
    }
}

/// Les escalades ouvertes d'un run : elles se répondent ensemble.
public struct HarnessEscalationBatch: Codable, Equatable, Sendable, Identifiable {
    public var run: HarnessRun?
    public var items: [HarnessEscalation]

    public init(run: HarnessRun?, items: [HarnessEscalation]) {
        self.run = run
        self.items = items
    }

    public var id: String { run?.id ?? items.first?.runId ?? "" }
}

/// La boîte de l'humain, d'un seul appel (`GET /v1/inbox`).
public struct HarnessInbox: Codable, Equatable, Sendable {
    public var batches: [HarnessEscalationBatch]
    public var awaiting: [HarnessRun]
    public var decisions: [HarnessDecision]
    public var runs: [HarnessRun]
    /// Le dernier événement du journal : le flux s'abonne à partir de là.
    public var cursor: Int

    public init(batches: [HarnessEscalationBatch] = [], awaiting: [HarnessRun] = [], decisions: [HarnessDecision] = [], runs: [HarnessRun] = [], cursor: Int = 0) {
        self.batches = batches
        self.awaiting = awaiting
        self.decisions = decisions
        self.runs = runs
        self.cursor = cursor
    }

    /// Le run d'un identifiant (titre d'une décision, d'une escalade).
    public func run(_ id: String) -> HarnessRun? { runs.first { $0.id == id } }

    /// Les features en cours : ni terminées, ni en attente d'un geste (montrées ailleurs).
    public var active: [HarnessRun] {
        runs.filter { run in
            guard let phase = run.phase else { return true }
            return [.queued, .running, .merging].contains(phase)
        }
    }

    /// Ce qui attend l'humain : escalades, verdicts, décisions à relire.
    public var pendingCount: Int { batches.reduce(0) { $0 + $1.items.count } + awaiting.count + decisions.count }
}

/// L'accusé d'un geste : un objet JSON, quel que soit son contenu (`{ run }` ou
/// `{ decision }`) — la boîte relue fait foi.
struct HarnessAck: Decodable {}

/// Le corps d'erreur du serveur : `{ "error": "…" }`.
struct HarnessErrorBody: Decodable {
    var error: String
}
