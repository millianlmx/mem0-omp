// Le détail d'un audit (audit-panel-in-omp-console BR-3) : l'en-tête (dépôt,
// orientation complète, statut, « Arrêter l'audit… »), puis selon le statut —
// l'analyse en cours, les cases des propositions, le suivi (avancement, questions
// en attente, décisions de l'arbitre) ou l'échec de l'analyse.
//
// Rendu dans une `ScrollView` par `AuditView` : aucun `.fixedSize` vertical sur
// un `Text` (piège mem0 05ccad68), les textes longs passent à la ligne d'eux-mêmes.

import ConsoleCore
import SwiftUI

struct AuditDetailView: View {
    @ObservedObject var model: AuditConsoleModel
    let card: AuditCard

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            Divider()
            switch AuditDetailContent.of(card) {
            case .analysing:
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text(AuditText.statusAnalysing)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(AuditAccessibility.analysing)
            case let .proposals(weaknesses, features):
                proposals(weaknesses: weaknesses, features: features)
            case .followUp:
                followUp
            case let .failed(failure):
                analysisFailure(failure)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    // MARK: - En-tête

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: card.repoName)
                    .font(.title2.bold())
                    .help(ConsoleFormat.path(card.repoRoot))
                VStack(alignment: .leading, spacing: 2) {
                    Text(AuditText.orientation)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(verbatim: card.orientation)
                        .textSelection(.enabled)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(AuditAccessibility.orientation)
                Text(AuditText.status(card.status))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(AuditAccessibility.status)
            }
            Spacer(minLength: 8)
            if card.status != .stopped {
                HStack(spacing: 6) {
                    if model.busy { ProgressView().controlSize(.small) }
                    Button(AuditText.stopAudit, role: .destructive) { model.requestStop() }
                        .disabled(model.busy)
                        .accessibilityIdentifier(AuditAccessibility.stop)
                }
            }
        }
    }

    // MARK: - Propositions

    private func proposals(weaknesses: [AuditProposalRow], features: [AuditProposalRow]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Form {
                if !weaknesses.isEmpty {
                    Section(AuditText.weaknesses) {
                        ForEach(weaknesses) { proposalToggle($0) }
                    }
                }
                if !features.isEmpty {
                    Section(AuditText.proposedFeatures) {
                        ForEach(features) { proposalToggle($0) }
                    }
                }
            }
            // `.columns` : le style macOS sans défilement propre — le détail
            // défile déjà, une `Form` groupée s'y écraserait à hauteur nulle.
            .formStyle(.columns)
            HStack(spacing: 10) {
                Text(AuditText.checkedCount(model.checkedCount(of: card)))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(AuditAccessibility.checkedCount)
                Spacer(minLength: 8)
                if model.busy { ProgressView().controlSize(.small) }
                Button(AuditText.reviewBrief) { model.presentBrief() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canReviewBrief(card))
                    .accessibilityIdentifier(AuditAccessibility.reviewBrief)
            }
        }
    }

    private func proposalToggle(_ row: AuditProposalRow) -> some View {
        let binding = Binding(
            get: { model.isChecked(row.slug, in: card.id) },
            set: { model.setChecked(row.slug, in: card.id, $0) }
        )
        return Toggle(isOn: binding) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: row.slug)
                    .font(.body.monospaced())
                Text(verbatim: row.intention)
                    .foregroundStyle(.secondary)
                if row.taken {
                    Text(AuditText.taken)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
        .toggleStyle(.checkbox)
        .disabled(row.taken || model.busy)
        .accessibilityIdentifier(AuditAccessibility.proposal(row.slug))
    }

    // MARK: - Suivi

    private var followUp: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text(AuditText.progressTitle).font(.headline)
                ForEach(card.features) { featureRow($0) }
                ForEach(card.launches, id: \.slug) { launch in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: launch.slug)
                            .font(.body.monospaced())
                        if let reason = launch.reason {
                            Text(verbatim: reason)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier(AuditAccessibility.notLaunched(launch.slug))
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(AuditAccessibility.progress)

            VStack(alignment: .leading, spacing: 10) {
                Text(AuditText.escalationsTitle).font(.headline)
                if card.escalations.isEmpty {
                    Text(AuditText.noEscalation)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(card.escalations) { escalation in
                        AuditEscalationView(model: model, auditId: card.id, escalation: escalation)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(AuditAccessibility.escalations)

            AuditDecisionsView(decisions: card.decisions)
        }
    }

    private func featureRow(_ row: AuditFeatureRow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(verbatim: row.slug)
                .font(.body.monospaced())
            if let phase = row.phase {
                Text(PhaseText.title(phase))
                    .foregroundStyle(.secondary)
            }
            Text(AuditText.waiting(row.waiting))
                .foregroundStyle(row.waiting == .escalated ? .orange : .secondary)
            Spacer(minLength: 8)
            if row.prUrl != nil {
                Button(AuditText.openPR) { model.openPR(row) }
                    .controlSize(.small)
                    .accessibilityIdentifier(AuditAccessibility.featurePR(row.slug))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AuditAccessibility.feature(row.slug))
    }

    // MARK: - Échec de l'analyse

    private func analysisFailure(_ failure: ReadableFailure) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
            Text(verbatim: failure.message)
            Spacer(minLength: 8)
            DiagnosticCopyButton(diagnostic: failure.diagnostic, identifier: AuditAccessibility.analysisDiagnostic)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleBanner(tint: .red)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AuditAccessibility.analysisFailed)
    }
}
