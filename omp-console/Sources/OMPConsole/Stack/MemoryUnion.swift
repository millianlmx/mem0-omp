// L'union des souvenirs des deux bases connues (S-8, BR-5 ; AC-9) : le CŒUR de
// l'algorithme, pur vis-à-vis du réseau — il ne connaît que le protocole
// `MemoryBase`, donc deux doublures en mémoire suffisent à le figer.
//
// Règle FIGÉE du contrat : pour la collection `omp_memory`, tout id présent dans
// la source et ABSENT de la cible est recopié, payload et vecteur VERBATIM, par
// lots de 64 au plus ; un id déjà présent dans la cible n'est JAMAIS envoyé —
// l'upsert de Qdrant ÉCRASE (`Any point with an existing {id} will be
// overwritten.`), donc la retenue est ce qui protège les souvenirs de la cible.
// Un lot refusé rend `.incomplete` avec le nombre DÉJÀ copié et n'entame aucun lot
// suivant (idempotence de la reprise).
//
// `HTTPMemoryBase` porte la seule traduction REST (Qdrant v1.19.0, Documentation
// du contrat) : en-tête `api-key`, `with_vector` au SINGULIER (le client Python de
// mem0 emploie le pluriel — piège déjà payé), scroll paginé par
// `next_page_offset`, upsert `?wait=true`.

import Foundation

/// L'adresse d'une base Qdrant, avec sa clé d'API (S-8).
struct QdrantEndpoint: Equatable, Sendable {
    var baseURL: URL
    var apiKey: String
}

/// L'id d'un point, dans SA forme JSON d'origine (u64 ou UUID) — jamais converti :
/// un id entier reste un nombre, un id UUID reste une chaîne.
enum QdrantPointID: Equatable, Hashable, Sendable {
    case number(UInt64)
    case string(String)
}

extension QdrantPointID: Codable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(UInt64.self) {
            self = .number(value)
            return
        }
        self = .string(try container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        }
    }
}

/// Une valeur JSON brute qui refait le tour EXACTEMENT : null, booléen, nombre,
/// chaîne, tableau, objet. Le nombre est porté par un `Double` (suffisant pour des
/// vecteurs et des payloads), la structure par des cas récursifs.
enum AnyJSON: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([AnyJSON])
    case object([String: AnyJSON])
}

