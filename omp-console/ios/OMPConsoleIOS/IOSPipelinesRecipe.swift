// Le crochet de RECETTE `-pipelines.recipe <vide|choisi|rempli>` : il ouvre l'écran
// Pipelines sur la feuille « Nouvelle feature » dans un état FORCÉ, pour capturer la
// feuille sans appairage ni dépôt réel — un crochet de recette, pas une
// fonctionnalité.
//
// Sans l'argument : aucun effet. Comme `IOSSection.resolve` et `IOSHomeRecipe`, la
// DERNIÈRE paire reconnue gagne ; une valeur inconnue est ignorée.
//
// Seules les DONNÉES sont forcées (dépôts proposés, dépôt choisi, titre, besoin) :
// la feuille, le calcul des libellés et la règle d'activation de « Lancer » sont
// le chemin RÉEL. Les littéraux vivent dans `PipelinesText`.

import Foundation

/// Le crochet lu dans les arguments de lancement.
enum IOSPipelinesRecipe: String, Equatable {
    /// Aucun dépôt choisi, titre et besoin vides : l'invite et « Lancer » inactif.
    case vide
    /// Un dépôt choisi, un titre et un besoin court.
    case choisi
    /// Comme `choisi`, avec un besoin de douze lignes (la zone défile à huit).
    case rempli

    /// La recette lue dans les arguments de lancement, ou aucune.
    static func resolve(_ arguments: [String]) -> IOSPipelinesRecipe? {
        var resolved: IOSPipelinesRecipe?
        var index = 0
        while index < arguments.count {
            if arguments[index] == PipelinesText.recipeFlag,
               index + 1 < arguments.count,
               let recipe = IOSPipelinesRecipe(rawValue: arguments[index + 1]) {
                resolved = recipe
            }
            index += 1
        }
        return resolved
    }

    /// Les dépôts proposés par la recette (triés), à la place de ceux de l'ardoise.
    var repos: [String] { PipelinesText.recipeRepos }

    /// La racine choisie : aucune pour `vide`.
    var repo: String {
        switch self {
        case .vide: return ""
        case .choisi, .rempli: return PipelinesText.recipeChosenRepo
        }
    }

    var title: String {
        switch self {
        case .vide: return ""
        case .choisi, .rempli: return PipelinesText.recipeFeatureTitle
        }
    }

    var need: String {
        switch self {
        case .vide: return ""
        case .choisi: return PipelinesText.recipeShortNeed
        case .rempli: return PipelinesText.recipeLongNeed
        }
    }
}
