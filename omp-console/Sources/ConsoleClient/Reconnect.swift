// Le sommeil de la reconnexion, derrière une couture injectable : les tests
// enregistrent la suite demandée sans attendre réellement (S-7).

import Foundation

/// La couture de temporisation du repli de reconnexion.
public protocol ClientPacer: Sendable {
    func sleep(seconds: Double) async throws
}

/// La production : un vrai `Task.sleep`.
public struct LiveClientPacer: ClientPacer {
    public init() {}

    public func sleep(seconds: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
}

/// Le repli progressif BORNÉ : jamais de boucle serrée.
public enum ClientRetry {
    /// La table des délais, en secondes ; au-delà, 30 s indéfiniment.
    public static let delays: [Double] = [0.5, 1, 2, 4, 8, 15, 30]

    /// Le délai de recherche Bonjour, en secondes : resté `.searching` (jeton,
    /// réseau, aucun Mac résolu) au-delà de cette attente, l'affichage dit
    /// « Mac injoignable » au lieu de « connexion en cours ».
    public static let searchGrace: Double = 10

    /// Le délai de la n-ième tentative (1 = première) : `delays[min(n-1, 6)]`.
    public static func delay(attempt: Int) -> Double {
        let index = min(max(attempt - 1, 0), delays.count - 1)
        return delays[index]
    }
}
