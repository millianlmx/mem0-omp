// Le vocabulaire de la coque de l'app (l'« OS agentique ») sur iPhone et iPad : le nom de
// l'onglet des fils, le geste « Demander » de chaque barre, et les symboles des onglets et
// des boutons de barre. Les autres mots viennent du noyau partagé (`OSText`, `OSWatchText`,
// `OSDecideText`, `OSSystemDestination`), communs au Mac.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`) : typographie française et glossaire
// `GLOSSAIRE.md` ; la garde `design-ios/AC-5` n'autorise un littéral alphabétique hors de
// ces fichiers que s'il commence par `ios.` ou `-`.

import ConsoleCore

enum IOSOSText {
    /// L'onglet de la liste des fils.
    static let threads = L10n.text("Fils")

    /// Le bouton de barre de chaque onglet : il ouvre la feuille du composeur.
    static let ask = L10n.text("Demander à l’OS")

    /// La page d'un fil que le serveur ne connaît plus (oublié, purgé).
    static let threadGone = L10n.text("Ce fil n’existe plus")

    // --- symboles ---------------------------------------------------------------

    static let nowSymbol = "dot.radiowaves.left.and.right"
    static let threadsSymbol = "bubble.left.and.bubble.right"
    static let decisionsSymbol = "rectangle.stack"
    static let proposalsSymbol = "lightbulb"
    static let knowledgeSymbol = "books.vertical"
    static let askSymbol = "sparkles"
    static let understandSymbol = "text.magnifyingglass"
    static let threadGoneSymbol = "questionmark.circle"
    /// La roue de la barre de chaque onglet : le hub Système.
    static let systemSymbol = "gearshape"
}
