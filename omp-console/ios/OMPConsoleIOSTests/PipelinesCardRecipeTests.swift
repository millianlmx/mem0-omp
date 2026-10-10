import ConsoleCore
import Testing

@testable import OMPConsoleIOS
@testable import ConsoleCore

/// Les preuves Swift du crochet de recette `-pipelines.recipe` : sans carte de
/// fixture qualifiée, les captures et la recette idb n'auraient rien à montrer.
@MainActor
@Suite("ios-fiche-carte-pipelines — le crochet de recette de la fiche")
struct PipelinesCardRecipeTests {
    @Test("ios-fiche-carte-pipelines/AC-1 : la carte de fixture offre « Reprendre » et « Arrêter… » et porte le titre long de recette")
    func fixtureCardOffersBothGestures() throws {
        let card = try #require(PipelinesCardRecipe.fiche.card)
        let gestures = PipelinesGesture.gestures(of: card)
        #expect(gestures.contains(.resume))
        #expect(gestures.contains(.stop))
        #expect(KanbanCardPresentation.title(card) == PipelinesText.recipeTitle)
        #expect(card.models == ModelSlots(
            reqSpecs: PipelinesText.recipeModelKnown,
            implReview: PipelinesText.recipeModelUnknown
        ))
    }

    @Test("ios-fiche-carte-pipelines/AC-6 : le catalogue de recette nomme le premier modèle et laisse le second brut")
    func recipeCatalogNamesOnlyTheKnownModel() throws {
        let recipe = PipelinesCardRecipe.actions
        let card = try #require(recipe.card)
        let lines = try #require(PipelinesModel.modelLines(card, names: recipe.modelNames))
        #expect(lines.reqSpecs.hasSuffix(PipelinesText.recipeModelKnownName))
        #expect(lines.implReview.hasSuffix(PipelinesText.recipeModelUnknown))
    }

    @Test("ios-fiche-carte-pipelines/AC-4 : la dernière paire reconnue gagne, une valeur inconnue est ignorée")
    func recipeFollowsTheLastRecognisedPair() {
        let flag = PipelinesText.recipeFlag
        #expect(PipelinesCardRecipe.resolve([]) == nil)
        #expect(PipelinesCardRecipe.resolve([flag, "inconnue"]) == nil)
        #expect(PipelinesCardRecipe.resolve([flag, PipelinesText.recipeFiche, flag, PipelinesText.recipeArret]) == .arret)
        #expect(PipelinesCardRecipe.resolve([flag, PipelinesText.recipeArret, flag, "inconnue"]) == .arret)
        #expect(PipelinesCardRecipe.resolve([flag]) == nil)
        #expect(PipelinesCardRecipe.fiche.scrollsToActions == false)
        #expect(PipelinesCardRecipe.actions.scrollsToActions)
        #expect(PipelinesCardRecipe.arret.scrollsToActions)
    }
}
