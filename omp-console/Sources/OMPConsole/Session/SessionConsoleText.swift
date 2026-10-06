// Ce que la coque garde des textes de la section « Session OMP » : les trois
// fonctions qui NOMMENT un type de la coque (`RpcMode`, `JournalEntry`,
// `SessionHost.State`). Les constantes et les tables `Status`/`Frame` vivent
// dans `ConsoleCore/Session/SessionConsoleText.swift`.

import ConsoleCore

extension SessionConsoleText {
    /// Le mode de la session, sans le nom du protocole.
    static func modeTitle(_ mode: RpcMode) -> String {
        switch mode {
        case .rpcUI: return "Dialogues : activés"
        case .rpc: return "Dialogues : désactivés"
        }
    }

    /// Une ligne du journal, préfixée de sa catégorie.
    static func journalLine(_ entry: JournalEntry) -> String {
        "[\(entry.kind.rawValue)] \(entry.message)"
    }

    /// L'état de la session hébergée en un mot.
    static func stateTitle(_ state: SessionHost.State, hasProject: Bool) -> String {
        switch state {
        case .idle: return hasProject ? "Prête" : "Aucun projet"
        case .launching: return "Démarrage…"
        case .running: return "Active"
        case .stopping: return "Arrêt…"
        case .stopped: return "Arrêtée"
        case .dead: return "Interrompue"
        case .failed: return "Échec"
        }
    }
}
