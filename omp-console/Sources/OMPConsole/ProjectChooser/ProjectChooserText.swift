// Les textes du sélecteur de projet des états vides de Mémoire, Fichiers et
// Terminal (S-1, S-2 de mac-etats-vides-sans-issue).
//
// Aucun raccourci clavier n'est nommé ici (AC-6) : le libellé est le même sur un
// clavier AZERTY ou QWERTY.

import Foundation

enum ProjectChooserText {
    /// Le bouton (ou le bouton de menu) de l'état vide. Points de suspension
    /// U+2026 : le geste ouvre un choix.
    static let choose = "Choisir un projet…"
    /// La dernière entrée du menu : le panneau d'ouverture.
    static let chooseFolder = "Choisir un dossier…"
    static let panelPrompt = "Choisir"
    static let panelMessage = "Choisissez le dossier du projet."
}
