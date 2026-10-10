// Les crochets de RECETTE `-pipelines.board pleine|marques` : l'écran Pipelines
// rend une ardoise de fixture à la place de celle dérivée du client, pour mesurer
// les voies et les cartes sans appairage — un crochet de recette, pas une
// fonctionnalité (features pipelines-ipad-voies-sans-largeur, S-8, et
// jargon-technique-expose-mac-et-ios, S-4).
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

    /// L'ardoise DÉRIVÉE de `HomeParity` (même dérivation que
    /// `PipelinesCardRecipe`) : elle porte la carte du lot mort `beta`, pour
    /// voir la phrase qui remplace les marques brutes.
    case marques

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
        case .marques: return .board(Self.derivedBoard)
        }
    }

    /// L'ardoise de `HomeParity`, horloge fixe (même appel que `PipelinesCardRecipe`).
    static let derivedBoard: KanbanBoardState = KanbanBoardState.derive(
        snapshot: HomeParity.snapshot,
        nowMs: 1_700_000_000_000,
        stateDir: "",
        isAlive: .transported(HomeParity.snapshot),
        prFacts: [:]
    )

    /// Le signal de PRÊT sur la sortie d'erreur du lancement (`--stderr`), lu par
    /// `scripts/ios-pipelines-voies-recette.sh` avant la capture.
    func announce() {
        FileHandle.standardError.write(Data(PipelinesText.boardRecipeReady.utf8))
    }
}
