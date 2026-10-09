// Les preuves de la RELÈVE mémoire de la feature ios-memoire (BR-1) : le sommaire
// de la route est celui de la coque macOS, la borne est honnête, la panne est
// relayée avec sa cause, et l'absence de projet ne lit RIEN.
//
// Le même `ScriptedMemoryService` pilote les deux côtés (le modèle de la coque et
// la route) : c'est ce qui rend comparable ce qui sort par `GET /v1/memory`.

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

@Suite("ios-memoire — le relais mémoire")
@MainActor
struct MemoryRelayTests {

    /// Les quatre lignes de référence : deux au-dessus du plancher, une à la borne
    /// incluse, une sans cosinus.
    private func relayRows() -> [MemoryRow] {
        [
            memoryRow(id: "m1", text: "souvenir un", score: 0.40, updatedAt: "2026-10-01T11:50:31.746110+00:00", scope: "projet", tags: ["commun"]),
            memoryRow(id: "m2", text: "souvenir deux", score: 0.55, updatedAt: "2026-10-02T09:00:00+00:00", scope: "projet", tags: ["commun"]),
            memoryRow(id: "m3", text: "souvenir trois", score: 0.92, updatedAt: nil, scope: "projet", tags: []),
            memoryRow(id: "m4", text: "souvenir quatre", score: nil, updatedAt: "2026-10-03T12:00:00+00:00", scope: "projet", tags: ["seul"]),
        ]
    }

    // MARK: - AC-1

