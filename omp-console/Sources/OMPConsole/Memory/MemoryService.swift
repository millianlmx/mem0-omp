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

/// Les routes de la fonctionnalité, et RIEN d'autre (S-2) : deux lectures et une
/// recherche. Aucun constructeur d'écriture n'existe dans ce module, et
/// `HTTPMemoryService` ne bâtit ses URL qu'à partir de cette liste.
enum MemoryRoute: String, CaseIterable, Sendable {
    case health = "/health"
    case all = "/memory/all"
    case search = "/memory/search"

    var method: String {
        switch self {
        case .health, .all: "GET"
        case .search: "POST"
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

/// Une ligne de souvenir, réduite à ce que l'app affiche (S-1, S-3, S-5) : son
/// identifiant, son texte COMPLET, sa date et son cosinus brut s'il en porte.
struct MemoryRow: Identifiable, Equatable, Sendable {
    var id: String
    var text: String
    var updatedAt: String?
    var semanticScore: Double?
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

    static func row(_ json: Any) -> MemoryRow {
        MemoryRow(
            id: identifier(json),
            text: line(json),
            updatedAt: updatedAt(json),
            semanticScore: score(json)
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

/// La surface du service, en LECTURE seule (S-2) : aucune méthode d'écriture
/// n'existe — il n'y a rien à appeler pour ajouter, modifier ou supprimer.
protocol MemoryServing: Sendable {
    func health() async -> MemoryHealth
    func search(query: String, scope: String, pool: Int) async throws -> [MemoryRow]
    func all(scope: String) async throws -> MemoryPage
}

struct HTTPMemoryService: MemoryServing {
    let config: MemoryServiceConfig
    let session: URLSession

    /// Budgets d'INACTIVITÉ, miroir de `TIMEOUT` (config.ts:13).
    static let searchTimeout: TimeInterval = 20
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

    func all(scope: String) async throws -> MemoryPage {
        var components = URLComponents(url: url(for: .all), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "agent_id", value: scope)]
        guard let url = components?.url else {
            throw MemoryServiceError.malformedResponse("URL /memory/all invalide")
        }
        let json = try await send(url, method: MemoryRoute.all.method, body: nil, timeout: Self.otherTimeout)
        return MemoryPage.decode(json)
    }

    func search(query: String, scope: String, pool: Int) async throws -> [MemoryRow] {
        // Le corps EXACT de S-1 : `limit` = pool sur-échantillonné, seuil du plugin,
        // `explain` pour obtenir le cosinus brut, `filters` nul.
        let body: [String: Any] = [
            "query": query,
            "agent_id": scope,
            "limit": pool,
            "filters": NSNull(),
            "threshold": MemorySearch.threshold,
            "explain": true,
        ]
        let json = try await send(url(for: .search), method: MemoryRoute.search.method, body: body, timeout: Self.searchTimeout)
        return MemoryJSON.rows(json).map(MemoryJSON.row)
    }

    /// L'URL d'une route, quelle que soit la barre oblique finale de `MEM0_HTTP_URL`.
    private func url(for route: MemoryRoute) -> URL {
        var base = config.baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + route.rawValue) ?? config.baseURL
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
