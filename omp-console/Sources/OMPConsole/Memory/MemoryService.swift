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

/// L'adresse et le jeton du service (S-7) : l'environnement du process, sinon
/// `~/.omp/mem0.json` (le fichier que lit aussi le plugin mémoire), sinon le service
/// de l'app. Une variable posée mais VIDE est traitée comme absente (le `||` du
/// plugin, config.ts).
struct MemoryServiceConfig: Equatable, Sendable {
    var baseURL: URL
    var token: String
    /// Le jeton d'INSTALLATION exigé de `/health` (S-4) : vide tant qu'il n'a pas
    /// été lu (`AppPaths.installationToken`) — un service qui ne le rend pas n'est
    /// alors jamais accepté comme « sa » pile.
    var installationToken: String = ""

    /// Littéral prouvé valide : le seul force-unwrap du module, et il ne porte
    /// aucune donnée réseau.
    static let defaultBaseURL = URL(string: "http://localhost:8321")!

    /// Sans `MEM0_HTTP_URL`, la base vise le port de l'agent mem0-rs de l'app
    /// (`MemoryAgent.port(environment:)`, 8321 hors recette — S-8).
    static func fromEnvironment(_ environment: [String: String]) -> MemoryServiceConfig {
        let value: (String) -> String? = { key in environment[key].flatMap { $0.isEmpty ? nil : $0 } }
        let agentBase = URL(string: "http://localhost:\(MemoryAgent.port(environment: environment))") ?? defaultBaseURL
        // Le jeton du fichier ne vaut que pour l'adresse du fichier : une adresse de
        // l'environnement ne reçoit jamais le jeton d'un autre service.
        let file = value("MEM0_HTTP_URL") == nil ? MemorySettingsFile.load(environment: environment) : nil
        let raw = value("MEM0_HTTP_URL") ?? file?.url
        let baseURL = raw.flatMap { URL(string: $0) } ?? agentBase
        let token = value("MEM0_HTTP_TOKEN") ?? file?.token ?? ""
        var config = MemoryServiceConfig(baseURL: baseURL, token: token)
        config.chosen = file != nil && raw == file?.url
        return config
    }

    /// L'adresse vient de `~/.omp/mem0.json` : la mémoire que l'utilisateur a choisie
    /// (celle d'un serveur, ou une pile en conteneurs sur ce Mac), jamais un port de
    /// l'app tenu par un autre.
    var chosen: Bool = false

    /// La sonde identitaire (jeton d'installation) ne garde que le service de l'app :
    /// une adresse distante ou choisie en est dispensée.
    var verifiesIdentity: Bool { !isRemote && !chosen }

    /// Vrai pour une adresse hors de ce Mac : la mémoire d'un serveur, choisie
    /// explicitement et authentifiée par son jeton.
    var isRemote: Bool {
        guard let host = baseURL.host else { return false }
        return !StackOwnership.isLocalHost(host)
    }

    /// La configuration EFFECTIVE du client : l'environnement, PLUS le jeton
    /// d'installation lu sur le disque (S-4). Un jeton absent (pile jamais
    /// préparée) laisse le champ vide : aucune réponse ne sera acceptée avant que
    /// la pile ne porte le sien.
    static func resolved(
        environment: [String: String],
        paths: AppPaths
    ) -> MemoryServiceConfig {
        var config = fromEnvironment(environment)
        config.installationToken = InstallationTokenStore.load(at: paths.installationToken) ?? ""
        return config
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

/// `~/.omp/mem0.json` — `{ "url": …, "token": … }` : la mémoire partagée avec le
/// serveur de pipelines. Une app lancée par le Finder ne voit pas le profil du
/// shell ; ce fichier, lu aussi par le plugin mémoire, donne la même adresse aux
/// sessions et à l'app.
enum MemorySettingsFile {
    static func url(environment: [String: String]) -> URL? {
        guard let home = environment["HOME"], !home.isEmpty else { return nil }
        return URL(fileURLWithPath: home, isDirectory: true).appendingPathComponent(".omp/mem0.json")
    }

    /// L'adresse et le jeton du fichier ; `nil` s'il manque, est illisible ou ne
    /// porte pas d'adresse.
    static func load(environment: [String: String]) -> (url: String, token: String?)? {
        guard let file = url(environment: environment),
              let data = try? Data(contentsOf: file),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let address = object["url"] as? String, !address.isEmpty
        else { return nil }
        let token = (object["token"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return (address, token)
    }
}

// MARK: - Modèle de données

/// L'état du service (S-6.2) : disponible ou non, et le DERNIER message d'erreur
/// rencontré (`nil` quand le service répond — le message persiste jusqu'au prochain
/// succès).
struct MemoryHealth: Equatable, Sendable {
    var isAvailable: Bool
    var errorMessage: String?
    /// Vrai quand un `200 ok` répond SANS porter le jeton d'installation (S-4) :
    /// l'adresse répond, mais ce n'est pas la pile de l'app. Cet état n'est JAMAIS
    /// « disponible » (S-5, BR-9).
    var isForeign: Bool = false
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
    /// (S-6.1). Elle est aussi la sonde IDENTITAIRE (S-4) : un `200 ok` n'est
    /// accepté que s'il porte le jeton d'installation de l'app ; un `200 ok` sans
    /// ce jeton (ou avec un autre) est « étranger » — jamais « disponible ». Une
    /// adresse distante ou choisie (`verifiesIdentity` faux) en est dispensée.
    func health() async -> MemoryHealth {
        do {
            let json = try await send(url(for: .health), method: MemoryRoute.health.method, body: nil, timeout: Self.otherTimeout)
            let object = json as? [String: Any]
            let ok = object?["ok"] as? Bool ?? false
            // Corps illisible ou `ok` faux : l'erreur existante, jamais « étranger »
            // (un service muet n'est pas un autre service prouvé).
            guard ok else {
                return MemoryHealth(isAvailable: false, errorMessage: MemoryText.unreadableResponse)
            }
            // La sonde identitaire garde le port LOCAL de l'app ; une adresse distante
            // est un choix explicite de l'utilisateur, authentifié par son jeton.
            if !config.verifiesIdentity {
                return MemoryHealth(isAvailable: true, errorMessage: nil)
            }
            let returned = object?["installation"] as? String
            let expected = config.installationToken
            if !expected.isEmpty, returned == expected {
                return MemoryHealth(isAvailable: true, errorMessage: nil)
            }
            // `ok` vrai, jeton absent ou différent : quelqu'un répond, mais ce n'est
            // pas la pile de l'app.
            return MemoryHealth(isAvailable: false, errorMessage: MemoryText.foreignService, isForeign: true)
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
