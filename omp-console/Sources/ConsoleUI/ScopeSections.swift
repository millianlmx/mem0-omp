// Les PORTÉES de la section Features autres que les features elles-mêmes, et les
// FEUILLES de création, écrites une fois pour le Mac et l'iPhone/iPad :
//  · Projets : un projet par rangée (titre, avancement, terminé ou non) ; la choisir
//    filtre les features sur ce projet ;
//  · Audits : un audit par section, ses propositions à cocher, « Lancer la sélection
//    en projet », l'analyse en direct, l'annulation ;
//  · « Nouveau projet », « Nouvel audit » et « Nouvelle planification » : des feuilles,
//    ouvertes par le bouton « + » de l'écran (`drafts.projectSheetShown`, …) — jamais
//    un formulaire en tête d'écran. Elles sont posées par `consolePalette`, à la racine.

import ConsoleClient
import ConsoleCore
import SwiftUI

// MARK: - Projets

public struct ProjectsListSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.drafts = drafts
    }

    public var body: some View {
        Section {
            if server.projects.isEmpty {
                Text(PipelineServerText.noProject)
                    .foregroundStyle(.secondary)
            }
            ForEach(server.projects) { project in
                Button {
                    server.history.projectId = project.id
                    drafts.runsScope = .features
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: project.isDone ? "checkmark.circle.fill" : "circle.dashed")
                            .foregroundStyle(project.isDone ? Color.green : Color.secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(project.title)
                                .foregroundStyle(.primary)
                            Text(project.repo + " · " + PipelineServerText.projectLine(total: project.runs.total, merged: project.runs.count(.merged)))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        ProgressView(value: Double(project.runs.count(.merged)), total: Double(max(project.runs.total, 1)))
                            .frame(width: 64)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .consoleID("projects.row")
            }
        } header: {
            Text(PipelineServerText.projectsTitle)
        } footer: {
            Text(PipelineServerText.launchProjectHint)
        }
    }
}

// MARK: - Audits

public struct AuditsListSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.drafts = drafts
    }

    public var body: some View {
        if server.audits.isEmpty {
            Section {
                Text(PipelineServerText.noAudit)
                    .foregroundStyle(.secondary)
            } footer: {
                Text(PipelineServerText.launchAuditHint)
            }
        }
        // Les audits à trier d'abord, puis ceux qui analysent, puis les clos.
        ForEach(server.audits.sorted { rank($0) < rank($1) }) { audit in
            Section {
                auditView(audit)
            } header: {
                HStack {
                    Text(audit.focus.isEmpty ? PipelineServerText.wholeRepo : audit.focus)
                    Spacer()
                    Text(audit.repo)
                }
            }
        }
    }

    private func rank(_ audit: HarnessAudit) -> Int {
        audit.isProposed ? 0 : (audit.isOpen ? 1 : 2)
    }

    @ViewBuilder
    private func auditView(_ audit: HarnessAudit) -> some View {
        Text(PipelineServerText.auditState(audit.state))
            .font(.caption.weight(.semibold))
            .foregroundStyle(audit.isProposed ? Color.orange : Color.secondary)
        if let reason = audit.reason, !reason.isEmpty {
            Text(reason)
                .font(.caption)
                .foregroundStyle(.secondary)
                .consoleReadable()
        }
        ForEach(Array(audit.proposals.enumerated()), id: \.offset) { index, proposal in
            if audit.isProposed {
                Toggle(isOn: Binding(get: { drafts.isPicked(audit, index) }, set: { _ in drafts.togglePick(audit, index) })) {
                    proposalLabel(proposal)
                }
                #if os(macOS)
                .toggleStyle(.checkbox)
                #endif
            } else {
                proposalLabel(proposal)
            }
        }
        if audit.canFollowSession || audit.isOpen {
            ViewThatFits(in: .horizontal) {
                HStack { buttons(audit) }
                VStack(alignment: .leading, spacing: 8) { buttons(audit) }
            }
            .disabled(server.busyAudits.contains(audit.id))
        }
    }

    @ViewBuilder
    private func buttons(_ audit: HarnessAudit) -> some View {
        if audit.isProposed {
            Button(PipelineServerText.launchProposals) {
                let items = Array(drafts.picks[audit.id] ?? [])
                let title = PipelineServerText.auditProjectTitle(audit.focus)
                Task {
                    if await server.launchProposals(auditId: audit.id, items: items, title: title) != nil { drafts.picks[audit.id] = nil }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled((drafts.picks[audit.id] ?? []).isEmpty || !server.canAct)
        }
        if audit.canFollowSession {
            Button(MonitoringText.auditSessionTitle, systemImage: PipelineServerText.sessionSymbol) {
                drafts.sessionRequest = HarnessSessionRequest(target: .audit(audit.id), title: audit.focus.isEmpty ? PipelineServerText.wholeRepo : audit.focus)
            }
            .buttonStyle(.bordered)
            .consoleID("audit.session.open")
        }
        if audit.isOpen {
            Button(PipelineServerText.cancelAudit, role: .destructive) {
                Task { await server.cancelAudit(audit.id) }
            }
            .buttonStyle(.bordered)
            .disabled(!server.canAct)
        }
    }

    private func proposalLabel(_ proposal: HarnessAuditProposal) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(proposal.title)
            Text((proposal.isWeakness ? PipelineServerText.weakness : PipelineServerText.feature) + " · " + proposal.rationale)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Feuilles de création

/// « Nouveau projet » : un dépôt, un nom, et ses features une à une.
struct NewProjectSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        NavigationStack {
            Form {
                if let failure = server.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                Section {
                    RepoPicker(server: server, drafts: drafts)
                    TextField(PipelineServerText.projectTitleLabel, text: $drafts.projectTitle)
                        .consoleID("project.launch.title")
                } footer: {
                    Text(PipelineServerText.launchProjectHint)
                }
                ForEach(Array($drafts.features.enumerated()), id: \.element.id) { index, $feature in
                    Section {
                        TextField(PipelineServerText.titleLabel, text: $feature.title)
                        TextField(PipelineServerText.requestLabel, text: $feature.request, axis: .vertical)
                            .lineLimit(2...6)
                        TextField(PipelineServerText.modulesLabel, text: $feature.modules)
                        if drafts.features.count > 1 {
                            Button(PipelineServerText.removeFeature, role: .destructive) { drafts.removeFeature(feature.id) }
                        }
                    } header: {
                        Text(PipelineServerText.questionIndex(index + 1, of: drafts.features.count))
                    }
                }
                Section {
                    Button(PipelineServerText.addFeature, systemImage: "plus") { drafts.addFeature() }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.launchProjectTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.projectSheetShown = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.launch) {
                        guard let repo = drafts.launchRepo(in: server.repos) else { return }
                        let title = drafts.projectTitle
                        let features = drafts.features
                        Task {
                            if await server.launchProject(repo: repo, title: title, features: features) != nil {
                                drafts.clearProject()
                                drafts.projectSheetShown = false
                            }
                        }
                    }
                    .disabled(!drafts.canLaunchProject || server.isLaunching || server.repos.isEmpty)
                    .consoleID("project.launch.commit")
                }
            }
        }
        .consoleSheetSize(minWidth: 540, minHeight: 560)
        .task { await server.refreshCatalog() }
    }
}

