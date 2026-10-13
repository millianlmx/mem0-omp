// Le détail d'un audit sur l'iPhone et l'iPad (audit-panel-in-omp-console, S-8,
// BR-5 ; refondu par audit-ui-redesign, S-6 à S-11), en liste groupée native.
//
//   • en-tête : légende « dépôt · lancé à HH:MM » et menu « ⋯ » (« Copier le
//     chemin », « Ouvrir dans Projet », « Arrêter l'audit… »), orientation en
//     titre sur deux lignes, sélectionnable, « Afficher l'orientation complète »
//     quand elle est tronquée, puis la frise des 4 étapes (`IOSAuditStepper`). Le
//     statut n'est jamais écrit et aucun bouton d'arrêt n'est en vedette ;
//   • analysing : la carte « OMP analyse le dépôt » — durée écoulée à la seconde,
//     la suite expliquée, « Arrêter l'audit… » discret ;
//   • proposed : « Faiblesses » puis « Features » (une rangée-bouton par
//     proposition, « Cochée »/« Non cochée » en valeur VoiceOver), et la barre
//     collante « N cochées » + « Relire le brief → » ;
//   • launched/stopped : les blocs de `AuditPresentation.followUpBlocks` — questions
//     en cartes orange EN PREMIER, avancement, non lancées et leur motif, décisions
//     de l'arbitre repliées ; arrêté avant tout lancement → état vide ;
//   • failed : état vide natif, la phrase d'échec lisible, « Relancer avec la même
//     orientation » et « Copier le diagnostic ».
//
// Hors connexion, le contenu reste sous le bandeau de connexion et chaque geste
// vers le Mac est coupé (« Copier » reste) ; un geste en vol remplace son bouton
// par un `ProgressView`.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSAuditDetailView: View {
    @ObservedObject var model: IOSAuditModel
    let auditId: String
    /// « Ouvrir dans Projet » (S-12), transmis par l'écran Audit.
    let openProject: (String) -> Void
    @Binding var showConnection: Bool

    @Environment(\.openURL) private var openURL
    /// L'orientation dépliée par « Afficher l'orientation complète » (S-6).
    @State private var orientationExpanded = false
    /// Vrai quand l'orientation ne tient pas dans ses deux lignes (Doc-5).
    @State private var orientationTruncated = false
    /// Les décisions de l'arbitre, repliées par défaut (S-10).
    @State private var decisionsExpanded = false
    /// Le bas de l'en-tête dans le repère de la liste : l'état vide d'un audit en
    /// échec ou arrêté avant lancement est posé dessous.
    @State private var headerBottom: CGFloat = 0

    /// Le repère de la liste du détail.
    private enum Space: Hashable { case detail }

    private var card: AuditCard? { model.card(auditId) }

    /// La frise d'un audit (S-7) : Brief est en cours tant que la relecture du
    /// brief de CET audit est ouverte.
    static func steps(_ card: AuditCard, briefAudit: String?) -> [PipelineStep] {
        AuditPresentation.steps(AuditPresentation.progressInput(card, briefReviewOpen: briefAudit == card.id))
    }

    /// Vrai quand le corps de l'audit est un état vide natif (S-10, S-11) : en
    /// échec, ou arrêté avant tout lancement. Posé en rangée de liste, un
    /// `ContentUnavailableView` prend la hauteur de toute la liste et pousse ses
    /// boutons sous la barre d'onglets (mesuré, `fixedSize` n'y change rien) :
    /// il est donc posé en surimpression, sous l'en-tête.
    static func showsEmptyState(_ card: AuditCard) -> Bool {
        card.status == .failed || AuditPresentation.followUpBlocks(card) == [.stoppedBeforeLaunch]
    }

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
                if !Self.showsEmptyState(card) { content(card) }
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
        .coordinateSpace(.named(Space.detail))
        .overlay(alignment: .top) {
            if let card, Self.showsEmptyState(card) {
                emptyState(card)
                    .padding(.top, headerBottom)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let card, card.status == .proposed {
                checkedBar(card)
            }
        }
        .navigationTitle(ConsoleSection.audit.title)
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

    // MARK: - En-tête (S-6, S-7)

    private func header(_ card: AuditCard) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                Text(verbatim: AuditPresentation.headerCaption(card))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                moreMenu(card)
            }
            orientationTitle(card)
            if orientationTruncated || orientationExpanded {
                Button(orientationExpanded ? AuditText.hideFullOrientation : AuditText.showFullOrientation) {
                    orientationExpanded.toggle()
                }
                .buttonStyle(.borderless)
                .font(.callout)
                .accessibilityIdentifier(IOSAuditAccessibility.orientationToggle)
            }
            IOSAuditStepper(steps: Self.steps(card, briefAudit: model.briefAudit))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSAuditAccessibility.header)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.frame(in: .named(Space.detail)).maxY
        } action: { bottom in
            headerBottom = bottom
        }
    }

    /// L'orientation en titre : deux lignes repliée, entière dépliée. Le texte
    /// entier, mesuré en arrière-plan par `ViewThatFits(in: .vertical)`, dit s'il
    /// est tronqué — sans `fixedSize` vertical (Doc-5).
    private func orientationTitle(_ card: AuditCard) -> some View {
        Text(verbatim: card.orientation)
            .font(.title3.weight(.semibold))
            .lineLimit(orientationExpanded ? nil : IOSMetrics.auditHeaderOrientationLines)
            .textSelection(.enabled)
            .background {
                if !orientationExpanded {
                    ViewThatFits(in: .vertical) {
                        Text(verbatim: card.orientation)
                            .font(.title3.weight(.semibold))
                            .hidden()
                            .onAppear { orientationTruncated = false }
                        Color.clear
                            .onAppear { orientationTruncated = true }
                    }
                    .accessibilityHidden(true)
                }
            }
    }

    /// Le menu « ⋯ » : les entrées du menu contextuel de la rangée (S-3).
    private func moreMenu(_ card: AuditCard) -> some View {
        Menu {
            IOSContextMenuItems(actions: IOSContextMenu.auditRow(card, gesturesEnabled: model.gesturesEnabled)) {
                perform($0, on: card)
            }
        } label: {
            Label(AuditText.moreActions, systemImage: IOSAuditSymbol.more)
                .labelStyle(.iconOnly)
                .font(.title3)
                .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
        }
        .accessibilityIdentifier(IOSAuditAccessibility.menu)
    }

    private func perform(_ action: IOSMenuAction, on card: AuditCard) {
        switch action {
        case .copyPath(let path):
            IOSPasteboard.copy(path)
        case .openInProject:
            openProject(card.repoKey)
        case .stopAudit:
            model.requestStop(card)
        default:
            break
        }
    }

    // MARK: - Contenu selon le statut

    @ViewBuilder private func content(_ card: AuditCard) -> some View {
        switch card.status {
        case .analysing:
            analysis(card)
        case .failed:
            // Rendu en surimpression sous l'en-tête (`emptyState`).
            EmptyView()
        case .proposed:
            proposals(card)
        case .launched, .stopped:
            ForEach(AuditPresentation.followUpBlocks(card), id: \.self) { block in
                followUp(block, of: card)
            }
        }
    }

    // MARK: - Analyse (S-8)

    private func analysis(_ card: AuditCard) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(AuditText.analysisCardTitle)
                        .font(.headline)
                }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(AuditText.analysisElapsed(AuditPresentation.elapsed(
                        ms: context.date.timeIntervalSince1970 * 1000 - card.createdAt
                    )))
                    .monospacedDigit()
                }
                Text(AuditText.analysisNext)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                stopButton(card)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(IOSAuditAccessibility.analysis)
        }
    }

    /// « Arrêter l'audit… » discret de la carte d'analyse, avec confirmation.
    @ViewBuilder private func stopButton(_ card: AuditCard) -> some View {
        if model.isInFlight(.stop(auditId: card.id)) {
            ProgressView()
        } else {
            Button(AuditText.stopAudit, role: .destructive) { model.requestStop(card) }
                .buttonStyle(.borderless)
                .font(.callout)
                .disabled(!model.gesturesEnabled)
                .accessibilityIdentifier(IOSAuditAccessibility.stop)
        }
    }

    // MARK: - Échec (S-11)

    /// L'état vide natif d'un audit en échec ou arrêté avant lancement.
    @ViewBuilder private func emptyState(_ card: AuditCard) -> some View {
        if card.status == .failed {
            failure(card)
        } else {
            stoppedEmpty
        }
    }

    private var stoppedEmpty: some View {
        ContentUnavailableView {
            Label(AuditText.stoppedTitle, systemImage: IOSAuditSymbol.stopped)
        } description: {
            Text(AuditText.stoppedBeforeLaunch)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSAuditAccessibility.stoppedEmpty)
    }

    private func failure(_ card: AuditCard) -> some View {
        ContentUnavailableView {
            Label(AuditText.failedTitle, systemImage: IOSAuditSymbol.failed)
        } description: {
            Text(verbatim: AuditPresentation.failureSentence(card.failure))
        } actions: {
            VStack(spacing: 12) {
                if model.isInFlight(.start) {
                    ProgressView()
                } else {
                    Button {
                        Task { await model.relaunch(card) }
                    } label: {
                        Label(AuditText.relaunch, systemImage: IOSAuditSymbol.relaunch)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.gesturesEnabled)
                    .accessibilityIdentifier(IOSAuditAccessibility.relaunch)
                }
                Button(AuditText.copyDiagnostic) { IOSPasteboard.copy(AuditPresentation.diagnostic(card)) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier(IOSAuditAccessibility.diagnostic)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSAuditAccessibility.failure)
    }

    // MARK: - Propositions (S-9)

    @ViewBuilder private func proposals(_ card: AuditCard) -> some View {
        let weaknesses = card.proposals.filter { $0.kind == .weakness }
        let features = card.proposals.filter { $0.kind == .feature }
        if card.proposals.isEmpty {
            Section {
                Text(AuditText.noProposal)
                    .foregroundStyle(.secondary)
            }
        }
        if !weaknesses.isEmpty {
            Section(AuditText.weaknesses) {
                ForEach(weaknesses) { proposalRow($0, in: card) }
            }
        }
        if !features.isEmpty {
            Section(AuditText.featuresTitle) {
                ForEach(features) { proposalRow($0, in: card) }
            }
        }
    }

    /// La barre collante du bas : « N cochées » et « Relire le brief → ».
    private func checkedBar(_ card: AuditCard) -> some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 12) {
                Text(AuditText.checkedCount(model.selectedSlugs(of: card).count))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(IOSAuditAccessibility.checkedCount)
                Spacer(minLength: 8)
                Button(AuditText.reviewBrief) { model.presentBrief(card) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.gesturesEnabled || !model.canReviewBrief(card))
                    .accessibilityIdentifier(IOSAuditAccessibility.reviewBrief)
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
        }
        .background(.bar)
    }

    /// Une case en rangée-bouton : le symbole dit l'état, VoiceOver le lit en valeur.
    /// L'intention en texte principal, le slug en légende monospace, « après X » pour
    /// les dépendances, « déjà prise » en pastille.
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
                    Text(verbatim: row.intention)
                        .font(.body)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: row.slug)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                        if !row.deps.isEmpty {
                            Text(AuditText.after(row.deps))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if row.taken {
                        Text(AuditText.taken)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color.secondary.opacity(0.15)))
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

    // MARK: - Pipelines (S-10)

    @ViewBuilder private func followUp(_ block: AuditFollowUpBlock, of card: AuditCard) -> some View {
        switch block {
        case .escalations:
            ForEach(Array(card.escalations.enumerated()), id: \.element.id) { index, escalation in
                Section {
                    IOSAuditEscalationRow(model: model, auditId: card.id, escalation: escalation)
                        .iosBanner(tone: .attention)
                        .listRowInsets(EdgeInsets())
                } header: {
                    if index == 0 { Text(AuditText.escalationsTitle) }
                }
            }
        case .progress:
            Section(AuditText.progressTitle) {
                ForEach(card.features) { featureRow($0) }
            }
        case .notLaunched:
            Section(AuditText.notLaunchedTitle) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(card.launches, id: \.slug) { outcome in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: outcome.slug)
                                .font(.callout.monospaced())
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
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(IOSAuditAccessibility.notLaunched)
            }
        case .decisions:
            Section {
                DisclosureGroup(isExpanded: $decisionsExpanded) {
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
                } label: {
                    Text(AuditText.decisionsGroupTitle(card.decisions.count))
                }
                .accessibilityIdentifier(IOSAuditAccessibility.decisions)
            }
        case .stoppedBeforeLaunch:
            // Rendu en surimpression sous l'en-tête (`emptyState`).
            EmptyView()
        }
    }

    /// Une feature lancée : son slug, sa barre de progression (teintée « danger »
    /// sur une étape en échec, lue étape par étape), son état d'attente et, avec
    /// une PR, « Ouvrir la PR ».
    private func featureRow(_ row: AuditFeatureRow) -> some View {
        let steps = AuditPresentation.featureSteps(row)
        let done = steps.filter { $0.state == .done }.count
        let failed = steps.contains { $0.state == .failed }
        return VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: row.slug)
                    .font(.callout.monospaced().weight(.semibold))
                ProgressView(value: Double(done), total: Double(steps.count))
                    .tint(failed ? ConsoleTone.danger.tint : nil)
                    .accessibilityValue(AuditText.stepsAccessibility(steps))
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
}

