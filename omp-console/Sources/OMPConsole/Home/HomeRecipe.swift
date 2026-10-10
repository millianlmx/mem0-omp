// Le crochet de RECETTE macOS `-home.recipe <dashboard|menuBar|pausedOnly>`
// (S-8 de accueil-en-cours-melange-pause-et-compte) : il pose l'ardoise de la
// fixture partagée `HomeParity` dans `KanbanModel` (l'Accueil) et dans
// `AlertsModel` (l'item de barre de menus), pour que les captures et la lecture
// AX montrent un chemin de code RÉEL — jamais un écran fabriqué.
//
// Actif SEULEMENT quand `OMP_CONSOLE_SUPPORT_ROOT` est posée et non vide : une
// recette ne tourne jamais sur la racine réelle de l'utilisateur. L'argument de
// lancement `-home.recipe <valeur>` remplit la clé `home.recipe` des
// préférences ; une valeur inconnue est ignorée. Ce n'est pas une
// fonctionnalité, comme `-home.recipe` sur iOS (`IOSHomeRecipe`).

import ConsoleCore
import Foundation

enum HomeRecipe: String, CaseIterable {
    /// La fixture entière : 5 « À vous », 2 « En cours », 1 « À reprendre »,
    /// 1 « Pas commencées », 2 livraisons.
    case dashboard
    /// Une attente et deux « En cours » : comptes (1, 2).
    case menuBar
    /// Seulement une pause et une feature pas commencée : comptes (0, 0).
    case pausedOnly

    /// La clé des préférences remplie par l'argument `-home.recipe`.
    static let defaultsKey = "home.recipe"

    /// La recette demandée, ou aucune : sans racine de support déplacée, la
    /// recette n'est jamais active.
    static func current(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> HomeRecipe? {
        guard let root = environment[AppPaths.supportRootEnvironmentKey], !root.isEmpty,
              let value = defaults.string(forKey: defaultsKey) else { return nil }
        return HomeRecipe(rawValue: value)
    }

    /// L'ardoise posée par la recette.
    var board: KanbanBoardState {
        switch self {
        case .dashboard: HomeParity.board
        case .menuBar: HomeParity.menuBarBoard
        case .pausedOnly: HomeParity.pausedOnlyBoard
        }
    }
}
