// Preuves de la construction de l'alerte AppKit (mac-quitter-sans-confirmation,
// S-3), sans `runModal` : boutons, Échap = Annuler, pas de case de suppression.

import AppKit
import Testing
@testable import OMPConsole

@MainActor
private func sessionAlert() throws -> (QuitPrompt, NSAlert) {
    let prompt = try #require(QuitPrompt.make([.session(name: "mem0-omp")]))
    return (prompt, QuitAlert.make(prompt))
}

@Test("mac-quitter-sans-confirmation/AC-1 : l'alerte porte le texte du prompt et les boutons Quitter puis Annuler")
@MainActor
func quitAlertCarriesPromptAndButtons() throws {
    let (prompt, alert) = try sessionAlert()
    #expect(alert.alertStyle == .warning)
    #expect(alert.messageText == prompt.title)
    #expect(alert.informativeText == prompt.message)
    #expect(alert.buttons.map(\.title) == ["Quitter", "Annuler"])
    #expect(alert.buttons[0].keyEquivalent == "\r")
    #expect(alert.buttons[0].accessibilityIdentifier() == "quit.alert.quit")
    #expect(alert.buttons[1].accessibilityIdentifier() == "quit.alert.cancel")
}

@Test("mac-quitter-sans-confirmation/AC-3 : Échap déclenche Annuler, et aucune case « Ne plus demander »")
@MainActor
func quitAlertEscapeCancelsWithoutSuppression() throws {
    let (_, alert) = try sessionAlert()
    #expect(alert.buttons[1].keyEquivalent == "\u{1b}")
    #expect(alert.buttons[1].keyEquivalentModifierMask.isEmpty)
    #expect(alert.showsSuppressionButton == false)
}
