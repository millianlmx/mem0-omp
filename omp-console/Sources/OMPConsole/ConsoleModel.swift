// État de la coque : la section courante.
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

final class ConsoleModel: ObservableObject {
    @Published private(set) var selection: ConsoleSection = .kanban

    func select(_ section: ConsoleSection) {
        selection = section
    }
}
