// Le vocabulaire de la section Statistiques de l'app iOS (S-3, S-4) : les mots
// propres à cette coque, et les identifiants d'accessibilité de l'écran.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`), comme `ProjectText.swift` et
// `ConnectionText.swift` : la garde `design-ios/AC-5` n'autorise un littéral
// alphabétique que dans ces fichiers-là — toute vue de l'écran ne lit que des
// constantes d'ici ou du noyau partagé `ConsoleCore`.
//
// Les mots DURABLES des statistiques (« Tokens envoyés », « Temps passé »,
// « Tours »…) viennent de `StatsPresentation` : une seule déclaration par mot,
// partagée avec la fenêtre macOS (BR-1).

import ConsoleClient

/// Les mots propres à la section Statistiques (S-4) — le reste vient de
/// `ConsoleCore`.
enum IOSStatsText {
    /// Le libellé de la ligne de total du projet (S-4).
    static let total = "Total du projet"

    /// Le message d'un échec de relevé : le message servi par l'API quand il
    /// existe, sinon le mot de `ConnectionText` pour l'état courant (patron
    /// `ProjectText.failure`, S-4).
    static func failure(_ error: Error, state: ClientState) -> String {
        if let clientError = error as? ClientError, case .api(let api) = clientError, let message = api.message {
            return message
        }
        return ConnectionText.state(state)
    }
}

/// Les identifiants d'accessibilité de la section (chaînes pointées `ios.stats.`) :
/// un second enum, comme `ProjectAccessibility` — les tests les éprouvent sans
/// rendre de SwiftUI.
enum StatsAccessibility {
    static let screen = "ios.stats"
    static let project = "ios.stats.project"
    static let loading = "ios.stats.loading"
    static let banner = "ios.stats.banner"
    static let error = "ios.stats.error"
    static let retry = "ios.stats.retry"
    static let noProject = "ios.stats.noProject"
    static let empty = "ios.stats.empty"
    static let total = "ios.stats.total"
    static let hidden = "ios.stats.hidden"

    static func feature(_ slug: String) -> String { "ios.stats.feature.\(slug)" }
}
