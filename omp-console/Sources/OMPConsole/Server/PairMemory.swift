// La mémoire du projet que la feuille « Appairer un iPhone » joint au ticket : celle d'un SERVEUR
// (`~/.omp/mem0.json` ou `MEM0_HTTP_URL`), avec son jeton, que l'iPhone lira comme celle d'un code
// `omp1:`. L'agent mem0 de ce Mac (localhost) n'est jamais joint : l'iPhone ne l'atteindrait pas.

import ConsoleClient
import Foundation

enum PairMemory {
    /// La mémoire à joindre, ou `nil` : mémoire locale, adresse qui n'est pas http(s), ou jeton que le
    /// serveur refuserait (blanc, plus de 512 caractères) — un ticket refusé ne s'afficherait pas.
    static func current(environment: [String: String] = ProcessInfo.processInfo.environment) -> HarnessPairMemory? {
        let config = MemoryServiceConfig.fromEnvironment(environment)
        guard config.isRemote, let scheme = config.baseURL.scheme?.lowercased(), scheme == "http" || scheme == "https",
              config.token.count <= 512, !config.token.contains(where: \.isWhitespace)
        else { return nil }
        let url = config.baseURL.absoluteString
        guard url.count <= 500, !url.contains(where: \.isWhitespace) else { return nil }
        return HarnessPairMemory(url: url, token: config.token)
    }
}
