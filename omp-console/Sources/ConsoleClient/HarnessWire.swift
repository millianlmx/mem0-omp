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
    /// La révision du run (+1 à chaque écriture) : renvoyée en `If-Match` avec un geste.
    /// `nil` avec un serveur antérieur aux clients multiples.
    public var rev: Int?
    /// La priorité d'admission (plus grand = plus tôt) ; `nil` avec un serveur antérieur.
    public var priority: Int?
    /// Le client qui a lancé la feature (`nil` : le service, ou le jeton historique).
    public var createdBy: String?
    /// Les fusions retentées après un refus (0 avec un serveur antérieur).
    public var mergeRetries: Int
    /// En file : l'instant avant lequel le serveur ne reprend pas (délai après un échec relançable).
    public var notBefore: Date?
    /// La cause du dernier échec d'étape (`timeout`, `rate_limit`, `network`…), ou `nil`.
    public var lastFailCause: String?
    public var createdAt: Double
    public var updatedAt: Double

    public init(
        id: String, repo: String, slug: String, title: String, request: String, state: String, step: String? = nil,
        fixes: Int = 0, modules: [String] = [], verdict: HarnessVerdict? = nil, mergeSha: String? = nil,
        prUrl: String? = nil, reason: String? = nil, model: String? = nil, rev: Int? = nil, priority: Int? = nil,
        createdBy: String? = nil, mergeRetries: Int = 0, notBefore: Date? = nil, lastFailCause: String? = nil,
        createdAt: Double = 0, updatedAt: Double = 0
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
        self.rev = rev
        self.priority = priority
        self.createdBy = createdBy
        self.mergeRetries = mergeRetries
        self.notBefore = notBefore
        self.lastFailCause = lastFailCause
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, repo, slug, title, request, state, step, fixes, modules, verdict, mergeSha, prUrl, reason, model
        case rev, priority, createdBy, mergeRetries, notBefore, lastFailCause, createdAt, updatedAt
    }

    /// Un serveur antérieur n'écrit ni `mergeRetries`, ni `notBefore`, ni `lastFailCause` :
    /// 0 et `nil`. `notBefore` est un instant en millisecondes.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        repo = try container.decode(String.self, forKey: .repo)
        slug = try container.decode(String.self, forKey: .slug)
        title = try container.decode(String.self, forKey: .title)
        request = try container.decode(String.self, forKey: .request)
        state = try container.decode(String.self, forKey: .state)
        step = try container.decodeIfPresent(String.self, forKey: .step)
        fixes = try container.decode(Int.self, forKey: .fixes)
        modules = try container.decode([String].self, forKey: .modules)
        verdict = try container.decodeIfPresent(HarnessVerdict.self, forKey: .verdict)
        mergeSha = try container.decodeIfPresent(String.self, forKey: .mergeSha)
        prUrl = try container.decodeIfPresent(String.self, forKey: .prUrl)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        rev = try container.decodeIfPresent(Int.self, forKey: .rev)
        priority = try container.decodeIfPresent(Int.self, forKey: .priority)
        createdBy = try container.decodeIfPresent(String.self, forKey: .createdBy)
        mergeRetries = try container.decodeIfPresent(Int.self, forKey: .mergeRetries) ?? 0
        notBefore = try container.decodeIfPresent(Double.self, forKey: .notBefore).map { Date(timeIntervalSince1970: $0 / 1000) }
        lastFailCause = try container.decodeIfPresent(String.self, forKey: .lastFailCause)
        createdAt = try container.decode(Double.self, forKey: .createdAt)
        updatedAt = try container.decode(Double.self, forKey: .updatedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(repo, forKey: .repo)
        try container.encode(slug, forKey: .slug)
        try container.encode(title, forKey: .title)
        try container.encode(request, forKey: .request)
        try container.encode(state, forKey: .state)
        try container.encodeIfPresent(step, forKey: .step)
        try container.encode(fixes, forKey: .fixes)
        try container.encode(modules, forKey: .modules)
        try container.encodeIfPresent(verdict, forKey: .verdict)
        try container.encodeIfPresent(mergeSha, forKey: .mergeSha)
        try container.encodeIfPresent(prUrl, forKey: .prUrl)
        try container.encodeIfPresent(reason, forKey: .reason)
        try container.encodeIfPresent(model, forKey: .model)
        try container.encodeIfPresent(rev, forKey: .rev)
        try container.encodeIfPresent(priority, forKey: .priority)
        try container.encodeIfPresent(createdBy, forKey: .createdBy)
        try container.encode(mergeRetries, forKey: .mergeRetries)
        try container.encodeIfPresent(notBefore.map { ($0.timeIntervalSince1970 * 1000).rounded() }, forKey: .notBefore)
        try container.encodeIfPresent(lastFailCause, forKey: .lastFailCause)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }

    /// L'état connu, ou `nil` pour un état apparu après cette version de l'app.
    public var phase: HarnessRunState? { HarnessRunState(rawValue: state) }

    /// Le run attend la validation de ses SPECS (avant /impl), pas d'un verdict.
    public var awaitsSpecs: Bool { phase == .awaitingHuman && step == "specs" }

    /// Le run peut repartir de son étape : en échec, ou arrêté sur une attente de l'humain.
    public var canRetry: Bool { phase == .failed || phase == .awaitingHuman }

    /// Le run est fusionné : sa feature peut être annulée (commit inverse sur la branche principale).
    public var canRevert: Bool { phase == .merged }
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
    /// La situation donnée par l'agent, en Markdown ; `nil` d'un serveur antérieur.
    public var context: String?
    /// Ce qu'emporte chaque option, dans l'ordre de `options` ; vide si l'agent ne l'a pas dit.
    public var impacts: [String]
    /// L'étape qui a pris la décision (`req`, `specs`, `impl`…) ; `nil` d'un serveur antérieur.
    public var step: String?
    public var category: String
    public var status: String
    public var createdAt: Double

    public init(id: Int, runId: String, seq: Int, question: String, options: [String], chosen: String, rationale: String, context: String? = nil, impacts: [String] = [], step: String? = nil, category: String = "reversible", status: String = "auto", createdAt: Double = 0) {
        self.id = id
        self.runId = runId
        self.seq = seq
        self.question = question
        self.options = options
        self.chosen = chosen
        self.rationale = rationale
        self.context = context
        self.impacts = impacts
        self.step = step
        self.category = category
        self.status = status
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, runId, seq, question, options, chosen, rationale, context, impacts, step, category, status, createdAt
    }

    /// Un serveur antérieur n'écrit ni `context`, ni `impacts`, ni `step` : `nil` et vide.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        runId = try container.decode(String.self, forKey: .runId)
        seq = try container.decode(Int.self, forKey: .seq)
        question = try container.decode(String.self, forKey: .question)
        options = try container.decode([String].self, forKey: .options)
        chosen = try container.decode(String.self, forKey: .chosen)
        rationale = try container.decode(String.self, forKey: .rationale)
        context = try container.decodeIfPresent(String.self, forKey: .context)
        impacts = try container.decodeIfPresent([String].self, forKey: .impacts) ?? []
        step = try container.decodeIfPresent(String.self, forKey: .step)
        category = try container.decode(String.self, forKey: .category)
        status = try container.decode(String.self, forKey: .status)
        createdAt = try container.decode(Double.self, forKey: .createdAt)
    }

    /// Le contexte donné par l'agent, s'il en a donné un.
    public var shownContext: String? { HarnessQuestion.shown(context) }

    /// Chaque option avec son impact, dans l'ordre de l'agent ; l'option retenue est marquée.
    public var choices: [HarnessChoice] {
        HarnessChoice.of(options: options, impacts: impacts, preferred: chosen)
    }

    /// La décision a été tranchée par le serveur à l'échéance d'une escalade restée sans réponse.
    public var decidedAtDeadline: Bool { status == "auto_timeout" }

    /// Les options que l'humain peut choisir à la place.
    public var alternatives: [String] { options.filter { $0 != chosen } }
}

