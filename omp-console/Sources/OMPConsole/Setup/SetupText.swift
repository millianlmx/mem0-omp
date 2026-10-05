// TOUS les textes de la préparation (S-5), en UN endroit — la vue affiche, elle ne
// compose jamais une phrase (même convention que `HomeText`/`MemoryText`).
//
// Chaque phrase est FIGÉE par le contrat : les tests les relisent telles quelles,
// et l'app ne peut pas dériver d'un mot sans faire rougir la suite.

import Foundation

enum SetupText {
    // --- la feuille -----------------------------------------------------------
    static let title = "Préparation d'OMP Console"
    static let body =
        "OMP Console installe ses composants — OMP, le moteur de conteneurs et la pile mémoire — puis les démarre. Cette étape n'a lieu qu'une fois."
    /// Le bouton de reprise après échec (proéminent, seul geste principal).
    static let retry = "Réessayer"
    /// « Fermer » est toujours disponible : fermer n'interrompt rien.
    static let close = "Fermer"
    /// Le bouton du bandeau de l'Accueil quand la préparation a été ignorée.
    static let resume = "Reprendre…"
    /// L'état de succès (la feuille se ferme d'elle-même par la politique).
    static let done = "Préparation terminée."

    // --- l'Accueil sans composants -------------------------------------------
    static let homeMissingTitle = "OMP Console prépare ses composants"
    static let homeMissingBody =
        "L'installation d'OMP, du moteur de conteneurs et de la pile mémoire est en cours. Les fonctions qui en dépendent se débloquent à la fin."

    // --- les lignes de la feuille --------------------------------------------
    static let componentsRow = "Composants"
    static let migrationRow = "Migration de la mémoire"
    static let stackRow = "Pile mémoire"
    static let prerequisitesRow = "Prérequis"

    // --- états d'oMLX (ligne Prérequis) --------------------------------------
    static let omlxUnknown = "Non vérifié"
    static let omlxReachable = "Disponible"
    static let omlxUnauthorized = "Jeton refusé (401)"
    static let omlxUnreachable = "Injoignable"

    /// Le détail d'une étape en cours. Les deux téléchargements affichent leur
    /// pourcentage seulement quand la taille totale est connue (`total == 0` ⇒
    /// « Téléchargement d'OMP… »).
    static func stepDetail(_ step: SetupStep) -> String {
        switch step {
        case .omp(let downloaded, let total):
            if total <= 0 { return "Téléchargement d'OMP…" }
            return "Téléchargement d'OMP — \(percent(downloaded, total)) %"
        case .ompInstall:
            return "Installation d'OMP…"
        case .podman(let downloaded, let total):
            if total <= 0 { return "Téléchargement de Podman…" }
            return "Téléchargement de Podman — \(percent(downloaded, total)) %"
        case .podmanInstall:
            return "Installation de Podman…"
        case .legacyStop:
            return "Arrêt de l'ancienne pile mémoire…"
        case .migrationCopy:
            return "Copie de la base mémoire existante…"
        case .machine:
            return "Préparation de la machine de conteneurs…"
        case .images:
            return "Préparation des images de la pile…"
        case .containers:
            return "Démarrage de la pile mémoire…"
        case .health:
            return "Attente de la mémoire…"
        case .prerequisites:
            return "Vérification des prérequis…"
        }
    }

    /// Le pourcentage d'un téléchargement, borné 0…100.
    static func percent(_ downloaded: Int64, _ total: Int64) -> Int {
        guard total > 0 else { return 0 }
        let value = Int((Double(downloaded) / Double(total) * 100).rounded(.down))
        return min(max(value, 0), 100)
    }

    /// Le mot d'état d'oMLX (S-5, ligne Prérequis).
    static func omlxWord(_ status: OMLXStatus) -> String {
        switch status {
        case .unknown: omlxUnknown
        case .reachable: omlxReachable
        case .unauthorized: omlxUnauthorized
        case .unreachable: omlxUnreachable
        }
    }

    /// Le message d'un échec de préparation (S-5, textes exacts).
    static func failureMessage(_ failure: SetupFailure) -> String {
        switch failure {
        case .components(.unsupportedMac):
            return "Ce Mac n'est pas pris en charge (arm64 requis)."
        case .components(.network(let component, _)):
            return "Pas de réseau : « \(component) » n'a pas pu être téléchargé. Vérifiez votre connexion, puis réessayez."
        case .components(.checksum(let component)):
            return "« \(component) » téléchargé est corrompu (empreinte SHA-256 différente). La préparation a été interrompue."
        case .components(.install(let component, let detail)):
            return "L'installation de « \(component) » a échoué : \(detail)"
        case .migration(.legacyStopFailed(let name, let detail)):
            return "L'ancienne pile mémoire n'a pas pu être arrêtée (\(name)) : \(detail)"
        case .migration(.copyFailed(let detail)):
            return "La copie de la base mémoire existante a échoué : \(detail)"
        case .stack(.machineFailed(let detail)):
            return "La machine de conteneurs n'a pas démarré : \(detail)"
        case .stack(.portBusy(let port)):
            return "Le port \(port) est déjà utilisé par un autre programme : la pile mémoire ne peut pas démarrer."
        case .stack(.containerFailed(let name, let detail)):
            return "Le conteneur \(name) n'a pas démarré : \(detail)"
        case .stack(.healthTimeout(let seconds)):
            return "La mémoire n'a pas répondu dans le délai imparti (\(seconds) s)."
        case .stack(.podmanFailed(let command, let detail)):
            return "Podman a échoué (\(command)) : \(detail)"
        }
    }

    /// Le bandeau de l'Accueil quand la feuille a été fermée : `nil` tant qu'elle
    /// est visible (l'état vit dans la feuille), et `nil` une fois prêt.
    static func banner(state: SetupState, dismissed: Bool) -> String? {
        guard dismissed else { return nil }
        switch state {
        case .preparing(let step):
            return "Préparation en cours — \(stepDetail(step))"
        case .failed(let failure):
            return "Préparation incomplète. \(failureMessage(failure))"
        case .idle, .ready:
            return nil
        }
    }
}
