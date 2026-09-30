// Preuves de l'émulateur VT : parsing CSI/SGR/OSC, décodage UTF-8 incrémental,
// réponses aux sondes, écran alterné, mélange de flux réel (S-3).
//
// Les flux rejoués sont des extraits LITTÉRAUX de l'inventaire MESURÉ de Doc-1
// (listes SGR mixtes, APC kitty-graphics, séquences d'écran) : chaque cas existe
// parce qu'omp l'émet réellement.

import Foundation
import Testing

@testable import OMPConsole

private let testPalette = TerminalPalette(
    defaultForeground: TerminalRGB(0xE6, 0xE6, 0xE6),
    defaultBackground: TerminalRGB(0x14, 0x14, 0x14)
)

private func bytes(_ text: String) -> [UInt8] { Array(text.utf8) }

private func trimmed(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespaces)
}

@MainActor
private func makeEmulator(columns: Int = 80, rows: Int = 24) -> TerminalEmulator {
    TerminalEmulator(columns: columns, rows: rows, palette: testPalette)
}

@MainActor
@Suite("terminal-integre/émulateur")
struct TerminalEmulatorTests {
    // MARK: Flux réel

    @Test("terminal-integre/AC-1 : un extrait réel du flux d'omp pose rangées, attributs et curseur")
    func realStreamExcerpt() {
        let emulator = makeEmulator(columns: 20, rows: 24)
        var stream = bytes("\u{1B}[?25l\u{1B}[?2026h\u{1B}[?7l")
        stream += bytes("\u{1B}_Ga=d,d=A,q=2\u{1B}\\")
        stream += bytes("\u{1B}[H\u{1B}[2J\u{1B}[3J")
        stream += bytes("\u{1B}[1;38;2;0;180;255mhello\u{1B}[0m")
        stream += bytes("\u{1B}[K\u{1B}[24;1H")
        emulator.feed(stream)

        let screen = emulator.screen
        #expect(screen.text(row: 0).hasPrefix("hello"))
        #expect(screen.line(0)[0].attributes.bold)
        #expect(screen.line(0)[0].attributes.foreground == .rgb(0, 180, 255))
        #expect(screen.line(0)[5].attributes == .plain)
        #expect(screen.cursor == TerminalCursor(row: 23, column: 0))
        #expect(screen.cursorVisible == false)
        #expect(screen.autowrap == false)
        #expect(screen.changedRows.contains(0))
        #expect(screen.changedRows.contains(23))
        // L'APC kitty-graphics (`ESC _G…ESC \`) n'a rien peint.
        #expect(trimmed(screen.text(row: 5)).isEmpty)
    }

    @Test("terminal-integre/AC-1 : les sondes DA1, CPR et OSC 11 répondent, dans l'ordre du parsing")
    func probeReplies() {
        let emulator = makeEmulator(columns: 40, rows: 10)
        var replies: [[UInt8]] = []
        emulator.onReply = { replies.append($0) }

        emulator.feed(bytes("abc"))
        emulator.feed(bytes("\u{1B}[c"))
        emulator.feed(bytes("\u{1B}[6n"))
        emulator.feed(bytes("\u{1B}[5;10H\u{1B}[6n\u{1B}[1;1H\u{1B}[6n"))
        emulator.feed(bytes("\u{1B}]11;?\u{07}"))

        #expect(replies.count == 5)
        #expect(replies[0] == bytes("\u{1B}[?1;2c"))
        #expect(replies[1] == bytes("\u{1B}[1;4R"))
        #expect(replies[2] == bytes("\u{1B}[5;10R"))
        #expect(replies[3] == bytes("\u{1B}[1;1R"))
        #expect(replies[4] == bytes("\u{1B}]11;rgb:1414/1414/1414\u{07}"))
    }

    @Test("terminal-integre/AC-1 : DA1 et CPR n'ont AUCUNE réponse sous forme privée ou sans demande")
    func noSpuriousReplies() {
        let emulator = makeEmulator(columns: 20, rows: 5)
        var replies: [[UInt8]] = []
        emulator.onReply = { replies.append($0) }

        emulator.feed(bytes("\u{1B}[>c\u{1B}[?1;2c\u{1B}[?u\u{1B}[?2031$p\u{1B}[16t"))
        #expect(replies.isEmpty)
    }

    // MARK: SGR

