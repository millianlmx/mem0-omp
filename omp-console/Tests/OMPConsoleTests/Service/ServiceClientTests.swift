// Preuves du client HTTP du service (BR-6, S-2, S-10) : codes, jeton, corps
// décodés, erreurs typées et localisation de `service.json`.
//
// Aucun réseau : le transport scripté rend les réponses décidées.

import Foundation
import Testing
@testable import OMPConsole

// MARK: - ServiceLocator

private let validToken = String(repeating: "a", count: 32)

private func writeService(_ object: [String: Any], in directory: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    try data.write(to: directory.appendingPathComponent("service.json"))
}

private func tempStateDir() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("omp-service-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

@Test("coque-service : un service.json absent rend ServiceUnavailable « service arrêté »")
func locatorMissingFileIsUnavailable() throws {
    let dir = try tempStateDir()
    #expect(throws: ServiceUnavailable.stopped) {
        _ = try ServiceLocator.locate(stateDir: dir.path, alive: { _ in true })
    }
    #expect(ServiceUnavailable.stopped.userMessage == "service arrêté")
}

@Test("coque-service : un pid mort dans service.json rend le service indisponible")
func locatorStalePidIsUnavailable() throws {
    let dir = try tempStateDir()
    try writeService([
        "version": 1, "pid": 4242, "port": 8788, "token": validToken,
        "startedAt": 1, "stateDir": dir.path, "sessionFile": NSNull(),
    ], in: dir)
    #expect(ServiceLocator.endpoint(stateDir: dir.path, alive: { _ in false }) == nil)
    #expect(throws: ServiceUnavailable.stopped) {
        _ = try ServiceLocator.locate(stateDir: dir.path, alive: { _ in false })
    }
}

@Test("coque-service : un enregistrement valide expose baseURL et jeton")
func locatorReadsEndpoint() throws {
    let dir = try tempStateDir()
    try writeService([
        "version": 1, "pid": 4242, "port": 9123, "token": validToken,
        "startedAt": 1, "stateDir": dir.path, "sessionFile": "/tmp/s.jsonl",
    ], in: dir)
    let endpoint = try ServiceLocator.locate(stateDir: dir.path, alive: { $0 == 4242 })
    #expect(endpoint.baseURL.absoluteString == "http://127.0.0.1:9123/v1")
    #expect(endpoint.token == validToken)
    #expect(endpoint.pid == 4242)
}

// MARK: - ServiceClient

@MainActor
@Test("coque-service : GET /v1/health décode la charge utile et porte le jeton")
func clientHealthDecodesAndCarriesToken() async throws {
    let transport = ScriptedServiceTransport()
    transport.stubJSON("GET", "/v1/health", ["version": 1, "pid": 99, "startedAt": 1, "sessions": 2, "lots": 1])
    let client = scriptedClient(transport)
    let pid = try await client.health()
    #expect(pid == 99)
    #expect(transport.requests.first?.token == client.endpoint.token)
    #expect(transport.requests.first?.method == "GET")
}

@MainActor
@Test("coque-service : un 401 devient .unauthorized")
func clientMapsUnauthorized() async throws {
    let transport = ScriptedServiceTransport()
    transport.stubStatus("GET", "/v1/health", status: 401, json: ["error": "unauthorized"])
    await #expect(throws: ServiceClientError.unauthorized) {
        _ = try await scriptedClient(transport).health()
    }
}

@MainActor
@Test("coque-service : un 404 devient .notFound avec le motif du service")
func clientMapsNotFound() async throws {
    let transport = ScriptedServiceTransport()
    transport.stubStatus("GET", "/v1/sessions/x", status: 404, json: ["error": "not_found", "reason": "session inconnue : x"])
    await #expect(throws: ServiceClientError.notFound(reason: "session inconnue : x")) {
        _ = try await scriptedClient(transport).session(id: "x")
    }
}

@MainActor
@Test("coque-service : un 409 de conduite devient .conflict avec le texte exact")
func clientMapsConflict() async throws {
    let transport = ScriptedServiceTransport()
    let reason = "ce dépôt n'a pas de distant GitHub"
    transport.stubStatus("POST", "/conduite", status: 409, json: ["error": "conflict", "reason": reason])
    await #expect(throws: ServiceClientError.conflict(reason: reason)) {
        _ = try await scriptedClient(transport).startConduite(repo: "/tmp/repo", name: "x")
    }
}

