// Les textes du sélecteur de projet des états vides de Mémoire, Fichiers et
// Terminal (S-1, S-2 de mac-etats-vides-sans-issue).
//
// Aucun raccourci clavier n'est nommé ici (AC-6) : le libellé est le même sur un
// clavier AZERTY ou QWERTY. « Choisir un dossier… », dernière entrée du menu, est
// le libellé de Session OMP (`SessionConsoleText.chooseFolder`), pas une copie.

import Foundation

enum ProjectChooserText {
    /// Le bouton (ou le bouton de menu) de l'état vide. Points de suspension
    /// U+2026 : le geste ouvre un choix.
    static let choose = "Choisir un projet…"
}
