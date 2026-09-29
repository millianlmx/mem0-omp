// La fenêtre « Projet » (BR-3) : en-tête, volets Plan et Document, session
// hébergée (transcription, dialogue, saisie).
//
// La section « Projet » de la coque rend EXACTEMENT cette vue (`ProjectView`),
// pour qu'il n'existe pas deux surfaces à tenir synchronisées.
//
// Aucun attribut macro SwiftUI : l'état de dépliage et l'état de la feuille vivent
// dans le modèle. Les volets de session viennent de `Session/RpcPanes.swift`.

import AppKit
import SwiftUI

struct ProjectConsoleView: View {
    @ObservedObject var model: ProjectConsoleModel
    @ObservedObject var host: SessionHost

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

    var body: some View {
        Group {
            if model.canStartConduite {
                emptyState
            } else {
                conduite
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .frame(minWidth: 760, minHeight: 520)
        .background(WindowAccessor { model.attachWindow($0) })
        .sheet(isPresented: $model.isLaunchSheetPresented) {
            ProjectLaunchSheet(model: model)
        }
        .alert(ProjectViewText.refusalTitle, isPresented: refusalBinding) {
            Button(ProjectViewText.closeConduite) {
                Task { @MainActor in await model.closeConduite() }
            }
            Button(ProjectViewText.launchCancel, role: .cancel) { model.dismissRefusal() }
        } message: {
            Text(model.refusal?.message ?? "")
        }
        .task { model.start() }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(ProjectViewText.emptyTitle)
                .font(.largeTitle)
            Text(ProjectViewText.emptyHelp)
                .foregroundStyle(.secondary)
            Button(ProjectViewText.startConduite) { model.presentLaunchSheet() }
                .accessibilityIdentifier("projet.start")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    private var conduite: some View {
        VStack(alignment: .leading, spacing: 10) {
            ProjectHeaderView(model: model)
            Divider()

            switch model.state {
            case .starting:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(ProjectViewText.sessionStarting)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            case .closing:
                Text(ProjectViewText.sessionClosing)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            default:
                sessionPanes
            }
        }
    }

    private var sessionPanes: some View {
        VStack(alignment: .leading, spacing: 10) {
            HSplitView {
                ProjectPlanPane(
                    sections: model.project.map(projectPlanSections) ?? [],
                    project: model.project,
                    expanded: $model.expandedSegments
                )
                ProjectDocPane(docText: model.docText)
            }
            .frame(minHeight: 180)

            if let notice = model.notice {
                Text(notice)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("projet.notice")
            }

            RpcTranscriptPane(idPrefix: "projet", lines: host.transcript)

            if let dialog = host.dialogQueue.first {
                Divider()
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
                    onAppeared: { model.dialogAppeared($0) }
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.orange, lineWidth: model.awaitingUser ? 2 : 0)
                )
            }

            Divider()
            RpcPromptBar(
                idPrefix: "projet",
                prompt: $model.prompt,
                placeholder: model.state == .live
                    ? "Saisissez un texte puis ↩."
                    : "Lancez la conduite pour saisir un texte.",
                isEditable: model.state == .live,
                canSend: model.canSendText,
                blockedByDialog: model.hasPendingDialog,
                blockedNote: "Répondez au dialogue en cours pour débloquer le tour.",
                onSend: { Task { @MainActor in await model.sendText() } }
            )
        }
    }
}

// MARK: - En-tête

struct ProjectHeaderView: View {
    @ObservedObject var model: ProjectConsoleModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(model.identity?.name ?? "—")
                    .font(.headline)
                    .accessibilityIdentifier("projet.name")
                Text(model.identity?.repoRoot.path ?? "")
                    .font(.system(.callout, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("projet.repo")
                Spacer(minLength: 8)
                Button(ProjectViewText.closeConduite) {
                    Task { @MainActor in await model.closeConduite() }
                }
                .disabled(!model.canCloseConduite)
                .accessibilityIdentifier("projet.close")
                Button(ProjectViewText.startConduite) { model.presentLaunchSheet() }
                    .disabled(!model.canStartConduite)
                    .accessibilityIdentifier("projet.start")
            }

            if let project = model.project {
                Text(projectStatusLine(of: project))
                    .accessibilityIdentifier("projet.status")
                Text(projectProgressLine(of: project))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(model.sessionStatusText)
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("projet.sessionStatus")
            if !model.statusMessage.isEmpty {
                Text(model.statusMessage)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("projet.error")
            }

            if model.awaitingUser {
                Text(model.waitingDialogCount > 1
                    ? "\(ProjectViewText.waitingBanner) \(ProjectViewText.waitingCount(model.waitingDialogCount))"
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
}

// MARK: - Volet « Plan »

struct ProjectPlanPane: View {
    let sections: [ProjectPlanSection]
    let project: Project?
    @Binding var expanded: Set<Int>

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("Plan")
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
                            VStack(alignment: .leading, spacing: 6) {
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
                        } label: {
                            Text("Segment \(section.index + 1) — \(section.name) (\(section.state.label))")
                                .font(.system(.callout, design: .monospaced))
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
            HStack(spacing: 6) {
                Text(row.slug)
                    .font(.system(.callout, design: .monospaced))
                Text("· \(row.stateLabel)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let model = row.model {
                    Text("· \(model)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if let prUrl = row.prUrl, let url = Self.linkURL(prUrl) {
                    Link("PR", destination: url)
                        .accessibilityIdentifier("projet.pr")
                } else if row.prUrl != nil {
                    Text(row.prUrl ?? ProjectViewText.noPR)
                        .font(.caption)
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

    /// Une URL n'est cliquable que si elle est `http(s)` (S-8).
    nonisolated static func linkURL(_ value: String) -> URL? {
        guard let url = URL(string: value), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return nil }
        return url
    }
}

// MARK: - Volet « Document »

struct ProjectDocPane: View {
    let docText: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("Document")
                    .font(.headline)
                if let docText {
                    ForEach(Array(projectDocBlocks(markdown: docText).enumerated()), id: \.offset) { _, block in
                        blockView(block)
                    }
                } else {
                    Text(ProjectViewText.docMissing)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .textSelection(.enabled)
        }
        .accessibilityIdentifier("projet.doc")
    }

    @ViewBuilder
    private func blockView(_ block: ProjectDocBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(text)
                .font(level <= 1 ? .title : (level == 2 ? .title2 : .title3))
                .fontWeight(.semibold)
        case .paragraph(let attributed):
            Text(attributed)
        case .tableHeader(let cells):
            Text(cells.joined(separator: "  |  "))
                .font(.system(.callout, design: .monospaced))
                .fontWeight(.semibold)
        case .tableRow(let cells):
            Text(projectDocRowText(cells))
                .font(.system(.caption, design: .monospaced))
        case .rawText(let text):
            Text(text)
                .font(.system(.body, design: .monospaced))
        }
    }
}
