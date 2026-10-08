// Le client mem0-http de l'app (S-1, S-2, S-3, S-6, S-7) : config, lignes de
// souvenir, page du sommaire, erreurs, protocole et implémentation HTTP.
//
// La surface est STRICTEMENT un lecteur (S-2) : le protocole n'expose aucune
// méthode d'écriture, et `HTTPMemoryService` ne construit ses URL qu'à partir de
// `MemoryRoute` — trois routes, jamais une de plus. Un test fige cette liste.
//
// Le client de référence est le plugin mémoire (`omp-mem0-memory/`) : les gardes de
// décodage reproduisent `memoryId` / `memoryLine` / `semanticScore`
// (mem0Client.ts:82-111), et les budgets sont ceux de `TIMEOUT` (config.ts:13).

import ConsoleCore
import Foundation

// MARK: - Configuration

/// L'adresse et le jeton du service (S-7), lus dans l'environnement du process —
/// jamais dans un fichier, jamais dans une préférence. Une variable posée mais VIDE
/// est traitée comme absente (le `||` du plugin, config.ts:2,4).
struct MemoryServiceConfig: Equatable, Sendable {
    var baseURL: URL
    var token: String

    /// Littéral prouvé valide : le seul force-unwrap du module, et il ne porte
    /// aucune donnée réseau.
    static let defaultBaseURL = URL(string: "http://localhost:8321")!

    static func fromEnvironment(_ environment: [String: String]) -> MemoryServiceConfig {
        let raw = environment["MEM0_HTTP_URL"].flatMap { $0.isEmpty ? nil : $0 }
        let baseURL = raw.flatMap { URL(string: $0) } ?? defaultBaseURL
        let token = environment["MEM0_HTTP_TOKEN"].flatMap { $0.isEmpty ? nil : $0 } ?? ""
        return MemoryServiceConfig(baseURL: baseURL, token: token)
    }
}

// MARK: - Routes (S-2)

/// Les routes de la fonctionnalité : trois lectures (dont le graphe) et une
/// recherche. Les CHEMINS D'ÉCRITURE n'existent pas ici — ils se composent par
/// identifiant, via `MemoryWritePath`, jamais par concaténation ad hoc.
enum MemoryRoute: String, CaseIterable, Sendable {
    case health = "/health"
    case all = "/memory/all"
    case search = "/memory/search"
    case graph = "/memory/graph"

    var method: String {
        switch self {
        case .health, .all, .graph: "GET"
        case .search: "POST"
        }
    }
}

/// Les chemins d'ÉCRITURE (S-8, S-9, S-10) : le chemin d'un souvenir se compose par
/// identifiant. `PUT` et `DELETE` partagent le même chemin, comme le service.
enum MemoryWritePath: Equatable, Sendable {
    case add
    case memory(String)

    var path: String {
        switch self {
        case .add: "/memory/add"
        case let .memory(id): "/memory/\(id)"
        }
    }

    var method: String {
        switch self {
        case .add: "POST"
        case .memory: "PUT"
        }
    }
}

// MARK: - Modèle de données

/// L'état du service (S-6.2) : disponible ou non, et le DERNIER message d'erreur
/// rencontré (`nil` quand le service répond — le message persiste jusqu'au prochain
/// succès).
struct MemoryHealth: Equatable, Sendable {
    var isAvailable: Bool
    var errorMessage: String?
}

// `MemoryRow` et `MemoryGraphEdge` vivent désormais dans `ConsoleCore`
// (`MemoryGraphFacts.swift`) : l'app iOS en a besoin, et ne lie pas cette cible.

/// La réponse de `GET /memory/graph`, décodée TOLÉRAMMENT : une arête dont les
/// extrémités ne sont pas deux chaînes et le score un nombre fini est ignorée — une
/// réponse partiellement illisible ne fait pas tomber le graphe entier.
struct MemoryGraphEdges: Equatable, Sendable {
    var total: Int
    var edges: [MemoryGraphEdge]

    static func decode(_ json: Any) -> MemoryGraphEdges {
        let object = json as? [String: Any]
        let raw = object?["edges"] as? [Any] ?? []
        var edges: [MemoryGraphEdge] = []
        for entry in raw {
            guard let edge = entry as? [String: Any],
                  let source = edge["source"] as? String,
                  let target = edge["target"] as? String,
                  let score = edge["score"] as? NSNumber,
                  !MemoryJSON.isBoolean(score) else { continue }
            let value = score.doubleValue
            guard value.isFinite else { continue }
            edges.append(MemoryGraphEdge(source: source, target: target, score: value))
        }
        let total = object?["total"] as? Int ?? edges.count
        return MemoryGraphEdges(total: total, edges: edges)
    }
}

