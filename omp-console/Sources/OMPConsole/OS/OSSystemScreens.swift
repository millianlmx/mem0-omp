// Le hub SYSTÈME au centre de l'OS du Mac : la grille de tuiles partagée (`OSSystemHub`),
// puis l'écran choisi, poussé dans la pile du centre (`OSWorkspace.systemPath`) — le
// Poste et ses pages, les dépôts, les planifications, l'autonomie, la vigie, les
// statistiques, les issues, l'administration. Le serveur est une feuille, jamais une page.
// Le contenu de chaque écran est partagé avec l'iPhone/iPad (cible ConsoleUI) ; ce
// fichier n'en garde que le cadre du Mac : formulaire groupé, échec en tête, barre
// d'outils. Propre au Mac : le « Navigateur du serveur » du Poste (`ServerBrowserViews`).

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct OSSystemCenter: View {
    let server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var workspace: OSWorkspace

    var body: some View {
        NavigationStack(path: $workspace.systemPath) {
            OSSystemHub(server: server) { destination in
                if destination == .server {
                    drafts.serverSheetShown = true
                } else {
                    workspace.systemPath.append(destination)
                }
            }
            .navigationDestination(for: OSSystemDestination.self) { destination in
                OSSystemScreen(server: server, drafts: drafts, destination: destination)
                    .navigationTitle(destination.title)
            }
            .workstationDestinations(server: server, drafts: drafts)
        }
    }
}

/// Un écran du hub, dans son cadre du Mac.
struct OSSystemScreen: View {
    let server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let destination: OSSystemDestination

    var body: some View {
        switch destination {
        case .workstation:
            OSWorkstationScreen(server: server, workstation: server.workstation, drafts: drafts)
        case .repos:
            RepoSettingsList(server: server)
        case .schedules:
            OSSystemForm(server: server) { SchedulesSections(server: server, drafts: drafts) }
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
                .task { await server.schedules.refresh() }
                .accessibilityIdentifier("schedules.harness")
        case .autonomy:
            OSSystemForm(server: server) { AutonomySections(server: server, drafts: drafts) }
                .task { await server.autonomy.refresh() }
                .accessibilityIdentifier("autonomy.harness")
        case .vigie:
            OSSystemForm(server: server) { VigieSections(server: server, drafts: drafts) }
                .task { await server.vigie.load() }
                .accessibilityIdentifier("vigie.harness")
        case .stats:
            OSStatsScreen(server: server)
        case .issues:
            OSSystemForm(server: server) { IssuesSections(server: server, drafts: drafts) }
                .accessibilityIdentifier("issues.harness")
        case .admin:
            OSSystemForm(server: server) { AdminSections(server: server, drafts: drafts) }
                .task(id: server.isAdmin) { if server.isAdmin { await server.admin.refresh() } }
                .accessibilityIdentifier("admin.harness")
        case .server:
            // Jamais poussé : le hub ouvre la feuille du serveur.
            EmptyView()
        }
    }
}

/// Le formulaire groupé d'un écran du hub : l'échec du dernier échange en tête, seulement
/// s'il y en a un.
struct OSSystemForm<Content: View>: View {
    @ObservedObject var server: HarnessModel
    @ViewBuilder let content: () -> Content

    var body: some View {
        Form {
            if let failure = server.failure {
                Section {
                    ConsoleFailureBanner(failure: failure)
                }
            }
            content()
        }
        .formStyle(.grouped)
    }
}

/// Le Poste : l'état et l'arrêt d'urgence, les envois à approuver, « Demander au poste »,
/// le journal récent, les pages (réglages, automatisations, commande, profil, réunions,
/// sessions) et, propre au Mac, le navigateur du serveur.
struct OSWorkstationScreen: View {
    let server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts
    @State private var serverLoginShown = false

    var body: some View {
        Form {
            WorkstationSections(workstation: workstation, atlassian: server.atlassian, drafts: drafts)
            ServerBrowserSection(workstation: workstation, model: server.serverBrowser, loginShown: $serverLoginShown)
        }
        .formStyle(.grouped)
        .modifier(ServerBrowserTasks(model: server.serverBrowser))
        .sheet(isPresented: $serverLoginShown) {
            ServerBrowserLoginSheet(model: server.serverBrowser, isPresented: $serverLoginShown)
        }
        .task {
            await workstation.load()
            await server.atlassian.refresh()
        }
        .accessibilityIdentifier("workstation.harness")
    }
}

/// Statistiques et santé : les graphiques d'abord (ce qui attend par projet, débit, coût,
/// santé), puis les chiffres, les services et la capacité.
struct OSStatsScreen: View {
    @ObservedObject var server: HarnessModel

    var body: some View {
        Group {
            if let stats = server.stats {
                OSSystemForm(server: server) {
                    HarnessStatsCharts(dashboard: HarnessDashboard(inbox: server.inbox ?? HarnessInbox(), stats: stats))
                    Section(PipelineServerText.statsRuns) {
                        LabeledContent(PipelineServerText.total, value: "\(stats.runs.total)")
                        ForEach(HarnessRunState.allCases, id: \.self) { state in
                            if let count = stats.runs.byState[state.rawValue], count > 0 {
                                LabeledContent(PipelineServerText.state(state.rawValue), value: "\(count)")
                            }
                        }
                        LabeledContent(PipelineServerText.mergedWeek, value: "\(stats.runs.mergedLast7Days)")
                        LabeledContent(PipelineServerText.mergeRate, value: stats.runs.mergeRate.map(PipelineServerText.percent) ?? PipelineServerText.notAvailable)
                        LabeledContent(PipelineServerText.leadTime, value: stats.runs.medianLeadSec.map(PipelineServerText.duration) ?? PipelineServerText.notAvailable)
                        LabeledContent(PipelineServerText.fixesPerMerge, value: stats.runs.fixesPerMerged.map { String(format: "%.1f", $0) } ?? PipelineServerText.notAvailable)
                    }
                    Section(PipelineServerText.statsSteps) {
                        ForEach(HarnessRun.stepKinds, id: \.self) { kind in
                            if let step = stats.steps[kind] {
                                Text(PipelineServerText.stepLine(label: HarnessRun.label(forStep: kind), count: step.count, failed: step.failed, median: step.medianSec))
                            }
                        }
                    }
                    Section(PipelineServerText.statsTests) {
                        LabeledContent(PipelineServerText.total, value: "\(stats.tests.total)")
                        LabeledContent(PipelineServerText.testsCached, value: "\(stats.tests.cached)")
                        LabeledContent(PipelineServerText.testsRetried, value: "\(stats.tests.retried)")
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
                    Section(PipelineServerText.statsCapacity) {
                        LabeledContent(PipelineServerText.runners, value: PipelineServerText.slots(used: stats.scheduler.runner.used, capacity: stats.scheduler.runner.capacity))
                        LabeledContent(PipelineServerText.heavySlots, value: PipelineServerText.slots(used: stats.scheduler.heavy.used, capacity: stats.scheduler.heavy.capacity))
                        LabeledContent(PipelineServerText.memoryFree, value: stats.scheduler.memAvailableMiB.map(PipelineServerText.mebibytes) ?? PipelineServerText.notAvailable)
                    }
                }
            } else {
                ContentUnavailableView(PipelineServerText.noStats, systemImage: OSSystemDestination.stats.symbol)
            }
        }
        .task { await server.refreshCatalog() }
        .accessibilityIdentifier("stats.harness")
    }
}
