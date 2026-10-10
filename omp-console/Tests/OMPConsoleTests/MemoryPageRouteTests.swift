// Les preuves de la route de page Mémoire et du graphe d'une seule portée
// (feature memoire-ios-expire-a-10-secondes, S-1 et S-6) : la liste se lit par
// pages bornées qui couvrent la portée une fois et une seule, le graphe ne lit que
// la portée résolue et reste entier à la taille réelle d'un projet, et la coque
// macOS, qui lit `MemoryServing` sans passer par ces routes, est inchangée.
//
// La suite est IMBRIQUÉE dans `RemoteMemoryRouteTests` (`.serialized`) : plusieurs
// tests posent `ProjectRoot.defaultsKey` dans `UserDefaults.standard`, une clé
// globale que `testDefaultScopeIsTheCurrentProject` lit aussi.

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

extension RemoteMemoryRouteTests {
    @Suite("memoire-ios-expire-a-10-secondes — page Mémoire et graphe d'une portée")
    @MainActor
    struct MemoryPageRouteTests {

        private func rows(_ count: Int, scope: String = "projet", text: String = "souvenir") -> [MemoryRow] {
            (0..<count).map { memoryRow(id: "m\($0)", text: "\(text) \($0)", scope: scope) }
        }

        /// Pose une racine de projet INEXISTANTE (aucun repli sur le cwd, donc aucune
        /// portée résolue) le temps de `body`, puis rend la valeur précédente.
        private func withoutProject(_ body: () async throws -> Void) async rethrows {
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
            try await body()
        }

        // MARK: - Page (S-1)

        @Test("memoire-ios-expire-a-10-secondes/AC-2 : testPagesCoverTheScopeExactlyOnce — les pages suivies par nextOffset couvrent la portée, dans l'ordre, sans doublon")
        func testPagesCoverTheScopeExactlyOnce() async throws {
            let served = rows(250)
            let service = ScriptedMemoryService(page: .success(MemoryPage(total: served.count, rows: served)))
            let stack = try await RemoteStack.make(memory: service)
            defer { stack.stop() }
            let token = try await stack.pair()

            var ids: [String] = []
            var sizes: [Int] = []
            var offset: Int? = 0
            while let current = offset {
                let reply = try await stack.call("GET", "/v1/memory/page?scope=projet&offset=\(current)", token: token)
                #expect(reply.status == 200)
                let page = try reply.json(RemoteMemoryPagePayload.self)
                #expect(page.scope == "projet")
                #expect(page.total == 250)
                #expect(page.offset == current)
                if let next = page.nextOffset {
                    #expect(next == current + page.rows.count)
                    #expect(next > current)
                }
                ids.append(contentsOf: page.rows.map(\.id))
                sizes.append(page.rows.count)
                offset = page.nextOffset
                if sizes.count > 10 { break }
            }

            #expect(sizes == [100, 100, 50])
            #expect(ids == served.map(\.id))
            #expect(Set(ids).count == ids.count)
            // Une page = UNE lecture du service, sur la portée demandée.
            #expect(service.allScopes == ["projet", "projet", "projet"])
        }

        @Test("memoire-ios-expire-a-10-secondes/AC-2 : testPageBoundsAreChecked — offset et limit hors bornes rendent 400 sans aucune lecture")
        func testPageBoundsAreChecked() async throws {
            let service = ScriptedMemoryService(page: .success(MemoryPage(total: 3, rows: rows(3))))
            let stack = try await RemoteStack.make(memory: service)
            defer { stack.stop() }
            let token = try await stack.pair()

            let cases: [(query: String, message: String)] = [
                ("offset=-1", "offset hors bornes"),
                ("offset=x", "offset hors bornes"),
                ("limit=0", "limit hors bornes"),
                ("limit=201", "limit hors bornes"),
            ]
            for item in cases {
                let reply = try await stack.call("GET", "/v1/memory/page?scope=projet&\(item.query)", token: token)
                #expect(reply.status == 400, "\(item.query)")
                #expect(reply.errorCode == "bad_request")
                #expect(reply.errorMessage == item.message)
            }
            #expect(service.allScopes.isEmpty)

            // Les bornes incluses passent.
            let edge = try await stack.call("GET", "/v1/memory/page?scope=projet&offset=0&limit=200", token: token)
            #expect(edge.status == 200)
            #expect(try edge.json(RemoteMemoryPagePayload.self).rows.count == 3)
        }

