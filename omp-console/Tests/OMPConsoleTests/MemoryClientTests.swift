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

// MARK: - Routes et écritures (S-2, S-3, S-8, S-9, S-10)

@Test("graph-based-memeries-view/AC-4 : la liste des routes et des chemins d'écriture est figée")
func ac4RoutesAndWritePathsAreFrozen() {
    #expect(MemoryRoute.allCases.map(\.rawValue) == ["/health", "/memory/all", "/memory/search", "/memory/graph"])
    #expect(MemoryRoute.health.method == "GET")
    #expect(MemoryRoute.all.method == "GET")
    #expect(MemoryRoute.search.method == "POST")
    #expect(MemoryRoute.graph.method == "GET")
    #expect(Set(MemoryRoute.allCases.map(\.method)).isSubset(of: ["GET", "POST"]))

    // Les chemins d'écriture se composent par identifiant, et rien d'autre.
    #expect(MemoryWritePath.add.path == "/memory/add")
    #expect(MemoryWritePath.add.method == "POST")
    #expect(MemoryWritePath.memory("m-1").path == "/memory/m-1")
    #expect(MemoryWritePath.memory("m-1").method == "PUT")
}

@Test("graph-based-memeries-view/AC-1 : le graphe lit TOUTES les portées — aucune query `agent_id`")
func ac1AllWithoutScopeHasNoQuery() async throws {
    StubURLProtocol.reset()
    StubURLProtocol.reply(
        "/memory/all",
        .init(body: memoryJSON([
            "total": 2,
            "results": [
                ["id": "m-1", "memory": "un", "agent_id": "projet-a", "metadata": ["tags": "t"]],
                ["id": "m-2", "memory": "deux"],
            ],
        ]))
    )
    let service = stubbedHTTPMemoryService()

    let page = try await service.all(scope: nil)

    let request = try #require(StubURLProtocol.requests.first)
    #expect(request.url?.path == "/memory/all")
    #expect(request.url?.query == nil)
    // `agent_id` présent ⇒ la portée de la ligne ; absent ⇒ nil, jamais "".
    #expect(page.rows.map(\.agentId) == ["projet-a", nil])
    #expect(page.rows[0].tags == ["t"])
}

@Test("graph-based-memeries-view/AC-17 : la recherche du graphe n'envoie AUCUN `agent_id`")
func ac17SearchWithoutScopeHasNoAgentId() async throws {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/search", .init(body: memoryJSON(["results": []])))
    let service = stubbedHTTPMemoryService()

    _ = try await service.search(query: "sujet", scope: nil, pool: 24)

    let request = try #require(StubURLProtocol.requests.first)
    let body = try #require(memoryBody(request))
    #expect(body["agent_id"] == nil)
    #expect(body["query"] as? String == "sujet")
    #expect(body["limit"] as? Int == 24)
    #expect(body["threshold"] as? Double == 0.55)
    #expect(body["explain"] as? Bool == true)
    #expect(body["filters"] is NSNull)
}

@Test("graph-based-memeries-view/AC-8 : `GET /memory/graph` est lu et décodé, une arête illisible étant ignorée")
func ac8GraphRouteIsDecoded() async throws {
    StubURLProtocol.reset()
    StubURLProtocol.reply(
        "/memory/graph",
        .init(body: memoryJSON([
            "total": 3,
            "threshold": 0.75,
            "top_k": 8,
            "edges": [
                ["source": "m-1", "target": "m-2", "score": 0.81],
                ["source": "m-3", "target": "m-4"],
                ["source": 5, "target": "m-5", "score": 0.9],
                ["source": "m-6", "target": "m-7", "score": "0.9"],
            ],
        ]))
    )
    let service = stubbedHTTPMemoryService()

    let graph = try await service.graph()

    let request = try #require(StubURLProtocol.requests.first)
    #expect(request.url?.path == "/memory/graph")
    #expect(request.httpMethod == "GET")
    #expect(graph.total == 3)
    #expect(graph.edges == [MemoryGraphEdge(source: "m-1", target: "m-2", score: 0.81)])

    // Une réponse vide (aucun souvenir) reste lisible.
    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/graph", .init(body: memoryJSON(["total": 0, "edges": []])))
    #expect(try await stubbedHTTPMemoryService().graph().edges.isEmpty)
}

