// Les crochets de RECETTE des feuilles de lancement (feuilles-ios-presentation-et-depots,
// S-7) : ils ouvrent d'eux-mêmes, UNE fois, la vraie feuille sur une fixture, sans
// réseau et sans écran fabriqué.
//
//   -projet.recipe lancement     : « Piloter un projet… » sur les dépôts de la fixture ;
//   -projet.recipe dialogue      : « OMP vous demande » sur le dialogue de la fixture ;
//   -sessionomp.recipe lancement : « Lancer une session OMP » sur les mêmes dépôts.
//
// Sans l'argument : aucun effet. Comme `IOSMemoryGraphRecipe` et `PipelinesCardRecipe`,
// la DERNIÈRE paire reconnue gagne ; une valeur inconnue est ignorée.
//
// Le fichier ne nomme aucun littéral alphabétique : les mots viennent
// d'`IOSLaunchRecipeText` et de `PipelinesText` (dépôts partagés avec « Nouvelle feature »).

import ConsoleClient
import ConsoleCore
import Foundation

/// La recette de l'écran Projet.
enum IOSProjectRecipe: Equatable {
    case lancement
    case dialogue

    /// La recette lue dans les arguments de lancement, ou aucune.
    static func resolve(_ arguments: [String]) -> IOSProjectRecipe? {
        IOSLaunchRecipe.lastValue(of: IOSLaunchRecipeText.projectFlag, in: arguments) { value in
            switch value {
            case IOSLaunchRecipeText.launch: return .lancement
            case IOSLaunchRecipeText.dialog: return .dialogue
            default: return nil
            }
        }
    }
}

/// La recette de l'écran Session OMP.
enum IOSSessionOmpRecipe: Equatable {
    case lancement

    /// La recette lue dans les arguments de lancement, ou aucune.
    static func resolve(_ arguments: [String]) -> IOSSessionOmpRecipe? {
        IOSLaunchRecipe.lastValue(of: IOSLaunchRecipeText.sessionOmpFlag, in: arguments) { value in
            value == IOSLaunchRecipeText.launch ? .lancement : nil
        }
    }
}

/// Les fixtures des feuilles de lancement.
enum IOSLaunchRecipe {
    /// Ce qu'une feuille de lancement reçoit À LA PLACE de `client.repos()` : la liste
    /// et le dépôt présélectionné.
    struct Fixture: Equatable {
        let repos: [RemoteRepoRow]
        let selectedKey: String
    }

    /// Les dépôts de la fixture : deux homonymes et un nom unique, la clé valant la
    /// racine. Le nom est celui du dossier, tel que la coque le sert.
    static let repos: [RemoteRepoRow] = PipelinesText.recipeRepos.map { root in
        RemoteRepoRow(
            repoKey: root,
            repoRoot: root,
            name: KanbanLaunchRepos.choices([root]).first?.label ?? root
        )
    }

    /// Le dépôt présélectionné : l'un des deux homonymes.
    static let selectedKey = PipelinesText.recipeChosenRepo

    static let fixture = Fixture(repos: repos, selectedKey: selectedKey)

    /// Le dialogue de la fixture, décodé par le même `Decodable` que le fil ; `nil` si
    /// le texte ne se décode pas (aucune feuille ne s'ouvre alors).
    static var dialog: RpcDialogRequest? {
        try? JSONDecoder().decode(RpcDialogRequest.self, from: Data(IOSLaunchRecipeText.dialogJSON.utf8))
    }

    /// La valeur de la DERNIÈRE paire `flag valeur` reconnue par `named`, ou aucune.
    static func lastValue<Recipe>(
        of flag: String,
        in arguments: [String],
        named: (String) -> Recipe?
    ) -> Recipe? {
        var resolved: Recipe?
        var index = 0
        while index < arguments.count {
            if arguments[index] == flag,
               index + 1 < arguments.count,
               let recipe = named(arguments[index + 1]) {
                resolved = recipe
            }
            index += 1
        }
        return resolved
    }
}
