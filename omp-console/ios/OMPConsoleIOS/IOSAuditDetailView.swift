// Le détail d'un audit sur l'iPhone et l'iPad (audit-panel-in-omp-console, S-6,
// S-8, BR-5) : les mêmes blocs que le détail du Mac, en liste groupée native.
//
//   • en-tête : dépôt, orientation saisie (AC-1), statut ;
//   • analysing : un indicateur ; failed : la phrase lisible ;
//   • proposed : une rangée-bouton par proposition (pas de case native sur iOS,
//     D-1), « Cochée »/« Non cochée » portés par `accessibilityValue`, faiblesses
//     puis features, puis « Relire le brief… » ;
//   • launched/stopped : questions en attente avec leur réponse (AC-6), avancement
//     de chaque feature lancée, propositions non lancées et leur motif, décisions
//     de l'arbitre ;
//   • « Arrêter l'audit… » avec confirmation, absent pour un audit arrêté.
//
// Hors connexion, le contenu reste sous le bandeau de connexion et chaque geste
// vers le Mac est coupé ; un geste en vol remplace son bouton par un `ProgressView`.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSAuditDetailView: View {
    @ObservedObject var model: IOSAuditModel
    let auditId: String
    @Binding var showConnection: Bool

    @Environment(\.openURL) private var openURL

    private var card: AuditCard? { model.card(auditId) }

    private var stopBinding: Binding<Bool> {
        Binding(
            get: { model.pendingStop == auditId },
            set: { if !$0 { model.pendingStop = nil } }
        )
    }

    private var briefBinding: Binding<Bool> {
        Binding(
            get: { model.briefAudit == auditId },
            set: { if !$0 { model.cancelBrief() } }
        )
    }

    var body: some View {
        List {
            if model.connection != .connected {
                IOSConnectionStateView(status: model.connection, layout: .banner, onConnect: { showConnection = true })
                    .iosBareListRow()
            }
            if let banner = model.shownBanner {
                Text(banner)
                    .font(.callout)
                    .iosBanner(tone: .danger)
                    .accessibilityIdentifier(IOSAuditAccessibility.banner)
                    .iosBareListRow()
            }
            if let card {
                Section { header(card) }
                content(card)
                if card.status != .stopped {
                    Section { stopButton(card) }
                }
            } else {
                // L'audit tout juste créé n'est pas encore arrivé par la trame `store`.
                Section {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(AuditText.statusAnalysing)
                    }
                }
            }
        }
        .iosGroupedList()
        .navigationTitle(card?.repoName ?? ConsoleSection.audit.title)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSAuditAccessibility.detail)
        .sheet(isPresented: briefBinding) {
            if let card {
                IOSAuditBriefSheet(model: model, card: card)
            }
        }
        .confirmationDialog(AuditText.stopTitle, isPresented: stopBinding, titleVisibility: .visible) {
            Button(AuditText.stopConfirm, role: .destructive) {
                Task { await model.confirmStop() }
            }
            Button(AuditText.cancel, role: .cancel) { model.pendingStop = nil }
        } message: {
            Text(AuditText.stopMessage)
        }
    }

    // MARK: - En-tête

    private func header(_ card: AuditCard) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: card.repoName)
                    .font(.headline)
                Spacer(minLength: 8)
                IOSStatusChip(status: ConsoleStatus(text: AuditText.status(card.status), tone: IOSAuditModel.tone(card.status)))
            }
            Text(AuditText.orientation)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(verbatim: card.orientation)
                .font(.body)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(IOSAuditAccessibility.header)
    }

    // MARK: - Contenu selon le statut

    @ViewBuilder private func content(_ card: AuditCard) -> some View {
        switch card.status {
        case .analysing:
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(AuditText.statusAnalysing)
                }
            }
        case .failed:
            Section {
                Text(AuditText.analysisFailed)
                    .font(.callout)
                    .iosBanner(tone: .danger)
            }
            .listRowInsets(EdgeInsets())
        case .proposed:
            proposals(card)
        case .launched, .stopped:
            escalations(card)
            progress(card)
            decisions(card)
        }
    }

    // MARK: - Propositions

    @ViewBuilder private func proposals(_ card: AuditCard) -> some View {
        let weaknesses = card.proposals.filter { $0.kind == .weakness }
        let features = card.proposals.filter { $0.kind == .feature }
        if !weaknesses.isEmpty {
            Section(AuditText.weaknesses) {
                ForEach(weaknesses) { proposalRow($0, in: card) }
            }
        }
        if !features.isEmpty {
            Section(AuditText.proposedFeatures) {
                ForEach(features) { proposalRow($0, in: card) }
            }
        }
        Section {
            Text(AuditText.checkedCount(model.selectedSlugs(of: card).count))
                .font(.callout)
                .foregroundStyle(.secondary)
            Button(AuditText.reviewBrief) { model.presentBrief(card) }
                .disabled(!model.gesturesEnabled || !model.canReviewBrief(card))
                .accessibilityIdentifier(IOSAuditAccessibility.reviewBrief)
        }
    }

    /// Une case en rangée-bouton : le symbole dit l'état, VoiceOver le lit en valeur.
    private func proposalRow(_ row: AuditProposalRow, in card: AuditCard) -> some View {
        let checked = model.isChecked(row.slug, in: card.id)
        return Button {
            model.toggle(row.slug, in: card.id)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: checked ? IOSAuditSymbol.checked : IOSAuditSymbol.unchecked)
                    .font(.title3)
                    .foregroundStyle(checked ? Color.accentColor : Color.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: row.slug)
                        .font(.body.weight(.semibold))
                    Text(verbatim: row.intention)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    if row.taken {
                        Text(AuditText.taken)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .tint(.primary)
        .disabled(row.taken)
        .accessibilityElement(children: .combine)
        .accessibilityValue(checked ? AuditText.checked : AuditText.unchecked)
        .accessibilityAddTraits(checked ? .isSelected : [])
        .accessibilityIdentifier(IOSAuditAccessibility.proposal(row.slug))
    }

    // MARK: - Questions en attente

    @ViewBuilder private func escalations(_ card: AuditCard) -> some View {
        Section(AuditText.escalationsTitle) {
            if card.escalations.isEmpty {
                Text(AuditText.noEscalation)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(card.escalations) { escalation in
                    IOSAuditEscalationRow(model: model, auditId: card.id, escalation: escalation)
                }
            }
        }
    }

    // MARK: - Avancement

    @ViewBuilder private func progress(_ card: AuditCard) -> some View {
        if !card.features.isEmpty || !card.launches.isEmpty {
            Section(AuditText.progressTitle) {
                ForEach(card.features) { featureRow($0) }
                ForEach(card.launches, id: \.slug) { outcome in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: outcome.slug)
                            .font(.body.weight(.semibold))
                        if let reason = outcome.reason {
                            Text(verbatim: reason)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier(IOSAuditAccessibility.feature(outcome.slug))
                }
            }
        }
    }

    private func featureRow(_ row: AuditFeatureRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: row.slug)
                    .font(.body.weight(.semibold))
                if let phase = row.phase {
                    Text(PhaseText.title(phase))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Text(AuditText.waiting(row.waiting))
                    .font(.callout)
                    .foregroundStyle(row.waiting == .escalated ? Color.orange : Color.secondary)
            }
            .accessibilityElement(children: .combine)
            if let text = row.prUrl, let url = URL(string: text) {
                Button(AuditText.openPR) { openURL(url) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier(IOSAuditAccessibility.openPR(row.slug))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSAuditAccessibility.feature(row.slug))
    }

    // MARK: - Décisions

    @ViewBuilder private func decisions(_ card: AuditCard) -> some View {
        Section(AuditText.decisionsTitle) {
            if card.decisions.isEmpty {
                Text(AuditText.noDecision)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(card.decisions.enumerated()), id: \.offset) { index, decision in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(AuditText.escalationHeader(slug: decision.slug, phase: decision.phase))
                            .font(.subheadline.weight(.semibold))
                        Text(verbatim: decision.question)
                        Text(verbatim: decision.answer)
                            .foregroundStyle(.secondary)
                        Text(AuditText.source(decision.source))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier(IOSAuditAccessibility.decision(index))
                }
            }
        }
    }

    // MARK: - Arrêt

    @ViewBuilder private func stopButton(_ card: AuditCard) -> some View {
        if model.isInFlight(.stop(auditId: card.id)) {
            ProgressView()
        } else {
            Button(AuditText.stopAudit, role: .destructive) { model.requestStop(card) }
                .disabled(!model.gesturesEnabled)
                .accessibilityIdentifier(IOSAuditAccessibility.stop)
        }
    }
}

