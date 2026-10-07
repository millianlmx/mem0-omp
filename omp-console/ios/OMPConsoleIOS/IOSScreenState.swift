import ConsoleCore

/// L'état d'écran de la coque iOS (S-3, BR-3), lu sur l'argument de lancement
/// `-ios.state <ready|error>`.
///
/// Le crochet `-ios.state error` est un CROCHET DE RECETTE, pas une
/// fonctionnalité : il n'existe que pour prouver, capture à l'appui, que le
/// bandeau d'erreur s'affiche par un chemin de code réel (AC-4). Même famille et
/// même tolérance que `IOSSection.resolve` : la DERNIÈRE paire reconnue gagne,
/// et une valeur absente, vide ou inconnue vaut `ready` — jamais une erreur.
enum IOSScreenState: Equatable {
    case ready
    /// L'écran affiche son bandeau rouge, avec ce message.
    case error(String)

    /// L'état lu dans les arguments de lancement.
    static func resolve(_ arguments: [String]) -> IOSScreenState {
        var resolved: IOSScreenState = .ready
        var index = 0
        while index < arguments.count {
            if arguments[index] == "-ios.state",
               index + 1 < arguments.count,
               let named = NamedState(rawValue: arguments[index + 1]) {
                resolved = named.state
            }
            index += 1
        }
        return resolved
    }

    /// Le bandeau de l'état, `nil` quand tout va bien : c'est la forme que
    /// `IOSSectionContent` transporte.
    var banner: ConsoleStatus? {
        guard case .error(let message) = self else { return nil }
        return ConsoleStatus(text: message, tone: .danger)
    }

    /// Le message du bandeau, `nil` quand tout va bien.
    var bannerMessage: String? {
        guard case .error(let message) = self else { return nil }
        return message
    }
}

/// Les valeurs reconnues du crochet, dérivées du nom des cas : aucune seconde
/// écriture des mots `ready` et `error` dans le code.
private enum NamedState: String {
    case ready
    case error

    var state: IOSScreenState {
        switch self {
        case .ready: return .ready
        case .error: return .error(IOSText.recipeError)
        }
    }
}
