// Une question en attente (audit-panel-in-omp-console S-6, AC-6) : « <slug> ·
// <phase> », la question (en Markdown), le motif de l'arbitre, puis la réponse
// attendue selon la sorte de l'escalade :
//   — ask / question : un bouton par option, le champ « Autre réponse » et
//     « Répondre » (ordre de tabulation : options, champ, Répondre) ;
//   — specs : « Valider les specs » et « Abandonner la feature » ;
//   — review : « Accepter la revue et livrer (PR) » et « Abandonner la feature ».
// Une réponse acceptée retire l'escalade à l'instantané suivant.

import ConsoleCore
import SwiftUI

struct AuditEscalationView: View {
    @ObservedObject var model: AuditConsoleModel
    let auditId: String
    let escalation: AuditEscalationRow

    private var draft: Binding<String> {
        Binding(
            get: { model.draft(for: escalation.key) },
            set: { model.setDraft($0, for: escalation.key) }
        )
    }

    private var canAnswerText: Bool {
        !model.busy && !model.draft(for: escalation.key).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(AuditText.escalationHeader(slug: escalation.slug, phase: escalation.phase))
                .font(.subheadline.weight(.semibold))
            MarkdownBlocksView(markdown: escalation.question)
            Text(AuditText.arbiterReason(escalation.reason))
                .font(.callout)
                .foregroundStyle(.secondary)
            answers
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.08), in: .rect(cornerRadius: ConsoleSurface.bannerRadius))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AuditAccessibility.escalation(escalation.slug))
    }

    @ViewBuilder
    private var answers: some View {
        switch escalation.kind {
        case .ask, .question:
            if !escalation.options.isEmpty {
                HStack(spacing: 8) {
                    ForEach(Array(escalation.options.enumerated()), id: \.offset) { index, option in
                        Button(option) { answer(option) }
                            .disabled(model.busy)
                            .accessibilityIdentifier(AuditAccessibility.escalationOption(escalation.slug, index))
                    }
                }
            }
            HStack(spacing: 8) {
                TextField(AuditText.otherAnswer, text: draft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { if canAnswerText { answer(model.draft(for: escalation.key)) } }
                    .accessibilityIdentifier(AuditAccessibility.escalationText(escalation.slug))
                if model.busy { ProgressView().controlSize(.small) }
                Button(AuditText.answer) { answer(model.draft(for: escalation.key)) }
                    .disabled(!canAnswerText)
                    .accessibilityIdentifier(AuditAccessibility.escalationAnswer(escalation.slug))
            }
        case .specs, .review:
            HStack(spacing: 8) {
                Button(escalation.kind == .specs ? AuditText.approveSpecs : AuditText.approveReview) {
                    decide(.approve)
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.busy)
                .accessibilityIdentifier(AuditAccessibility.escalationApprove(escalation.slug))
                Button(AuditText.abandonFeature, role: .destructive) { decide(.abandon) }
                    .disabled(model.busy)
                    .accessibilityIdentifier(AuditAccessibility.escalationAbandon(escalation.slug))
                if model.busy { ProgressView().controlSize(.small) }
            }
        }
    }

    private func answer(_ text: String) {
        Task { @MainActor in
            await model.submitAnswer(auditId: auditId, escalation: escalation, answer: text)
        }
    }

    private func decide(_ decision: AuditMilestoneDecision) {
        Task { @MainActor in
            await model.submitDecision(auditId: auditId, escalation: escalation, decision: decision)
        }
    }
}