/// Une décision irréversible qu'un runner n'a pas prise : elle attend l'humain.
public struct HarnessEscalation: Codable, Equatable, Sendable, Identifiable {
    public var id: Int
    public var runId: String
    public var category: String
    public var question: String
    /// Les options proposées (vide avec un serveur antérieur).
    public var options: [String]
    /// L'option que l'agent aurait choisie : la réponse présélectionnée dans les apps.
    public var recommended: String?
    /// La situation donnée par l'agent, en Markdown. Sur un serveur antérieur : sa raison.
    public var context: String?
    /// Pourquoi l'agent recommande `recommended` ; `nil` d'un serveur antérieur.
    public var rationale: String?
    /// Ce qu'emporte chaque option, dans l'ordre de `options` ; vide d'un serveur antérieur.
    public var impacts: [String]
    /// L'étape qui a posé la question (`req`, `specs`, `impl`…) ; `nil` d'un serveur antérieur.
    public var step: String?
    public var status: String

    public init(id: Int, runId: String, category: String, question: String, options: [String], recommended: String? = nil, context: String? = nil, rationale: String? = nil, impacts: [String] = [], step: String? = nil, status: String = "open") {
        self.id = id
        self.runId = runId
        self.category = category
        self.question = question
        self.options = options
        self.recommended = recommended
        self.context = context
        self.rationale = rationale
        self.impacts = impacts
        self.step = step
        self.status = status
    }

