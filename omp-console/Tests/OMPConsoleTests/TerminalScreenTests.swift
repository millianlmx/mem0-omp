// Preuves de la grille : écriture de cellules, défilement, marges, effacements,
// redimensionnement (S-3, S-6 côté grille). La grille est une valeur PURE : les
// assertions portent sur des suites exactes d'opérations, sans E/S ni horloge.

import Foundation
import Testing

@testable import OMPConsole

private func trimmed(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespaces)
}

private func fill(_ screen: inout TerminalScreen, _ lines: [String]) {
    for (index, line) in lines.enumerated() {
        screen.moveTo(row: index, column: 0)
        for character in line { screen.write(String(character), width: 1, attributes: .plain) }
    }
}

@Suite("terminal-integre/écran")
struct TerminalScreenTests {
    // MARK: Écriture et contrôles C0

    @Test("terminal-integre/AC-1 : autowrap désactivé, écrire au-delà de la dernière colonne écrase la dernière cellule")
    func noAutowrapOverwritesLastCell() {
        var screen = TerminalScreen(columns: 3, rows: 2)
        screen.autowrap = false
        for character in ["a", "b", "c", "d", "e"] {
            screen.write(character, width: 1, attributes: .plain)
        }
        #expect(screen.text(row: 0) == "abe")
        #expect(screen.cursor == TerminalCursor(row: 0, column: 2))
    }

    @Test("terminal-integre/AC-1 : autowrap actif, la cellule suivante passe à la ligne")
    func autowrapWrapsOnNextCell() {
        var screen = TerminalScreen(columns: 3, rows: 2)
        for character in ["a", "b", "c", "d"] {
            screen.write(character, width: 1, attributes: .plain)
        }
        #expect(screen.text(row: 0) == "abc")
        #expect(screen.text(row: 1).hasPrefix("d"))
    }

    @Test("terminal-integre/AC-1 : BS en colonne 0 est sans effet, HT avance au pas de 8, CR ramène à la colonne 0")
    func backspaceTabCarriageReturn() {
        var screen = TerminalScreen(columns: 20, rows: 1)
        screen.backspace()
        #expect(screen.cursor.column == 0)

        screen.tab()
        #expect(screen.cursor.column == 8)
        screen.tab()
        #expect(screen.cursor.column == 16)
        screen.tab()
        #expect(screen.cursor.column == 19)

        screen.carriageReturn()
        #expect(screen.cursor.column == 0)
    }

    @Test("terminal-integre/AC-1 : LF en bas de marge défile ; la ligne qui sort est perdue")
    func lineFeedScrollsAtBottom() {
        var screen = TerminalScreen(columns: 4, rows: 3)
        fill(&screen, ["aaa", "bbb", "ccc"])
        screen.moveTo(row: 2, column: 0)
        screen.lineFeed()

        #expect(trimmed(screen.text(row: 0)) == "bbb")
        #expect(trimmed(screen.text(row: 1)) == "ccc")
        #expect(trimmed(screen.text(row: 2)).isEmpty)
        #expect(screen.cursor == TerminalCursor(row: 2, column: 0))
    }

    @Test("terminal-integre/AC-1 : une cellule large occupe deux colonnes, la seconde est une continuation vide")
    func wideCellOccupiesTwoColumns() {
        var screen = TerminalScreen(columns: 4, rows: 1)
        screen.write("中", width: 2, attributes: .plain)

        #expect(screen.line(0)[0].text == "中")
        #expect(screen.line(0)[0].width == 2)
        #expect(screen.line(0)[0].isContinuation == false)
        #expect(screen.line(0)[1].isContinuation)
        #expect(screen.line(0)[1].text == "")
        #expect(screen.cursor.column == 2)
        #expect(screen.text(row: 0) == "中  ")
    }

    @Test("terminal-integre/AC-1 : un combinant est rattaché à la cellule de sa base")
    func combiningAttachesToBase() {
        var screen = TerminalScreen(columns: 4, rows: 1)
        screen.write("e", width: 1, attributes: .plain)
        screen.appendCombining("\u{0301}")

        #expect(screen.line(0)[0].text == "e\u{0301}")
        #expect(screen.text(row: 0).hasPrefix("e\u{0301}"))
        #expect(screen.cursor.column == 1)
    }

    // MARK: Effacements

    @Test("terminal-integre/AC-1 : ED 0/1/2 efface sous, au-dessus, ou tout ; ED 3 est sans effet")
    func eraseInDisplay() {
        var screen = TerminalScreen(columns: 4, rows: 3)
        fill(&screen, ["aaaa", "bbbb", "cccc"])
        screen.moveTo(row: 1, column: 2)
        screen.eraseInDisplay(0)
        #expect(screen.text(row: 0) == "aaaa")
        #expect(screen.text(row: 1) == "bb  ")
        #expect(screen.text(row: 2) == "    ")

        var above = TerminalScreen(columns: 4, rows: 3)
        fill(&above, ["aaaa", "bbbb", "cccc"])
        above.moveTo(row: 1, column: 1)
        above.eraseInDisplay(1)
        #expect(above.text(row: 0) == "    ")
        #expect(above.text(row: 1) == "  bb")
        #expect(above.text(row: 2) == "cccc")

        var kept = TerminalScreen(columns: 4, rows: 3)
        fill(&kept, ["aaaa", "bbbb", "cccc"])
        kept.eraseInDisplay(3)
        #expect(kept.text(row: 0) == "aaaa")
        #expect(kept.text(row: 2) == "cccc")

        screen.eraseInDisplay(2)
        #expect(screen.text(row: 0) == "    ")
    }

