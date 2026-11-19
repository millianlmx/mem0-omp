// « OS agentique » : les DÉCISIONS — tout ce qui attend l'humain, d'où que cela vienne
// (questions d'une tâche, specs et revues à valider, envois du poste, Demandes à lancer
// ou à préciser, commentaires Jira proposés) —, l'ESPACE de chacune (le client pour qui
// l'on tranche) et leur regroupement en LOTS de même sorte : plusieurs revues ou
// plusieurs envois se tranchent alors d'un geste, jamais pour deux espaces à la fois.
//
// Une proposition n'est PAS une décision : les audits proposés vivent dans Propositions.
//
// Pur : aucune vue, aucun réseau, aucun texte.

import Foundation

/// La sorte d'une décision, dans l'ordre de lecture : les portes d'une tâche d'abord.
public enum OSDecisionKind: String, CaseIterable, Identifiable, Sendable {
    case questions, specs, verdict, approval, intake, jira

    public var id: String { rawValue }
}

/// Une décision qui attend l'humain.
public enum OSDecision: Identifiable, Equatable, Sendable {
    /// Les questions d'une tâche arrêtée (un lot de questions par tâche).
    case questions(HarnessEscalationBatch)
    case specs(HarnessRun)
    /// Une tâche qui attend l'humain hors de ses specs : une revue à valider, un arbitrage,
    /// un budget à accorder, une relance après des échecs répétés.
    case verdict(HarnessRun)
    /// Un envoi du poste à approuver.
    case approval(WorkstationAction)
    /// Une Demande : un plan à lancer, ou une question de clarification.
    case intake(HarnessIntake)
    /// Un commentaire Jira proposé par l'agent.
    case jira(AtlassianWrite)

    public var id: String {
        switch self {
        case let .questions(batch): "q:" + batch.id
        case let .specs(run): "s:" + run.id
        case let .verdict(run): "v:" + run.id
        case let .approval(action): "w:\(action.seq)"
        case let .intake(intake): "i:" + intake.id
        case let .jira(write): "j:" + write.id
        }
    }

    public var kind: OSDecisionKind {
        switch self {
        case .questions: .questions
        case .specs: .specs
        case .verdict: .verdict
        case .approval: .approval
        case .intake: .intake
        case .jira: .jira
        }
    }

    /// La tâche concernée, quand il y en a une.
    public var runId: String? {
        switch self {
        case let .questions(batch): batch.id
        case let .specs(run), let .verdict(run): run.id
        case .approval, .intake, .jira: nil
        }
    }

    /// Le dépôt concerné, quand il est connu : de quoi ranger la décision dans un espace.
    public var repo: String? {
        switch self {
        case let .questions(batch): batch.run?.repo
        case let .specs(run), let .verdict(run): run.repo
        case let .intake(intake): intake.repo ?? intake.plan?.repo
        case .approval, .jira: nil
        }
    }
}

/// Des décisions de même sorte et d'un même espace, à trancher une à une ou d'un geste.
public struct OSDecisionLot: Identifiable, Equatable, Sendable {
    public var kind: OSDecisionKind
    public var items: [OSDecision]
    /// L'espace du lot (son identifiant) ; `nil` : hors de tout espace, ou lots non rangés par espace.
    public var spaceId: String?

    public init(kind: OSDecisionKind, items: [OSDecision], spaceId: String? = nil) {
        self.kind = kind
        self.items = items
        self.spaceId = spaceId
    }

    public var id: String { spaceId.map { $0 + "/" + kind.rawValue } ?? kind.rawValue }

    /// Plusieurs décisions de la sorte : un geste peut les trancher ensemble.
    public var isBatch: Bool { items.count > 1 }

    /// Les tâches du lot, dans son ordre, sans doublon.
    public var runIds: [String] {
        var seen = Set<String>()
        return items.compactMap(\.runId).filter { seen.insert($0).inserted }
    }
}

/// Les décisions d'un espace (`space` ; `nil` : celles qui ne sont dans aucun).
public struct OSDecisionGroup: Identifiable, Equatable, Sendable {
    public var space: HarnessSpace?
    public var items: [OSDecision]

    public init(space: HarnessSpace?, items: [OSDecision]) {
        self.space = space
        self.items = items
    }

