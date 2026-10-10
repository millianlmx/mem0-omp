// Les preuves Swift des rangées de l'Accueil selon la largeur (feature
// accueil-iphone-rangees-ecrasees-et-geste, BR-1) : la règle d'axe PURE
// `IOSHomeContent.rowAxis(_:width:)`, sans rendre de vue, et la recette
// `-home.recipe longTitles` des captures en largeur compacte.
//
// AC-1 : largeur compacte, taille standard → deux lignes (titre, puis puce +
// bouton). AC-2 : largeur régulière ou inconnue → une ligne. AC-3 : taille
// d'accessibilité → empilée, quelle que soit la largeur.

import ConsoleClient
import ConsoleCore
import SwiftUI
import Testing

@testable import OMPConsoleIOS

@Suite("accueil-iphone-rangees-ecrasees-et-geste — rangées")
struct IOSHomeRowsTests {
    private static let standardSizes: [DynamicTypeSize] = [
        .xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge,
    ]
    private static let accessibilitySizes: [DynamicTypeSize] = [
        .accessibility1, .accessibility2, .accessibility3, .accessibility4, .accessibility5,
    ]

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-1 : en largeur compacte, la rangée passe sur deux lignes dès la taille par défaut")
    func compactWidthSplitsRowsInTwoLines() {
        for size in Self.standardSizes {
            #expect(IOSHomeContent.rowAxis(size, width: .compact) == .twoLine, "\(size)")
        }
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-2 : en largeur régulière ou inconnue, la rangée reste sur une ligne")
    func regularWidthKeepsOneLine() {
        for size in Self.standardSizes {
            #expect(IOSHomeContent.rowAxis(size, width: .regular) == .horizontal, "\(size)")
            #expect(IOSHomeContent.rowAxis(size, width: nil) == .horizontal, "\(size)")
        }
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-3 : aux tailles d'accessibilité, la rangée s'empile dans toutes les largeurs")
    func accessibilitySizesStackInEveryWidth() {
        let widths: [UserInterfaceSizeClass?] = [.compact, .regular, nil]
        for size in Self.accessibilitySizes {
            for width in widths {
                #expect(IOSHomeContent.rowAxis(size, width: width) == .stacked, "\(size) \(String(describing: width))")
            }
        }
    }

    @Test("accueil-iphone-rangees-ecrasees-et-geste/AC-1 (recette) : longTitles donne un titre long aux rangées, pas aux cartes « À vous »")
    func longTitlesRecipeRetitlesRows() {
        #expect(IOSHomeRecipe.resolve(["-home.recipe", "longTitles"]) == .longTitles)
        #expect(IOSHomeText.recipeLongTitle.count == 40)

        guard case .dashboard(let reference) = IOSHomeRecipe.dashboard.homeState,
              case .dashboard(let long) = IOSHomeRecipe.longTitles.homeState else {
            Issue.record("les recettes dashboard et longTitles doivent rendre un tableau de bord")
            return
        }
        let rows = long.running + long.delivered
        #expect(rows.count == 4)
        #expect(rows.map(\.id) == (reference.running + reference.delivered).map(\.id))
        #expect(rows.allSatisfy { $0.title == IOSHomeText.recipeLongTitle })

        #expect(long.attention.map(\.card.id) == reference.attention.map(\.card.id))
        #expect(long.attention.map(\.card.title) == reference.attention.map(\.card.title))
        #expect(long.attention.allSatisfy { $0.card.title != IOSHomeText.recipeLongTitle })
    }
}
