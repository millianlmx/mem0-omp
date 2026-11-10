// Les repères visuels de l'« OS agentique » : la logique pure derrière le chemin d'une feature,
// le niveau de risque, la part des tests et le compte à rebours.

@testable import ConsoleUI
import Foundation
import Testing

@Suite("OSGlyph")
struct OSGlyphTests {
    @Test("le chemin : les étapes d'avant sont faites, celle-ci est en cours, les autres à venir")
    func journeyStates() {
        #expect(OSGlyph.nodes(step: 2, merged: false) == [.done, .done, .current, .upcoming, .upcoming])
        #expect(OSGlyph.nodes(step: 0, merged: false) == [.current, .upcoming, .upcoming, .upcoming, .upcoming])
    }

    @Test("une feature fusionnée a tout fait, quelle que soit l'étape lue")
    func mergedIsAllDone() {
        #expect(OSGlyph.nodes(step: 4, merged: true) == Array(repeating: .done, count: 5))
        #expect(OSGlyph.nodes(step: 1, merged: true) == Array(repeating: .done, count: 5))
    }

    @Test("le risque : trois niveaux connus, rien pour un risque d'une version plus récente")
    func riskLevels() {
        #expect(OSGlyph.riskLevel("low") == 1)
        #expect(OSGlyph.riskLevel("medium") == 2)
        #expect(OSGlyph.riskLevel("high") == 3)
        #expect(OSGlyph.riskLevel("critical") == nil)
    }

    @Test("la part des tests passés : sans test, aucune part")
    func testShare() {
        #expect(OSGlyph.testShare(passed: 0, failed: 0) == nil)
        #expect(OSGlyph.testShare(passed: 3, failed: 1) == 0.75)
        #expect(OSGlyph.testShare(passed: 0, failed: 4) == 0)
    }

    @Test("le compte à rebours : de 1 à 0, borné des deux côtés")
    func countdown() {
        #expect(OSGlyph.remaining(30, of: 60) == 0.5)
        #expect(OSGlyph.remaining(90, of: 60) == 1)
        #expect(OSGlyph.remaining(-5, of: 60) == 0)
        #expect(OSGlyph.remaining(10, of: 0) == 0)
    }

    @Test("le budget : part dépensée, au-delà de 1 quand il est dépassé, 0 sans plafond valide")
    func budgetShare() {
        #expect(OSGlyph.budgetShare(spent: 25, ceiling: 50) == 0.5)
        #expect(OSGlyph.budgetShare(spent: 75, ceiling: 50) == 1.5)
        #expect(OSGlyph.budgetShare(spent: -3, ceiling: 50) == 0)
        #expect(OSGlyph.budgetShare(spent: 10, ceiling: 0) == 0)
    }

    @Test("ce qui retient une feature : un symbole par cause connue, le sablier pour une cause inconnue")
    func waitSymbols() {
        #expect(OSGlyph.waitSymbol("paused") == "pause.circle")
        #expect(OSGlyph.waitSymbol("daily_budget") == OSGlyph.waitSymbol("space_budget"))
        #expect(OSGlyph.waitSymbol("slots") != OSGlyph.waitSymbol("memory"))
        #expect(OSGlyph.waitSymbol("une-cause-future") == "hourglass")
    }
}
