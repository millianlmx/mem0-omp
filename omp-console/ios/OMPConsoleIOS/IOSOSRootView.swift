import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// L'« OS agentique » sur iPhone et iPad : la COQUE de l'app. Une barre d'onglets native
// (`TabView`, style `.sidebarAdaptable` : barre en bas sur iPhone, en haut ou en barre
// latérale sur iPad) porte cinq onglets — Maintenant (le Radar et le brief), Fils (le
// composeur, l'espace, la liste ; un fil se pousse dans la pile), Décisions (le tri, sa
// pastille), Propositions (sa pastille) et Savoir (consignes, paliers, espaces,
// Automatismes, Mémoire). La roue de la barre de chaque onglet pousse le hub Système dans
// sa pile, puis la page d'une tuile (`IOSSystemScreens.swift`). « Comprendre » est un
// inspecteur : une colonne sur iPad, une feuille sur iPhone. Les écrans eux-mêmes sont
// partagés avec le Mac (`ConsoleUI/OS/`) : ce fichier ne porte que ce qui est propre à
// l'iPhone et à l'iPad — onglets, piles, barre, tirer pour actualiser, ⌘1…⌘5, arguments de
// recette.
//
// Les écrans partagés demandent un écran par `OSWorkspace` (un fil, un espace, le tri,
// « Comprendre ») : la coque traduit la demande en onglet et en page (`IOSOSNavigation`)
// et rend à l'espace de travail ce que l'écran montre. Les feuilles et confirmations des
// gestes restent posées une fois, à la racine (`RootView`).

