// L'union des souvenirs (S-8, BR-5 ; AC-9), figée par DOUBLURES en mémoire : le
// diff exact, le découpage en lots, le refus de lot, la cible sans collection, la
// préservation verbatim — et, pour `HTTPMemoryBase`, le transport REST réel
// (`with_vector` au SINGULIER, pagination par `next_page_offset`) sans socket.
//
// La suite s'appelle `MemoryUnionTests` : c'est ce nom que `swift test --filter`
// sélectionne (le filtre porte sur l'identifiant du test, pas sur son titre).

import Foundation
import Testing

@testable import OMPConsole

/// Une base mémoire scriptée : ids, points et lots d'upsert observés.
final class ScriptedMemoryBase: MemoryBase, @unchecked Sendable {
    var collections: [String]
    var ids: [QdrantPointID]
    var pointsByID: [QdrantPointID: QdrantPoint]
    /// Refuse l'upsert à partir de ce rang (0 = le premier). `nil` = jamais.
    var refuseUpsertFrom: Int?
    var upsertError = MemoryBaseError(status: 400, body: "Bad Request")
    private(set) var upserts: [[QdrantPoint]] = []

    init(
        collections: [String] = [MemoryUnion.memoryCollection],
        ids: [QdrantPointID] = [],
        points: [QdrantPoint] = []
    ) {
        self.collections = collections
        self.ids = ids
        self.pointsByID = Dictionary(uniqueKeysWithValues: points.map { ($0.id, $0) })
    }

    func collectionNames() async throws -> [String] { collections }

    func pointIds(in collection: String) async throws -> [QdrantPointID] { ids }

    func points(ids: [QdrantPointID], in collection: String) async throws -> [QdrantPoint] {
        ids.compactMap { pointsByID[$0] }
    }

    func upsert(_ points: [QdrantPoint], into collection: String) async throws {
        if let refuseUpsertFrom, upserts.count >= refuseUpsertFrom {
            throw upsertError
        }
        upserts.append(points)
    }
}

/// Un `URLProtocol` piloté par une closure, avec la même lecture de corps que
/// `StubURLProtocol` (le corps arrive en FLUX).
final class UnionURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, Data)?)?
    nonisolated(unsafe) static var captured: [URLRequest] = []
    private static let lock = NSLock()

    static func reset() {
        lock.lock(); handler = nil; captured = []; lock.unlock()
    }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UnionURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var request = request
        if let stream = request.httpBodyStream {
            request.httpBody = Self.drain(stream)
        }
        Self.lock.lock()
        Self.captured.append(request)
        let handler = Self.handler
        Self.lock.unlock()

        guard let (status, body) = handler?(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// Un compteur d'appels partageable entre le test et la closure de la doublure.
final class UnionCallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func next() -> Int {
        lock.lock(); defer { lock.unlock() }
        let current = value
        value += 1
        return current
    }
}

private func unionPoint(_ id: QdrantPointID, _ vector: AnyJSON = .array([.number(0.1)]), payload: AnyJSON? = nil) -> QdrantPoint {
    QdrantPoint(id: id, vector: vector, payload: payload)
}

private func unionEndpoint(_ port: Int) -> QdrantEndpoint {
    QdrantEndpoint(baseURL: URL(string: "http://127.0.0.1:\(port)")!, apiKey: "key")
}

struct MemoryUnionTests {
    @Test("bug-embedded-podman-machine/AC-9 : la cible {B, D} reçoit EXACTEMENT [A, C] de la source {A, B, C}")
    func unionCopiesOnlyMissingIDs() async {
        let a = unionPoint(.number(10)), b = unionPoint(.number(20)), c = unionPoint(.number(30)), d = unionPoint(.number(40))
        let source = ScriptedMemoryBase(ids: [.number(10), .number(20), .number(30)], points: [a, b, c])
        let target = ScriptedMemoryBase(ids: [.number(20), .number(40)], points: [b, d])

        let outcome = await MemoryUnion.run(source: source, target: target)

        #expect(outcome == .caughtUp(copied: 2, source: "", fingerprint: ""))
        #expect(target.upserts.flatMap { $0 }.map(\.id) == [.number(10), .number(30)])
    }

    @Test("bug-embedded-podman-machine/AC-9 : aucun lot d'upsert ne dépasse batchSize et tous les ids manquants passent")
    func unionBatchesMissingIDs() async {
        let ids = (0..<200).map { QdrantPointID.number(UInt64($0)) }
        let source = ScriptedMemoryBase(ids: ids, points: ids.map { unionPoint($0) })
        let target = ScriptedMemoryBase(ids: [], points: [])

        let outcome = await MemoryUnion.run(source: source, target: target)

        #expect(outcome == .caughtUp(copied: 200, source: "", fingerprint: ""))
        #expect(target.upserts.allSatisfy { $0.count <= MemoryUnion.batchSize })
        #expect(target.upserts.flatMap { $0 }.count == 200)
    }

    @Test("bug-embedded-podman-machine/AC-9 : un lot refusé rend .incomplete avec le déjà copié, et rien de plus n'est envoyé")
    func unionStopsOnRefusedBatch() async {
        let ids = (0..<200).map { QdrantPointID.number(UInt64($0)) }
        let source = ScriptedMemoryBase(ids: ids, points: ids.map { unionPoint($0) })
        let target = ScriptedMemoryBase(ids: [], points: [])
        target.refuseUpsertFrom = 1
        target.upsertError = MemoryBaseError(status: 400, body: "Bad Request: refused")

        let outcome = await MemoryUnion.run(source: source, target: target)

        #expect(outcome == .incomplete(copied: 64, reason: "400 Bad Request: refused"))
        #expect(target.upserts.count == 1)
    }

