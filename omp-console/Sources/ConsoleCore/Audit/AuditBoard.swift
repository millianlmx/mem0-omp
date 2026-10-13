// La dérivation PURE de la section Audit (audit-panel-in-omp-console S-5) : d'un
// instantané du magasin, une carte par audit — ses propositions, l'avancement de
// ses features, ses questions en attente et les décisions de l'arbitre.
//
// Même patron que `KanbanBoard` : la coque macOS et l'app iOS dérivent la MÊME
// ardoise du même instantané (celui de l'iPhone arrive par la trame `store`).
// Aucun mot ici : les libellés sont `AuditText`.
//
// VIT DANS `ConsoleCore`.

/// L'état d'attente d'une feature lancée par un audit, par priorité :
/// l'escalade, puis l'arbitrage en vol, puis l'état de la feature.
public enum AuditWaiting: String, Sendable, Equatable, Codable {
    case escalated, arbitrating, notStarted, running, waiting, blocked, failed, prCreated, done, cancelled

    /// `state == nil` (aucun état connu : ni feature vivante, ni suivi recopié)
    /// se lit « en attente de démarrage ».
    public static func of(state: LotFeatureState?, prUrl: String?, escalated: Bool, arbitrating: Bool) -> AuditWaiting {
        if escalated { return .escalated }
        if arbitrating { return .arbitrating }
        switch state {
        case nil, .pending: return .notStarted
        case .running: return .running
        case .waiting: return .waiting
        case .blocked: return .blocked
        case .failed: return .failed
        case .done: return prUrl == nil ? .done : .prCreated
        case .cancelled: return .cancelled
        }
    }
}

/// La sorte d'une escalade, d'après le préfixe de sa clé (avant le premier `:`)
/// — c'est elle qui décide de la réponse attendue : une réponse libre ou une
/// option (`ask`, `question`), une décision de jalon (`specs`, `review`).
public enum AuditEscalationKind: String, Sendable, Equatable, Codable {
    case ask, question, specs, review

    /// `nil` pour une clé hors de ces quatre sortes : le service ne sait pas y
    /// répondre depuis la section Audit.
    public init?(key: String) {
        guard let prefix = key.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first else { return nil }
        self.init(rawValue: String(prefix))
    }

    /// Une décision de jalon (approuver ou abandonner) plutôt qu'une réponse.
    public var isMilestone: Bool { self == .specs || self == .review }
}

/// Une proposition à cocher. `taken` : son slug existe déjà dans un lot du même
/// dépôt — la case est désactivée.
public struct AuditProposalRow: Sendable, Equatable, Identifiable {
    public var kind: AuditProposalKind
    public var slug: String
    public var intention: String
    public var deps: [String]
    public var taken: Bool

    public var id: String { slug }

    public init(kind: AuditProposalKind, slug: String, intention: String, deps: [String], taken: Bool) {
        self.kind = kind
        self.slug = slug
        self.intention = intention
        self.deps = deps
        self.taken = taken
    }
}

/// L'avancement d'une feature lancée par l'audit.
public struct AuditFeatureRow: Sendable, Equatable, Identifiable {
    public var slug: String
    public var phase: PipelinePhase?
    public var waiting: AuditWaiting
    public var prUrl: String?

    public var id: String { slug }

    public init(slug: String, phase: PipelinePhase?, waiting: AuditWaiting, prUrl: String?) {
        self.slug = slug
        self.phase = phase
        self.waiting = waiting
        self.prUrl = prUrl
    }
}

/// Une question que l'arbitre n'a pas pu trancher : elle attend l'utilisateur.
public struct AuditEscalationRow: Sendable, Equatable, Identifiable {
    public var slug: String
    /// La clé de l'élément escaladé, renvoyée telle quelle avec la réponse.
    public var key: String
    public var kind: AuditEscalationKind
    public var phase: PipelinePhase
    public var question: String
    public var options: [String]
    public var reason: String
    public var at: Double

    public var id: String { key }

    public init(slug: String, key: String, kind: AuditEscalationKind, phase: PipelinePhase, question: String, options: [String], reason: String, at: Double) {
        self.slug = slug
        self.key = key
        self.kind = kind
        self.phase = phase
        self.question = question
        self.options = options
        self.reason = reason
        self.at = at
    }
}

/// Un audit, prêt à afficher.
public struct AuditCard: Sendable, Equatable, Identifiable {
    public var id: String
    public var repoRoot: String
    /// Le dernier composant de `repoRoot`.
    public var repoName: String
    public var orientation: String
    public var status: AuditStatus
    public var createdAt: Double
    public var failure: String?
    /// Le brief à relire (`proposal.briefDraft`), `nil` avant les propositions.
    public var briefDraft: String?
    /// Faiblesses puis features, dans l'ordre de l'analyse.
    public var proposals: [AuditProposalRow]
    /// Les propositions cochées NON lancées, avec leur motif (`launched == false`).
    public var launches: [AuditLaunchOutcome]
    /// Une rangée par proposition lancée, dans l'ordre de lancement.
    public var features: [AuditFeatureRow]
    /// Les escalades des features de CET audit seulement, la plus ancienne d'abord.
    public var escalations: [AuditEscalationRow]
    /// Les décisions de l'arbitre dans le contexte de cet audit, la plus récente d'abord.
    public var decisions: [AuditDecision]

