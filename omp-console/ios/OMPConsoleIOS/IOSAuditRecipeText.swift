// Le vocabulaire PROPRE à l'écran Audit de l'app iOS (audit-panel-in-omp-console,
// S-8, BR-5) : le crochet de recette `-audit.recipe <liste|propositions|suivi>`,
// les symboles SF des cases et les identifiants d'accessibilité `ios.audit.*`.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`) : la garde `design-ios/AC-5`
// n'autorise un littéral alphabétique que dans ces fichiers-là. Les MOTS affichés
// de l'écran ne vivent pas ici : ils sont tous dans `AuditText` (ConsoleCore),
// partagés avec la section Audit du Mac.

import Foundation

enum IOSAuditRecipeText {
    /// Le drapeau de la recette de l'écran Audit.
    static let flag = "-audit.recipe"
    /// La liste des trois audits de `AuditParity`.
    static let list = "liste"
    /// Le détail de l'audit qui attend la validation de son brief, deux cases cochées.
    static let proposals = "propositions"
    /// Le détail de l'audit lancé : avancement, question en attente, décisions.
    static let followUp = "suivi"
}

/// Les symboles SF de l'écran Audit : des identifiants, pas des libellés.
enum IOSAuditSymbol {
    /// Une proposition cochée.
    static let checked = "checkmark.circle.fill"
    /// Une proposition non cochée.
    static let unchecked = "circle"
    /// Le badge des questions en attente d'une rangée d'audit.
    static let escalations = "questionmark.bubble.fill"
}

/// Les identifiants d'accessibilité de l'écran Audit (chaînes pointées `ios.audit.`).
enum IOSAuditAccessibility {
    static let screen = "ios.audit"
    static let empty = "ios.audit.empty"
    static let banner = "ios.audit.banner"
    static let start = "ios.audit.start"
    static let detail = "ios.audit.detail"
    static let header = "ios.audit.header"
    static let reviewBrief = "ios.audit.brief"
    static let stop = "ios.audit.stop"
    static let launchSheet = "ios.audit.launch"
    static let launchOrientation = "ios.audit.launch.orientation"
    static let launchConfirm = "ios.audit.launch.confirm"
    static let launchCancel = "ios.audit.launch.cancel"
    static let launchError = "ios.audit.launch.error"
    static let briefSheet = "ios.audit.brief.sheet"
    static let briefEditor = "ios.audit.brief.editor"
    static let briefConfirm = "ios.audit.brief.confirm"
    static let briefCancel = "ios.audit.brief.cancel"
    static let briefError = "ios.audit.brief.error"

    static func row(_ id: String) -> String { "ios.audit.row.\(id)" }
    static func launchRepo(_ repoKey: String) -> String { "ios.audit.launch.repo.\(repoKey)" }
    static func proposal(_ slug: String) -> String { "ios.audit.proposal.\(slug)" }
    static func feature(_ slug: String) -> String { "ios.audit.feature.\(slug)" }
    static func openPR(_ slug: String) -> String { "ios.audit.feature.\(slug).pr" }
    static func escalation(_ key: String) -> String { "ios.audit.escalation.\(key)" }
    static func option(_ key: String, _ index: Int) -> String { "ios.audit.escalation.\(key).option.\(index)" }
    static func otherAnswer(_ key: String) -> String { "ios.audit.escalation.\(key).other" }
    static func answer(_ key: String) -> String { "ios.audit.escalation.\(key).answer" }
    static func approve(_ key: String) -> String { "ios.audit.escalation.\(key).approve" }
    static func abandon(_ key: String) -> String { "ios.audit.escalation.\(key).abandon" }
    static func decision(_ index: Int) -> String { "ios.audit.decision.\(index)" }
}
