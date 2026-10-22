// Preuves du texte de l'alerte « Quitter arrêtera… » (mac-quitter-sans-confirmation,
// S-3) : ce qui déclenche l'alerte et l'effet vrai de la sortie.

import Foundation
import Testing
@testable import OMPConsole

@Test("mac-quitter-sans-confirmation/AC-1 : une commande du Terminal déclenche l'alerte, nommée")
func quitPromptTerminalAlone() throws {
    let prompt = try #require(QuitPrompt.make([.terminalCommand(name: "sleep")]))
    #expect(prompt.title == "Quitter arrêtera des activités en cours.")
    #expect(prompt.message == "La commande « sleep » du Terminal s’arrêtera.")
}

@Test("mac-quitter-sans-confirmation/AC-8 : sans activité, aucune alerte")
func quitPromptNothingStops() {
    #expect(QuitPrompt.make([]) == nil)
}

@Test("mac-quitter-sans-confirmation/AC-6 : sans nom lisible, la ligne prend sa variante générique")
func quitPromptUnnamedVariant() throws {
    let blank = try #require(QuitPrompt.make([.terminalCommand(named: "  ")]))
    let none = try #require(QuitPrompt.make([.terminalCommand(named: nil)]))
    #expect(blank.message == "La commande en cours dans le Terminal s’arrêtera.")
    #expect(none == blank)
}
