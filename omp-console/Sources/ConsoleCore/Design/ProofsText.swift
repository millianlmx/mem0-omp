// Le vocabulaire de l'onglet « Preuves » de la page d'une feature, partagé par la
// coque Mac et l'app iOS : les captures, l'avant et l'après d'un critère, les rapports
// de tests par critère, les journaux, et les tours de revue précédents.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française et glossaire
// GLOSSAIRE.md. Chaque phrase passe par `L10n` : sa clé est le texte français, sa
// traduction anglaise vit dans `Resources/en.lproj/Localizable.strings`.

import Foundation

public enum ProofsText {
    public static let tab = L10n.text("Preuves")
    public static let pairs = L10n.text("Avant et après")
    public static let before = L10n.text("Avant")
    public static let after = L10n.text("Après")
    public static let captures = L10n.text("Captures")
    public static let reports = L10n.text("Rapports de tests")
    public static let logs = L10n.text("Journaux")
    public static let videos = L10n.text("Vidéos")
    public static let previousRounds = L10n.text("Tours précédents")
    public static let previousRoundsHint = L10n.text("Les preuves jointes avant la dernière correction.")
    public static let none = L10n.text("Aucune preuve jointe à cette revue.")
    public static let failed = L10n.text("Les preuves n’ont pas pu être lues.")
    public static let missing = L10n.text("Le serveur ne connaît plus cette preuve.")
    public static let unreadable = L10n.text("Cette version de l’app ne sait pas lire cette preuve.")
    public static let truncated = L10n.text("Rapport incomplet. Seule la fin de la sortie des tests a été gardée, des critères peuvent manquer.")
    public static let noCriteria = L10n.text("Aucun critère des specs dans cette sortie.")
    public static let otherTests = L10n.text("Autres tests")

    /// « Critère AC-3 »
    public static func criterion(_ acRef: String) -> String {
        L10n.format("Critère %@", acRef)
    }

    /// « 3 réussis · 1 échoué »
    public static func counts(passed: Int, failed: Int) -> String {
        ConsoleFormat.count(passed, L10n.text("réussi"), L10n.text("réussis"))
            + " · " + ConsoleFormat.count(failed, L10n.text("échoué"), L10n.text("échoués"))
    }

    /// La taille d'une preuve : « 12 Ko ».
    public static func size(_ bytes: Int) -> String {
        Int64(bytes).formatted(.byteCount(style: .file).locale(ConsoleFormat.locale))
    }
}
