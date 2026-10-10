// Le lecteur de RECETTE de la Mémoire en mode liste (`-memoire.recipe clavier`,
// ipad-clavier-et-largeur-de-lecture, S-8) : un client `.connected` sans réseau qui
// sert la fixture PARTAGÉE `MemoryGraphParity` par les trois lectures de
// `IOSMemoryReading`. Le modèle et l'écran sont ceux de production ; seul le
// lecteur change.
//
// Chaque lecture d'une page du sommaire écrit `IOSMemoryText.keyboardRecipeRead`
// sur la sortie d'erreur du lancement (`--stderr`), par le même canal que le signal
// de prêt du graphe : la recette du clavier y compte les relectures de ⌘R. La
// fixture tient en UNE page (aucune page suivante) : une relecture = un signal.
//
// Aucun littéral alphabétique ici (les mots viennent d'`IOSMemoryText`), aucun
// jeton du magasin, aucune horloge.

import ConsoleClient
import ConsoleCore
import Foundation

@MainActor
final class IOSMemoryRecipeReader: IOSMemoryReading {
    /// Un point d'accès factice : rien n'est jamais ouvert vers lui.
    let state: ClientState = .connected(endpoint: ClientEndpoint.manual(host: "127.0.0.1", port: 8787))

    /// Les souvenirs de la fixture qui portent un texte, dans l'ordre du graphe.
    private static var rows: [RemoteMemoryRow] {
        MemoryGraphParity.facts.nodes.compactMap { node in
            guard case let .memory(id) = node.id, let text = node.text, !text.isEmpty else { return nil }
            return RemoteMemoryRow(id: id, text: text, updatedAt: nil, score: nil, tags: node.tags, agentId: node.scope)
        }
    }

    /// La portée du sommaire : la première portée nommée du graphe de parité.
    private static var scope: String? {
        MemoryGraphParity.facts.nodes.compactMap(\.scope).first
    }

    func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        FileHandle.standardError.write(Data(IOSMemoryText.keyboardRecipeRead.utf8))
        let rows = Self.rows
        return RemoteMemoryPagePayload(scope: Self.scope, total: rows.count, offset: 0, rows: rows, nextOffset: nil)
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        let rows = Self.rows.filter { $0.text.localizedCaseInsensitiveContains(query) }
        return RemoteMemorySearchPayload(rows: rows, candidates: rows.count, scored: rows.count)
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        IOSMemoryGraphRecipe.clavier.payload
    }
}
