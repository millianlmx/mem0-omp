// Le vocabulaire PROPRE aux menus contextuels de l'app iOS
// (ios-gestes-et-retours-natifs, S-4) : le symbole système de « Copier ». Le
// libellé de l'entrée est celui du contrôle existant (`MemoryText`), jamais
// recopié ici.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`) : la garde `design-ios/AC-5`
// n'autorise un littéral alphabétique hors de ces fichiers que s'il commence par
// `ios.` ou `-`.

/// Le symbole des menus contextuels.
enum IOSMenuText {
    /// Le symbole système de « Copier » (HIG Context menus : « Use the same icons
    /// as the system to represent actions such as Copy »).
    static let copySymbol = "doc.on.doc"
}
