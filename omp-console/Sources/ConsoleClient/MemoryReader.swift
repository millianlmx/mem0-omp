// La mémoire du serveur, lue DIRECTEMENT par l'app iOS (mem0-rs, publié par
// `harness.sh up` et porté par le code d'appairage) : aucun Mac sur le chemin.
//
// Trois lectures, comme la section Mémoire de la coque macOS : le sommaire d'une
// portée par pages, une recherche sélectionnée exactement comme l'outil
// `mem0_search` (`MemorySearch`), et le graphe des souvenirs, dérivé par le noyau
// partagé (`MemoryGraph`). Le décodage des réponses est celui de la coque
// (`MemoryPage`, `MemoryJSON`, `MemoryGraphEdges`). Lecture seule.

import ConsoleCore
import Foundation

/// L'adresse de la mémoire et son jeton (`X-Mem0-Token`).
public struct MemoryServer: Equatable, Sendable {
    public var baseURL: URL
    public var token: String

    public init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
    }
}

/// La cause d'une lecture échouée, sans détail technique : l'écran en tire sa phrase.
public enum MemoryReadError: Error, Equatable, Sendable {
    /// Aucune réponse : serveur éteint, hors réseau, adresse fausse.
    case unreachable
    /// Joint, mais sans réponse à temps.
    case timedOut
    /// 401 ou 403 : le jeton n'est plus le bon.
    case unauthorized
    /// 503 : le service répond qu'il n'est pas prêt.
    case unavailable
    /// 404 ou 405 sur le graphe : un mem0-rs trop ancien pour cette route.
    case outdated
    /// Tout autre statut, ou un corps illisible.
    case failed
}

/// Le transport, injectable : la production passe par `URLSession`, les tests par
/// une doublure qui rend un statut et un corps.
public protocol MemoryTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (status: Int, body: Data)
}