    private enum CodingKeys: String, CodingKey {
        case id, runId, category, question, options, recommended, context, rationale, impacts, step, status
    }

    /// Un serveur antérieur n'écrit ni `recommended`, ni `options`, ni `context`, ni
    /// `rationale`, ni `impacts`, ni `step` : `nil` et vide.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        runId = try container.decode(String.self, forKey: .runId)
        category = try container.decode(String.self, forKey: .category)
        question = try container.decode(String.self, forKey: .question)
        options = try container.decodeIfPresent([String].self, forKey: .options) ?? []
        recommended = try container.decodeIfPresent(String.self, forKey: .recommended)
        context = try container.decodeIfPresent(String.self, forKey: .context)
        rationale = try container.decodeIfPresent(String.self, forKey: .rationale)
        impacts = try container.decodeIfPresent([String].self, forKey: .impacts) ?? []
        step = try container.decodeIfPresent(String.self, forKey: .step)
        status = try container.decode(String.self, forKey: .status)
    }

    /// Le contexte donné par l'agent, s'il en a donné un.
    public var shownContext: String? { HarnessQuestion.shown(context) }

    /// La raison de la recommandation, si l'agent l'a séparée du contexte.
    public var shownRationale: String? { HarnessQuestion.shown(rationale) }

    /// Chaque option avec son impact, dans l'ordre de l'agent ; la recommandée est marquée.
    public var choices: [HarnessChoice] {
        HarnessChoice.of(options: options, impacts: impacts, preferred: recommended)
    }
}

/// Une option d'une question, avec ce qu'elle emporte.
public struct HarnessChoice: Equatable, Sendable, Identifiable {
    public var option: String
    /// Ce qu'emporte l'option, si l'agent l'a dit.
    public var impact: String?
    /// L'option recommandée (escalade) ou retenue (décision).
    public var isPreferred: Bool

    public init(option: String, impact: String? = nil, isPreferred: Bool = false) {
        self.option = option
        self.impact = impact
        self.isPreferred = isPreferred
    }

    public var id: String { option }

