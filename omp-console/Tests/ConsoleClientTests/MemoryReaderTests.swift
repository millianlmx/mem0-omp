// La lecture DIRECTE de la mémoire du serveur par l'app iOS (`MemoryReader`) :
// pages du sommaire, recherche de `mem0_search`, graphe du noyau, portées, et une
// cause par panne. Hermétique : une doublure de transport rend statut et corps.

import ConsoleCore
import Foundation
import Testing
@testable import ConsoleClient

/// Rend la réponse scriptée de chaque chemin et retient les requêtes reçues.
final class ScriptedMemoryTransport: MemoryTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [String: Result<(status: Int, body: Data), Error>] = [:]
    private var sent: [URLRequest] = []

    func reply(_ path: String, status: Int = 200, json: String) {
        lock.lock()
        defer { lock.unlock() }
        replies[path] = .success((status, Data(json.utf8)))
    }

    func fail(_ path: String, _ error: Error) {
        lock.lock()
        defer { lock.unlock() }
        replies[path] = .failure(error)
    }

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return sent
    }

    func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        let path = request.url.map { $0.path + ($0.query.map { "?" + $0 } ?? "") } ?? ""
        let reply = lock.withLock {
            sent.append(request)
            return replies[path] ?? replies[request.url?.path ?? ""]
        }
        guard let reply else { return (404, Data()) }
        return try reply.get()
    }
}

private func reader(_ transport: ScriptedMemoryTransport, token: String = "jeton") -> MemoryReader {
    MemoryReader(server: MemoryServer(baseURL: URL(string: "https://vps.tailnet.ts.net:8443/")!, token: token), transport: transport)
}

