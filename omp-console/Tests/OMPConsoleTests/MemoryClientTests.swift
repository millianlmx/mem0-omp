// Le client mem0-http (S-1, S-2, S-3, S-6, S-7, BR-2) : la requête RÉELLE que
// l'app émet, la sélection de pertinence portée du plugin, la portée des routes et
// les messages d'erreur.
//
// Les requêtes passent par un `URLProtocol` stubé : URL, méthode, en-tête de jeton
// et corps sont capturés tels que `HTTPMemoryService` les produit — aucune socket,
// aucun service requis.

import Foundation
import Testing

@testable import OMPConsole

// MARK: - S-1 : la recherche

@Test("memoire-mem0/AC-1 : la recherche émet le corps exact de mem0_search (pool de 24, seuil 0,55, explain, portée du projet)")
func ac1SearchRequestMatchesThePlugin() async throws {
    StubURLProtocol.reset()
    StubURLProtocol.reply(
        "/memory/search",
        .init(body: memoryJSON(["results": [["id": "m-1", "memory": "un souvenir"]]]))
    )
    let service = stubbedHTTPMemoryService()

    let rows = try await service.search(query: "sujet", scope: "mem0-omp", pool: MemorySearch.pool(requested: 6))

    #expect(MemorySearch.defaultLimit == 6)
    #expect(MemorySearch.threshold == 0.55)
    #expect(MemorySearch.pool(requested: 6) == 24)
    #expect(MemorySearch.pool(requested: 40) == 50)

    let request = try #require(StubURLProtocol.requests.first)
    #expect(request.url?.path == "/memory/search")
    #expect(request.httpMethod == "POST")
    let body = try #require(memoryBody(request))
    #expect(body["query"] as? String == "sujet")
    #expect(body["agent_id"] as? String == "mem0-omp")
    #expect(body["limit"] as? Int == 24)
    #expect(body["threshold"] as? Double == 0.55)
    #expect(body["explain"] as? Bool == true)
    #expect(body["filters"] is NSNull)
    #expect(rows.map(\.id) == ["m-1"])
    #expect(rows.map(\.text) == ["un souvenir"])
}

@Test("memoire-mem0/AC-1 : la sélection est celle de selectRelevant — cosinus seuls, décroissant, tronqué")
func ac1SelectionMatchesSelectRelevant() {
    let rows = [
        memoryRow(id: "m-1", text: "a", score: 0.9),
        memoryRow(id: "m-2", text: "b", score: 0.4),
        memoryRow(id: "m-3", text: "c", score: 0.7),
        memoryRow(id: "m-4", text: "d"),
        memoryRow(id: "m-5", text: "e", score: 0.55),
        memoryRow(id: "m-6", text: "f", score: 0.7),
    ]

    let selection = MemorySearch.select(rows: rows, floor: MemorySearch.threshold, limit: MemorySearch.defaultLimit)
    // Ordre DÉCROISSANT par cosinus ; à cosinus égal (m-3, m-6), l'ordre reçu est
    // conservé (le tri de TypeScript est stable). m-2 est sous le seuil, m-4 n'a
    // pas de cosinus : aucune des deux n'entre.
    #expect(selection.kept.map(\.id) == ["m-1", "m-3", "m-6", "m-5"])
    #expect(selection.candidates == 6)
    #expect(selection.scored == 5)

    // La limite tronque APRÈS le tri.
    let limited = MemorySearch.select(rows: rows, floor: MemorySearch.threshold, limit: 2)
    #expect(limited.kept.map(\.id) == ["m-1", "m-3"])

    // Aucun cosinus du tout : des candidats, mais rien à trier — c'est le signal
    // « le service ne renvoie pas de score sémantique ».
    let unscored = MemorySearch.select(
        rows: [memoryRow(id: "m-1", text: "a"), memoryRow(id: "m-2", text: "b")],
        floor: MemorySearch.threshold,
        limit: MemorySearch.defaultLimit
    )
    #expect(unscored.kept.isEmpty)
    #expect(unscored.candidates == 2)
    #expect(unscored.scored == 0)

    // Des cosinus, mais tous sous le seuil.
    let below = MemorySearch.select(
        rows: [memoryRow(id: "m-1", text: "a", score: 0.2)],
        floor: MemorySearch.threshold,
        limit: MemorySearch.defaultLimit
    )
    #expect(below.kept.isEmpty)
    #expect(below.scored == 1)
}

// MARK: - S-2 : lecture seule

