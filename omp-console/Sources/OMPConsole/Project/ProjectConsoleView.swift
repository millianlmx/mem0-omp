// La vue « Projet » (BR-3 ; S-19 R3 de omp-console-redesign), au patron de
// « Session OMP » : un en-tête (nom, dépôt, état en mots, arrêt, détails), le
// volet « PR et CI », Plan | Document, puis la CONVERSATION de la session hébergée
// (`ConversationThread`, sur le fichier de session d'`omp`) et un composeur. Les
// dialogues de `/project` s'ouvrent en feuille ; les trames brutes, l'activité
// résumée, le journal, le pid et l'identifiant de session vivent dans
// l'inspecteur « Détails techniques » — jamais dans la vue principale.
//
// La section « Projet » de la coque rend EXACTEMENT cette vue (`ProjectView`),
// pour qu'il n'existe pas deux surfaces à tenir synchronisées ; seule la fenêtre
// « Projet » prend le nom du projet pour titre.
//
// Aucun attribut macro SwiftUI : l'état de dépliage, des feuilles, des
// confirmations et de l'inspecteur vit dans le modèle. Le dialogue vient de
// `Session/RpcPanes.swift`.

import AppKit
import ConsoleCore
import SwiftUI

struct ProjectConsoleView: View {
    @ObservedObject var model: ProjectConsoleModel
    // La session est observée séparément : son journal et sa file de dialogues
    // changent sans que le modèle publie quoi que ce soit.
    @ObservedObject var host: ServiceSessionModel

    init(model: ProjectConsoleModel) {
        self.model = model
        self.host = model.host
    }

    private var refusalBinding: Binding<Bool> {
        Binding(
            get: { model.refusal != nil },
            set: { if !$0 { model.dismissRefusal() } }
        )
    }

    /// L'alerte de confirmation de fusion (S-5) : présentée si et seulement si le
    /// modèle porte une proposition issue d'une relecture fraîche.
    private var mergeBinding: Binding<Bool> {
        Binding(
            get: { model.pendingMerge != nil },
            set: { if !$0 { model.cancelMerge() } }
        )
    }

    private var mergeTitle: String {
        model.pendingMerge.map { ProjectViewText.prMergeConfirmTitle(number: $0.number) } ?? ""
    }

    private var mergeMessage: String {
        model.pendingMerge.map { ProjectViewText.prMergeConfirmMessage(title: $0.title) } ?? ""
    }

    private func stop() {
        Task { @MainActor in await model.closeConduite() }
    }

