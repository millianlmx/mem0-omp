// Preuves des routes PR de l'API distante (S-12 / AC-14) : lecture des PR suivies
// et fusion demandée puis confirmée.
//
// La pile est RÉELLE (serveur, routeur, registre d'appareils) ; seule la couche
// `gh` est doublée par `RecordingPRService`. Aucun test ne touche le vrai magasin
// ni le vrai trousseau : tout vit sous `NSTemporaryDirectory()`.

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

// MARK: - Constantes

/// Une adresse CONFORME (`https://github.com/<owner>/<repo>/pull/n`, cf.
/// `PRServiceTests`) mais FICTIVE : son nom de dépôt est neutre, jamais celui de
/// CE dépôt. `test/docs.test.ts` exige que `PUBLISHING.md` cite exactement les
/// fichiers porteurs de la marque d'URL du dépôt ; une fixture de test n'a rien à
/// y faire, et le handle de PUBLISHING.md ne doit pas être substitué ici.
private let prURL = "https://github.com/proprietaire/depot/pull/45"
/// Une adresse SUIVIE mais invalide pour `gh` (hôte étranger) : la route de fusion
/// doit la refuser en 404, jamais en 500 (S-12).
private let invalidPRURL = "https://exemple.test/pull/45"
private let prSlug = "premiere"
/// Un sha40 minuscule : c'est la valeur que `isSHA` accepte.
private let currentHead = "0123456789abcdef0123456789abcdef01234567"
private let staleHead = "ffffffffffffffffffffffffffffffffffffffff"

// MARK: - Doublure de `PRServicing`

/// Rend toujours le même instantané et journalise lectures et fusions.
final class RecordingPRService: PRServicing, @unchecked Sendable {
    struct MergeCall: Equatable, Sendable {
        let prUrl: String
        let title: String
        let body: String
        let headOid: String
    }

    private let lock = NSLock()
    private let result: Result<PRSnapshot, GhError>
    private var _readURLs: [String] = []
    private var _merges: [MergeCall] = []

    init(_ snapshot: PRSnapshot) {
        result = .success(snapshot)
    }

    init(_ error: GhError) {
        result = .failure(error)
    }

    func read(prUrl: String, in directory: String) async throws -> PRSnapshot {
        try withLock {
            _readURLs.append(prUrl)
            return try result.get()
        }
    }

    func merge(prUrl: String, title: String, body: String, headOid: String, in directory: String) async throws {
        withLock {
            _merges.append(MergeCall(prUrl: prUrl, title: title, body: body, headOid: headOid))
        }
    }

    var readURLs: [String] { withLock { _readURLs } }
    var merges: [MergeCall] { withLock { _merges } }

    private func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}

// MARK: - Outillage

/// Un instantané dont les trois statuts requis prennent les états donnés, dans
/// l'ordre de S-1.
private func snapshot(states: [PRCheckState], headOid: String) -> PRSnapshot {
    let checks = RequiredCheck.allCases.enumerated().map { index, required in
        PRCheckReading(name: required.name, state: states[index], link: nil)
    }
    return PRSnapshot(title: "Ma PR", headOid: headOid, body: "Le corps de la PR", checks: checks)
}

/// Écrit `projects/<key>.json` dans un magasin jetable et rend la racine.
private func stateDir(withProjectKey key: String, repoRoot: String, slug: String, url: String) throws -> String {
    let root = try makeProjectStateDir()
    let object = projectObject(
        repoKey: key,
        repoRoot: repoRoot,
        segments: [["name": "Lire le réel", "features": [projectFeatureObject(slug: slug, status: "pr", prUrl: url)]]],
        current: 0,
        hostSession: NSNull()
    )
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    let file = ((root as NSString).appendingPathComponent("projects") as NSString)
        .appendingPathComponent("\(key).json")
    try data.write(to: URL(fileURLWithPath: file))
    return root
}

