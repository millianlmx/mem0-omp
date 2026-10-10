// Ce que la coque garde des textes de la préparation : les fonctions qui nomment
// un type de la coque (`ComponentID`, `SetupStep`, `OMLXStatus`, `SetupFailure`,
// `SetupState`). Toutes les constantes et `percent(_:_:)` vivent dans
// `ConsoleCore/Setup/SetupText.swift`.

import ConsoleCore
import Foundation

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
        case .union:
            return "Rattrapage des souvenirs manquants…"
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

    /// Le détail BRUT d'un échec de préparation (S-5) : l'ancien texte de la
    /// feuille, mot pour mot — commande, stderr, port, propriétaire et geste shell.
    /// Seul « Copier le diagnostic » l'emporte.
    static func failureDiagnostic(_ failure: SetupFailure) -> String {
        switch failure {
        case .components(.unsupportedMac):
            return "Ce Mac n'est pas pris en charge (arm64 requis)."
        case .components(.network(let component, _)):
            return "Pas de réseau : « \(component) » n'a pas pu être téléchargé. Vérifiez votre connexion, puis réessayez."
        case .components(.checksum(let component)):
            return "« \(component) » téléchargé est corrompu (empreinte SHA-256 différente). La préparation a été interrompue."
        case .components(.install(let component, let detail)):
            return "L'installation de « \(component) » a échoué : \(detail)"
        case .migration(.copyFailed(let detail)):
            return "La copie de la base mémoire existante a échoué : \(detail)"
        case .legacy(.stopFailed(let name, let detail)):
            return "L'ancienne pile mémoire n'a pas pu être arrêtée (\(name)) : \(detail)"
        case .stack(.machineFailed(let detail)):
            return "La machine de conteneurs n'a pas démarré : \(detail)"
        case .stack(.portConflict(let port, let owner)):
            return "Le port \(port) est déjà tenu par \(owner.userDescription) : la pile mémoire ne peut pas démarrer.\nGeste : \(owner.gesture)"
        case .stack(.containerFailed(let name, let detail)):
            return "Le conteneur \(name) n'a pas démarré : \(detail)"
        case .stack(.healthTimeout(let seconds)):
            return "La mémoire n'a pas répondu dans le délai imparti (\(seconds) s)."
        case .stack(.installationFailed(let detail)):
            return "L'identité d'installation de la pile n'a pas pu être écrite : \(detail)"
        case .stack(.podmanFailed(let command, let detail)):
            return "Podman a échoué (\(command)) : \(detail)"
        }
    }

    /// La conséquence d'un échec (S-5) : ce que l'utilisateur perd, sans commande,
    /// stderr ni port. Les cas sans détail Podman gardent leur texte actuel.
    static func failureConsequence(_ failure: SetupFailure) -> String {
        switch failure {
        case .stack(.machineFailed):
            return failureMachine
        case .stack(.containerFailed):
            return failureContainer
        case .stack(.podmanFailed):
            return failurePodman
        case .legacy(.stopFailed):
            return failureLegacyStop
        case .stack(.portConflict(_, .legacyStack)):
            return failurePortLegacy
        case .stack(.portConflict(_, .foreign)):
            return failurePortForeign
        case .stack(.portConflict):
            return failurePortOther
        default:
            return failureDiagnostic(failure)
        }
    }

    /// La phrase de la ligne en échec (S-5) : la conséquence, puis le geste. Le
    /// geste nomme le bouton qui règle le cas (« Réessayer », ou la reprise de
    /// l'ancienne pile) ; hors des cas Podman, le texte actuel est inchangé.
    static func failureMessage(_ failure: SetupFailure) -> String {
        let consequence = failureConsequence(failure)
        switch failure {
        case .stack(.portConflict(_, .legacyStack)):
            return "\(consequence) \(failurePortLegacyGesture)"
        case .stack(.portConflict(_, .foreign)):
            return "\(consequence) \(failurePortForeignGesture)"
        case .stack(.machineFailed), .stack(.containerFailed), .stack(.podmanFailed),
             .stack(.portConflict), .legacy(.stopFailed):
            return "\(consequence) \(failureRetryGesture)"
        default:
            return consequence
        }
    }

    /// La phrase claire d'un échec, telle que la feuille la montre : jamais le
    /// détail technique, qui se replie derrière « Afficher le détail » (S-6).
    /// Les échecs Podman reprennent `failureMessage` (conséquence et geste, S-5).
    static func failureSummary(_ failure: SetupFailure) -> String {
        switch failure {
        case .components(.unsupportedMac):
            return "Ce Mac n'est pas pris en charge (arm64 requis)."
        case .components(.network(let component, _)):
            return "Pas de réseau : « \(component) » n'a pas pu être téléchargé. Vérifiez votre connexion, puis réessayez."
        case .components(.checksum(let component)):
            return "« \(component) » téléchargé est corrompu (empreinte SHA-256 différente). La préparation a été interrompue."
        case .components(.install(let component, _)):
            return "L'installation de « \(component) » a échoué."
        case .legacy(.stopFailed), .stack(.machineFailed), .stack(.containerFailed),
             .stack(.podmanFailed), .stack(.portConflict):
            return failureMessage(failure)
        case .migration(.copyFailed):
            return "La copie de la base mémoire existante a échoué."
        case .stack(.healthTimeout(let seconds)):
            return "La mémoire n'a pas répondu dans le délai imparti (\(seconds) s)."
        case .stack(.installationFailed):
            return "L'identité d'installation de la pile n'a pas pu être écrite."
        }
    }

    /// Le détail technique d'un échec, replié par défaut sous la phrase claire
    /// (S-6) ; `nil` quand il n'y en a pas, ou qu'il n'est fait que de blancs. Le
    /// geste d'un conflit de port (une commande) s'y range aussi.
    static func failureDetail(_ failure: SetupFailure) -> String? {
        let subject: String?
        let raw: String
        switch failure {
        case .components(.unsupportedMac), .components(.checksum), .stack(.healthTimeout):
            return nil
        case .stack(.portConflict(_, let owner)):
            return "Geste : \(owner.gesture)"
        case .components(.network(_, let detail)), .components(.install(_, let detail)),
             .migration(.copyFailed(let detail)), .stack(.machineFailed(let detail)),
             .stack(.installationFailed(let detail)):
            (subject, raw) = (nil, detail)
        case .legacy(.stopFailed(let name, let detail)), .stack(.containerFailed(let name, let detail)):
            (subject, raw) = (name, detail)
        case .stack(.podmanFailed(let command, let detail)):
            (subject, raw) = (command, detail)
        }
        guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return subject.map { "\($0) : \(raw)" } ?? raw
    }

    /// Le bandeau de l'Accueil quand la feuille a été fermée : `nil` tant qu'elle
    /// est visible (l'état vit dans la feuille), et `nil` une fois prêt.
    static func banner(state: SetupState, dismissed: Bool) -> String? {
        guard dismissed else { return nil }
        switch state {
        case .preparing(let step):
            return "Préparation en cours — \(stepDetail(step))"
        case .failed(let failure):
            return "Préparation incomplète. \(failureConsequence(failure))"
        case .idle, .ready:
            return nil
        }
    }
}
