// Le retour haptique d'une commande envoyée au Mac (ios-gestes-et-retours-natifs,
// S-5) : succès ou échec, joué à la RÉPONSE du Mac (`ConsoleClientModel.commandOutcome`),
// jamais à l'envoi. `RootView` le pose une seule fois par `sensoryFeedback`.
//
// Aucun réglage propre à l'app : le système ne joue le motif que sur un appareil
// à moteur haptique, au premier plan, réglage Haptique actif (ni l'iPad ni le
// simulateur ne jouent rien).

import ConsoleClient
import SwiftUI

enum IOSCommandFeedback {
    /// Le motif système de l'issue : `.success` quand le Mac a répondu par un
    /// succès, `.error` sinon ; rien (`nil`) avant toute commande.
    static func feedback(for outcome: ClientCommandOutcome?) -> SensoryFeedback? {
        guard let outcome else { return nil }
        return outcome.succeeded ? .success : .error
    }
}