/// Monte un modèle avec une conduite VIVE sur un dépôt git jetable, dont le projet
/// publié suit une PR. Le service de PR est injecté : aucun `gh` n'est lancé.
@MainActor
private func makeLiveModel(service: RecordingPRService, url: String = prURL) async throws -> (model: ProjectConsoleModel, repoKey: String, stateDir: String) {
    let repo = try makeGitRepository()
    let key = ProjectPaths.key(forRoot: repo.path)
    let root = try stateDir(withProjectKey: key, repoRoot: repo.path, slug: prSlug, url: url)

    let transport = ScriptedRpcTransport()
    transport.readyLine = projectReadyLine()
    wireProjectAutoResponses(transport)
    makeProjectTransportRenderOnClose(transport)
    let host = makeScriptedProjectHost(transport)
    let model = makeProjectModel(
        host: host,
        stateDir: root,
        prService: service,
        urlOpener: RecordingURLOpener(),
        environment: [:]
    )
    model.start()
    await model.startConduite(repoRoot: repo, name: "PR")
    _ = await awaitProject { model.project?.repoKey == key }
    return (model, key, root)
}

/// Monte un modèle SANS conduite : le projet est publié, mais l'identité reste
/// `nil` — le cas « aucun projet conduit ».
@MainActor
private func makeIdleStack(stateDir root: String) async throws -> (stack: RemoteStack, model: ProjectConsoleModel) {
    let transport = ScriptedRpcTransport()
    let host = makeScriptedProjectHost(transport)
    let model = makeProjectModel(host: host, stateDir: root, environment: [:])
    let stack = try await RemoteStack.make(stateDir: root, projectModel: model)
    return (stack, model)
}

