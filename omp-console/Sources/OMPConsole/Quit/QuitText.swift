// TOUS les textes du Quitter de l'app (mac-quitter-sans-confirmation, S-3) : un
// seul endroit à corriger, et des fonctions pures donc testables sans UI.
//
// Le message dit l'effet VRAI de la sortie : la commande du Terminal s'arrête.
// Guillemets « » avec une espace ordinaire ; le nom est inséré tel quel, sans
// troncature.

import Foundation

enum QuitText {
    // MARK: - Menu et boutons

    static let menuItem = "Quitter OMP Console"
    static let quitButton = "Quitter"
    static let cancelButton = "Annuler"

    // MARK: - Alerte

    static let title = "Quitter arrêtera des activités en cours."

    static func terminalStops(command: String?) -> String {
        guard let command else { return "La commande en cours dans le Terminal s’arrêtera." }
        return "La commande « \(command) » du Terminal s’arrêtera."
    }

}