    @Test("ios-memoire/AC-1 : la route rend les mêmes souvenirs que la coque macOS, même ordre, et le total du service")
    func testRouteRelaysTheSameSummaryAsTheShell() async throws {
        let rows = relayRows()
        let service = ScriptedMemoryService(page: .success(MemoryPage(total: 4, rows: rows)))
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        // (1) La coque macOS, sur LE MÊME service et la MÊME portée.
        let model = memoryModel(service: service, scope: "projet")
        await model.refresh()
        let state = model.state
        guard case let .summary(scope, total, shellRows) = state else {
            Issue.record("la coque macOS doit rendre un sommaire, reçu \(state)")
            return
        }

        // (2) La route, portée explicite (aucune résolution locale).
        let reply = try await stack.call("GET", "/v1/memory?scope=projet", token: token)
        #expect(reply.status == 200)
        let page = try reply.json(RemoteMemoryPagePayload.self)

        #expect(page.scope == scope)
        #expect(page.total == total)
        #expect(page.total == 4)
        #expect(page.truncated == false)
        // Mêmes identifiants, MÊME ORDRE, mêmes textes.
        #expect(page.rows.map(\.id) == shellRows.map(\.id))
        #expect(page.rows.map(\.id) == ["m1", "m2", "m3", "m4"])
        #expect(page.rows.map(\.text) == shellRows.map(\.text))
        // Le cosinus et les étiquettes sont relayés tels quels.
        #expect(page.rows.first { $0.id == "m3" }?.score == 0.92)
        #expect(page.rows.first { $0.id == "m4" }?.score == nil)
        #expect(page.rows.first { $0.id == "m1" }?.tags == ["commun"])
        #expect(service.allScopes == ["projet", "projet"])

        // La ligne de contexte partagée est celle du noyau : date relative puis
        // étiquettes, segments absents omis.
        #expect(MemoryText.subtitle(updatedAt: rows[2].updatedAt, tags: rows[2].tags, nowMs: 0) == "")
        #expect(MemoryText.subtitle(updatedAt: rows[0].updatedAt, tags: rows[0].tags, nowMs: 0)
            == MemoryText.subtitle(row: rows[0], nowMs: 0))
    }

    @Test("ios-memoire/AC-1 : une charge au-delà de la borne est tronquée honnêtement, la TÊTE conservée")
    func testOversizedSummaryIsTruncatedKeepingTheHead() async throws {
        // 1200 lignes de 2000 octets : ≈ 2,4 Mio, au-delà de la borne de corps.
        let text = String(repeating: "a", count: 2000)
        let rows = (0..<1200).map { index in
            memoryRow(id: "m\(index)", text: text, scope: "projet")
        }
        let service = ScriptedMemoryService(page: .success(MemoryPage(total: rows.count, rows: rows)))
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/memory?scope=projet", token: token)
        #expect(reply.status == 200)
        let page = try reply.json(RemoteMemoryPagePayload.self)
        #expect(page.truncated == true)
        #expect(page.rows.count < page.total)
        #expect(page.rows.count < rows.count)
        // La tête (les plus récents, l'ordre du service) est conservée.
        #expect(page.rows.first?.id == "m0")
        #expect(page.rows.last?.id != rows.last?.id)
    }

    // MARK: - AC-4

    @Test("ios-memoire/AC-4 : la recherche relayée est exactement la sélection de l'outil mem0_search")
    func testSearchRelaysTheToolSelection() async throws {
        let rows = relayRows()
        let service = ScriptedMemoryService(search: .success(rows))
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/memory/search?scope=projet&q=souvenir", token: token)
        #expect(reply.status == 200)
        let search = try reply.json(RemoteMemorySearchPayload.self)

        let selected = MemorySearch.select(rows: rows, floor: MemorySearch.threshold, limit: MemorySearch.defaultLimit)
        #expect(search.rows.map(\.id) == selected.kept.map(\.id))
        #expect(search.rows.map(\.id) == ["m3", "m2"])
        #expect(search.candidates == 4)
        #expect(search.scored == 3)
        // Le pool est celui de l'outil : six résultats × quatre, plafonné à 50.
        #expect(service.searches.count == 1)
        #expect(service.searches.first?.query == "souvenir")
        #expect(service.searches.first?.scope == "projet")
        #expect(service.searches.first?.pool == MemorySearch.pool(requested: MemorySearch.defaultLimit))
        #expect(service.searches.first?.pool == 24)
    }

    // MARK: - AC-6

    @Test("ios-memoire/AC-6 : les quatre pannes mémoire rendent 503 avec l'adresse sondée et le dernier échec")
    func testEveryMemoryFailureIsUnavailableWithItsCause() async throws {
        let failures: [MemoryServiceError] = [
            .notReachable("connexion refusée"),
            .unauthorized,
            .unexpectedStatus(500, "boom"),
            .malformedResponse("corps illisible"),
        ]
        for failure in failures {
            let service = ScriptedMemoryService(
                page: .failure(failure),
                search: .failure(failure)
            )
            let stack = try await RemoteStack.make(memory: service)
            defer { stack.stop() }
            let token = try await stack.pair()

            for path in ["/v1/memory?scope=projet", "/v1/memory/search?scope=projet&q=souvenir"] {
                let reply = try await stack.call("GET", path, token: token)
                #expect(reply.status == 503)
                #expect(reply.errorCode == "unavailable")
                #expect(reply.errorMessage == MemoryText.unavailableDetail(
                    address: "http://127.0.0.1:8321",
                    error: failure.userMessage
                ))
                #expect(reply.text.contains("\"error\""))
            }
        }
    }

    // MARK: - AC-7

    @Test("ios-memoire/AC-7 : sans portée résolue, la page est vide et le service n'est PAS appelé")
    func testWithoutProjectNothingIsRead() async throws {
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: ProjectRoot.defaultsKey)
        // Une clé PRÉSENTE mais invalide : aucun repli sur le cwd, donc aucune portée.
        defaults.set("/inexistant-omp-console-\(UUID().uuidString)", forKey: ProjectRoot.defaultsKey)
        defer {
            if let previous {
                defaults.set(previous, forKey: ProjectRoot.defaultsKey)
            } else {
                defaults.removeObject(forKey: ProjectRoot.defaultsKey)
            }
        }

        let service = ScriptedMemoryService(page: .success(MemoryPage(total: 2, rows: relayRows())))
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/memory", token: token)
        #expect(reply.status == 200)
        let page = try reply.json(RemoteMemoryPagePayload.self)
        #expect(page.scope == nil)
        #expect(page.total == 0)
        #expect(page.rows.isEmpty)
        #expect(page.truncated == false)
        // AUCUN appel au service : ni `all`, ni `search`, ni `health`.
        #expect(service.allScopes.isEmpty)
        #expect(service.searches.isEmpty)
        #expect(service.healthCalls == 0)

        // La recherche, elle, est REFUSÉE avant toute lecture.
        let searchReply = try await stack.call("GET", "/v1/memory/search?q=souvenir", token: token)
        #expect(searchReply.status == 400)
        #expect(searchReply.errorCode == "bad_request")
        #expect(service.searches.isEmpty)
    }

    @Test("ios-memoire/AC-7 : une portée DEMANDÉE est servie même sans projet ouvert")
    func testExplicitScopeIsServedWithoutProject() async throws {
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

        let service = ScriptedMemoryService(page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m1", text: "un")])))
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/memory?scope=autre-projet", token: token)
        #expect(reply.status == 200)
        let page = try reply.json(RemoteMemoryPagePayload.self)
        #expect(page.scope == "autre-projet")
        #expect(page.rows.map(\.id) == ["m1"])
        #expect(service.allScopes == ["autre-projet"])
    }

    // MARK: - Compléments de borne

    @Test("ios-memoire/AC-1 : `limit` explicite est honoré, absent vaut la borne de nombre du dépôt")
    func testExplicitLimitIsHonoured() async throws {
        let rows = (0..<5).map { index in memoryRow(id: "m\(index)", text: "souvenir \(index)") }
        let service = ScriptedMemoryService(page: .success(MemoryPage(total: 5, rows: rows)))
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        let limited = try await stack.call("GET", "/v1/memory?scope=projet&limit=2", token: token)
        #expect(limited.status == 200)
        let page = try limited.json(RemoteMemoryPagePayload.self)
        #expect(page.total == 5)
        #expect(page.rows.map(\.id) == ["m0", "m1"])
        #expect(page.truncated == true)
        #expect(RemoteLimits.memoryRows == 2000)
    }

    @Test("ios-memoire/AC-3 : une requête blanche est refusée sans aucune lecture")
    func testBlankQueryIsRefusedWithoutReading() async throws {
        let service = ScriptedMemoryService(search: .success([memoryRow(id: "m1", text: "un")]))
        let stack = try await RemoteStack.make(memory: service)
        defer { stack.stop() }
        let token = try await stack.pair()

        for suffix in ["", "?q=", "?q=%20%20", "?scope=projet"] {
            let reply = try await stack.call("GET", "/v1/memory/search\(suffix)", token: token)
            #expect(reply.status == 400)
            #expect(reply.errorCode == "bad_request")
        }
        #expect(service.searches.isEmpty)
    }

    // MARK: - ios-graphe-memoire-405-erreur-brute

    @Test("ios-graphe-memoire-405-erreur-brute/AC-3 : un 405 sur /memory/graph rend 503 outdated_service avec le message d'aujourd'hui")
    func testGraph405IsOutdatedService() async throws {
        let failure = MemoryServiceError.unexpectedStatus(405, #"{"detail":"Method Not Allowed"}"#)
        let stack = try await RemoteStack.make(memory: ScriptedMemoryService(graph: .failure(failure)))
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/memory/graph", token: token)
        #expect(reply.status == 503)
        #expect(reply.errorCode == "outdated_service")
        #expect(reply.errorMessage == MemoryText.unavailableDetail(
            address: "http://127.0.0.1:8321",
            error: failure.userMessage
        ))
    }

    @Test("ios-graphe-memoire-405-erreur-brute/AC-4 : un 404 sur /memory/graph rend aussi 503 outdated_service")
    func testGraph404IsOutdatedService() async throws {
        let failure = MemoryServiceError.unexpectedStatus(404, #"{"detail":"Not Found"}"#)
        let stack = try await RemoteStack.make(memory: ScriptedMemoryService(graph: .failure(failure)))
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/memory/graph", token: token)
        #expect(reply.status == 503)
        #expect(reply.errorCode == "outdated_service")
        #expect(reply.errorMessage == MemoryText.unavailableDetail(
            address: "http://127.0.0.1:8321",
            error: failure.userMessage
        ))
    }

    @Test("ios-graphe-memoire-405-erreur-brute/AC-6 : les autres pannes du graphe restent `unavailable`, y compris un 405 sur /memory/all")
    func testOtherGraphFailuresStayUnavailable() async throws {
        let graphFailures: [MemoryServiceError] = [
            .unexpectedStatus(500, "boom"),
            .notReachable("connexion refusée"),
            .unauthorized,
            .malformedResponse("corps illisible"),
        ]
        for failure in graphFailures {
            let stack = try await RemoteStack.make(memory: ScriptedMemoryService(graph: .failure(failure)))
            defer { stack.stop() }
            let token = try await stack.pair()

            let reply = try await stack.call("GET", "/v1/memory/graph", token: token)
            #expect(reply.status == 503)
            #expect(reply.errorCode == "unavailable")
            #expect(reply.errorMessage == MemoryText.unavailableDetail(
                address: "http://127.0.0.1:8321",
                error: failure.userMessage
            ))
        }

        // La route de la liste n'est pas celle du graphe : on n'en déduit pas « trop ancien ».
        for status in [404, 405] {
            let failure = MemoryServiceError.unexpectedStatus(status, "x")
            let stack = try await RemoteStack.make(memory: ScriptedMemoryService(page: .failure(failure)))
            defer { stack.stop() }
            let token = try await stack.pair()

            let reply = try await stack.call("GET", "/v1/memory/graph", token: token)
            #expect(reply.status == 503)
            #expect(reply.errorCode == "unavailable")
        }
    }

    @Test("ios-graphe-memoire-405-erreur-brute/AC-7 : la liste et la recherche ne rendent jamais outdated_service, même sur 404/405")
    func testListAndSearchNeverReportOutdatedService() async throws {
        for status in [404, 405] {
            let failure = MemoryServiceError.unexpectedStatus(status, #"{"detail":"Method Not Allowed"}"#)
            let stack = try await RemoteStack.make(
                memory: ScriptedMemoryService(page: .failure(failure), search: .failure(failure))
            )
            defer { stack.stop() }
            let token = try await stack.pair()

            for path in ["/v1/memory?scope=projet", "/v1/memory/search?scope=projet&q=souvenir"] {
                let reply = try await stack.call("GET", path, token: token)
                #expect(reply.status == 503)
                #expect(reply.errorCode == "unavailable")
                #expect(reply.errorMessage == MemoryText.unavailableDetail(
                    address: "http://127.0.0.1:8321",
                    error: failure.userMessage
                ))
            }
        }
    }
}
