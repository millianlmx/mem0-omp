import ConsoleClient
import ConsoleCore
import Foundation
import SwiftUI

/// Le point d'entrée de l'app iOS. Trois crochets de recette sont lus dans les
/// arguments de lancement :
///
/// - `-section <rawValue>` : la section ouverte au démarrage (script de captures) ;
/// - `-ios.state <ready|error>` : l'état d'écran, pour capturer le bandeau
///   d'erreur par un chemin RÉEL (S-3) — un crochet de recette, pas une
///   fonctionnalité ;
/// - `-memoire.recipe <…>` : l'état du graphe de la mémoire (`IOSMemoryGraphRecipe`).
///
/// Ces trois crochets ouvrent toujours l'interface classique. Sans eux, l'app s'ouvre sur
/// la nouvelle interface (`IOSOSRootView`), sauf si l'interface classique a été choisie
/// (`IOSInterface`) ; `-os.view`, `-os.thread` et `-os.space` y ouvrent un écran précis, et
/// `-os.server` / `-os.token` relient un serveur de recette quand l'app n'en a enregistré
/// aucun (`IOSShellLaunch`, `IOSRecipeServer`).
///
/// L'App POSSÈDE les deux accès au serveur du VPS, posés par le MÊME code
/// d'appairage (feuille Serveur) : ses pipelines (`HarnessModel`), qui servent les
/// cinq sections de pilotage, et sa mémoire (`MemoryAccess`). Aucun Mac : l'app
/// fonctionne seule.
///
/// Les notifications sont posées dès `init` (une action touchée app fermée relance
/// l'app en arrière-plan) : catégories et gestes (`HarnessNotificationCenter`), jeton
/// APNs rendu au délégué d'application (`IOSAppDelegate`) puis enregistré au serveur.
/// Les Live Activities aussi (`IOSLiveActivityCenter.attach`) : jeton push-to-start
/// enregistré au serveur, activités démarrées par le serveur adoptées.
@main
struct OMPConsoleIOSApp: App {
    private let initialSection: ConsoleSection
    private let initialState: IOSScreenState
    private let memoryRecipe: IOSMemoryGraphRecipe?
    /// Le serveur de recette donné par les arguments de lancement (`-os.server`), ou `nil`.
    private let recipeServer: (address: String, token: String)?
    @StateObject private var memory: MemoryAccess
    @StateObject private var server: HarnessModel
    @StateObject private var drafts = HarnessDrafts()
    /// L'interface montrée : la nouvelle (le défaut) ou la classique.
    @StateObject private var interface: IOSInterface
    /// Les Live Activities des features suivies sur l'écran verrouillé.
    @StateObject private var activities: IOSLiveActivityCenter
    /// Le widget d'écran d'accueil, nourri par le groupe d'apps.
    @StateObject private var widgets = IOSWidgetBridge()
    /// Les catégories de notification et la réponse à leurs actions.
    @StateObject private var notifications: HarnessNotificationCenter
    /// Le jeton APNs de l'appareil.
    @UIApplicationDelegateAdaptor(IOSAppDelegate.self) private var appDelegate

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        initialSection = IOSSection.resolve(arguments)
        initialState = IOSScreenState.resolve(arguments)
        memoryRecipe = IOSMemoryGraphRecipe.resolve(arguments)
        _interface = StateObject(wrappedValue: IOSInterface(arguments: arguments))
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
                interface: interface,
                selection: initialSection,
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
            .onReceive(server.$session) { _ in activities.sync(with: server) }
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
        .commands { IOSKeyboardCommands() }
    }
}
