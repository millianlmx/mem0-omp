// TOUS les textes de la préparation (S-5), en UN endroit — la vue affiche, elle ne
// compose jamais une phrase (même convention que `HomeText`/`MemoryText`).
//
// Chaque phrase est FIGÉE par le contrat : les tests les relisent telles quelles,
// et l'app ne peut pas dériver d'un mot sans faire rougir la suite.

import Foundation

public enum SetupText {
    // --- la feuille -----------------------------------------------------------
    public static let title = "Préparation d'OMP Console"
    public static let body =
        "OMP Console installe ses composants — OMP, le moteur de conteneurs et la pile mémoire — puis les démarre. Cette étape n'a lieu qu'une fois."
    /// Le bouton de reprise après échec (proéminent, seul geste principal).
    public static let retry = "Réessayer"
    /// « Fermer » est toujours disponible : fermer n'interrompt rien.
    public static let close = "Fermer"
    /// Le bouton du bandeau de l'Accueil quand la préparation a été ignorée.
    public static let resume = "Reprendre…"
    /// L'état de succès (la feuille se ferme d'elle-même par la politique).
    public static let done = "Préparation terminée."

    // --- l'Accueil sans composants -------------------------------------------
    public static let homeMissingTitle = "OMP Console prépare ses composants"
    public static let homeMissingBody =
        "L'installation d'OMP, du moteur de conteneurs et de la pile mémoire est en cours. Les fonctions qui en dépendent se débloquent à la fin."

    // --- le badge des composants ---------------------------------------------
    /// L'état positif du badge (S-1) : les deux composants embarqués sont
    /// installés.
    public static let componentsAllInstalled = "Tout est installé"

    // --- les lignes de la feuille --------------------------------------------
    public static let componentsRow = "Composants"
    public static let migrationRow = "Migration de la mémoire"
    public static let stackRow = "Pile mémoire"
    public static let prerequisitesRow = "Prérequis"

    // --- états d'oMLX (ligne Prérequis) --------------------------------------
    public static let omlxUnknown = "Non vérifié"
    public static let omlxReachable = "Disponible"
    public static let omlxUnauthorized = "Jeton refusé (401)"
    public static let omlxUnreachable = "Injoignable"

    /// Le pourcentage d'un téléchargement, borné 0…100.
    public static func percent(_ downloaded: Int64, _ total: Int64) -> Int {
        guard total > 0 else { return 0 }
        let value = Int((Double(downloaded) / Double(total) * 100).rounded(.down))
        return min(max(value, 0), 100)
    }

}
