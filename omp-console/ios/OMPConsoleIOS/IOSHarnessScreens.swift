import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// Les écrans de pilotage de l'app iOS, tous servis par le serveur de pipelines du
// VPS (omp-harness), joint directement : Accueil (résumé et boîte de l'humain),
// Pipelines (lancer une feature avec ses options, historique filtrable), Projet, Audit et Statistiques. Le
// Poste (poste de travail) passe par le même cadre, dans `IOSWorkstationScreen.swift`.
//
// Un seul `HarnessModel` et un seul `HarnessDrafts` pour l'app (posés par
// `OMPConsoleIOSApp`) : le flux d'événements tient chaque écran à jour. Les mots
// viennent du noyau (`PipelineServerText`), les symboles de `IOSShellText` : aucun
// libellé en dur ici (`design-ios/AC-5`).

/// Le cadre commun : relier le serveur s'il ne l'est pas, sinon la liste groupée,
/// avec l'échec du dernier échange en tête, le tirer-pour-actualiser et le bouton
/// du serveur en barre. `reloadAlso` relit en plus ce qui n'est pas dans la boîte
/// (le poste de travail).
struct IOSHarnessScreen<Content: View>: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let section: ConsoleSection
    let catalog: Bool
    let reloadAlso: (@MainActor () async -> Void)?
    @ViewBuilder let content: () -> Content

    init(
        server: HarnessModel,
        drafts: HarnessDrafts,
        section: ConsoleSection,
        catalog: Bool,
        reloadAlso: (@MainActor () async -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.server = server
        self.drafts = drafts
        self.section = section
        self.catalog = catalog
        self.reloadAlso = reloadAlso
        self.content = content
    }

    var body: some View {
        Group {
            if !server.isLoaded {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !server.isConfigured {
                notConfigured
            } else {
                // Une tuile du tableau de bord de l'Accueil demande une section de la
                // boîte (`homeAnchor`) : la liste y défile, puis oublie la demande.
                ScrollViewReader { proxy in
                    List {
                        if let failure = server.failure {
                            Text(failure.message)
                                .font(.callout)
                                .iosBanner(tone: .attention)
                                .iosBareListRow()
                        }
                        content()
                    }
                    .iosGroupedList()
                    .refreshable { await reload() }
                    .onChange(of: drafts.homeAnchor) { _, anchor in
                        guard let anchor else { return }
                        withAnimation(IOSMotion.scrollAnimation(reduceMotion: reduceMotion)) {
                            proxy.scrollTo(anchor.rawValue, anchor: .top)
                        }
                        drafts.homeAnchor = nil
                    }
                }
            }
        }
        .navigationTitle(section.title)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    drafts.serverSheetShown = true
                } label: {
                    Label(PipelineServerText.open, systemImage: IOSShellText.serverSymbol)
                }
                .accessibilityIdentifier("ios.server.open")
            }
        }
        .task {
            if catalog { await server.refreshCatalog() }
        }
        .harnessGestures(server: server, drafts: drafts)
        .workstationGestures(workstation: server.workstation, drafts: drafts)
        // ⌘R relit l'écran comme le geste « tirer pour actualiser ».
        .focusedSceneValue(\.iosRefresh, IOSCommandAction(owner: section, isEnabled: server.isConfigured) {
            Task { await reload() }
        })
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.screen." + section.rawValue)
    }

    private func reload() async {
        await server.refresh()
        if catalog { await server.refreshCatalog() }
        await reloadAlso?()
    }

    private var notConfigured: some View {
        VStack(spacing: 16) {
            Image(systemName: IOSShellText.serverSymbol)
                .font(.largeTitle)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(PipelineServerText.notConfigured)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button(PipelineServerText.configure) { drafts.serverSheetShown = true }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("ios.server.configure")
        }
        .padding()
        .iosReadableWidth()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Accueil

/// L'Accueil : les envois du poste de travail qui attendent l'approbation d'abord
/// (ils expirent, et le Poste est rangé sous « Plus » sur iPhone), puis le tableau
/// de bord (KPIs et graphiques), les alertes et la boîte.
struct IOSHarnessHomeScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .home, catalog: true, reloadAlso: {
            await server.workstation.refresh()
            await server.vigie.refresh()
        }) {
            let inbox = server.inbox ?? HarnessInbox()
            VigieSilentBanner(vigie: server.vigie)
            DigestSection(server: server)
            WorkstationHomeApprovals(workstation: server.workstation, drafts: drafts)
            IOSDashboardSections(server: server, drafts: drafts, dashboard: HarnessDashboard(inbox: inbox, stats: server.stats))
            QueueSummarySection(server: server)
            ServicesSummarySection(server: server)
            IOSAlertsSection(drafts: drafts, inbox: inbox)
            InboxSections(server: server, drafts: drafts, inbox: inbox)
        }
    }
}

// MARK: - Exploitation

/// La vigie : mode, plafonds, battement de cœur et incidents (contenu partagé, ConsoleUI).
struct IOSVigieScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .vigie, catalog: true, reloadAlso: { await server.vigie.load() }) {
            VigieSections(server: server, drafts: drafts)
        }
        .task { await server.vigie.load() }
    }
}

