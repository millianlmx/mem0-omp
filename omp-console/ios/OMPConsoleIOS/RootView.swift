import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

/// La racine UNIQUE de l'app iOS. Elle rend la coque (`IOSOSRootView`) et pose ICI, une
/// fois pour toute l'app, les feuilles, les confirmations des gestes, la palette, les liens
/// et les notifications. Une demande venue du dehors (palette, notification, lien, vue
/// partagée) mène à son onglet, à son fil, à la Mémoire ou à une page du Système
/// (`IOSOSRouting`).
///
/// Elle REÇOIT les deux accès de `OMPConsoleIOSApp`, tous deux au serveur du VPS et posés
/// par le même code d'appairage : ses pipelines (lus au lancement, flux ouvert) et sa
/// mémoire. Aucun Mac.
struct RootView: View {
    @ObservedObject var memory: MemoryAccess
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    /// Les notifications : un toucher ouvre l'écran ou le fil qu'elles désignent.
    @ObservedObject var notifications: HarnessNotificationCenter
    /// L'onglet et les piles de la coque.
    @State private var navigation: IOSOSNavigation
    @Environment(\.scenePhase) private var scenePhase

    /// Ce que les arguments de lancement demandent d'ouvrir.
    private let launch: IOSShellLaunch
    /// Le crochet de recette `-ios.state` de l'écran Mémoire.
    private let state: IOSScreenState
    /// Le crochet de recette `-memoire.recipe`, quand il est donné.
    private let memoryRecipe: IOSMemoryGraphRecipe?

    init(
        memory: MemoryAccess,
        server: HarnessModel,
        drafts: HarnessDrafts,
        notifications: HarnessNotificationCenter,
        launch: IOSShellLaunch,
        state: IOSScreenState = .ready,
        memoryRecipe: IOSMemoryGraphRecipe? = nil
    ) {
        self.memory = memory
        self.server = server
        self.drafts = drafts
        self.notifications = notifications
        self.launch = launch
        _navigation = State(initialValue: launch.initialNavigation)
        self.state = state
        self.memoryRecipe = memoryRecipe
    }

    var body: some View {
        IOSOSRootView(
            memory: memory, server: server, drafts: drafts, navigation: $navigation,
            launch: launch, state: state, memoryRecipe: memoryRecipe
        )
        // Un lien `ompconsole://` (widget, Live Activity, raccourci) : une section, le fil
        // d'une feature (`threads/<id>`), le tri (`decisions`), « Maintenant » (`now`) ou une
        // page du Système (`system/<page>`). Le lien d'un QR code d'appairage (`pair`) ne
        // relie rien tout seul : il ouvre la confirmation, qui nomme le serveur.
        .onOpenURL { url in
            if HarnessPairLink.isPairLink(url) {
                askToPair(url)
                return
            }
            guard let destination = HarnessWidgetLink.destination(of: url) else { return }
            show(IOSOSRouting.destination(of: destination))
        }
        .sheet(isPresented: $drafts.serverSheetShown) {
            IOSServerSheet(server: server, drafts: drafts)
        }
        .pairLinkConfirmation(server: server, drafts: drafts)
        // La palette ⌘K et les feuilles de création (feature ⌘N, projet, audit,
        // planification), partagées avec le Mac (ConsoleUI).
        .consolePalette(server: server, drafts: drafts, sections: ConsoleSection.allCases, memory: true, select: selector)
        .consoleNotificationRoutes(notifications, server: server, drafts: drafts, select: selector)
        .focusedSceneValue(\.iosPalette, IOSPaletteAction(drafts: drafts, isEnabled: server.isConfigured))
        // Les feuilles et confirmations des gestes (refus, consigne, budget, relance,
        // arrêt, direct d'un audit ou d'un job du poste, approbations du poste,
        // planifications, clients), une fois pour toute l'app.
        .harnessGestures(server: server, drafts: drafts)
        .workstationGestures(workstation: server.workstation, drafts: drafts)
        .controlGestures(server: server, drafts: drafts)
        // Le socle des écrans partagés : le rendu Markdown, le direct d'une session, la Live
        // Activity d'une feature, propres à l'iPhone/iPad, et le routage d'une section.
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
        // L'état du poste, les propositions de Jira, les demandes et le
        // battement de la vigie, relus à chaque serveur relié ; le flux de la boîte les tient
        // ensuite à jour.
        .task(id: server.address) {
            await server.workstation.refresh()
            await server.atlassian.refresh()
            await server.intakes.refresh()
            await server.vigie.refresh()
        }
        // Au retour au premier plan, le flux coupé en arrière-plan est rouvert sur une
        // boîte fraîche : ce qui a changé pendant l'absence se voit tout de suite.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            server.stopLive()
            Task {
                await server.refresh()
                server.startLive()
                await server.workstation.refresh()
                await server.atlassian.refresh()
                await server.intakes.refresh()
            }
        }
    }

    /// Le lien d'un QR code d'appairage : la confirmation, serveur nommé (l'échange n'a lieu qu'après
    /// « Appairer ») ; un lien incomplet ou forgé dit qu'il est illisible au lieu de se taire. Une feuille
    /// déjà ouverte ne cache pas la confirmation.
    private func askToPair(_ url: URL) {
        drafts.serverSheetShown = false
        drafts.pairOutcome = nil
        guard let link = HarnessPairLink(url: url) else {
            drafts.pairOutcome = .failed(.invalidLink)
            return
        }
        drafts.pairRequest = link
    }

    /// Montre une destination (lien, palette, notification, vue partagée).
    private func show(_ destination: IOSOSDestination) {
        Self.show(destination, navigation: $navigation, drafts: drafts)
    }

    /// Montrer une section (palette, notification, lien d'une vue partagée) : son onglet, le
    /// fil de la feature à ouvrir (`drafts.openedRun`, que la coque ouvre), la Mémoire dans le
    /// Savoir, ou le Système — la page posée dans `drafts.systemPage`, sinon son hub.
    private var selector: @MainActor @Sendable (ConsoleSection) -> Void {
        let navigation = $navigation
        return { [drafts] section in
            let page = drafts.systemPage
            drafts.systemPage = nil
            let destination = IOSOSRouting.destination(of: section, openedRun: drafts.openedRun, page: section == .system ? page : nil)
            Self.show(destination, navigation: navigation, drafts: drafts)
        }
    }

    @MainActor
    private static func show(_ destination: IOSOSDestination, navigation: Binding<IOSOSNavigation>, drafts: HarnessDrafts) {
        switch destination {
        case let .tab(tab):
            navigation.wrappedValue.show(tab)
        case let .run(runId):
            navigation.wrappedValue.show(.threads)
            drafts.openedRun = runId
        case .memory:
            navigation.wrappedValue.show(.memory, in: .knowledge)
        case .system:
            navigation.wrappedValue.showSystem()
        case .systemPage(.server):
            drafts.serverSheetShown = true
        case let .systemPage(page):
            navigation.wrappedValue.showSystem(page)
        }
    }
}
