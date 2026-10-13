// La liste des audits (audit-ui-redesign S-3) : deux sections « En cours »
// (analysing, proposed, launched) et « Terminés » (stopped, failed), une section
// vide n'est pas rendue. Une rangée par audit — pastille du statut, orientation
// sur deux lignes au plus, légende « dépôt · étape · âge » sur une ligne, badge
// orange du nombre de questions en attente. Le statut n'est jamais écrit : il est
// la valeur VoiceOver de la rangée. ↑↓ parcourent la liste (`List(selection:)`),
// clic droit (ou ctrl-clic) ouvre le menu de la rangée.

import ConsoleCore
import SwiftUI

struct AuditListView: View {
    @ObservedObject var model: AuditConsoleModel
    let openInProject: @MainActor (AuditCard) -> Void

    var body: some View {
        List(selection: $model.selection) {
            ForEach(AuditPresentation.sections(model.board)) { section in
                Section(section.title) {
                    ForEach(section.cards) { card in
                        AuditListRow(card: card, briefReviewOpen: model.isBriefSheetPresented && model.selection == card.id)
                            .tag(card.id)
                            .accessibilityIdentifier(AuditAccessibility.row(card.id))
                            .contextMenu {
                                AuditMenuItems(
                                    model: model,
                                    card: card,
                                    row: card.id,
                                    openInProject: openInProject
                                )
                            }
                    }
                }
            }
        }
        // Une liste de contenu, pas une seconde barre latérale (Doc-6).
        .listStyle(.inset)
        .accessibilityIdentifier(AuditAccessibility.list)
    }
}

struct AuditListRow: View {
    let card: AuditCard
    /// La relecture du brief est ouverte pour CETTE carte : la légende dit « Brief ».
    let briefReviewOpen: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(AuditPresentation.tone(card.status).tint)
                .frame(width: 8, height: 8)
                .padding(.top, 5)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: card.orientation)
                    .lineLimit(2)
                // L'âge suit l'horloge à la minute (« il y a 3 minutes »).
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(verbatim: AuditPresentation.rowCaption(
                        card,
                        briefReviewOpen: briefReviewOpen,
                        nowMs: context.date.timeIntervalSince1970 * 1000
                    ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
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
        .accessibilityValue(AuditText.status(card.status))
    }
}

/// Les entrées du menu d'un audit — menu contextuel de la rangée et menu « ⋯ » de
/// l'en-tête : « Copier le chemin », « Ouvrir dans Projet », séparateur, puis
/// « Arrêter l'audit… » (destructif, dernier, absent pour un audit terminé).
struct AuditMenuItems: View {
    @ObservedObject var model: AuditConsoleModel
    let card: AuditCard
    /// La rangée dont c'est le menu contextuel, ou `nil` pour le menu « ⋯ » de l'en-tête.
    let row: String?
    let openInProject: @MainActor (AuditCard) -> Void

    var body: some View {
        ForEach(Array(AuditPresentation.menu(for: card).enumerated()), id: \.offset) { _, item in
            switch item {
            case let .copyPath(path):
                Button(AuditText.copyPath) { DiagnosticPasteboard.copy(path) }
                    .accessibilityIdentifier(AuditAccessibility.menuItem(item, row: row))
            case .openInProject:
                Button(AuditText.openInProject) { openInProject(card) }
                    .accessibilityIdentifier(AuditAccessibility.menuItem(item, row: row))
            case .stop:
                Divider()
                // La confirmation existante (`AuditView.confirmationDialog`).
                Button(AuditText.stopAudit, role: .destructive) { model.pendingStop = card.id }
                    .disabled(model.busy)
                    .accessibilityIdentifier(AuditAccessibility.menuItem(item, row: row))
            }
        }
    }
}
