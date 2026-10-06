// Les états qui NOMMENT un type de la coque : `ConsoleStatus` (et le reste du
// vocabulaire commun) vit dans `ConsoleCore`, mais ces trois fabriques prennent
// `KanbanCard`, `RunChoice` et `SessionHost.State`, qui ne sont pas partagés —
// elles restent donc ici, en extension (une seule définition de `ConsoleStatus`
// dans tout le paquet).

import ConsoleCore

extension ConsoleStatus {
    /// L'état d'une carte de l'ardoise. Une carte que « Reprendre » peut relancer
    /// est « En pause » quelle que soit sa colonne (le pilote est mort, la feature
    /// vit encore).
    static func of(card: KanbanCard) -> ConsoleStatus {
        if KanbanActionPresentation.resumable(card) {
            return ConsoleStatus(text: "En pause", tone: .paused)
        }
        switch card.column {
        case .enAttente: return ConsoleStatus(text: "Pas commencée", tone: .neutral)
        case .enCours: return ConsoleStatus(text: "En cours", tone: .info)
        case .questionEnVol: return ConsoleStatus(text: "À vous", tone: .attention)
        case .prOuverte: return ConsoleStatus(text: "PR ouverte", tone: .success)
        case .fusionne: return ConsoleStatus(text: "Fusionnée", tone: .success)
        case .echec: return ConsoleStatus(text: "Échec", tone: .danger)
        case .jalonSpecs: return ConsoleStatus(text: "Specs à valider", tone: .attention)
        case .jalonReview: return ConsoleStatus(text: "Revue à accepter", tone: .attention)
        case .bloquee: return ConsoleStatus(text: "Bloquée", tone: .danger)
        case .termineeSansPr: return ConsoleStatus(text: "Terminée", tone: .neutral)
        case .annuleeRetiree: return ConsoleStatus(text: "Annulée", tone: .neutral)
        }
    }

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
