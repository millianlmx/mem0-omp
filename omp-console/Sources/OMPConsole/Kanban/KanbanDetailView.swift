// La feuille de détail d'une carte de Pipelines, ouverte par double clic, ↩ ou
// « Afficher les détails » (refonte du 2026-10-02) : un en-tête (titre, dépôt et
// étape, badge d'état), la frise d'avancement, la zone d'action, les
// informations, puis les détails techniques repliés ; « Fermer » (Échap) en bas
// à droite.
//
// Plus de `Form` groupé : il rangeait le titre, le dépôt et le badge sur trois
// lignes de formulaire, dessinait l'avancement en pastilles qui ressemblaient à
// des boutons radio, et poussait les options d'une question à droite de leur
// libellé.
//
// L'avancement vient de `PipelineProgress.steps(for:)` (fonction PURE).

import SwiftUI

struct KanbanDetailView: View {
    @ObservedObject var model: KanbanModel
    /// Le modèle d'action : la zone de gestes de la section « Action » (S-10).
    @ObservedObject var actions: ActionsModel
    let card: KanbanCard
    @StateObject private var stopPrompt = KanbanStopPrompt()

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    PipelineStepper(steps: PipelineProgress.steps(for: card))
                    section(KanbanText.action) {
                        KanbanActionPane(model: actions, card: card, showsStop: false)
                    }
                    section(KanbanText.information) {
                        information
                    }
                    technical
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            footer
        }
        .frame(minWidth: 480, idealWidth: 540, minHeight: 440, idealHeight: 620)
        // Conteneur : la zone d'action garde ses propres identifiants
        // (`kanban.actions.*`).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("kanban.detail")
        // La feuille « Modèles » demandée depuis l'inspecteur : imbriquée dans la
        // feuille de détail (la racine ne présente pas de feuille par-dessus une
        // autre).
        .sheet(item: Binding(
            get: { model.detailShown ? model.modelsSheetCard : nil },
            set: { model.modelsSheetCard = $0 }
        )) { card in
            ModelsSheet(card: card, actions: actions)
        }
    }

    /// « Arrêter… » (destructif, confirmé) à gauche, « Fermer » (Échap) à droite.
    private var footer: some View {
        HStack {
            if let action = card.action, KanbanActionPresentation.zones(for: card).contains(where: {
                if case .stopLot = $0 { true } else { false }
            }) {
                Button(ActionsText.stop, role: .destructive) { stopPrompt.shown = true }
                    .accessibilityIdentifier("kanban.actions.stop")
                    .kanbanStopConfirmation(
                        repo: card.repo,
                        isPresented: Binding(get: { stopPrompt.shown }, set: { stopPrompt.shown = $0 })
                    ) {
                        actions.stopLot(action)
                    }
            }
            Spacer()
            Button(KanbanText.close) { model.detailShown = false }
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("kanban.detail.close")
        }
        .padding(16)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(KanbanCardPresentation.title(card))
                    .font(.title2.bold())
                    .textSelection(.enabled)
                Text(subtitle)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            StatusBadge(status: ConsoleStatus.of(card: card))
                .fixedSize()
        }
    }

    /// « dépôt · étape ».
    private var subtitle: String {
        [card.repo, card.phase.map(PhaseText.title)].compactMap { $0 }.joined(separator: " · ")
    }

    /// Une section : un intitulé discret, puis son contenu sur un fond groupé.
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quinary, in: .rect(cornerRadius: 10))
        }
    }

    private var information: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
            infoRow(KanbanText.step, card.phase.map(PhaseText.title) ?? "—")
            if KanbanCardPresentation.showsDuration(card) {
                GridRow {
                    Text(KanbanText.duration).foregroundStyle(.secondary)
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(ConsoleFormat.duration(ms: card.elapsedMs(nowMs: context.date.timeIntervalSince1970 * 1000)))
                            .monospacedDigit()
                    }
                }
            }
            if let models = card.models {
                infoRow(KanbanText.modelReqSpecs, models.reqSpecs ?? KanbanText.modelDefault)
                infoRow(KanbanText.modelImplReview, models.implReview ?? KanbanText.modelDefault)
            }
            if let action = card.action, action.slug != nil {
                GridRow {
                    Button(KanbanText.editModelsShort) {
                        actions.beginModelsEdit(card.models)
                        model.modelsSheetCard = card
                    }
                    .accessibilityIdentifier("kanban.actions.editModels")
                    .gridCellColumns(2)
                }
            }
            if let prUrl = card.prUrl, let url = ProjectPlanRowView.linkURL(prUrl) {
                GridRow {
                    Text(KanbanText.pullRequest).foregroundStyle(.secondary)
                    Link(HomeText.openPR, destination: url)
                }
            }
        }
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value).textSelection(.enabled)
        }
    }

    private var technical: some View {
        DisclosureGroup(
            KanbanText.technical,
            isExpanded: Binding(
                get: { model.technicalExpanded },
                set: { model.technicalExpanded = $0 }
            )
        ) {
            VStack(alignment: .leading, spacing: 4) {
                if let marks = card.marksText {
                    Text(KanbanText.marks(marks))
                }
                ForEach(Array(card.sources.enumerated()), id: \.offset) { _, source in
                    Text(verbatim: source.ref)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
        }
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("kanban.detail.technical")
    }
}
