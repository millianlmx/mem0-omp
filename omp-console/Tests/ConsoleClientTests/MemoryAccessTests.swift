// L'accès de l'app iOS à la mémoire du serveur : posé par le code d'appairage,
// gardé d'un lancement à l'autre, et la portée lue — choisie, sinon la plus récente.

import Foundation
import Testing
@testable import ConsoleClient

@MainActor
@Suite("Accès à la mémoire du serveur")
struct MemoryAccessTests {
    @Test("le code d'appairage pose adresse et jeton, relus au lancement suivant ; une adresse vide les oublie")
    func configureAndReload() async throws {
        let preferences = InMemoryClientPreferences()
        let tokens = InMemoryTokenStore()
        let access = MemoryAccess(preferences: preferences, tokens: tokens)
        #expect(!access.isConfigured)
        await access.configure(address: "https://vps.tailnet.ts.net:8443/", token: "jeton")
        #expect(access.server == MemoryServer(baseURL: URL(string: "https://vps.tailnet.ts.net:8443")!, token: "jeton"))

        let relaunched = MemoryAccess(preferences: preferences, tokens: tokens)
        await relaunched.load()
        #expect(relaunched.server == access.server)

        await relaunched.configure(address: "", token: "")
        #expect(!relaunched.isConfigured)
        #expect(preferences.string(forKey: MemoryAccess.addressKey) == nil)
        #expect(try await tokens.token(for: MemoryAccess.tokenAccount) == nil)
    }

    @Test("sans portée choisie, la plus récente ; une portée choisie est gardée")
    func scope() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all", json: #"{"results":[{"id":"1","memory":"x","agent_id":"recent"},{"id":"2","memory":"y","agent_id":"ancien"}]}"#)
        transport.reply("/memory/all?agent_id=recent", json: #"{"results":[{"id":"1","memory":"x","agent_id":"recent"}]}"#)
        let preferences = InMemoryClientPreferences()
        let access = MemoryAccess(preferences: preferences, tokens: InMemoryTokenStore(), transport: transport)
        await access.configure(address: "https://vps:8443", token: "jeton")
        let page = try await access.memoryPage(scope: nil, offset: 0, limit: nil)
        #expect(page.scope == "recent")
        #expect(access.scopes == ["recent", "ancien"])

        access.choose(scope: "ancien")
        #expect(try await access.scope(nil) == "ancien")
        #expect(preferences.string(forKey: MemoryAccess.scopeKey) == "ancien")
    }

    @Test("sans mémoire configurée, une lecture échoue sans appel")
    func unconfigured() async {
        let transport = ScriptedMemoryTransport()
        let access = MemoryAccess(preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(), transport: transport)
        await #expect(throws: MemoryReadError.unreachable) { try await access.memoryPage(scope: nil, offset: 0, limit: nil) }
        #expect(transport.requests.isEmpty)
    }
}