    public init(id: String, repoRoot: String, repoName: String, orientation: String, status: AuditStatus, createdAt: Double, failure: String?, briefDraft: String?, proposals: [AuditProposalRow], launches: [AuditLaunchOutcome], features: [AuditFeatureRow], escalations: [AuditEscalationRow], decisions: [AuditDecision]) {
        self.id = id
        self.repoRoot = repoRoot
        self.repoName = repoName
        self.orientation = orientation
        self.status = status
        self.createdAt = createdAt
        self.failure = failure
        self.briefDraft = briefDraft
        self.proposals = proposals
        self.launches = launches
        self.features = features
        self.escalations = escalations
        self.decisions = decisions
    }
}

/// L'ardoise de la section Audit.
public struct AuditBoard: Sendable, Equatable {
    /// Le plus récent d'abord.
    public var audits: [AuditCard]

    public init(audits: [AuditCard]) {
        self.audits = audits
    }

    public func card(id: String?) -> AuditCard? {
        guard let id else { return nil }
        return audits.first { $0.id == id }
    }

    /// Dérive l'ardoise d'un instantané. Une feature « vivante » d'un audit est
    /// une feature de n'importe quel lot dont `auditSession` est la clé de l'audit :
    /// c'est elle qui fait foi, sinon le dernier état recopié dans `launches`.
    public static func of(_ snapshot: StoreSnapshot) -> AuditBoard {
        let lots = snapshot.lots.lots
        var liveByKey: [String: [LotFeature]] = [:]
        for lot in lots {
            for feature in lot.features {
                guard let key = feature.auditSession else { continue }
                liveByKey[key, default: []].append(feature)
            }
        }
        let slugsByRepo: [(repo: String, slugs: Set<String>)] = lots.map { lot in
            (realpathOr(lot.repoRoot), Set(lot.features.map(\.slug)))
        }
        var decisionsById: [String: [(index: Int, decision: AuditDecision)]] = [:]
        for (index, decision) in snapshot.audits.decisions.enumerated() {
            decisionsById[decision.auditId, default: []].append((index, decision))
        }

        let cards = snapshot.audits.records.map { record -> AuditCard in
            let live = liveByKey[record.key] ?? []
            let repoReal = realpathOr(record.repoRoot)
            let lotSlugs = slugsByRepo.filter { $0.repo == repoReal }.map(\.slugs)
            let proposals = (record.proposal?.elements ?? []).map { element in
                AuditProposalRow(
                    kind: element.kind,
                    slug: element.slug,
                    intention: element.intention,
                    deps: element.deps,
                    taken: lotSlugs.contains { $0.contains(element.slug) }
                )
            }
            let features = record.launches.filter(\.launched).map { launch -> AuditFeatureRow in
                if let feature = live.first(where: { $0.slug == launch.slug }) {
                    return AuditFeatureRow(
                        slug: launch.slug,
                        phase: feature.phase,
                        waiting: .of(state: feature.state, prUrl: feature.prUrl, escalated: feature.escalation != nil, arbitrating: feature.arbitration != nil),
                        prUrl: feature.prUrl
                    )
                }
                return AuditFeatureRow(
                    slug: launch.slug,
                    phase: launch.phase,
                    waiting: .of(state: launch.state, prUrl: launch.prUrl, escalated: false, arbitrating: false),
                    prUrl: launch.prUrl
                )
            }
            let escalations = live.compactMap { feature -> AuditEscalationRow? in
                guard let escalation = feature.escalation, let kind = AuditEscalationKind(key: escalation.key) else { return nil }
                return AuditEscalationRow(
                    slug: feature.slug,
                    key: escalation.key,
                    kind: kind,
                    phase: escalation.phase,
                    question: escalation.question,
                    options: escalation.options,
                    reason: escalation.reason,
                    at: escalation.at
                )
            }
            .sorted { $0.at != $1.at ? $0.at < $1.at : $0.slug < $1.slug }
            // Le plus récent d'abord ; à instant égal, la ligne écrite le plus tard.
            let decisions = (decisionsById[record.id] ?? [])
                .sorted { $0.decision.at != $1.decision.at ? $0.decision.at > $1.decision.at : $0.index > $1.index }
                .map(\.decision)
            return AuditCard(
                id: record.id,
                repoRoot: record.repoRoot,
                repoName: auditRepoName(record.repoRoot),
                orientation: record.orientation,
                status: record.status,
                createdAt: record.createdAt,
                failure: record.failure,
                briefDraft: record.proposal?.briefDraft,
                proposals: proposals,
                launches: record.launches.filter { !$0.launched },
                features: features,
                escalations: escalations,
                decisions: decisions
            )
        }
        return AuditBoard(audits: cards.sorted { $0.createdAt != $1.createdAt ? $0.createdAt > $1.createdAt : $0.id < $1.id })
    }
}

/// Le dernier composant non vide d'un chemin (`/a/b/` → `b`).
private func auditRepoName(_ path: String) -> String {
    path.split(separator: "/").last.map(String.init) ?? path
}
