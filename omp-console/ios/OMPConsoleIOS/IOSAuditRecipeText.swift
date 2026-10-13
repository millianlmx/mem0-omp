// Le vocabulaire PROPRE à l'écran Audit de l'app iOS (audit-panel-in-omp-console,
// S-8, BR-5 ; étendu par audit-ui-redesign) : le crochet de recette
// `-audit.recipe <liste|propositions|suivi|analyse|echec>`, les symboles SF (cases,
// menu « ⋯ », frise, états vides) et les identifiants d'accessibilité `ios.audit.*`.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`) : la garde `design-ios/AC-5`
// n'autorise un littéral alphabétique que dans ces fichiers-là. Les MOTS affichés
// de l'écran ne vivent pas ici : ils sont tous dans `AuditText` (ConsoleCore),
// partagés avec la section Audit du Mac.

import Foundation

enum IOSAuditRecipeText {
    /// Le drapeau de la recette de l'écran Audit.
    static let flag = "-audit.recipe"
    /// La liste des cinq audits de `AuditParity`.
    static let list = "liste"
    /// Le détail de l'audit qui attend la validation de son brief, deux cases cochées.
    static let proposals = "propositions"
    /// Le détail de l'audit lancé : avancement, question en attente, décisions.
    static let followUp = "suivi"
    /// Le détail de l'audit en cours d'analyse (audit-ui-redesign, S-14).
    static let analysis = "analyse"
    /// Le détail de l'audit en échec (audit-ui-redesign, S-14).
    static let failure = "echec"
}

/// Les symboles SF de l'écran Audit : des identifiants, pas des libellés.
enum IOSAuditSymbol {
    /// Une proposition cochée.
    static let checked = "checkmark.circle.fill"
    /// Une proposition non cochée.
    static let unchecked = "circle"
    /// Le menu « Plus d'actions » de l'en-tête du détail (audit-ui-redesign, S-6).
    static let more = "ellipsis.circle"
    /// Les états d'une étape de la frise (S-7).
    static let stepDone = "checkmark.circle.fill"
    static let stepCurrent = "circle.inset.filled"
    static let stepFailed = "xmark.circle.fill"
    static let stepUpcoming = "circle"
    /// L'état vide d'un audit en échec (S-11).
    static let failed = "exclamationmark.triangle"
    /// L'état vide d'un audit arrêté avant le lancement (S-10).
    static let stopped = "stop.circle"
    /// « Relancer avec la même orientation » (S-11).
    static let relaunch = "arrow.clockwise"
}

/// Les identifiants d'accessibilité de l'écran Audit (chaînes pointées `ios.audit.`).
enum IOSAuditAccessibility {
    static let screen = "ios.audit"
    static let empty = "ios.audit.empty"
    static let banner = "ios.audit.banner"
    static let start = "ios.audit.start"
    static let checkedCount = "ios.audit.checkedCount"
    static let orientationToggle = "ios.audit.orientation.toggle"
    static let menu = "ios.audit.menu"
    static let stepper = "ios.audit.stepper"
    static let analysis = "ios.audit.analysis"
    static let notLaunched = "ios.audit.notLaunched"
    static let decisions = "ios.audit.decisions"
    static let stoppedEmpty = "ios.audit.stoppedEmpty"
    static let failure = "ios.audit.failure"
    static let relaunch = "ios.audit.relaunch"
    static let diagnostic = "ios.audit.diagnostic"
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
