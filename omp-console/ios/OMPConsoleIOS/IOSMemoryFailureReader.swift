// Le lecteur de PANNE de la Mémoire (`-memoire.recipe injoignable|service-ancien`,
// ios-redaction-vouvoiement, S-2) : un client `.connected` sans réseau dont chaque
// lecture échoue toujours de la même façon. Le sommaire et la recherche lèvent un Mac
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
    /// Un point d'accès factice : rien n'est jamais ouvert vers lui.
    let state: ClientState = .connected(endpoint: ClientEndpoint.manual(host: "127.0.0.1", port: 8787))

    func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        throw ClientError.transport(.unreachable(IOSMemoryText.failureRecipeDetail))
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        throw ClientError.transport(.unreachable(IOSMemoryText.failureRecipeDetail))
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        throw ClientError.api(.outdatedService(IOSMemoryText.failureRecipeDetail))
    }
}
