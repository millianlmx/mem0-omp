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
    /// En file, ce qui retient la feature (« slots runner pleins 5/5 ») ; sinon la raison
    /// de son attente ou de son échec.
    public var reason: String?
    /// En file seulement, la cause de ce qui la retient (`memory`, `slots`, `repo_cap`,
    /// `modules`, `daily_budget`, `unknown_repo`) ; absente quand rien ne la retient.
    public var waitCause: String?
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
    /// Le projet de la feature, ou `nil` pour une feature lancée seule.
    public var projectId: String?
    /// Le type de travail déclaré au lancement (`bug`, `feature`, `docs`, `deps`, `test`),
    /// ou `nil` : aucune règle d'autonomie ne s'applique alors à la feature.
    public var kind: String?
    /// Les labels déclarés au lancement (vides avec un serveur antérieur).
    public var labels: [String]
    /// La carte en tête des specs à valider ou d'un arbitrage (session en graphe), servie par `GET /v1/runs/{id}`
    /// et `GET /v1/inbox` seulement : `nil` ailleurs et d'un serveur antérieur ; vide (`feature` vide, aucune carte)
    /// quand le run n'attend ni specs ni arbitrage.
    public var briefing: HarnessBriefing? = nil
    /// La feature dont celle-ci est la suite (découpage, correction) ; `nil` sinon ou d'un serveur antérieur.
    public var afterRun: String? = nil
    /// La branche git de la feature (`harness/<slug>`) ; `nil` d'un serveur qui ne la sert pas.
    public var branch: String? = nil
    public var createdAt: Double
    public var updatedAt: Double

    public init(
        id: String, repo: String, slug: String, title: String, request: String, state: String, step: String? = nil,
        fixes: Int = 0, modules: [String] = [], verdict: HarnessVerdict? = nil, mergeSha: String? = nil,
        prUrl: String? = nil, reason: String? = nil, model: String? = nil, rev: Int? = nil, priority: Int? = nil,
        createdBy: String? = nil, mergeRetries: Int = 0, notBefore: Date? = nil, lastFailCause: String? = nil,
        projectId: String? = nil, createdAt: Double = 0, updatedAt: Double = 0, waitCause: String? = nil,
        kind: String? = nil, labels: [String] = [], briefing: HarnessBriefing? = nil, afterRun: String? = nil
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
        self.projectId = projectId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.waitCause = waitCause
        self.kind = kind
        self.labels = labels
        self.briefing = briefing
        self.afterRun = afterRun
    }

    private enum CodingKeys: String, CodingKey {
        case id, repo, slug, title, request, state, step, fixes, modules, verdict, mergeSha, prUrl, reason, model
        case rev, priority, createdBy, mergeRetries, notBefore, lastFailCause, projectId, createdAt, updatedAt, waitCause, kind, labels, briefing, afterRun, branch
    }

    /// Un serveur antérieur n'écrit ni `mergeRetries`, ni `notBefore`, ni `lastFailCause`,
    /// ni `kind`, ni `labels`, ni `briefing` : 0, `nil` et vide. `notBefore` est un instant en millisecondes.
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
        projectId = try container.decodeIfPresent(String.self, forKey: .projectId)
        createdAt = try container.decode(Double.self, forKey: .createdAt)
        updatedAt = try container.decode(Double.self, forKey: .updatedAt)
        waitCause = try container.decodeIfPresent(String.self, forKey: .waitCause)
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
        labels = try container.decodeIfPresent([String].self, forKey: .labels) ?? []
        briefing = try container.decodeIfPresent(HarnessBriefing.self, forKey: .briefing)
        afterRun = try container.decodeIfPresent(String.self, forKey: .afterRun)
        branch = try container.decodeIfPresent(String.self, forKey: .branch)
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
        try container.encodeIfPresent(projectId, forKey: .projectId)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encodeIfPresent(waitCause, forKey: .waitCause)
        try container.encodeIfPresent(kind, forKey: .kind)
        try container.encode(labels, forKey: .labels)
        try container.encodeIfPresent(briefing, forKey: .briefing)
        try container.encodeIfPresent(afterRun, forKey: .afterRun)
        try container.encodeIfPresent(branch, forKey: .branch)
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
    /// Une validation prise seule par l'autonomie par paliers : la porte franchie, la règle
    /// et les preuves constatées ; `nil` pour une décision d'agent ou d'un serveur antérieur.
    public var autonomy: HarnessAutonomyProof?

    public init(id: Int, runId: String, seq: Int, question: String, options: [String], chosen: String, rationale: String, context: String? = nil, impacts: [String] = [], step: String? = nil, category: String = "reversible", status: String = "auto", createdAt: Double = 0, autonomy: HarnessAutonomyProof? = nil) {
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
        self.autonomy = autonomy
    }

    private enum CodingKeys: String, CodingKey {
        case id, runId, seq, question, options, chosen, rationale, context, impacts, step, category, status, createdAt, autonomy
    }

    /// Un serveur antérieur n'écrit ni `context`, ni `impacts`, ni `step`, ni `autonomy` : `nil` et vide.
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
        autonomy = try container.decodeIfPresent(HarnessAutonomyProof.self, forKey: .autonomy)
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
    /// La carte de la question (session en graphe) : ce que l'humain lit en 30 secondes ; `nil` d'un serveur
    /// antérieur ou d'une escalade posée sans carte (l'affichage historique s'applique alors).
    public var card: HarnessCard?

    public init(id: Int, runId: String, category: String, question: String, options: [String], recommended: String? = nil, context: String? = nil, rationale: String? = nil, impacts: [String] = [], step: String? = nil, status: String = "open", card: HarnessCard? = nil) {
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
        self.card = card
    }

    private enum CodingKeys: String, CodingKey {
        case id, runId, category, question, options, recommended, context, rationale, impacts, step, status, card
    }

    /// Un serveur antérieur n'écrit ni `recommended`, ni `options`, ni `context`, ni
    /// `rationale`, ni `impacts`, ni `step`, ni `card` : `nil` et vide.
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
        card = try container.decodeIfPresent(HarnessCard.self, forKey: .card)
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
    public var pendingCount: Int { openBatches.reduce(0) { $0 + $1.items.count } + awaiting.count }

    /// Les lots d'escalades qu'on peut encore trancher : un serveur plus ancien sert aussi
    /// ceux d'une feature terminée (annulée, fusionnée, en échec), que plus rien n'attend.
    public var openBatches: [HarnessEscalationBatch] {
        batches.filter { batch in
            guard let phase = batch.run?.phase else { return true }
            return ![.merged, .cancelled, .failed].contains(phase)
        }
    }

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

