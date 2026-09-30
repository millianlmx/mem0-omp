// Ouvrir une PR dans le navigateur par défaut (S-4) : un protocole pour être doublé,
// et le seul appelant de `NSWorkspace.open(_:)` (docs §5).

import AppKit
import Foundation

/// L'ouvreur d'URL injecté. `Sendable` : le geste vit dans le modèle `@MainActor`,
/// et l'implémentation système n'a aucun état.
protocol URLOpening: Sendable {
    /// `true` si l'ouverture a réussi (S-4).
    func open(_ url: URL) -> Bool
}

struct SystemURLOpener: URLOpening {
    func open(_ url: URL) -> Bool {
        NSWorkspace.shared.open(url)
    }
}
