import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

/// La racine UNIQUE de l'app iOS : une barre d'onglets native (`TabView`, style
/// `.sidebarAdaptable`) porte les deux tailles d'écran. En largeur régulière (iPad)
/// elle s'ouvre en barre latérale groupée (Travail, Outils, Système) avec les cinq
/// sections, puis la recherche. En largeur compacte (iPhone), la barre n'a que cinq
/// places, recherche comprise : À traiter, Features, Poste, Système, puis la
/// recherche ; la Mémoire y est la première rangée du hub Système, poussée dans sa
/// pile. Chaque onglet a sa `NavigationStack` : celle de Features suit la feature
/// ouverte (`drafts.openedRun`), celle de Système la page montrée (`drafts.systemPage`)
/// — la palette et les notifications y poussent donc leur page. Le routage onglet ↔
/// section est pur (`IOSTabs`).
///
/// Elle REÇOIT les deux accès de `OMPConsoleIOSApp`, tous deux au serveur du VPS
/// et posés par le même code d'appairage : ses pipelines (lus au lancement, flux
/// ouvert) et sa mémoire. Aucun Mac. Les feuilles et confirmations des gestes sont
/// posées ici, une fois pour toute l'app.
struct RootView: View {
    @State private var selection: IOSTab
    @State private var state: IOSScreenState
    @ObservedObject var memory: MemoryAccess
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    /// Les notifications : un toucher ouvre la bonne section ou la feature.
    @ObservedObject var notifications: HarnessNotificationCenter
    /// Le poste de travail du même serveur (`server.workstation`) : ses badges.
    @ObservedObject var workstation: WorkstationModel
    /// Les propositions des signalements de collègues (`server.signals`) : badge d'À traiter.
    @ObservedObject var signals: CorporateSignalsModel
    /// La vigie du même serveur (`server.vigie`) : le badge de Système quand elle se tait.
    @ObservedObject var vigie: HarnessVigie
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    /// La pile de Système : une page du hub, ou la Mémoire sur iPhone.
    @State private var systemPath = NavigationPath()

    /// Le crochet de recette `-memoire.recipe`, quand il est donné.
    private let memoryRecipe: IOSMemoryGraphRecipe?

    init(
        memory: MemoryAccess,
        server: HarnessModel,
        drafts: HarnessDrafts,
        notifications: HarnessNotificationCenter,
        selection: ConsoleSection = .inbox,
        state: IOSScreenState = .ready,
        memoryRecipe: IOSMemoryGraphRecipe? = nil
    ) {
        self.memory = memory
        self.server = server
        self.drafts = drafts
        self.notifications = notifications
        self.workstation = server.workstation
        self.signals = server.signals
        self.vigie = server.vigie
        _selection = State(initialValue: IOSTabs.tab(from: .section(.inbox), to: selection))
        _state = State(initialValue: state)
        self.memoryRecipe = memoryRecipe
    }

    // Le `TabView` et l'onglet d'une section vivent hors de `body` : d'un seul
    // tenant, l'expression dépassait le temps de vérification de types de la CI.
    private var tabs: some View {
        TabView(selection: shownSelection) {
            ForEach(ConsoleSectionGroup.allCases, id: \.self) { group in
                TabSection(group.title) {
                    ForEach(IOSSection.sections(of: group)) { section in
                        sectionTab(section)
                    }
                }
            }
            Tab(value: IOSTab.search, role: .search) {
                NavigationStack {
                    IOSSearchScreen(server: server, drafts: drafts)
                }
            }
            .accessibilityIdentifier("ios.tab.search")
        }
        .tabViewStyle(.sidebarAdaptable)
        .defaultAdaptableTabBarPlacement(.sidebar)
        .tabViewSidebarHeader {
            Text(IOSShellText.rootTitle)
                .font(.title.bold())
                .accessibilityAddTraits(.isHeader)
        }
    }

    /// Vrai en largeur compacte (iPhone, iPad en Split View étroit).
    private var isCompact: Bool { sizeClass == .compact }

    /// La sélection ramenée à la largeur COURANTE, dans la même passe que le masquage
    /// (UIKit interrompt l'app si la sélection désigne un onglet masqué).
    private var shownSelection: Binding<IOSTab> {
        Binding(get: { IOSTabs.shown(selection, compact: isCompact) }, set: { selection = $0 })
    }

