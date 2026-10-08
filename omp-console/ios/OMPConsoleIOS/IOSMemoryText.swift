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

    // MARK: - Le mode graphe (BR-4, BR-5, BR-6)

    /// Le graphe partiel : le Mac a retiré des lignes à l'une des deux bornes.
    static let graphPartial = "Graphe partiel : le Mac n'a pas servi tous les souvenirs."

    /// Le titre du bloc de liens de la fiche.
    static let links = "Liens"

    /// Les natures d'un lien, en mots de l'app (le noyau n'en nomme aucune).
    static let linkSemantic = "Proximité"
    static let linkTag = "Étiquette"
    static let linkManual = "Manuel"

    /// Le libellé d'une ligne de lien : sa nature, l'autre extrémité, et le score
    /// d'une proximité.
    static func linkLine(kind: MemoryGraphLinkKind, other: String, score: Double?) -> String {
        let name: String
        switch kind {
        case .semantic: name = linkSemantic
        case .tag: name = linkTag
        case .manual: name = linkManual
        }
        guard let score else { return name + " · " + other }
        return name + " " + MemoryText.decimal(score) + " · " + other
    }

    // MARK: - La recette `-memoire.recipe` (BR-7)

    /// Le drapeau du crochet de recette du mode graphe.
    static let graphRecipeFlag = "-memoire.recipe"
    static let graphRecipePlate = "graphe"
    static let graphRecipeZoom = "zoom"
    static let graphRecipeSheet = "fiche"

    /// Le souvenir de la fixture dont la recette `fiche` ouvre la feuille.
    static let graphRecipeMemory = "m1"

    /// Le signal de PRÊT, écrit sur la sortie d'erreur quand l'état forcé de la recette
    /// est atteint. `scripts/ios-shots.sh` le lit (miroir littéral dans le script) au lieu
    /// d'attendre un délai fixe.
    static let graphRecipeReady = "memoire-recipe-ready"
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

    // MARK: - Le mode graphe (BR-4, BR-5, BR-6)

    static let graphToggle = "ios.memoire.graphe.bascule"
    static let graphCanvas = "ios.memoire.graphe.canevas"
    static let graphCount = "ios.memoire.graphe.compte"
    static let graphZoomIn = "ios.memoire.graphe.zoomIn"
    static let graphZoomOut = "ios.memoire.graphe.zoomOut"
    static let graphRecenter = "ios.memoire.graphe.recenter"
    static let graphTagMenu = "ios.memoire.graphe.etiquette"
    static let graphPartial = "ios.memoire.graphe.partiel"
    static let graphDetail = "ios.memoire.graphe.fiche"

    static func graphTagOption(_ tag: String) -> String { "ios.memoire.graphe.etiquette.\(tag)" }
}
