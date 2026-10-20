// Le retour haptique d'une commande envoyée au Mac (ios-gestes-et-retours-natifs,
// S-5) : succès ou échec, joué à la RÉPONSE du Mac (`ConsoleClientModel.commandOutcome`),
// jamais à l'envoi. `RootView` le pose une seule fois par `sensoryFeedback`.
//
// Aucun réglage propre à l'app : le système ne joue le motif que sur un appareil
// à moteur haptique, au premier plan, réglage Haptique actif (ni l'iPad ni le
// simulateur ne jouent rien).

import ConsoleClient
import SwiftUI

/// Les dernières issues de commande des DEUX machines (S-10 de
/// orchestrator-living-in-a-vps) : une seule valeur à observer, donc un seul retour
/// haptique posé par la racine.
struct IOSCommandOutcomes: Equatable {
    var mac: ClientCommandOutcome?
    var vps: ClientCommandOutcome?

    init(mac: ClientCommandOutcome?, vps: ClientCommandOutcome?) {
        self.mac = mac
        self.vps = vps
    }

    @MainActor
    init(_ clients: MachineClients) {
        mac = clients.mac.commandOutcome
        vps = clients.vps.commandOutcome
    }
}

enum IOSCommandFeedback {
    /// Le motif de la commande qui vient d'aboutir : celle du VPS si son issue a changé,
    /// sinon celle du Mac.
    static func feedback(from old: IOSCommandOutcomes, to new: IOSCommandOutcomes) -> SensoryFeedback? {
        new.vps != old.vps ? feedback(for: new.vps) : feedback(for: new.mac)
    }

    /// Le motif système de l'issue : `.success` quand le Mac a répondu par un
    /// succès, `.error` sinon ; rien (`nil`) avant toute commande.
    static func feedback(for outcome: ClientCommandOutcome?) -> SensoryFeedback? {
        guard let outcome else { return nil }
        return outcome.succeeded ? .success : .error
    }
}
