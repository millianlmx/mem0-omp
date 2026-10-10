// Ce que la coque garde des textes de la section « Session OMP » : les deux
// fonctions qui NOMMENT un type de la coque (`JournalEntry`,
// `ServiceSessionModel.State`). Les constantes et les tables `Status`/`Frame`
// vivent dans `ConsoleCore/Session/SessionConsoleText.swift`.

import ConsoleCore

extension SessionConsoleText {
    /// Une ligne du journal, préfixée de sa catégorie.
    static func journalLine(_ entry: JournalEntry) -> String {
        "[\(entry.kind.rawValue)] \(entry.message)"
    }

    /// L'état de la session servie en un mot.
    static func stateTitle(_ state: ServiceSessionModel.State, hasProject: Bool) -> String {
        switch state {
        case .idle: return hasProject ? "Prête" : SessionConsoleText.Status.idleNoProject
        case .launching: return "Démarrage…"
        case .running: return "Active"
        case .stopping: return "Arrêt…"
        case .stopped: return "Arrêtée"
        case .dead: return "Interrompue"
        case .failed: return "Échec"
        }
    }

    /// L'état lisible de la ligne « État » des inspecteurs Session OMP et Projet
    /// (S-3 de jargon-technique-expose-mac-et-ios) : trois mots seulement. Le
    /// motif d'un échec n'y figure pas : il vit dans `diagnostic`.
    static func inspectorState(_ state: SessionRunStatus) -> String {
        switch state {
        case .running: return SessionConsoleText.stateRunning
        case .idle, .launching, .stopping: return SessionConsoleText.stateWaiting
        case .stopped, .dead, .failed: return SessionConsoleText.stateStopped
        }
    }

    /// Le brut de « Copier le diagnostic » des inspecteurs : exactement cinq
    /// lignes, dans cet ordre ; une valeur inconnue se dit « absent ».
    static func diagnostic(
        pid: Int32?,
        state: SessionRunStatus,
        sessionId: String?,
        projectPath: String?,
        sessionFile: String?
    ) -> String {
        let absent = "absent"
        return [
            "numéro de processus : \(pid.map { String($0) } ?? absent)",
            "état : \(String(describing: state))",
            "identifiant de session : \(sessionId ?? absent)",
            "projet : \(projectPath ?? absent)",
            "fichier de session : \(sessionFile ?? absent)",
        ].joined(separator: "\n")
    }
}