    public var id: String { space?.id ?? "" }
}

public enum OSDecisions {
    /// Toutes les décisions en attente, dans l'ordre de chaque source.
    public static func all(
        inbox: HarnessInbox?,
        approvals: [WorkstationAction] = [],
        intakes: [HarnessIntake] = [],
        writes: [AtlassianWrite] = []
    ) -> [OSDecision] {
        var items: [OSDecision] = []
        if let inbox {
            items += inbox.openBatches.filter { !$0.items.isEmpty }.map(OSDecision.questions)
            items += inbox.awaiting.map { $0.awaitsSpecs ? .specs($0) : .verdict($0) }
        }
        items += approvals.map(OSDecision.approval)
        items += intakes.filter { $0.isPlanned || $0.isClarifying }.map(OSDecision.intake)
        items += writes.map(OSDecision.jira)
        return items
    }

    /// Toutes les décisions en attente sur le serveur relié.
    @MainActor
    public static func all(server: HarnessModel) -> [OSDecision] {
        all(
            inbox: server.inbox,
            approvals: server.workstation.approvals,
            intakes: server.intakes.open,
            writes: server.atlassian.availability == .available ? server.atlassian.proposals : []
        )
    }

    /// Les décisions d'une tâche : ses questions, ses specs ou sa revue.
    public static func of(runId: String, inbox: HarnessInbox?) -> [OSDecision] {
        all(inbox: inbox).filter { $0.runId == runId }
    }

    /// Les décisions regroupées par sorte, dans l'ordre de lecture (`OSDecisionKind`) ; chaque
    /// lot garde l'ordre d'arrivée de ses décisions. Aucune sorte vide.
    public static func lots(_ decisions: [OSDecision]) -> [OSDecisionLot] {
        OSDecisionKind.allCases.compactMap { kind in
            let items = decisions.filter { $0.kind == kind }
            return items.isEmpty ? nil : OSDecisionLot(kind: kind, items: items)
        }
    }

    // MARK: Espaces

    /// L'espace d'une décision : celui de son dépôt ; un envoi du poste ou une Demande pour
    /// le poste va à l'espace qui porte le poste ; un commentaire Jira à l'espace qui déclare
    /// le projet de son ticket. `nil` : hors de tout espace.
    public static func space(of decision: OSDecision, spaces: [HarnessSpace]) -> HarnessSpace? {
        if let space = OSThreads.space(ofRepo: decision.repo, spaces: spaces) { return space }
        switch decision {
        case .approval:
            return spaces.first(where: \.poste)
        case let .intake(intake):
            return intake.plan?.kind == "workstation_request" ? spaces.first(where: \.poste) : nil
        case let .jira(write):
            guard let dash = write.issueKey.lastIndex(of: "-") else { return nil }
            let project = write.issueKey[..<dash].uppercased()
            return spaces.first { space in space.jiraProjects.contains { $0.uppercased() == project } }
        case .questions, .specs, .verdict:
            return nil
        }
    }

    /// Les décisions de l'espace retenu (`spaceId` ; `nil` ou inconnu : toutes).
    public static func scoped(_ decisions: [OSDecision], spaceId: String?, spaces: [HarnessSpace]) -> [OSDecision] {
        guard let spaceId, spaces.contains(where: { $0.id == spaceId }) else { return decisions }
        return decisions.filter { space(of: $0, spaces: spaces)?.id == spaceId }
    }

    /// Les décisions rangées par espace, dans l'ordre de `spaces` ; celles qui ne sont dans
    /// aucun espace viennent en dernier. Chaque groupe garde l'ordre d'arrivée ; aucun groupe vide.
    public static func bySpace(_ decisions: [OSDecision], spaces: [HarnessSpace]) -> [OSDecisionGroup] {
        var bySpaceId: [String: [OSDecision]] = [:]
        var outside: [OSDecision] = []
        for decision in decisions {
            if let space = space(of: decision, spaces: spaces) {
                bySpaceId[space.id, default: []].append(decision)
            } else {
                outside.append(decision)
            }
        }
        var groups = spaces.compactMap { space in bySpaceId[space.id].map { OSDecisionGroup(space: space, items: $0) } }
        if !outside.isEmpty { groups.append(OSDecisionGroup(space: nil, items: outside)) }
        return groups
    }
}
