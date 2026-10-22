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
        "OMP Console installe OMP, reprend si besoin l’ancienne mémoire, puis démarre son service mémoire. Cette étape n’a lieu qu’une fois."
    /// « Réessayer » : sur l'échec, sur les rejets de l'import (qui est relancé),
    /// et en mode bloquant pour relire la présence d'OMP sans rien télécharger.
    public static let retry = "Réessayer"
    /// Le choix offert quand l'import a laissé des éléments de côté
    /// (omp-console-sans-podman S-5) : la bascule se fait sans eux.
    public static let switchAnyway = "Basculer quand même"
    /// « Fermer » n'existe qu'en mode fermable (OMP présent) : fermer n'interrompt
    /// rien. Tant qu'OMP manque, la feuille n'a pas de « Fermer ».
    public static let close = "Fermer"
    /// Le geste principal de la feuille bloquante : télécharge OMP.
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

    // --- le badge des composants ---------------------------------------------
    /// L'état positif du badge (S-1) : les composants embarqués sont installés.
    public static let componentsAllInstalled = "Tout est installé"
    /// L'info-bulle du badge quand un composant manque : il est alors un bouton
    /// qui rouvre la feuille de préparation.
    public static let componentsBadgeHelp = "Afficher la préparation d’OMP Console"

    // --- les lignes de la feuille --------------------------------------------
    public static let componentsRow = "Composants"
    public static let migrationRow = "Migration de la mémoire"
    public static let serviceRow = "Service mémoire"
    public static let prerequisitesRow = "Prérequis"

    // --- états d'oMLX (ligne Prérequis) --------------------------------------
    public static let omlxUnknown = "Non vérifié"
    public static let omlxReachable = "Disponible"
    public static let omlxUnauthorized = "Clé refusée"
    public static let omlxUnreachable = "Injoignable"

    // --- échecs de la migration et du service mémoire (omp-console-sans-podman S-5)
    // La feuille et le bandeau disent la CONSÉQUENCE, puis le geste ; la commande,
    // le détail brut et les gestes shell restent dans le diagnostic copiable.
    public static let failureLegacyMissing =
        "L’ancienne mémoire est introuvable sur ce Mac : elle ne peut pas être reprise, la nouvelle ne démarre pas."
    public static let failureLegacyMachine =
        "L’ancienne mémoire n’a pas démarré : elle ne peut pas être reprise, la nouvelle ne démarre pas."
    public static let failureLegacyUnreachable =
        "L’ancienne mémoire ne répond pas : elle ne peut pas être reprise, la nouvelle ne démarre pas."
    public static let failureHistoryCopy =
        "L’historique de l’ancienne mémoire n’a pas pu être copié : la nouvelle ne démarre pas."
    public static let failureImport =
        "L’import des souvenirs a échoué : la nouvelle mémoire ne démarre pas, l’ancienne reste en place."
    public static let failureLegacyStop = "L’ancienne mémoire n’a pas pu être arrêtée : la nouvelle ne peut pas démarrer."
    public static let failureSwitchState = "La bascule n’a pas pu être enregistrée : la nouvelle mémoire ne démarre pas."
    public static let failureAgentMissing = "Le service mémoire manque dans l’app : les souvenirs sont indisponibles."
    public static let failureAgentLaunch = "Le service mémoire n’a pas pu être lancé : les souvenirs sont indisponibles."
    public static let failureAgentHealth = "Le service mémoire n’a pas répondu : les souvenirs sont indisponibles."
    public static let failureAgentIdentity = "L’identité de la mémoire n’a pas pu être écrite : les souvenirs sont indisponibles."
    public static let failurePortOther = "La place réservée à la mémoire est occupée : celle-ci ne peut pas démarrer."
    /// Le geste commun : « Réessayer » règle le cas ; sinon, le diagnostic sert au
    /// signalement.
    public static let failureRetryGesture = "Réessayez ; si l’échec revient, copiez le diagnostic pour le signaler."
    /// Le geste d'un service mémoire absent du bundle : seule une réinstallation
    /// le remet en place.
    public static let failureReinstallGesture = "Réinstallez OMP Console."
    /// Le geste d'un port tenu par un programme nommé (S-3).
    public static let failurePortProgramGesture = "Quittez-le, puis réessayez."

    /// La conséquence d'un port tenu par un programme nommé (S-3) : son nom court,
    /// jamais son pid ni le port.
    public static func failurePortProgram(_ process: String) -> String {
        "Le programme « \(process) » occupe la place réservée à la mémoire : celle-ci ne peut pas démarrer."
    }

    // --- rejets de l'import (omp-console-sans-podman S-5) ---------------------
    /// Le bandeau relayé quand la feuille attend « Basculer quand même » ou
    /// « Réessayer ».
    public static let bannerAwaitingSwitch =
        "Préparation incomplète. L’import de l’ancienne mémoire attend votre choix sur le Mac."
    /// L'explication des deux choix, sous la ligne de la migration.
    public static let rejectedChoice =
        "« Basculer quand même » démarre la nouvelle mémoire sans eux ; l’ancienne reste intacte sur ce Mac. « Réessayer » relance l’import."

    /// Le libellé d'une raison de rejet de `mem0-rs import` ; un code inconnu
    /// reste tel quel.
    public static func rejectionReason(_ code: String) -> String {
        switch code {
        case "vecteur_absent": "vecteur absent"
        case "dimension": "dimension inattendue"
        case "texte_absent": "texte absent"
        case "champ_invalide": "champ invalide"
        case "historique_orphelin": "historique orphelin"
        default: code
        }
    }

    /// Le pourcentage d'un téléchargement, borné 0…100.
    public static func percent(_ downloaded: Int64, _ total: Int64) -> Int {
        guard total > 0 else { return 0 }
        let value = Int((Double(downloaded) / Double(total) * 100).rounded(.down))
        return min(max(value, 0), 100)
    }

}
