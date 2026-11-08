import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// Les écrans de l'app iOS servis par le serveur de pipelines du VPS (omp-harness),
// joint directement : « À traiter » (la file unique de ce qui attend l'humain),
// Features (une ligne par feature, une page par feature, et les portées Projets, Audits
// et Issues), et le hub Système avec ses pages (vigie, planifications, statistiques et
// santé, administration). Le Poste passe par le même cadre, dans
// `IOSWorkstationScreen.swift` ; la page d'une feature vit dans `IOSRunScreen.swift`.
//
// Un seul `HarnessModel` et un seul `HarnessDrafts` pour l'app (posés par
// `OMPConsoleIOSApp`) : le flux d'événements tient chaque écran à jour. Les feuilles et
// confirmations des gestes sont posées une fois, à la racine (`RootView`). Les mots
// viennent du noyau (`PipelineServerText`, `ShellText`), les symboles de
// `IOSShellText` : aucun libellé en dur ici (`design-ios/AC-5`).

/// Le cadre commun : relier le serveur s'il ne l'est pas, sinon la liste groupée,
/// avec l'échec du dernier échange en tête et le tirer-pour-actualiser. `reloadAlso`
/// relit en plus ce qui n'est pas dans la boîte (le poste de travail, la vigie…).
struct IOSHarnessScreen<Content: View>: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let title: String
    /// La section qui porte l'écran : ⌘R ne relit que l'écran affiché.
    let owner: ConsoleSection
    /// L'identifiant de l'écran pour la recette (`ios.screen.<section>` ou
    /// `ios.screen.system.<page>`).
    let identifier: String
    let catalog: Bool
    let reloadAlso: (@MainActor () async -> Void)?
    @ViewBuilder let content: () -> Content

    /// L'écran racine d'une section.
    init(
        server: HarnessModel,
        drafts: HarnessDrafts,
        section: ConsoleSection,
        catalog: Bool,
        reloadAlso: (@MainActor () async -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(server: server, drafts: drafts, title: section.title, owner: section, identifier: "ios.screen." + section.rawValue, catalog: catalog, reloadAlso: reloadAlso, content: content)
    }

    /// Une page poussée par le hub Système.
    init(
        server: HarnessModel,
        drafts: HarnessDrafts,
        page: SystemPage,
        reloadAlso: (@MainActor () async -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(server: server, drafts: drafts, title: page.title, owner: .system, identifier: "ios.screen.system." + page.rawValue, catalog: true, reloadAlso: reloadAlso, content: content)
    }

    private init(
        server: HarnessModel,
        drafts: HarnessDrafts,
        title: String,
        owner: ConsoleSection,
        identifier: String,
        catalog: Bool,
        reloadAlso: (@MainActor () async -> Void)?,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.server = server
        self.drafts = drafts
        self.title = title
        self.owner = owner
        self.identifier = identifier
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
                // La palette ou une notification demande un genre de « À traiter »
                // (`homeAnchor`) : la liste y défile, puis oublie la demande.
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
        .navigationTitle(title)
        .task {
            if catalog { await server.refreshCatalog() }
        }
        // ⌘R relit l'écran comme le geste « tirer pour actualiser ».
        .focusedSceneValue(\.iosRefresh, IOSCommandAction(owner: owner, isEnabled: server.isConfigured) {
            Task { await reload() }
        })
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
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

// MARK: - À traiter

/// « À traiter » : la file unique de ce qui attend l'humain (approbations du poste
/// d'abord, puis questions, specs, revues, alertes et audits), sous la ligne de pouls ;
/// rien de vide n'est montré. Le « + » de la barre lance une feature.
struct IOSInboxScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .inbox, catalog: true, reloadAlso: {
            await server.workstation.refresh()
            await server.vigie.refresh()
        }) {
            InboxFeed(server: server, drafts: drafts, inbox: server.inbox ?? HarnessInbox())
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    drafts.launchSheetShown = true
                } label: {
                    Label(PipelineServerText.newFeature, systemImage: PipelineServerText.newFeatureSymbol)
                }
                .disabled(!server.isConfigured || !server.canAct)
                .accessibilityIdentifier("ios.inbox.new")
            }
        }
    }
}

// MARK: - Features

