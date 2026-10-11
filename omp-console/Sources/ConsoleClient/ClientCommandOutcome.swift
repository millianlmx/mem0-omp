// L'issue d'une commande envoyée au Mac (ios-gestes-et-retours-natifs, S-5) :
// publiée par `ConsoleClientModel.commandOutcome` à la RÉPONSE du Mac, jamais à
// l'envoi. L'app iOS en tire son retour haptique de succès ou d'échec.
//
// `sequence` croît de 1 à chaque issue : deux issues de même résultat restent
// différentes, et un déclencheur `Equatable` (`sensoryFeedback(trigger:)`) les
// joue toutes les deux.

import Foundation

public struct ClientCommandOutcome: Equatable, Sendable {
    /// Le rang de l'issue depuis la création du modèle : 1 pour la première,
    /// strictement croissant ensuite.
    public let sequence: Int
    /// Vrai quand le Mac a répondu par un succès (statut 2xx décodé) ; faux pour
    /// un statut d'échec, une panne de transport, une charge illisible ou un refus
    /// local (`.notConnected`, verrou de version).
    public let succeeded: Bool

    public init(sequence: Int, succeeded: Bool) {
        self.sequence = sequence
        self.succeeded = succeeded
    }
}
