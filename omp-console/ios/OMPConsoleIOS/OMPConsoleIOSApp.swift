import ConsoleCore
import Foundation
import SwiftUI

/// Le point d'entrée de l'app iOS. La section ouverte au démarrage est résolue
/// depuis les arguments de lancement (`-section <rawValue>`) : c'est ce qui
/// permet au script de captures d'ouvrir chacune des sept sections. Aucun
/// argument reconnu ⇒ l'Accueil.
@main
struct OMPConsoleIOSApp: App {
    private let initialSection = IOSSection.resolve(ProcessInfo.processInfo.arguments)

    var body: some Scene {
        WindowGroup {
            RootView(selection: initialSection)
        }
    }
}