    /// L'onglet d'une section : son badge d'attente, sa pile de navigation.
    @TabContentBuilder<IOSTab>
    private func sectionTab(_ section: ConsoleSection) -> some TabContent<IOSTab> {
        let count: Int = badge(for: section)
        let label: String = IOSShellText.sectionRowLabel(section.title, badge: count)
        let identifier: String = "ios.tab." + section.rawValue
        Tab(section.title, systemImage: IOSSection.systemImage(of: section), value: IOSTab.section(section)) {
            stack(for: section)
        }
        .badge(count)
        .hidden(IOSTabs.isHidden(section, compact: isCompact))
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    /// La pile d'un onglet : liée à la feature ouverte pour Features, à la page
    /// montrée (ou à la Mémoire sur iPhone) pour Système, libre ailleurs.
    @ViewBuilder
    private func stack(for section: ConsoleSection) -> some View {
        switch section {
        case .runs:
            NavigationStack(path: openedRunPath) { sectionScreen(section) }
        case .system:
            NavigationStack(path: $systemPath) { sectionScreen(section) }
        default:
            NavigationStack { sectionScreen(section) }
        }
    }

    /// La pile de Features : la page de `drafts.openedRun`, rien sinon ; revenir à la
    /// liste l'oublie.
    private var openedRunPath: Binding<[String]> {
        Binding(
            get: { drafts.openedRun.map { [$0] } ?? [] },
            set: { drafts.openedRun = $0.last }
        )
    }

    var body: some View {
        tabs
            .focusedSceneValue(\.iosSelectSection, IOSSectionSelector(current: IOSTabs.shown(selection, compact: isCompact).section, select: selector))
            // La page de Système demandée (palette, notification, vigie muette) remplace la
            // pile de l'onglet ; le Serveur, lui, est une feuille. Revenir au hub l'oublie.
            .onChange(of: drafts.systemPage, initial: true) { _, page in
                guard let page, page != .server else { return }
                systemPath = NavigationPath([page])
            }
            .onChange(of: systemPath.count) { _, count in
                if count == 0 { drafts.systemPage = nil }
            }
            // Sur iPhone, la Mémoire choisie (lancement, iPad replié) passe sous Système.
            .onChange(of: isCompact, initial: true) { _, compact in
                if compact, selection == .section(.memory) { selector(.memory) }
            }
            // Un toucher sur le widget d'écran d'accueil ouvre sa section.
            .onOpenURL { url in
                if let section = HarnessWidgetLink.section(of: url) { selector(section) }
            }
            .sheet(isPresented: $drafts.serverSheetShown) {
                IOSServerSheet(server: server, drafts: drafts)
            }
            // La palette ⌘K et les feuilles de création (feature ⌘N, projet, audit,
            // planification), partagées avec le Mac (ConsoleUI).
            .consolePalette(server: server, drafts: drafts, sections: IOSSection.all, memory: true, select: selector)
            .consoleNotificationRoutes(notifications, server: server, drafts: drafts, select: selector)
            .focusedSceneValue(\.iosPalette, IOSPaletteAction(drafts: drafts, isEnabled: server.isConfigured))
            // Les feuilles et confirmations des gestes (refus, consigne, budget, relance,
            // arrêt, direct d'un audit ou d'un job du poste, approbations du poste,
            // planifications, clients), une fois pour toute l'app.
            .harnessGestures(server: server, drafts: drafts)
            .workstationGestures(workstation: workstation, drafts: drafts)
            .controlGestures(server: server, drafts: drafts)
            // Le socle des écrans partagés : le rendu Markdown, le direct d'une session,
            // la Live Activity d'une feature, propres à l'iPhone/iPad, et la sélection
            // de section.
            .consoleShell(ConsoleShell(
                markdown: { AnyView(IOSMarkdownView(blocks: $0)) },
                session: { [server] request in AnyView(IOSSessionSheet(server: server, request: request)) },
                runActions: { [server] run in AnyView(IOSLiveActivityMenuItem(server: server, run: run)) },
                select: { section in selector(section) }
            ))
            .task {
                await memory.load()
                await server.load()
                server.startLive()
            }
            // L'état du poste et ses envois à approuver, les propositions des signalements
            // (badges, À traiter), et le battement de la vigie, relus à chaque serveur relié ;
            // le flux de la boîte les tient ensuite à jour.
            .task(id: server.address) {
                await workstation.refresh()
                await signals.refresh()
                await server.intakes.refresh()
                await vigie.refresh()
            }
            // Au retour au premier plan, le flux coupé en arrière-plan est rouvert sur une
            // boîte fraîche : ce qui a changé pendant l'absence se voit tout de suite.
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                server.stopLive()
                Task {
                    await server.refresh()
                    server.startLive()
                    await workstation.refresh()
                    await signals.refresh()
                    await server.intakes.refresh()
                }
            }
    }

    /// L'écran racine d'une section.
    private func sectionScreen(_ section: ConsoleSection) -> some View {
        IOSSectionView(
            section: section,
            state: state,
            memory: memory,
            server: server,
            drafts: drafts,
            memoryRecipe: memoryRecipe
        )
    }

    /// Montrer une section (⌘<n>, palette, notification, widget, lien d'une vue
    /// partagée) : sélectionne son onglet. Sur iPhone, la Mémoire s'ouvre dans la pile
    /// de Système.
    private var selector: @MainActor @Sendable (ConsoleSection) -> Void {
        let selection = $selection
        let systemPath = $systemPath
        let compact = isCompact
        return { section in
            if IOSTabs.isHidden(section, compact: compact) {
                selection.wrappedValue = .section(.system)
                systemPath.wrappedValue = NavigationPath([IOSSystemRoute.memory])
                return
            }
            selection.wrappedValue = IOSTabs.tab(from: selection.wrappedValue, to: section)
        }
    }

    /// Le badge d'une section (`IOSTabs.badge`).
    private func badge(for section: ConsoleSection) -> Int {
        IOSTabs.badge(
            of: section,
            pending: (server.inbox?.pendingCount ?? 0) + signals.pendingCount,
            approvals: workstation.pendingCount,
            vigieSilent: vigie.isSilent
        )
    }
}