@Test("memoire-mem0/AC-2 : la liste des routes constructibles est exactement /health, /memory/all et /memory/search")
func ac2RoutesAreReadOnly() {
    #expect(MemoryRoute.allCases.map(\.rawValue) == ["/health", "/memory/all", "/memory/search"])
    #expect(MemoryRoute.health.method == "GET")
    #expect(MemoryRoute.all.method == "GET")
    #expect(MemoryRoute.search.method == "POST")
    // Aucune route d'écriture n'existe : ni PUT, ni DELETE, ni /memory/add.
    #expect(!MemoryRoute.allCases.contains { $0.rawValue.contains("add") })
    #expect(Set(MemoryRoute.allCases.map(\.method)).isSubset(of: ["GET", "POST"]))
}

// MARK: - S-3 : le sommaire

@Test("memoire-mem0/AC-3 : le sommaire demande la portée du projet et rend le compte et l'ordre du service")
func ac3SummaryCarriesScopeTotalAndOrder() async throws {
    StubURLProtocol.reset()
    StubURLProtocol.reply(
        "/memory/all",
        .init(body: memoryJSON([
            "total": 3,
            "results": [
                ["id": "m-3", "memory": "récent", "updated_at": "2026-09-30T10:00:00Z"],
                ["id": "m-2", "memory": "moyen", "updated_at": "2026-09-29T10:00:00Z"],
                ["id": "m-1", "memory": "ancien", "updated_at": "2026-09-28T10:00:00Z"],
            ],
        ]))
    )
    let service = stubbedHTTPMemoryService()

    let page = try await service.all(scope: "mem0-omp")

    let request = try #require(StubURLProtocol.requests.first)
    #expect(request.url?.path == "/memory/all")
    #expect(request.httpMethod == "GET")
    #expect(request.url?.query == "agent_id=mem0-omp")
    #expect(page.total == 3)
    #expect(page.rows.map(\.id) == ["m-3", "m-2", "m-1"])
    #expect(page.rows.map(\.updatedAt) == ["2026-09-30T10:00:00Z", "2026-09-29T10:00:00Z", "2026-09-28T10:00:00Z"])
}

@Test("memoire-mem0/AC-3 : un sommaire sans `total` compte ses lignes, et un tableau nu est accepté")
func ac3PageToleratesBareShapes() {
    let withoutTotal = MemoryPage.decode(["results": [["id": "m-1", "memory": "a"]]] as [String: Any])
    #expect(withoutTotal.total == 1)
    #expect(withoutTotal.rows.map(\.id) == ["m-1"])

    let bare = MemoryPage.decode([["id": "m-1", "memory": "a"], ["id": "m-2", "memory": "b"]] as [Any])
    #expect(bare.total == 2)
    #expect(bare.rows.map(\.id) == ["m-1", "m-2"])

    let empty = MemoryPage.decode(["total": 0, "results": []] as [String: Any])
    #expect(empty.total == 0)
    #expect(empty.rows.isEmpty)
}

// MARK: - Décodage des lignes (mem0Client.ts:82-111)

@Test("memoire-mem0/AC-6 : une ligne porte le texte COMPLET stocké, jamais un aperçu tronqué")
func ac6RowKeepsTheFullStoredText() {
    let long = "première ligne très longue\nligne 2\n\nligne 4 avec des espaces   "
    let row = MemoryJSON.row(["id": "m-1", "memory": long])
    #expect(row.text == long)

    // `memoryLine` : `memory`, sinon `text`, sinon la sérialisation JSON.
    #expect(MemoryJSON.row(["id": "m-1", "text": "depuis text"]).text == "depuis text")
    #expect(MemoryJSON.row(["id": "m-1", "memory": 42]).text == "42")
    let serialized = MemoryJSON.row(["id": "m-1", "autre": "champ"]).text
    #expect(serialized.contains("\"autre\""))
}

@Test("memoire-mem0/AC-3 : une ligne sans identifiant porte « ? », et un cosinus non fini est ignoré")
func ac3RowGuardsAreLocal() {
    #expect(MemoryJSON.row(["memory": "sans id"]).id == "?")
    #expect(MemoryJSON.row(["id": 7, "memory": "numérique"]).id == "7")
    #expect(MemoryJSON.row(["id": true, "memory": "booléen"]).id == "?")

    #expect(MemoryJSON.row(["id": "m", "memory": "x", "score_details": ["semantic_score": 0.8]]).semanticScore == 0.8)
    #expect(MemoryJSON.row(["id": "m", "memory": "x"]).semanticScore == nil)
    #expect(MemoryJSON.row(["id": "m", "memory": "x", "score_details": [:]]).semanticScore == nil)
    #expect(MemoryJSON.row(["id": "m", "memory": "x", "score_details": ["semantic_score": "0.8"]]).semanticScore == nil)
    #expect(MemoryJSON.row(["id": "m", "memory": "x", "score_details": ["semantic_score": true]]).semanticScore == nil)
}