/// La frise des 4 étapes d'un audit (audit-ui-redesign, S-7) : quatre colonnes
/// symbole-sur-titre quand elles tiennent sur la largeur, sinon quatre rangées
/// symbole + titre (Dynamic Type). VoiceOver la lit d'un bloc, « Analyse : fait,
/// Propositions : en cours, … ».
struct IOSAuditStepper: View {
    let steps: [PipelineStep]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 8) {
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    VStack(spacing: 4) {
                        symbol(step.state)
                        Text(step.title)
                            .font(.caption)
                            .foregroundStyle(step.state == .upcoming ? Color.secondary : Color.primary)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    Label {
                        Text(step.title)
                            .foregroundStyle(step.state == .upcoming ? Color.secondary : Color.primary)
                    } icon: {
                        symbol(step.state)
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(AuditText.stepsAccessibility(steps))
        .accessibilityIdentifier(IOSAuditAccessibility.stepper)
    }

    private func symbol(_ state: PipelineStepState) -> some View {
        Image(systemName: Self.symbolName(state))
            .foregroundStyle(Self.tint(state))
            .accessibilityHidden(true)
    }

    /// Le symbole d'un état d'étape.
    static func symbolName(_ state: PipelineStepState) -> String {
        switch state {
        case .done: IOSAuditSymbol.stepDone
        case .current: IOSAuditSymbol.stepCurrent
        case .failed: IOSAuditSymbol.stepFailed
        case .upcoming: IOSAuditSymbol.stepUpcoming
        }
    }

    private static func tint(_ state: PipelineStepState) -> Color {
        switch state {
        case .done: ConsoleTone.success.tint
        case .current: Color.accentColor
        case .failed: ConsoleTone.danger.tint
        case .upcoming: Color.secondary
        }
    }
}

/// Une question en attente : « <slug> · <phase> », la question, le motif de
/// l'arbitre, puis la réponse attendue — options et « Autre réponse », ou les deux
/// décisions de jalon. Le détail la pose en carte orange (`iosBanner(tone: .attention)`).
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
        .frame(maxWidth: .infinity, alignment: .leading)
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