/// « Nouvel audit » : un dépôt et un périmètre (vide : le dépôt entier).
struct NewAuditSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        NavigationStack {
            Form {
                if let failure = server.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                Section {
                    RepoPicker(server: server, drafts: drafts)
                    TextField(PipelineServerText.focusLabel, text: $drafts.auditFocus, prompt: Text(PipelineServerText.focusPrompt))
                        .consoleID("audit.launch.focus")
                } footer: {
                    Text(PipelineServerText.launchAuditHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.launchAuditTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.auditSheetShown = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.launch) {
                        guard let repo = drafts.launchRepo(in: server.repos) else { return }
                        let focus = drafts.auditFocus
                        Task {
                            if await server.launchAudit(repo: repo, focus: focus) != nil {
                                drafts.auditFocus = ""
                                drafts.auditSheetShown = false
                                drafts.runsScope = .audits
                            }
                        }
                    }
                    .disabled(server.isLaunching || server.repos.isEmpty)
                    .consoleID("audit.launch.commit")
                }
            }
        }
        .consoleSheetSize(minWidth: 480, minHeight: 300)
        .task { await server.refreshCatalog() }
    }
}

/// « + » d'une portée de Features : la création qui lui va, ou le menu des trois.
public struct NewWorkMenu: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.drafts = drafts
    }

    public var body: some View {
        Menu {
            Button(PipelineServerText.newFeature, systemImage: PipelineServerText.newFeatureSymbol) { drafts.launchSheetShown = true }
            Button(ShellText.newProject, systemImage: RunsScope.projects.systemImage) { drafts.projectSheetShown = true }
            Button(ShellText.newAudit, systemImage: RunsScope.audits.systemImage) { drafts.auditSheetShown = true }
        } label: {
            Label(ShellText.newMenu, systemImage: PipelineServerText.newFeatureSymbol)
        } primaryAction: {
            switch drafts.runsScope {
            case .projects: drafts.projectSheetShown = true
            case .audits: drafts.auditSheetShown = true
            case .features, .issues: drafts.launchSheetShown = true
            }
        }
        .disabled(!server.canAct)
        .consoleID("runs.new")
    }
}
