// La Live Activity d'une feature sur iPhone : son état, son étape, l'outil que l'agent
// emploie, une alerte en cours et son coût, sur l'écran verrouillé et dans la Dynamic
// Island. L'app la met à jour tant qu'elle est ouverte ; app fermée, c'est le serveur
// qui la pousse par APNs (`config.apns` du serveur), avec le jeton push que l'app lui
// enregistre (`HarnessModel.registerActivity`).
//
// `HarnessActivityState` est la forme EXACTE de `content-state` que le serveur envoie
// (`ActivityContent` de `omp-harness/push.ts`) : un champ de plus ou de moins d'un
// côté, et iOS ignore la mise à jour.

import Foundation

/// Ce que montre la Live Activity d'une feature.
public struct HarnessActivityState: Codable, Hashable, Sendable {
    /// L'état du run (`running`, `awaiting_human`…), tel que le serveur l'écrit.
    public var state: String
    public var step: String?
    /// L'outil que l'agent emploie à l'instant, s'il est connu.
    public var tool: String?
    /// La sorte d'une alerte en cours (`stalled`, `budget_exceeded`…).
    public var alert: String?
    /// Le coût de la feature, en dollars.
    public var cost: Double
    /// L'instant de la dernière écriture du run, en millisecondes.
    public var updatedAt: Double

    public init(state: String, step: String? = nil, tool: String? = nil, alert: String? = nil, cost: Double = 0, updatedAt: Double = 0) {
        self.state = state
        self.step = step
        self.tool = tool
        self.alert = alert
        self.cost = cost
        self.updatedAt = updatedAt
    }

    /// L'état d'une feature d'après la boîte (et le direct, s'il est suivi).
    public init(run: HarnessRun, inbox: HarnessInbox?, tool: String? = nil) {
        self.init(
            state: run.state,
            step: run.step,
            tool: tool,
            alert: inbox?.alerts(of: run.id).first?.kind,
            cost: inbox?.costs[run.id] ?? 0,
            updatedAt: run.updatedAt
        )
    }

    public var phase: HarnessRunState? { HarnessRunState(rawValue: state) }

    /// La feature est terminée : l'activité se clôt.
    public var isFinal: Bool {
        guard let phase else { return false }
        return [.merged, .failed, .cancelled].contains(phase)
    }

    /// La feature attend l'humain (questions, specs, verdict).
    public var needsHuman: Bool {
        guard let phase else { return false }
        return [.escalated, .awaitingHuman].contains(phase)
    }
}

extension Data {
    /// Le jeton push d'une activité, en hexadécimal (ce que le serveur attend).
    public var hexToken: String { map { String(format: "%02x", $0) }.joined() }
}

#if canImport(ActivityKit) && os(iOS)
import ActivityKit

/// Les attributs fixes de la Live Activity d'une feature ; son état est `HarnessActivityState`.
public struct OMPRunActivityAttributes: ActivityAttributes {
    public typealias ContentState = HarnessActivityState

    public var runId: String
    public var title: String
    public var repo: String

    public init(runId: String, title: String, repo: String) {
        self.runId = runId
        self.title = title
        self.repo = repo
    }
}
#endif