// MARK: - S-6, S-7 : sonde, erreurs, config et jeton

@Test("memoire-mem0/AC-7 : la sonde /health rend « disponible » quand le service répond ok")
func ac7HealthReportsAvailability() async throws {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/health", .init(body: memoryJSON(["ok": true, "mem0": "2.2.1", "user": "millian"])))
    let service = stubbedHTTPMemoryService()

    let health = await service.health()

    #expect(health.isAvailable)
    #expect(health.errorMessage == nil)
    #expect(StubURLProtocol.requests.first?.url?.path == "/health")
    #expect(StubURLProtocol.requests.first?.httpMethod == "GET")
}

@Test("memoire-mem0/AC-8 : un service arrêté rend le message de transport, et rien d'autre")
func ac8TransportFailureKeepsItsMessage() async {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/health", .init(error: URLError(.cannotConnectToHost)))
    let service = stubbedHTTPMemoryService()

    let health = await service.health()

    #expect(!health.isAvailable)
    #expect(health.errorMessage == URLError(.cannotConnectToHost).localizedDescription)

    // La recherche lève la MÊME cause, elle ne l'avale pas.
    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/search", .init(error: URLError(.cannotConnectToHost)))
    await #expect(throws: MemoryServiceError.self) {
        _ = try await stubbedHTTPMemoryService().search(query: "q", scope: "s", pool: 24)
    }
}

@Test("memoire-mem0/AC-8 : 401, statut inattendu et corps illisible ont chacun leur texte")
func ac8StatusesHaveTheirMessages() async {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/all", .init(status: 401, body: Data("nope".utf8)))
    await #expect(throws: MemoryServiceError.unauthorized) {
        _ = try await stubbedHTTPMemoryService().all(scope: "s")
    }

    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/all", .init(status: 503, body: Data("indisponible".utf8)))
    do {
        _ = try await stubbedHTTPMemoryService().all(scope: "s")
        Issue.record("un statut 503 doit lever")
    } catch let error as MemoryServiceError {
        #expect(error.userMessage == "réponse 503 du service (indisponible)")
    } catch {
        Issue.record("erreur inattendue : \(error)")
    }

    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/all", .init(body: Data("pas du json".utf8)))
    do {
        _ = try await stubbedHTTPMemoryService().all(scope: "s")
        Issue.record("un corps illisible doit lever")
    } catch let error as MemoryServiceError {
        #expect(error.userMessage == MemoryText.unreadableResponse)
    } catch {
        Issue.record("erreur inattendue : \(error)")
    }

    #expect(MemoryServiceError.unauthorized.userMessage == "jeton refusé (401)")
}

@Test("memoire-mem0/AC-8 : le jeton n'est envoyé que s'il est non vide, et l'adresse par défaut est localhost:8321")
func ac8ConfigAndToken() async throws {
    let defaulted = MemoryServiceConfig.fromEnvironment([:])
    #expect(defaulted.baseURL.absoluteString == "http://localhost:8321")
    #expect(defaulted.token.isEmpty)

    let overridden = MemoryServiceConfig.fromEnvironment([
        "MEM0_HTTP_URL": "http://127.0.0.1:9000",
        "MEM0_HTTP_TOKEN": "secret",
    ])
    #expect(overridden.baseURL.absoluteString == "http://127.0.0.1:9000")
    #expect(overridden.token == "secret")

    // Une variable posée mais VIDE est traitée comme absente (le `||` du plugin).
    let empty = MemoryServiceConfig.fromEnvironment(["MEM0_HTTP_URL": "", "MEM0_HTTP_TOKEN": ""])
    #expect(empty.baseURL.absoluteString == "http://localhost:8321")
    #expect(empty.token.isEmpty)

    StubURLProtocol.reset()
    StubURLProtocol.reply("/health", .init(body: memoryJSON(["ok": true])))
    _ = await stubbedHTTPMemoryService(token: "secret").health()
    #expect(StubURLProtocol.requests.first?.value(forHTTPHeaderField: "X-Mem0-Token") == "secret")

    StubURLProtocol.reset()
    StubURLProtocol.reply("/health", .init(body: memoryJSON(["ok": true])))
    _ = await stubbedHTTPMemoryService(token: "").health()
    #expect(StubURLProtocol.requests.first?.value(forHTTPHeaderField: "X-Mem0-Token") == nil)
}

/// Le corps JSON d'une requête capturée : `URLSession` le remet en flux, pas en
/// `httpBody` — le stub le draine et le repose, ce test lit les deux formes.
private func memoryBody(_ request: URLRequest) -> [String: Any]? {
    if let body = request.httpBody {
        return try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    }
    return nil
}