    /// Les options dans l'ordre de l'agent, chacune avec son impact quand la liste
    /// les suit une à une (sinon aucun : un impact mal aligné tromperait le lecteur).
    static func of(options: [String], impacts: [String], preferred: String?) -> [HarnessChoice] {
        let aligned = impacts.count == options.count
        return options.enumerated().map { index, option in
            let impact = aligned ? HarnessQuestion.shown(impacts[index]) : nil
            return HarnessChoice(option: option, impact: impact, isPreferred: option == preferred)
        }
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

    /// Le serveur ne prend les réponses qu'à la fin de l'étape (run `escalated`) : avant,
    /// l'agent termine ce qui n'en dépend pas, et un envoi serait refusé (409). Sans le
    /// run, rien ne permet d'en juger : le lot reste ouvert.
    public var acceptsAnswers: Bool { run.map { $0.state == "escalated" } ?? true }
}

/// Une proposition d'audit : une faiblesse à corriger ou une feature à construire.
public struct HarnessAuditProposal: Codable, Equatable, Sendable {
    public var title: String
    public var request: String
    public var modules: [String]
    public var kind: String
    public var rationale: String

    public init(title: String, request: String, modules: [String] = [], kind: String, rationale: String) {
        self.title = title
        self.request = request
        self.modules = modules
        self.kind = kind
        self.rationale = rationale
    }

    /// Une faiblesse du code existant (sinon une feature qui manque).
    public var isWeakness: Bool { kind == "faiblesse" }
}

/// Un audit d'un dépôt : `queued` → `analysing` → `proposed`, puis `launched` en projet.
public struct HarnessAudit: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var repo: String
    public var focus: String
    public var state: String
    public var proposals: [HarnessAuditProposal]
    public var projectId: String?
    public var reason: String?
    public var createdAt: Double

    public init(id: String, repo: String, focus: String = "", state: String, proposals: [HarnessAuditProposal] = [], projectId: String? = nil, reason: String? = nil, createdAt: Double = 0) {
        self.id = id
        self.repo = repo
        self.focus = focus
        self.state = state
        self.proposals = proposals
        self.projectId = projectId
        self.reason = reason
        self.createdAt = createdAt
    }

    /// Les propositions attendent le choix de l'humain.
    public var isProposed: Bool { state == "proposed" }
    /// L'analyse n'est pas finie : l'audit peut encore être annulé.
    public var isOpen: Bool { state == "queued" || state == "analysing" || state == "proposed" }
}

/// Le décompte des runs d'un projet par état.
public struct HarnessRunCount: Codable, Equatable, Sendable {
    public var total: Int
    public var byState: [String: Int]

    public init(total: Int = 0, byState: [String: Int] = [:]) {
        self.total = total
        self.byState = byState
    }

    public func count(_ state: HarnessRunState) -> Int { byState[state.rawValue] ?? 0 }
}

/// Un projet : des features planifiées par modules.
public struct HarnessProject: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var repo: String
    public var title: String
    public var status: String
    public var createdAt: Double
    public var runs: HarnessRunCount

    public init(id: String, repo: String, title: String, status: String = "active", createdAt: Double = 0, runs: HarnessRunCount = HarnessRunCount()) {
        self.id = id
        self.repo = repo
        self.title = title
        self.status = status
        self.createdAt = createdAt
        self.runs = runs
    }

    public var isDone: Bool { status == "done" }
}

/// Une étape, dans les statistiques : combien, combien en échec, durée médiane.
public struct HarnessStepStats: Codable, Equatable, Sendable {
    public var count: Int
    public var failed: Int
    public var medianSec: Double?

    public init(count: Int, failed: Int, medianSec: Double? = nil) {
        self.count = count
        self.failed = failed
        self.medianSec = medianSec
    }
}

/// Les statistiques du serveur (`GET /v1/stats`).
public struct HarnessStats: Codable, Equatable, Sendable {
    public struct Runs: Codable, Equatable, Sendable {
        /// Un jour de la série : runs créés, et mergés ou échoués ce jour-là.
        public struct Day: Codable, Equatable, Sendable, Identifiable {
            /// Le jour UTC, `2026-10-24`.
            public var day: String
            public var created: Int
            public var merged: Int
            public var failed: Int

