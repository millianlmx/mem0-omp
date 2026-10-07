// Les états qui NOMMENT un type de la coque : `ConsoleStatus` (et le reste du
// vocabulaire commun) vit dans `ConsoleCore`, mais ces deux fabriques prennent
// `RunChoice` et `SessionHost.State`, qui ne sont pas partagés — elles restent
// donc ici, en extension (une seule définition de `ConsoleStatus` dans tout le
// paquet). `ConsoleStatus.of(card:)` a déménagé dans `ConsoleCore` : elle ne
// nomme que des types partagés, les deux coques l'affichent.

import ConsoleCore

extension ConsoleStatus {
    /// L'état d'un run de la liste des sessions : un run vivant au propriétaire
    /// périmé est « Interrompu ».
    static func of(run: RunChoice) -> ConsoleStatus {
        switch run.state {
        case .live where run.isStale:
            return ConsoleStatus(text: "Interrompu", tone: .neutral)
        case .live(.running):
            return ConsoleStatus(text: "En cours", tone: .info)
        case .live(.waiting):
            return ConsoleStatus(text: "À vous", tone: .attention)
        case .ended(.done):
            return ConsoleStatus(text: "Terminé", tone: .success)
        case .ended(.failed):
            return ConsoleStatus(text: "Échec", tone: .danger)
        }
    }

    /// L'état d'une session OMP hébergée (Session OMP, Projet) : le mot de
    /// `SessionConsoleText.stateTitle` et son ton.
    static func of(session state: SessionHost.State, hasProject: Bool) -> ConsoleStatus {
        let text = SessionConsoleText.stateTitle(state, hasProject: hasProject)
        let tone: ConsoleTone = switch state {
        case .running: .success
        case .launching: .info
        case .stopping, .idle, .stopped: .neutral
        case .dead, .failed: .danger
        }
        return ConsoleStatus(text: text, tone: tone)
    }
}
