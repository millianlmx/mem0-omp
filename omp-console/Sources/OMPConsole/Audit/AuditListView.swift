// La liste des audits (audit-panel-in-omp-console BR-3) : une rangée par audit —
// nom du dépôt, orientation sur deux lignes au plus, statut en mots, et le badge
// du nombre de questions en attente. ↑↓ parcourent la liste (`List(selection:)`).

import ConsoleCore
import SwiftUI

struct AuditListView: View {
    @ObservedObject var model: AuditConsoleModel

    var body: some View {
        List(selection: $model.selection) {
            ForEach(model.board.audits) { card in
                AuditListRow(card: card)
                    .tag(card.id)
                    .accessibilityIdentifier(AuditAccessibility.row(card.id))
            }
        }
        .listStyle(.sidebar)
        .accessibilityIdentifier(AuditAccessibility.list)
    }
}

struct AuditListRow: View {
    let card: AuditCard

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: card.repoName)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(verbatim: card.orientation)
                    .lineLimit(2)
                    .foregroundStyle(.secondary)
                Text(AuditText.status(card.status))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if !card.escalations.isEmpty {
                Text(verbatim: "\(card.escalations.count)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(.orange.opacity(0.25), in: .capsule)
                    .accessibilityLabel(AuditText.pendingQuestions(card.escalations.count))
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
