// Le vocabulaire de l'écran Mémoire de l'app iOS : les quelques mots propres à
// cette coque, et ses identifiants d'accessibilité.
//
// Fichier de VOCABULAIRE (`*Text.swift`), comme `ProjectText.swift` et
// `ConnectionText.swift` : la garde `design-ios/AC-5` n'autorise un littéral
// alphabétique que dans ces fichiers-là — toute vue de l'écran ne lit que des
// constantes d'ici ou du noyau partagé `ConsoleCore`.
//
// Les mots DURABLES (états, compte, résultats, troncature) viennent du noyau :
// l'app ne réinvente aucun libellé partagé. Ce qui reste ici, c'est ce qui nomme
// un raccourci macOS ou une surface absente du Mac.

import ConsoleClient
import ConsoleCore

/// Les mots propres à l'écran Mémoire (BR-2) — le reste vient de `ConsoleCore`.
enum IOSMemoryText {
    /// L'état vide de l'app quand le Mac n'est pas joignable : on ne peut PAS
    /// affirmer que la mémoire est vide (on ne l'a pas lue), donc on le dit.
    static let noData = "Aucune donnée reçue du Mac pour l'instant."

    /// Aucun projet ouvert : le libellé partagé `MemoryText.noProjectDescription`
    /// nomme ⌘4, qui n'existe pas sur iPhone — re-formulé côté app, seul mot où
    /// l'app s'écarte du noyau.
    static let noProjectDetail = "Choisissez un projet dans la section « Session OMP »."

    /// Le Mac n'a pas répondu : c'est l'état du CLIENT, jamais une cause mémoire.
    static let macUnreachable = "Le Mac n'a pas répondu."

    /// Le bandeau de l'indisponibilité mémoire : le titre partagé, puis le détail
    /// relayé par le Mac (adresse sondée et dernier message d'erreur).
    static func unavailable(detail: String) -> String {
        MemoryText.unavailableTitle + "\n" + detail
    }

    /// La ligne de troncature du sommaire : ce qui est montré, puis le total servi.
    static func truncated(shown: Int, total: Int) -> String {
        "\(ConsoleFormat.count(shown, "souvenir", "souvenirs")) sur "
            + "\(ConsoleFormat.count(total, "souvenir", "souvenirs")) — liste tronquée."
    }
}

/// Les identifiants d'accessibilité de l'écran, chaînes pointées préfixées
/// `ios.memoire.` — la même convention que `ProjectAccessibility`.
enum IOSMemoryAccessibility {
    static let screen = "ios.memoire.screen"
    static let banner = "ios.memoire.banner"
    static let refresh = "ios.memoire.refresh"
    static let retry = "ios.memoire.retry"
    static let summary = "ios.memoire.summary"
    static let count = "ios.memoire.count"
    static let results = "ios.memoire.results"
    static let truncated = "ios.memoire.truncated"
    static let detail = "ios.memoire.detail"

    static func row(_ id: String) -> String { "ios.memoire.row.\(id)" }
}
