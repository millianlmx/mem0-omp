// Le détail d'un audit (audit-ui-redesign S-6 à S-11) : l'en-tête (« dépôt ·
// lancé à HH:MM », menu « ⋯ », orientation sur deux lignes dépliable), la frise
// des quatre étapes, puis le corps selon le statut — la carte « OMP analyse le
// dépôt », les propositions en cartes (la barre « N cochées » est posée par
// `AuditView`, collante sous le défilement), le corps des pipelines (questions en
// attente d'abord, avancement, non lancées, décisions repliées), l'état vide d'un
// audit arrêté avant lancement ou en échec (« Relancer avec la même orientation »).
//
// Rendu dans une `ScrollView` par `AuditView` : aucun `.fixedSize` vertical sur
// un `Text` (piège mem0 05ccad68), les textes longs passent à la ligne d'eux-mêmes.
// La troncature de l'orientation se mesure par `ViewThatFits` (Doc-5).

import ConsoleCore
import SwiftUI

struct AuditDetailView: View {
    @ObservedObject var model: AuditConsoleModel
    @ObservedObject var viewState: AuditViewState
    let card: AuditCard
    let openInProject: @MainActor (AuditCard) -> Void

    /// La frise rendue : la relecture du brief compte pour CET audit seulement.
    static func stepperSteps(_ card: AuditCard, model: AuditConsoleModel) -> [PipelineStep] {
        AuditPresentation.steps(AuditPresentation.progressInput(
            card,
            briefReviewOpen: model.isBriefSheetPresented && model.selection == card.id
        ))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            PipelineStepper(steps: Self.stepperSteps(card, model: model))
                .accessibilityIdentifier(AuditAccessibility.stepper)
            Divider()
            switch AuditDetailContent.of(card) {
            case .analysing:
                analysisCard
            case let .proposals(weaknesses, features):
                proposals(weaknesses: weaknesses, features: features)
            case .followUp:
                followUp
            case .stoppedBeforeLaunch:
                stoppedBeforeLaunch
            case let .failed(failure):
                analysisFailure(failure)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    // MARK: - En-tête

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                Text(verbatim: AuditPresentation.headerCaption(card))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(card.repoRoot)
                Spacer(minLength: 8)
                Menu {
                    AuditMenuItems(
                        model: model,
                        card: card,
                        row: nil,
                        openInProject: openInProject
                    )
                } label: {
                    Label(AuditText.moreActions, systemImage: "ellipsis")
                        .labelStyle(.iconOnly)
                        // En style bordé, le cadre AX du menu est celui de son
                        // libellé (mesuré : 12,5 pt sans cadre) ; 22 pt gardent
                        // la cible au-dessus du seuil de 20 pt de la recette UI
                        // Mac. Le style `.borderlessButton` rend, lui, 21 × 15 pt
                        // quel que soit le libellé.
                        .frame(width: 22, height: 22)
                }
                .menuStyle(.button)
                .buttonStyle(.bordered)
                .buttonBorderShape(.circle)
                .menuIndicator(.hidden)
                .fixedSize()
                .help(AuditText.moreActions)
                .accessibilityLabel(AuditText.moreActions)
                .accessibilityIdentifier(AuditAccessibility.menu)
            }
            orientationTitle
            if viewState.offersOrientationToggle(card.id) {
                Button {
                    viewState.toggleOrientation(card.id)
                } label: {
                    Text(viewState.isOrientationExpanded(card.id) ? AuditText.hideFullOrientation : AuditText.showFullOrientation)
                        .frame(minHeight: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.link)
                .controlSize(.small)
                .accessibilityIdentifier(AuditAccessibility.orientationToggle)
            }
        }
    }

    private var orientationTitle: some View {
        let expanded = viewState.isOrientationExpanded(card.id)
        return Text(verbatim: card.orientation)
            .font(.title2.weight(.semibold))
            .lineLimit(expanded ? nil : 2)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(alignment: .topLeading) {
                if !expanded { truncationProbe }
            }
            .accessibilityIdentifier(AuditAccessibility.orientation)
    }

    /// Le premier enfant n'est retenu que si l'orientation ENTIÈRE tient dans la
    /// hauteur des deux lignes ; sinon le second apparaît : le texte est tronqué.
    /// `.id` : un autre audit remesure (sinon l'enfant retenu ne réapparaît pas).
    private var truncationProbe: some View {
        let id = card.id
        return ViewThatFits(in: .vertical) {
            Text(verbatim: card.orientation)
                .font(.title2.weight(.semibold))
                .hidden()
                .onAppear { viewState.setOrientationTruncated(id, false) }
            Color.clear
                .onAppear { viewState.setOrientationTruncated(id, true) }
        }
        .id(id)
        .accessibilityHidden(true)
    }

    // MARK: - Analyse

