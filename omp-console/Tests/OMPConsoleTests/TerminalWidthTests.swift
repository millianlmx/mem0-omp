// Preuves de la largeur en cellules (Doc-4, UAX #11) : ce que la grille compte
// pour un box-drawing, un emoji ou un combinant. Les glyphes sont ceux de la
// table MESURÉE de Doc-4.

import Foundation
import Testing

@testable import OMPConsole

@Suite("terminal-integre/largeur")
struct TerminalWidthTests {
    @Test("terminal-integre/AC-1 : un box-drawing, un ambigu ou un neutre vaut UNE cellule")
    func ambiguousAndNeutralAreOneCell() {
        for glyph in ["─", "│", "╭", "╮", "●", "•", "→", "é", "✓", "⏺"] {
            #expect(TerminalWidth.of(glyph) == 1, "\(glyph) devrait valoir 1 cellule")
        }
    }

    @Test("terminal-integre/AC-1 : un glyphe Wide ou Fullwidth vaut DEUX cellules")
    func wideIsTwoCells() {
        for glyph in ["中", "😀", "👍", "Ａ"] {
            #expect(TerminalWidth.of(glyph) == 2, "\(glyph) devrait valoir 2 cellules")
        }
    }

    @Test("terminal-integre/AC-1 : un combinant vaut ZÉRO cellule, et la base commande le grapheme")
    func combiningIsZero() {
        #expect(TerminalWidth.of("\u{0301}") == 0)
        #expect(TerminalWidth.of("e\u{0301}") == 1)
        #expect(TerminalWidth.of("中\u{0301}") == 2)
        #expect(TerminalWidth.of("") == 0)
        #expect(TerminalWidth.of(" ") == 1)
    }

    @Test("terminal-integre/AC-1 : les bornes des plages larges sont exactes")
    func rangeBoundaries() {
        #expect(TerminalWidth.of("\u{1100}") == 2) // début de la plage hangûl large
        #expect(TerminalWidth.of("\u{1200}") == 1) // éthiopien, juste après la plage
        #expect(TerminalWidth.of("\u{2E7F}") == 1)
        #expect(TerminalWidth.of("\u{2E80}") == 2)
        #expect(TerminalWidth.of("\u{2E99}") == 2)
        #expect(TerminalWidth.of("\u{2E9A}") == 1)
        #expect(TerminalWidth.of("\u{1F5FA}") == 1)
        #expect(TerminalWidth.of("\u{1F5FB}") == 2)
        #expect(TerminalWidth.of("\u{1F64F}") == 2)
        #expect(TerminalWidth.of("\u{1F650}") == 1)
        #expect(TerminalWidth.of("\u{FF60}") == 2) // pleine largeur
        #expect(TerminalWidth.of("\u{FF61}") == 1) // demi-largeur
        #expect(TerminalWidth.of("\u{2500}") == 1) // box-drawing
        #expect(TerminalWidth.of("\u{10FFFF}") == 1)
    }

    @Test("terminal-integre/AC-1 : un « default ignorable » vaut zéro MÊME si sa plage est large")
    func ignorableWinsOverWide() {
        // U+115F/U+1160 sont des remplisseurs hangûl : East Asian Width W, mais
        // « default ignorable » — la règle de Doc-4 (Mn/Me ou ignorable d'abord)
        // leur donne 0, pas 2.
        #expect(TerminalWidth.of("\u{115F}") == 0)
        #expect(TerminalWidth.of("\u{1160}") == 0)
        #expect(TerminalWidth.of("\u{200B}") == 0)
    }

    @Test("terminal-integre/AC-1 : la surcharge scalaire est cohérente avec la surcharge texte")
    func scalarOverloadMatchesText() {
        let scalar = "中".unicodeScalars.first!
        #expect(TerminalWidth.of(scalar) == 2)
        #expect(TerminalWidth.of(scalar) == TerminalWidth.of("中"))
    }
}
