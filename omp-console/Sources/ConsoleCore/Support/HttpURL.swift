// Le prédicat PARTAGÉ d'une adresse ouvrable : une URL n'est cliquable que si son
// schéma est `http` ou `https`. Les deux coques l'emploient (les cartes du tableau
// macOS et la feuille d'une carte iOS), donc la règle vit à un seul endroit.
//
// Déménagé de `ProjectPlanRowView.linkURL` (`ProjectConsoleView.swift`).

import Foundation

/// L'URL d'une adresse de PR quand elle est ouvrable (`http`/`https`), `nil`
/// sinon — jamais une adresse recomposée.
public func httpURL(_ value: String) -> URL? {
    guard let url = URL(string: value), let scheme = url.scheme?.lowercased(),
          scheme == "http" || scheme == "https" else { return nil }
    return url
}
