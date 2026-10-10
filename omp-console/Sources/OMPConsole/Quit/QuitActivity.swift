// L'inventaire des activités au moment du Quitter (mac-quitter-sans-confirmation,
// S-1) : une valeur par source, prise d'un trait à la demande de sortie et jamais
// réévaluée tant que l'alerte est ouverte.
//
// Deux familles, selon l'effet VRAI de la sortie (arbitrage 2 du contrat) :
//   - la Session OMP hébergée et la commande au premier plan du Terminal MEURENT
//     au Quitter : elles seules déclenchent l'alerte ;
//   - le pilotage (seulement détaché) et les pipelines (servies par le service
//     OMP, un job launchd) CONTINUENT dans OMP : citées quand l'alerte s'affiche,
//     elles ne la déclenchent jamais.

import Foundation

enum QuitActivity: Equatable, Sendable {
    /// Session OMP hébergée : s'ARRÊTE au Quitter (DELETE de la session).
    case session(name: String?)
    /// Commande au premier plan du Terminal intégré : s'ARRÊTE (SIGTERM puis
    /// SIGKILL au groupe du shell).
    case terminalCommand(name: String?)
    /// Pilotage de projet : CONTINUE dans OMP (l'app s'en détache seulement).
    case pilotage(name: String?)
    /// Pipelines en cours (`count ≥ 1`) : CONTINUENT dans OMP.
    case pipelines(count: Int)

    /// `true` pour les seules activités que le Quitter arrête.
    var stopsAtQuit: Bool {
        switch self {
        case .session, .terminalCommand: return true
        case .pilotage, .pipelines: return false
        }
    }

    /// Les constructeurs normalisés : un nom vide ou fait seulement de blancs
    /// devient `nil`, pour que le texte prenne la variante sans nom.
    static func session(named name: String?) -> QuitActivity {
        .session(name: normalized(name))
    }

    static func terminalCommand(named name: String?) -> QuitActivity {
        .terminalCommand(name: normalized(name))
    }

    static func pilotage(named name: String?) -> QuitActivity {
        .pilotage(name: normalized(name))
    }

    /// `nil` quand aucune pipeline n'est en cours : l'activité est alors absente.
    static func pipelines(running count: Int) -> QuitActivity? {
        count >= 1 ? .pipelines(count: count) : nil
    }

    static func normalized(_ name: String?) -> String? {
        guard let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return name
    }
}

/// Le texte de l'alerte « Quitter arrêtera… » (S-3), dérivé d'un instantané.
struct QuitPrompt: Equatable, Sendable {
    let title: String
    let message: String
}

extension QuitPrompt {
    /// `nil` ⇔ aucune activité ne s'arrête au Quitter (liste vide, ou seulement
    /// pilotage et pipelines) : la sortie se fait sans alerte (B-3, arbitrage 2).
    /// Sinon une ligne par activité présente, dans l'ordre FIXE session, commande
    /// du Terminal, pilotage, pipelines, quel que soit l'ordre d'entrée.
    static func make(_ activities: [QuitActivity]) -> QuitPrompt? {
        guard activities.contains(where: \.stopsAtQuit) else { return nil }
        var session: String?
        var terminal: String?
        var pilotage: String?
        var pipelines: String?
        for activity in activities {
            switch activity {
            case .session(let name): session = QuitText.sessionStops(name: name)
            case .terminalCommand(let name): terminal = QuitText.terminalStops(command: name)
            case .pilotage(let name): pilotage = QuitText.pilotageContinues(name: name)
            case .pipelines(let count): pipelines = QuitText.pipelinesContinue(count: count)
            }
        }
        let lines = [session, terminal, pilotage, pipelines].compactMap { $0 }
        return QuitPrompt(title: QuitText.title, message: lines.joined(separator: "\n"))
    }
}
