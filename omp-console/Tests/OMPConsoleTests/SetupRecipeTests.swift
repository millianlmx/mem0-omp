// Preuves du crochet de recette `-setup.recipe` de la feuille de préparation
// (S-7 de mac-omp-manquant-non-bloquant) : la garde par racine jetable, et la
// réussite scriptée qui pose les deux exécutables SOUS la racine jetable et mène le
// modèle à `.ready`. Les autres valeurs (progression, indéterminée, échec) sont
// prouvées par la recette sur l'app réelle, consignée en revue (AC-12).

import Combine
import Foundation
import Testing
@testable import OMPConsole

@MainActor
private func waitUntil(timeout: Duration = .seconds(10), _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

/// Des préférences jetables, portant la valeur donnée sous `setup.recipe`.
private func recipeDefaults(_ value: String?) -> UserDefaults {
    let suite = "setup-recipe-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    if let value { defaults.set(value, forKey: SetupRecipe.defaultsKey) }
    return defaults
}

@Test("mac-omp-manquant-non-bloquant/AC-12 : le crochet `-setup.recipe` n'agit que sous une racine jetable")
func recipeRequiresDisposableRoot() {
    let root = [AppPaths.supportRootEnvironmentKey: "/tmp/omp-console-recette"]

    // Sans racine jetable : jamais de crochet, quelle que soit la valeur.
    #expect(SetupRecipe.current(defaults: recipeDefaults("succes"), environment: [:]) == nil)
    #expect(SetupRecipe.current(
        defaults: recipeDefaults("succes"),
        environment: [AppPaths.supportRootEnvironmentKey: ""]
    ) == nil)

    // Avec : la valeur reconnue, et rien pour une valeur absente ou inconnue.
    for recipe in SetupRecipe.allCases {
        #expect(SetupRecipe.current(defaults: recipeDefaults(recipe.rawValue), environment: root) == recipe)
    }
    #expect(SetupRecipe.current(defaults: recipeDefaults(nil), environment: root) == nil)
    #expect(SetupRecipe.current(defaults: recipeDefaults("inconnu"), environment: root) == nil)
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-12 : la recette `succes` pose OMP et Podman sous la racine jetable et mène à `.ready`")
func successRecipeInstallsUnderDisposableRoot() async throws {
    let root = ComponentsRoot()
    let installer = root.installer
    #expect(!installer.isInstalled(.omp))
    #expect(!installer.isInstalled(.podman))

    let model = SetupRecipe.succes.model(paths: root.paths, manifest: root.manifest, autoPrepare: false)
    #expect(model.state == .idle)
    var steps: [SetupState] = []
    let watch = model.$state.sink { steps.append($0) }
    defer { watch.cancel() }

    model.startInstall()
    #expect(await waitUntil { model.state == .ready })

    // Les deux binaires sont de vrais exécutables, sous la racine jetable.
    for component in ComponentID.allCases {
        let location = installer.binaryLocation(component)
        #expect(location.path.hasPrefix(root.paths.supportRoot.path))
        #expect(installer.isInstalled(component))
    }
    // La cible était OMP (premier manquant) : téléchargement chiffré, puis pose.
    #expect(steps.contains(.preparing(.omp(downloaded: 60_000_000, total: 120_000_000))))
    #expect(steps.contains(.preparing(.ompInstall)))
    #expect(!steps.contains { if case .preparing(.podman) = $0 { true } else { false } })
}
