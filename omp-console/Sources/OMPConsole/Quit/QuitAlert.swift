// L'alerte « Quitter arrêtera… » (mac-quitter-sans-confirmation, S-3) : une
// `NSAlert` modale d'APPLICATION, jamais une feuille, pour s'afficher par-dessus
// une feuille SwiftUI attachée (mesuré, Doc-9 du contrat).
//
// Boutons posés de droite à gauche : « Quitter » à droite, bouton par défaut
// (Retour) ; « Annuler » reçoit Échap EXPLICITEMENT, car AppKit ne le donne qu'à
// un bouton titré « Cancel » en anglais (Doc-5). Aucune case « Ne plus demander ».

import AppKit

@MainActor
enum QuitAlert {
    static let quitIdentifier = "quit.alert.quit"
    static let cancelIdentifier = "quit.alert.cancel"

    static func make(_ prompt: QuitPrompt) -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = prompt.title
        alert.informativeText = prompt.message
        alert.showsSuppressionButton = false

        let quit = alert.addButton(withTitle: QuitText.quitButton)
        quit.setAccessibilityIdentifier(quitIdentifier)

        let cancel = alert.addButton(withTitle: QuitText.cancelButton)
        cancel.keyEquivalent = "\u{1b}"
        cancel.setAccessibilityIdentifier(cancelIdentifier)
        return alert
    }

    /// Montre l'alerte et rend le choix : `.quit` pour le premier bouton, `.cancel`
    /// pour tout le reste. L'activation est coopérative (sans effet si le système
    /// la refuse) : l'alerte ne vole pas le focus d'une autre app.
    static func run(_ prompt: QuitPrompt) -> QuitFlow.Choice {
        NSApp.activate()
        return make(prompt).runModal() == .alertFirstButtonReturn ? .quit : .cancel
    }
}