extension AnyJSON: Codable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
            return
        }
        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
            return
        }
        if let value = try? container.decode(Double.self) {
            self = .number(value)
            return
        }
        if let value = try? container.decode(String.self) {
            self = .string(value)
            return
        }
        if let value = try? container.decode([AnyJSON].self) {
            self = .array(value)
            return
        }
        self = .object(try container.decode([String: AnyJSON].self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// Un point recopiable : payload et vecteur conservés tels que le service les rend.
struct QdrantPoint: Equatable, Sendable {
    var id: QdrantPointID
    var vector: AnyJSON
    var payload: AnyJSON?
}

/// L'échec d'un appel à une base mémoire, porteur du code et du corps pour que
/// l'union fabrique `<code> <corps borné>` (S-8).
struct MemoryBaseError: Error, Equatable, Sendable {
    var status: Int
    var body: String
}

/// Une base mémoire telle que l'union la voit (deux doublures suffisent à la tester).
protocol MemoryBase: Sendable {
    func collectionNames() async throws -> [String]
    /// Les ids de la collection, lus par scroll PAGINÉ jusqu'à `next_page_offset` absent.
    func pointIds(in collection: String) async throws -> [QdrantPointID]
    func points(ids: [QdrantPointID], in collection: String) async throws -> [QdrantPoint]
    /// L'upsert `?wait=true` : écrase un id existant, donc l'union n'y met que des absents.
    func upsert(_ points: [QdrantPoint], into collection: String) async throws
}

/// L'implémentation REST (Qdrant v1.19.0).
struct HTTPMemoryBase: MemoryBase {
    let endpoint: QdrantEndpoint
    let session: URLSession

    init(endpoint: QdrantEndpoint, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.session = session
    }

    func collectionNames() async throws -> [String] {
        struct Response: Decodable {
            struct Result: Decodable {
                struct Collection: Decodable { let name: String }
                let collections: [Collection]
            }
            let result: Result
        }
        let response: Response = try await send(
            method: "GET",
            path: ["collections"],
            body: nil,
            as: Response.self
        )
        return response.result.collections.map(\.name)
    }

    func pointIds(in collection: String) async throws -> [QdrantPointID] {
        struct Request: Encodable {
            var limit: Int
            var offset: QdrantPointID?
            var with_payload: Bool
            var with_vector: Bool
        }
        struct Response: Decodable {
            struct Result: Decodable {
                struct Point: Decodable { let id: QdrantPointID }
                let points: [Point]
                let next_page_offset: QdrantPointID?
            }
            let result: Result
        }

        var ids: [QdrantPointID] = []
        var offset: QdrantPointID?
        while true {
            let request = Request(
                limit: MemoryUnion.pageSize,
                offset: offset,
                with_payload: false,
                with_vector: false
            )
            let body = try JSONEncoder().encode(request)
            let response: Response = try await send(
                method: "POST",
                path: ["collections", collection, "points", "scroll"],
                body: body,
                as: Response.self
            )
            ids.append(contentsOf: response.result.points.map(\.id))
            guard let next = response.result.next_page_offset else { break }
            offset = next
        }
        return ids
    }

    func points(ids: [QdrantPointID], in collection: String) async throws -> [QdrantPoint] {
        struct Request: Encodable {
            let ids: [QdrantPointID]
            let with_payload: Bool
            let with_vector: Bool
        }
        struct Response: Decodable {
            struct Record: Decodable {
                let id: QdrantPointID
                let vector: AnyJSON?
                let payload: AnyJSON?
            }
            let result: [Record]
        }
        let request = Request(ids: ids, with_payload: true, with_vector: true)
        let body = try JSONEncoder().encode(request)
        let response: Response = try await send(
            method: "POST",
            path: ["collections", collection, "points"],
            body: body,
            as: Response.self
        )
        return response.result.map { QdrantPoint(id: $0.id, vector: $0.vector ?? .null, payload: $0.payload) }
    }

    func upsert(_ points: [QdrantPoint], into collection: String) async throws {
        struct Request: Encodable {
            struct Point: Encodable {
                let id: QdrantPointID
                let vector: AnyJSON
                let payload: AnyJSON?
            }
            let points: [Point]
        }
        let request = Request(points: points.map { Request.Point(id: $0.id, vector: $0.vector, payload: $0.payload) })
        let body = try JSONEncoder().encode(request)
        _ = try await send(
            method: "PUT",
            path: ["collections", collection, "points"],
            query: [URLQueryItem(name: "wait", value: "true")],
            body: body
        )
    }

    // MARK: - Le transport REST

    private func send(
        method: String,
        path: [String],
        query: [URLQueryItem] = [],
        body: Data?
    ) async throws {
        let request = try makeRequest(method: method, path: path, query: query, body: body)
        let (data, response) = try await data(for: request)
        try validate(data: data, response: response)
    }

    private func send<Response: Decodable>(
        method: String,
        path: [String],
        query: [URLQueryItem] = [],
        body: Data?,
        as type: Response.Type
    ) async throws -> Response {
        let request = try makeRequest(method: method, path: path, query: query, body: body)
        let (data, response) = try await data(for: request)
        try validate(data: data, response: response)
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw MemoryBaseError(status: 0, body: "réponse illisible : \(error.localizedDescription)")
        }
    }

    private func makeRequest(
        method: String,
        path: [String],
        query: [URLQueryItem],
        body: Data?
    ) throws -> URLRequest {
        var url = endpoint.baseURL
        for component in path {
            url.appendPathComponent(component)
        }
        if !query.isEmpty, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.queryItems = query
            url = components.url ?? url
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(endpoint.apiKey, forHTTPHeaderField: "api-key")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw MemoryBaseError(status: 0, body: "réponse non HTTP")
            }
            return (data, http)
        } catch let error as MemoryBaseError {
            throw error
        } catch {
            throw MemoryBaseError(status: 0, body: error.localizedDescription)
        }
    }

    private func validate(data: Data, response: HTTPURLResponse) throws {
        guard (200..<300).contains(response.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw MemoryBaseError(status: response.statusCode, body: body)
        }
    }
}