        @Test("memoire-ios-expire-a-10-secondes/AC-2 : testPageWithoutProjectReadsNothing — sans projet ouvert, page vide et aucun appel au service")
        func testPageWithoutProjectReadsNothing() async throws {
            try await withoutProject {
                let service = ScriptedMemoryService(page: .success(MemoryPage(total: 3, rows: rows(3))))
                let stack = try await RemoteStack.make(memory: service)
                defer { stack.stop() }
                let token = try await stack.pair()

                let reply = try await stack.call("GET", "/v1/memory/page?offset=40", token: token)
                #expect(reply.status == 200)
                let page = try reply.json(RemoteMemoryPagePayload.self)
                #expect(page == RemoteMemoryPagePayload(scope: nil, total: 0, offset: 0, rows: [], nextOffset: nil))
                // `nextOffset` absent du corps, pas `null`.
                #expect(!reply.text.contains("nextOffset"))
                #expect(service.allScopes.isEmpty)
            }
        }

        @Test("memoire-ios-expire-a-10-secondes/AC-2 : testOffsetPastTheEndIsEmpty — un offset au-delà de la fin rend une page vide, sans suite ni erreur")
        func testOffsetPastTheEndIsEmpty() async throws {
            let service = ScriptedMemoryService(page: .success(MemoryPage(total: 5, rows: rows(5))))
            let stack = try await RemoteStack.make(memory: service)
            defer { stack.stop() }
            let token = try await stack.pair()

            for offset in [5, 900] {
                let reply = try await stack.call("GET", "/v1/memory/page?scope=projet&offset=\(offset)", token: token)
                #expect(reply.status == 200)
                let page = try reply.json(RemoteMemoryPagePayload.self)
                #expect(page.rows.isEmpty)
                #expect(page.offset == offset)
                #expect(page.total == 5)
                #expect(page.nextOffset == nil)
            }
            // La dernière page pleine n'annonce pas de suite.
            let last = try await stack.call("GET", "/v1/memory/page?scope=projet&offset=3&limit=2", token: token)
            let page = try last.json(RemoteMemoryPagePayload.self)
            #expect(page.rows.map(\.id) == ["m3", "m4"])
            #expect(page.nextOffset == nil)
        }

        @Test("memoire-ios-expire-a-10-secondes/AC-2 : testOversizedRowsKeepAtLeastOneRow — la borne d'octets coupe la queue mais sert toujours une ligne")
        func testOversizedRowsKeepAtLeastOneRow() throws {
            // Trois lignes de 3 Mio chacune : même seule, une ligne dépasse 2 Mio.
            let huge = String(repeating: "a", count: 3 * 1024 * 1024)
            let served = (0..<3).map { memoryRow(id: "g\($0)", text: huge, scope: "projet") }
            let first = RemoteReads.pagePayload(scope: "projet", total: 3, rows: served, offset: 0, limit: 100)
            #expect(first.rows.map(\.id) == ["g0"])
            #expect(first.nextOffset == 1)

            let second = RemoteReads.pagePayload(scope: "projet", total: 3, rows: served, offset: first.nextOffset ?? 0, limit: 100)
            #expect(second.rows.map(\.id) == ["g1"])
            #expect(second.nextOffset == 2)

            // Des lignes moyennes : la tranche est réduite sous la borne, la tête gardée.
            let medium = String(repeating: "b", count: 40_000)
            let many = (0..<100).map { memoryRow(id: "r\($0)", text: medium, scope: "projet") }
            let page = RemoteReads.pagePayload(scope: "projet", total: 100, rows: many, offset: 0, limit: 100)
            #expect(page.rows.count > 1)
            #expect(page.rows.count < 100)
            #expect(page.rows.first?.id == "r0")
            #expect(page.nextOffset == page.rows.count)
            #expect(try HTTPJSON.encode(page).count <= RemoteLimits.responseBody)
        }

