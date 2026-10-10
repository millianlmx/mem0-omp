// Les preuves Swift du badge de la ligne « Accueil » de la liste racine / barre
// latérale (ios-badge-attente-invisible-racine) : la fonction pure `rowBadge` ne
// dépend que du nombre d'attentes, jamais de la section affichée, et le crochet
// `-home.recipe` nourrit le badge depuis la MÊME fixture que l'Accueil forcé.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

@Suite("ios-badge-attente-invisible-racine — le badge de la ligne Accueil")
struct IOSHomeBadgeTests {
    @Test("ios-badge-attente-invisible-racine/AC-1 : la ligne Accueil porte le compte, quelle que soit la section")
    func homeRowCarriesPositiveCount() {
        for count in [1, 3, 120] {
            #expect(IOSHomeContent.rowBadge(for: .home, attentionCount: count) == count)
            for section in ConsoleSection.allCases where section != .home {
                #expect(IOSHomeContent.rowBadge(for: section, attentionCount: count) == 0)
            }
        }
    }

    @Test("ios-badge-attente-invisible-racine/AC-2 : aucun badge quand il n'y a aucune attente")
    func homeRowHiddenAtZero() {
        for section in ConsoleSection.allCases {
            #expect(IOSHomeContent.rowBadge(for: section, attentionCount: 0) == 0)
            #expect(IOSHomeContent.rowBadge(for: section, attentionCount: -1) == 0)
        }
    }

    @Test("ios-badge-attente-invisible-racine : la recette nourrit le badge comme l'Accueil")
    func recipeFeedsSidebarBadge() {
        let expected: [(IOSHomeRecipe, Int)] = [
            (.dashboard, 5), (.answer, 5), (.contract, 5), (.degraded, 5),
            (.loading, 0), (.firstRun, 0), (.ompMissing, 0),
        ]
        for (recipe, badge) in expected {
            #expect(recipe.badge == badge, "recette \(recipe.rawValue)")
            let carriesFixture: Bool
            switch recipe.homeState {
            case .dashboard, .disconnected: carriesFixture = true
            default: carriesFixture = false
            }
            #expect((recipe.badge == 5) == carriesFixture, "recette \(recipe.rawValue)")
        }
    }
}
