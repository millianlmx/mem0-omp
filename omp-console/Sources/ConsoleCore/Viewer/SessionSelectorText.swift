// Les textes de la section « Sessions » (déplacés du sélecteur macOS le
// 2026-10-06, S-4 de design-ios) : le vocabulaire DURABLE que les deux coques
// affichent — le titre de l'état vide, l'absence de magasin, l'absence de run et
// le compte d'entrées illisibles écartées.
//
// VIT DANS `ConsoleCore` : la coque macOS garde sa vue, l'app iOS lit ces mots
// mot pour mot (B-3), et il n'existe jamais deux déclarations du même libellé.

import Foundation

public enum SessionSelectorText {
    public static let emptyTitle = "Aucune session"
    public static let storeAbsent = "Aucune pipeline n’a encore été lancée sur ce Mac."
    public static let noRun = "Les sessions des pipelines apparaîtront ici."
    public static let open = "Ouvrir"

    public static func discarded(_ count: Int) -> String {
        ConsoleFormat.count(count, "entrée illisible écartée", "entrées illisibles écartées")
    }
}