    var body: some View {
        Group {
            if model.canStartConduite {
                emptyState
            } else {
                conduite
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .frame(minWidth: 480, minHeight: 420)
        .navigationSubtitle(model.identity?.name ?? "")
        .background(WindowAccessor { model.attachWindow($0) })
        .sheet(isPresented: $model.isLaunchSheetPresented) {
            ProjectLaunchSheet(model: model)
        }
        .alert(ProjectViewText.refusalTitle, isPresented: refusalBinding) {
            Button(ProjectViewText.launchCancel, role: .cancel) { model.dismissRefusal() }
            Button(ProjectViewText.closeConduite, role: .destructive) { stop() }
        } message: {
            Text(model.refusal?.message ?? "")
        }
        .confirmationDialog(
            ProjectViewText.closeConfirmTitle,
            isPresented: $model.isStopConfirmationPresented,
            titleVisibility: .visible
        ) {
            Button(ProjectViewText.closeConduite, role: .destructive) { stop() }
                .accessibilityIdentifier("projet.close.confirm")
            Button(ProjectViewText.launchCancel, role: .cancel) {}
        } message: {
            Text(ProjectViewText.closeConfirmMessage)
        }
        .alert(mergeTitle, isPresented: mergeBinding) {
            Button(ProjectViewText.prMergeCancelButton, role: .cancel) { model.cancelMerge() }
            Button(ProjectViewText.prMergeConfirmButton) {
                Task { @MainActor in await model.confirmMerge() }
            }
        } message: {
            Text(mergeMessage)
        }
        .task { model.start() }
    }

    /// Aucun projet piloté : un état vide standard, une seule action proéminente.
    /// Le message d'une session interrompue y reste lisible.
    private var emptyState: some View {
        ContentUnavailableView {
            Label(ProjectViewText.emptyTitle, systemImage: "scope")
        } description: {
            VStack(spacing: 6) {
                Text(ProjectViewText.emptyHelp)
                if !model.statusMessage.isEmpty {
                    Text(model.statusMessage)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("projet.error")
                }
            }
        } actions: {
            Button(ProjectViewText.startConduite) { model.presentLaunchSheet() }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("projet.start")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Pilotage

    private var conduite: some View {
        VStack(spacing: 0) {
            ProjectHeaderView(model: model)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 10)
            Divider()
            if model.state == .closing {
                VStack(spacing: 10) {
                    ProgressView()
                    Text(ProjectViewText.sessionClosing)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // Les deux volets défilent chacun : rien n'est coupé au bas de la
                // fenêtre, quelle que soit la hauteur du plan ou de la conversation.
                VSplitView {
                    projectPanes
                        .padding(12)
                        .frame(minHeight: 220, idealHeight: 300, maxHeight: .infinity)
                    conversationArea
                        .frame(minHeight: 200, maxHeight: .infinity)
                }
            }
            Divider()
            composer
        }
        // Un seul dialogue à la fois : le PREMIER de la file ; la feuille ne se
        // ferme que par une réponse ou une annulation, qui le retirent de la file.
        .sheet(item: pendingDialog) { dialog in
            ProjectDialogSheet(model: model, dialog: dialog)
        }
        .inspector(isPresented: $model.technicalShown) { inspector }
    }

    /// PR et CI, puis Plan | Document.
    @ViewBuilder private var projectPanes: some View {
        if model.state == .starting {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(ProjectViewText.sessionStarting)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ProjectPRPane(model: model)
                HSplitView {
                    ProjectPlanPane(
                        sections: model.project.map(projectPlanSections) ?? [],
                        project: model.project,
                        expanded: $model.expandedSegments
                    )
                    .frame(minWidth: 260, maxHeight: .infinity)
                    ProjectDocPane(blocks: model.docBlocks)
                        .frame(minWidth: 260, maxHeight: .infinity)
                }
            }
        }
    }

    // MARK: - Conversation (S-19 R3)

    @ViewBuilder private var conversationArea: some View {
        if let conversation = model.conversation {
            ConversationThread(model: conversation)
                .id(conversation.target.sessionFile)
                .accessibilityIdentifier("projet.conversation")
        } else if model.state == .starting {
            VStack(spacing: 10) {
                ProgressView()
                Text(ProjectViewText.sessionStarting)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView {
                Label(ProjectViewText.conversationWaitingTitle, systemImage: "bubble.left.and.bubble.right")
            } description: {
                Text(ProjectViewText.conversationWaiting)
            }
            .controlSize(.small)
        }
    }

    // MARK: - Composeur (patron « Session OMP »)

    private var composerPlaceholder: String {
        if model.hasPendingDialog { return ProjectViewText.composerBlocked }
        return model.state == .live ? ProjectViewText.composerLive : ProjectViewText.composerIdle
    }

    private func send() {
        Task { @MainActor in await model.sendText() }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField(composerPlaceholder, text: $model.prompt)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
                .disabled(model.state != .live || model.hasPendingDialog)
                .onSubmit { if model.canSendText { send() } }
                .accessibilityIdentifier("projet.prompt")
            Button { send() } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title)
            }
            .buttonStyle(.plain)
            .foregroundStyle(model.canSendText ? Color.accentColor : Color.secondary)
            .disabled(!model.canSendText)
            .accessibilityLabel(SessionConsoleText.send)
            .accessibilityIdentifier("projet.send")
        }
        .padding(12)
    }

    // MARK: - Dialogue en feuille

    private var pendingDialog: Binding<RpcDialogRequest?> {
        Binding(get: { host.dialogQueue.first }, set: { _ in })
    }

    // MARK: - Inspecteur « Détails techniques » (patron S-18 R8)

    private var inspector: some View {
        Form {
            Section(SessionConsoleText.sectionSession) {
                LabeledContent(ProjectViewText.launchRepository) {
                    Text(model.identity?.repoRoot.path ?? SessionConsoleText.none)
                        .textSelection(.enabled)
                        .truncationMode(.middle)
                }
                LabeledContent(SessionConsoleText.fieldState, value: SessionConsoleText.inspectorState(host.state))
                LabeledContent(SessionConsoleText.fieldSessionId) {
                    Text(host.sessionId ?? SessionConsoleText.none)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .truncationMode(.middle)
                }
                Text(model.sessionStatusText)
                    .font(.callout)
                    .textSelection(.enabled)
                DiagnosticCopyButton(
                    diagnostic: SessionConsoleText.diagnostic(
                        pid: host.pid,
                        state: host.state,
                        sessionId: host.sessionId,
                        projectPath: model.identity?.repoRoot.path,
                        sessionFile: host.sessionFile
                    ),
                    identifier: "projet.diagnostic.copy"
                )
            }

            Section(SessionConsoleText.sectionJournal) {
                if host.journal.isEmpty {
                    Text(SessionConsoleText.noJournal)
                        .foregroundStyle(.secondary)
                }
                ForEach(host.journal.reversed()) { entry in
                    Text(SessionConsoleText.journalLine(entry))
                        .font(.caption)
                        .textSelection(.enabled)
                }
            }
            .accessibilityIdentifier("projet.journal")
        }
        .formStyle(.grouped)
        .inspectorColumnWidth(min: 320, ideal: 420, max: 640)
    }
}

// MARK: - Feuille de dialogue (S-19 R3)

/// Un dialogue de `/project`, au patron de « Session OMP » : « OMP vous demande »,
/// le compteur « Question n sur m » quand le titre se termine par « (n/m) », la
/// question, puis — pour la revue du plan — le reste du titre RENDU en Markdown
/// dans un bloc défilable d'au plus 360 pt, enfin la forme de réponse et sa
/// rangée de boutons (à droite). Le plan reçu est montré EN ENTIER : seul le bloc
/// défile, rien n'est coupé. Le fond est opaque : la fenêtre ne transparaît pas.
struct ProjectDialogSheet: View {
    @ObservedObject var model: ProjectConsoleModel
    let dialog: RpcDialogRequest

