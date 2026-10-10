// Le crochet de RECETTE `-pipelines.board pleine` : l'écran Pipelines rend
// l'ardoise de la fixture partagée `KanbanBoardParity` (ConsoleCore) à la place de
// celle dérivée du client, pour mesurer les voies et les cartes sans appairage —
// un crochet de recette, pas une fonctionnalité (feature
// pipelines-ipad-voies-sans-largeur, S-8).
//
// Seule la DONNÉE est forcée : voies, en-têtes, cartes et feuilles sont le chemin
// RÉEL de l'écran ; le bandeau de connexion n'est pas affiché. Le drapeau est
// DISTINCT de `-pipelines.recipe` (feuille « Nouvelle feature ») : les deux
// crochets peuvent être passés ensemble.
//
// Sans l'argument : aucun effet. Comme `IOSPipelinesRecipe`, la DERNIÈRE paire
// reconnue gagne ; une valeur inconnue est ignorée. Les littéraux vivent dans
// `PipelinesText`.

import ConsoleCore
import Foundation

/// Le crochet lu dans les arguments de lancement.
enum IOSPipelinesBoardRecipe: String, Equatable {
    /// L'ardoise pleine de `KanbanBoardParity` : une voie vide, une voie
    /// « Livrées » de 100 cartes, des noms longs.
    case pleine

    /// La recette lue dans les arguments de lancement, ou aucune.
    static func resolve(_ arguments: [String]) -> IOSPipelinesBoardRecipe? {
        var resolved: IOSPipelinesBoardRecipe?
        var index = 0
        while index < arguments.count {
            if arguments[index] == PipelinesText.boardRecipeFlag,
               index + 1 < arguments.count,
               let recipe = IOSPipelinesBoardRecipe(rawValue: arguments[index + 1]) {
                resolved = recipe
            }
            index += 1
        }
        return resolved
    }

    /// L'état d'écran forcé : l'ardoise de la fixture, comme si le Mac l'avait
    /// servie.
    var screenState: PipelinesScreenState {
        switch self {
        case .pleine: return .board(.board(KanbanBoardParity.board))
        }
    }

    /// Le signal de PRÊT sur la sortie d'erreur du lancement (`--stderr`), lu par
    /// `scripts/ios-pipelines-voies-recette.sh` avant la capture.
    func announce() {
        FileHandle.standardError.write(Data(PipelinesText.boardRecipeReady.utf8))
    }
}
