// La FILE unique de « À traiter » : tout ce qui attend l'humain, en une seule liste
// triée, sans section vide. Calculée ici, sans vue, pour que le Mac et l'iPhone la
// lisent dans le même ordre et qu'un test la fige.
//
// L'ordre : d'abord les PORTES — questions à trancher, specs et verdicts à valider —
// qui arrêtent une feature tant que l'humain ne répond pas, la plus ancienne attente
// en tête quel que soit son genre ; puis les alertes (feature bloquée, budget), les
// audits dont les propositions attendent un tri, et en dernier les décisions prises
// seules par l'agent, regroupées par feature (elles ne bloquent rien).

import Foundation

/// Un élément de la file.
public enum HarnessInboxItem: Identifiable, Equatable, Sendable {
    /// Les questions d'une feature arrêtée (un lot par feature).
    case questions(HarnessEscalationBatch)
    /// Des specs qui attendent d'être validées.
    case specs(HarnessRun)
    /// Un verdict de revue qui attend d'être validé (ou une feature arrêtée sans verdict).
    case verdict(HarnessRun)
    /// Une alerte sur une feature (bloquée, budget dépassé…).
    case alert(HarnessAlert)
    /// Un audit dont les propositions attendent un tri.
    case audit(HarnessAudit)
    /// Les décisions prises seules sur une feature, à relire.
    case decisions(runId: String, items: [HarnessDecision])

    public var id: String {
        switch self {
        case .questions(let batch): "questions/" + batch.id
        case .specs(let run): "specs/" + run.id
        case .verdict(let run): "verdict/" + run.id
        case .alert(let alert): "alert/" + alert.id
        case .audit(let audit): "audit/" + audit.id
        case .decisions(let runId, _): "decisions/" + runId
        }
    }

    /// La feature concernée, quand il y en a une.
    public var runId: String? {
        switch self {
        case .questions(let batch): batch.id
        case .specs(let run), .verdict(let run): run.id
        case .alert(let alert): alert.runId
        case .audit: nil
        case .decisions(let runId, _): runId
        }
    }

    /// L'ancre de la palette et des notifications qui mène à ce genre d'élément.
    public var anchor: HarnessHomeAnchor? {
        switch self {
        case .questions: .toDecide
        case .specs: .specs
        case .verdict: .verdicts
        case .decisions: .decisions
        case .alert, .audit: nil
        }
    }

    /// Une porte arrête une feature tant que l'humain ne répond pas.
    public var isGate: Bool {
        switch self {
        case .questions, .specs, .verdict: true
        case .alert, .audit, .decisions: false
        }
    }
}

public enum HarnessInboxFeed {
    /// La file de `inbox`, dans l'ordre de lecture (voir l'en-tête du fichier).
    public static func items(_ inbox: HarnessInbox) -> [HarnessInboxItem] {
        var gates: [(item: HarnessInboxItem, since: Double)] = []
        for batch in inbox.batches where !batch.items.isEmpty {
            gates.append((.questions(batch), batch.run?.updatedAt ?? 0))
        }
        for run in inbox.awaiting {
            gates.append((run.awaitsSpecs ? .specs(run) : .verdict(run), run.updatedAt))
        }
        let ordered = gates.enumerated()
            .sorted { ($0.element.since, $0.offset) < ($1.element.since, $1.offset) }
            .map(\.element.item)

        let alerts = inbox.alerts.sorted { $0.since < $1.since }.map(HarnessInboxItem.alert)
        let audits = inbox.auditsProposed.sorted { $0.createdAt < $1.createdAt }.map(HarnessInboxItem.audit)

        var decisions: [HarnessInboxItem] = []
        for runId in inbox.decisionRunIds {
            let items = inbox.decisions.filter { $0.runId == runId }
            if !items.isEmpty { decisions.append(.decisions(runId: runId, items: items)) }
        }
        return ordered + alerts + audits + decisions
    }

    /// Le premier élément du genre que désigne `anchor` (palette, notification).
    public static func first(_ anchor: HarnessHomeAnchor, in items: [HarnessInboxItem]) -> HarnessInboxItem? {
        items.first { $0.anchor == anchor }
    }
}