    static let bodyMaxHeight: CGFloat = 360

    var body: some View {
        let parts = ProjectDialogText.split(dialog.title)
        let step = ProjectDialogText.step(parts.heading)
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(SessionConsoleText.dialogTitle)
                    .font(.title3.bold())
                if let counter = step.counter {
                    Text(counter)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("projet.dialog.step")
                }
            }
            Text(step.question)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("projet.dialog.title")
            if let text = parts.body {
                // `fixedSize` vertical : le bloc prend la hauteur de son contenu,
                // bornée à 360 pt ; au-delà, il défile.
                ScrollView {
                    MarkdownBlocksView(markdown: text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                }
                .frame(maxHeight: Self.bodyMaxHeight)
                .fixedSize(horizontal: false, vertical: true)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityIdentifier("projet.dialog.body")
            }
            RpcDialogPane(
                idPrefix: "projet",
                dialog: dialog,
                dialogText: $model.dialogText,
                selectedOptionIndex: $model.selectedOptionIndex,
                canAnswer: model.canAnswerDialog,
                onAnswerSelected: { model.answerSelectedOption() },
                onAnswerText: { model.answerDialogText() },
                onConfirm: { model.confirmDialog($0) },
                onCancel: { model.cancelDialog() },
                onAppeared: { model.dialogAppeared($0) },
                showsHeader: false,
                showsTitle: false,
                cancelTitle: ProjectViewText.dialogCancel
            )
        }
        .padding(20)
        .frame(width: parts.body == nil ? 480 : 620)
        .background(.background)
        .interactiveDismissDisabled(true)
        .onExitCommand { model.cancelDialog() }
    }
}

// MARK: - En-tête

struct ProjectHeaderView: View {
    @ObservedObject var model: ProjectConsoleModel
    // L'état en mots suit la session, qui publie sans passer par le modèle.
    @ObservedObject var host: ServiceSessionModel

