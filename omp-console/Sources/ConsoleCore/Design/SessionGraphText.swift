// Le vocabulaire de la session en graphe, partagé par la coque Mac et l’app iOS : la
// carte d’une question (enjeu, options, réversibilité, coût), le schéma de bifurcation,
// la carte d’exploration, le briefing des specs et des arbitrages, et l’onglet « Carte »
// de la page d’une feature.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française et glossaire
// GLOSSAIRE.md. Chaque phrase passe par `L10n` : sa clé est le texte français, sa
// traduction anglaise vit dans `Resources/en.lproj/Localizable.strings`.

import Foundation

public enum SessionGraphText {
    public static let tab = L10n.text("Carte")
    public static let reversible = L10n.text("réversible")
    public static let irreversible = L10n.text("irréversible")
    public static let costLow = L10n.text("coût faible")
    public static let costMedium = L10n.text("coût moyen")
    public static let costHigh = L10n.text("coût fort")
    public static let notReviewed = L10n.text("Carte non relue par le relecteur rapide")
    public static let schemaTitle = L10n.text("La bifurcation")
    public static let established = L10n.text("Établi")
    public static let ambiguity = L10n.text("À trancher")
    public static let chooseHint = L10n.text("Choisit cette option comme réponse")
    public static let explorationTitle = L10n.text("Carte d’exploration")
    public static let explorationHint = L10n.text("Ce que l’agent a lu et fait. En évidence, ce d’où vient la question.")
    public static let details = L10n.text("Détails")
    public static let briefingPoints = L10n.text("Points à regarder")
    public static let lanes = L10n.text("Parcours")
    public static let folders = L10n.text("Dossiers")
    public static let done = L10n.text("Fait")
    public static let running = L10n.text("En cours")
    public static let blocked = L10n.text("Bloqué")
    public static let edited = L10n.text("modifié")
    public static let testPassed = L10n.text("Tests réussis")
    public static let testFailed = L10n.text("Tests en échec")
    public static let testStopped = L10n.text("Tests interrompus")
    public static let decision = L10n.text("Décision")
    public static let escalation = L10n.text("Question")
    public static let openLive = L10n.text("Mène à l’entrée du direct")
    public static let empty = L10n.text("L’agent n’a encore rien lu ni fait.")
    public static let failed = L10n.text("La carte n’a pas pu être lue.")
    public static let legend = L10n.text("En évidence, les décisions, les questions et ce qui les fonde.")

    public static func stake(_ stake: String) -> String {
        L10n.format("Enjeu : %@", stake)
    }

    public static func feature(_ line: String) -> String {
        L10n.format("Ce que fait la feature : %@", line)
    }

    public static func search(_ pattern: String) -> String {
        L10n.format("Recherche « %@ »", pattern)
    }

    public static func edits(_ label: String) -> String {
        L10n.format("Modifications · %@", label)
    }

    public static func reads(_ count: Int) -> String {
        count == 1 ? L10n.text("1 lecture") : L10n.format("%lld lectures", count)
    }

    public static func grouped(_ count: Int) -> String {
        count == 1 ? L10n.text("1 fichier regroupé") : L10n.format("%lld fichiers regroupés", count)
    }

    /// Le coût d’une option (`faible`, `moyen`, `fort`) ; un coût inconnu se montre tel quel.
    public static func cost(_ raw: String) -> String {
        switch raw {
        case "faible": costLow
        case "moyen": costMedium
        case "fort": costHigh
        default: raw
        }
    }

    public static let tabSymbol = "point.3.connected.trianglepath.dotted"
    public static let schemaSymbol = "arrow.triangle.branch"
    public static let explorationSymbol = "map"
    public static let stepSymbol = "flag"
    public static let dirSymbol = "folder"
    public static let fileSymbol = "doc.text"
    public static let searchSymbol = "magnifyingglass"
    public static let testSymbol = "checkmark.seal"
    public static let editSymbol = "pencil"
    public static let decisionSymbol = "arrow.triangle.branch"
    public static let escalationSymbol = "questionmark.bubble"
    public static let reversibleSymbol = "arrow.uturn.backward"
    public static let irreversibleSymbol = "exclamationmark.triangle"
    public static let arrowSymbol = "arrow.right"
}