    @Test("terminal-integre/AC-1 : EL 0/1/2 efface à droite, à gauche, toute la rangée")
    func eraseInLine() {
        var screen = TerminalScreen(columns: 4, rows: 3)
        fill(&screen, ["aaaa", "bbbb", "cccc"])
        screen.moveTo(row: 1, column: 2)
        screen.eraseInLine(1)
        #expect(screen.text(row: 1) == "   b")
        screen.eraseInLine(0)
        #expect(screen.text(row: 1) == "    ")
        screen.eraseInLine(2)
        #expect(screen.text(row: 1) == "    ")
        #expect(screen.text(row: 0) == "aaaa")
    }

    // MARK: Marges

    @Test("terminal-integre/AC-1 : DECSTBM borne le défilement par LF, hors marges le contenu reste")
    func scrollRegionBoundsLineFeed() {
        var screen = TerminalScreen(columns: 3, rows: 4)
        fill(&screen, ["000", "111", "222", "333"])
        screen.setScrollRegion(top: 1, bottom: 3)
        #expect(screen.cursor == TerminalCursor(row: 0, column: 0))
        screen.moveTo(row: 3, column: 0)
        screen.lineFeed()

        #expect(screen.text(row: 0) == "000")
        #expect(trimmed(screen.text(row: 1)) == "222")
        #expect(trimmed(screen.text(row: 2)) == "333")
        #expect(trimmed(screen.text(row: 3)).isEmpty)
    }

    @Test("terminal-integre/AC-1 : IL et DL décalent les rangées DANS les marges")
    func insertAndDeleteLines() {
        var screen = TerminalScreen(columns: 3, rows: 4)
        fill(&screen, ["000", "111", "222", "333"])
        screen.setScrollRegion(top: 1, bottom: 3)

        screen.moveTo(row: 1, column: 0)
        screen.insertLines(1)
        #expect(screen.text(row: 0) == "000")
        #expect(trimmed(screen.text(row: 1)).isEmpty)
        #expect(trimmed(screen.text(row: 2)) == "111")
        #expect(trimmed(screen.text(row: 3)) == "222")

        screen.deleteLines(1)
        #expect(screen.text(row: 0) == "000")
        #expect(trimmed(screen.text(row: 1)) == "111")
        #expect(trimmed(screen.text(row: 2)) == "222")
        #expect(trimmed(screen.text(row: 3)).isEmpty)
    }

    @Test("terminal-integre/AC-1 : SU et SD défilent dans les marges seulement")
    func scrollUpAndDown() {
        var screen = TerminalScreen(columns: 3, rows: 4)
        fill(&screen, ["000", "111", "222", "333"])
        screen.setScrollRegion(top: 1, bottom: 3)

        screen.scrollUp(1)
        #expect(screen.text(row: 0) == "000")
        #expect(trimmed(screen.text(row: 1)) == "222")
        #expect(trimmed(screen.text(row: 2)) == "333")

        screen.scrollDown(1)
        #expect(screen.text(row: 0) == "000")
        #expect(trimmed(screen.text(row: 1)).isEmpty)
        #expect(trimmed(screen.text(row: 2)) == "222")
        #expect(trimmed(screen.text(row: 3)) == "333")
    }

    // MARK: changedRows

    @Test("terminal-integre/AC-7 : un déplacement du curseur marque l'ANCIENNE et la NOUVELLE rangée")
    func cursorMoveMarksBothRows() {
        var screen = TerminalScreen(columns: 3, rows: 3)
        screen.clearChanged()
        screen.moveTo(row: 1, column: 0)
        #expect(screen.changedRows == Set([0, 1]))

        screen.clearChanged()
        screen.moveTo(row: 2, column: 1)
        #expect(screen.changedRows == Set([1, 2]))

        screen.clearChanged()
        screen.moveTo(row: 2, column: 2)
        #expect(screen.changedRows.isEmpty)

        screen.clearChanged()
        screen.cursorVisible = false
        #expect(screen.changedRows == Set([2]))
    }

    @Test("terminal-integre/AC-7 : resize réancre en haut à gauche, sans reflow, et marque toutes les rangées")
    func resizeAnchorsWithoutReflow() {
        var screen = TerminalScreen(columns: 3, rows: 2)
        fill(&screen, ["abc", "def"])
        screen.moveTo(row: 1, column: 1)
        screen.clearChanged()

        screen.resize(columns: 5, rows: 3)
        #expect(screen.columns == 5)
        #expect(screen.rows == 3)
        #expect(screen.text(row: 0) == "abc  ")
        #expect(screen.text(row: 1) == "def  ")
        #expect(screen.text(row: 2) == "     ")
        #expect(screen.cursor == TerminalCursor(row: 1, column: 1))
        #expect(screen.changedRows == Set([0, 1, 2]))

        // Rétrécissement : les colonnes et rangées hors écran sont perdues.
        screen.clearChanged()
        screen.resize(columns: 2, rows: 1)
        #expect(screen.text(row: 0) == "ab")
        #expect(screen.cursor == TerminalCursor(row: 0, column: 1))
        #expect(screen.changedRows == Set([0]))
    }
}