    init(model: ProjectConsoleModel) {
        self.model = model
        self.host = model.host
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.identity?.name ?? ProjectViewText.windowTitle)
                        .font(.title2.weight(.semibold))
                        .lineLimit(1)
                        .accessibilityIdentifier("projet.name")
                    if let repo = model.identity?.repoRoot.path {
                        Text(ConsoleFormat.path(repo))
                            .font(.callout)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("projet.repo")
                    }
                }
                Spacer(minLength: 8)
                StatusPill(status: model.sessionStatus)
                    .accessibilityIdentifier("projet.sessionStatus")
                Button { model.technicalShown.toggle() } label: {
                    Label(SessionConsoleText.details, systemImage: "info.circle")
                        .labelStyle(.iconOnly)
                }
                .help(SessionConsoleText.details)
                .accessibilityLabel(SessionConsoleText.details)
                .accessibilityIdentifier("projet.details")
                Button(ProjectViewText.closeConduite, role: .destructive) {
                    model.isStopConfirmationPresented = true
                }
                .disabled(!model.canCloseConduite)
                .accessibilityIdentifier("projet.close")
            }

            if let project = model.project {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(projectStatusLine(of: project))
                        .accessibilityIdentifier("projet.status")
                    Text("·")
                        .foregroundStyle(.secondary)
                    Text(projectProgressLine(of: project))
                        .foregroundStyle(.secondary)
                }
                .font(.callout)
                .lineLimit(1)
            }

            if !model.statusMessage.isEmpty {
                Text(model.statusMessage)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("projet.error")
            }

            if model.notice != nil {
                notice
            }

            if model.awaitingUser {
                Text(model.waitingDialogCount > 1
                    ? ProjectViewText.waitingCount(model.waitingDialogCount)
                    : ProjectViewText.waitingBanner)
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("projet.banner")
            } else if model.isProjectDone, let project = model.project {
                let counts = projectProgressCounts(of: project)
                Text(ProjectViewText.doneBanner(m: counts.merged, n: counts.total))
                    .font(.callout)
                    .foregroundStyle(.green)
                    .accessibilityIdentifier("projet.banner")
            }
        }
    }

    /// La dernière notification du pilote, DÉCODÉE et rendue en Markdown ; un
    /// long message défile dans un bloc borné plutôt que de pousser la vue.
    private var notice: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "info.circle")
                .foregroundStyle(.secondary)
            ScrollView {
                MarkdownBlocksView(blocks: model.noticeBlocks)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 96)
            .fixedSize(horizontal: false, vertical: true)
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("projet.notice")
    }
}

// MARK: - Volet « Plan »

struct ProjectPlanPane: View {
    let sections: [ProjectPlanSection]
    let project: Project?
    @Binding var expanded: Set<Int>

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(ProjectViewText.planTitle)
                    .font(.headline)
                if project == nil {
                    Text(ProjectViewText.projectMissing)
                        .foregroundStyle(.secondary)
                } else if sections.isEmpty {
                    Text(ProjectViewText.emptyPlan)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(sections, id: \.index) { section in
                        DisclosureGroup(isExpanded: binding(for: section.index)) {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(Array(section.features.enumerated()), id: \.offset) { _, row in
                                    ProjectPlanRowView(row: row)
                                }
                                if !section.removed.isEmpty {
                                    Text(ProjectViewText.removedTitle)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    ForEach(Array(section.removed.enumerated()), id: \.offset) { _, row in
                                        ProjectPlanRowView(row: row)
                                    }
                                }
                            }
                            .padding(.leading, 8)
                            .padding(.top, 4)
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(ProjectViewText.segmentTitle(
                                    index: section.index + 1,
                                    count: sections.count,
                                    name: section.name
                                ))
                                .font(.callout.weight(.medium))
                                Spacer(minLength: 4)
                                Text(section.state.label)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
        }
        .accessibilityIdentifier("projet.plan")
    }

    private func binding(for index: Int) -> Binding<Bool> {
        Binding(
            get: { expanded.contains(index) },
            set: { if $0 { expanded.insert(index) } else { expanded.remove(index) } }
        )
    }
}

struct ProjectPlanRowView: View {
    let row: ProjectPlanRow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(row.slug)
                    .font(.callout)
                Text("· \(row.stateLabel)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let models = row.models {
                    Text("· \(models)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if let prUrl = row.prUrl, let url = httpURL(prUrl) {
                    Link("PR", destination: url)
                        .accessibilityIdentifier("projet.pr")
                }
            }
            if !row.intention.isEmpty {
                Text(row.intention)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let reason = row.removedReason, !reason.isEmpty {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

}

// MARK: - Volet « Document »

/// `PROJECT.md` rendu par le composant Markdown commun de l'app (titres, listes,
/// vrais tableaux), analysé une fois par version par le modèle.
struct ProjectDocPane: View {
    let blocks: [MarkdownBlock]?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(ProjectViewText.docTitle)
                    .font(.headline)
                if let blocks {
                    MarkdownBlocksView(blocks: blocks)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(ProjectViewText.docMissing)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
        }
        .accessibilityIdentifier("projet.doc")
    }
}