/// Features : la portée choisie en tête de liste (features, projets, audits, issues),
/// puis sa liste. Une feature s'ouvre en page (`IOSRunScreen`) dans la pile de
/// l'onglet, liée à `drafts.openedRun` ; les filtres et la création tiennent dans la
/// barre, la recherche dans le champ du système.
struct IOSFeaturesScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var history: HarnessRunsHistory

    init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.drafts = drafts
        self.history = server.history
    }

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .runs, catalog: true, reloadAlso: { await reloadScope() }) {
            Picker(ShellText.scope, selection: $drafts.runsScope) {
                ForEach(RunsScope.allCases) { scope in
                    Text(scope.title).tag(scope)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .iosBareListRow()
            .accessibilityIdentifier("ios.runs.scope")
            switch drafts.runsScope {
            case .features: RunsListSections(server: server, drafts: drafts, selectable: false)
            case .projects: ProjectsListSections(server: server, drafts: drafts)
            case .audits: AuditsListSections(server: server, drafts: drafts)
            case .issues: IssuesSections(server: server, drafts: drafts)
            }
        }
        .searchable(text: $history.query)
        .toolbar {
            if server.isConfigured {
                if drafts.runsScope == .features {
                    ToolbarItem(placement: .topBarTrailing) {
                        RunsFilterMenu(server: server)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NewWorkMenu(server: server, drafts: drafts)
                }
            }
        }
        .navigationDestination(for: String.self) { runId in
            // Une autre feature ouverte à la même place de la pile repart de zéro (onglet, direct).
            IOSRunScreen(server: server, drafts: drafts, runId: runId)
                .id(runId)
        }
        // Relue à chaque serveur relié : l'appairage fait depuis cet écran la remplit.
        .task(id: server.address) { await history.refresh() }
    }

    private func reloadScope() async {
        switch drafts.runsScope {
        case .features: await history.refresh()
        case .issues: await server.issues.refresh(repo: drafts.issuesRepo(in: server.repos))
        case .projects, .audits: break
        }
    }
}

// MARK: - Système

/// Le hub Système : une rangée par page de ce qui se règle rarement, avec son état à
/// droite ; chaque rangée pousse sa page dans la pile de l'onglet (`drafts.systemPage`),
/// la rangée Serveur ouvre la feuille de connexion. Sur iPhone (`showsMemory`), la
/// Mémoire, qui n'a pas d'onglet, est la première rangée : elle se pousse dans la même
/// pile (`IOSSystemRoute.memory`, destination posée par `IOSSectionView`).
struct IOSSystemScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let showsMemory: Bool

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .system, catalog: false, reloadAlso: { await reloadSummaries() }) {
            if showsMemory {
                Section {
                    NavigationLink(value: IOSSystemRoute.memory) {
                        memoryRow
                    }
                    .accessibilityIdentifier("ios.system.memory")
                }
            }
            SystemHubSections(server: server, drafts: drafts)
        }
        .navigationDestination(for: SystemPage.self) { page in
            IOSSystemPageScreen(server: server, drafts: drafts, page: page)
        }
        .task(id: server.address) { await reloadSummaries() }
    }

    /// La rangée Mémoire, à l'image de celles du hub : symbole, titre, ce qu'elle montre.
    private var memoryRow: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: ConsoleSection.memory.systemImage)
                .accessibilityHidden(true)
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(ConsoleSection.memory.title)
                    .font(.body.weight(.medium))
                Text(IOSShellText.memorySummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
    }

    /// Les résumés des rangées : le mode de la vigie, les planifications actives.
    private func reloadSummaries() async {
        await server.vigie.refresh()
        await server.schedules.refresh()
    }
}

/// L'aiguillage page du hub → écran.
struct IOSSystemPageScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let page: SystemPage

    var body: some View {
        switch page {
        case .vigie: IOSVigieScreen(server: server, drafts: drafts)
        case .schedules: IOSSchedulesScreen(server: server, drafts: drafts)
        case .stats: IOSStatsScreen(server: server, drafts: drafts)
        case .admin: IOSAdminScreen(server: server, drafts: drafts)
        // La rangée Serveur ouvre la feuille de connexion : jamais poussée (`RootView`
        // écarte cette page de la pile).
        case .server: EmptyView()
        }
    }
}

/// La vigie : mode, plafonds, battement de cœur et incidents (contenu partagé, ConsoleUI).
struct IOSVigieScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, page: .vigie, reloadAlso: { await server.vigie.load() }) {
            VigieSections(server: server, drafts: drafts)
        }
        .task { await server.vigie.load() }
    }
}

/// Les planifications récurrentes (contenu partagé, ConsoleUI) ; le « + » de la barre
/// ouvre la feuille « Nouvelle planification ».
struct IOSSchedulesScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, page: .schedules, reloadAlso: { await server.schedules.refresh() }) {
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
        .task { await server.schedules.refresh() }
    }
}

/// L'administration du serveur, admin seulement (contenu partagé, ConsoleUI).
struct IOSAdminScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, page: .admin, reloadAlso: { await server.admin.refresh() }) {
            AdminSections(server: server, drafts: drafts)
        }
        .task(id: server.isAdmin) { await server.admin.refresh() }
    }
}

/// Statistiques et santé : les graphiques (ce qui attend par projet, débit, coût,
/// santé), puis le détail des features, des étapes et des tests, la consommation des
/// agents, les modèles, les services et la capacité du serveur.
struct IOSStatsScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, page: .stats) {
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
