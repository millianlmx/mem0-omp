// La section « Audit » de la coque (audit-panel-in-omp-console S-6, refondue par
// audit-ui-redesign BR-2) : la liste des audits (style inset, 220 à 260 pt) à
// gauche, le détail de l'audit sélectionné à droite avec, pour un audit proposé,
// la barre collante « N cochées » / « Relire le brief → », et « Nouvel audit »
// dans la barre d'outils. Les feuilles (lancement, brief) et la confirmation
// d'arrêt sont présentées ici, sur l'état du modèle.
//
// Aucun mot ici : tous viennent d'`AuditText` (ou des textes partagés de la coque).
// Aucun `.fixedSize(horizontal: false, vertical: true)` sur un `Text` du détail
// (piège mem0 05ccad68). Aucun `@State` : l'état de vue est `AuditViewState`.

import ConsoleCore
import SwiftUI

/// Les identifiants d'accessibilité de la section, en un seul endroit : les vues
/// les posent, les preuves et la recette les nomment.
enum AuditAccessibility {
    static let start = "audit.start"
    static let emptyStart = "audit.empty.start"
    static let list = "audit.list"
    static let loading = "audit.loading"
    static let failure = "audit.failure"
    static let failureDiagnostic = "audit.failure.diagnostic"
    static let retry = "audit.retry"
    static let orientation = "audit.orientation"
    static let orientationToggle = "audit.orientation.toggle"
    static let stepper = "audit.stepper"
    static let menu = "audit.menu"
    static let stop = "audit.stop"
    static let stopConfirm = "audit.stop.confirm"
    static let reviewBrief = "audit.reviewBrief"
    static let checkedCount = "audit.checkedCount"
    static let proposalsWeaknesses = "audit.proposals.weaknesses"
    static let proposalsFeatures = "audit.proposals.features"
    static let analysing = "audit.analysing"
    static let analysisFailed = "audit.analysisFailed"
    static let analysisDiagnostic = "audit.analysisFailed.diagnostic"
    static let relaunch = "audit.relaunch"
    static let stoppedEmpty = "audit.stoppedEmpty"
    static let progress = "audit.progress"
    static let notLaunchedGroup = "audit.notLaunched"
    static let escalations = "audit.escalations"
    static let decisions = "audit.decisions"

    static let launchRepository = "audit.launch.repository"
    static let launchChoose = "audit.launch.choose"
    static let launchOrientation = "audit.launch.orientation"
    static let launchMessage = "audit.launch.message"
    static let launchCancel = "audit.launch.cancel"
    static let launchCommit = "audit.launch.commit"

    static let briefEditor = "audit.brief.editor"
    static let briefError = "audit.brief.error"
    static let briefFailure = "audit.brief.failure"
    static let briefCancel = "audit.brief.cancel"
    static let briefCommit = "audit.brief.commit"

    static func row(_ id: String) -> String { "audit.row.\(id)" }
    /// Une entrée du menu contextuel de la rangée `id`.
    static func rowMenu(_ id: String, _ item: AuditMenuItem) -> String { "audit.row.\(id).\(menuSuffix(item))" }
    /// Une entrée du menu « ⋯ » de l'en-tête.
    static func headerMenu(_ item: AuditMenuItem) -> String { "audit.menu.\(menuSuffix(item))" }
    /// Une entrée du menu d'un audit : celui de la rangée `row`, ou — `nil` — le
    /// menu « ⋯ » de l'en-tête.
    static func menuItem(_ item: AuditMenuItem, row: String?) -> String {
        row.map { rowMenu($0, item) } ?? headerMenu(item)
    }
    private static func menuSuffix(_ item: AuditMenuItem) -> String {
        switch item {
        case .copyPath: "copyPath"
        case .openInProject: "openProject"
        case .stop: "stop"
        }
    }
    static func proposal(_ slug: String) -> String { "audit.proposal.\(slug)" }
    static func feature(_ slug: String) -> String { "audit.feature.\(slug)" }
    static func featurePR(_ slug: String) -> String { "audit.feature.\(slug).pr" }
    static func notLaunched(_ slug: String) -> String { "audit.notLaunched.\(slug)" }
    static func escalation(_ slug: String) -> String { "audit.escalation.\(slug)" }
    static func escalationText(_ slug: String) -> String { "audit.escalation.\(slug).text" }
    static func escalationAnswer(_ slug: String) -> String { "audit.escalation.\(slug).answer" }
    static func escalationOption(_ slug: String, _ index: Int) -> String { "audit.escalation.\(slug).option.\(index)" }
    static func escalationApprove(_ slug: String) -> String { "audit.escalation.\(slug).approve" }
    static func escalationAbandon(_ slug: String) -> String { "audit.escalation.\(slug).abandon" }
    static func decision(_ index: Int) -> String { "audit.decision.\(index)" }
}

