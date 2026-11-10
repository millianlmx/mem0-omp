// État de la coque : la section courante de l'interface classique — « À traiter » à
// l'ouverture — et ce que la nouvelle interface doit montrer quand un raccourci, un
// lien ou une notification le demande (`osRoute`).
//
// L'état vit dans une classe `ObservableObject` parce que `@State` est INTERDIT
// sous les Command Line Tools : c'est une macro SwiftUI que le toolchain CLT ne
// fournit pas (D3). `@Published` et `@ObservedObject`, eux, sont de vraies
// property wrappers, donc autorisés.
//
// `selection` n'est jamais optionnelle : une section est toujours sélectionnée
// (aucun état vide à inventer). `select(_:)` est le SEUL point de mutation, ce
// qui rend la règle vérifiable et la sélection idempotente.

import Combine
import ConsoleCore
import ConsoleUI

@MainActor
final class ConsoleModel: ObservableObject {
    @Published private(set) var selection: ConsoleSection = .inbox
    /// L'écran que la nouvelle interface doit ouvrir (⌘1…⌘5, un lien `ompconsole://…`,
    /// une notification) : elle le consomme dès qu'elle est à l'écran. Vit ici, à
    /// l'échelle de l'app, pour survivre à une fenêtre fermée puis rouverte.
    @Published var osRoute: OSRoute?

    func select(_ section: ConsoleSection) {
        selection = section
    }
}
