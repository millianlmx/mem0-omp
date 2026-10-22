// Le statut PRÉSENTÉ de la mémoire du serveur dans l'app iOS : une fonction PURE
// de l'accès (`MemoryAccess`), lue par l'écran Mémoire pour choisir entre ses
// données, le composant « lecture des réglages » et le composant « mémoire non
// reliée » avec sa cause. Une panne de lecture n'est pas un statut : elle a sa
// propre phrase (`IOSMemoryErrorText`).

import ConsoleClient

/// La cause d'une mémoire non reliée, avec sa phrase
/// (`IOSConnectionStateText.cause(_:)`).
enum IOSDisconnectCause: Equatable, Sendable {
    /// Aucun code d'appairage sur cet appareil, ou un code sans mémoire.
    case unpaired
}

enum IOSConnectionStatus: Equatable, Sendable {
    case connected
    case connecting
    case disconnected(IOSDisconnectCause)

    /// La table : réglages pas encore lus, mémoire configurée, ou rien.
    static func resolve(isLoaded: Bool, isConfigured: Bool) -> IOSConnectionStatus {
        if isConfigured { return .connected }
        return isLoaded ? .disconnected(.unpaired) : .connecting
    }

    /// Le statut présenté de l'accès partagé.
    @MainActor
    static func of(_ memory: MemoryAccess) -> IOSConnectionStatus {
        resolve(isLoaded: memory.isLoaded, isConfigured: memory.isConfigured)
    }

    /// Les gestes qui lisent la mémoire ne sont tapables qu'une fois reliée.
    var gesturesEnabled: Bool {
        self == .connected
    }
}
