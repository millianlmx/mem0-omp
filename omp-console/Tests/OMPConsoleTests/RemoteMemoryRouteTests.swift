// Les preuves de la route MÉMOIRE (S-9) : un relais de mem0-http, graphe compris.
//
// La doublure `ScriptedMemoryService` est le SEUL service : aucune socket n'est
// ouverte. Le seuil de recherche reste celui de la coque (`MemorySearch`), jamais
// un second seuil défini par l'API.

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

@Suite("Remote mémoire", .serialized)
@MainActor
struct RemoteMemoryRouteTests {

    // MARK: - AC-8

    @Test("api-distante-du-console/AC-8 : l'appareil appairé obtient les souvenirs servis par mem0-http, graphe compris")
    func memoryIsRelayedGraphIncluded() async throws {
        let rows = [
            memoryRow(id: "m1", text: "souvenir un", score: 0.40, scope: "projet", tags: ["commun"]),
            memoryRow(id: "m2", text: "souvenir deux", score: 0.55, scope: "projet", tags: ["commun"]),
            memoryRow(id: "m3", text: "souvenir trois", score: 0.92, scope: "projet", tags: ["commun"]),
            memoryRow(id: "m4", text: "souvenir quatre", score: nil, scope: "projet", tags: []),
        ]
        let service = ScriptedMemoryService(
            page: .success(MemoryPage(total: 4, rows: rows)),
            search: .success(rows),
            graph: .success(MemoryGraphEdges(
                total: 1,
                edges: [MemoryGraphEdge(source: "m1", target: "m3", score: 0.81)]
            ))
        )
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        // (1) La page relayée, telle que le service la rend. La portée est
        // EXPLICITE : sans elle, la route ne lirait rien (S-2, « aucun projet »).
        let pageReply = try await stack.call("GET", "/v1/memory?scope=projet", token: token)
        #expect(pageReply.status == 200)
        let page = try pageReply.json(RemoteMemoryPagePayload.self)
        #expect(page.scope == "projet")
        #expect(page.truncated == false)
        #expect(page.total == 4)
        #expect(page.rows.map(\.id) == ["m1", "m2", "m3", "m4"])
        #expect(page.rows.first { $0.id == "m3" }?.score == 0.92)
        #expect(page.rows.first { $0.id == "m4" }?.score == nil)
        #expect(page.rows.first { $0.id == "m1" }?.tags == ["commun"])

        // (2) La recherche : le seuil 0,55 de la coque, via `MemorySearch.select`.
        let searchReply = try await stack.call("GET", "/v1/memory/search?scope=projet&q=souvenir", token: token)
        #expect(searchReply.status == 200)
        let search = try searchReply.json(RemoteMemorySearchPayload.self)
        let selected = MemorySearch.select(
            rows: rows,
            floor: MemorySearch.threshold,
            limit: MemorySearch.defaultLimit
        )
        #expect(search.rows.map(\.id) == selected.kept.map(\.id))
        #expect(search.rows.map(\.id) == ["m3", "m2"])
        #expect(!search.rows.contains { $0.id == "m1" })   // 0,40 < 0,55 : écarté
        #expect(search.rows.contains { $0.id == "m2" })    // 0,55 : gardé (borne incluse)
        #expect(search.candidates == 4)
        #expect(search.scored == 3)

        // (3) Le graphe : nœuds souvenirs ET étiquettes, liens sémantiques et d'étiquette.
        let graphReply = try await stack.call("GET", "/v1/memory/graph", token: token)
        #expect(graphReply.status == 200)
        let graph = try graphReply.json(RemoteMemoryGraphPayload.self)
        let nodeIds = Set(graph.nodes.map(\.id))
        #expect(nodeIds.contains("memory:m1"))
        #expect(nodeIds.contains("memory:m4"))
        #expect(nodeIds.contains("tag:commun"))
        #expect(graph.nodes.first { $0.id == "memory:m1" }?.label == "souvenir un")
        let semantic = graph.links.filter { $0.kind == "semantic" }
        #expect(semantic.contains { ($0.a, $0.b) == ("memory:m1", "memory:m3") })
        #expect(semantic.first?.score == 0.81)
        let tagLinks = graph.links.filter { $0.kind == "tag" }
        #expect(tagLinks.contains { ($0.a, $0.b) == ("memory:m2", "tag:commun") })
        #expect(tagLinks.allSatisfy { $0.score == nil })
        #expect(graph.total == graph.nodes.count)
        #expect(service.graphCalls == 1)
    }

