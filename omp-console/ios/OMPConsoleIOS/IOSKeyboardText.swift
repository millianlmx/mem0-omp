// Le vocabulaire des commandes clavier de l'iPad (ipad-clavier-et-largeur-de-lecture,
// S-2) : les deux libellés propres à la barre des menus et les trois touches de
// lettre. Les libellés de section viennent de `ConsoleSection.title`, celui de
// « Nouvelle feature… » de `NewFeatureText.command` : rien n'est recopié ici.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`) : la garde `design-ios/AC-5`
// n'autorise une touche littérale (« r », « f », « n ») que dans ces fichiers-là ;
// `IOSKeyboardCommands` la lit par `KeyEquivalent(IOSKeyboardText.…Key)`. Aucun
// import de SwiftUI : une touche reste un simple `Character`.

/// Les mots et les touches des commandes clavier de l'iPad.
enum IOSKeyboardText {
    /// La commande qui relit les données de l'écran courant (⌘R).
    static let refresh = "Rafraîchir"
    /// La commande qui active le champ de recherche de l'écran courant (⌘F).
    static let search = "Rechercher"

    /// La touche de « Rafraîchir », avec ⌘.
    static let refreshKey: Character = "r"
    /// La touche de « Rechercher », avec ⌘.
    static let searchKey: Character = "f"
    /// La touche de « Nouvelle feature… », avec ⌘.
    static let newFeatureKey: Character = "n"
}
