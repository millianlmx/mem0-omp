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
/// L'App POSSÈDE les deux accès au serveur du VPS, posés par le MÊME code
/// d'appairage (feuille Serveur) : ses pipelines (`HarnessModel`), qui servent les
/// cinq sections de pilotage, et sa mémoire (`MemoryAccess`). Aucun Mac : l'app
/// fonctionne seule.
@main
struct OMPConsoleIOSApp: App {
    private let initialSection: ConsoleSection
    private let initialState: IOSScreenState
    private let memoryRecipe: IOSMemoryGraphRecipe?
    @StateObject private var memory: MemoryAccess
    @StateObject private var server: HarnessModel
    @StateObject private var drafts = HarnessDrafts()
    /// Les Live Activities des features suivies sur l'écran verrouillé.
    @StateObject private var activities = IOSLiveActivityCenter()

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        initialSection = IOSSection.resolve(arguments)
        initialState = IOSScreenState.resolve(arguments)
        memoryRecipe = IOSMemoryGraphRecipe.resolve(arguments)
        let memory = MemoryAccess.live()
        _memory = StateObject(wrappedValue: memory)
        // Le code d'appairage accepté porte aussi la mémoire du serveur. L'instance
        // est celle que résolvent les App Intents (`IOSSharedServer`).
        let server = IOSSharedServer.install(HarnessModel.live(onPaired: { pairing in
            Task { @MainActor in
                await memory.configure(address: pairing.memoryAddress, token: pairing.memoryToken)
            }
        }), in: .shared)
        _server = StateObject(wrappedValue: server)
    }

    var body: some Scene {
        WindowGroup {
            RootView(
                memory: memory,
                server: server,
                drafts: drafts,
                selection: initialSection,
                state: initialState,
                memoryRecipe: memoryRecipe
            )
            .environmentObject(activities)
            // Chaque boîte relue et chaque outil du direct suivi tiennent les Live Activities à jour.
            .onReceive(server.$inbox) { _ in activities.sync(with: server) }
            .onReceive(server.$session) { _ in activities.sync(with: server) }
        }
        .commands { IOSKeyboardCommands() }
    }
}
