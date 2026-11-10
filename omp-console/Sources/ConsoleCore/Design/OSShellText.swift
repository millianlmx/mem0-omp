// Les mots de la COQUE de l'« OS agentique » : les deux interfaces (la nouvelle, la
// classique et le moyen d'en revenir), les écrans que ⌘1…⌘5 ouvrent, et la feuille
// « Nouveau fil… » (⌘N). Les outils (Mémoire, Poste, Santé…) gardent le nom de l'écran
// classique qu'ils ouvrent : `ConsoleUI/OS/OSTools.swift` les aiguille.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française et glossaire
// GLOSSAIRE.md. Chaque phrase passe par `L10n` : sa clé est le texte français, sa
// traduction anglaise vit dans `Resources/en.lproj/Localizable.strings`.

import Foundation

public enum OSShellText {
    // MARK: - Les deux interfaces

    public static let newInterface = L10n.text("Nouvelle interface")
    public static let backToNew = L10n.text("Revenir à la nouvelle interface")

    // MARK: - Nouveau fil

    public static let newThreadTitle = L10n.text("Nouveau fil")
    public static let phrase = L10n.text("Que voulez-vous ?")
    public static let moreOptions = L10n.text("Plus d’options")
    public static let expert = L10n.text("Expert")
}
