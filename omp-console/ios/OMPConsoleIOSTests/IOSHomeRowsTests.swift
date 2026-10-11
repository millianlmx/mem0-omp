// Les preuves Swift des rangées de l'Accueil (feature
// accueil-iphone-rangees-ecrasees-et-geste, BR-1) : la recette `-home.recipe
// longTitles` des captures en largeur compacte. La règle d'axe, qui suit le
// contenu et non plus la classe de largeur, est éprouvée par
// `IOSDynamicTypeAXTests` (ios-dynamic-type-ax-residuel, S-3).

import ConsoleClient
import ConsoleCore
import SwiftUI
import Testing

@testable import OMPConsoleIOS

@Suite("accueil-iphone-rangees-ecrasees-et-geste — rangées")
struct IOSHomeRowsTests {
    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-1 (recette) : longTitles donne un titre long aux rangées, pas aux cartes « À vous »")
    func longTitlesRecipeRetitlesRows() {
        #expect(IOSHomeRecipe.resolve(["-home.recipe", "longTitles"]) == .longTitles)
        #expect(IOSHomeText.recipeLongTitle.count == 40)

        guard case .dashboard(let reference) = IOSHomeRecipe.dashboard.homeState,
              case .dashboard(let long) = IOSHomeRecipe.longTitles.homeState else {
            Issue.record("les recettes dashboard et longTitles doivent rendre un tableau de bord")
            return
        }
        let rows = IOSHomeContent.rows(long)
        #expect(rows.count == 6)
        #expect(rows.map(\.id) == IOSHomeContent.rows(reference).map(\.id))
        #expect(rows.allSatisfy { $0.title == IOSHomeText.recipeLongTitle })

        #expect(long.attention.map(\.card.id) == reference.attention.map(\.card.id))
        #expect(long.attention.map(\.card.title) == reference.attention.map(\.card.title))
        #expect(long.attention.allSatisfy { $0.card.title != IOSHomeText.recipeLongTitle })
    }
}
