// Le crochet de RECETTE `-pipelines.recipe <fiche|actions|arret>` (ios-fiche-carte-pipelines) :
// il ouvre, UNE fois, la fiche d'une carte de fixture sur l'écran Pipelines, sans
// réseau et sans écran fabriqué — la vraie `PipelinesCardSheet` est rendue, sur la
// carte dérivée de la fixture partagée `HomeParity` par la même dérivation que
// l'Accueil de recette.
//
//   fiche   : la fiche en haut ;
//   actions : la fiche défilée jusqu'à la liste des gestes ;
//   arret   : comme `actions`, puis la confirmation d'arrêt ouverte.
//
// Sans l'argument : aucun effet. Comme `IOSSection.resolve` et `IOSMemoryGraphRecipe`,
// la DERNIÈRE paire reconnue gagne ; une valeur inconnue est ignorée.
//
// Le fichier ne nomme AUCUN type du magasin (jeton interdit des sources de l'app) et
// aucun littéral alphabétique : les mots viennent de `PipelinesText`.

import ConsoleClient
import ConsoleCore
import Foundation

enum PipelinesCardRecipe: Equatable {
    case fiche
    case actions
    case arret

    /// La recette lue dans les arguments de lancement, ou aucune.
    static func resolve(_ arguments: [String]) -> PipelinesCardRecipe? {
        var resolved: PipelinesCardRecipe?
        var index = 0
        while index < arguments.count {
            if arguments[index] == PipelinesText.recipeFlag,
               index + 1 < arguments.count,
               let recipe = named(arguments[index + 1]) {
                resolved = recipe
            }
            index += 1
        }
        return resolved
    }

    /// Les valeurs reconnues, lues dans le vocabulaire de l'app (aucun littéral ici).
    private static func named(_ value: String) -> PipelinesCardRecipe? {
        switch value {
        case PipelinesText.recipeFiche: return .fiche
        case PipelinesText.recipeActions: return .actions
        case PipelinesText.recipeArret: return .arret
        default: return nil
        }
    }

    /// Faut-il défiler jusqu'à la liste des gestes ?
    var scrollsToActions: Bool { self != .fiche }

    /// La carte de fixture : la première de l'ardoise dérivée de `HomeParity` qui offre
    /// « Reprendre » ET « Arrêter… », avec le titre long et les deux modèles de recette.
    /// `nil` quand aucune carte ne qualifie : aucune fiche ne s'ouvre, aucun signal.
    var card: KanbanCard? { Self.fixtureCard }

    /// Le catalogue de recette : seul le premier modèle y figure, le second reste brut.
    var modelNames: [String: String] {
        [PipelinesText.recipeModelKnown: PipelinesText.recipeModelKnownName]
    }

    /// Le signal de PRÊT sur la sortie d'erreur du lancement (`--stderr`), lu par les scripts
    /// de captures : il n'est émis que si l'état forcé est réellement demandé à la fiche.
    func announce() {
        FileHandle.standardError.write(Data(PipelinesText.recipeReady.utf8))
    }

    /// L'ardoise de la fixture, horloge fixe (même dérivation que `IOSHomeRecipe`).
    private static let board: KanbanBoardState = KanbanBoardState.derive(
        snapshot: HomeParity.snapshot,
        nowMs: 1_700_000_000_000,
        stateDir: "",
        isAlive: .transported(HomeParity.snapshot),
        prFacts: [:]
    )

    private static var fixtureCard: KanbanCard? {
        guard let candidate = board.kanbanBoard?.cards.first(where: { card in
            let gestures = PipelinesGesture.gestures(of: card)
            return gestures.contains(.resume) && gestures.contains(.stop)
        }) else { return nil }
        var card = candidate
        card.title = PipelinesText.recipeTitle
        card.models = ModelSlots(
            reqSpecs: PipelinesText.recipeModelKnown,
            implReview: PipelinesText.recipeModelUnknown
        )
        return card
    }
}
