// Les textes du sélecteur de projet des états vides de Mémoire, Fichiers et
// Terminal (S-1, S-2 de mac-etats-vides-sans-issue).
//
// Aucun raccourci clavier n'est nommé ici (AC-6) : le libellé est le même sur un
// clavier AZERTY ou QWERTY.

import ConsoleCore
import Foundation

enum ProjectChooserText {
    /// Le bouton (ou le bouton de menu) de l'état vide. Points de suspension
    /// U+2026 : le geste ouvre un choix.
    static let choose = L10n.text("Choisir un projet…")
    /// La dernière entrée du menu : le panneau d'ouverture.
    static let chooseFolder = L10n.text("Choisir un dossier…")
    static let panelPrompt = L10n.text("Choisir")
    static let panelMessage = L10n.text("Choisissez le dossier du projet.")
}
