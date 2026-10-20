// La fenêtre principale : la ramener au premier plan est partagé par les commandes
// de menu (sections ⌘1…⌘8) et par l'intent « Ouvrir OMP Console ».

import AppKit

enum MainWindow {
    /// L'identifiant de la scène `WindowGroup` de la fenêtre principale.
    static let sceneID = "main"

    /// La fenêtre principale, visible ou fermée. Elle se reconnaît à son
    /// identifiant AppKit, que SwiftUI dérive de celui de la scène
    /// (`main-AppWindow-1`, mesuré) — pas à son titre, qui suit la section courante.
    /// Une fenêtre fermée reste dans `NSApp.windows` (invisible).
    @MainActor
    static func window() -> NSWindow? {
        let prefix = "\(sceneID)-"
        return NSApp.windows.first {
            $0.canBecomeMain && ($0.identifier?.rawValue.hasPrefix(prefix) ?? false)
        }
    }

    /// Une feuille est attachée à la fenêtre principale.
    @MainActor
    static func hasAttachedSheet() -> Bool {
        window()?.attachedSheet != nil
    }

    /// La fenêtre principale redevient visible et au premier plan :
    /// `makeKeyAndOrderFront` ramène aussi une fenêtre fermée.
    @MainActor
    static func reveal() {
        window()?.makeKeyAndOrderFront(nil)
        // `activate(ignoringOtherApps:)` est dépréciée, mais c'est la seule des deux
        // formes dont l'effet est MESURÉ (fenêtre clé et principale, app active).
        NSApp.activate(ignoringOtherApps: true)
    }
}
