// Les sections de pilotage de la coque, toutes servies par le serveur de pipelines
// du VPS (omp-harness) — le seul moteur : Accueil (résumé et boîte de l'humain),
// Pipelines (features : lancer, suivre, arrêter), Projet (projets : lancer, suivre),
// Audit (audits : lancer, trier les propositions) et Statistiques. Le Poste (poste
// de travail) passe par le même cadre, dans `WorkstationViews.swift`.
//
// Un seul `HarnessModel` et un seul `HarnessDrafts` pour toute la fenêtre (posés par
// `OMPConsoleApp`) : le flux d'événements tient chaque section à jour. Sans
// serveur relié, chaque section montre le même appel à le relier. Le titre de la
// fenêtre est posé par la racine (la section courante), jamais ici.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Le cadre commun : relier le serveur s'il ne l'est pas, sinon le contenu, avec
/// l'échec du dernier échange en tête et l'actualisation en barre d'outils.
/// `reload` relit en plus ce qui n'est pas dans la boîte (le poste de travail).
struct HarnessSection<Content: View>: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let catalog: Bool
    let reload: (@MainActor () async -> Void)?
    @ViewBuilder let content: () -> Content

    init(
        server: HarnessModel,
        drafts: HarnessDrafts,
        catalog: Bool,
        reload: (@MainActor () async -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.server = server
        self.drafts = drafts
        self.catalog = catalog
        self.reload = reload
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
                // boîte (`homeAnchor`) : le formulaire y défile, puis oublie la demande.
                ScrollViewReader { proxy in
                    Form {
                        if let failure = server.failure {
                            Section {
                                HarnessFailureLabel(failure: failure)
                            }
                        }
                        content()
                    }
                    .formStyle(.grouped)
                    .onChange(of: drafts.homeAnchor) { _, anchor in
                        guard let anchor else { return }
                        withAnimation { proxy.scrollTo(anchor.rawValue, anchor: .top) }
                        drafts.homeAnchor = nil
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task {
                        await server.refresh()
                        if catalog { await server.refreshCatalog() }
                        await reload?()
                    }
                } label: {
                    Label(PipelineServerText.refresh, systemImage: "arrow.clockwise")
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(!server.isConfigured || server.isLoading)
                .accessibilityIdentifier("server.refresh")
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    drafts.serverSheetShown = true
                } label: {
                    Label(PipelineServerText.open, systemImage: "server.rack")
                }
                .accessibilityIdentifier("server.open")
            }
        }
        .task {
            if catalog { await server.refreshCatalog() }
        }
        .harnessGestures(server: server, drafts: drafts)
        .workstationGestures(workstation: server.workstation, drafts: drafts)
    }

    private var notConfigured: some View {
        VStack(spacing: 16) {
            Image(systemName: "server.rack")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(PipelineServerText.notConfigured)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 420)
            Button(PipelineServerText.configure) { drafts.serverSheetShown = true }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("server.configure")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Le choix du dépôt des lancements, parmi ceux que le serveur déclare.
struct HarnessRepoPicker: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        if server.repos.isEmpty {
            Text(PipelineServerText.noRepo)
                .foregroundStyle(.secondary)
        } else {
            Picker(PipelineServerText.repoLabel, selection: repoBinding) {
                ForEach(server.repos) { repo in
                    Text(repo.name).tag(repo.name)
                }
            }
        }
    }

    private var repoBinding: Binding<String> {
        Binding(get: { drafts.launchRepo(in: server.repos) ?? "" }, set: { drafts.repo = $0 })
    }
}

// MARK: - Accueil

/// L'Accueil : les envois du poste de travail qui attendent l'approbation d'abord
/// (ils expirent), puis le tableau de bord (KPIs et graphiques, pour comprendre d'un
/// coup d'œil ce qui se passe sur tous les projets), les alertes et la boîte.
struct HarnessHomeView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true, reload: { await server.workstation.refresh() }) {
            let inbox = server.inbox ?? HarnessInbox()
            WorkstationHomeApprovals(workstation: server.workstation, drafts: drafts)
            HarnessDashboardSections(server: server, drafts: drafts, dashboard: HarnessDashboard(inbox: inbox, stats: server.stats))
            HarnessAlertsSection(drafts: drafts, inbox: inbox)
            HarnessInboxSections(server: server, drafts: drafts, inbox: inbox)
        }
        .accessibilityIdentifier("home.harness")
    }
}

// MARK: - Pipelines

