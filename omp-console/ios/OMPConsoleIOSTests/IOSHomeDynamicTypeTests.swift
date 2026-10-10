// Les preuves Swift des rangées de l'Accueil en Dynamic Type (feature
// ios-accueil-dynamic-type-casse, BR-1 et BR-2) : la règle d'axe PURE, sans rendre
// de vue, et le crochet de recette `-home.row` des captures. La règle est éprouvée
// en largeur régulière, celle de ces critères (la largeur compacte est couverte
// par `IOSHomeRowsTests`).
//
// AC-1 : première taille d'accessibilité → empilée. AC-2 : taille maximale →
// empilée, boutons bornés. AC-3 : tailles standard → une seule ligne. AC-4 : le
// crochet `-home.row` vise la rangée « Reprendre » de la fixture.

import ConsoleClient
import ConsoleCore
import SwiftUI
import Testing

@testable import OMPConsoleIOS

@Suite("ios-accueil-dynamic-type-casse — rangées de l'Accueil en Dynamic Type")
struct IOSHomeDynamicTypeTests {
    private static let standardSizes: [DynamicTypeSize] = [
        .xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge,
    ]

    @Test("ios-accueil-dynamic-type-casse/AC-3 : sous les tailles d'accessibilité, la rangée reste horizontale")
    func rowsStayHorizontalBelowAccessibilitySizes() {
        for size in Self.standardSizes {
            #expect(IOSHomeContent.rowAxis(size, width: .regular) == .horizontal, "\(size)")
        }
        #expect(IOSHomeContent.rowButtonMaximumSize > .xxxLarge)
    }

    @Test("ios-accueil-dynamic-type-casse/AC-1 : dès la première taille d'accessibilité, la rangée s'empile")
    func rowsStackFromTheFirstAccessibilitySize() {
        #expect(IOSHomeContent.rowAxis(.accessibility1, width: .regular) == .stacked)
        #expect(IOSHomeContent.rowAxis(.accessibility3, width: .regular) == .stacked)
        #expect(IOSHomeContent.rowAxis(.xxxLarge, width: .regular) == .horizontal)
    }

    @Test("ios-accueil-dynamic-type-casse/AC-2 : à la taille maximale, la rangée s'empile et ses boutons sont bornés")
    func rowsStackAtTheLargestSize() {
        #expect(IOSHomeContent.rowAxis(.accessibility5, width: .regular) == .stacked)
        #expect(IOSHomeContent.rowButtonMaximumSize <= .accessibility3)
        #expect(IOSHomeContent.rowButtonMaximumSize.isAccessibilitySize)
        #expect(IOSHomeContent.rowTextMaximumSize.isAccessibilitySize)
        #expect(IOSHomeContent.rowTextMaximumSize >= IOSHomeContent.rowButtonMaximumSize)
        #expect(IOSHomeContent.rowTextMaximumSize < .accessibility5, "à accessibility5 le sous-titre est coupé au milieu d'un mot")
    }

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
