// Les preuves Swift du badge de la ligne « Accueil » de la liste racine / barre
// latérale (ios-badge-attente-invisible-racine) : la fonction pure `rowBadge` ne
// dépend que du nombre d'attentes, jamais de la section affichée, et le crochet
// `-home.recipe` nourrit le badge depuis la MÊME fixture que l'Accueil forcé. Le
// badge de la ligne « Audit » (audit-ui-redesign, S-4) suit le même chemin.

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
            #expect(IOSHomeContent.rowBadge(for: .home, attentionCount: count, auditCount: 0) == count)
            for section in ConsoleSection.allCases where section != .home {
                #expect(IOSHomeContent.rowBadge(for: section, attentionCount: count, auditCount: 0) == 0)
            }
        }
    }

    @Test("ios-badge-attente-invisible-racine/AC-2 : aucun badge quand il n'y a aucune attente")
    func homeRowHiddenAtZero() {
        for section in ConsoleSection.allCases {
            #expect(IOSHomeContent.rowBadge(for: section, attentionCount: 0, auditCount: 0) == 0)
            #expect(IOSHomeContent.rowBadge(for: section, attentionCount: -1, auditCount: -1) == 0)
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
            case .dashboard, .unavailable: carriesFixture = true
            default: carriesFixture = false
            }
            #expect((recipe.badge == 5) == carriesFixture, "recette \(recipe.rawValue)")
        }
    }

    @Test("audit-ui-redesign-ios/AC-6 : l'onglet Audit (iPhone) et la rangée Audit (iPad) portent le nombre d'audits qui attendent, 0 → aucun badge")
    func auditRowCarriesAwaitingAudits() throws {
        // La fonction pure : Audit porte son compte, Accueil le sien, le reste 0.
        #expect(IOSHomeContent.rowBadge(for: .audit, attentionCount: 5, auditCount: 2) == 2)
        #expect(IOSHomeContent.rowBadge(for: .home, attentionCount: 5, auditCount: 2) == 5)
        for section in ConsoleSection.allCases where section != .home && section != .audit {
            #expect(IOSHomeContent.rowBadge(for: section, attentionCount: 5, auditCount: 2) == 0)
        }
        #expect(IOSHomeContent.rowBadge(for: .audit, attentionCount: 5, auditCount: 0) == 0)
        #expect(IOSHomeContent.rowBadge(for: .audit, attentionCount: 5, auditCount: -3) == 0)
        // Le libellé VoiceOver de l'onglet : « Audit, 2 en attente ».
        #expect(IOSHomeText.sectionRowLabel(ConsoleSection.audit.title, badge: 2)
            == "\(ConsoleSection.audit.title), 2 \(IOSHomeText.rowPending)")

        // La recette `liste` (AuditParity : un audit proposed, un audit lancé à
        // question en attente, un analysing sans question, un arrêté, un en échec)
        // → 2, le même compte que l'instantané reçu du Mac.
        let recipe = try #require(IOSAuditRecipe.resolve(["-audit.recipe", "liste"]))
        #expect(recipe.board(nowMs: 1_700_000_000_000).awaitingUserCount == 2)
        #expect(AuditBoard.awaitingUserCount(in: AuditParity.snapshot) == 2)

        // Toutes les questions répondues et plus rien de proposé → aucun badge.
        let quiet = AuditBoard(audits: AuditParity.board.audits.map { card in
            var card = card
            card.escalations = []
            if card.status == .proposed { card.status = .launched }
            return card
        })
        #expect(quiet.awaitingUserCount == 0)
        #expect(IOSHomeContent.rowBadge(for: .audit, attentionCount: 0, auditCount: quiet.awaitingUserCount) == 0)
    }
}
