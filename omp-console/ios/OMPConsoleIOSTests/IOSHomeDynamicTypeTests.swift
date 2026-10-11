// La preuve Swift du crochet de recette `-home.row` des captures des rangées de
// l'Accueil (feature ios-accueil-dynamic-type-casse, BR-2) : AC-4, le crochet vise
// la rangée « Reprendre » de la fixture. La règle d'axe des rangées, qui suit le
// contenu et non plus la taille de texte, est éprouvée par `IOSDynamicTypeAXTests`
// (ios-dynamic-type-ax-residuel, S-3).

import ConsoleClient
import ConsoleCore
import SwiftUI
import Testing

@testable import OMPConsoleIOS

@Suite("ios-accueil-dynamic-type-casse — rangées de l'Accueil en Dynamic Type")
struct IOSHomeDynamicTypeTests {
    @Test("ios-accueil-dynamic-type-casse/AC-4, accueil-en-cours-melange-pause-et-compte/AC-2 : le crochet -home.row vise la rangée Reprendre de la fixture, sous « À reprendre »")
    func rowHookTargetsTheResumeRow() {
        #expect(IOSHomeRecipe.row(["-home.row", "2"]) == 2)
        #expect(IOSHomeRecipe.row(["-home.row", "1", "-home.row", "3"]) == 3)
        #expect(IOSHomeRecipe.row(["-home.row", "x"]) == nil)
        #expect(IOSHomeRecipe.row(["-home.row", "-1"]) == nil)
        #expect(IOSHomeRecipe.row(["-home.row"]) == nil)
        #expect(IOSHomeRecipe.row([]) == nil)

        guard case .dashboard(let dashboard) = IOSHomeRecipe.dashboard.homeState else {
            Issue.record("la recette .dashboard ne rend pas de tableau de bord")
            return
        }
        // Les rangées dans l'ordre de l'écran : 2 « En cours », 1 « À reprendre »,
        // 1 « Pas commencées », 2 « Livrées récemment ».
        let rows = IOSHomeContent.rows(dashboard)
        #expect(rows.map(\.id) == (dashboard.running + dashboard.paused + dashboard.notStarted + dashboard.delivered).map(\.id))
        #expect(rows.count == 6)
        let resumable = rows.filter { KanbanActionPresentation.resumable($0) && $0.action != nil }
        #expect(resumable.count == 1)
        guard let resume = resumable.first, let index = rows.firstIndex(where: { $0.id == resume.id }) else {
            Issue.record("la fixture ne porte aucune rangée reprenable")
            return
        }
        #expect(IOSHomeContent.recipeRowID(dashboard, index: index) == resume.id)
        #expect(index == 2, "la rangée Reprendre suit les deux « En cours »")
        #expect(dashboard.paused.map(\.id) == [resume.id])
        #expect(IOSHomeContent.recipeRowID(dashboard, index: 3) == dashboard.notStarted.first?.id)
        #expect(IOSHomeContent.recipeRowID(dashboard, index: 6) == nil)
        #expect(IOSHomeContent.recipeRowID(dashboard, index: -1) == nil)
    }
}
