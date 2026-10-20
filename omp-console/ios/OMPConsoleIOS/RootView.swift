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
/// Elle REÇOIT les deux clients de `OMPConsoleIOSApp` : le serveur de pipelines du
/// VPS (lu au lancement, son flux ouvert) et le client du Mac appairé (démarré ;
/// la feuille de connexion au Mac s'ouvre d'elle-même SEULEMENT quand l'appareil
/// n'a pas de jeton ou que le Mac l'a refusé, et qu'aucune section n'a été
/// demandée par `-section`). Le bouton antenne la rouvre à la demande. L'onglet
/// Accueil porte le badge de ce qui attend l'humain, l'onglet Audit celui des
/// audits à trier.
struct RootView: View {
    @State private var route: IOSTabRoute
    @State private var state: IOSScreenState
    @ObservedObject var client: ConsoleClientModel
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @State private var showConnection = false
    @Environment(\.horizontalSizeClass) private var sizeClass

    /// Le crochet de recette `-memoire.recipe`, quand il est donné.
    private let memoryRecipe: IOSMemoryGraphRecipe?
    /// Vrai quand `-section` n'a pas été fourni : les captures pilotées gardent
    /// ainsi leur écran, sans feuille par-dessus.
    private let autoPresentConnection: Bool

    init(
        client: ConsoleClientModel,
        server: HarnessModel,
        drafts: HarnessDrafts,
        selection: ConsoleSection = .home,
        state: IOSScreenState = .ready,
        memoryRecipe: IOSMemoryGraphRecipe? = nil,
        autoPresentConnection: Bool = true
    ) {
        self.client = client
        self.server = server
        self.drafts = drafts
        _route = State(initialValue: IOSTabRoute(tab: .section(selection), plusPath: []))
        _state = State(initialValue: state)
        self.memoryRecipe = memoryRecipe
        self.autoPresentConnection = autoPresentConnection
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
            .sheet(isPresented: $showConnection) {
                ConnectionSheet(model: client)
            }
            .sheet(isPresented: $drafts.serverSheetShown) {
                IOSServerSheet(server: server, drafts: drafts)
            }
            .task {
                await server.load()
                server.startLive()
            }
            .onAppear {
                client.start()
                presentConnectionIfNeeded()
            }
            .onChange(of: client.pairing) { _, _ in
                presentConnectionIfNeeded()
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

    /// L'écran d'une section, avec son bouton antenne : contenu de chaque onglet ET
    /// destination de « Plus », donc chaque écran porte le bouton exactement une fois.
    private func sectionScreen(_ section: ConsoleSection) -> some View {
        IOSSectionView(
            section: section,
            state: state,
            client: client,
            server: server,
            drafts: drafts,
            memoryRecipe: memoryRecipe,
            showConnection: $showConnection
        )
        .toolbar { connectionToolbarItem }
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
        .toolbar { connectionToolbarItem }
    }

    private func select(_ section: ConsoleSection) {
        route = IOSTabs.route(from: currentRoute, to: section, compact: isCompact)
    }

    /// Le bouton antenne (« Connexion » au Mac) : rouvre la feuille de connexion,
    /// sans condition.
    @ToolbarContentBuilder
    private var connectionToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showConnection = true
            } label: {
                Label(ConnectionText.title, systemImage: "antenna.radiowaves.left.and.right")
            }
            .accessibilityIdentifier(ConnectionAccessibility.open)
        }
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

    /// La feuille s'ouvre d'elle-même sans jeton ou sur un jeton refusé, jamais
    /// pendant la lecture du trousseau ni pour un appareil appairé (S-2).
    private func presentConnectionIfNeeded() {
        if autoPresentConnection,
           ConnectionSheetMode.autoPresents(client.pairing, deferred: false) {
            showConnection = true
        }
    }
}
