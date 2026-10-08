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
}
