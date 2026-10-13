// Le verdict de l'attente « prêt à émettre » (`ConsoleClientModel.waitUntilReady()`) :
// le Mac confirmé, ou la cause typée qui empêche d'émettre.
//
// Il est déduit des faits déjà publiés (`pairing`, `state`) et d'une trame `hello`
// compatible reçue sur le flux ouvert ; il n'ajoute aucun état publié.

import Foundation

public enum ClientReadiness: Equatable, Sendable {
    /// Le Mac est confirmé : flux ouvert ET trame `hello` reçue avec la version d'API locale.
    case ready(endpoint: ClientEndpoint)
    /// Trousseau relu, aucun jeton (et aucun refus en cours).
    case notPaired
    /// Le Mac a refusé le jeton (401) : appareil révoqué côté Mac.
    case pairingRefused
    /// Mac non confirmé à l'échéance (ou attente annulée).
    case macUnreachable
    /// Verrou de version posé : numéros local et distant (distant inconnu = nil).
    case incompatibleVersion(local: Int, remote: Int?)
}