        @Test("memoire-ios-expire-a-10-secondes/AC-9 : testOldListRouteIsGone — GET /v1/memory n'existe plus : 404 « route inconnue », celui qu'une app iOS antérieure lira")
        func testOldListRouteIsGone() async throws {
            let service = ScriptedMemoryService(page: .success(MemoryPage(total: 3, rows: rows(3))))
            let stack = try await RemoteStack.make(memory: service)
            defer { stack.stop() }
            let token = try await stack.pair()

            let reply = try await stack.call("GET", "/v1/memory?scope=projet", token: token)
            #expect(reply.status == 404)
            #expect(reply.errorMessage == "route inconnue")
            #expect(service.allScopes.isEmpty)
            #expect(!RemoteRouter.routes.contains { $0.name == "memory" })
        }

        // MARK: - Graphe (S-6)

        @Test("memoire-ios-expire-a-10-secondes/AC-3 : testGraphReadsOnlyTheRequestedScope — le graphe ne lit que la portée demandée et la nomme")
        func testGraphReadsOnlyTheRequestedScope() async throws {
            let served = rows(4, scope: "alpha")
            let service = ScriptedMemoryService(
                page: .success(MemoryPage(total: served.count, rows: served)),
                graph: .success(MemoryGraphEdges(total: 1, edges: [MemoryGraphEdge(source: "m0", target: "m1", score: 0.9)]))
            )
            let stack = try await RemoteStack.make(memory: service)
            defer { stack.stop() }
            let token = try await stack.pair()

            let reply = try await stack.call("GET", "/v1/memory/graph?scope=alpha", token: token)
            #expect(reply.status == 200)
            let payload = try reply.json(RemoteMemoryGraphPayload.self)
            #expect(service.allScopes == ["alpha"])
            #expect(payload.scope == "alpha")
            let memoryNodes = payload.nodes.filter { $0.id.hasPrefix("memory:") }
            #expect(memoryNodes.count == 4)
            #expect(memoryNodes.allSatisfy { $0.scope == "alpha" })
            #expect(payload.truncated == false)
        }

        @Test("memoire-ios-expire-a-10-secondes/AC-3 : testScopedGraphLeavesOutLinksToOtherScopes — arêtes et liens manuels vers une autre portée n'apparaissent pas")
        func testScopedGraphLeavesOutLinksToOtherScopes() {
            // Le service a déjà filtré les lignes par portée ; ses arêtes, elles,
            // couvrent toutes les portées (mem0-http n'a pas de filtre de graphe).
            let scoped = rows(3, scope: "alpha")
            let edges = [
                MemoryGraphEdge(source: "m0", target: "m1", score: 0.9),
                MemoryGraphEdge(source: "m2", target: "x9", score: 0.9),
            ]
            let manual: Set<MemoryLink> = [MemoryLink(a: "m0", b: "m2"), MemoryLink(a: "m1", b: "x8")]
            let payload = RemoteReads.memoryGraph(scope: "alpha", rows: scoped, edges: edges, manual: manual)
            let ids = Set(payload.nodes.map(\.id))
            #expect(!ids.contains("memory:x9"))
            #expect(!ids.contains("memory:x8"))
            #expect(payload.links.allSatisfy { ids.contains($0.a) && ids.contains($0.b) })
            #expect(payload.links.contains { $0.kind == "manual" && Set([$0.a, $0.b]) == ["memory:m0", "memory:m2"] })
        }