struct IOSOSRootView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var spaces: HarnessSpacesModel
    @ObservedObject var proposals: HarnessProposalsModel
    /// Les fils et le compte des décisions, recalculés à part et publiés seulement s'ils
    /// changent : la coque ne les reconstruit pas à chaque rendu.
    @StateObject private var threadStore: OSThreadStore
    @StateObject private var workspace: OSWorkspace
    /// Portés sans être observés ici : leurs écrans les observent eux-mêmes.
    private let memory: MemoryAccess
    private let intakes: HarnessIntakes
    private let history: HarnessRunsHistory
    private let vigie: HarnessVigie
    private let atlassian: AtlassianModel
    private let localSessions: HarnessLocalSessionsModel
    @Binding var navigation: IOSOSNavigation
    /// Le fil et l'espace que la recette demande d'ouvrir (`-os.thread`, `-os.space`), tant
    /// qu'ils ne sont pas connus.
    @State private var pendingThread: String?
    @State private var pendingSpace: String?
    /// L'historique a été lu une fois : un fil absent n'existe plus.
    @State private var loaded = false

    /// L'état de recette et le crochet du graphe de l'écran Mémoire, poussé depuis le Savoir.
    let state: IOSScreenState
    let memoryRecipe: IOSMemoryGraphRecipe?

    init(
        memory: MemoryAccess, server: HarnessModel, drafts: HarnessDrafts, navigation: Binding<IOSOSNavigation>,
        launch: IOSShellLaunch, state: IOSScreenState, memoryRecipe: IOSMemoryGraphRecipe?
    ) {
        self.memory = memory
        self.server = server
        self.drafts = drafts
        workstation = server.workstation
        intakes = server.intakes
        history = server.history
        vigie = server.vigie
        atlassian = server.atlassian
        spaces = server.spaces
        localSessions = server.localSessions
        proposals = server.proposals
        _threadStore = StateObject(wrappedValue: OSThreadStore(server: server))
        _workspace = StateObject(wrappedValue: OSWorkspace(server: server))
        _navigation = navigation
        _pendingThread = State(initialValue: launch.thread)
        _pendingSpace = State(initialValue: launch.space)
        self.state = state
        self.memoryRecipe = memoryRecipe
    }

    /// Le nom de chaque navigateur du poste, par identifiant.
    private var browserNames: [String: String] {
        Dictionary((workstation.status?.browsers ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        let all = threadStore.threads
        let decisions = threadStore.decisionCount
        tabs(all, decisions: decisions)
            .focusedSceneValue(\.iosSelectTab, IOSTabSelector(current: navigation.tab) { [navigation = $navigation] tab in
                navigation.wrappedValue.show(tab)
            })
            .task(id: server.address) { await load() }
            // Un lien, une notification touchée, une proposition acceptée, une feature citée :
            // son fil s'ouvre dès qu'il existe. La recette ouvre le sien de la même façon.
            .onChange(of: openKey(all), initial: true) {
                if let runId = drafts.openedRun {
                    drafts.openedRun = nil
                    workspace.open(runId: runId, in: all)
                } else {
                    workspace.settle(all)
                }
                openPending(all)
            }
            // Ce qu'un écran partagé demande devient un onglet et une page, puis l'espace de
            // travail reçoit ce que l'écran montre vraiment (un fil oublié rend la liste).
            .onChange(of: workspace.selection) { _, selection in
                navigation.follow(selection: selection)
                reconcile()
            }
            // L'humain change d'onglet ou revient en arrière : l'espace de travail le suit —
            // sauf si une demande y attend déjà (posée dans la même passe : elle sera suivie).
            .onChange(of: navigation) { old, _ in
                if workspace.selection == old.selection { reconcile() }
            }
            .onAppear { reconcile() }
            .onChange(of: workspace.triage) { _, asked in
                guard asked else { return }
                workspace.triage = false
                navigation.show(.decisions)
            }
            .onDisappear { workspace.pulse.stop() }
    }

    // MARK: Onglets

    private func tabs(_ threads: [OSThread], decisions: Int) -> some View {
        TabView(selection: shownTab) {
            ForEach(IOSOSTab.allCases, id: \.self) { tab in
                tabItem(tab, threads: threads, decisions: decisions)
            }
        }
        // Sur iPad, la barre d'onglets du haut (la barre latérale couvrirait le contenu en
        // portrait) ; son bouton ouvre la barre latérale et ses cinq onglets.
        .tabViewStyle(.sidebarAdaptable)
        .tabViewSidebarHeader {
            Text(IOSShellText.rootTitle)
                .font(.title.bold())
                .accessibilityAddTraits(.isHeader)
        }
    }

    /// L'onglet montré : jamais les Propositions sur un serveur qui n'en sert pas (UIKit
    /// interrompt l'app si la sélection désigne un onglet masqué).
    private var shownTab: Binding<IOSOSTab> {
        Binding(
            get: { navigation.tab == .proposals && !proposals.isServed ? .now : navigation.tab },
            set: { navigation.tab = $0 }
        )
    }

    /// Un onglet : sa pastille, sa pile de navigation.
    @TabContentBuilder<IOSOSTab>
    private func tabItem(_ tab: IOSOSTab, threads: [OSThread], decisions: Int) -> some TabContent<IOSOSTab> {
        let count: Int = IOSOSRouting.badge(of: tab, decisions: decisions, proposals: proposals.isServed ? proposals.proposals.count : 0)
        let label: String = IOSShellText.sectionRowLabel(tab.title, badge: count)
        let identifier: String = "ios.os.tab." + tab.rawValue
        Tab(tab.title, systemImage: tab.systemImage, value: tab) {
            NavigationStack(path: path(of: tab)) {
                root(tab, threads: threads, decisions: decisions)
                    .navigationDestination(for: IOSOSRoute.self) { route in
                        page(route, threads: threads)
                    }
            }
            // « Comprendre » : une colonne à côté de la pile sur iPad, une feuille sur iPhone.
            .inspector(isPresented: understanding(in: tab)) {
                IOSOSUnderstandPanel(server: server, drafts: drafts, workspace: workspace, runId: understoodRun(threads))
                    .inspectorColumnWidth(min: 320, ideal: 420, max: 560)
            }
        }
        .badge(count)
        .hidden(tab == .proposals && !proposals.isServed)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    /// « Comprendre » est montré par l'onglet affiché, et par lui seul.
    private func understanding(in tab: IOSOSTab) -> Binding<Bool> {
        Binding(
            get: { workspace.understanding && navigation.tab == tab },
            set: { shown in
                if navigation.tab == tab { workspace.understanding = shown }
            }
        )
    }

    private func path(of tab: IOSOSTab) -> Binding<[IOSOSRoute]> {
        Binding(get: { navigation.path(of: tab) }, set: { navigation.setPath($0, of: tab) })
    }

    // MARK: Racines

    /// L'écran racine d'un onglet.
    @ViewBuilder
    private func root(_ tab: IOSOSTab, threads: [OSThread], decisions: Int) -> some View {
        switch tab {
        case .now:
            IOSOSScreen(server: server, drafts: drafts, tab: tab, reload: reload, openSystem: openSystem) {
                OSHomeView(server: server, pulse: workspace.pulse, workspace: workspace, threads: threads, decisions: decisions)
            }
            .navigationBarTitleDisplayMode(.inline)
            // Le Radar reste en tête, sous la barre : la pause y est toujours à un geste.
            .safeAreaInset(edge: .top, spacing: 0) {
                if server.isConfigured {
                    OSRadar(server: server, workstation: workstation, vigie: vigie, pulse: workspace.pulse, workspace: workspace, threads: threads)
                }
            }
        case .threads:
            IOSOSScreen(server: server, drafts: drafts, tab: tab, reload: reload, openSystem: openSystem) {
                OSThreadList(
                    server: server, intakes: intakes, pulse: workspace.pulse, workspace: workspace,
                    threads: OSThreadScope.threads(threads, spaceId: workspace.spaceId, place: workspace.place, spaces: spaces.spaces),
                    places: OSThreadScope.places(
                        repos: server.repos.map(\.name), threads: threads, space: spaces.spaces.first { $0.id == workspace.spaceId }
                    ),
                    browsers: browserNames, decisions: decisions, drafts: drafts
                )
                // Le style à sections repliables : les fils arrêtés restent repliés.
                .listStyle(.sidebar)
            }
        case .decisions:
            IOSOSScreen(server: server, drafts: drafts, tab: tab, reload: reload, openSystem: openSystem) {
                OSTriageView(server: server, workstation: workstation, intakes: intakes, workspace: workspace, embedded: true)
                    .iosReadableWidth()
            }
        case .proposals:
            IOSOSScreen(server: server, drafts: drafts, tab: tab, reload: reload, openSystem: openSystem) {
                OSProposalsView(server: server, workspace: workspace, threads: threads)
            }
        case .knowledge:
            IOSOSScreen(server: server, drafts: drafts, tab: tab, reload: reload, openSystem: openSystem) {
                OSKnowledgeView(
                    server: server, workspace: workspace,
                    openMemory: { navigation.push(.memory) },
                    openAutomations: { navigation.push(.automations) }
                )
            }
        }
    }

    // MARK: Pages poussées

    @ViewBuilder
    private func page(_ route: IOSOSRoute, threads: [OSThread]) -> some View {
        switch route {
        case let .thread(id):
            IOSOSThreadPage(
                server: server, drafts: drafts, workspace: workspace,
                thread: threads.first { $0.id == id }, loaded: loaded, browsers: browserNames, reload: reload
            )
        case let .space(id):
            OSSpacePage(server: server, spaceId: id) { text in IOSPasteboard.copy(text) }
                .id(id)
                .refreshable { await reload() }
                .navigationBarTitleDisplayMode(.inline)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("ios.os.screen.space")
        case .automations:
            OSAutomationsView(server: server, drafts: drafts)
                .refreshable { await reload() }
                .navigationBarTitleDisplayMode(.inline)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("ios.os.screen.automations")
        case .memory:
            IOSMemoryScreen(
                client: memory, recipe: state, graphRecipe: memoryRecipe,
                showConnection: $drafts.serverSheetShown, searchRequest: $drafts.memorySearchRequest
            )
        case .system:
            IOSSystemHubScreen(server: server, open: openSystemPage)
        case let .systemPage(destination):
            IOSSystemDestinationScreen(server: server, drafts: drafts, destination: destination)
        }
    }

    /// La roue de la barre : le hub Système, dans la pile de l'onglet montré.
    private func openSystem() {
        navigation.push(.system)
    }

    /// Une tuile du hub : sa page, poussée par-dessus ; le Serveur ouvre sa feuille.
    private func openSystemPage(_ destination: OSSystemDestination) {
        if destination == .server {
            drafts.serverSheetShown = true
        } else {
            navigation.push(.systemPage(destination))
        }
    }

    /// La feature que « Comprendre » montre : celle qu'un écran a désignée, sinon celle du
    /// fil montré.
    private func understoodRun(_ threads: [OSThread]) -> String? {
        if let focused = workspace.focusRunId { return focused }
        guard case let .thread(id)? = navigation.top else { return nil }
        return threads.first { $0.id == id }?.focusRun?.id
    }

    /// Rend à l'espace de travail ce que l'écran montre.
    private func reconcile() {
        let shown = navigation.selection
        if workspace.selection != shown { workspace.selection = shown }
    }

    // MARK: Lectures

    /// Ce qui fait rouvrir un fil attendu : la feature à ouvrir, celle qu'on attend, la
    /// recette, et le nombre de fils connus.
    private func openKey(_ threads: [OSThread]) -> String {
        [drafts.openedRun ?? "", workspace.pendingRunId ?? "", pendingThread ?? "", String(threads.count)].joined(separator: "|")
    }

    /// Recette : le fil (`-os.thread`) et l'espace (`-os.space`) demandés s'ouvrent dès qu'ils
    /// sont connus.
    private func openPending(_ threads: [OSThread]) {
        if let id = pendingThread, let found = IOSOSRouting.thread(named: id, in: threads) {
            pendingThread = nil
            navigation.show(.thread(found.id), in: .threads)
        }
        if let name = pendingSpace, let found = IOSOSRouting.space(named: name, in: spaces.spaces) {
            pendingSpace = nil
            navigation.show(.space(found.id), in: .knowledge)
        }
    }

    /// À chaque serveur relié : le pouls, puis tout ce dont les fils sont faits.
    private func load() async {
        guard server.isConfigured else { return }
        workspace.pulse.start()
        await history.refresh()
        await workstation.load()
        await vigie.load()
        await intakes.refresh()
        await atlassian.refresh()
        await localSessions.refresh()
        await spaces.refresh()
        await proposals.refresh()
        await server.refreshCatalog()
        loaded = true
        openPending(threadStore.threads)
    }

    /// Tirer pour actualiser : la boîte, les fils, et ce que les cinq onglets montrent.
    private func reload() async {
        await server.refresh()
        await history.refresh()
        await workstation.refresh()
        await intakes.refresh()
        await atlassian.refresh()
        await localSessions.refresh()
        await spaces.refresh()
        await proposals.refresh()
        await server.pause.refresh()
        await server.brief.refresh()
        await server.rules.refresh()
        await server.autonomy.refresh()
        await vigie.refresh()
    }
}
