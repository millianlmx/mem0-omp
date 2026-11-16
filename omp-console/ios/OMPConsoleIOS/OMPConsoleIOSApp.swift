import ConsoleClient
import ConsoleCore
import Foundation
import SwiftUI

/// Le point d'entrée de l'app iOS. Les crochets de recette sont lus dans les arguments de
/// lancement (`IOSShellLaunch`) : `-os.view`, `-os.thread`, `-os.space` et `-os.system`
/// ouvrent un écran précis ; `-ios.state <ready|error>` (l'état d'écran, pour capturer le
/// bandeau d'erreur par un chemin RÉEL) et `-memoire.recipe <…>` (l'état du graphe,
/// `IOSMemoryGraphRecipe`) ouvrent la Mémoire ; `-os.server` / `-os.token` relient un
/// serveur de recette quand l'app n'en a enregistré aucun (`IOSRecipeServer`).
///
/// L'App POSSÈDE les deux accès au serveur du VPS, posés par le MÊME code
/// d'appairage (feuille Serveur) : ses pipelines (`HarnessModel`) et sa mémoire
/// (`MemoryAccess`). Aucun Mac : l'app fonctionne seule.
///
/// Les notifications sont posées dès `init` (une action touchée app fermée relance
/// l'app en arrière-plan) : catégories et gestes (`HarnessNotificationCenter`), jeton
/// APNs rendu au délégué d'application (`IOSAppDelegate`) puis enregistré au serveur.
/// Les Live Activities aussi (`IOSLiveActivityCenter.attach`) : jeton push-to-start
/// enregistré au serveur, activités démarrées par le serveur adoptées.
@main
struct OMPConsoleIOSApp: App {
    private let launch: IOSShellLaunch
    private let initialState: IOSScreenState
    private let memoryRecipe: IOSMemoryGraphRecipe?
    /// Le serveur de recette donné par les arguments de lancement (`-os.server`), ou `nil`.
    private let recipeServer: (address: String, token: String)?
    @StateObject private var memory: MemoryAccess
    @StateObject private var server: HarnessModel
    @StateObject private var drafts = HarnessDrafts()
    /// Les Live Activities des features suivies sur l'écran verrouillé.
    @StateObject private var activities: IOSLiveActivityCenter
    /// Le widget d'écran d'accueil, nourri par le groupe d'apps.
    @StateObject private var widgets = IOSWidgetBridge()
    /// Les catégories de notification et la réponse à leurs actions.
    @StateObject private var notifications: HarnessNotificationCenter
    /// Le jeton APNs de l'appareil.
    @UIApplicationDelegateAdaptor(IOSAppDelegate.self) private var appDelegate

    @Environment(\.scenePhase) private var scenePhase
    /// Le retour d'arrière-plan : relit, rouvre les flux une fois (`HarnessAppLifecycle`).
    @State private var lifecycle = HarnessAppLifecycle()

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        launch = IOSShellLaunch.resolve(arguments)
        initialState = IOSScreenState.resolve(arguments)
        memoryRecipe = IOSMemoryGraphRecipe.resolve(arguments)
        let memory = MemoryAccess.live()
        _memory = StateObject(wrappedValue: memory)
        // Le code d'appairage accepté porte aussi la mémoire du serveur. L'instance
        // est celle que résolvent les App Intents (`IOSSharedServer`).
        let recipeServer = IOSRecipeServer.resolve(arguments)
        self.recipeServer = recipeServer
        let server = IOSSharedServer.install(HarnessModel.live(fallback: { recipeServer }, onPaired: { pairing in
            Task { @MainActor in
                await memory.configure(address: pairing.memoryAddress, token: pairing.memoryToken)
            }
        }), in: .shared)
        _server = StateObject(wrappedValue: server)
        let notifications = HarnessNotificationCenter()
        notifications.attach(server)
        _notifications = StateObject(wrappedValue: notifications)
        // Le jeton push-to-start et les activités démarrées par le serveur s'écoutent dès
        // le lancement, même en arrière-plan.
        let activities = IOSLiveActivityCenter()
        activities.attach(server)
        _activities = StateObject(wrappedValue: activities)
    }

    var body: some Scene {
        WindowGroup {
            RootView(
                memory: memory,
                server: server,
                drafts: drafts,
                notifications: notifications,
                launch: launch,
                state: initialState,
                memoryRecipe: memoryRecipe
            )
            .environmentObject(activities)
            // Chaque boîte relue et chaque outil du direct suivi tiennent les Live Activities
            // et le widget d'écran d'accueil à jour ; un serveur relié ou oublié aussi.
            .onReceive(server.$inbox) { _ in
                activities.sync(with: server)
                widgets.sync(with: server)
            }
            .onReceive(server.$address) { _ in widgets.sync(with: server) }
            // Le direct publie avant de changer : son outil courant se lit au tour suivant, et
            // seul un outil qui change touche les Live Activities.
            .onReceive(
                server.direct.objectWillChange
                    .receive(on: RunLoop.main)
                    .map { [server] _ in server.session?.current?.tool }
                    .removeDuplicates()
            ) { _ in activities.sync(with: server) }
            // Après l'appairage : la permission de notifier, puis le jeton de l'appareil,
            // enregistré au serveur relié (et à chaque nouveau jeton que rend le système).
            .task(id: server.address) {
                widgets.sync(with: server)
                await activities.serverChanged(server)
                // Sur un serveur de recette, l'invite du système ne doit pas couvrir les captures.
                if server.isConfigured, recipeServer == nil { await IOSPush.enable(notifications) }
            }
            .onReceive(appDelegate.$deviceToken) { token in
                guard let token else { return }
                Task { await server.registerDevice(token: token, environment: .current) }
            }
            // Le jeton approbateur ou non : approuver un envoi du poste agit, ou ouvre l'app.
            .onReceive(server.$client) { _ in notifications.refreshCategories() }
        }
        // La phase AGRÉGÉE de l'app (active si une fenêtre l'est) pilote les flux et lectures partagés ;
        // posée sur la scène, elle part une fois, pas une fois par fenêtre. Le pouls suit sa fenêtre
        // (`IOSOSRootView`).
        .onChange(of: scenePhase) { _, phase in
            lifecycle.phaseChanged(to: HarnessAppPhase(phase), harness: server)
        }
        .commands { IOSKeyboardCommands() }
    }
}

extension HarnessAppPhase {
    /// La phase de SwiftUI, traduite pour `ConsoleClient` (qui n'importe pas SwiftUI) ; tout ce qui
    /// n'est ni actif ni en arrière-plan, `@unknown default` compris, vaut inactif : il ne relit rien.
    init(_ phase: ScenePhase) {
        switch phase {
        case .active: self = .active
        case .background: self = .background
        default: self = .inactive
        }
    }
}
