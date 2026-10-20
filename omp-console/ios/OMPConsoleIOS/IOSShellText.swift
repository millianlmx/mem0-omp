// Le vocabulaire de la coque iOS : la barre latérale de l'iPad, l'onglet « Plus »
// de l'iPhone, le libellé d'accessibilité d'un onglet et les symboles des écrans
// du serveur de pipelines. Les mots des écrans du serveur vivent dans le noyau
// partagé (`PipelineServerText`), communs au Mac.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`) : typographie française et
// glossaire `GLOSSAIRE.md` ; la garde `design-ios/AC-5` n'autorise un littéral
// alphabétique hors de ces fichiers que s'il commence par `ios.` ou `-`.

import ConsoleCore

enum IOSShellText {
    /// Le titre « OMP Console » de la coque : en-tête de la barre latérale de l'iPad
    /// (`tabViewSidebarHeader`), invisible sur iPhone.
    static let rootTitle = "OMP Console"

    /// Le libellé du dernier onglet de l'iPhone et le titre de navigation de sa
    /// liste, qui pousse les sections rangées sous « Plus ».
    static let plusTitle = "Plus"
    /// Le symbole SF de l'onglet « Plus ».
    static let plusSymbol = "ellipsis"

    /// Le mot qui suit le nombre d'un badge visible dans le libellé d'un onglet.
    static let rowPending = "en attente"

    /// Le libellé d'accessibilité d'un onglet de section : le titre, suivi du badge
    /// QUAND il est visible (`badge > 0`).
    static func sectionRowLabel(_ title: String, badge: Int) -> String {
        badge > 0 ? "\(title), \(badge) \(rowPending)" : title
    }

    /// Le symbole d'une option choisie.
    static let selectedSymbol = "checkmark"

    // --- écrans du serveur de pipelines ----------------------------------------

    static let serverSymbol = "server.rack"
    static let warningSymbol = "exclamationmark.triangle.fill"
    static let weakVerdictSymbol = "eyeglasses"
    static let escalationSymbol = "questionmark.bubble"
    static let specsSymbol = "doc.text.magnifyingglass"
    static let verdictSymbol = "checkmark.seal"
    static let decisionSymbol = "arrow.uturn.backward.circle"
    static let auditSymbol = "checklist"
    static let activeSymbol = "gearshape.2"
    static let addSymbol = "plus"
    static let pickedSymbol = "checkmark.circle.fill"
    static let unpickedSymbol = "circle"
    /// Une ligne de liste (« · élément »).
    static func bullet(_ item: String) -> String { "· " + item }
    /// « Faiblesse · motif »
    static func proposalDetail(kind: String, rationale: String) -> String { "\(kind) · \(rationale)" }
}
