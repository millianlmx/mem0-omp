// Le vocabulaire de la coque iOS : la barre latérale de l'iPad, le libellé
// d'accessibilité d'un onglet et les symboles des écrans du serveur de pipelines. Les
// mots des écrans du serveur vivent dans le noyau partagé (`PipelineServerText`,
// `ShellText`), communs au Mac.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`) : typographie française et
// glossaire `GLOSSAIRE.md` ; la garde `design-ios/AC-5` n'autorise un littéral
// alphabétique hors de ces fichiers que s'il commence par `ios.` ou `-`.

import ConsoleCore

enum IOSShellText {
    /// Le titre « OMP Console » de la coque : en-tête de la barre latérale de l'iPad
    /// (`tabViewSidebarHeader`), invisible sur iPhone.
    static let rootTitle = "OMP Console"

    /// Le mot qui suit le nombre d'un badge visible dans le libellé d'un onglet.
    static let rowPending = L10n.text("en attente")

    /// Le libellé d'accessibilité d'un onglet de section : le titre, suivi du badge
    /// QUAND il est visible (`badge > 0`).
    static func sectionRowLabel(_ title: String, badge: Int) -> String {
        badge > 0 ? "\(title), \(badge) \(rowPending)" : title
    }

    /// Le symbole d'une option choisie.
    static let selectedSymbol = "checkmark"

    // --- écrans du serveur de pipelines ----------------------------------------

    static let serverSymbol = "server.rack"
    static let addSymbol = "plus"
}
