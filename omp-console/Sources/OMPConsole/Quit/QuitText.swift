// TOUS les textes du Quitter de l'app (mac-quitter-sans-confirmation, S-3) : un
// seul endroit à corriger, et des fonctions pures donc testables sans UI.
//
// Chaque ligne du message dit l'effet VRAI de la sortie : la Session OMP et la
// commande du Terminal s'arrêtent ; le pilotage et les pipelines continuent dans
// OMP (arbitrage 2 du contrat). Guillemets « » avec une espace ordinaire, comme
// `KanbanText` et `ProjectViewText` ; le nom est inséré tel quel, sans troncature.

import Foundation

enum QuitText {
    // MARK: - Menu et boutons

    static let menuItem = "Quitter OMP Console"
    static let quitButton = "Quitter"
    static let cancelButton = "Annuler"

    // MARK: - Alerte

    static let title = "Quitter arrêtera des activités en cours."

    static func sessionStops(name: String?) -> String {
        guard let name else { return "La session OMP s’arrêtera." }
        return "La session OMP de « \(name) » s’arrêtera."
    }

    static func terminalStops(command: String?) -> String {
        guard let command else { return "La commande en cours dans le Terminal s’arrêtera." }
        return "La commande « \(command) » du Terminal s’arrêtera."
    }

    static func pilotageContinues(name: String?) -> String {
        let suffix = "continue dans OMP : vous le retrouverez en pilotant de nouveau ce projet."
        guard let name else { return "Le pilotage en cours \(suffix)" }
        return "Le pilotage de « \(name) » \(suffix)"
    }

    static func pipelinesContinue(count: Int) -> String {
        count == 1
            ? "1 pipeline en cours continue dans OMP."
            : "\(count) pipelines en cours continuent dans OMP."
    }
}
