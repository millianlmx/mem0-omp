// TOUS les textes de la préparation (S-5), en UN endroit — la vue affiche, elle ne
// compose jamais une phrase (même convention que `HomeText`/`MemoryText`).
//
// Chaque phrase est FIGÉE par le contrat : les tests les relisent telles quelles,
// et l'app ne peut pas dériver d'un mot sans faire rougir la suite.

import Foundation

public enum SetupText {
    // --- la feuille -----------------------------------------------------------
    public static let title = "Préparation d’OMP Console"
    public static let body =
        "OMP Console installe ses composants — OMP, le moteur de conteneurs et la pile mémoire — puis les démarre. Cette étape n’a lieu qu’une fois."
    /// « Réessayer » : sur l'échec, et en mode bloquant pour relire la présence
    /// d'OMP sans rien télécharger.
    public static let retry = "Réessayer"
    /// Le geste explicite de reprise de l'ancienne pile (S-6) : la SEULE voie qui
    /// arrête des conteneurs legacy, et seulement sur ordre de l'utilisateur.
    public static let takeover = "Arrêter l’ancienne pile et reprendre"
    /// « Fermer » n'existe qu'en mode fermable (OMP présent) : fermer n'interrompt
    /// rien. Tant qu'OMP manque, la feuille n'a pas de « Fermer ».
    public static let close = "Fermer"
    /// Le geste principal de la feuille bloquante : télécharge OMP et Podman.
    public static let install = "Installer"
    /// Le seul moyen de sortir de la feuille bloquante : termine l'app.
    public static let quit = "Quitter"
    /// Le paragraphe de la feuille bloquante, sous le corps.
    public static let ompMissingBody =
        "OMP n’est pas installé sur ce Mac. Installez-le pour utiliser OMP Console, ou quittez l’app."
    /// « Réessayer » n'a pas trouvé OMP : la feuille reste bloquante et le dit.
    public static let retryMissed = "OMP n’est toujours pas installé."
    /// Le bouton qui déplie le détail technique d'un échec.
    public static let showDetail = "Afficher le détail"
    /// Le même bouton, détail déplié.
    public static let hideDetail = "Masquer le détail"
    /// Le bouton du bandeau de l'Accueil quand la préparation a été ignorée.
    public static let resume = "Reprendre…"
    /// L'état de succès (la feuille se ferme d'elle-même par la politique).
    public static let done = "Préparation terminée."

    // --- l'Accueil sans composants -------------------------------------------
    public static let homeMissingTitle = "OMP n’est pas installé"
    public static let homeMissingBody =
        "Installez OMP depuis la feuille de préparation : les fonctions qui en dépendent se débloquent à la fin de l’installation."

    // --- le badge des composants ---------------------------------------------
    /// L'état positif du badge (S-1) : les deux composants embarqués sont
    /// installés.
    public static let componentsAllInstalled = "Tout est installé"
    /// L'info-bulle du badge quand un composant manque : il est alors un bouton
    /// qui rouvre la feuille de préparation.
    public static let componentsBadgeHelp = "Afficher la préparation d’OMP Console"

    // --- les lignes de la feuille --------------------------------------------
    public static let componentsRow = "Composants"
    public static let migrationRow = "Migration de la mémoire"
    public static let stackRow = "Pile mémoire"
    public static let prerequisitesRow = "Prérequis"

    // --- états d'oMLX (ligne Prérequis) --------------------------------------
    public static let omlxUnknown = "Non vérifié"
    public static let omlxReachable = "Disponible"
    public static let omlxUnauthorized = "Clé refusée"
    public static let omlxUnreachable = "Injoignable"

    // --- échecs Podman de la préparation (S-5 de jargon-technique-expose-mac-et-ios)
    // La feuille et le bandeau disent la CONSÉQUENCE, puis le geste ; la commande,
    // le stderr et les gestes shell restent dans le diagnostic copiable.
    public static let failureMachine = "Le moteur de la mémoire n’a pas démarré : les souvenirs sont indisponibles."
    public static let failureContainer = "Un composant de la mémoire n’a pas démarré : les souvenirs sont indisponibles."
    public static let failurePodman = "La préparation de la mémoire a échoué : les souvenirs sont indisponibles."
    public static let failureLegacyStop = "L’ancienne mémoire n’a pas pu être arrêtée : la nouvelle ne peut pas démarrer."
    public static let failurePortLegacy = "L’ancienne mémoire occupe encore la place de la nouvelle : celle-ci ne peut pas démarrer."
    public static let failurePortForeign = "Une autre app occupe la place réservée à la mémoire : celle-ci ne peut pas démarrer."
    public static let failurePortOther = "La place réservée à la mémoire est occupée : celle-ci ne peut pas démarrer."
    /// Le geste commun : « Réessayer » règle le cas ; sinon, le diagnostic sert au
    /// signalement.
    public static let failureRetryGesture = "Réessayez ; si l’échec revient, copiez le diagnostic pour le signaler."
    public static let failurePortLegacyGesture = "Arrêtez l’ancienne mémoire pour reprendre."
    public static let failurePortForeignGesture = "Quittez cette app, puis réessayez ; copiez le diagnostic pour savoir laquelle."

    /// Le pourcentage d'un téléchargement, borné 0…100.
    public static func percent(_ downloaded: Int64, _ total: Int64) -> Int {
        guard total > 0 else { return 0 }
        let value = Int((Double(downloaded) / Double(total) * 100).rounded(.down))
        return min(max(value, 0), 100)
    }

}
