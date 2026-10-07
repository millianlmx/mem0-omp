import ConsoleCore
import Foundation
import SwiftUI

/// Le point d'entrée de l'app iOS. Deux crochets de recette sont lus dans les
/// arguments de lancement :
///
/// - `-section <rawValue>` : la section ouverte au démarrage (script de captures) ;
/// - `-ios.state <ready|error>` : l'état d'écran, pour capturer le bandeau
///   d'erreur par un chemin RÉEL (S-3) — un crochet de recette, pas une
///   fonctionnalité.
///
/// La feuille de connexion ne s'ouvre D'ELLE-MÊME que si `-section` n'a pas été
/// fourni : les captures de `scripts/ios-shots.sh` gardent ainsi leur écran,
/// sans feuille par-dessus.
///
/// Aucun argument reconnu ⇒ l'Accueil et l'état `ready`.
@main
struct OMPConsoleIOSApp: App {
    private let initialSection: ConsoleSection
    private let initialState: IOSScreenState
    private let requestedSection: Bool

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        initialSection = IOSSection.resolve(arguments)
        initialState = IOSScreenState.resolve(arguments)
        requestedSection = arguments.contains("-section")
    }

    var body: some Scene {
        WindowGroup {
            RootView(
                selection: initialSection,
                state: initialState,
                autoPresentConnection: !requestedSection
            )
        }
    }
}
