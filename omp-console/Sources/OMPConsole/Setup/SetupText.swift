// Ce que la coque garde des textes de la préparation : les cinq fonctions qui
// nomment un type de la coque (`ComponentID`, `SetupStep`, `OMLXStatus`,
// `SetupFailure`, `SetupState`). Toutes les constantes et `percent(_:_:)` vivent
// dans `ConsoleCore/Setup/SetupText.swift`.

import ConsoleCore

extension SetupText {
    /// Le mot du badge pour les composants manquants (S-1, AC-1/AC-2) : les noms
    /// joints par « et », la marque du pluriel sur « manquants » — jamais
    /// « manquant(s) » (convention de pluriel du dépôt).
    static func componentsWord(_ missing: [ComponentID]) -> String {
        switch missing.count {
        case 0: return componentsAllInstalled
        case 1: return "\(missing[0].name) manquant"
        default: return missing.map(\.name).joined(separator: " et ") + " manquants"
        }
    }

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