/// Le sommaire d'une portée (S-3) : le compte `total` du service et ses lignes,
/// dans l'ordre rendu.
struct MemoryPage: Equatable, Sendable {
    var total: Int
    var rows: [MemoryRow]

    /// Un tableau nu est accepté autant qu'un objet `{"total": n, "results": […]}` ;
    /// `total` absent (ou non entier) vaut le nombre de lignes reçues.
    static func decode(_ json: Any) -> MemoryPage {
        let rows = MemoryJSON.rows(json).map(MemoryJSON.row)
        let total = (json as? [String: Any])?["total"] as? Int ?? rows.count
        return MemoryPage(total: total, rows: rows)
    }
}

/// Les gardes de décodage des lignes réseau, portées de `mem0Client.ts:82-111`.
/// Les lignes ne sont validées nulle part ailleurs : chaque garde est locale, et
/// une ligne mal formée rend un champ `nil` — jamais un `force`-unwrap, jamais une
/// exception qui ferait tomber la liste entière.
enum MemoryJSON {
    /// `rows(result)` (mem0Client.ts:71-73) : tableau nu ou `{"results": […]}`.
    static func rows(_ json: Any) -> [Any] {
        if let array = json as? [Any] { return array }
        if let object = json as? [String: Any], let results = object["results"] as? [Any] { return results }
        return []
    }

    /// `memoryLine(m)` : `m.memory`, sinon `m.text`, sinon la sérialisation JSON.
    static func line(_ json: Any) -> String {
        guard let object = json as? [String: Any] else { return scalar(json) }
        if let memory = object["memory"], !(memory is NSNull) { return scalar(memory) }
        if let text = object["text"], !(text is NSNull) { return scalar(text) }
        return scalar(json)
    }

    /// `memoryId(m)` : `String(m.id)` pour une chaîne ou un nombre, `"?"` sinon.
    static func identifier(_ json: Any) -> String {
        guard let object = json as? [String: Any], let raw = object["id"] else { return "?" }
        if let string = raw as? String { return string }
        // `typeof id === "number"` : un booléen n'est PAS un nombre ici (mesuré :
        // JSONSerialization rend `true` en NSNumber).
        if let number = raw as? NSNumber, !isBoolean(number) { return number.stringValue }
        return "?"
    }

    /// `semanticScore(row)` : `score_details.semantic_score`, seulement s'il est
    /// fini — champ absent, non numérique, NaN ou infini rendent `nil`.
    static func score(_ json: Any) -> Double? {
        guard let object = json as? [String: Any],
              let details = object["score_details"] as? [String: Any],
              let raw = details["semantic_score"] as? NSNumber,
              !isBoolean(raw)
        else { return nil }
        let value = raw.doubleValue
        return value.isFinite ? value : nil
    }

    static func updatedAt(_ json: Any) -> String? {
        guard let object = json as? [String: Any], let raw = object["updated_at"], !(raw is NSNull) else {
            return nil
        }
        return scalar(raw)
    }

