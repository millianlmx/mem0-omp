// Les états qui NOMMENT un type de la coque : `ConsoleStatus` (et le reste du
// vocabulaire commun) vit dans `ConsoleCore`, mais cette fabrique prend
// `ServiceSessionModel.State`, qui n'est pas partagé — elle reste donc ici, en
// extension (une seule définition de `ConsoleStatus` dans tout le paquet).
// `ConsoleStatus.of(card:)` et `of(run:)` ont déménagé dans `ConsoleCore` : elles
// ne nomment que des types partagés, les deux coques les affichent.

import ConsoleCore

extension ConsoleStatus {
    /// L'état d'une session OMP hébergée (Session OMP, Projet) : le mot de
    /// `SessionConsoleText.stateTitle` et son ton.
    static func of(session state: ServiceSessionModel.State, hasProject: Bool) -> ConsoleStatus {
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
