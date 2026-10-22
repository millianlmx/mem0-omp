import ConsoleClient
import ConsoleCore
import SwiftUI

/// La racine UNIQUE de l'app iOS : une barre d'onglets native (`TabView`, style
/// `.sidebarAdaptable`) porte les deux tailles d'écran. En largeur compacte
/// (iPhone) elle montre quatre onglets en bas — Accueil, Pipelines, Projet, Audit —
/// puis « Plus », qui pousse Statistiques et Mémoire dans sa propre pile ; en
/// largeur régulière (iPad) elle s'ouvre en barre latérale groupée (Pilotage,
/// Consultation). Chaque onglet a sa `NavigationStack`. Le routage onglet ↔
/// section est pur (`IOSTabs`).
///
/// Elle REÇOIT les deux accès de `OMPConsoleIOSApp`, tous deux au serveur du VPS
/// et posés par le même code d'appairage : ses pipelines (lus au lancement, flux
/// ouvert) et sa mémoire. Aucun Mac. L'onglet Accueil porte le badge de ce qui
/// attend l'humain, l'onglet Audit celui des audits à trier.
struct RootView: View {
    @State private var route: IOSTabRoute
    @State private var state: IOSScreenState
    @ObservedObject var memory: MemoryAccess
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase

    /// Le crochet de recette `-memoire.recipe`, quand il est donné.
    private let memoryRecipe: IOSMemoryGraphRecipe?

    init(
        memory: MemoryAccess,
        server: HarnessModel,
        drafts: HarnessDrafts,
        selection: ConsoleSection = .home,
        state: IOSScreenState = .ready,
        memoryRecipe: IOSMemoryGraphRecipe? = nil
    ) {
        self.memory = memory
        self.server = server
        self.drafts = drafts
        _route = State(initialValue: IOSTabRoute(tab: .section(selection), plusPath: []))
        _state = State(initialValue: state)
        self.memoryRecipe = memoryRecipe
    }

    // Le `TabView` et l'onglet d'une section vivent hors de `body` : d'un seul
    // tenant, l'expression dépassait le temps de vérification de types de la CI.
    private var tabs: some View {
        TabView(selection: shownRoute.tab) {
            ForEach(ConsoleSectionGroup.allCases, id: \.self) { group in
                TabSection(group.title) {
                    ForEach(IOSTabs.declaredSections(of: group, compact: isCompact)) { section in
                        sectionTab(section)
                    }
                }
            }
            Tab(IOSShellText.plusTitle, systemImage: IOSShellText.plusSymbol, value: IOSTab.plus) {
                NavigationStack(path: shownRoute.plusPath) {
                    plusList.navigationDestination(for: ConsoleSection.self) { sectionScreen($0) }
                }
            }
            .hidden(IOSTabs.isHidden(.plus, compact: isCompact))
            .accessibilityIdentifier("ios.tab.plus")
        }
        .tabViewStyle(.sidebarAdaptable)
        .defaultAdaptableTabBarPlacement(.sidebar)
        .tabViewSidebarHeader {
            Text(IOSShellText.rootTitle)
                .font(.title.bold())
                .accessibilityAddTraits(.isHeader)
        }
    }

    /// L'onglet d'une section : badge d'attente, masquage sous « Plus » en compact.
    @TabContentBuilder<IOSTab>
    private func sectionTab(_ section: ConsoleSection) -> some TabContent<IOSTab> {
        let count: Int = badge(for: section)
        let label: String = IOSShellText.sectionRowLabel(section.title, badge: count)
        let hidden: Bool = IOSTabs.isHidden(IOSTab.section(section), compact: isCompact)
        let identifier: String = "ios.tab." + section.rawValue
        Tab(section.title, systemImage: IOSSection.systemImage(of: section), value: IOSTab.section(section)) {
            NavigationStack { sectionScreen(section) }
        }
        .badge(count)
        .hidden(hidden)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    var body: some View {
        tabs
            .onChange(of: sizeClass, initial: true) { _, size in
                route = IOSTabs.adapt(route, compact: size == .compact)
            }
            .focusedSceneValue(\.iosSelectSection, IOSSectionSelector(current: IOSTabs.shown(currentRoute)) { select($0) })
            .sheet(isPresented: $drafts.serverSheetShown) {
                IOSServerSheet(server: server, drafts: drafts)
            }
            .task {
                await memory.load()
                await server.load()
                server.startLive()
            }
            // Au retour au premier plan, le flux coupé en arrière-plan est rouvert sur une
            // boîte fraîche : ce qui a changé pendant l'absence se voit tout de suite.
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                server.stopLive()
                Task {
                    await server.refresh()
                    server.startLive()
                }
            }
    }

    /// Vrai en largeur compacte (iPhone, iPad en Split View étroit).
    private var isCompact: Bool { sizeClass == .compact }

    /// La route ramenée à la classe de taille COURANTE : sélection et masquage se
    /// lisent tous deux depuis `isCompact`, dans la même passe (UIKit interrompt
    /// l'app si la sélection désigne un onglet masqué).
    private var currentRoute: IOSTabRoute { IOSTabs.adapt(route, compact: isCompact) }

    private var shownRoute: Binding<IOSTabRoute> {
        Binding(get: { currentRoute }, set: { route = $0 })
    }

    /// L'écran d'une section : contenu de chaque onglet ET destination de « Plus ».
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

    /// La liste de l'onglet « Plus » (iPhone) : des rangées système qui poussent
    /// les sections rangées sous « Plus » dans la pile de l'onglet.
    private var plusList: some View {
        List(IOSTabs.plusSections) { section in
            NavigationLink(value: section) {
                Label(section.title, systemImage: IOSSection.systemImage(of: section))
            }
            .accessibilityIdentifier("ios.plus." + section.rawValue)
        }
        .navigationTitle(IOSShellText.plusTitle)
    }

    private func select(_ section: ConsoleSection) {
        route = IOSTabs.route(from: currentRoute, to: section, compact: isCompact)
    }

    /// Le badge d'une section : ce qui attend l'humain sur l'Accueil, les audits à
    /// trier sur Audit.
    private func badge(for section: ConsoleSection) -> Int {
        guard let inbox = server.inbox else { return 0 }
        switch section {
        case .home: return inbox.pendingCount
        case .audit: return inbox.auditsProposed.count
        default: return 0
        }
    }
}
