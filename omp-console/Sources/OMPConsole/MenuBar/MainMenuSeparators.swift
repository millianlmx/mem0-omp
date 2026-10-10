import AppKit

/// Les séparateurs de la barre des menus (S-1, mac-finitions-hig) : aucun n'est
/// visible en tête, en fin ni juste après un autre séparateur visible.
///
/// Les groupes de commandes SwiftUI vides laissent des séparateurs parasites, et
/// AppKit en ajoute tardivement (« Activer le mode plein écran », à l'ouverture
/// du menu ou à une lecture AX). On ne les SUPPRIME pas (SwiftUI réécrit ses items
/// quand l'état d'une commande change) : on les MASQUE, et l'on rejoue la règle à
/// chaque mise à jour d'un menu de la barre.
@MainActor
enum MainMenuSeparators {
    /// Masque ou re-montre les séparateurs de `menu` et de ses sous-menus.
    ///
    /// Un séparateur reste visible si et seulement si un item visible qui n'est pas
    /// un séparateur le précède depuis le dernier séparateur gardé (ou le début),
    /// ET un tel item le suit avant le prochain séparateur gardé (ou la fin).
    ///
    /// Idempotent : `isHidden` n'est écrit que s'il change. Chaque écriture poste
    /// `didChangeItemNotification`, qui relance un passage (`observe()`) ; ce
    /// passage n'écrit rien, et la chaîne s'arrête.
    static func tidy(_ menu: NSMenu) {
        var hasContent = false
        var pending: NSMenuItem?
        for item in menu.items {
            if let submenu = item.submenu { tidy(submenu) }
            if item.isSeparatorItem {
                if hasContent && pending == nil {
                    pending = item
                } else {
                    setHidden(item, true)
                }
            } else if !item.isHidden {
                if let kept = pending {
                    setHidden(kept, false)
                    pending = nil
                }
                hasContent = true
            }
        }
        if let trailing = pending { setHidden(trailing, true) }
    }

    /// Rejoue `tidy` de façon SYNCHRONE à chaque ajout, retrait ou changement d'un
    /// item d'un menu de la barre : un passage asynchrone laisse une lecture AX voir
    /// les doubles (D-3). Les menus hors de `NSApp.mainMenu` (contextuels, barre
    /// d'outils, sélecteurs) ne sont pas touchés. Garder les jetons rendus.
    static func observe() -> [NSObjectProtocol] {
        let names = [NSMenu.didAddItemNotification, NSMenu.didRemoveItemNotification, NSMenu.didChangeItemNotification]
        return names.map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { notification in
                // `queue: nil` : le bloc tourne sur le fil qui poste, et un `NSMenu`
                // n'est modifié que sur le fil principal — ce que `assumeIsolated`
                // atteste, et qui rend sûr le passage du menu dans le bloc.
                nonisolated(unsafe) let menu = notification.object as? NSMenu
                MainActor.assumeIsolated {
                    guard let menu, belongsToMainMenu(menu) else { return }
                    tidy(menu)
                }
            }
        }
    }

    private static func belongsToMainMenu(_ menu: NSMenu) -> Bool {
        guard let main = NSApp.mainMenu else { return false }
        var current: NSMenu? = menu
        while let candidate = current {
            if candidate === main { return true }
            current = candidate.supermenu
        }
        return false
    }

    private static func setHidden(_ item: NSMenuItem, _ hidden: Bool) {
        if item.isHidden != hidden { item.isHidden = hidden }
    }
}
