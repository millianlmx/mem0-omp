// TOUS les textes du Quitter de l'app (mac-quitter-sans-confirmation, S-3) : un
// seul endroit à corriger, et des fonctions pures donc testables sans UI.
//
// Le message dit l'effet VRAI de la sortie : la commande du Terminal s'arrête.
// Guillemets « » avec une espace ordinaire ; le nom est inséré tel quel, sans
// troncature.

import ConsoleCore
import Foundation

enum QuitText {
    // MARK: - Menu et boutons

    static let menuItem = L10n.text("Quitter OMP Console")
    static let quitButton = L10n.text("Quitter")
    static let cancelButton = L10n.text("Annuler")

    // MARK: - Alerte

    static let title = L10n.text("Quitter arrêtera des activités en cours.")

    static func terminalStops(command: String?) -> String {
        guard let command else { return L10n.text("La commande en cours dans le Terminal s’arrêtera.") }
        return L10n.format("La commande « %@ » du Terminal s’arrêtera.", command)
    }

}
