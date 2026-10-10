// Preuves de S-1 (mac-finitions-hig) sur de vrais `NSMenu`, sans barre des menus :
// la règle des séparateurs de `MainMenuSeparators.tidy` et le refus des onglets
// posé par `AppDelegate.applicationWillFinishLaunching`.
//
// La liste des menus de l'app lancée (S-1 R4/R5) est relue par AX sur une
// instance de recette : `omp-console/build/mac-finitions-hig/apres/menus.txt`.

import AppKit
import Testing
@testable import OMPConsole

/// Un menu décrit par une chaîne : « - » est un séparateur, tout autre mot un item.
@MainActor
private func menu(_ layout: String) -> NSMenu {
    let menu = NSMenu(title: "Test")
    for token in layout.split(separator: " ") {
        menu.addItem(token == "-" ? .separator() : NSMenuItem(title: String(token), action: nil, keyEquivalent: ""))
    }
    return menu
}

/// Ce qu'on voit du menu : les items visibles, « - » pour un séparateur.
@MainActor
private func visible(_ menu: NSMenu) -> String {
    menu.items.filter { !$0.isHidden }.map { $0.isSeparatorItem ? "-" : $0.title }.joined(separator: " ")
}

/// Compte les `didChangeItemNotification` postées pour `menu` pendant `body`.
@MainActor
private func changeNotifications(of menu: NSMenu, during body: () -> Void) -> Int {
    final class Counter: @unchecked Sendable { var value = 0 }
    let counter = Counter()
    let token = NotificationCenter.default.addObserver(
        forName: NSMenu.didChangeItemNotification, object: menu, queue: nil
    ) { _ in counter.value += 1 }
    body()
    NotificationCenter.default.removeObserver(token)
    return counter.value
}

@MainActor
@Test("mac-finitions-hig/AC-1 : aucune entrée d'onglet, aucun séparateur en tête, en fin ni en double")
func mainMenuHasNoTabsNorStraySeparators() {
    // Onglets : le délégué les refuse avant la première fenêtre.
    let previous = NSWindow.allowsAutomaticWindowTabbing
    defer { NSWindow.allowsAutomaticWindowTabbing = previous }
    NSWindow.allowsAutomaticWindowTabbing = true
    AppDelegate().applicationWillFinishLaunching(Notification(name: NSApplication.willFinishLaunchingNotification))
    #expect(NSWindow.allowsAutomaticWindowTabbing == false)

    // Séparateurs de tête, de fin et doubles masqués — jamais supprimés.
    let fichier = menu("- Nouvelle Session Piloter - - Fermer -")
    MainMenuSeparators.tidy(fichier)
    #expect(visible(fichier) == "Nouvelle Session Piloter - Fermer")
    #expect(fichier.items.count == 8)

    // Un séparateur entre deux items visibles reste visible.
    let aide = menu("Évaluation - Bienvenue")
    MainMenuSeparators.tidy(aide)
    #expect(visible(aide) == "Évaluation - Bienvenue")

    // Un menu fait seulement de séparateurs : tous masqués. Un menu vide : rien.
    let separators = menu("- - -")
    MainMenuSeparators.tidy(separators)
    #expect(visible(separators) == "")
    let empty = NSMenu(title: "Vide")
    MainMenuSeparators.tidy(empty)
    #expect(empty.items.isEmpty)

    // Un item non séparateur masqué ne compte pas : le séparateur qu'il séparait
    // devient de fin et se masque ; l'item lui-même n'est jamais touché.
    let presentation = menu("Barre - Masqué")
    presentation.items[2].isHidden = true
    MainMenuSeparators.tidy(presentation)
    #expect(visible(presentation) == "Barre")
    #expect(presentation.items[2].isHidden)

    // L'item redevient visible : son séparateur réapparaît au passage suivant.
    presentation.items[2].isHidden = false
    MainMenuSeparators.tidy(presentation)
    #expect(visible(presentation) == "Barre - Masqué")

    // Un sous-menu est traité comme son parent.
    let fenetre = menu("Minimiser Déplacer")
    let sub = menu("- Moitiés - - Quarts -")
    fenetre.setSubmenu(sub, for: fenetre.items[1])
    MainMenuSeparators.tidy(fenetre)
    #expect(visible(sub) == "Moitiés - Quarts")

    // Idempotence : le premier passage écrit (et notifie), le second n'écrit rien,
    // donc la chaîne de rappels synchrones d'`observe()` s'arrête.
    let menuBar = menu("- A - - B -")
    #expect(changeNotifications(of: menuBar) { MainMenuSeparators.tidy(menuBar) } > 0)
    #expect(changeNotifications(of: menuBar) { MainMenuSeparators.tidy(menuBar) } == 0)
    #expect(visible(menuBar) == "A - B")
}