    @Test("terminal-integre/AC-1 : les listes SGR mixtes mesurées sont interprétées en entier")
    func mixedSGRLists() {
        let emulator = makeEmulator(columns: 40, rows: 6)
        emulator.feed(bytes("\u{1B}[0;38;2;15;18;22mA"))
        #expect(emulator.screen.line(0)[0].attributes.foreground == .rgb(15, 18, 22))

        emulator.feed(bytes("\u{1B}[39;38;2;156;163;176mB"))
        #expect(emulator.screen.line(0)[1].attributes.foreground == .rgb(156, 163, 176))

        emulator.feed(bytes("\u{1B}[1;22;39mC"))
        #expect(emulator.screen.line(0)[2].attributes.foreground == .default)
        #expect(emulator.screen.line(0)[2].attributes.bold == false)

        emulator.feed(bytes("\u{1B}[38;2;107;114;128;3mD"))
        #expect(emulator.screen.line(0)[3].attributes.foreground == .rgb(107, 114, 128))
        #expect(emulator.screen.line(0)[3].attributes.italic)

        emulator.feed(bytes("\u{1B}[48;2;15;18;22;39mE"))
        #expect(emulator.screen.line(0)[4].attributes.background == .rgb(15, 18, 22))
        #expect(emulator.screen.line(0)[4].attributes.foreground == .default)

        emulator.feed(bytes("\u{1B}[1;38;2;0;180;255mF"))
        #expect(emulator.screen.line(0)[5].attributes.bold)
        #expect(emulator.screen.line(0)[5].attributes.foreground == .rgb(0, 180, 255))

        emulator.feed(bytes("\u{1B}[0;49mG"))
        #expect(emulator.screen.line(0)[6].attributes == .plain)
    }

    @Test("terminal-integre/AC-1 : les 16, 256 couleurs et les retraits SGR sont couverts")
    func indexedAndResetSGR() {
        let emulator = makeEmulator(columns: 20, rows: 4)
        emulator.feed(bytes("\u{1B}[31mA"))
        #expect(emulator.screen.line(0)[0].attributes.foreground == .indexed(1))
        emulator.feed(bytes("\u{1B}[94mB"))
        #expect(emulator.screen.line(0)[1].attributes.foreground == .indexed(12))
        emulator.feed(bytes("\u{1B}[38;5;196mC"))
        #expect(emulator.screen.line(0)[2].attributes.foreground == .indexed(196))
        emulator.feed(bytes("\u{1B}[48;5;240mD"))
        #expect(emulator.screen.line(0)[3].attributes.background == .indexed(240))
        emulator.feed(bytes("\u{1B}[38;5;300mE"))
        #expect(emulator.screen.line(0)[4].attributes.foreground == .default)
        emulator.feed(bytes("\u{1B}[38;2;300;0;0mF"))
        #expect(emulator.screen.line(0)[5].attributes.foreground == .rgb(255, 0, 0))
        emulator.feed(bytes("\u{1B}[4;24mG"))
        #expect(emulator.screen.line(0)[6].attributes.underline == false)
    }

    @Test("terminal-integre/AC-1 : `CSI >4;2m` (modifyOtherKeys) n'est PAS du SGR")
    func modifyOtherKeysIsNotSGR() {
        let emulator = makeEmulator(columns: 10, rows: 2)
        emulator.feed(bytes("\u{1B}[>4;2mA"))
        #expect(emulator.screen.line(0)[0].attributes == .plain)
    }

    // MARK: Robustesse

    @Test("terminal-integre/AC-1 : un paramètre énorme est borné et une séquence inconnue ne corrompt rien")
    func unknownSequencesAndHugeParams() {
        let emulator = makeEmulator(columns: 10, rows: 24)
        emulator.feed(bytes("A"))
        emulator.feed(bytes("\u{1B}[1;2;3;4;5z"))
        emulator.feed(bytes("\u{1B}[0 q"))
        emulator.feed(bytes("\u{1B}[16t\u{1B}[22;2t\u{1B}[23;2t"))
        emulator.feed(bytes("\u{1B}]0;titre\u{07}"))
        emulator.feed(bytes("\u{1B}[?1000h\u{1B}[?1006h\u{1B}[?2004h"))

        #expect(trimmed(emulator.screen.text(row: 0)) == "A")
        #expect(emulator.screen.cursor == TerminalCursor(row: 0, column: 1))

        emulator.feed(bytes("\u{1B}[9999HA"))
        #expect(emulator.screen.cursor == TerminalCursor(row: 23, column: 1))
        #expect(trimmed(emulator.screen.text(row: 23)) == "A")
    }

    @Test("terminal-integre/AC-1 : une chaîne OSC non terminée est abandonnée après 4 096 octets, sans peindre")
    func unterminatedOSCIsAbandoned() {
        let emulator = makeEmulator(columns: 10, rows: 2)
        var replies: [[UInt8]] = []
        emulator.onReply = { replies.append($0) }

        emulator.feed(bytes("\u{1B}]11;"))
        emulator.feed(Array(repeating: UInt8(ascii: "x"), count: 5_000))
        #expect(replies.isEmpty)
        #expect(trimmed(emulator.screen.text(row: 0)).isEmpty)

        emulator.feed(bytes("\u{07}Z"))
        #expect(replies.isEmpty)
        #expect(trimmed(emulator.screen.text(row: 0)) == "Z")
    }

