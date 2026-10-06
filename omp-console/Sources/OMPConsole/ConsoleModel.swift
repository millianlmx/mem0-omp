// État de la coque : la section courante — l'Accueil à l'ouverture (S-4 de
// omp-console-redesign) — et la pile de navigation de la section Sessions (la
// visionneuse poussée sur la liste, au lieu d'une fenêtre par session).
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

final class ConsoleModel: ObservableObject {
    @Published private(set) var selection: ConsoleSection = .home
    /// La session ouverte dans la section Sessions : vide = la liste. Elle
    /// survit au passage d'une section à l'autre.
    @Published var sessionsPath: [ViewerTarget] = []

    func select(_ section: ConsoleSection) {
        selection = section
    }

    /// Montre une session dans la section Sessions (remplace celle qui était
    /// ouverte : une seule visionneuse à la fois).
    func openSession(_ target: ViewerTarget) {
        sessionsPath = [target]
        selection = .sessions
    }
}