            public init(day: String, created: Int = 0, merged: Int = 0, failed: Int = 0) {
                self.day = day
                self.created = created
                self.merged = merged
                self.failed = failed
            }

            public var id: String { day }
        }

        /// Les runs d'un dépôt.
        public struct Repo: Codable, Equatable, Sendable {
            public var total: Int
            public var active: Int
            public var merged: Int
            public var failed: Int
            public var mergedLast7Days: Int

            public init(total: Int = 0, active: Int = 0, merged: Int = 0, failed: Int = 0, mergedLast7Days: Int = 0) {
                self.total = total
                self.active = active
                self.merged = merged
                self.failed = failed
                self.mergedLast7Days = mergedLast7Days
            }
        }

        public var total: Int
        public var byState: [String: Int]
        public var mergedLast7Days: Int
        public var mergeRate: Double?
        public var medianLeadSec: Double?
        public var fixesPerMerged: Double?
        /// Les 14 derniers jours, chacun présent ; absent d'un serveur plus ancien.
        public var byDay: [Day]?
        /// Par dépôt ; absent d'un serveur plus ancien.
        public var byRepo: [String: Repo]?

        public init(total: Int = 0, byState: [String: Int] = [:], mergedLast7Days: Int = 0, mergeRate: Double? = nil, medianLeadSec: Double? = nil, fixesPerMerged: Double? = nil, byDay: [Day]? = nil, byRepo: [String: Repo]? = nil) {
            self.total = total
            self.byState = byState
            self.mergedLast7Days = mergedLast7Days
            self.mergeRate = mergeRate
            self.medianLeadSec = medianLeadSec
            self.fixesPerMerged = fixesPerMerged
            self.byDay = byDay
            self.byRepo = byRepo
        }
    }

    public struct Tests: Codable, Equatable, Sendable {
        public var total: Int
        public var cached: Int
        public var byOutcome: [String: Int]
        public var retried: Int
        /// Les commandes instables (vertes après un rouge) ; absent d'un serveur plus ancien.
        public var flaky: [HarnessFlakyTest]?

        public init(total: Int = 0, cached: Int = 0, byOutcome: [String: Int] = [:], retried: Int = 0, flaky: [HarnessFlakyTest]? = nil) {
            self.total = total
            self.cached = cached
            self.byOutcome = byOutcome
            self.retried = retried
            self.flaky = flaky
        }
    }

    public struct Slots: Codable, Equatable, Sendable {
        public var used: Int
        public var capacity: Int

        public init(used: Int = 0, capacity: Int = 0) {
            self.used = used
            self.capacity = capacity
        }
    }

    public struct Scheduler: Codable, Equatable, Sendable {
        public var runner: Slots
        public var heavy: Slots
        public var memAvailableMiB: Double?

        public init(runner: Slots = Slots(), heavy: Slots = Slots(), memAvailableMiB: Double? = nil) {
            self.runner = runner
            self.heavy = heavy
            self.memAvailableMiB = memAvailableMiB
        }
    }

    public var runs: Runs
    /// Par étape (`req`, `specs`, `impl`, `review`, `fix`).
    public var steps: [String: HarnessStepStats]
    public var tests: Tests
    public var decisions: [String: Int]
    public var escalations: [String: Int]
    public var audits: [String: Int]
    public var scheduler: Scheduler
    /// La consommation des agents ; absente d'un serveur plus ancien.
    public var usage: HarnessUsageStats?
    /// La comparaison des modèles ; absente d'un serveur plus ancien.
    public var models: [HarnessModelStats]?