    @Test("bug-embedded-podman-machine/AC-9 : une cible sans la collection omp_memory rend .nothingToDo")
    func unionNothingToDoWithoutTargetCollection() async {
        let source = ScriptedMemoryBase(ids: [.number(1)], points: [unionPoint(.number(1))])
        let target = ScriptedMemoryBase(collections: [], ids: [], points: [])

        let outcome = await MemoryUnion.run(source: source, target: target)

        #expect(outcome == .nothingToDo)
        #expect(target.upserts.isEmpty)
    }

    @Test("bug-embedded-podman-machine/AC-9 : une cible déjà à jour rend .nothingCopied et n'envoie rien")
    func unionNothingCopiedWhenUpToDate() async {
        let ids: [QdrantPointID] = [.number(1), .number(2)]
        let source = ScriptedMemoryBase(ids: ids, points: ids.map { unionPoint($0) })
        let target = ScriptedMemoryBase(ids: ids, points: ids.map { unionPoint($0) })

        let outcome = await MemoryUnion.run(source: source, target: target)

        #expect(outcome == .nothingCopied(source: "", fingerprint: ""))
        #expect(target.upserts.isEmpty)
    }

    @Test("bug-embedded-podman-machine/AC-9 : le scroll pagine par next_page_offset jusqu'à son absence")
    func httpScrollPaginates() async throws {
        UnionURLProtocol.reset()
        let counter = UnionCallCounter()
        let page1 = Data(#"{"result":{"points":[{"id":1},{"id":2}],"next_page_offset":2}}"#.utf8)
        let page2 = Data(#"{"result":{"points":[{"id":3}],"next_page_offset":null}}"#.utf8)
        UnionURLProtocol.handler = { _ in
            counter.next() == 0 ? (200, page1) : (200, page2)
        }
        let base = HTTPMemoryBase(endpoint: unionEndpoint(6333), session: UnionURLProtocol.session())

        let ids = try await base.pointIds(in: MemoryUnion.memoryCollection)

        #expect(ids == [.number(1), .number(2), .number(3)])
        // La seconde requête porte l'offset (la forme JSON du next_page_offset).
        let second = UnionURLProtocol.captured[1]
        let body = String(data: second.httpBody ?? Data(), encoding: .utf8) ?? ""
        #expect(body.contains("\"offset\":2"))
    }

    @Test("bug-embedded-podman-machine/AC-9 : la lecture des points porte with_vector au SINGULIER et recopie le vecteur verbatim")
    func httpRetrieveUsesSingularWithVector() async throws {
        UnionURLProtocol.reset()
        let named = Data(#"{"result":[{"id":1,"vector":{"": [0.5, 0.25], "bm25": {"indices":[1],"values":[2]}},"payload":{"k":"v"}},{"id":2,"vector":[0.1,0.2],"payload":null}]}"#.utf8)
        UnionURLProtocol.handler = { _ in (200, named) }
        let base = HTTPMemoryBase(endpoint: unionEndpoint(6333), session: UnionURLProtocol.session())

        let points = try await base.points(ids: [.number(1), .number(2)], in: MemoryUnion.memoryCollection)

        let request = UnionURLProtocol.captured[0]
        let body = String(data: request.httpBody ?? Data(), encoding: .utf8) ?? ""
        #expect(body.contains("\"with_vector\""))
        #expect(!body.contains("\"with_vectors\""))
        // Vecteur nommé préservé tel quel.
        #expect(points[0].vector == .object([
            "": .array([.number(0.5), .number(0.25)]),
            "bm25": .object(["indices": .array([.number(1)]), "values": .array([.number(2)])]),
        ]))
        // Vecteur en liste nue préservé tel quel.
        #expect(points[1].vector == .array([.number(0.1), .number(0.2)]))
        #expect(points[1].payload == nil)
    }

    @Test("bug-embedded-podman-machine/AC-9 : l'upsert part en PUT ?wait=true avec le point verbatim")
    func httpUpsertIsWaitTrueAndVerbatim() async throws {
        UnionURLProtocol.reset()
        UnionURLProtocol.handler = { _ in (200, Data(#"{"result":{"status":"completed"}}"#.utf8)) }
        let base = HTTPMemoryBase(endpoint: unionEndpoint(6333), session: UnionURLProtocol.session())
        let vector = AnyJSON.object(["": .array([.number(0.5)])])
        let point = QdrantPoint(id: .string("uuid-1"), vector: vector, payload: .object(["k": .string("v")]))

        try await base.upsert([point], into: MemoryUnion.memoryCollection)

        let request = UnionURLProtocol.captured[0]
        #expect(request.httpMethod == "PUT")
        #expect(request.url?.query?.contains("wait=true") == true)
        #expect(request.value(forHTTPHeaderField: "api-key") == "key")
        let body = String(data: request.httpBody ?? Data(), encoding: .utf8) ?? ""
        #expect(body.contains("\"id\":\"uuid-1\""))
        #expect(body.contains("\"points\""))
    }

    @Test("bug-embedded-podman-machine/AC-9 : un refus HTTP devient un MemoryBaseError porteur du code et du corps")
    func httpRefusalCarriesCode() async {
        UnionURLProtocol.reset()
        UnionURLProtocol.handler = { _ in (400, Data(#"{"status":{"error":"boom"}}"#.utf8)) }
        let base = HTTPMemoryBase(endpoint: unionEndpoint(6333), session: UnionURLProtocol.session())

        await #expect(throws: MemoryBaseError(status: 400, body: #"{"status":{"error":"boom"}}"#)) {
            _ = try await base.collectionNames()
        }
    }
}
