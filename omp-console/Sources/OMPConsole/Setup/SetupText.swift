// Ce que la coque garde des textes de la préparation : les fonctions qui nomment
// un type de la coque (`ComponentID`, `SetupStep`, `OMLXStatus`, `SetupFailure`,
// `SetupState`, `ImportReport`). Toutes les constantes et `percent(_:_:)` vivent
// dans `ConsoleCore/Setup/SetupText.swift`.

import ConsoleCore
import Foundation

extension SetupText {
    /// Le mot du badge pour les composants manquants (S-1, AC-1/AC-2) :
    /// « <nom> manquant », ou le mot « tout est installé » quand rien ne manque.
    /// OMP est le seul composant que l'app installe.
    static func componentsWord(_ missing: [ComponentID]) -> String {
        guard let component = missing.first else { return componentsAllInstalled }
        return "\(component.name) manquant"
    }

    /// Le détail d'une étape en cours. Le téléchargement d'OMP affiche son
    /// pourcentage seulement quand la taille totale est connue (`total == 0` ⇒
    /// « Téléchargement d'OMP… »).
    static func stepDetail(_ step: SetupStep) -> String {
        switch step {
        case .omp(let downloaded, let total):
            if total <= 0 { return "Téléchargement d’OMP…" }
            return "Téléchargement d’OMP — \(percent(downloaded, total)) %"
        case .ompInstall:
            return "Installation d’OMP…"
        case .migrationStart:
            return "Démarrage de l’ancienne mémoire…"
        case .migrationImport:
            return "Reprise des souvenirs de l’ancienne mémoire…"
        case .migrationStop:
            return "Arrêt de l’ancienne mémoire…"
        case .agent:
            return "Démarrage du service mémoire…"
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

    /// Le détail BRUT d'un échec de préparation (S-5) : commande, détail, port,
    /// propriétaire et geste shell. Seul « Copier le diagnostic » l'emporte.
    /// `logPath` est le journal de l'agent, nommé par un délai de santé dépassé.
    static func failureDiagnostic(_ failure: SetupFailure, logPath: String = AppPaths.standard().mem0Log.path) -> String {
        switch failure {
        case .components(.unsupportedMac):
            return "Ce Mac n’est pas pris en charge (arm64 requis)."
        case .components(.network(let component, _)):
            return "Pas de réseau : « \(component) » n’a pas pu être téléchargé. Vérifiez votre connexion, puis réessayez."
        case .components(.checksum(let component)):
            return "« \(component) » téléchargé est corrompu (empreinte SHA-256 différente). La préparation a été interrompue."
        case .components(.install(let component, let detail)):
            return "L’installation de « \(component) » a échoué : \(detail)"
        case .migration(.podmanMissing(let path)):
            return "podman introuvable : \(path)"
        case .migration(.machineFailed(let detail)):
            return "La machine podman omp-console n’a pas démarré : \(detail)"
        case .migration(.qdrantUnreachable(let detail)):
            return "Qdrant (127.0.0.1:6333, conteneur omp-console-qdrant) injoignable : \(detail)"
        case .migration(.historyCopyFailed(let detail)):
            return "podman cp omp-console-mem0-http:/home/mem0/.mem0/history.db a échoué : \(detail)"
        case .migration(.importFailed(let code, let detail)):
            return "mem0-rs import a échoué (code \(code)) : \(detail)"
        case .migration(.stopFailed(let detail)):
            return "podman stop omp-console-mem0-http omp-console-qdrant a échoué : \(detail)"
        case .migration(.stateWriteFailed(let path, let detail)):
            return "État de bascule non inscriptible (\(path)) : \(detail)"
        case .agent(.binaryMissing(let path)):
            return "mem0-rs absent ou non exécutable : \(path)"
        case .agent(.launchctlFailed(let command, let detail)):
            return "launchctl \(command) a échoué : \(detail)"
        case .agent(.plistWriteFailed(let path, let detail)):
            return "Plist de l’agent non inscriptible (\(path)) : \(detail)"
        case .agent(.healthTimeout(let seconds, let log)):
            return "Le service mémoire n’a pas répondu dans le délai imparti (\(seconds) s).\nJournal : \(logPath)\n\(log)"
        case .agent(.installationFailed(let detail)):
            return "L’identité d’installation de la pile n’a pas pu être écrite : \(detail)"
        case .agent(.portConflict(let port, let owner)):
            return "Le port \(port) est déjà tenu par \(owner.userDescription) : la mémoire ne peut pas démarrer.\nGeste : \(owner.gesture)"
        }
    }

    /// La conséquence d'un échec (S-5) : ce que l'utilisateur perd, sans commande,
    /// détail brut ni port. Les échecs des composants gardent leur texte actuel.
    static func failureConsequence(_ failure: SetupFailure) -> String {
        switch failure {
        case .components:
            return failureDiagnostic(failure)
        case .migration(.podmanMissing):
            return failureLegacyMissing
        case .migration(.machineFailed):
            return failureLegacyMachine
        case .migration(.qdrantUnreachable):
            return failureLegacyUnreachable
        case .migration(.historyCopyFailed):
            return failureHistoryCopy
        case .migration(.importFailed):
            return failureImport
        case .migration(.stopFailed):
            return failureLegacyStop
        case .migration(.stateWriteFailed):
            return failureSwitchState
        case .agent(.binaryMissing):
            return failureAgentMissing
        case .agent(.launchctlFailed), .agent(.plistWriteFailed):
            return failureAgentLaunch
        case .agent(.healthTimeout):
            return failureAgentHealth
        case .agent(.installationFailed):
            return failureAgentIdentity
        case .agent(.portConflict(_, .foreign(let process, _))):
            return failurePortProgram(process)
        case .agent(.portConflict):
            return failurePortOther
        }
    }

    /// La phrase de la ligne en échec (S-5) : la conséquence, puis le geste qui
    /// règle le cas. Les échecs des composants gardent leur phrase actuelle.
    static func failureMessage(_ failure: SetupFailure) -> String {
        let consequence = failureConsequence(failure)
        switch failure {
        case .components:
            return consequence
        case .agent(.binaryMissing):
            return "\(consequence) \(failureReinstallGesture)"
        case .agent(.portConflict(_, .foreign)):
            return "\(consequence) \(failurePortProgramGesture)"
        case .migration, .agent:
            return "\(consequence) \(failureRetryGesture)"
        }
    }

    /// La phrase claire d'un échec, telle que la feuille la montre : jamais le
    /// détail technique, qui se replie derrière « Afficher le détail » (S-6).
    /// La migration et le service mémoire reprennent `failureMessage`.
    static func failureSummary(_ failure: SetupFailure) -> String {
        switch failure {
        case .components(.unsupportedMac):
            return "Ce Mac n’est pas pris en charge (arm64 requis)."
        case .components(.network(let component, _)):
            return "Pas de réseau : « \(component) » n’a pas pu être téléchargé. Vérifiez votre connexion, puis réessayez."
        case .components(.checksum(let component)):
            return "« \(component) » téléchargé est corrompu (empreinte SHA-256 différente). La préparation a été interrompue."
        case .components(.install(let component, _)):
            return "L’installation de « \(component) » a échoué."
        case .migration, .agent:
            return failureMessage(failure)
        }
    }

    /// Le détail technique d'un échec, replié par défaut sous la phrase claire
    /// (S-6) ; `nil` quand il n'y en a pas, ou qu'il n'est fait que de blancs. Le
    /// geste d'un conflit de port (une commande) s'y range aussi.
    static func failureDetail(_ failure: SetupFailure) -> String? {
        let subject: String?
        let raw: String
        switch failure {
        case .components(.unsupportedMac), .components(.checksum):
            return nil
        case .agent(.portConflict(_, let owner)):
            return "Geste : \(owner.gesture)"
        case .components(.network(_, let detail)), .components(.install(_, let detail)),
             .migration(.machineFailed(let detail)), .migration(.qdrantUnreachable(let detail)),
             .migration(.historyCopyFailed(let detail)), .migration(.stopFailed(let detail)),
             .agent(.installationFailed(let detail)), .agent(.healthTimeout(_, let detail)):
            (subject, raw) = (nil, detail)
        case .migration(.podmanMissing(let path)), .agent(.binaryMissing(let path)):
            (subject, raw) = (nil, path)
        case .migration(.importFailed(let code, let detail)):
            (subject, raw) = ("code \(code)", detail)
        case .migration(.stateWriteFailed(let path, let detail)), .agent(.plistWriteFailed(let path, let detail)):
            (subject, raw) = (path, detail)
        case .agent(.launchctlFailed(let command, let detail)):
            (subject, raw) = (command, detail)
        }
        guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return subject.map { "\($0) : \(raw)" } ?? raw
    }

    /// La ligne de la migration quand l'import a laissé des éléments de côté
    /// (S-5) : leur nombre, puis les raisons groupées, de la plus fréquente à la
    /// plus rare (puis par libellé).
    static func rejectedSummary(_ report: ImportReport) -> String {
        var counts: [String: Int] = [:]
        for reject in report.rejects {
            counts[rejectionReason(reject.raison), default: 0] += 1
        }
        let groups = counts
            .sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
            .map { "\($0.key) (\($0.value))" }
            .joined(separator: ", ")
        let total = ConsoleFormat.count(report.totalRejected, "élément", "éléments")
        return "L’import a laissé de côté \(total) : \(groups)."
    }

    /// Le détail repliable des rejets : une ligne par élément laissé de côté.
    static func rejectedDetail(_ report: ImportReport) -> String {
        report.rejects
            .map { "\($0.element) \($0.id) — \(rejectionReason($0.raison)) (\($0.detail))" }
            .joined(separator: "\n")
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
        case .awaitingSwitch:
            return bannerAwaitingSwitch
        case .idle, .ready:
            return nil
        }
    }
}