        @Test("memoire-ios-expire-a-10-secondes/AC-3 : testGraphWithoutProjectReadsNothing — sans projet ouvert, graphe vide sans portée et aucun appel au service")
        func testGraphWithoutProjectReadsNothing() async throws {
            try await withoutProject {
                let service = ScriptedMemoryService(page: .success(MemoryPage(total: 3, rows: rows(3))))
                let stack = try await RemoteStack.make(memory: service)
                defer { stack.stop() }
                let token = try await stack.pair()

                let reply = try await stack.call("GET", "/v1/memory/graph", token: token)
                #expect(reply.status == 200)
                let payload = try reply.json(RemoteMemoryGraphPayload.self)
                #expect(payload == RemoteMemoryGraphPayload(scope: nil, nodes: [], links: [], total: 0, truncated: false))
                #expect(service.allScopes.isEmpty)
                #expect(service.graphCalls == 0)
            }
        }

        @Test("memoire-ios-expire-a-10-secondes/AC-3 : testScopedGraphIsWholeAtRealSize — 1 583 souvenirs de 1 000 octets et 3 773 arêtes : graphe entier, rien de tronqué")
        func testScopedGraphIsWholeAtRealSize() async throws {
            let text = String(repeating: "t", count: 1_000)
            let served = (0..<1_583).map { index in
                memoryRow(id: "m\(index)", text: text, scope: "projet", tags: ["famille-\(index % 40)", "commun"])
            }
            // 3 773 arêtes distinctes : (i, i+1), (i, i+2), (i, i+3) sur les 1 580 premiers.
            let edges = (0..<3_773).map { k in
                let source = k % 1_580
                return MemoryGraphEdge(source: "m\(source)", target: "m\(source + 1 + k / 1_580)", score: 0.8)
            }
            let service = ScriptedMemoryService(
                page: .success(MemoryPage(total: served.count, rows: served)),
                graph: .success(MemoryGraphEdges(total: edges.count, edges: edges))
            )
            let stack = try await RemoteStack.make(memory: service)
            defer { stack.stop() }
            let token = try await stack.pair()

            let reply = try await stack.call("GET", "/v1/memory/graph?scope=projet", token: token)
            #expect(reply.status == 200)
            let payload = try reply.json(RemoteMemoryGraphPayload.self)
            #expect(payload.truncated == false)
            #expect(payload.nodes.filter { $0.id.hasPrefix("memory:") }.count == 1_583)
            #expect(payload.total == payload.nodes.count)
            // La charge dépasse l'ancienne borne commune de 2 Mio : c'est la borne
            // PROPRE au graphe qui la laisse passer entière.
            #expect(reply.body.count > RemoteLimits.responseBody)
            #expect(reply.body.count <= RemoteLimits.memoryGraphBody)
        }

        // MARK: - Coque macOS (S-8)

        @Test("memoire-ios-expire-a-10-secondes/AC-10 : testMacShellStillReadsTheServiceDirectly — la Mémoire macOS (liste et graphe) lit le service comme avant, toutes portées pour le graphe")
        func testMacShellStillReadsTheServiceDirectly() async {
            let served = [
                memoryRow(id: "a-1", text: "un", scope: "projet-a", tags: ["t"]),
                memoryRow(id: "a-2", text: "deux", scope: "projet-a", tags: ["t"]),
                memoryRow(id: "b-1", text: "trois", scope: "projet-b"),
            ]
            let service = ScriptedMemoryService(page: .success(MemoryPage(total: served.count, rows: served)))

            let list = memoryModel(service: service, scope: "projet-a")
            await list.refresh()
            guard case let .summary(scope, total, shown) = list.state else {
                Issue.record("la liste macOS doit rendre un sommaire, reçu \(list.state)")
                return
            }
            #expect(scope == "projet-a")
            #expect(total == 3)
            #expect(shown.map(\.id) == ["a-1", "a-2", "b-1"])

            let graph = memoryGraphModel(service: service)
            await graph.activate()
            // Le graphe macOS n'emprunte pas la route : il lit TOUTES les portées.
            #expect(service.allScopes == ["projet-a", nil])
            #expect(graph.rows.count == 3)
            #expect(graph.filterProjects == ["projet-a", "projet-b"])
        }
    }
}
