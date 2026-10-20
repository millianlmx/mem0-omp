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
/// La feuille de connexion au Mac ne s'ouvre D'ELLE-MÊME que si `-section` n'a pas
/// été fourni : les captures gardent ainsi leur écran, sans feuille par-dessus.
///
/// L'App POSSÈDE les deux clients : celui du Mac appairé (`ConsoleClientModel.live()`,
/// créé une fois par processus dans `init()`, y compris lors d'un lancement à froid
/// par Siri), enregistré pour les App Intents (`IOSSharedClient`), qui sert la
/// mémoire du projet ; et celui du serveur de pipelines du VPS (`HarnessModel`),
/// qui sert les cinq sections de pilotage.
@main
struct OMPConsoleIOSApp: App {
    private let initialSection: ConsoleSection
    private let initialState: IOSScreenState
    private let memoryRecipe: IOSMemoryGraphRecipe?
    private let requestedSection: Bool
    /// Le client du Mac, jamais en `@StateObject` : son autoclosure paresseuse
    /// pourrait construire une autre instance que celle enregistrée.
    private let client: ConsoleClientModel
    @StateObject private var server = HarnessModel.live()
    @StateObject private var drafts = HarnessDrafts()

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        initialSection = IOSSection.resolve(arguments)
        initialState = IOSScreenState.resolve(arguments)
        memoryRecipe = IOSMemoryGraphRecipe.resolve(arguments)
        requestedSection = arguments.contains("-section")
        client = IOSSharedClient.install(ConsoleClientModel.live(), in: .shared)
    }

    var body: some Scene {
        WindowGroup {
            RootView(
                client: client,
                server: server,
                drafts: drafts,
                selection: initialSection,
                state: initialState,
                memoryRecipe: memoryRecipe,
                autoPresentConnection: !requestedSection
            )
        }
        .commands { IOSKeyboardCommands() }
    }
}