    // MARK: - Complémentaires

    /// Le dépôt de la fixture est un VRAI dépôt git portant un `package.json` : la
    /// portée du projet courant est alors connue, et l'assertion porte sur une
    /// valeur que le test sait, pas sur la sortie de la même fonction.
    @Test func testDefaultScopeIsTheCurrentProject() async throws {
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: ProjectRoot.defaultsKey)
        let repo = joinPath(NSTemporaryDirectory(), "omp-console-scope-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: repo, withIntermediateDirectories: true)
        defer {
            if let previous {
                defaults.set(previous, forKey: ProjectRoot.defaultsKey)
            } else {
                defaults.removeObject(forKey: ProjectRoot.defaultsKey)
            }
            try? FileManager.default.removeItem(atPath: repo)
        }

        let git = Process()
        git.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        git.arguments = ["init", "-q", repo]
        git.standardOutput = FileHandle.nullDevice
        git.standardError = FileHandle.nullDevice
        try git.run()
        git.waitUntilExit()
        try #require(git.terminationStatus == 0)
        try Data(#"{"name":"projet-courant"}"#.utf8).write(to: URL(fileURLWithPath: joinPath(repo, "package.json")))
        defaults.set(repo, forKey: ProjectRoot.defaultsKey)

        let service = ScriptedMemoryService(page: .success(MemoryPage(total: 0, rows: [])))
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        // La portée résolue par la coque pour ce projet.
        let expected = await MemoryScope.currentProject(environment: [:])
        #expect(expected == "projet-courant")

        let pageReply = try await stack.call("GET", "/v1/memory", token: token)
        #expect(pageReply.status == 200)
        #expect(service.allScopes == [expected])

        // Une portée DEMANDÉE est relayée telle quelle, sans passer par la coque.
        let explicitReply = try await stack.call("GET", "/v1/memory?scope=autre-projet", token: token)
        #expect(explicitReply.status == 200)
        #expect(service.allScopes.last == "autre-projet")
        #expect(service.allScopes.count == 2)
    }

    @Test func testUnreachableServiceIsUnavailableNotEmpty() async throws {
        let service = ScriptedMemoryService(
            page: .failure(.notReachable("connexion refusée")),
            search: .failure(.notReachable("connexion refusée"))
        )
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        for path in ["/v1/memory?scope=projet", "/v1/memory/search?scope=projet&q=souvenir"] {
            let reply = try await stack.call("GET", path, token: token)
            #expect(reply.status == 503)
            #expect(reply.errorCode == "unavailable")
            // Le message est EXACTEMENT celui de la constante partagée : l'adresse
            // RÉELLEMENT sondée, puis le dernier échec (S-3).
            #expect(reply.errorMessage == MemoryText.unavailableDetail(
                address: "http://127.0.0.1:8321",
                error: "connexion refusée"
            ))
            #expect(reply.errorMessage?.contains("127.0.0.1:8321") == true)
            #expect(reply.text.contains("\"error\""))
        }
    }

    @Test("ios-memoire-graphe/AC-2 : testGraphIncludesManualLinks — le lien manuel créé sur le Mac est servi et distinguable")
    func testGraphIncludesManualLinks() async throws {
        let rows = [
            memoryRow(id: "m1", text: "un", score: nil, scope: "projet", tags: []),
            memoryRow(id: "m2", text: "deux", score: nil, scope: "projet", tags: []),
        ]
        let service = ScriptedMemoryService(page: .success(MemoryPage(total: 2, rows: rows)))
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        // Le fichier EXACT que la pile lit : la racine de support + le nom du registre.
        let url = stack.supportRoot.appendingPathComponent(MemoryLinkStore.fileName)
        #expect(MemoryLinkStore.save([MemoryLink(a: "m1", b: "m2")], to: url))

        let reply = try await stack.call("GET", "/v1/memory/graph", token: token)
        #expect(reply.status == 200)
        let graph = try reply.json(RemoteMemoryGraphPayload.self)
        let manual = graph.links.filter { $0.kind == "manual" }
        #expect(manual.count == 1)
        #expect(manual.first?.a == "memory:m1")
        #expect(manual.first?.b == "memory:m2")
        #expect(manual.first?.score == nil)
    }

    /// AC-1/AC-3 : sans `scope`, la route graphe lit TOUTES les portées — jamais un
    /// repli sur le projet courant (qui ferait diverger le graphe iOS dès qu'un
    /// projet est ouvert).
    @Test func testGraphServesEveryScopeWithoutAProject() async throws {
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: ProjectRoot.defaultsKey)
        defaults.set("/inexistant-omp-console-\(UUID().uuidString)", forKey: ProjectRoot.defaultsKey)
        defer {
            if let previous {
                defaults.set(previous, forKey: ProjectRoot.defaultsKey)
            } else {
                defaults.removeObject(forKey: ProjectRoot.defaultsKey)
            }
        }

        let service = ScriptedMemoryService(page: .success(MemoryPage(total: 2, rows: MemoryGraphParity.rows)))
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/memory/graph", token: token)
        #expect(reply.status == 200)
        let graph = try reply.json(RemoteMemoryGraphPayload.self)
        #expect(!graph.nodes.isEmpty)
        // La portée demandée au service est nulle : TOUTES les portées.
        #expect(service.allScopes == [nil])
        // Une portée EXPLICITE est, elle, passée telle quelle.
        _ = try await stack.call("GET", "/v1/memory/graph?scope=alpha", token: token)
        #expect(service.allScopes == [nil, "alpha"])
    }

    /// AC-1 : au-delà de la borne, le graphe est tronqué honnêtement et reste
    /// COHÉRENT (aucun lien orphelin, `total` = nœuds servis).
    @Test func testGraphTruncationIsAnnouncedAndCoherent() async throws {
        let text = String(repeating: "a", count: 2000)
        let rows = (0..<1200).map { index in
            memoryRow(id: "m\(index)", text: text, scope: "projet")
        }
        let service = ScriptedMemoryService(page: .success(MemoryPage(total: rows.count, rows: rows)))
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/memory/graph", token: token)
        #expect(reply.status == 200)
        let graph = try reply.json(RemoteMemoryGraphPayload.self)
        #expect(graph.truncated == true)
        #expect(graph.nodes.count < rows.count)
        #expect(graph.total == graph.nodes.count)
        let ids = Set(graph.nodes.map(\.id))
        #expect(graph.links.allSatisfy { ids.contains($0.a) && ids.contains($0.b) })
    }

    @Test func testLimitOutOfBoundsIsBadRequest() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair()

        for limit in ["0", "201", "abc"] {
            let reply = try await stack.call("GET", "/v1/memory?limit=\(limit)", token: token)
            #expect(reply.status == 400)
            #expect(reply.errorCode == "bad_request")
        }
    }

    @Test func testEmptyQueryIsBadRequest() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair()

        let absent = try await stack.call("GET", "/v1/memory/search", token: token)
        #expect(absent.status == 400)
        #expect(absent.errorCode == "bad_request")

        let blank = try await stack.call("GET", "/v1/memory/search?q=", token: token)
        #expect(blank.status == 400)
        #expect(blank.errorCode == "bad_request")
    }
}