/// L'union des souvenirs, invariants de l'algorithme ci-dessus.
enum MemoryUnion {
    static let memoryCollection = "omp_memory"
    /// Taille de page du scroll (S-8).
    static let pageSize = 500
    /// Taille d'un lot retrieve/upsert (S-8).
    static let batchSize = 64

    /// Le corps borné d'un refus (`<code> <corps borné>`, S-8).
    static func incompleteReason(for error: any Error, limit: Int = 300) -> String {
        if let failure = error as? MemoryBaseError {
            let body = failure.body.trimmingCharacters(in: .whitespacesAndNewlines)
            let bounded = body.count <= limit ? body : String(body.prefix(limit))
            return "\(failure.status) \(bounded)".trimmingCharacters(in: .whitespaces)
        }
        let text = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.count <= limit ? text : String(text.prefix(limit))
    }

    /// Le diff figé : ids de la source absents de la cible, par lots ≤ `batchSize`.
    static func run(
        source: any MemoryBase,
        target: any MemoryBase,
        collection: String = memoryCollection
    ) async -> MemoryUnionOutcome {
        do {
            // La cible d'abord : sans la collection, il n'y a rien à rejoindre (base
            // neuve jamais servie — c'est la copie disque de la migration qui amorce).
            let targetNames = try await target.collectionNames()
            guard targetNames.contains(collection) else { return .nothingToDo }

            // Source sans la collection (`collections/` vide) : rien à unir.
            let sourceNames = try await source.collectionNames()
            guard sourceNames.contains(collection) else { return .nothingToDo }

            let sourceIds = try await source.pointIds(in: collection)
            let targetIds = Set(try await target.pointIds(in: collection))
            let missing = sourceIds.filter { !targetIds.contains($0) }
            guard !missing.isEmpty else { return .nothingCopied(source: "", fingerprint: "") }

            var copied = 0
            for batch in batches(of: missing, size: batchSize) {
                do {
                    let points = try await source.points(ids: batch, in: collection)
                    try await target.upsert(points, into: collection)
                    copied += points.count
                } catch {
                    // Un lot refusé : `.incomplete` avec le DÉJÀ copié, et AUCUN lot
                    // suivant (rien de déjà recopié n'est renvoyé).
                    return .incomplete(copied: copied, reason: incompleteReason(for: error))
                }
            }
            return .caughtUp(copied: copied, source: "", fingerprint: "")
        } catch {
            return .incomplete(copied: 0, reason: incompleteReason(for: error))
        }
    }

    /// Découpe une suite en lots d'au plus `size` éléments, dans l'ordre reçu.
    static func batches(of ids: [QdrantPointID], size: Int) -> [[QdrantPointID]] {
        guard size > 0 else { return ids.isEmpty ? [] : [ids] }
        var result: [[QdrantPointID]] = []
        var index = 0
        while index < ids.count {
            let end = Swift.min(index + size, ids.count)
            result.append(Array(ids[index..<end]))
            index = end
        }
        return result
    }
}

/// L'issue d'une passe d'union (S-8).
enum MemoryUnionOutcome: Equatable, Sendable {
    /// Pas de base source (ou collection absente).
    case nothingToDo
    case nothingCopied(source: String, fingerprint: String)
    case caughtUp(copied: Int, source: String, fingerprint: String)
    /// La préparation continue : la pile est saine, la trace n'est pas enregistrée.
    case incomplete(copied: Int, reason: String)
}
