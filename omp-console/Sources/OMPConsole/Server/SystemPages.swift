// SYSTÈME sur le Mac : le hub (une rangée par page, son état à droite) et les pages
// qu'il pousse dans sa pile — Vigie, Planifications, Statistiques et santé,
// Administration. Le Serveur ouvre la feuille de connexion. Le contenu est PARTAGÉ avec
// l'app iOS (cible ConsoleUI) ; ce fichier n'en garde que le cadre du Mac.
//
// La pile suit `drafts.systemPage` : la palette ou une notification (vigie muette)
// pousse la page demandée ; revenir au hub l'oublie.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct HarnessSystemView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true, form: false, reload: {
            await server.vigie.load()
            await server.schedules.refresh()
            if server.autonomy.isWatched { await server.autonomy.refresh() }
            if server.isAdmin { await server.admin.refresh() }
        }) {
            NavigationStack(path: path) {
                HarnessForm(server: server, drafts: drafts) {
                    SystemHubSections(server: server, drafts: drafts)
                }
                .navigationDestination(for: SystemPage.self) { page in
                    destination(page)
                        .navigationTitle(page.title)
                }
            }
        }
        .task {
            await server.vigie.load()
            await server.schedules.refresh()
        }
        .controlGestures(server: server, drafts: drafts)
        .accessibilityIdentifier("system.harness")
    }

    /// La pile : la page demandée, sans le Serveur (une feuille, jamais une page).
    private var path: Binding<[SystemPage]> {
        Binding(
            get: { drafts.systemPage.flatMap { $0 == .server ? nil : [$0] } ?? [] },
            set: { drafts.systemPage = $0.last }
        )
    }

    @ViewBuilder
    private func destination(_ page: SystemPage) -> some View {
        switch page {
        case .vigie:
            HarnessForm(server: server, drafts: drafts) { VigieSections(server: server, drafts: drafts) }
                .accessibilityIdentifier("vigie.harness")
        case .schedules:
            SystemSchedulesPage(server: server, drafts: drafts)
        case .autonomy:
            HarnessForm(server: server, drafts: drafts) { AutonomySections(server: server) }
                .task { await server.autonomy.refresh() }
                .accessibilityIdentifier("autonomy.harness")
        case .stats:
            SystemStatsPage(server: server, drafts: drafts)
        case .admin:
            HarnessForm(server: server, drafts: drafts) { AdminSections(server: server, drafts: drafts) }
                .task(id: server.isAdmin) { await server.admin.refresh() }
                .accessibilityIdentifier("admin.harness")
        case .server:
            // Jamais poussée (`path` l'écarte) : le Serveur est la feuille de connexion.
            EmptyView()
        }
    }
}

/// Les planifications, et leur seule action : « + ».
struct SystemSchedulesPage: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessForm(server: server, drafts: drafts) {
            SchedulesSections(server: server, drafts: drafts)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    drafts.scheduleSheetShown = true
                } label: {
                    Label(ShellText.newSchedule, systemImage: PipelineServerText.newFeatureSymbol)
                }
                .help(ShellText.newSchedule)
                .disabled(!server.canAct || server.schedules.availability != .available)
                .accessibilityIdentifier("schedules.new")
            }
        }
        .accessibilityIdentifier("schedules.harness")
    }
}

/// Statistiques et santé : les graphiques d'abord (ce qui attend par projet, débit,
/// coût, santé), puis le détail chiffré, les services et la capacité.
struct SystemStatsPage: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessForm(server: server, drafts: drafts) {
            if let stats = server.stats {
                HarnessStatsCharts(dashboard: HarnessDashboard(inbox: server.inbox ?? HarnessInbox(), stats: stats))
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
                ServicesSection(server: server)
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