    private var analysisCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(AuditText.analysisCardTitle)
                    .font(.headline)
            }
            // La durée écoulée depuis le lancement, à la seconde (patron HomeView).
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(AuditText.analysisElapsed(AuditPresentation.elapsed(
                    ms: context.date.timeIntervalSince1970 * 1000 - card.createdAt
                )))
                .monospacedDigit()
            }
            Text(AuditText.analysisNext)
                .foregroundStyle(.secondary)
            Button(role: .destructive) { model.requestStop() } label: {
                Text(AuditText.stopAudit)
                    .frame(minHeight: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .disabled(model.busy)
            .accessibilityIdentifier(AuditAccessibility.stop)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleCard(selected: false)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AuditAccessibility.analysing)
    }

    // MARK: - Propositions

    @ViewBuilder
    private func proposals(weaknesses: [AuditProposalRow], features: [AuditProposalRow]) -> some View {
        if weaknesses.isEmpty && features.isEmpty {
            Text(AuditText.noProposal)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 16) {
                if !weaknesses.isEmpty {
                    proposalGroup(AuditText.weaknesses, weaknesses)
                        .accessibilityIdentifier(AuditAccessibility.proposalsWeaknesses)
                }
                if !features.isEmpty {
                    proposalGroup(AuditText.featuresTitle, features)
                        .accessibilityIdentifier(AuditAccessibility.proposalsFeatures)
                }
            }
        }
    }

    private func proposalGroup(_ title: String, _ rows: [AuditProposalRow]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                proposalToggle(row)
                if index < rows.count - 1 { Divider() }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleCard(selected: false)
        .accessibilityElement(children: .contain)
    }

    private func proposalToggle(_ row: AuditProposalRow) -> some View {
        let binding = Binding(
            get: { model.isChecked(row.slug, in: card.id) },
            set: { model.setChecked(row.slug, in: card.id, $0) }
        )
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Toggle(isOn: binding) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: row.intention)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: row.slug)
                            .font(.caption.monospaced())
                        if !row.deps.isEmpty {
                            Text(AuditText.after(row.deps))
                                .font(.caption)
                        }
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .toggleStyle(.checkbox)
            .disabled(row.taken || model.busy)
            .accessibilityIdentifier(AuditAccessibility.proposal(row.slug))
            Spacer(minLength: 8)
            if row.taken {
                Text(AuditText.taken)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(.gray.opacity(0.2), in: .capsule)
            }
        }
    }

    // MARK: - Pipelines

    private var followUp: some View {
        VStack(alignment: .leading, spacing: 20) {
            ForEach(Array(AuditPresentation.followUpBlocks(card).enumerated()), id: \.offset) { _, block in
                switch block {
                case .escalations:
                    VStack(alignment: .leading, spacing: 10) {
                        Text(AuditText.escalationsTitle).font(.headline)
                        ForEach(card.escalations) { escalation in
                            AuditEscalationView(model: model, auditId: card.id, escalation: escalation)
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier(AuditAccessibility.escalations)
                case .progress:
                    VStack(alignment: .leading, spacing: 12) {
                        Text(AuditText.progressTitle).font(.headline)
                        ForEach(card.features) { featureRow($0) }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier(AuditAccessibility.progress)
                case .notLaunched:
                    VStack(alignment: .leading, spacing: 8) {
                        Text(AuditText.notLaunchedTitle).font(.headline)
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
                    .accessibilityIdentifier(AuditAccessibility.notLaunchedGroup)
                case .decisions:
                    AuditDecisionsView(decisions: card.decisions, isExpanded: viewState.decisionsExpanded(card.id))
                case .stoppedBeforeLaunch:
                    stoppedBeforeLaunch
                }
            }
        }
    }

    private func featureRow(_ row: AuditFeatureRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(verbatim: row.slug)
                    .font(.body.monospaced())
                Spacer(minLength: 8)
                if row.prUrl != nil {
                    Button(AuditText.openPR) { model.openPR(row) }
                        .controlSize(.small)
                        .accessibilityIdentifier(AuditAccessibility.featurePR(row.slug))
                }
            }
            PipelineProgressBar(steps: AuditPresentation.featureSteps(row))
                .frame(maxWidth: 360)
            Text(AuditText.waiting(row.waiting))
                .font(.callout)
                .foregroundStyle(row.waiting == .escalated ? .orange : .secondary)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AuditAccessibility.feature(row.slug))
    }

    private var stoppedBeforeLaunch: some View {
        ContentUnavailableView {
            Label(AuditText.stoppedTitle, systemImage: "stop.circle")
        } description: {
            Text(AuditText.stoppedBeforeLaunch)
        }
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier(AuditAccessibility.stoppedEmpty)
    }

    // MARK: - Échec de l'analyse

    private func analysisFailure(_ failure: ReadableFailure) -> some View {
        ContentUnavailableView {
            Label(AuditText.failedTitle, systemImage: "exclamationmark.triangle")
        } description: {
            Text(verbatim: failure.message)
        } actions: {
            // Un nouvel audit, même dépôt et même orientation : il est sélectionné,
            // l'audit échoué reste sous « Terminés ».
            Button(AuditText.relaunch) {
                Task { @MainActor in
                    await model.submitStart(repoRoot: card.repoRoot, orientation: card.orientation)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.busy)
            .accessibilityIdentifier(AuditAccessibility.relaunch)
            DiagnosticCopyButton(diagnostic: failure.diagnostic, identifier: AuditAccessibility.analysisDiagnostic)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AuditAccessibility.analysisFailed)
    }
}

/// La barre collante d'un audit proposé : « N cochées » et « Relire le brief → »
/// (⌘↩), posée par `AuditView` au bas du défilement du détail.
struct AuditProposalsBar: View {
    @ObservedObject var model: AuditConsoleModel
    let card: AuditCard

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 10) {
                Text(AuditText.checkedCount(model.checkedCount(of: card)))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(AuditAccessibility.checkedCount)
                Spacer(minLength: 8)
                if model.busy { ProgressView().controlSize(.small) }
                Button(AuditText.reviewBrief) { model.presentBrief() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!model.canReviewBrief(card))
                    .accessibilityIdentifier(AuditAccessibility.reviewBrief)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .background(.bar)
    }
}
