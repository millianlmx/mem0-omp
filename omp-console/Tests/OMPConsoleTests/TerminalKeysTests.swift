// Preuves de la table clavier de S-5 : ce qui part dans le PTY, et ce qui n'y part
// jamais. La fonction testée est PURE (`TerminalKeys.bytes`), donc ces preuves ne
// dépendent ni d'une fenêtre, ni d'un process, ni d'un événement synthétique.

import AppKit
import Testing
@testable import OMPConsole

private func bytes(_ characters: String?, _ keyCode: UInt16, _ modifiers: NSEvent.ModifierFlags = []) -> [UInt8]? {
    TerminalKeys.bytes(characters: characters, modifiers: modifiers, keyCode: keyCode)
}

@Test("terminal-integre/AC-5 : le texte imprimable part en UTF-8")
func printableTextIsSentAsUTF8() {
    #expect(bytes("a", 0) == [0x61])
    #expect(bytes("é", 0) == Array("é".utf8))
    #expect(bytes("→", 0) == Array("→".utf8))
    #expect(bytes("", 0) == nil)
    #expect(bytes(nil, 0) == nil)
}

@Test("terminal-integre/AC-5 : les touches de contrôle gardent leur octet legacy")
func controlKeysUseLegacyBytes() {
    #expect(bytes("\r", 36) == [0x0D])              // Retour
    #expect(bytes("\r", 76) == [0x0D])              // Entrée du pavé numérique
    #expect(bytes("\u{7F}", 51) == [0x7F])          // Retour arrière
    #expect(bytes("\t", 48) == [0x09])              // Tabulation
    #expect(bytes("\u{1B}", 53) == [0x1B])          // Échap
}

@Test("terminal-integre/AC-5 : les flèches partent dans le jeu normal (CSI A/B/C/D)")
func arrowsUseNormalCursorKeys() {
    #expect(bytes("\u{F700}", 126) == Array("\u{1B}[A".utf8))   // ↑
    #expect(bytes("\u{F701}", 125) == Array("\u{1B}[B".utf8))   // ↓
    #expect(bytes("\u{F703}", 124) == Array("\u{1B}[C".utf8))   // →
    #expect(bytes("\u{F702}", 123) == Array("\u{1B}[D".utf8))   // ←
}

@Test("terminal-integre/AC-5 : Ctrl-C part comme l'octet 0x03, la discipline de ligne décide du reste")
func controlCIsSentAsAByte() {
    // Deux formes d'AppKit pour la même frappe : le caractère déjà interprété en
    // octet de contrôle, et la lettre nue.
    #expect(bytes("\u{03}", 8, .control) == [0x03])
    #expect(bytes("c", 8, .control) == [0x03])
    #expect(bytes("C", 8, .control) == [0x03])
    #expect(bytes("a", 0, .control) == [0x01])
    #expect(bytes("z", 6, .control) == [0x1A])
}

@Test("terminal-integre/AC-5 : les ponctuations de contrôle et Ctrl-D sont transmises")
func controlPunctuationIsSent() {
    #expect(bytes("d", 2, .control) == [0x04])      // Ctrl-D : fin de fichier pour le shell
    #expect(bytes("\\", 42, .control) == [0x1C])
    #expect(bytes("]", 30, .control) == [0x1D])
    #expect(bytes("^", 43, .control) == [0x1E])
    #expect(bytes("_", 27, .control) == [0x1F])
    #expect(bytes("[", 33, .control) == [0x1B])
}

@Test("terminal-integre/AC-5 : aucun octet 0x00 n'est jamais produit")
func nullByteIsNeverProduced() {
    #expect(bytes("@", 19, .control) == nil)
    #expect(bytes("2", 19, .control) == nil)
    #expect(bytes(" ", 49, .control) == nil)
    #expect(bytes("\u{00}", 0) == nil)
}

@Test("terminal-integre/AC-5 : ⌘, Option et les touches hors périmètre ne partent pas")
func appGesturesAreNotSent() {
    #expect(bytes("c", 8, .command) == nil)
    #expect(bytes("v", 9, .command) == nil)
    #expect(bytes("é", 14, .option) == nil)
    // Les touches de fonction arrivent avec `.function` (c'est ainsi qu'AppKit les
    // livre : le caractère est un scalaire de la zone à usage privé).
    #expect(bytes("\u{F704}", 122, .function) == nil)          // F1
    #expect(bytes("\u{F72C}", 116, .function) == nil)          // PageUp
    #expect(bytes("\u{F72D}", 121, .function) == nil)          // PageDown
    #expect(bytes("\u{F729}", 115, .function) == nil)          // Début
    #expect(bytes("\u{F72B}", 119, .function) == nil)          // Fin
    // … et le drapeau suffit, quelle que soit la charge utile.
    #expect(bytes("a", 0, .function) == nil)
}

@Test("terminal-integre/AC-5 : la touche Maj ne change pas l'octet des flèches ni du texte")
func shiftDoesNotAlterTransmission() {
    #expect(bytes("A", 0, .shift) == [0x41])
    #expect(bytes("\u{F700}", 126, .shift) == Array("\u{1B}[A".utf8))
}