/// La MÊME pile que `RemoteStack.make`, mais avec un `environment` choisi pour
/// `RemoteActions` (le harnais fige le sien à `[:]`) : sert à prouver la route
/// `gh` absent. Réutilise `RemoteStack` par son initialiseur mémber.
@MainActor
private func makeStack(
    project: ProjectConsoleModel,
    stateDir root: String,
    environment: [String: String]
) async throws -> RemoteStack {
    let support = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("omp-console-remote-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    let clock = MutableRemoteClock()
    let hub = StoreHub(stateDir: root, nowMs: { clock.nowMs })
    let tokens = InMemoryDeviceTokenStore()
    let registry = DeviceRegistry(
        file: support.appendingPathComponent("remote/devices.json"),
        store: tokens,
        clock: clock.clock
    )
    await registry.load()
    let stats = StatsModel(stateDir: root)
    let kanban = KanbanModel(hub: hub)
    let actions = ActionsModel()
    let session = SessionConsoleModel()
    let memory = ScriptedMemoryService()
    let streams = RemoteStreamHub(storeHub: hub, registry: registry, session: session, clock: clock.clock)
    let config = MemoryServiceConfig(baseURL: URL(string: "http://127.0.0.1:8321")!, token: "")
    let reads = RemoteReads(
        hub: hub,
        registry: registry,
        stats: stats,
        service: memory,
        memoryConfig: config,
        memoryLinks: support.appendingPathComponent("memory-links.json"),
        environment: environment,
        clock: clock.clock
    )
    let remoteActions = RemoteActions(
        kanban: kanban,
        actions: actions,
        session: session,
        project: project,
        hub: hub,
        environment: environment,
        clock: clock.clock
    )
    let router = RemoteRouter(reads: reads, registry: registry, actions: remoteActions, streams: streams)
    let server = RemoteServer(handler: { request, connection in
        await router.handle(request, connection: connection)
    })
    try await server.start(port: 0)
    return RemoteStack(
        supportRoot: support,
        stateDir: root,
        clock: clock,
        storeHub: hub,
        registry: registry,
        tokens: tokens,
        stats: stats,
        memory: memory,
        kanban: kanban,
        actions: actions,
        session: session,
        project: project,
        streams: streams,
        router: router,
        server: server,
        port: server.port ?? 0
    )
}

// MARK: - AC-14 (canonique)

@MainActor
@Test("api-distante-du-console/AC-14 : la fusion demandée puis confirmée est exécutée dans la coque")
func mergeRequestedThenConfirmed() async throws {
    let service = RecordingPRService(snapshot(states: [.green, .green, .green], headOid: currentHead))
    let setup = try await makeLiveModel(service: service)
    let stack = try await RemoteStack.make(stateDir: setup.stateDir, projectModel: setup.model)
    defer {
        setup.model.stop()
        stack.stop()
    }
    let token = try await stack.pair()

    // La lecture des PR suivies : l'état réel du projet conduit.
    let listed = try await stack.call("GET", "/v1/projects/\(setup.repoKey)/pull-requests", token: token)
    #expect(listed.status == 200)
    let payload = try listed.json(RemotePullRequestsPayload.self)
    #expect(payload.failure == nil)
    #expect(payload.stale == false)
    #expect(payload.rows.map(\.slug) == [prSlug])
    let row = try #require(payload.rows.first)
    #expect(row.number == 45)
    #expect(row.freshness == .fresh)
    #expect(row.checks.map(\.state) == [.green, .green, .green])
    #expect(service.readURLs.allSatisfy { $0 == prURL })

    // La fusion demandée avec le sha COURANT : exécutée une seule fois.
    let merged = try await stack.call(
        "POST",
        "/v1/projects/\(setup.repoKey)/pull-requests/\(prSlug)/merge",
        token: token,
        json: ["headOid": currentHead]
    )
    #expect(merged.status == 200)
    let mergedPayload = try merged.json(RemoteMergedPayload.self)
    #expect(mergedPayload.merged == true)
    #expect(mergedPayload.number == 45)
    #expect(mergedPayload.url == prURL)
    #expect(service.merges.count == 1)
    #expect(service.merges.first?.headOid == currentHead)
    #expect(service.merges.first?.prUrl == prURL)

    // Un sha PÉRIMÉ : conflit, et aucune fusion supplémentaire.
    let conflict = try await stack.call(
        "POST",
        "/v1/projects/\(setup.repoKey)/pull-requests/\(prSlug)/merge",
        token: token,
        json: ["headOid": staleHead]
    )
    #expect(conflict.status == 409)
    #expect(conflict.errorCode == "conflict")
    #expect(service.merges.count == 1)
}

// MARK: - Cas complémentaires

@MainActor
@Test func testNoConduiteIsConflict() async throws {
    let key = "0123456789abcdef"
    let root = try stateDir(withProjectKey: key, repoRoot: "/tmp/omp-absent", slug: prSlug, url: prURL)
    let (stack, model) = try await makeIdleStack(stateDir: root)
    defer {
        model.stop()
        stack.stop()
    }
    let token = try await stack.pair()

    let reply = try await stack.call("GET", "/v1/projects/\(key)/pull-requests", token: token)
    #expect(reply.status == 409)
    #expect(reply.errorCode == "conflict")
}

@MainActor
@Test func testUnknownRepoKeyIsNotFound() async throws {
    let root = try makeProjectStateDir()
    let (stack, model) = try await makeIdleStack(stateDir: root)
    defer {
        model.stop()
        stack.stop()
    }
    let token = try await stack.pair()

    let reply = try await stack.call("GET", "/v1/projects/deadbeefdeadbeef/pull-requests", token: token)
    #expect(reply.status == 404)
    #expect(reply.errorCode == "not_found")
}

@MainActor
@Test func testUnknownSlugIsNotFound() async throws {
    let service = RecordingPRService(snapshot(states: [.green, .green, .green], headOid: currentHead))
    let setup = try await makeLiveModel(service: service)
    let stack = try await RemoteStack.make(stateDir: setup.stateDir, projectModel: setup.model)
    defer {
        setup.model.stop()
        stack.stop()
    }
    let token = try await stack.pair()

    let reply = try await stack.call(
        "POST",
        "/v1/projects/\(setup.repoKey)/pull-requests/absente/merge",
        token: token,
        json: ["headOid": currentHead]
    )
    #expect(reply.status == 404)
    #expect(reply.errorCode == "not_found")
    #expect(service.merges.isEmpty)
}

@MainActor
@Test func testGhMissingIsUnavailable() async throws {
    let service = RecordingPRService(snapshot(states: [.green, .green, .green], headOid: currentHead))
    let setup = try await makeLiveModel(service: service)
    // Un `gh` introuvable : l'override est le SEUL candidat, et il n'existe pas.
    let stack = try await makeStack(
        project: setup.model,
        stateDir: setup.stateDir,
        environment: ["OMP_CONSOLE_GH_BINARY": "/nonexistent/omp-console-gh"]
    )
    defer {
        setup.model.stop()
        stack.stop()
    }
    let token = try await stack.pair()

    // La PR est bien suivie (la lecture ne dépend pas de `gh`).
    let listed = try await stack.call("GET", "/v1/projects/\(setup.repoKey)/pull-requests", token: token)
    #expect(listed.status == 200)

    let reply = try await stack.call(
        "POST",
        "/v1/projects/\(setup.repoKey)/pull-requests/\(prSlug)/merge",
        token: token,
        json: ["headOid": currentHead]
    )
    #expect(reply.status == 503)
    #expect(reply.status != 500)
    #expect(reply.errorCode == "unavailable")
    #expect(service.merges.isEmpty)
}

@MainActor
@Test func testMalformedHeadOidIsBadRequest() async throws {
    let service = RecordingPRService(snapshot(states: [.green, .green, .green], headOid: currentHead))
    let setup = try await makeLiveModel(service: service)
    let stack = try await RemoteStack.make(stateDir: setup.stateDir, projectModel: setup.model)
    defer {
        setup.model.stop()
        stack.stop()
    }
    let token = try await stack.pair()

    for head in ["abc", String(repeating: "A", count: 40), String(repeating: "z", count: 40)] {
        let reply = try await stack.call(
            "POST",
            "/v1/projects/\(setup.repoKey)/pull-requests/\(prSlug)/merge",
            token: token,
            json: ["headOid": head]
        )
        #expect(reply.status == 400)
        #expect(reply.errorCode == "bad_request")
    }
    #expect(service.merges.isEmpty)
}

/// Une URL de PR invalide (hôte étranger) est refusée en 404, jamais en 500 (S-12).
@MainActor
@Test func testInvalidPRURLIsNotFound() async throws {
    let service = RecordingPRService(snapshot(states: [.green, .green, .green], headOid: currentHead))
    let setup = try await makeLiveModel(service: service, url: invalidPRURL)
    let stack = try await RemoteStack.make(stateDir: setup.stateDir, projectModel: setup.model)
    defer {
        setup.model.stop()
        stack.stop()
    }
    let token = try await stack.pair()

    // La PR est SUIVIE (l'URL non vide suffit), mais l'adresse est invalide.
    let listed = try await stack.call("GET", "/v1/projects/\(setup.repoKey)/pull-requests", token: token)
    #expect(listed.status == 200)
    #expect(try listed.json(RemotePullRequestsPayload.self).rows.map(\.slug) == [prSlug])

    let reply = try await stack.call(
        "POST",
        "/v1/projects/\(setup.repoKey)/pull-requests/\(prSlug)/merge",
        token: token,
        json: ["headOid": currentHead]
    )
    #expect(reply.status == 404, "404 attendu, obtenu \(reply.status) \(reply.text)")
    #expect(reply.errorCode == "not_found")
    #expect(service.merges.isEmpty)
}

@MainActor
@Test func testMergeRefusedWhenChecksAreNotGreen() async throws {
    let service = RecordingPRService(snapshot(states: [.red, .green, .green], headOid: currentHead))
    let setup = try await makeLiveModel(service: service)
    let stack = try await RemoteStack.make(stateDir: setup.stateDir, projectModel: setup.model)
    defer {
        setup.model.stop()
        stack.stop()
    }
    let token = try await stack.pair()

    // La PR est suivie, mais un statut requis n'est pas vert.
    let listed = try await stack.call("GET", "/v1/projects/\(setup.repoKey)/pull-requests", token: token)
    #expect(listed.status == 200)
    let payload = try listed.json(RemotePullRequestsPayload.self)
    #expect(try #require(payload.rows.first).isMergeAvailable == false)

    let reply = try await stack.call(
        "POST",
        "/v1/projects/\(setup.repoKey)/pull-requests/\(prSlug)/merge",
        token: token,
        json: ["headOid": currentHead]
    )
    #expect(reply.status == 409)
    #expect(reply.errorCode == "conflict")
    #expect(setup.model.pendingMerge == nil)
    #expect(service.merges.isEmpty)
}