/// Les lignes d'une portée telles que `GET /memory/all` les sert.
private func scopeJSON(_ count: Int, scope: String = "produit", prefix: String = "m") -> String {
    let items = (0 ..< count).map { #"{"id":"\#(prefix)\#($0)","memory":"souvenir \#($0)","agent_id":"\#(scope)"}"# }
    return #"{"total":\#(count),"results":[\#(items.joined(separator: ","))]}"#
}

/// Le nombre de requêtes parties vers `path` (requête comprise).
private func reads(_ transport: ScriptedMemoryTransport, _ path: String) -> Int {
    transport.requests.filter { request in
        request.url.map { $0.path + ($0.query.map { "?" + $0 } ?? "") } == path
    }.count
}

@MainActor
private func access(_ transport: ScriptedMemoryTransport, chosen: String? = nil) async -> MemoryAccess {
    let preferences = InMemoryClientPreferences()
    if let chosen { preferences.set(chosen, forKey: MemoryAccess.scopeKey) }
    let access = MemoryAccess(preferences: preferences, tokens: InMemoryTokenStore(), transport: transport)
    await access.configure(address: "https://vps:8443", token: "jeton")
    await access.load()
    return access
}

@MainActor
@Suite("Mémoire iOS : une seule lecture de portée par actualisation")
struct MemoryScopeReadsTests {
    private let edges = #"{"total":2,"edges":[{"source":"m0","target":"m1","score":0.8}]}"#

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-7 : sommaire, défilement jusqu'à la fin puis graphe lisent la portée et le graphe une seule fois, chaque souvenir une fois")
    func summaryScrollThenGraph() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all?agent_id=produit", json: scopeJSON(250))
        transport.reply("/memory/graph", json: edges)
        let memory = await access(transport, chosen: "produit")

        var ids: [String] = []
        var offset: Int? = 0
        while let start = offset {
            let page = try await memory.memoryPage(scope: start == 0 ? nil : "produit", offset: start, limit: nil)
            ids += page.rows.map(\.id)
            offset = page.nextOffset
        }
        let graph = try await memory.memoryGraph(scope: nil)

        #expect(ids == (0 ..< 250).map { "m\($0)" })
        #expect(graph.nodes.filter { $0.text != nil }.count == 250)
        #expect(reads(transport, "/memory/all?agent_id=produit") == 1)
        #expect(reads(transport, "/memory/graph") == 1)
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-7 : le graphe ouvert en premier lit la portée une fois, un second graphe (⌘R) la relit")
    func graphFirstThenRefresh() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all?agent_id=produit", json: scopeJSON(5))
        transport.reply("/memory/graph", json: edges)
        let memory = await access(transport, chosen: "produit")

        _ = try await memory.memoryGraph(scope: nil)
        #expect(reads(transport, "/memory/all?agent_id=produit") == 1)
        _ = try await memory.memoryGraph(scope: nil)
        #expect(reads(transport, "/memory/all?agent_id=produit") == 2)
        #expect(reads(transport, "/memory/graph") == 2)
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-8 : sans portée choisie, la lecture sans portée a lieu une fois et donne la portée la plus récente sans second téléchargement")
    func unscopedReadOnce() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all", json: #"{"total":4,"results":[{"id":"1","memory":"x","agent_id":"recent"},{"id":"2","memory":"y","agent_id":"ancien"},{"id":"3","memory":"z","agent_id":"recent"},{"id":"4","memory":"w"}]}"#)
        transport.reply("/memory/graph", json: edges)
        let memory = await access(transport)

        let page = try await memory.memoryPage(scope: nil, offset: 0, limit: nil)
        #expect(page.scope == "recent")
        #expect(page.rows.map(\.id) == ["1", "3"])
        #expect(page.total == 2)
        _ = try await memory.memoryGraph(scope: nil)

        #expect(transport.requests.map { $0.url?.absoluteString } == [
            "https://vps:8443/memory/all",
            "https://vps:8443/memory/graph",
        ])
        #expect(memory.scopes == ["recent", "ancien"])
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-8 : l'actualisation suivante relit la portée seule, jamais la lecture sans portée")
    func refreshAfterUnscoped() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all", json: #"{"total":2,"results":[{"id":"1","memory":"x","agent_id":"recent"},{"id":"2","memory":"y","agent_id":"ancien"}]}"#)
        transport.reply("/memory/all?agent_id=recent", json: scopeJSON(1, scope: "recent", prefix: "n"))
        let memory = await access(transport)

        _ = try await memory.memoryPage(scope: nil, offset: 0, limit: nil)
        let refreshed = try await memory.memoryPage(scope: nil, offset: 0, limit: nil)

        #expect(refreshed.rows.map(\.id) == ["n0"])
        #expect(reads(transport, "/memory/all") == 1)
        #expect(reads(transport, "/memory/all?agent_id=recent") == 1)
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-9 : actualiser relit la portée du serveur, les pages suivantes viennent de la nouvelle lecture et pas de l'ancienne")
    func refreshReadsAgain() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all?agent_id=produit", json: scopeJSON(250))
        let memory = await access(transport, chosen: "produit")
        _ = try await memory.memoryPage(scope: nil, offset: 0, limit: nil)
        _ = try await memory.memoryPage(scope: "produit", offset: 100, limit: nil)
        #expect(reads(transport, "/memory/all?agent_id=produit") == 1)

        transport.reply("/memory/all?agent_id=produit", json: scopeJSON(150, prefix: "n"))
        let first = try await memory.memoryPage(scope: nil, offset: 0, limit: nil)
        let next = try await memory.memoryPage(scope: "produit", offset: 100, limit: nil)

        #expect(reads(transport, "/memory/all?agent_id=produit") == 2)
        #expect(first.total == 150)
        #expect(next.total == 150)
        #expect(next.rows.map(\.id) == (100 ..< 150).map { "n\($0)" })
        #expect(next.nextOffset == nil)
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-9 : une actualisation en échec lève sa cause et laisse la lecture précédente aux pages suivantes")
    func failedRefreshKeepsData() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all?agent_id=produit", json: scopeJSON(250))
        let memory = await access(transport, chosen: "produit")
        _ = try await memory.memoryPage(scope: nil, offset: 0, limit: nil)

        transport.fail("/memory/all?agent_id=produit", URLError(.timedOut))
        await #expect(throws: MemoryReadError.timedOut) { try await memory.memoryPage(scope: nil, offset: 0, limit: nil) }
        let next = try await memory.memoryPage(scope: "produit", offset: 100, limit: nil)

        #expect(next.rows.map(\.id) == (100 ..< 200).map { "m\($0)" })
        #expect(reads(transport, "/memory/all?agent_id=produit") == 2)
    }
}
