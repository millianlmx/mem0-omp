// Le journal des gestes (S-4) : l'état d'une entrée et l'entrée elle-même.
//
// Extrait du modèle macOS `ActionsModel` pour vivre dans le noyau partagé : la
// coque macOS et l'app iOS emploient les MÊMES types, `Codable` synthétisé, sans
// couche DTO (S-1, S-5).
//
// VIT DANS `ConsoleCore`.

import Foundation

/// L'état d'une entrée de journal (S-4) : en attente d'accusé, prise en charge,
/// refusée (avec le motif du pilote ou sans), déposée, en échec d'écriture, ou
/// restée sans accusé au-delà de `ActionsModel.ackTimeoutMs` (S-8 de
/// omp-console-redesign).
public enum ActionJournalState: Sendable, Equatable, Codable {
    case awaitingAck
    case taken
    case refused(reason: String?)
    case delivered
    case failed(reason: String)
    case unacknowledged
}

/// Une entrée du journal des gestes : le libellé du geste (`réponse`, `texte`,
/// `jalon specs`, `jalon revue`, `lancement`, `arrêt`), la cible (label du run,
/// slug, titre, nom du dépôt) et l'état.
public struct ActionJournalEntry: Identifiable, Sendable, Equatable, Codable {
    public let id: String
    public let kindLabel: String
    public let targetLabel: String
    public var state: ActionJournalState
    public let at: Double

    public init(id: String, kindLabel: String, targetLabel: String, state: ActionJournalState, at: Double) {
        self.id = id
        self.kindLabel = kindLabel
        self.targetLabel = targetLabel
        self.state = state
        self.at = at
    }
}
