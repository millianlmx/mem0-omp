import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// Le SYSTÈME de l'app iOS : ce qui se règle ou se consulte rarement. La roue de la barre
// de chaque onglet pousse le hub dans la pile de l'onglet ; c'est la grille de tuiles
// partagée avec le Mac (`OSSystemHub`). Une tuile pousse sa page dans la même pile (le
// Serveur, lui, ouvre sa feuille, posée à la racine). Chaque page est une liste groupée
// native autour d'un contenu partagé (ConsoleUI) : le Poste, les dépôts, les
// planifications, l'autonomie, la vigie, les statistiques, les issues, l'administration.
// Les feuilles et confirmations de leurs gestes sont posées une fois, à la racine
// (`RootView`). Mots : `OSSystemDestination`, `PipelineServerText` ; symboles :
// `IOSShellText` — aucun libellé en dur ici (`design-ios/AC-5`).

/// Le hub Système : la grille de tuiles partagée, le tirer-pour-actualiser et ⌘R.
struct IOSSystemHubScreen: View {
    @ObservedObject var server: HarnessModel
    let open: @MainActor (OSSystemDestination) -> Void

    private static let identifier = "ios.os.screen.system"

    var body: some View {
        OSSystemHub(server: server, open: open)
            .refreshable { await reload() }
            .focusedSceneValue(\.iosRefresh, IOSCommandAction(owner: Self.identifier, isEnabled: server.isConfigured) {
                Task { await reload() }
            })
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(Self.identifier)
    }

    /// Ce que les tuiles résument : le poste, la vigie, les planifications, l'autonomie,
    /// les clients et les dépôts.
    private func reload() async {
        await server.refresh()
        await server.workstation.refresh()
        await server.vigie.refresh()
        await server.schedules.refresh()
        await server.autonomy.refresh()
        if server.isAdmin { await server.admin.refresh() }
        await server.refreshCatalog()
    }
}

/// Une page du hub, poussée dans la pile de l'onglet.
struct IOSSystemDestinationScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let destination: OSSystemDestination

    var body: some View {
        switch destination {
        case .workstation:
            page(refresh: {
                await server.workstation.load()
                await server.atlassian.refresh()
            }) {
                WorkstationSections(workstation: server.workstation, atlassian: server.atlassian, drafts: drafts)
            }
            .workstationDestinations(server: server, drafts: drafts)
        case .repos:
            RepoSettingsList(server: server)
                .navigationTitle(destination.title)
                .navigationBarTitleDisplayMode(.inline)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("ios.os.system." + destination.rawValue)
        case .schedules:
            page(refresh: { await server.schedules.refresh() }) {
                SchedulesSections(server: server, drafts: drafts)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        drafts.scheduleSheetShown = true
                    } label: {
                        Label(ShellText.newSchedule, systemImage: IOSShellText.addSymbol)
                    }
                    .disabled(!server.canAct)
                    .accessibilityIdentifier("ios.schedules.new")
                }
            }
        case .autonomy:
            page(refresh: { await server.autonomy.refresh() }) {
                AutonomySections(server: server, drafts: drafts)
            }
        case .vigie:
            page(refresh: { await server.vigie.load() }) {
                VigieSections(server: server, drafts: drafts)
            }
        case .stats:
            page(refresh: { await server.refreshCatalog() }) {
                IOSStatsSections(server: server)
            }
        case .issues:
            // Les issues du dépôt choisi se relisent d'elles-mêmes (`IssuesSections`).
            page(refresh: {}) {
                IssuesSections(server: server, drafts: drafts)
            }
        case .admin:
            page(refresh: { await server.admin.refresh() }) {
                AdminSections(server: server, drafts: drafts)
            }
        case .server:
            // Le Serveur est la feuille de connexion, ouverte par la racine : jamais poussé
            // (`IOSOSNavigation.showSystem`, `IOSOSRootView.openSystemPage`).
            EmptyView()
        }
    }

    private func page<Content: View>(
        refresh: @escaping @MainActor () async -> Void, @ViewBuilder content: @escaping () -> Content
    ) -> IOSSystemPage<Content> {
        IOSSystemPage(server: server, destination: destination, refresh: refresh, content: content)
    }
}

/// Le cadre d'une page du hub : la liste groupée native, l'échec du dernier échange en tête,
/// le titre de la page, la lecture à l'ouverture, le tirer-pour-actualiser et ⌘R.
struct IOSSystemPage<Content: View>: View {
    @ObservedObject var server: HarnessModel
    let destination: OSSystemDestination
    /// Ce que la page lit en plus de la boîte (le poste, la vigie…).
    let refresh: @MainActor () async -> Void
    @ViewBuilder let content: () -> Content

    private var identifier: String { "ios.os.system." + destination.rawValue }

    var body: some View {
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
        .task { await refresh() }
        .navigationTitle(destination.title)
        .navigationBarTitleDisplayMode(.inline)
        .focusedSceneValue(\.iosRefresh, IOSCommandAction(owner: identifier, isEnabled: server.isConfigured) {
            Task { await reload() }
        })
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private func reload() async {
        await server.refresh()
        await refresh()
    }
}

/// Statistiques et santé : les graphiques d'abord (ce qui attend, débit, coût, santé), puis
/// les chiffres des features, des étapes et des tests, la consommation des agents, les
/// modèles, les tests instables, les services et la santé du serveur au fil du temps.
struct IOSStatsSections: View {
    @ObservedObject var server: HarnessModel

    var body: some View {
        if let stats = server.stats {
            IOSStatsCharts(dashboard: HarnessDashboard(inbox: server.inbox ?? HarnessInbox(), stats: stats))
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
        } else {
            ContentUnavailableView(PipelineServerText.noStats, systemImage: OSSystemDestination.stats.symbol)
                .iosBareListRow()
        }
    }
}