@MainActor
@Test("coque-service : POST /commands envoie le corps et décode l'accusé")
func clientPostsCommandAndDecodesAck() async throws {
    let transport = ScriptedServiceTransport()
    transport.stubJSON("POST", "/commands", ["ack": [
        "version": 1, "id": "console-1-abcd", "repo": "/tmp/repo", "kind": "stop",
        "state": "refused", "reason": "lot illisible", "at": 12,
    ]])
    let client = scriptedClient(transport)
    let ack = try await client.command(repo: "/tmp/repo", body: [
        "version": 1, "id": "console-1-abcd", "sentAt": 1, "repo": "/tmp/repo", "kind": "stop",
    ])
    #expect(ack.state == .refused)
    #expect(ack.reason == "lot illisible")
    #expect(ack.kind == "stop")
    let sent = transport.requests.first?.body
    #expect(sent?["kind"] as? String == "stop")
    #expect(sent?["repo"] as? String == "/tmp/repo")
}

@MainActor
@Test("coque-service : POST /v1/sessions porte cwd, purpose et le CHEMIN de reprise")
func clientCreatesSession() async throws {
    let transport = ScriptedServiceTransport()
    transport.stubJSON("POST", "/v1/sessions", [
        "id": "sess-1", "cwd": "/tmp/repo", "purpose": "session", "state": "idle",
        "sessionFile": "/tmp/s.jsonl",
    ])
    let client = scriptedClient(transport)
    let info = try await client.createSession(cwd: "/tmp/repo", resume: "/tmp/s.jsonl", purpose: "session")
    #expect(info.id == "sess-1")
    #expect(info.sessionFile == "/tmp/s.jsonl")
    let body = transport.requests.first?.body
    #expect(body?["cwd"] as? String == "/tmp/repo")
    #expect(body?["purpose"] as? String == "session")
    // Le service n'accepte qu'un CHEMIN (« chemin de fichier de session attendu »,
    // 400 pour tout autre type) : un booléen ne part JAMAIS (S-6).
    #expect(body?["resume"] as? String == "/tmp/s.jsonl")

    // Une ouverture NEUVE n'envoie pas le champ : le service la lit comme « pas de
    // reprise ».
    _ = try await client.createSession(cwd: "/tmp/repo", purpose: "project")
    let fresh = transport.requests.last?.body
    #expect(fresh?["resume"] == nil)
    #expect(fresh?["purpose"] as? String == "project")
}

@MainActor
@Test("coque-service : GET /v1/sessions liste les sessions servies")
func clientListsSessions() async throws {
    let transport = ScriptedServiceTransport()
    transport.stubJSON("GET", "/v1/sessions", ["sessions": [
        ["id": "s1", "cwd": "/tmp/repo", "purpose": "project", "state": "running", "sessionFile": "/tmp/p.jsonl"],
        ["id": "s2", "cwd": "/tmp/repo", "purpose": "session", "state": "idle", "sessionFile": NSNull()],
    ]])
    let sessions = try await scriptedClient(transport).sessions()
    #expect(sessions.count == 2)
    #expect(sessions.first?.id == "s1")
    #expect(sessions.first?.purpose == "project")
    #expect(sessions.first?.sessionFile == "/tmp/p.jsonl")
    #expect(sessions.last?.sessionFile == nil)
    #expect(transport.requests.first?.method == "GET")
    #expect(transport.requests.first?.path.hasSuffix("/v1/sessions") == true)
}

@MainActor
@Test("coque-service : une connexion refusée devient .unavailable (« service arrêté »)")
func clientMapsUnavailable() async throws {
    let transport = ScriptedServiceTransport()
    transport.failRequests(ServiceClientError.unavailable)
    await #expect(throws: ServiceClientError.unavailable) {
        _ = try await scriptedClient(transport).health()
    }
    #expect(ServiceClientError.unavailable.userMessage == "service arrêté")
}

@MainActor
@Test("coque-service : un 503 devient .stopping")
func clientMapsStopping() async throws {
    let transport = ScriptedServiceTransport()
    transport.stubStatus("GET", "/v1/health", status: 503, json: ["error": "stopping"])
    await #expect(throws: ServiceClientError.stopping) {
        _ = try await scriptedClient(transport).health()
    }
}