private func rows(_ count: Int, scope: String = "produit") -> String {
    let items = (0 ..< count).map { #"{"id":"m\#($0)","memory":"souvenir \#($0)","agent_id":"\#(scope)","metadata":{"tags":"a,b"}}"# }
    return #"{"total":\#(count),"results":[\#(items.joined(separator: ","))]}"#
}

@Suite("Lecture directe de la mémoire du serveur")
struct MemoryReaderTests {
    @Test("le sommaire se lit par pages, dans l'ordre du service, avec le jeton de la mémoire")
    func pages() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all?agent_id=produit", json: rows(150))
        let first = try await reader(transport).page(scope: "produit", offset: 0)
        #expect(first.scope == "produit")
        #expect(first.total == 150)
        #expect(first.rows.count == MemoryReader.pageSize)
        #expect(first.rows.first?.text == "souvenir 0")
        #expect(first.rows.first?.tags == ["a", "b"])
        #expect(first.nextOffset == 100)
        let second = try await reader(transport).page(scope: "produit", offset: 100)
        #expect(second.rows.count == 50)
        #expect(second.nextOffset == nil)
        #expect(transport.requests.first?.value(forHTTPHeaderField: "X-Mem0-Token") == "jeton")
        #expect(transport.requests.first?.url?.absoluteString == "https://vps.tailnet.ts.net:8443/memory/all?agent_id=produit")
    }

    @Test("sans portée, ni page ni graphe n'appellent le service")
    func noScope() async throws {
        let transport = ScriptedMemoryTransport()
        let page = try await reader(transport).page(scope: nil, offset: 0)
        let graph = try await reader(transport).graph(scope: nil)
        #expect(page.scope == nil && page.rows.isEmpty)
        #expect(graph.scope == nil && graph.nodes.isEmpty)
        #expect(transport.requests.isEmpty)
    }

    @Test("la recherche est celle de mem0_search : pool, seuil, tri par cosinus brut")
    func search() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/search", json: #"""
        {"results":[
          {"id":"bas","memory":"sous le seuil","score_details":{"semantic_score":0.4}},
          {"id":"haut","memory":"le plus proche","score_details":{"semantic_score":0.9}},
          {"id":"moyen","memory":"proche","score_details":{"semantic_score":0.7}},
          {"id":"nu","memory":"sans cosinus"}
        ]}
        """#)
        let result = try await reader(transport).search(query: "linter", scope: "produit")
        #expect(result.rows.map(\.id) == ["haut", "moyen"])
        #expect(result.candidates == 4)
        #expect(result.scored == 3)
        let body = try #require(transport.requests.first?.httpBody)
        let sent = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(sent["limit"] as? Int == MemorySearch.pool(requested: MemorySearch.defaultLimit))
        #expect(sent["threshold"] as? Double == MemorySearch.threshold)
        #expect(sent["agent_id"] as? String == "produit")
    }

    @Test("le graphe vient du noyau partagé : souvenirs, étiquettes partagées, arêtes du service")
    func graph() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all?agent_id=produit", json: rows(3))
        transport.reply("/memory/graph", json: #"{"total":2,"edges":[{"source":"m0","target":"m1","score":0.8},{"source":"m0","target":"absent","score":0.9}]}"#)
        let graph = try await reader(transport).graph(scope: "produit")
        let expected = MemoryGraph.nodes(rows: MemoryPage.decode(try JSONSerialization.jsonObject(with: Data(rows(3).utf8))).rows)
        #expect(graph.nodes.map(\.id) == expected.map { MemoryGraphWire.id($0.id) })
        #expect(graph.links.contains { $0.kind == "semantic" && $0.score == 0.8 })
        #expect(!graph.links.contains { $0.a.contains("absent") || $0.b.contains("absent") })
        #expect(graph.links.contains { $0.kind == "tag" })
    }

    @Test("la projection du lecteur porte exactement les faits gelés de la fixture, sans lien manuel")
    func graphProjectsTheFrozenFacts() {
        let payload = MemoryReader.graphPayload(scope: "alpha", rows: MemoryGraphParity.rows, edges: MemoryGraphParity.edges)
        let facts = MemoryGraphParity.facts
        #expect(payload.nodes.map(\.id) == facts.nodes.map { MemoryGraphWire.id($0.id) })
        let expected = facts.links.filter { $0.kind != .manual }.map { link in
            "\(MemoryGraphWire.id(link.a))|\(MemoryGraphWire.id(link.b))|\(MemoryGraphWire.name(link.kind))"
        }
        #expect(payload.links.map { "\($0.a)|\($0.b)|\($0.kind)" } == expected)
        #expect(!payload.links.contains { $0.kind == MemoryGraphWire.name(.manual) })
    }

    @Test("les portées vont de la plus récente à la plus ancienne, sans doublon")
    func scopes() async throws {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all", json: #"{"results":[{"id":"1","memory":"x","agent_id":"b"},{"id":"2","memory":"y","agent_id":"a"},{"id":"3","memory":"z","agent_id":"b"},{"id":"4","memory":"w"}]}"#)
        #expect(try await reader(transport).scopes() == ["b", "a"])
    }

    @Test("une cause par panne : jeton refusé, service pas prêt, graphe absent, délai, injoignable")
    func failures() async {
        let transport = ScriptedMemoryTransport()
        transport.reply("/memory/all?agent_id=refus", status: 401, json: "{}")
        transport.reply("/memory/all?agent_id=lent", status: 503, json: "{}")
        transport.reply("/memory/all?agent_id=vieux", json: rows(1))
        transport.reply("/memory/graph", status: 405, json: "{}")
        transport.fail("/memory/all?agent_id=delai", URLError(.timedOut))
        transport.fail("/memory/all?agent_id=coupe", URLError(.cannotConnectToHost))
        transport.reply("/memory/all?agent_id=casse", json: "pas du json")
        let memory = reader(transport)
        await #expect(throws: MemoryReadError.unauthorized) { try await memory.page(scope: "refus", offset: 0) }
        await #expect(throws: MemoryReadError.unavailable) { try await memory.page(scope: "lent", offset: 0) }
        await #expect(throws: MemoryReadError.outdated) { try await memory.graph(scope: "vieux") }
        await #expect(throws: MemoryReadError.timedOut) { try await memory.page(scope: "delai", offset: 0) }
        await #expect(throws: MemoryReadError.unreachable) { try await memory.page(scope: "coupe", offset: 0) }
        await #expect(throws: MemoryReadError.failed) { try await memory.page(scope: "casse", offset: 0) }
    }
}
