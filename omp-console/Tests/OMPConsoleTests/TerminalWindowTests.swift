// Preuves de la FENÊTRE « Terminal » sans ouvrir de fenêtre : la garde de
// terminaison (S-8), l'invariant de largeur typographique du rendu (S-3) et le
// minimum de grille (S-6).
//
// L'invariant est prouvé sur `TerminalRowRendering` — la construction d'une rangée
// est une valeur, hors de la vue — donc sans NSWindow ni boucle d'événements.

import AppKit
import CoreText
import Testing
@testable import OMPConsole

private let testPalette = TerminalPalette(
    defaultForeground: TerminalRGB(0xE6, 0xE6, 0xE6),
    defaultBackground: TerminalRGB(0x14, 0x14, 0x14)
)

private func advanceOfM(_ font: NSFont) -> CGFloat {
    let ctFont = font as CTFont
    var glyph = CTFontGetGlyphWithName(ctFont, "M" as CFString)
    var advance = CGSize.zero
    CTFontGetAdvancesForGlyphs(ctFont, .horizontal, &glyph, &advance, 1)
    return advance.width
}

private func makeCells(_ text: String) -> [TerminalCell] {
    text.map { character in
        var cell = TerminalCell()
        cell.text = String(character)
        cell.width = 1
        return cell
    }
}

@MainActor
@Test("terminal-integre/AC-1 : la largeur typographique d'une rangée vaut exactement colonnes × largeur de cellule")
func rowTypographicWidthMatchesTheCellGrid() {
    let font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    let bold = NSFont.monospacedSystemFont(ofSize: 13, weight: .bold)
    let italic = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
    let cellWidth = advanceOfM(font)
    #expect(cellWidth > 0)

    for text in ["MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM", "  espaces et majuscules M  ", "0123456789"] {
        let cells = makeCells(text)
        let line = TerminalRowRendering.line(for: cells, palette: testPalette, base: font, bold: bold, italic: italic)
        let width = CTLineGetTypographicBounds(line, nil, nil, nil)
        #expect(abs(Double(width) - Double(cells.count) * Double(cellWidth)) < 0.5)
    }
}

@MainActor
@Test("terminal-integre/AC-1 : les attributs ne changent pas la largeur d'une rangée")
func attributesDoNotChangeTheRowWidth() {
    let font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    let bold = NSFont.monospacedSystemFont(ofSize: 13, weight: .bold)
    let italic = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
    let cellWidth = advanceOfM(font)

    var cells = makeCells("MMMMMM")
    cells[0].attributes.bold = true
    cells[1].attributes.italic = true
    cells[2].attributes.underline = true
    cells[3].attributes.inverse = true
    cells[4].attributes.foreground = .indexed(196)
    cells[5].attributes.background = .rgb(10, 20, 30)

    let line = TerminalRowRendering.line(for: cells, palette: testPalette, base: font, bold: bold, italic: italic)
    let width = CTLineGetTypographicBounds(line, nil, nil, nil)
    #expect(abs(Double(width) - Double(cells.count) * Double(cellWidth)) < 0.5)
}

@MainActor
@Test("terminal-integre/AC-1 : l'inverse échange avant et arrière au rendu")
func inverseSwapsTheColors() {
    var cell = TerminalCell()
    cell.text = "A"
    cell.attributes.inverse = true

    let plain = TerminalRowRendering.attributedString(
        for: [cell], palette: testPalette, base: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
        bold: NSFont.monospacedSystemFont(ofSize: 13, weight: .bold),
        italic: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    )
    let attributes = plain.attributes(at: 0, effectiveRange: nil)
    #expect((attributes[.foregroundColor] as? NSColor)?.isEqual(testPalette.defaultBackground.nsColor) == true)
    #expect((attributes[.backgroundColor] as? NSColor)?.isEqual(testPalette.defaultForeground.nsColor) == true)
}

@MainActor
@Test("terminal-integre/AC-7 : la zone de rendu ne descend jamais sous 20×5, jamais 0 colonne")
func gridNeverGoesBelowTheMinimum() {
    let view = TerminalRenderView()
    view.frame = NSRect(x: 0, y: 0, width: 8, height: 8)
    #expect(view.measuredGrid().columns == TerminalRenderView.minimumColumns)
    #expect(view.measuredGrid().rows == TerminalRenderView.minimumRows)
    #expect(view.measuredGrid().columns > 0)

    view.frame = NSRect(x: 0, y: 0, width: 100_000, height: 10)
    #expect(view.measuredGrid().columns > TerminalRenderView.minimumColumns)
    #expect(view.measuredGrid().rows == TerminalRenderView.minimumRows)
}

@MainActor
@Test("terminal-integre/AC-9 : la garde de applicationShouldTerminate couvre les trois accroches")
func terminationGuardCoversTheThreeHooks() async {
    let delegate = AppDelegate()
    let savedSession = AppDelegate.terminateSession
    let savedProject = AppDelegate.terminateProject
    let savedTerminal = AppDelegate.terminateTerminal
    defer {
        AppDelegate.terminateSession = savedSession
        AppDelegate.terminateProject = savedProject
        AppDelegate.terminateTerminal = savedTerminal
    }

    AppDelegate.terminateSession = nil
    AppDelegate.terminateProject = nil
    AppDelegate.terminateTerminal = nil
    // Sans accroche, l'app quitte immédiatement (comportement inchangé).
    #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
    // Fermer la dernière fenêtre ne quitte jamais l'app (AC-8).
    #expect(delegate.applicationShouldTerminateAfterLastWindowClosed(NSApplication.shared) == false)

    // L'accroche du TERMINAL seule suffit à faire ATTENDRE l'app (S-8) : la
    // première demande est annulée, l'accroche tourne, puis la terminaison est
    // redemandée et passe (une feuille ouverte ne la bloque plus).
    var called = false
    var requested = false
    delegate.requestTermination = { requested = true }
    AppDelegate.terminateTerminal = { called = true }
    #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
    #expect(await awaitMainTrue { called && requested })
    #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
}

@MainActor
@Test("terminal-integre/AC-10 : la garde du terminal ne dépend ni de la session ni du projet")
func terminalHookIsIndependentFromTheOthers() async {
    let delegate = AppDelegate()
    let savedSession = AppDelegate.terminateSession
    let savedProject = AppDelegate.terminateProject
    let savedTerminal = AppDelegate.terminateTerminal
    defer {
        AppDelegate.terminateSession = savedSession
        AppDelegate.terminateProject = savedProject
        AppDelegate.terminateTerminal = savedTerminal
    }

    var sessionCalled = false
    var terminalCalled = false
    AppDelegate.terminateSession = { sessionCalled = true }
    AppDelegate.terminateProject = nil
    AppDelegate.terminateTerminal = { terminalCalled = true }

    var requested = false
    delegate.requestTermination = { requested = true }
    #expect(delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
    #expect(await awaitMainTrue { sessionCalled && terminalCalled && requested })
}