public struct URLSessionMemoryTransport: MemoryTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        let (data, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

public struct MemoryReader: Sendable {
    /// La taille d'une page du sommaire : la liste se lit par tranches.
    public static let pageSize = 100
    /// Le sommaire et le graphe lisent toute une portée ; la recherche est courte.
    static let readTimeout: TimeInterval = 60
    static let searchTimeout: TimeInterval = 20

    public let server: MemoryServer
    private let transport: any MemoryTransport

    public init(server: MemoryServer, transport: any MemoryTransport = URLSessionMemoryTransport()) {
        self.server = server
        self.transport = transport
    }

    /// Les portées de la mémoire, de la plus récemment écrite à la plus ancienne.
    public func scopes() async throws -> [String] {
        let rows = try await all(scope: nil).rows
        var seen: Set<String> = []
        return rows.compactMap(\.agentId).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// La tranche `[offset, offset+limit)` du sommaire de `scope`, dans l'ordre du
    /// service ; sans portée, une page vide `scope: nil` sans appel.
    public func page(scope: String?, offset: Int, limit: Int? = nil) async throws -> RemoteMemoryPagePayload {
        guard let scope else { return RemoteMemoryPagePayload(scope: nil, total: 0, offset: 0, rows: [], nextOffset: nil) }
        let page = try await all(scope: scope)
        let start = min(max(0, offset), page.rows.count)
        let kept = page.rows[start...].prefix(max(1, limit ?? Self.pageSize)).map(RemoteMemoryRow.init)
        let next = start + kept.count
        return RemoteMemoryPagePayload(
            scope: scope,
            total: page.total,
            offset: offset,
            rows: Array(kept),
            nextOffset: next < page.rows.count ? next : nil
        )
    }

    /// La recherche de `mem0_search` : pool sur-échantillonné, seuil du plugin, tri
    /// par cosinus brut (`MemorySearch.select`).
    public func search(query: String, scope: String?, limit: Int? = nil) async throws -> RemoteMemorySearchPayload {
        let limit = limit ?? MemorySearch.defaultLimit
        var body: [String: Any] = [
            "query": query,
            "limit": MemorySearch.pool(requested: limit),
            "filters": NSNull(),
            "threshold": MemorySearch.threshold,
            "explain": true,
        ]
        if let scope { body["agent_id"] = scope }
        let json = try await send(path: "/memory/search", method: "POST", body: body, timeout: Self.searchTimeout)
        let rows = MemoryJSON.rows(json).map(MemoryJSON.row)
        let selected = MemorySearch.select(rows: rows, floor: MemorySearch.threshold, limit: limit)
        return RemoteMemorySearchPayload(
            rows: selected.kept.map(RemoteMemoryRow.init),
            candidates: selected.candidates,
            scored: selected.scored
        )
    }

    /// Le graphe d'une portée : ses souvenirs, leurs étiquettes partagées et les
    /// arêtes de proximité du service ; sans portée, un graphe vide sans appel.
    public func graph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        guard let scope else { return RemoteMemoryGraphPayload(scope: nil, nodes: [], links: [], total: 0) }
        let rows = try await all(scope: scope).rows
        let edges = MemoryGraphEdges.decode(try await send(path: "/memory/graph", method: "GET", body: nil, timeout: Self.readTimeout))
        return Self.graphPayload(scope: scope, rows: rows, edges: edges.edges)
    }

    /// La projection des faits du noyau : `text`/`tags` pour les seuls nœuds-souvenirs,
    /// `score` pour les seules arêtes `semantic`. Aucun lien manuel : ils sont propres
    /// au Mac qui les a tracés.
    static func graphPayload(scope: String, rows: [MemoryRow], edges: [MemoryGraphEdge]) -> RemoteMemoryGraphPayload {
        let nodes = MemoryGraph.nodes(rows: rows)
        let links = MemoryGraph.links(rows: rows, edges: edges, manual: [])
        return RemoteMemoryGraphPayload(
            scope: scope,
            nodes: nodes.map { node in
                RemoteMemoryGraphNode(
                    id: MemoryGraphWire.id(node.id),
                    label: node.label,
                    scope: node.scope ?? "",
                    text: node.text,
                    tags: node.text == nil ? nil : node.tags
                )
            },
            links: links.map { link in
                var score: Double?
                if case .semantic(let value) = link.kind { score = value }
                return RemoteMemoryGraphLink(
                    a: MemoryGraphWire.id(link.a),
                    b: MemoryGraphWire.id(link.b),
                    kind: MemoryGraphWire.name(link.kind),
                    score: score
                )
            },
            total: nodes.count
        )
    }

    // MARK: - Transport

    private func all(scope: String?) async throws -> MemoryPage {
        var path = "/memory/all"
        if let scope, let encoded = scope.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            path += "?agent_id=" + encoded
        }
        return MemoryPage.decode(try await send(path: path, method: "GET", body: nil, timeout: Self.readTimeout))
    }

    private func send(path: String, method: String, body: [String: Any]?, timeout: TimeInterval) async throws -> Any {
        var base = server.baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: base + path) else { throw MemoryReadError.unreachable }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        if !server.token.isEmpty { request.setValue(server.token, forHTTPHeaderField: "X-Mem0-Token") }

        let reply: (status: Int, body: Data)
        do {
            reply = try await transport.send(request)
        } catch let error as URLError where error.code == .timedOut {
            throw MemoryReadError.timedOut
        } catch {
            throw MemoryReadError.unreachable
        }
        switch reply.status {
        case 200 ..< 300:
            guard let json = try? JSONSerialization.jsonObject(with: reply.body) else { throw MemoryReadError.failed }
            return json
        case 401, 403: throw MemoryReadError.unauthorized
        case 404, 405: throw path == "/memory/graph" ? MemoryReadError.outdated : MemoryReadError.failed
        case 503: throw MemoryReadError.unavailable
        default: throw MemoryReadError.failed
        }
    }
}

extension RemoteMemoryRow {
    /// La ligne telle que l'écran la montre : le cosinus brut sert de score.
    public init(_ row: MemoryRow) {
        self.init(
            id: row.id,
            text: row.text,
            updatedAt: row.updatedAt,
            score: row.semanticScore,
            tags: row.tags,
            agentId: row.agentId
        )
    }
}