struct AuditView: ConsoleSectionView {
    static let section = ConsoleSection.audit

    @ObservedObject var model: AuditConsoleModel
    /// « Ouvrir dans Projet » : la coque bascule sur la section Projet
    /// (`AuditProjectBridge`), branchée par `SectionDetail`.
    let openInProject: @MainActor (AuditCard) -> Void
    /// L'état de vue (orientations dépliées, décisions dépliées).
    @StateObject private var viewState = AuditViewState()

    init(model: AuditConsoleModel, openInProject: @escaping @MainActor (AuditCard) -> Void) {
        self.model = model
        self.openInProject = openInProject
    }

    /// La confirmation d'arrêt : présentée si et seulement si un arrêt attend.
    private var stopBinding: Binding<Bool> {
        Binding(
            get: { model.pendingStop != nil },
            set: { if !$0 { model.cancelStop() } }
        )
    }

    /// La feuille du brief : toute fermeture passe par `cancelBrief` (AC-3).
    private var briefBinding: Binding<Bool> {
        Binding(
            get: { model.isBriefSheetPresented },
            set: { if !$0 { model.cancelBrief() } }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            if let failure = model.failure, !model.isBriefSheetPresented {
                AuditFailureBanner(model: model, failure: failure)
            }
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { model.presentLaunchSheet() } label: {
                    Label(AuditText.newAudit, systemImage: "text.magnifyingglass")
                }
                .labelStyle(.titleAndIcon)
                .help(AuditText.startAudit)
                .disabled(model.busy)
                .accessibilityIdentifier(AuditAccessibility.start)
            }
        }
        .sheet(isPresented: $model.isLaunchSheetPresented) {
            AuditLaunchSheet(model: model)
        }
        .sheet(isPresented: briefBinding) {
            AuditBriefSheet(model: model)
        }
        .confirmationDialog(AuditText.stopTitle, isPresented: stopBinding, titleVisibility: .visible) {
            Button(AuditText.stopConfirm, role: .destructive) {
                Task { @MainActor in await model.confirmStop() }
            }
            .accessibilityIdentifier(AuditAccessibility.stopConfirm)
            Button(AuditText.cancel, role: .cancel) { model.cancelStop() }
        } message: {
            Text(AuditText.stopMessage)
        }
        .task { model.start() }
    }

    @ViewBuilder
    private var content: some View {
        if !model.isLoaded {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier(AuditAccessibility.loading)
        } else if model.board.audits.isEmpty {
            emptyState
        } else {
            HStack(spacing: 0) {
                AuditListView(model: model, openInProject: openInProject)
                    .frame(minWidth: 220, idealWidth: 240, maxWidth: 260)
                Divider()
                ScrollView {
                    if let card = model.selectedCard {
                        AuditDetailView(model: model, viewState: viewState, card: card, openInProject: openInProject)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                    } else if model.selection != nil {
                        // L'audit tout juste créé, pas encore relu dans le magasin.
                        ProgressView()
                            .padding(24)
                            .frame(maxWidth: .infinity)
                    }
                }
                // La barre « N cochées » reste visible quel que soit le défilement :
                // le contenu défilant est rentré de sa hauteur (Doc-7).
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if let card = model.selectedCard, card.status == .proposed {
                        AuditProposalsBar(model: model, card: card)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(AuditText.emptyTitle, systemImage: ConsoleSection.audit.systemImage)
        } description: {
            Text(AuditText.emptyHelp)
        } actions: {
            Button(AuditText.startAudit) { model.presentLaunchSheet() }
                .buttonStyle(.borderedProminent)
                .disabled(model.busy)
                .accessibilityIdentifier(AuditAccessibility.emptyStart)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Le bandeau d'échec du dernier geste : la phrase, « Copier le diagnostic », et
/// — service arrêté — « Réessayer ». Retiré au geste suivant réussi.
struct AuditFailureBanner: View {
    @ObservedObject var model: AuditConsoleModel
    let failure: ReadableFailure

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
            VStack(alignment: .leading, spacing: 2) {
                if model.serviceDown {
                    Text(verbatim: ServiceUnavailable.stopped.userMessage)
                        .font(.callout.weight(.semibold))
                }
                Text(verbatim: failure.message)
            }
            Spacer(minLength: 8)
            if model.serviceDown {
                Button(SessionConsoleText.retry) {
                    Task { @MainActor in await model.retry() }
                }
                .controlSize(.small)
                .disabled(model.busy)
                .accessibilityIdentifier(AuditAccessibility.retry)
            }
            DiagnosticCopyButton(diagnostic: failure.diagnostic, identifier: AuditAccessibility.failureDiagnostic)
        }
        .font(.callout)
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleBanner(tint: .orange)
        .padding(8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AuditAccessibility.failure)
    }
}