    public init(runs: Runs = Runs(), steps: [String: HarnessStepStats] = [:], tests: Tests = Tests(), decisions: [String: Int] = [:], escalations: [String: Int] = [:], audits: [String: Int] = [:], scheduler: Scheduler = Scheduler(), usage: HarnessUsageStats? = nil, models: [HarnessModelStats]? = nil) {
        self.runs = runs
        self.steps = steps
        self.tests = tests
        self.decisions = decisions
        self.escalations = escalations
        self.audits = audits
        self.scheduler = scheduler
        self.usage = usage
        self.models = models
    }
}

/// La boîte de l'humain, d'un seul appel (`GET /v1/inbox`).
public struct HarnessInbox: Codable, Equatable, Sendable {
    public var batches: [HarnessEscalationBatch]
    public var awaiting: [HarnessRun]
    public var decisions: [HarnessDecision]
    public var runs: [HarnessRun]
    /// Les audits ouverts (en analyse, ou dont les propositions attendent un choix).
    public var audits: [HarnessAudit]
    /// Le dernier événement du journal : le flux s'abonne à partir de là.
    public var cursor: Int
    /// Les alertes en cours de la veille du serveur (agent muet, étape lente…).
    public var alerts: [HarnessAlert]
    /// Le coût de chaque feature listée qui a consommé quelque chose, en dollars.
    public var costs: [String: Double]

    public init(batches: [HarnessEscalationBatch] = [], awaiting: [HarnessRun] = [], decisions: [HarnessDecision] = [], runs: [HarnessRun] = [], audits: [HarnessAudit] = [], cursor: Int = 0, alerts: [HarnessAlert] = [], costs: [String: Double] = [:]) {
        self.batches = batches
        self.awaiting = awaiting
        self.decisions = decisions
        self.runs = runs
        self.audits = audits
        self.cursor = cursor
        self.alerts = alerts
        self.costs = costs
    }

    private enum CodingKeys: String, CodingKey {
        case batches, awaiting, decisions, runs, audits, cursor, alerts, costs
    }

    /// Un serveur plus ancien n'écrit ni `audits`, ni `alerts`, ni `costs` : ils sont alors vides.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        batches = try container.decode([HarnessEscalationBatch].self, forKey: .batches)
        awaiting = try container.decode([HarnessRun].self, forKey: .awaiting)
        decisions = try container.decode([HarnessDecision].self, forKey: .decisions)
        runs = try container.decode([HarnessRun].self, forKey: .runs)
        audits = try container.decodeIfPresent([HarnessAudit].self, forKey: .audits) ?? []
        cursor = try container.decode(Int.self, forKey: .cursor)
        alerts = try container.decodeIfPresent([HarnessAlert].self, forKey: .alerts) ?? []
        costs = try container.decodeIfPresent([String: Double].self, forKey: .costs) ?? [:]
    }

    /// Les alertes en cours d'une feature.
    public func alerts(of runId: String) -> [HarnessAlert] { alerts.filter { $0.runId == runId } }

    /// Les runs dont les SPECS attendent la validation (avant /impl).
    public var specsAwaiting: [HarnessRun] { awaiting.filter(\.awaitsSpecs) }
    /// Les runs dont le VERDICT de revue attend la validation.
    public var verdictsAwaiting: [HarnessRun] { awaiting.filter { !$0.awaitsSpecs } }
    /// Les audits dont les propositions attendent un choix.
    public var auditsProposed: [HarnessAudit] { audits.filter(\.isProposed) }

    /// Le run d'un identifiant (titre d'une décision, d'une escalade).
    public func run(_ id: String) -> HarnessRun? { runs.first { $0.id == id } }

    /// Les features en cours : ni terminées, ni en attente d'un geste (montrées ailleurs).
    public var active: [HarnessRun] {
        runs.filter { run in
            guard let phase = run.phase else { return true }
            return [.queued, .running, .merging].contains(phase)
        }
    }

    /// Ce qui BLOQUE une feature tant que l'humain n'a pas agi : escalades ouvertes, specs
    /// et verdicts à valider. Les décisions prises seules (relues après coup) et les audits
    /// à trier n'y entrent pas : ils ont leurs propres compteurs.
    public var pendingCount: Int { batches.reduce(0) { $0 + $1.items.count } + awaiting.count }

    /// Les runs qui ont des décisions à relire, dans l'ordre de la boîte, sans doublon.
    public var decisionRunIds: [String] {
        var seen = Set<String>()
        return decisions.map(\.runId).filter { seen.insert($0).inserted }
    }
}

