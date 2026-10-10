// Écriture du diagnostic dans le presse-papiers (S-1 de jargon-technique-expose-mac-et-ios).
//
// `clearContents()` d'abord : sans propriétaire déclaré, `setString` est refusé.
// Le texte est copié tel quel — ni rognage, ni ajout, retours à la ligne gardés —
// puisqu'il sert à un signalement. Le paramètre `pasteboard` laisse les tests
// écrire dans un presse-papiers nommé unique, jamais dans celui de l'utilisateur.

import AppKit

enum DiagnosticPasteboard {
    @MainActor
    static func copy(_ text: String, to pasteboard: NSPasteboard = .general) {
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }
}
