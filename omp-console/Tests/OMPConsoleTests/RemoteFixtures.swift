// Le harnais des tests de l'API distante : une pile RÉELLE — vrai `RemoteServer`
// sur un port éphémère, vrai routeur, vrai registre sur un fichier jetable,
// doublure de trousseau et doublure mémoire — plus un client HTTP minimal.
//
// Aucun test ne touche le vrai trousseau : tout vit sous `NSTemporaryDirectory()`.

import Combine
import ConsoleCore
import Foundation
@testable import OMPConsole

/// Une horloge que le test fait avancer (expiration du code d'appairage).
final class MutableRemoteClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double

    init(_ start: Double = 1_700_000_000_000) {
        value = start
    }

    var nowMs: Double {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func advance(ms: Double) {
        lock.lock()
        value += ms
        lock.unlock()
    }

    var clock: RemoteClock {
        RemoteClock { [weak self] in self?.nowMs ?? 0 }
    }
}

/// La réponse d'un appel HTTP au serveur réel.
struct RemoteReply {
    let status: Int
    let headers: [String: String]
    let body: Data

    var text: String { String(decoding: body, as: UTF8.self) }

    func json<T: Decodable>(_ type: T.Type) throws -> T {
        try HTTPJSON.decoder.decode(type, from: body)
    }

    /// Le code d'erreur du contrat, quand la réponse en porte un.
    var errorCode: String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let error = object["error"] as? [String: Any] else { return nil }
        return error["code"] as? String
    }

    var errorMessage: String? {
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let error = object["error"] as? [String: Any] else { return nil }
        return error["message"] as? String
    }
}

/// La pile complète, prête à interroger.
@MainActor
struct RemoteStack {
    let supportRoot: URL
    let clock: MutableRemoteClock
    let registry: DeviceRegistry
    let tokens: InMemoryDeviceTokenStore
    let memory: ScriptedMemoryService
    let streams: RemoteStreamHub
    let router: RemoteRouter
    let server: RemoteServer
    let port: UInt16

    var base: String { "http://127.0.0.1:\(port)" }

    /// `liveMemory` remplace le service scripté AUPRÈS DES ROUTES (banc de recette
    /// sur la vraie mémoire, `memoryDelayServe`) ; `memoryConfig` remplace l'adresse
    /// fictive. Nuls ⇒ routes servies par `memory`.
    static func make(
        memory: ScriptedMemoryService = ScriptedMemoryService(),
        liveMemory: (any MemoryServing)? = nil,
        memoryConfig: MemoryServiceConfig? = nil,
        clock: MutableRemoteClock = MutableRemoteClock(),
        components: @escaping @MainActor () -> RemoteComponentsPayload = {
            RemoteComponentsPayload(ompInstalled: true, ompPath: nil, setupBanner: nil)
        },
        componentsChanges: AnyPublisher<Void, Never> = Empty<Void, Never>(completeImmediately: false).eraseToAnyPublisher()
    ) async throws -> RemoteStack {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("omp-console-remote-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let tokens = InMemoryDeviceTokenStore()
        let registry = DeviceRegistry(
            file: root.appendingPathComponent("remote/devices.json"),
            store: tokens,
            clock: clock.clock
        )
        await registry.load()
        let streams = RemoteStreamHub(
            registry: registry,
            clock: clock.clock,
            components: components,
            componentsChanges: componentsChanges
        )
        // Le câblage de PRODUCTION (`RemoteServiceModel`) : le registre publie
        // l'évènement `devices` par le flux. Sans lui, l'ordre RÉEL des trames
        // d'ouverture resterait invisible aux tests (S-13).
        registry.changeHandler = { [weak streams] in streams?.broadcastDevices() }
        let config = memoryConfig ?? MemoryServiceConfig(baseURL: URL(string: "http://127.0.0.1:8321")!, token: "")
        let reads = RemoteReads(
            registry: registry,
            service: liveMemory ?? memory,
            memoryConfig: config,
            memoryLinks: root.appendingPathComponent("memory-links.json"),
            environment: [:],
            clock: clock.clock,
            components: components
        )
        let router = RemoteRouter(reads: reads, registry: registry, streams: streams)
        let server = RemoteServer(handler: { request, connection in
            await router.handle(request, connection: connection)
        })
        try await server.start(port: 0)
        let port = server.port ?? 0

        return RemoteStack(
            supportRoot: root,
            clock: clock,
            registry: registry,
            tokens: tokens,
            memory: memory,
            streams: streams,
            router: router,
            server: server,
            port: port
        )
    }

    func stop() {
        server.stop()
        streams.closeAll()
        try? FileManager.default.removeItem(at: supportRoot)
    }

    // MARK: - Client

    func request(
        _ method: String,
        _ path: String,
        token: String? = nil,
        body: Data? = nil,
        json: [String: Any]? = nil,
        headers: [String: String] = [:],
        protocolVersion: Int? = ConsoleAPI.protocolVersion,
        omitProtocolHeader: Bool = false
    ) -> URLRequest {
        var request = URLRequest(url: URL(string: base + path)!)
        request.httpMethod = method
        if let protocolVersion, !omitProtocolHeader {
            request.setValue(String(protocolVersion), forHTTPHeaderField: ConsoleAPI.Service.protocolHeader)
        }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if let json { request.httpBody = try? JSONSerialization.data(withJSONObject: json) }
        if let body { request.httpBody = body }
        return request
    }

    func call(
        _ method: String,
        _ path: String,
        token: String? = nil,
        json: [String: Any]? = nil,
        body: Data? = nil,
        headers: [String: String] = [:],
        protocolVersion: Int? = ConsoleAPI.protocolVersion,
        omitProtocolHeader: Bool = false
    ) async throws -> RemoteReply {
        let request = request(
            method,
            path,
            token: token,
            body: body,
            json: json,
            headers: headers,
            protocolVersion: protocolVersion,
            omitProtocolHeader: omitProtocolHeader
        )
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        var normalized: [String: String] = [:]
        for (key, value) in http?.allHeaderFields ?? [:] {
            if let key = key as? String, let value = value as? String { normalized[key.lowercased()] = value }
        }
        return RemoteReply(status: http?.statusCode ?? 0, headers: normalized, body: data)
    }

    /// Le code affiché par la coque, puis l'appairage HTTP — le chemin complet.
    @discardableResult
    func pair(name: String = "Téléphone") async throws -> String {
        let code = try registry.generateCode().value
        let reply = try await call("POST", "/v1/pair", json: [
            "code": code,
            "name": name,
            "protocolVersion": ConsoleAPI.protocolVersion,
        ])
        guard reply.status == 200 else { throw ConsoleAPIError.server("appairage refusé (\(reply.status))") }
        let payload = try reply.json(RemotePairPayload.self)
        return payload.token
    }
}

/// L'encodeur des corps de requête des tests.
func jsonBody(_ object: [String: Any]) -> Data {
    (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
}
