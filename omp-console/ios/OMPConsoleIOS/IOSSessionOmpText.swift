// Le vocabulaire PROPRE à l'écran « Session OMP » de l'app iOS (BR-4, BR-5) : les
// mots qui n'existent pas dans le noyau partagé, les valeurs de fil de l'état de
// la session hébergée, et les identifiants d'accessibilité.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`) : la garde `design-ios/AC-5`
// n'autorise un littéral alphabétique que dans ces fichiers-là — donc tout mot de
// cette feature et tout identifiant (préfixe `ios.sessionomp.`) vivent ici. Les
// mots DURABLES que les deux coques affichent (`SessionConsoleText`,
// `ProjectViewText`, `ConnectionText`, `ConversationText`) ne sont PAS recopiés.

import ConsoleCore

/// Les mots propres à l'écran Session OMP (BR-4, BR-5).
enum IOSSessionOmpText {
    /// Le titre de la feuille de lancement (AC-1, AC-4).
    static let launchSheetTitle = "Lancer une session OMP"
    /// L'aide de l'état vide : la session n'est pas encore lancée.
    static let emptyHelp = "Choisissez un dépôt du Mac et lancez la session."

    /// La confirmation d'arrêt (AC-13, S-7).
    static let stopConfirmTitle = "Arrêter la session ?"
    static let stopConfirmMessage = "La session hébergée sur le Mac s’arrêtera."

    /// Le libellé d'accessibilité de l'en-tête : le dépôt, puis l'état (S-2).
    static func headerLabel(_ project: String, _ state: String) -> String { "\(project) — \(state)" }
}

/// Le vocabulaire du champ `state` de la session hébergée (S-2) : les valeurs de
/// fil sont des littéraux alphabétiques, donc elles vivent dans un fichier
/// `*Text.swift`. Un `state` inconnu du client est traité comme `idle`.
enum HostedSessionWire: String {
    case idle
    case launching
    case running
    case stopping
    case stopped
    case dead
    case failed
}

/// Les identifiants d'accessibilité de l'écran (préfixe `ios.sessionomp.`).
enum SessionOmpAccessibility {
    static let screen = "ios.sessionomp"
    static let header = "ios.sessionomp.header"
    static let chip = "ios.sessionomp.chip"
    static let banner = "ios.sessionomp.banner"
    static let emptyCard = "ios.sessionomp.empty"
    static let launching = "ios.sessionomp.launching"
    static let stopping = "ios.sessionomp.stopping"
    static let loading = "ios.sessionomp.loading"
    static let thread = "ios.sessionomp.thread"
    static let composer = "ios.sessionomp.composer"
    static let send = "ios.sessionomp.send"
    static let launch = "ios.sessionomp.launch"
    static let relaunch = "ios.sessionomp.relaunch"
    static let stop = "ios.sessionomp.stop"

    // --- La feuille de lancement (BR-5) --------------------------------------
    static let launchSheet = "ios.sessionomp.launch.sheet"
    static let launchCommit = "ios.sessionomp.launch.commit"
    static let launchCancel = "ios.sessionomp.launch.cancel"
    static let launchError = "ios.sessionomp.launch.error"
    static let launchRepositories = "ios.sessionomp.launch.repositories"

    static func launchRepo(_ repoKey: String) -> String { "ios.sessionomp.launch.repo.\(repoKey)" }
}
