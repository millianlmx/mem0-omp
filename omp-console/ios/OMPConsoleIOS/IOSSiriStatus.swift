// Ce que l'intent témoin énonce de l'état du serveur de pipelines : une table PURE
// (relié ou non, joint ou non, ce qui attend l'humain), plus une relecture de la
// boîte. Aucune écriture. Les mots vivent dans `IOSSiriText`.

import ConsoleClient
import Foundation

enum IOSSiriStatus: Equatable, Sendable {
    /// Aucun code d'appairage sur cet appareil.
    case unconfigured
    /// Un serveur est relié, mais sa boîte n'a pas pu être lue.
    case unreachable
    /// La boîte du serveur est lue : ce qui attend l'humain.
    case connected(pending: Int)

    /// La table : relié, puis lu.
    static func resolve(isConfigured: Bool, inbox: HarnessInbox?, failed: Bool) -> IOSSiriStatus {
        guard isConfigured else { return .unconfigured }
        guard let inbox, !failed else { return .unreachable }
        return .connected(pending: inbox.pendingCount)
    }

    /// La phrase énoncée.
    var phrase: String {
        switch self {
        case .unconfigured: IOSSiriText.unconfigured
        case .unreachable: IOSSiriText.unreachable
        case .connected(let pending): IOSSiriText.connected(pending: pending)
        }
    }

    /// Relit le réglage du serveur (un lancement à froid par Siri ne l'a pas encore
    /// lu), puis sa boîte, et énonce l'état à cet instant. Ne lève jamais.
    @MainActor
    static func answer(for server: HarnessModel) async -> String {
        await server.load()
        if server.isConfigured { await server.refresh() }
        return resolve(isConfigured: server.isConfigured, inbox: server.inbox, failed: server.failure != nil).phrase
    }
}