struct HarnessPipelinesView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true) {
            Section {
                HarnessRepoPicker(server: server, drafts: drafts)
                TextField(PipelineServerText.titleLabel, text: $drafts.runTitle)
                    .accessibilityIdentifier("pipelines.launch.title")
                TextField(PipelineServerText.requestLabel, text: $drafts.runRequest, axis: .vertical)
                    .lineLimit(3...10)
                    .accessibilityIdentifier("pipelines.launch.request")
                Button(PipelineServerText.launch) {
                    guard let repo = drafts.launchRepo(in: server.repos) else { return }
                    let title = drafts.runTitle
                    let request = drafts.runRequest
                    Task {
                        if await server.launchRun(repo: repo, title: title, request: request) != nil { drafts.clearRun() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!drafts.canLaunchRun || server.isLaunching || server.repos.isEmpty)
                .accessibilityIdentifier("pipelines.launch.commit")
            } header: {
                Text(PipelineServerText.launchRunTitle)
            } footer: {
                Text(PipelineServerText.launchRunHint)
            }

            let runs = server.inbox?.runs ?? []
            Section {
                if runs.isEmpty {
                    Text(PipelineServerText.noRun)
                        .foregroundStyle(.secondary)
                }
                ForEach(runs) { run in
                    HarnessRunRow(server: server, drafts: drafts, run: run)
                }
            } header: {
                Text(PipelineServerText.allRuns)
            }
        }
        .accessibilityIdentifier("pipelines.harness")
    }
}

// MARK: - Projet

struct HarnessProjectsView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true) {
            Section {
                HarnessRepoPicker(server: server, drafts: drafts)
                TextField(PipelineServerText.projectTitleLabel, text: $drafts.projectTitle)
                    .accessibilityIdentifier("project.launch.title")
                ForEach($drafts.features) { $feature in
                    VStack(alignment: .leading, spacing: 6) {
                        TextField(PipelineServerText.titleLabel, text: $feature.title)
                        TextField(PipelineServerText.requestLabel, text: $feature.request, axis: .vertical)
                            .lineLimit(2...6)
                        TextField(PipelineServerText.modulesLabel, text: $feature.modules)
                        if drafts.features.count > 1 {
                            Button(PipelineServerText.removeFeature, role: .destructive) { drafts.removeFeature(feature.id) }
                                .buttonStyle(.borderless)
                        }
                    }
                    .padding(.vertical, 4)
                }
                HStack {
                    Button(PipelineServerText.addFeature) { drafts.addFeature() }
                        .buttonStyle(.bordered)
                    Spacer()
                    Button(PipelineServerText.launch) {
                        guard let repo = drafts.launchRepo(in: server.repos) else { return }
                        let title = drafts.projectTitle
                        let features = drafts.features
                        Task {
                            if await server.launchProject(repo: repo, title: title, features: features) != nil { drafts.clearProject() }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!drafts.canLaunchProject || server.isLaunching || server.repos.isEmpty)
                    .accessibilityIdentifier("project.launch.commit")
                }
            } header: {
                Text(PipelineServerText.launchProjectTitle)
            } footer: {
                Text(PipelineServerText.launchProjectHint)
            }

            Section {
                if server.projects.isEmpty {
                    Text(PipelineServerText.noProject)
                        .foregroundStyle(.secondary)
                }
                ForEach(server.projects) { project in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(project.title)
                            Text(PipelineServerText.projectLine(total: project.runs.total, merged: project.runs.count(.merged)))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(project.isDone ? PipelineServerText.projectDone : PipelineServerText.projectActive)
                            .font(.caption)
                            .foregroundStyle(project.isDone ? Color.green : Color.secondary)
                    }
                }
            } header: {
                Text(PipelineServerText.projectsTitle)
            }
        }
        .accessibilityIdentifier("project.harness")
    }
}

// MARK: - Audit