/// Les planifications récurrentes (contenu partagé, ConsoleUI).
struct IOSSchedulesScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .schedules, catalog: true, reloadAlso: { await server.schedules.refresh() }) {
            SchedulesSections(server: server, drafts: drafts)
        }
        .task { await server.schedules.refresh() }
        .controlGestures(server: server, drafts: drafts)
    }
}

/// Les issues des dépôts et leur correction (contenu partagé, ConsoleUI).
struct IOSIssuesScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .issues, catalog: true, reloadAlso: {
            await server.issues.refresh(repo: drafts.issuesRepo(in: server.repos))
        }) {
            IssuesSections(server: server, drafts: drafts)
        }
    }
}

/// L'administration du serveur, admin seulement (contenu partagé, ConsoleUI).
struct IOSAdminScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .admin, catalog: true, reloadAlso: { await server.admin.refresh() }) {
            AdminSections(server: server, drafts: drafts)
        }
        .task(id: server.isAdmin) { await server.admin.refresh() }
        .controlGestures(server: server, drafts: drafts)
    }
}

// MARK: - Pipelines

struct IOSHarnessPipelinesScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .kanban, catalog: true, reloadAlso: { await server.history.refresh() }) {
            LaunchFeatureSections(server: server, drafts: drafts)
            RunsHistorySections(server: server, drafts: drafts, history: server.history)
        }
    }
}

// MARK: - Projet

