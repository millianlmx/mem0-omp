// Point d'entrée de la coque. Le fichier NE s'appelle PAS main.swift : `@main`
// y est refusé (D2/D3). L'état vit dans un `@StateObject` (property wrapper
// réelle, autorisée sous CLT) plutôt qu'un `@State` (macro, interdite).

import SwiftUI

@main
struct OMPConsoleApp: App {
    @StateObject private var model = ConsoleModel()

    var body: some Scene {
        WindowGroup("OMP Console") {
            ConsoleRootView(model: model)
        }
    }
}
