// « Décisions de l'arbitre » (audit-panel-in-omp-console S-6, repliées par
// audit-ui-redesign S-10) : un groupe REPLIÉ par défaut dont le titre porte le
// nombre de décisions, et dedans une rangée par décision prise au nom de
// l'utilisateur dans le contexte de l'audit — feature, phase, question, réponse
// et source (« Déjà tranchée » / « Tranchée par l'arbitre »). L'ardoise les rend
// déjà de la plus récente à la plus ancienne. Sans décision, le bloc est absent
// (`AuditPresentation.followUpBlocks`).

import ConsoleCore
import SwiftUI

struct AuditDecisionsView: View {
    let decisions: [AuditDecision]
    /// Le dépliage vit dans `AuditViewState`, par audit (aucun `@State`).
    let isExpanded: Binding<Bool>

    var body: some View {
        DisclosureGroup(isExpanded: isExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(decisions.enumerated()), id: \.offset) { index, decision in
                    AuditDecisionRow(decision: decision)
                        .accessibilityIdentifier(AuditAccessibility.decision(index))
                    if index < decisions.count - 1 { Divider() }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
        } label: {
            Text(AuditText.decisionsGroupTitle(decisions.count)).font(.headline)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(AuditAccessibility.decisions)
    }
}

struct AuditDecisionRow: View {
    let decision: AuditDecision

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(AuditText.escalationHeader(slug: decision.slug, phase: decision.phase))
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 8)
                Text(AuditText.source(decision.source))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(verbatim: decision.question)
            Text(verbatim: decision.answer)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}
