// Ce qu'une feature attend de vous, en place, partagé par le Mac et l'iPhone/iPad : la
// carte qui la concerne (questions, specs, verdict, décisions prises seules).
// « Comprendre » la pose en tête de son résumé.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Ce que la feature attend de vous, en place : la carte de la boîte qui la concerne.
public struct RunPendingCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let run: HarnessRun

    public init(server: HarnessModel, drafts: HarnessDrafts, run: HarnessRun) {
        self.server = server
        self.drafts = drafts
        self.run = run
    }

    /// La feature attend quelque chose de l'humain.
    public static func isPending(_ run: HarnessRun, in inbox: HarnessInbox?) -> Bool {
        guard let inbox else { return false }
        return inbox.openBatches.contains { $0.id == run.id } || inbox.awaiting.contains { $0.id == run.id }
            || inbox.decisions.contains { $0.runId == run.id }
    }

    public var body: some View {
        if let inbox = server.inbox {
            if let batch = inbox.openBatches.first(where: { $0.id == run.id }) {
                EscalationBatchCard(server: server, drafts: drafts, inbox: inbox, batch: batch)
                    .disabled(!server.canAct)
            }
            if let waiting = inbox.awaiting.first(where: { $0.id == run.id }) {
                if waiting.awaitsSpecs {
                    SpecsCard(server: server, drafts: drafts, inbox: inbox, run: waiting)
                        .disabled(!server.canAct)
                } else {
                    VerdictCard(server: server, drafts: drafts, inbox: inbox, run: waiting)
                        .disabled(!server.canAct)
                }
            }
            let decisions = inbox.decisions.filter { $0.runId == run.id }
            if !decisions.isEmpty {
                DecisionsCard(server: server, drafts: drafts, inbox: inbox, runId: run.id, decisions: decisions)
                    .disabled(!server.canAct)
            }
        }
    }
}