/// Un artefact d'étape (`req.md`, `specs.md`, `impl.md`).
public struct HarnessArtifact: Codable, Equatable, Sendable {
    public var name: String
    public var content: String

    public init(name: String, content: String) {
        self.name = name
        self.content = content
    }
}

/// La vue d'un run (`GET /v1/runs/{id}`) : ce que l'app lit pour valider les specs.
public struct HarnessRunView: Codable, Equatable, Sendable {
    public var run: HarnessRun
    public var artifacts: [HarnessArtifact]
    /// La consommation du run ; absente d'un serveur plus ancien.
    public var usage: HarnessRunUsage?
    public var budget: HarnessBudget?
    public var alerts: [HarnessAlert]?

    public init(run: HarnessRun, artifacts: [HarnessArtifact] = [], usage: HarnessRunUsage? = nil, budget: HarnessBudget? = nil, alerts: [HarnessAlert]? = nil) {
        self.run = run
        self.artifacts = artifacts
        self.usage = usage
        self.budget = budget
        self.alerts = alerts
    }

    public func artifact(_ name: String) -> String? { artifacts.first { $0.name == name }?.content }

    /// Les specs du run (`specs.md`), à valider avant /impl.
    public var specs: String? { artifact("specs.md") }
}

/// Un dépôt déclaré sur le serveur (`GET /v1/status`).
/// Le client de ce jeton (`GET /v1/me`) : son nom, son rôle, ses dépôts.
public struct HarnessClient: Decodable, Equatable, Sendable {
    public var name: String
    /// `viewer` (lecture), `operator` (gestes et lancements) ou `admin`.
    public var role: String
    /// Les dépôts permis ; `nil` : tous (`"*"` côté serveur).
    public var repos: [String]?

    public init(name: String, role: String, repos: [String]? = nil) {
        self.name = name
        self.role = role
        self.repos = repos
    }

    private enum CodingKeys: String, CodingKey { case name, role, repos }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        role = try container.decode(String.self, forKey: .role)
        repos = try? container.decode([String].self, forKey: .repos)
    }

    /// Le rôle permet les gestes et les lancements (un lecteur ne voit que la boîte).
    public var canAct: Bool { role != "viewer" }
}

/// La réponse de `GET /v1/me`.
public struct HarnessMe: Decodable, Equatable, Sendable {
    public var client: HarnessClient
}

public struct HarnessRepo: Codable, Equatable, Sendable, Identifiable {
    public var name: String
    public var scope: String

    public init(name: String, scope: String = "") {
        self.name = name
        self.scope = scope
    }

    public var id: String { name }
}

struct HarnessStatus: Decodable {
    var repos: [HarnessRepo]
}

struct HarnessProjects: Decodable {
    var projects: [HarnessProject]
}

struct HarnessAudits: Decodable {
    var audits: [HarnessAudit]
}

struct HarnessRunReply: Decodable {
    var run: HarnessRun
}

struct HarnessAuditReply: Decodable {
    var audit: HarnessAudit
}

struct HarnessProjectReply: Decodable {
    var projectId: String
}

/// L'accusé d'un geste : un objet JSON, quel que soit son contenu (`{ run }` ou
/// `{ decision }`) — la boîte relue fait foi.
struct HarnessAck: Decodable {}

/// Le corps d'erreur du serveur : `{ "error": "…" }`.
struct HarnessErrorBody: Decodable {
    var error: String
}