@Test("graph-based-memeries-view/AC-12 : la création envoie `infer: false` et n'omet `tags` que s'il est vide")
func ac12AddBodyIsExact() async throws {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/add", .init(body: memoryJSON(["results": []])))
    let service = stubbedHTTPMemoryService()

    try await service.add(text: "souvenir neuf", scope: "projet-a", tags: ["t1", "t2"])

    let request = try #require(StubURLProtocol.requests.first)
    #expect(request.url?.path == "/memory/add")
    #expect(request.httpMethod == "POST")
    let body = try #require(memoryBody(request))
    #expect(body["text"] as? String == "souvenir neuf")
    #expect(body["agent_id"] as? String == "projet-a")
    #expect(body["tags"] as? String == "t1,t2")
    // REQUIS : sans lui, mem0 ferait résumer le texte par le LLM.
    #expect(body["infer"] as? Bool == false)

    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/add", .init(body: memoryJSON(["results": []])))
    try await stubbedHTTPMemoryService().add(text: "sans étiquettes", scope: "p", tags: [])
    let bareRequest = try #require(StubURLProtocol.requests.first)
    let bare = try #require(memoryBody(bareRequest))
    #expect(bare["tags"] == nil)
}

@Test("graph-based-memeries-view/AC-9 : la correction envoie le texte saisi et les étiquettes normalisées")
func ac9UpdateBodyIsExact() async throws {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/m-1", .init(body: memoryJSON(["message": "ok"])))
    let service = stubbedHTTPMemoryService()

    try await service.update(id: "m-1", text: "texte corrigé", tags: ["t1", "t2"])

    let request = try #require(StubURLProtocol.requests.first)
    #expect(request.url?.path == "/memory/m-1")
    #expect(request.httpMethod == "PUT")
    let body = try #require(memoryBody(request))
    #expect(body["text"] as? String == "texte corrigé")
    #expect(body["tags"] as? String == "t1,t2")

    // Aucune étiquette ⇒ `""`, jamais un champ absent (c'est lui qui les retire).
    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/m-1", .init(body: memoryJSON(["message": "ok"])))
    try await stubbedHTTPMemoryService().update(id: "m-1", text: "x", tags: [])
    let clearedRequest = try #require(StubURLProtocol.requests.first)
    let cleared = try #require(memoryBody(clearedRequest))
    #expect(cleared["tags"] as? String == "")
}

@Test("graph-based-memeries-view/AC-11 : la suppression émet DELETE sur le chemin du souvenir, sans corps")
func ac11DeleteBodyIsExact() async throws {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/m-1", .init(body: memoryJSON(["message": "ok"])))
    let service = stubbedHTTPMemoryService()

    try await service.delete(id: "m-1")

    let request = try #require(StubURLProtocol.requests.first)
    #expect(request.url?.path == "/memory/m-1")
    #expect(request.httpMethod == "DELETE")
    #expect(request.httpBody == nil)
}

@Test("graph-based-memeries-view/AC-11 : une écriture refusée lève une erreur porteuse de son texte")
func ac11WriteFailureCarriesItsMessage() async {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/memory/m-1", .init(status: 500, body: Data("id inconnu".utf8)))

    await #expect(throws: MemoryServiceError.unexpectedStatus(500, "id inconnu")) {
        try await stubbedHTTPMemoryService().delete(id: "m-1")
    }
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

@Test("omp-console-redesign/S-18 : les étiquettes d'une ligne viennent de metadata.tags, absentes ⇒ aucune")
func s18RowTagsComeFromMetadata() {
    let row: [String: Any] = ["id": "m", "memory": "x", "metadata": ["tags": "a,b"]]
    #expect(MemoryJSON.row(row).tags == ["a", "b"])
    // Espaces détourés, segments vides écartés.
    #expect(MemoryJSON.row(["id": "m", "memory": "x", "metadata": ["tags": " a , ,b,"]]).tags == ["a", "b"])
    // Absentes, nulles ou non textuelles : aucune étiquette, la ligne reste lisible.
    #expect(MemoryJSON.row(["id": "m", "memory": "x"]).tags == [])
    #expect(MemoryJSON.row(["id": "m", "memory": "x", "metadata": NSNull()]).tags == [])
    #expect(MemoryJSON.row(["id": "m", "memory": "x", "metadata": ["memory_type": "procedural_memory"]]).tags == [])
    #expect(MemoryJSON.row(["id": "m", "memory": "x", "metadata": ["tags": ["a"]]]).tags == [])
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