/// Une preuve jointe à un run (`GET /v1/runs/{id}/proofs`) : capture, vidéo, log ou rapport de tests.
/// Le contenu s'obtient par `GET /v1/runs/{id}/proofs/{n}` ; le serveur ne donne jamais de chemin.
public struct HarnessProof: Codable, Equatable, Sendable, Identifiable {
    public var n: Int
    /// `screenshot`, `video`, `log` ou `test_report`.
    public var kind: String
    public var title: String
    /// L'étape qui l'a produite : `impl`, `fix` ou `review`.
    public var step: String
    public var mime: String
    public var size: Int
    /// En millisecondes depuis l'epoch.
    public var createdAt: Double
    /// Le critère d'acceptation (`AC-n`) que la preuve illustre.
    public var acRef: String?
    /// `before` (la base) ou `after` (le worktree du run), pour apparier des captures.
    public var side: String?

    public var id: Int { n }

    public init(n: Int, kind: String, title: String, step: String = "review", mime: String = "image/png", size: Int = 0, createdAt: Double = 0, acRef: String? = nil, side: String? = nil) {
        self.n = n
        self.kind = kind
        self.title = title
        self.step = step
        self.mime = mime
        self.size = size
        self.createdAt = createdAt
        self.acRef = acRef
        self.side = side
    }
}

/// Les preuves d'un run : l'enveloppe de `GET /v1/runs/{id}/proofs`.
public struct HarnessProofs: Codable, Equatable, Sendable {
    public var runId: String
    public var proofs: [HarnessProof]

    public init(runId: String, proofs: [HarnessProof] = []) {
        self.runId = runId
        self.proofs = proofs
    }
}

/// Le contenu d'une preuve `test_report` (omp-harness/test-report.ts) : le décompte
/// des tests par critère des specs du run, lu dans toute la sortie des tests.
public struct HarnessTestReport: Codable, Equatable, Sendable {
    /// `impl` ou `fix`.
    public var step: String
    /// `touched` ou `full`.
    public var scope: String
    /// `pass`, `fail`, `oom`, `timeout`, `error` ou `aborted`.
    public var outcome: String
    /// Vrai : le rapport vient d'un résultat servi par le cache, compté sur la fin
    /// gardée de la sortie ; des critères peuvent manquer.
    public var truncated: Bool
    public var criteria: [HarnessTestCriterion]
    /// Les tests hors des critères du run (autre slug, critère absent des specs, sans id).
    public var other: HarnessTestCount

    public init(step: String, scope: String = "touched", outcome: String = "pass", truncated: Bool = false, criteria: [HarnessTestCriterion] = [], other: HarnessTestCount = HarnessTestCount()) {
        self.step = step
        self.scope = scope
        self.outcome = outcome
        self.truncated = truncated
        self.criteria = criteria
        self.other = other
    }
}

/// Le décompte d'un critère d'un rapport de tests.
public struct HarnessTestCriterion: Codable, Equatable, Sendable, Identifiable {
    /// `<slug>/AC-n`, ou `AC-n` quand `slug` est nul.
    public var id: String
    public var slug: String?
    public var ac: String
    public var tests: Int
    public var passed: Int
    public var failed: Int

    public init(id: String, slug: String? = nil, ac: String, tests: Int = 0, passed: Int = 0, failed: Int = 0) {
        self.id = id
        self.slug = slug
        self.ac = ac
        self.tests = tests
        self.passed = passed
        self.failed = failed
    }
}

/// Un décompte de tests.
public struct HarnessTestCount: Codable, Equatable, Sendable {
    public var tests: Int
    public var passed: Int
    public var failed: Int

    public init(tests: Int = 0, passed: Int = 0, failed: Int = 0) {
        self.tests = tests
        self.passed = passed
        self.failed = failed
    }
}

/// Un dépôt déclaré sur le serveur (`GET /v1/status`).
/// Le client de ce jeton (`GET /v1/me`) : son nom, son rôle, ses dépôts.
public struct HarnessClient: Decodable, Equatable, Sendable {
    public var name: String
    /// `viewer` (lecture), `operator` (gestes et lancements) ou `admin`.
    public var role: String
    /// Les dépôts permis ; `nil` : tous (`"*"` côté serveur).
    public var repos: [String]?
    /// Le jeton est celui de l'approbateur (`harness.sh approver`) : il tranche les envois
    /// du poste. Faux avec un serveur antérieur aux approbateurs.
    public var approver: Bool

    public init(name: String, role: String, repos: [String]? = nil, approver: Bool = false) {
        self.name = name
        self.role = role
        self.repos = repos
        self.approver = approver
    }

    private enum CodingKeys: String, CodingKey { case name, role, repos, approver }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        role = try container.decode(String.self, forKey: .role)
        repos = try? container.decode([String].self, forKey: .repos)
        approver = (try? container.decode(Bool.self, forKey: .approver)) ?? false
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