struct IOSHarnessProjectsScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .project, catalog: true) {
            Section {
                RepoPicker(server: server, drafts: drafts)
                TextField(PipelineServerText.projectTitleLabel, text: $drafts.projectTitle)
                    .accessibilityIdentifier("ios.project.launch.title")
            } header: {
                Text(PipelineServerText.launchProjectTitle)
            } footer: {
                Text(PipelineServerText.launchProjectHint)
            }
            ForEach($drafts.features) { $feature in
                Section {
                    TextField(PipelineServerText.titleLabel, text: $feature.title)
                    TextField(PipelineServerText.requestLabel, text: $feature.request, axis: .vertical)
                    TextField(PipelineServerText.modulesLabel, text: $feature.modules)
                    if drafts.features.count > 1 {
                        Button(PipelineServerText.removeFeature, role: .destructive) { drafts.removeFeature(feature.id) }
                    }
                }
            }
            Section {
                Button {
                    drafts.addFeature()
                } label: {
                    Label(PipelineServerText.addFeature, systemImage: IOSShellText.addSymbol)
                }
                Button(PipelineServerText.launch) {
                    guard let repo = drafts.launchRepo(in: server.repos) else { return }
                    let title = drafts.projectTitle
                    let features = drafts.features
                    Task {
                        if await server.launchProject(repo: repo, title: title, features: features) != nil { drafts.clearProject() }
                    }
                }
                .disabled(!drafts.canLaunchProject || server.isLaunching || server.repos.isEmpty)
                .accessibilityIdentifier("ios.project.launch.commit")
            }
            Section {
                if server.projects.isEmpty {
                    Text(PipelineServerText.noProject).foregroundStyle(.secondary)
                }
                ForEach(server.projects) { project in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(project.title)
                        Text(PipelineServerText.projectLine(total: project.runs.total, merged: project.runs.count(.merged)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(project.isDone ? PipelineServerText.projectDone : PipelineServerText.projectActive)
                            .font(.caption)
                            .foregroundStyle(project.isDone ? Color.green : Color.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text(PipelineServerText.projectsTitle)
            }
        }
    }
}

// MARK: - Audit

struct IOSHarnessAuditsScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .audit, catalog: true) {
            Section {
                RepoPicker(server: server, drafts: drafts)
                TextField(PipelineServerText.focusLabel, text: $drafts.auditFocus, prompt: Text(PipelineServerText.focusPrompt))
                    .accessibilityIdentifier("ios.audit.launch.focus")
                Button(PipelineServerText.launch) {
                    guard let repo = drafts.launchRepo(in: server.repos) else { return }
                    let focus = drafts.auditFocus
                    Task {
                        if await server.launchAudit(repo: repo, focus: focus) != nil { drafts.auditFocus = "" }
                    }
                }
                .disabled(server.isLaunching || server.repos.isEmpty)
                .accessibilityIdentifier("ios.audit.launch.commit")
            } header: {
                Text(PipelineServerText.launchAuditTitle)
            } footer: {
                Text(PipelineServerText.launchAuditHint)
            }
            if server.audits.isEmpty {
                Section {
                    Text(PipelineServerText.noAudit).foregroundStyle(.secondary)
                }
            }
            ForEach(server.audits) { audit in
                Section {
                    auditRows(audit)
                } header: {
                    Text(audit.focus.isEmpty ? PipelineServerText.wholeRepo : audit.focus)
                }
            }
        }
    }

    @ViewBuilder
    private func auditRows(_ audit: HarnessAudit) -> some View {
        Text(PipelineServerText.auditState(audit.state))
            .font(.caption.weight(.semibold))
            .foregroundStyle(audit.isProposed ? Color.orange : Color.secondary)
        if let reason = audit.reason, !reason.isEmpty {
            Text(reason)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        ForEach(Array(audit.proposals.enumerated()), id: \.offset) { index, proposal in
            if audit.isProposed {
                Button {
                    drafts.togglePick(audit, index)
                } label: {
                    Label {
                        proposalLabel(proposal)
                    } icon: {
                        Image(systemName: drafts.isPicked(audit, index) ? IOSShellText.pickedSymbol : IOSShellText.unpickedSymbol)
                    }
                }
                .buttonStyle(.borderless)
                .accessibilityAddTraits(drafts.isPicked(audit, index) ? .isSelected : [])
            } else {
                proposalLabel(proposal)
            }
        }
        if audit.isProposed {
            Button(PipelineServerText.launchProposals) {
                let items = Array(drafts.picks[audit.id] ?? [])
                let title = PipelineServerText.auditProjectTitle(audit.focus)
                Task {
                    if await server.launchProposals(auditId: audit.id, items: items, title: title) != nil { drafts.picks[audit.id] = nil }
                }
            }
            .disabled((drafts.picks[audit.id] ?? []).isEmpty || server.busyAudits.contains(audit.id))
        }
        if audit.canFollowSession {
            Button(MonitoringText.auditSessionTitle, systemImage: PipelineServerText.sessionSymbol) {
                drafts.sessionRequest = HarnessSessionRequest(target: .audit(audit.id), title: audit.focus.isEmpty ? PipelineServerText.wholeRepo : audit.focus)
            }
            .accessibilityIdentifier("ios.audit.session")
        }
        if audit.isOpen {
            Button(PipelineServerText.cancelAudit, role: .destructive) {
                Task { await server.cancelAudit(audit.id) }
            }
            .disabled(server.busyAudits.contains(audit.id))
        }
    }

    private func proposalLabel(_ proposal: HarnessAuditProposal) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(proposal.title)
            Text(IOSShellText.proposalDetail(
                kind: proposal.isWeakness ? PipelineServerText.weakness : PipelineServerText.feature,
                rationale: proposal.rationale
            ))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Statistiques

struct IOSHarnessStatsScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .stats, catalog: true) {
            if let stats = server.stats {
                Section {
                    LabeledContent(PipelineServerText.total, value: String(stats.runs.total))
                    ForEach(HarnessRunState.allCases, id: \.self) { state in
                        if let count = stats.runs.byState[state.rawValue], count > 0 {
                            LabeledContent(PipelineServerText.state(state.rawValue), value: String(count))
                        }
                    }
                    LabeledContent(PipelineServerText.mergedWeek, value: String(stats.runs.mergedLast7Days))
                    LabeledContent(PipelineServerText.mergeRate, value: stats.runs.mergeRate.map(PipelineServerText.percent) ?? PipelineServerText.notAvailable)
                    LabeledContent(PipelineServerText.leadTime) {
                        Text(stats.runs.medianLeadSec.map(PipelineServerText.duration) ?? PipelineServerText.notAvailable)
                            .monospacedDigit()
                    }
                } header: {
                    Text(PipelineServerText.statsRuns)
                }
                Section {
                    ForEach(HarnessRun.stepKinds, id: \.self) { kind in
                        if let step = stats.steps[kind] {
                            Text(PipelineServerText.stepLine(label: HarnessRun.label(forStep: kind), count: step.count, failed: step.failed, median: step.medianSec))
                                .monospacedDigit()
                        }
                    }
                } header: {
                    Text(PipelineServerText.statsSteps)
                }
                Section {
                    LabeledContent(PipelineServerText.total, value: String(stats.tests.total))
                    LabeledContent(PipelineServerText.testsCached, value: String(stats.tests.cached))
                    LabeledContent(PipelineServerText.testsRetried, value: String(stats.tests.retried))
                } header: {
                    Text(PipelineServerText.statsTests)
                }
                if let usage = stats.usage {
                    IOSUsageSection(usage: usage)
                }
                if let models = stats.models {
                    IOSModelsSection(models: models)
                }
                if let flaky = stats.tests.flaky {
                    IOSFlakySection(flaky: flaky)
                }
                ServicesSection(server: server)
                IOSHealthSection(server: server)
                Section {
                    LabeledContent(PipelineServerText.runners, value: PipelineServerText.slots(used: stats.scheduler.runner.used, capacity: stats.scheduler.runner.capacity))
                    LabeledContent(PipelineServerText.heavySlots, value: PipelineServerText.slots(used: stats.scheduler.heavy.used, capacity: stats.scheduler.heavy.capacity))
                    LabeledContent(PipelineServerText.memoryFree, value: stats.scheduler.memAvailableMiB.map(PipelineServerText.mebibytes) ?? PipelineServerText.notAvailable)
                } header: {
                    Text(PipelineServerText.statsCapacity)
                }
            } else {
                Section {
                    Text(PipelineServerText.noStats).foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - Gestes
