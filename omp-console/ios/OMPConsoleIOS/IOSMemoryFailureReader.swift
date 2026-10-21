// Le lecteur de PANNE de la Mémoire (`-memoire.recipe injoignable|service-ancien`,
// ios-redaction-vouvoiement, S-2) : une mémoire reliée sans réseau dont chaque
// lecture échoue toujours de la même façon. Le sommaire et la recherche lèvent un serveur
// injoignable ; le graphe, un service mémoire trop ancien. Les modèles, le traducteur
// d'erreurs et l'écran sont ceux de production : seul le lecteur change, et
// « Réessayer » retombe dans la même panne.
//
// Aucun littéral alphabétique ici (les mots viennent d'`IOSMemoryText`), aucun
// jeton du magasin, aucune horloge.

import ConsoleClient
import ConsoleCore
import Foundation

@MainActor
final class IOSMemoryFailureReader: IOSMemoryReading {
    /// Une mémoire tenue pour reliée : rien n'est jamais ouvert vers le réseau.
    let isConfigured = true

    func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        throw MemoryReadError.unreachable
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        throw MemoryReadError.unreachable
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        throw MemoryReadError.outdated
    }
}