struct HarnessAuditsView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true) {
            Section {
                HarnessRepoPicker(server: server, drafts: drafts)
                TextField(PipelineServerText.focusLabel, text: $drafts.auditFocus, prompt: Text(PipelineServerText.focusPrompt))
                    .accessibilityIdentifier("audit.launch.focus")
                Button(PipelineServerText.launch) {
                    guard let repo = drafts.launchRepo(in: server.repos) else { return }
                    let focus = drafts.auditFocus
                    Task {
                        if await server.launchAudit(repo: repo, focus: focus) != nil { drafts.auditFocus = "" }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(server.isLaunching || server.repos.isEmpty)
                .accessibilityIdentifier("audit.launch.commit")
            } header: {
                Text(PipelineServerText.launchAuditTitle)
            } footer: {
                Text(PipelineServerText.launchAuditHint)
            }

            if server.audits.isEmpty {
                Section {
                    Text(PipelineServerText.noAudit)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(server.audits) { audit in
                Section {
                    auditView(audit)
                } header: {
                    Text(audit.focus.isEmpty ? PipelineServerText.wholeRepo : audit.focus)
                }
            }
        }
        .accessibilityIdentifier("audit.harness")
    }

    @ViewBuilder
    private func auditView(_ audit: HarnessAudit) -> some View {
        HStack {
            Text(PipelineServerText.auditState(audit.state))
                .font(.caption.weight(.semibold))
                .foregroundStyle(audit.isProposed ? Color.orange : Color.secondary)
            Spacer()
            Text(audit.repo)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if let reason = audit.reason, !reason.isEmpty {
            Text(reason)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        ForEach(Array(audit.proposals.enumerated()), id: \.offset) { index, proposal in
            if audit.isProposed {
                Toggle(isOn: pickBinding(audit, index)) {
                    proposalLabel(proposal)
                }
                .toggleStyle(.checkbox)
            } else {
                proposalLabel(proposal)
            }
        }
        if audit.canFollowSession {
            Button {
                drafts.sessionRequest = HarnessSessionRequest(target: .audit(audit.id), title: audit.focus.isEmpty ? PipelineServerText.wholeRepo : audit.focus)
            } label: {
                Label(MonitoringText.auditSessionTitle, systemImage: PipelineServerText.sessionSymbol)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("audit.session.open")
        }
        if audit.isOpen {
            HStack {
                if audit.isProposed {
                    Button(PipelineServerText.launchProposals) {
                        let items = Array(drafts.picks[audit.id] ?? [])
                        let title = PipelineServerText.auditProjectTitle(audit.focus)
                        Task {
                            if await server.launchProposals(auditId: audit.id, items: items, title: title) != nil { drafts.picks[audit.id] = nil }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled((drafts.picks[audit.id] ?? []).isEmpty)
                }
                Spacer()
                Button(PipelineServerText.cancelAudit, role: .destructive) {
                    Task { await server.cancelAudit(audit.id) }
                }
                .buttonStyle(.bordered)
            }
            .disabled(server.busyAudits.contains(audit.id))
        }
    }

    private func proposalLabel(_ proposal: HarnessAuditProposal) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(proposal.title)
            Text("\(proposal.isWeakness ? PipelineServerText.weakness : PipelineServerText.feature) · \(proposal.rationale)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func pickBinding(_ audit: HarnessAudit, _ index: Int) -> Binding<Bool> {
        Binding(get: { drafts.isPicked(audit, index) }, set: { _ in drafts.togglePick(audit, index) })
    }
}

// MARK: - Statistiques

struct HarnessStatsView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true) {
            if let stats = server.stats {
                Section {
                    row(PipelineServerText.total, "\(stats.runs.total)")
                    ForEach(HarnessRunState.allCases, id: \.self) { state in
                        if let count = stats.runs.byState[state.rawValue], count > 0 {
                            row(PipelineServerText.state(state.rawValue), "\(count)")
                        }
                    }
                    row(PipelineServerText.mergedWeek, "\(stats.runs.mergedLast7Days)")
                    row(PipelineServerText.mergeRate, stats.runs.mergeRate.map(PipelineServerText.percent) ?? PipelineServerText.notAvailable)
                    row(PipelineServerText.leadTime, stats.runs.medianLeadSec.map(PipelineServerText.duration) ?? PipelineServerText.notAvailable)
                    row(PipelineServerText.fixesPerMerge, stats.runs.fixesPerMerged.map { String(format: "%.1f", $0) } ?? PipelineServerText.notAvailable)
                } header: {
                    Text(PipelineServerText.statsRuns)
                }
                Section {
                    ForEach(HarnessRun.stepKinds, id: \.self) { kind in
                        if let step = stats.steps[kind] {
                            Text(PipelineServerText.stepLine(label: HarnessRun.label(forStep: kind), count: step.count, failed: step.failed, median: step.medianSec))
                        }
                    }
                } header: {
                    Text(PipelineServerText.statsSteps)
                }
                Section {
                    row(PipelineServerText.total, "\(stats.tests.total)")
                    row(PipelineServerText.testsCached, "\(stats.tests.cached)")
                    row(PipelineServerText.testsRetried, "\(stats.tests.retried)")
                } header: {
                    Text(PipelineServerText.statsTests)
                }
                if let usage = stats.usage {
                    HarnessUsageSection(usage: usage)
                }
                if let models = stats.models {
                    HarnessModelsSection(models: models)
                }
                if let flaky = stats.tests.flaky {
                    HarnessFlakySection(flaky: flaky)
                }
                HarnessHealthSection(server: server)
                Section {
                    row(PipelineServerText.runners, PipelineServerText.slots(used: stats.scheduler.runner.used, capacity: stats.scheduler.runner.capacity))
                    row(PipelineServerText.heavySlots, PipelineServerText.slots(used: stats.scheduler.heavy.used, capacity: stats.scheduler.heavy.capacity))
                    row(PipelineServerText.memoryFree, stats.scheduler.memAvailableMiB.map(PipelineServerText.mebibytes) ?? PipelineServerText.notAvailable)
                } header: {
                    Text(PipelineServerText.statsCapacity)
                }
            } else {
                Section {
                    Text(PipelineServerText.noStats)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityIdentifier("stats.harness")
    }

    private func row(_ label: String, _ value: String) -> some View {
        LabeledContent(label, value: value)
    }
}
