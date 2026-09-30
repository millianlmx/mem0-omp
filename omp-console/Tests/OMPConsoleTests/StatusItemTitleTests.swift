// Preuves de l'item de barre de menus (BR-5, S-2) : son TITRE est une fonction pure
// (AC-8), et la vie de l'app après fermeture de la fenêtre est un retour de délégué
// directement testable (AC-9).
//
// Aucun `NSStatusBar` n'est construit ici : mesuré (Doc-9), l'instancier tue un
// processus de test. Le câblage AppKit de `StatusItemController` est prouvé par la
// recette (S-10).

import AppKit
import Foundation
import Testing
@testable import OMPConsole

// MARK: - AC-8 : icône seule ou « occupés · en attente »

@Test("notifications-et-barre-de-menus/AC-8 : zéro run ⇒ icône seule ; un run occupé ou en attente ⇒ le titre porte les deux chiffres")
func statusItemTitleFollowsCounters() {
    // Rien de connu, ou magasin absent : icône seule.
    #expect(StatusItemTitle.text(for: .loading) == "")
    #expect(StatusItemTitle.text(for: .storeAbsent(dir: "/tmp/magasin")) == "")
    // Zéro et zéro : icône seule, jamais « 0·0 ».
    #expect(StatusItemTitle.text(for: .ready(.zero)) == "")
    // Dès qu'un compteur est non nul, les DEUX chiffres sont présents (position
    // non ambiguë), séparés par le point médian U+00B7.
    #expect(StatusItemTitle.text(for: .ready(RunCounters(busy: 2, waiting: 0))) == "2\u{00B7}0")
    #expect(StatusItemTitle.text(for: .ready(RunCounters(busy: 0, waiting: 3))) == "0\u{00B7}3")
    #expect(StatusItemTitle.text(for: .ready(RunCounters(busy: 12, waiting: 4))) == "12\u{00B7}4")
}

// MARK: - AC-9 : fermer la fenêtre ne quitte pas l'app

@MainActor
@Test("notifications-et-barre-de-menus/AC-9 : fermer la dernière fenêtre ne termine pas l'app (⌘Q seul quitte)")
func closingLastWindowDoesNotTerminate() {
    // Le retour du délégué est directement exécutable dans un processus de test
    // (mesuré, Doc-9) : `false` = l'app reste vivante, l'item de barre demeure.
    let delegate = AppDelegate()
    #expect(delegate.applicationShouldTerminateAfterLastWindowClosed(NSApplication.shared) == false)
}
