import ConsoleCore
import Foundation
import SwiftUI

/// Le point d'entrée de l'app iOS. La section ouverte au démarrage est résolue
/// depuis les arguments de lancement (`-section <rawValue>`) : c'est ce qui
/// permet au script de captures d'ouvrir chacune des sept sections. Aucun
/// argument reconnu ⇒ l'Accueil.
///
/// La feuille de connexion ne s'ouvre D'ELLE-MÊME que si `-section` n'a pas été
/// fourni : les 14 captures de `scripts/ios-shots.sh` gardent ainsi leur écran,
/// sans feuille par-dessus.
@main
struct OMPConsoleIOSApp: App {
    private let initialSection = IOSSection.resolve(ProcessInfo.processInfo.arguments)
    private let requestedSection = ProcessInfo.processInfo.arguments.contains("-section")

    var body: some Scene {
        WindowGroup {
            RootView(selection: initialSection, autoPresentConnection: !requestedSection)
        }
    }
}
