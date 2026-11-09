// L'« OS agentique », partagé par le Mac et l'iPhone/iPad : l'état de l'espace de travail
// (fil choisi, feature comprise, niveau de zoom, tri, lieu) et les décisions qui
// attendent l'humain, d'où qu'elles viennent. La coque de chaque app tient UN
// `OSWorkspace` et le passe aux écrans de ce dossier.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Le niveau de zoom de « Comprendre », du plus court au plus brut.
public enum OSLevel: String, CaseIterable, Identifiable, Sendable {
    case summary, story, proofs, raw

    public var id: String { rawValue }
}

/// Ce que montre le niveau Preuves de « Comprendre ».
public enum OSProofPane: String, CaseIterable, Identifiable, Sendable {
    case captures, files, tests

    public var id: String { rawValue }
}

@MainActor
public final class OSWorkspace: ObservableObject {
    /// La sélection de « Maintenant » (l'accueil), à la place d'un fil.
    public static let now = "now"
    /// La sélection des « Automatismes » : ce que l'OS lance seul, et quand.
    public static let automations = "automations"
    /// Le filtre de lieu « le Poste » (sinon un nom de dépôt).
    public static let postePlace = "@poste"

    @Published public var selection: String? = OSWorkspace.now
    /// La feature que montre « Comprendre » (sinon celle du fil choisi).
    @Published public var focusRunId: String?
    @Published public var understanding = false
    @Published public var level: OSLevel = .summary
    @Published public var triage = false
    /// Le lieu retenu dans la liste des fils : un dépôt, le Poste (`postePlace`), ou tous (`nil`).
    @Published public var place: String?
    public let pulse: OSPulse

    public init(server: HarnessModel) {
        pulse = OSPulse(harness: server)
    }

    public func open(_ threadId: String) {
        selection = threadId
        focusRunId = nil
    }

    public func understand(runId: String, level: OSLevel) {
        focusRunId = runId
        self.level = level
        understanding = true
    }
}

/// Une décision qui attend l'humain, d'où qu'elle vienne.
public enum OSDecision: Identifiable {
    case questions(HarnessEscalationBatch)
    case specs(HarnessRun)
    case verdict(HarnessRun)
    case approval(WorkstationAction)
    case intake(HarnessIntake)
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

    /// La feature que la décision concerne, quand elle en concerne une.
    public var runId: String? {
        switch self {
        case let .questions(batch): batch.id
        case let .specs(run), let .verdict(run): run.id
        default: nil
        }
    }

    /// Toutes les décisions en attente, les plus anciennes d'abord dans chaque sorte.
    @MainActor
    public static func all(server: HarnessModel, workstation: WorkstationModel) -> [OSDecision] {
        var items: [OSDecision] = []
        if let inbox = server.inbox {
            items += inbox.openBatches.map(OSDecision.questions)
            items += inbox.awaiting.map { $0.awaitsSpecs ? .specs($0) : .verdict($0) }
            items += inbox.auditsProposed.map(OSDecision.audit)
        }
        items += workstation.approvals.map(OSDecision.approval)
        items += server.intakes.open.filter { $0.isPlanned || $0.isClarifying }.map(OSDecision.intake)
        if server.atlassian.availability == .available {
            items += server.atlassian.proposals.map(OSDecision.jira)
        }
        return items
    }

    /// Les décisions d'une feature.
    @MainActor
    public static func of(runId: String, server: HarnessModel) -> [OSDecision] {
        guard let inbox = server.inbox else { return [] }
        var items: [OSDecision] = inbox.openBatches.filter { $0.id == runId }.map(OSDecision.questions)
        items += inbox.awaiting.filter { $0.id == runId }.map { $0.awaitsSpecs ? .specs($0) : .verdict($0) }
        return items
    }
}
