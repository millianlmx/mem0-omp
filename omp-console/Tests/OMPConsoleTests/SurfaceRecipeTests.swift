// Preuves du crochet de recette `-surface.recipe` (S-5 de recette-ui-mac-automatisee) :
// la garde par racine jetable, et le décodage des 24 identifiants du catalogue des
// surfaces (9 sections, 15 feuilles). L'ouverture réelle de chaque surface est
// prouvée par le passage de la recette sur l'app, consigné en revue (AC-3).

import Foundation
import Testing
@testable import OMPConsole

/// Des préférences jetables, portant la valeur donnée sous `surface.recipe`.
private func recipeDefaults(_ value: String?) -> UserDefaults {
    let suite = "surface-recipe-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    if let value { defaults.set(value, forKey: SurfaceRecipe.defaultsKey) }
    return defaults
}

/// Les identifiants du catalogue des surfaces (S-6), dans son ordre.
private let catalogueIDs = [
    "accueil", "pipelines", "projet", "session-omp", "terminal", "sessions", "fichiers", "memoire",
    "statistiques", "bienvenue", "preparation", "appairage", "nouvelle-pipeline", "reponse", "contrat",
    "fiche-carte", "modeles", "projet-lancement", "projet-dialogue", "session-omp-dialogue",
    "terminal-lancement", "memoire-creation", "memoire-edition", "memoire-lien",
]

@Test("recette-ui-mac-automatisee/AC-3 : le crochet `-surface.recipe` n'agit que sous une racine jetable")
func surfaceRecipeRequiresDisposableRoot() {
    let root = [AppPaths.supportRootEnvironmentKey: "/tmp/omp-console-recette-ui/support"]

    // Sans racine jetable : jamais de crochet, quelle que soit la valeur.
    #expect(SurfaceRecipe.current(defaults: recipeDefaults("accueil"), environment: [:]) == nil)
    #expect(SurfaceRecipe.current(
        defaults: recipeDefaults("accueil"),
        environment: [AppPaths.supportRootEnvironmentKey: ""]
    ) == nil)

    // Avec : rien pour une valeur absente ou inconnue.
    #expect(SurfaceRecipe.current(defaults: recipeDefaults(nil), environment: root) == nil)
    #expect(SurfaceRecipe.current(defaults: recipeDefaults("inconnu"), environment: root) == nil)
    #expect(SurfaceRecipe.current(defaults: recipeDefaults("sessionOmp"), environment: root) == nil)
}

@Test("recette-ui-mac-automatisee/AC-3 : les 24 identifiants du catalogue des surfaces sont décodés")
func surfaceRecipeDecodesCatalogue() {
    let root = [AppPaths.supportRootEnvironmentKey: "/tmp/omp-console-recette-ui/support"]

    #expect(SurfaceRecipe.allCases.count == 24)
    #expect(SurfaceRecipe.allCases.map(\.rawValue) == catalogueIDs)
    for id in catalogueIDs {
        let recipe = SurfaceRecipe.current(defaults: recipeDefaults(id), environment: root)
        #expect(recipe?.rawValue == id, "identifiant non décodé : \(id)")
    }
}