    @Test("terminal-integre/AC-1 : un caractère UTF-8 coupé entre deux feed n'engendre aucun U+FFFD")
    func utf8SplitAcrossFeeds() {
        let emulator = makeEmulator(columns: 10, rows: 2)
        let emoji = Array("😀".utf8)
        emulator.feed([emoji[0], emoji[1]])
        emulator.feed([emoji[2]])
        emulator.feed([emoji[3]])
        emulator.feed(bytes("!"))

        #expect(emulator.screen.line(0)[0].text == "😀")
        #expect(emulator.screen.line(0)[0].width == 2)
        #expect(emulator.screen.line(0)[2].text == "!")
        #expect(emulator.screen.text(row: 0).contains("\u{FFFD}") == false)

        // Séquences invalides : ignorées, jamais remplacées ni écrites.
        emulator.feed(bytes("\u{1B}[1;1H\u{1B}[2K"))
        emulator.feed([0xC0, 0x80, 0xE0, 0x80])
        #expect(emulator.screen.text(row: 0).contains("\u{FFFD}") == false)
        #expect(trimmed(emulator.screen.text(row: 0)).isEmpty)
        emulator.feed(bytes("ok"))
        #expect(trimmed(emulator.screen.text(row: 0)) == "ok")
    }

    @Test("terminal-integre/AC-1 : `?1049h` bascule sur un tampon vierge, `?1049l` restaure écran ET curseur")
    func alternateScreen() {
        let emulator = makeEmulator(columns: 10, rows: 3)
        emulator.feed(bytes("normal"))
        emulator.feed(bytes("\u{1B}[2;3H"))
        emulator.feed(bytes("\u{1B}[?1049h"))

        #expect(trimmed(emulator.screen.text(row: 0)).isEmpty)
        #expect(emulator.screen.cursor == TerminalCursor(row: 0, column: 0))

        emulator.feed(bytes("\u{1B}[2;2Halt"))
        #expect(trimmed(emulator.screen.text(row: 1)) == "alt")

        emulator.feed(bytes("\u{1B}[?1049l"))
        #expect(trimmed(emulator.screen.text(row: 0)) == "normal")
        #expect(emulator.screen.cursor == TerminalCursor(row: 1, column: 2))

        // `?1049l` sans `?1049h` : sans effet.
        emulator.feed(bytes("\u{1B}[?1049l"))
        #expect(trimmed(emulator.screen.text(row: 0)) == "normal")
    }

    // MARK: Critères côté grille

    @Test("terminal-integre/AC-3 : le message d'échec du lancement se rend dans la grille, jamais un écran vide")
    func failureMessageIsRendered() {
        let emulator = makeEmulator(columns: 60, rows: 6)
        emulator.feed(bytes("Répertoire introuvable : /tmp/absent."))
        #expect(trimmed(emulator.screen.text(row: 0)) == "Répertoire introuvable : /tmp/absent.")
        #expect(emulator.screen.changedRows.contains(0))
    }

    @Test("terminal-integre/AC-5 : le texte tapé, reflété par le TUI, reste dans la grille et Ctrl-C ne la touche pas")
    func typedTextIsReflected() {
        let emulator = makeEmulator(columns: 20, rows: 4)
        emulator.feed(bytes("hello"))
        emulator.feed(bytes("\r\n"))
        #expect(trimmed(emulator.screen.text(row: 0)) == "hello")
        #expect(emulator.screen.cursor.row == 1)

        emulator.feed([0x03]) // Ctrl-C : caractère de contrôle sans effet sur la grille
        #expect(trimmed(emulator.screen.text(row: 0)) == "hello")

        emulator.feed(bytes("\u{1B}[1;1Htest\u{1B}[K"))
        #expect(trimmed(emulator.screen.text(row: 0)) == "test")
    }

    @Test("terminal-integre/AC-6 : la réponse du modèle s'affiche avec son thème truecolor")
    func modelResponseIsRendered() {
        let emulator = makeEmulator(columns: 40, rows: 6)
        emulator.feed(bytes("\u{1B}[1;38;2;0;180;255m⏺\u{1B}[0m "))
        emulator.feed(bytes("La réponse du modèle est arrivée."))

        #expect(emulator.screen.line(0)[0].text == "⏺")
        #expect(emulator.screen.line(0)[0].attributes.bold)
        #expect(emulator.screen.line(0)[0].attributes.foreground == .rgb(0, 180, 255))
        #expect(trimmed(emulator.screen.text(row: 0)) == "⏺ La réponse du modèle est arrivée.")
    }

    @Test("terminal-integre/AC-7 : resize réancre le contenu et rend TOUTES les rangées modifiées")
    func resizeMarksEveryRow() {
        let emulator = makeEmulator(columns: 5, rows: 2)
        emulator.feed(bytes("abc"))
        emulator.feed(bytes("\u{1B}[2;1Hde"))
        emulator.clearChanged()
        #expect(emulator.screen.changedRows.isEmpty)

        emulator.resize(columns: 8, rows: 4)
        #expect(emulator.screen.columns == 8)
        #expect(emulator.screen.rows == 4)
        #expect(emulator.screen.text(row: 0).hasPrefix("abc"))
        #expect(emulator.screen.text(row: 1).hasPrefix("de"))
        #expect(emulator.screen.changedRows == Set([0, 1, 2, 3]))
    }
}
