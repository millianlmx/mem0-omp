// « OS agentique » : les DÉCISIONS — tout ce qui attend l'humain, d'où que cela vienne
// (questions d'une feature, specs et verdicts à valider, envois du poste à approuver,
// Demandes à confirmer ou à préciser, audits à trier, commentaires Jira proposés) — et
// leur regroupement en LOTS de même sorte : plusieurs specs, plusieurs verdicts ou
// plusieurs envois se tranchent alors d'un geste.
//
// Pur : aucune vue, aucun réseau, aucun texte.

import Foundation

/// La sorte d'une décision, dans l'ordre de lecture : les portes d'une feature d'abord.
public enum OSDecisionKind: String, CaseIterable, Identifiable, Sendable {
    case questions, specs, verdict, approval, intake, audit, jira

    public var id: String { rawValue }
}

/// Une décision qui attend l'humain.
public enum OSDecision: Identifiable, Equatable, Sendable {
    /// Les questions d'une feature arrêtée (un lot de questions par feature).
    case questions(HarnessEscalationBatch)
    case specs(HarnessRun)
    case verdict(HarnessRun)
    /// Un envoi du poste à approuver.
    case approval(WorkstationAction)
    /// Une Demande : un plan à confirmer, ou une question de clarification.
    case intake(HarnessIntake)
    /// Un audit dont les propositions attendent un tri.
    case audit(HarnessAudit)
    /// Un commentaire Jira proposé par l'agent.
    case jira(AtlassianWrite)

    public var id: String {
        switch self {
        case let .questions(batch): "q:" + batch.id
        case let .specs(run): "s:" + run.id
        case let .verdict(run): "v:" + run.id
        case let .approval(action): "w:\(action.seq)"
        case let .intake(intake): "i:" + intake.id
        case let .audit(audit): "a:" + audit.id
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
        case .audit: .audit
        case .jira: .jira
        }
    }

    /// La feature concernée, quand il y en a une.
    public var runId: String? {
        switch self {
        case let .questions(batch): batch.id
        case let .specs(run), let .verdict(run): run.id
        case .approval, .intake, .audit, .jira: nil
        }
    }

    /// Le dépôt concerné, quand il est connu : de quoi ranger la décision dans un espace.
    public var repo: String? {
        switch self {
        case let .questions(batch): batch.run?.repo
        case let .specs(run), let .verdict(run): run.repo
        case let .intake(intake): intake.repo
        case let .audit(audit): audit.repo
        case .approval, .jira: nil
        }
    }
}

/// Des décisions de même sorte, à trancher une à une ou d'un geste.
public struct OSDecisionLot: Identifiable, Equatable, Sendable {
    public var kind: OSDecisionKind
    public var items: [OSDecision]

    public init(kind: OSDecisionKind, items: [OSDecision]) {
        self.kind = kind
        self.items = items
    }

    public var id: String { kind.rawValue }

    /// Plusieurs décisions de la sorte : un geste peut les trancher ensemble.
    public var isBatch: Bool { items.count > 1 }

    /// Les features du lot, dans son ordre, sans doublon.
    public var runIds: [String] {
        var seen = Set<String>()
        return items.compactMap(\.runId).filter { seen.insert($0).inserted }
    }
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
            items += inbox.auditsProposed.map(OSDecision.audit)
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

    /// Les décisions d'une feature : ses questions, ses specs ou son verdict.
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
}
