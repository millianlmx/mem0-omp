import ConsoleClient
import ConsoleCore
import SwiftUI

/// La feuille « Décisions de l’arbitre » de l'écran Pipelines : le fil que le Mac
/// transporte dans la trame `store` (`AuditsEnvelope.feed`), la plus récente en
/// tête — la même lecture que la bulle du Mac (feature et dépôt, origine, heure,
/// question, réponse, motif de l'arbitre).
struct PipelinesDecisionsSheet: View {
    @ObservedObject var client: ConsoleClientModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let decisions = client.snapshot?.audits.feed ?? []
        let repos = ArbiterDecisionFeed.repoNames(lots: client.snapshot?.lots.lots ?? [])
        NavigationStack {
            List {
                if decisions.isEmpty {
                    Text(KanbanText.decisionsEmpty)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(decisions) { decision in
                        row(decision, repo: repos[decision.repoKey])
                    }
                }
            }
            .navigationTitle(KanbanText.decisionsTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(KanbanText.close) { dismiss() }
                }
            }
        }
        .accessibilityIdentifier(PipelinesText.decisionsSheetId)
    }

    private func row(_ decision: ArbiterDecision, repo: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            IOSAdaptiveRow(spacing: 8, pinsControlsTrailing: false) {
                Text(KanbanText.decisionSubject(repo: repo, slug: decision.slug))
                    .font(.callout.weight(.semibold))
                Text(ConsoleFormat.time(ms: decision.at))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            Text(KanbanText.decisionSource(decision.source))
                .font(.caption.weight(.semibold))
                .foregroundStyle(decision.source == .utilisateur ? Color.secondary : Color.accentColor)
            Text(decision.question)
                .font(.callout)
            Text(decision.answer)
                .font(.callout)
                .foregroundStyle(.secondary)
            if let reason = decision.reason {
                Text(KanbanText.arbiterMotive(reason))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
