// L'inventaire des activités au moment du Quitter (mac-quitter-sans-confirmation,
// S-1) : une valeur prise d'un trait à la demande de sortie et jamais réévaluée
// tant que l'alerte est ouverte.
//
// Seule la commande au premier plan du Terminal intégré meurt au Quitter : elle
// seule déclenche l'alerte. Les pipelines vivent sur le serveur du VPS, que la
// sortie de l'app ne touche pas.

import Foundation

enum QuitActivity: Equatable, Sendable {
    /// Commande au premier plan du Terminal intégré : s'ARRÊTE (SIGTERM puis
    /// SIGKILL au groupe du shell).
    case terminalCommand(name: String?)

    /// Le constructeur normalisé : un nom vide ou fait seulement de blancs
    /// devient `nil`, pour que le texte prenne la variante sans nom.
    static func terminalCommand(named name: String?) -> QuitActivity {
        .terminalCommand(name: normalized(name))
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
    /// `nil` ⇔ aucune activité : la sortie se fait sans alerte (B-3). Sinon une
    /// ligne par activité.
    static func make(_ activities: [QuitActivity]) -> QuitPrompt? {
        guard !activities.isEmpty else { return nil }
        let lines = activities.map { activity in
            switch activity {
            case .terminalCommand(let name): QuitText.terminalStops(command: name)
            }
        }
        return QuitPrompt(title: QuitText.title, message: lines.joined(separator: "\n"))
    }
}