    /// `metadata.tags` tel que le serveur le stocke (`"a,b"`, http_server.py) :
    /// découpé aux virgules, détouré, sans segment vide. Absent ou non textuel ⇒
    /// aucune étiquette.
    static func tags(_ json: Any) -> [String] {
        guard let object = json as? [String: Any],
              let metadata = object["metadata"] as? [String: Any],
              let raw = metadata["tags"] as? String
        else { return [] }
        return raw.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// `agent_id` de la ligne (S-2) : la portée du souvenir, absente ⇒ `nil` (la
    /// ligne reste un nœud, regroupé sous « Sans projet »).
    static func agentId(_ json: Any) -> String? {
        guard let object = json as? [String: Any], let raw = object["agent_id"], !(raw is NSNull) else {
            return nil
        }
        return raw as? String
    }

    static func row(_ json: Any) -> MemoryRow {
        MemoryRow(
            id: identifier(json),
            text: line(json),
            updatedAt: updatedAt(json),
            semanticScore: score(json),
            tags: tags(json),
            agentId: agentId(json)
        )
    }

    static func isBoolean(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    /// La forme TEXTE d'une valeur JSON : une chaîne telle quelle, tout le reste
    /// sérialisé en JSON (le `String(...)`/`JSON.stringify` du plugin).
    static func scalar(_ value: Any) -> String {
        if let string = value as? String { return string }
        if let fragment = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
           let text = String(data: fragment, encoding: .utf8) {
            return text
        }
        return "\(value)"
    }
}

// MARK: - Étiquettes (S-8)

/// La normalisation des étiquettes d'un souvenir, en UNE formule partagée par la
/// feuille d'édition, celle de création et le client HTTP : découpage aux virgules,
/// trim, segments vides retirés, doublons retirés (l'ordre d'apparition est
/// conservé), jointure par « , ». `""` signifie « aucune étiquette ».
enum MemoryTags {
    /// Les étiquettes d'un champ de saisie, dans l'ordre d'apparition.
    static func list(_ raw: String) -> [String] {
        var seen: Set<String> = []
        var kept: [String] = []
        for segment in raw.split(separator: ",") {
            let tag = segment.trimmingCharacters(in: .whitespaces)
            guard !tag.isEmpty, seen.insert(tag).inserted else { continue }
            kept.append(tag)
        }
        return kept
    }

    /// La forme envoyée au service : `"a,b"`, ou `""` pour aucune.
    static func normalized(_ tags: [String]) -> String {
        tags.joined(separator: ",")
    }

    /// La forme d'un champ de saisie : `"a, b"`.
    static func display(_ tags: [String]) -> String {
        tags.joined(separator: ", ")
    }
}

// MARK: - Erreurs

/// Les erreurs du client, chacune avec SON texte (une erreur, un texte) : la vue
/// affiche `userMessage`, elle ne compose jamais un message (S-6.4).
enum MemoryServiceError: Error, Equatable, Sendable {
    case notReachable(String)
    case unauthorized
    case unexpectedStatus(Int, String)
    case malformedResponse(String)

    var userMessage: String {
        switch self {
        case let .notReachable(detail): detail
        case .unauthorized: MemoryText.tokenRefused
        case let .unexpectedStatus(code, detail): MemoryText.unexpectedStatus(code: code, detail: detail)
        case .malformedResponse: MemoryText.unreadableResponse
        }
    }

    /// Le message d'une erreur quelconque, sans jamais exposer un `NSError` brut.
    static func message(for error: Error) -> String {
        (error as? MemoryServiceError)?.userMessage ?? transportMessage(error)
    }

    /// La description de l'erreur TELLE QUELLE : un refus ATS
    /// (`appTransportSecurityRequiresSecureConnection`) doit s'afficher, jamais
    /// devenir « aucun souvenir » (S-6.4).
    static func transportMessage(_ error: Error) -> String {
        (error as? URLError)?.localizedDescription ?? error.localizedDescription
    }

    /// Le début du corps d'une réponse en échec, borné comme celui du plugin
    /// (`mem0Client.ts:24`, `body.slice(0, 300)`).
    static func detail(_ data: Data) -> String {
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "corps vide" : String(text.prefix(300))
    }
}

// MARK: - Protocole et implémentation HTTP

/// La surface du service : trois lectures (sommaire, recherche, graphe) et les
/// écritures du mode graphe (créer, corriger, supprimer). Chaque écriture est une
/// méthode nommée — la vue ne compose jamais une requête.
protocol MemoryServing: Sendable {
    func health() async -> MemoryHealth
    /// `scope` nul ⇒ AUCUNE query `agent_id` : toutes les portées du service (S-2).
    func all(scope: String?) async throws -> MemoryPage
    /// `scope` nul ⇒ recherche toutes portées (S-7) ; la liste, elle, passe
    /// toujours la portée du projet.
    func search(query: String, scope: String?, pool: Int) async throws -> [MemoryRow]
    func graph() async throws -> MemoryGraphEdges
    /// `POST /memory/add` avec `infer: false` : stockage mot pour mot, sans LLM.
    /// `tags` vide ⇒ le champ n'est pas envoyé.
    func add(text: String, scope: String, tags: [String]) async throws
    /// `PUT /memory/{id}` : le texte est écrit TEL QUEL, `tags` remplace les
    /// étiquettes (`""` les retire, S-8).
    func update(id: String, text: String, tags: [String]) async throws
    func delete(id: String) async throws
}

struct HTTPMemoryService: MemoryServing {
    let config: MemoryServiceConfig
    let session: URLSession

    /// Budgets d'INACTIVITÉ, miroir de `TIMEOUT` (config.ts:13). Le graphe a le
    /// sien (20 s) : il lit toute la collection et calcule les similarités côté
    /// service, ce qui ne coûte pas le temps d'une lecture de liste.
    static let searchTimeout: TimeInterval = 20
    static let graphTimeout: TimeInterval = 20
    static let otherTimeout: TimeInterval = 10

    init(config: MemoryServiceConfig, session: URLSession = .shared) {
        self.config = config
        self.session = session
    }

    /// La sonde `/health` ne lève JAMAIS : l'état est une valeur, pas une erreur
    /// (S-6.1).
    func health() async -> MemoryHealth {
        do {
            let json = try await send(url(for: .health), method: MemoryRoute.health.method, body: nil, timeout: Self.otherTimeout)
            let ok = (json as? [String: Any])?["ok"] as? Bool ?? false
            return MemoryHealth(isAvailable: ok, errorMessage: ok ? nil : MemoryText.unreadableResponse)
        } catch {
            return MemoryHealth(isAvailable: false, errorMessage: MemoryServiceError.message(for: error))
        }
    }

    func all(scope: String?) async throws -> MemoryPage {
        var components = URLComponents(url: url(for: .all), resolvingAgainstBaseURL: false)
        // Sans portée, AUCUNE query n'est posée : le service rend alors toutes les
        // portées (`scope_filters` n'ajoute que `user_id`).
        components?.queryItems = scope.map { [URLQueryItem(name: "agent_id", value: $0)] }
        guard let url = components?.url else {
            throw MemoryServiceError.malformedResponse("URL /memory/all invalide")
        }
        let json = try await send(url, method: MemoryRoute.all.method, body: nil, timeout: Self.otherTimeout)
        return MemoryPage.decode(json)
    }

    func search(query: String, scope: String?, pool: Int) async throws -> [MemoryRow] {
        // Le corps EXACT de S-1 : `limit` = pool sur-échantillonné, seuil du plugin,
        // `explain` pour obtenir le cosinus brut, `filters` nul. `agent_id` n'est
        // posé que si une portée est demandée (S-7 : le graphe cherche partout).
        var body: [String: Any] = [
            "query": query,
            "limit": pool,
            "filters": NSNull(),
            "threshold": MemorySearch.threshold,
            "explain": true,
        ]
        if let scope { body["agent_id"] = scope }
        let json = try await send(url(for: .search), method: MemoryRoute.search.method, body: body, timeout: Self.searchTimeout)
        return MemoryJSON.rows(json).map(MemoryJSON.row)
    }

    func graph() async throws -> MemoryGraphEdges {
        let json = try await send(url(for: .graph), method: MemoryRoute.graph.method, body: nil, timeout: Self.graphTimeout)
        return MemoryGraphEdges.decode(json)
    }

    func add(text: String, scope: String, tags: [String]) async throws {
        var body: [String: Any] = [
            "text": text,
            "agent_id": scope,
            // REQUIS : sans lui, mem0 ferait résumer le texte par le LLM au lieu de
            // le stocker mot pour mot (S-10).
            "infer": false,
        ]
        let normalized = MemoryTags.normalized(tags)
        if !normalized.isEmpty { body["tags"] = normalized }
        _ = try await send(
            url(for: MemoryWritePath.add.path),
            method: MemoryWritePath.add.method,
            body: body,
            timeout: Self.otherTimeout
        )
    }

    func update(id: String, text: String, tags: [String]) async throws {
        // `tags` est TOUJOURS posé (chaîne vide comprise) : c'est lui qui remplace
        // les étiquettes, et la fiche les affiche telles qu'elle les a saisies.
        let body: [String: Any] = ["text": text, "tags": MemoryTags.normalized(tags)]
        _ = try await send(
            url(for: MemoryWritePath.memory(id).path),
            method: MemoryWritePath.memory(id).method,
            body: body,
            timeout: Self.otherTimeout
        )
    }

    func delete(id: String) async throws {
        _ = try await send(
            url(for: MemoryWritePath.memory(id).path),
            method: "DELETE",
            body: nil,
            timeout: Self.otherTimeout
        )
    }

    /// L'URL d'une route, quelle que soit la barre oblique finale de `MEM0_HTTP_URL`.
    private func url(for route: MemoryRoute) -> URL {
        url(for: route.rawValue)
    }

    private func url(for path: String) -> URL {
        var base = config.baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + path) ?? config.baseURL
    }

    private func send(_ url: URL, method: String, body: [String: Any]?, timeout: TimeInterval) async throws -> Any {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        if !config.token.isEmpty {
            request.setValue(config.token, forHTTPHeaderField: "X-Mem0-Token")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw MemoryServiceError.notReachable(MemoryServiceError.transportMessage(error))
        }
        guard let http = response as? HTTPURLResponse else {
            throw MemoryServiceError.malformedResponse("réponse sans statut HTTP")
        }
        guard (200 ..< 300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw MemoryServiceError.unauthorized }
            throw MemoryServiceError.unexpectedStatus(http.statusCode, MemoryServiceError.detail(data))
        }
        do {
            return try JSONSerialization.jsonObject(with: data)
        } catch {
            throw MemoryServiceError.malformedResponse("corps illisible")
        }
    }
}