/// Une question en attente : « <slug> · <phase> », la question, le motif de
/// l'arbitre, puis la réponse attendue — options et « Autre réponse », ou les deux
/// décisions de jalon.
struct IOSAuditEscalationRow: View {
    @ObservedObject var model: IOSAuditModel
    let auditId: String
    let escalation: AuditEscalationRow

    private var draft: Binding<String> {
        Binding(
            get: { model.draft(for: escalation.key) },
            set: { model.setDraft($0, for: escalation.key) }
        )
    }

    private var canAnswer: Bool {
        model.gesturesEnabled && !model.draft(for: escalation.key).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(AuditText.escalationHeader(slug: escalation.slug, phase: escalation.phase))
                    .font(.subheadline.weight(.semibold))
                Text(verbatim: escalation.question)
                Text(AuditText.arbiterReason(escalation.reason))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            if model.isInFlight(.answer(key: escalation.key)) {
                ProgressView()
            } else {
                answers
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSAuditAccessibility.escalation(escalation.key))
    }

    @ViewBuilder private var answers: some View {
        switch escalation.kind {
        case .ask, .question:
            ForEach(Array(escalation.options.enumerated()), id: \.offset) { index, option in
                Button {
                    Task { await model.answer(auditId: auditId, escalation: escalation, text: option) }
                } label: {
                    Text(verbatim: option)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .disabled(!model.gesturesEnabled)
                .accessibilityIdentifier(IOSAuditAccessibility.option(escalation.key, index))
            }
            TextField(AuditText.otherAnswer, text: draft, axis: .vertical)
                .lineLimit(IOSMetrics.auditOtherAnswerLines)
                .textFieldStyle(.roundedBorder)
                .onSubmit(submitDraft)
                .disabled(!model.gesturesEnabled)
                .accessibilityIdentifier(IOSAuditAccessibility.otherAnswer(escalation.key))
            Button(AuditText.answer, action: submitDraft)
                .buttonStyle(.borderedProminent)
                .disabled(!canAnswer)
                .accessibilityIdentifier(IOSAuditAccessibility.answer(escalation.key))
        case .specs, .review:
            Button(escalation.kind == .specs ? AuditText.approveSpecs : AuditText.approveReview) {
                Task { await model.decide(auditId: auditId, escalation: escalation, decision: .approve) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!model.gesturesEnabled)
            .accessibilityIdentifier(IOSAuditAccessibility.approve(escalation.key))
            Button(AuditText.abandonFeature, role: .destructive) {
                Task { await model.decide(auditId: auditId, escalation: escalation, decision: .abandon) }
            }
            .buttonStyle(.bordered)
            .disabled(!model.gesturesEnabled)
            .accessibilityIdentifier(IOSAuditAccessibility.abandon(escalation.key))
        }
    }

    private func submitDraft() {
        guard canAnswer else { return }
        let text = model.draft(for: escalation.key)
        Task { await model.answer(auditId: auditId, escalation: escalation, text: text) }
    }
}
