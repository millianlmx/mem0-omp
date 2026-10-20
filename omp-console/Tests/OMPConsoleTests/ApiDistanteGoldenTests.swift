// La PREUVE DE PARITÉ de l'API distante (orchestrator-living-in-a-vps, AC-12) : le Mac
// (cette pile Swift) rejoue la liste ordonnée `test/fixtures/api-distante/requests.json`
// sur une copie de la fixture `state/` + `repos/` + `worktrees/` + `sessions/` + `bin/`,
// normalise les réponses et les compare à `test/fixtures/api-distante/golden/`. Le
// serveur TypeScript du VPS rejoue les MÊMES requêtes dans
// `test/req/api-distante-parite.test.ts` et se compare aux MÊMES golden : le Mac est la
// source de vérité (`MEM0_OMP_WRITE_GOLDEN=1` réécrit les golden depuis ce test).
//
// FORMAT de `requests.json` et NORMALISATION : documentés en tête de
// `test/req/api-distante-parite.test.ts` (les deux tests appliquent exactement les
// mêmes règles : gabarits `$ROOT`, `$KEY(rel)`, `$ENC(…)`, normalisations `$ROOT`,
// `$KEY(rel)`, `$MACHINE`, `$MEM0`, `$UUID`, `$CMDID`, `$SALT`).
//
// HERMÉTIQUE : la copie vit sous `NSTemporaryDirectory()`, l'horloge est figée à
// 1 700 000 000 000 ms, aucun pid de la fixture n'est vivant, la mémoire est un mem0
// factice HTTP (un `RemoteServer` qui sert `mem0/`), le service du poste est une table
// de règles (`service.json`) et `gh`/`omp` sont les doublures de `bin/` — jamais le
// magasin `~/.omp/agent/pipeline` ni un binaire du poste.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

// MARK: - La fixture partagée et sa copie

/// Le dossier `test/fixtures/api-distante` du dépôt, déduit de l'emplacement de ce fichier.
private let sharedFixture: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // OMPConsoleTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // omp-console
    .deletingLastPathComponent()  // racine du dépôt
    .appendingPathComponent("test/fixtures/api-distante", isDirectory: true)

/// La copie jetable de la fixture, et les gabarits / normalisations qui en dépendent.
private struct GoldenFixture {
    /// Le `realpath` de la racine de la copie : toute chaîne la contenant est normalisée en `$ROOT`.
    let root: String
    /// Le dossier jetable qui contient la racine : c'est lui qu'on supprime en fin de test.
    let cleanup: String
    /// `repos/alpha` → repoKey (sha1 du realpath, 16 premiers hexadécimaux).
    let keys: [String: String]
    /// Le port du mem0 factice, une fois démarré : `http://127.0.0.1:<port>` → `$MEM0`.
    var mem0Origin: String?

    static let copiedDirectories = ["state", "repos", "worktrees", "sessions", "bin"]
    /// Les dépôts SANS `.git` (le marqueur git est créé à la copie : git refuse d'indexer un `.git` imbriqué).
    static let withoutGit: Set<String> = ["plain"]

    /// Les dépôts dont l'ORDRE doit être celui des noms : les repoKey dérivent du chemin de la copie (donc
    /// varient d'un run à l'autre) et plusieurs listes du magasin sont triées par repoKey. La racine est donc
    /// choisie, parmi `r0`, `r1`…, la première dont les clés suivent l'ordre alphabétique des dépôts —
    /// le TypeScript applique la MÊME règle, pour que les deux ordres de tri coïncident toujours.
    static let orderedRepos = ["alpha", "beta", "gamma"]

    init() throws {
        let fileManager = FileManager.default
        let container = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("api-distante-golden-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: container, withIntermediateDirectories: true)
        let realContainer = realpathOr(container.path)
        cleanup = container.path
        var chosen: String?
        for attempt in 0..<1000 {
            let candidate = "\(realContainer)/r\(attempt)"
            let candidateKeys = Self.orderedRepos.map { KanbanRepoKey.key(forRoot: "\(candidate)/repos/\($0)") }
            if candidateKeys == candidateKeys.sorted() { chosen = candidate; break }
        }
        guard let chosen else { throw CocoaError(.fileWriteUnknown) }
        root = chosen
        let base = URL(fileURLWithPath: chosen, isDirectory: true)
        try fileManager.createDirectory(at: base, withIntermediateDirectories: true)
        for name in Self.copiedDirectories {
            try fileManager.copyItem(at: sharedFixture.appendingPathComponent(name), to: base.appendingPathComponent(name))
        }
        let repos = base.appendingPathComponent("repos", isDirectory: true)
        var computed: [String: String] = [:]
        for name in try fileManager.contentsOfDirectory(atPath: repos.path).sorted() {
            let directory = repos.appendingPathComponent(name, isDirectory: true)
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: directory.path, isDirectory: &isDirectory), isDirectory.boolValue else { continue }
            if !Self.withoutGit.contains(name) {
                let git = directory.appendingPathComponent(".git", isDirectory: true)
                try fileManager.createDirectory(at: git, withIntermediateDirectories: true)
                try Data("ref: refs/heads/main\n".utf8).write(to: git.appendingPathComponent("HEAD"))
            }
            computed["repos/\(name)"] = KanbanRepoKey.key(forRoot: directory.path)
        }
        keys = computed
        try substituteTree(at: base)
    }

    /// Gabarits de FICHIERS : `$ROOT` et `$KEY(rel)` dans les contenus (hors `bin/`), `$KEY(a+b)` dans
    /// les noms (`+` tient lieu de `/`).
    private func substituteTree(at base: URL) throws {
        let fileManager = FileManager.default
        var paths: [String] = []
        if let walker = fileManager.enumerator(atPath: base.path) {
            for case let relative as String in walker { paths.append(relative) }
        }
        for relative in paths where !relative.hasPrefix("bin") {
            let url = base.appendingPathComponent(relative)
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue,
                  let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            let resolved = template(text)
            if resolved != text { try resolved.write(to: url, atomically: true, encoding: .utf8) }
        }
        // Les noms, du plus profond au plus haut : renommer un parent invaliderait les chemins des enfants.
        for relative in paths.sorted(by: { $0.split(separator: "/").count > $1.split(separator: "/").count }) where relative.contains("$KEY(") {
            let url = base.appendingPathComponent(relative)
            let renamed = url.deletingLastPathComponent().appendingPathComponent(template(url.lastPathComponent, plusIsSlash: true))
            if renamed != url { try fileManager.moveItem(at: url, to: renamed) }
        }
    }

    /// `$KEY(rel)` puis `$ROOT`.
    func template(_ text: String, plusIsSlash: Bool = false) -> String {
        var out = text
        for (relative, key) in keys {
            out = out.replacingOccurrences(of: "$KEY(\(plusIsSlash ? relative.replacingOccurrences(of: "/", with: "+") : relative))", with: key)
        }
        return out.replacingOccurrences(of: "$ROOT", with: root)
    }

    /// Gabarits de REQUÊTES : `template`, puis `$ENC(x)` = encodage pourcent de tout sauf `A-Za-z0-9-._~`.
    func resolve(_ text: String) -> String {
        var out = template(text)
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        while let open = out.range(of: "$ENC("), let close = out[open.upperBound...].firstIndex(of: ")") {
            let inner = String(out[open.upperBound..<close])
            let encoded = inner.addingPercentEncoding(withAllowedCharacters: unreserved) ?? inner
            out.replaceSubrange(open.lowerBound...close, with: encoded)
        }
        return out
    }

    func resolveJSON(_ value: Any) -> Any {
        switch value {
        case let text as String: return resolve(text)
        case let list as [Any]: return list.map(resolveJSON)
        case let object as [String: Any]: return object.mapValues(resolveJSON)
        default: return value
        }
    }

    // MARK: Normalisation des réponses

    private static let machineKeys: Set<String> = ["machine", "homeDirectory", "ompPath"]

    func normalize(_ value: Any) -> Any {
        switch value {
        case let object as [String: Any]:
            var out: [String: Any] = [:]
            for (key, inner) in object {
                out[key] = Self.machineKeys.contains(key) ? "$MACHINE" : normalize(inner)
            }
            return out
        case let list as [Any]:
            return list.map(normalize)
        case let text as String:
            return normalize(text: text)
        default:
            return value
        }
    }

    func normalize(text: String) -> String {
        var out = text
        for (relative, key) in keys { out = out.replacingOccurrences(of: key, with: "$KEY(\(relative))") }
        out = out.replacingOccurrences(of: root, with: "$ROOT")
        if let mem0Origin { out = out.replacingOccurrences(of: mem0Origin, with: "$MEM0") }
        out = Self.replace(#"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"#, in: out) { _ in "$UUID" }
        out = Self.replace(#"^([a-z]+-\d+|\d{16})-[0-9a-f]{4}$"#, in: out) { _ in "$CMDID" }
        out = Self.replace(#"(\d{16})-[0-9a-f]{4}(-\d+)?\.json"#, in: out) { groups in "\(groups[1])-$SALT\(groups[2]).json" }
        return out
    }

    /// Remplace chaque occurrence de `pattern` par ce que rend `transform` (groupes de capture : 0 = tout, puis 1…).
    private static func replace(_ pattern: String, in text: String, transform: ([String]) -> String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let source = text as NSString
        var out = ""
        var cursor = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            out += source.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            let groups = (0..<match.numberOfRanges).map { index -> String in
                let range = match.range(at: index)
                return range.location == NSNotFound ? "" : source.substring(with: range)
            }
            out += transform(groups)
            cursor = match.range.location + match.range.length
        }
        return out + source.substring(from: cursor)
    }
}

// MARK: - Le service du poste, scripté par `service.json`

/// Un `ServiceTransport` piloté par la table de règles de `service.json` : la MÊME table que rejoue
/// le `ServiceApi` scripté du test TypeScript. Première règle gagnante ; `*` = un segment.
private final class ParityServiceTransport: ServiceTransport, @unchecked Sendable {
    private struct Rule {
        let method: String
        let pattern: NSRegularExpression
        let when: [String: Any]
        let status: Int
        let json: Any
        /// Les trames poussées sur le flux OUVERT d'une session à la réception de la requête.
        let emit: (stream: String, frames: [(event: String, data: [String: Any])])?
    }

    private struct EventStream {
        let path: String
        let pattern: NSRegularExpression
        let frames: [(event: String, data: [String: Any])]
    }

    struct Call {
        let method: String
        let path: String
        let body: [String: Any]?
    }

    private let rules: [Rule]
    private let streams: [EventStream]
    private let lock = NSLock()
    private var calls: [Call] = []
    /// Le flux ouvert de chaque session (par motif de chemin) et les trames émises avant son ouverture.
    private var live: [String: AsyncThrowingStream<String, Error>.Continuation] = [:]
    private var pending: [String: [String]] = [:]

    init(table: [String: Any]) throws {
        var rules: [Rule] = []
        var streams: [EventStream] = []
        for entry in table["rules"] as? [[String: Any]] ?? [] {
            if let path = entry["stream"] as? String {
                streams.append(EventStream(path: path, pattern: try Self.regex(path), frames: Self.frames(entry["frames"])))
            } else {
                var emit: (stream: String, frames: [(event: String, data: [String: Any])])?
                if let spec = entry["emit"] as? [String: Any], let stream = spec["stream"] as? String {
                    emit = (stream, Self.frames(spec["frames"]))
                }
                rules.append(Rule(
                    method: (entry["method"] as? String ?? "GET").uppercased(),
                    pattern: try Self.regex(entry["path"] as? String ?? ""),
                    when: entry["when"] as? [String: Any] ?? [:],
                    status: entry["status"] as? Int ?? 200,
                    json: entry["json"] ?? [String: Any](),
                    emit: emit
                ))
            }
        }
        self.rules = rules
        self.streams = streams
    }

    private static func frames(_ raw: Any?) -> [(event: String, data: [String: Any])] {
        (raw as? [[String: Any]] ?? []).map { (event: $0["event"] as? String ?? "", data: $0["data"] as? [String: Any] ?? [:]) }
    }

    private static func regex(_ path: String) throws -> NSRegularExpression {
        let escaped = NSRegularExpression.escapedPattern(for: path).replacingOccurrences(of: "\\*", with: "[^/]+")
        return try NSRegularExpression(pattern: "^\(escaped)$")
    }

    /// Les appels qui MODIFIENT le service (POST/DELETE) : ce qu'une route distante lui a réellement demandé.
    var mutatingCalls: [Call] { lock.withLock { calls } }

    func send(_ request: URLRequest) async throws -> ServiceHTTPResponse {
        let method = (request.httpMethod ?? "GET").uppercased()
        let encodedPath = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath } ?? ""
        let body = request.httpBody.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
        if method != "GET" {
            let decoded = encodedPath.removingPercentEncoding ?? encodedPath
            lock.withLock { calls.append(Call(method: method, path: decoded, body: body)) }
        }
        let range = NSRange(encodedPath.startIndex..., in: encodedPath)
        for rule in rules where rule.method == method && rule.pattern.firstMatch(in: encodedPath, range: range) != nil {
            let matches = rule.when.allSatisfy { key, expected in
                guard let actual = body?[key] else { return false }
                return (actual as AnyObject).isEqual(expected)
            }
            if !matches { continue }
            if let emit = rule.emit { push(emit.frames, to: emit.stream) }
            let payload = try JSONSerialization.data(withJSONObject: rule.json, options: [.sortedKeys, .fragmentsAllowed])
            return ServiceHTTPResponse(status: rule.status, body: payload)
        }
        return ServiceHTTPResponse(status: 404, body: Data(#"{"error":"not_found","reason":"route non scriptée"}"#.utf8))
    }

    /// Pousse des trames sur le flux ouvert de `streamPath` ; fermé encore, elles attendent son ouverture.
    private func push(_ frames: [(event: String, data: [String: Any])], to streamPath: String) {
        let lines = frames.flatMap { serviceFrame($0.event, $0.data) }
        lock.withLock {
            if let continuation = live[streamPath] {
                for line in lines { continuation.yield(line) }
            } else {
                pending[streamPath, default: []].append(contentsOf: lines)
            }
        }
    }

    func lines(_ request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        let path = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath } ?? ""
        let range = NSRange(path.startIndex..., in: path)
        guard let stream = streams.first(where: { $0.pattern.firstMatch(in: path, range: range) != nil }) else {
            throw ServiceClientError.unavailable
        }
        let streamPath = stream.path
        let opening = stream.frames.flatMap { serviceFrame($0.event, $0.data) }
        return AsyncThrowingStream { continuation in
            for line in opening { continuation.yield(line) }
            lock.withLock {
                for line in pending.removeValue(forKey: streamPath) ?? [] { continuation.yield(line) }
                live[streamPath] = continuation
            }
            // Le flux reste OUVERT : la session reste vivante sans reconnexion.
            let hold = Task {
                try? await Task.sleep(for: .seconds(3_600))
                continuation.finish()
            }
            continuation.onTermination = { [weak self] _ in
                hold.cancel()
                self?.lock.withLock { _ = self?.live.removeValue(forKey: streamPath) }
            }
        }
    }
}

// MARK: - Le mem0 factice (un RemoteServer qui sert `mem0/`)

@MainActor
private final class FakeMem0 {
    private var server: RemoteServer?
    private let routes: [String: Any]
    private var graphCursor = 0
    private(set) var origin = ""

    init() throws {
        let data = try Data(contentsOf: sharedFixture.appendingPathComponent("mem0/routes.json"))
        routes = (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    func start() async throws {
        let server = RemoteServer(handler: { [weak self] request, connection in
            guard let self else { return .respond(Self.text(500, "arrêté")) }
            return .respond(self.answer(request, connection: connection))
        })
        try await server.start(port: 0)
        self.server = server
        origin = "http://127.0.0.1:\(server.port ?? 0)"
    }

    func stop() { server?.stop() }

    private static func text(_ code: Int, _ body: String) -> HTTPResponse {
        HTTPResponse(code: code, reason: HTTPStatus.reason(code), contentType: "text/plain; charset=utf-8", body: Data(body.utf8))
    }

    private func file(_ name: String) -> HTTPResponse {
        guard let data = try? Data(contentsOf: sharedFixture.appendingPathComponent("mem0/\(name)")) else {
            return Self.text(500, "fixture mem0 absente : \(name)")
        }
        return .json(code: 200, payload: data)
    }

    /// `{file}` | `{status, text}` | `{drop: true}`.
    private func reply(_ entry: [String: Any]?, connection: RemoteConnectionHandle) -> HTTPResponse {
        guard let entry else { return Self.text(404, "Not Found") }
        if entry["drop"] as? Bool == true {
            connection.close()
            return Self.text(500, "connexion coupée")
        }
        if let name = entry["file"] as? String { return file(name) }
        return Self.text(entry["status"] as? Int ?? 500, entry["text"] as? String ?? "")
    }

    private func answer(_ request: HTTPRequest, connection: RemoteConnectionHandle) -> HTTPResponse {
        let expected = routes["token"] as? String ?? ""
        if !expected.isEmpty, request.headers.value("X-Mem0-Token") != expected { return Self.text(401, "jeton refusé") }
        switch (request.method, request.path) {
        case ("GET", "/memory/all"):
            let all = routes["all"] as? [String: Any] ?? [:]
            return reply(all[request.query["agent_id"] ?? ""] as? [String: Any], connection: connection)
        case ("POST", "/memory/search"):
            let body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any]
            let search = routes["search"] as? [String: Any] ?? [:]
            return reply(search[body?["query"] as? String ?? ""] as? [String: Any], connection: connection)
        case ("GET", "/memory/graph"):
            let sequence = routes["graph"] as? [[String: Any]] ?? []
            let entry = sequence.isEmpty ? nil : sequence[min(graphCursor, sequence.count - 1)]
            graphCursor += 1
            return reply(entry, connection: connection)
        default:
            return Self.text(404, "Not Found")
        }
    }
}

// MARK: - Les requêtes

private struct GoldenRequest {
    let n: Int
    let name: String
    let method: String
    let path: String
    let body: Any?
    let rawBody: String?
    let headers: [String: String]
    /// `nil` = le jeton de l'appareil appairé ; `"none"` = aucun ; `"unknown"` = un jeton inconnu.
    let token: String?
    /// `"omit"` = sans en-tête de version ; un entier = cette version.
    let protocolValue: Any?
    let before: [[String: Any]]
    let golden: Bool
    let expect: [String: Any]?
    let stream: Bool
    /// Une condition asynchrone du Mac à attendre AVANT d'envoyer (le TypeScript, synchrone, l'ignore).
    let awaiting: String?

    init(_ object: [String: Any]) {
        n = object["n"] as? Int ?? 0
        name = object["name"] as? String ?? ""
        method = (object["method"] as? String ?? "GET").uppercased()
        path = object["path"] as? String ?? ""
        body = object["body"]
        rawBody = object["rawBody"] as? String
        headers = object["headers"] as? [String: String] ?? [:]
        token = object["token"] as? String
        protocolValue = object["protocol"]
        before = object["before"] as? [[String: Any]] ?? []
        golden = object["golden"] as? Bool ?? true
        expect = object["expect"] as? [String: Any]
        stream = object["stream"] as? Bool ?? false
        awaiting = object["await"] as? String
    }

    var goldenFile: String { String(format: "%03d-%@.json", n, name) }
}

private func canonical(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .prettyPrinted, .fragmentsAllowed]) else {
        return "\(value)"
    }
    return String(decoding: data, as: UTF8.self)
}

/// Les lignes qui diffèrent, `-` attendu / `+` obtenu : un diff lisible par requête.
private func lineDiff(expected: String, actual: String) -> String {
    let left = expected.split(separator: "\n", omittingEmptySubsequences: false)
    let right = actual.split(separator: "\n", omittingEmptySubsequences: false)
    var out: [String] = []
    for index in 0..<max(left.count, right.count) {
        let a = index < left.count ? String(left[index]) : nil
        let b = index < right.count ? String(right[index]) : nil
        if a == b { continue }
        if let a { out.append("- \(a)") }
        if let b { out.append("+ \(b)") }
        if out.count >= 40 { out.append("… (diff tronqué)"); break }
    }
    return out.joined(separator: "\n")
}

private func parseBody(_ data: Data) -> Any {
    if data.isEmpty { return NSNull() }
    if let json = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) { return json }
    return String(decoding: data, as: UTF8.self)
}

// MARK: - Le test

/// La suite porte le nom du fichier : `swift test --filter ApiDistanteGoldenTests` la lance.
@MainActor
struct ApiDistanteGoldenTests {
@Test("orchestrator-living-in-a-vps/AC-12 : les 44 routes du Mac rejouées sur la fixture partagée rendent exactement les golden")
func remoteApiParityGoldenReplay() async throws {
    let writing = ProcessInfo.processInfo.environment["MEM0_OMP_WRITE_GOLDEN"] == "1"
    let fixture = try GoldenFixture()
    defer { try? FileManager.default.removeItem(atPath: fixture.cleanup) }
    let stateDir = fixture.root + "/state"

    // --- l'environnement injecté et le binaire `omp` du catalogue de modèles (process-global : restauré en fin de test)
    let environment = [
        "PATH": fixture.root + "/bin",
        "HOME": fixture.root,
        "OMP_CONSOLE_GH_BINARY": fixture.root + "/bin/gh",
    ]

    // --- le mem0 factice
    let mem0 = try FakeMem0()
    try await mem0.start()
    defer { mem0.stop() }
    var fixtureWithOrigin = fixture
    fixtureWithOrigin.mem0Origin = mem0.origin
    let golden = fixtureWithOrigin
    let memoryConfig = MemoryServiceConfig(baseURL: URL(string: mem0.origin)!, token: "jeton-mem0")

    // --- le service scripté, commun à tous les modèles
    let serviceData = try Data(contentsOf: sharedFixture.appendingPathComponent("service.json"))
    let table = golden.resolveJSON(try JSONSerialization.jsonObject(with: serviceData)) as? [String: Any] ?? [:]
    let transport = try ParityServiceTransport(table: table)
    let client: @Sendable () -> ServiceClient = { projectServiceClient(transport) }

    let frozen = StoreClock { 1_700_000_000_000 }
    let actions = ActionsModel(
        writer: PipelineWriter(
            stateDir: stateDir,
            fileOps: .live,
            post: { repo, body in try await client().command(repo: repo, body: body) },
            pilot: { repo in try await client().pilot(repo: repo) }
        ),
        clock: frozen,
        salt: { "0000" },
        modelCatalogLoader: { .success(ModelCatalogListing(selectors: [], names: [:])) }
    )
    let suite = { UserDefaults(suiteName: "api-distante-golden-\(UUID().uuidString)") ?? .standard }
    let session = SessionConsoleModel(
        host: ServiceSessionModel(
            purpose: "session",
            makeClient: { client() },
            maxAttempts: 5,
            retryDelay: { _ in projectRetryDelay }
        ),
        defaults: suite()
    )
    let project = makeProjectModel(
        host: makeProjectHost(purpose: "project", makeClient: { client() }),
        stateDir: stateDir,
        environment: environment
    )
    let audit = AuditConsoleModel(
        stateDir: stateDir,
        snapshots: { AsyncStream { $0.finish() } },
        makeClient: { client() },
        defaults: suite()
    )
    let components = RemoteComponentsPayload(
        ompInstalled: true,
        ompPath: golden.root + "/bin/omp",
        setupBanner: nil,
        homeDirectory: golden.root
    )

    let stack = try await RemoteStack.make(
        liveMemory: HTTPMemoryService(config: memoryConfig),
        memoryConfig: memoryConfig,
        stateDir: stateDir,
        clock: MutableRemoteClock(1_700_000_000_000),
        projectModel: project,
        actionsModel: actions,
        sessionModel: session,
        auditModel: audit,
        components: { components },
        journal: { actions.journal },
        prStates: KanbanModel.ghBook(environment: environment),
        environment: environment,
        memoryLinks: URL(fileURLWithPath: stateDir + "/remote/memory-links.json")
    )
    defer { stack.stop() }
    project.start()
    stack.kanban.start()
    let ready = await awaitMainTrue(timeout: 20) {
        (stack.kanban.state.kanbanBoard?.cards.count ?? 0) >= 19
            && !stack.kanban.pullRequestStatesPayload().refreshing
            && stack.kanban.pullRequestStatesPayload().facts.count == 4
    }
    let cardCount = stack.kanban.state.kanbanBoard?.cards.count ?? 0
    let factCount = stack.kanban.pullRequestStatesPayload().facts.count
    try #require(ready, "le tableau doit publier ses cartes et les faits de PR (cartes : \(cardCount), faits de PR : \(factCount))")
    let token = try await stack.pair(name: "Téléphone")

    // --- la liste ordonnée des requêtes
    let requestsData = try Data(contentsOf: sharedFixture.appendingPathComponent("requests.json"))
    let requests = ((try JSONSerialization.jsonObject(with: requestsData)) as? [[String: Any]] ?? []).map(GoldenRequest.init)
    #expect(!requests.isEmpty, "requests.json ne doit pas être vide")
    let goldenDirectory = sharedFixture.appendingPathComponent("golden", isDirectory: true)
    if writing { try FileManager.default.createDirectory(at: goldenDirectory, withIntermediateDirectories: true) }

    var written: [String] = []
    for request in requests {
        try applyBefore(request.before, fixture: golden)
        if let condition = request.awaiting {
            let settled = await awaitMainTrue(timeout: 10) {
                switch condition {
                case "hostedDialog": session.host.dialogQueue.count == 1
                case "hostedNoDialog": session.host.dialogQueue.isEmpty
                case "hostedRunning": session.host.state == .running
                case "conduiteDialog": project.host.dialogQueue.count == 1
                case "conduiteLive": project.state == .live
                case "conduiteRows": project.prRows.count >= 2
                default: false
                }
            }
            #expect(settled, "#\(request.n) \(request.name) : condition « \(condition) » jamais atteinte")
        }
        let path = golden.resolve(request.path)
        let outcome: [String: Any]
        if request.stream {
            outcome = try await captureStream(stack: stack, token: token, path: path, fixture: golden)
        } else {
            // `ModelCatalogLoader` lit l'environnement du PROCESSUS : l'override n'existe que le temps du catalogue,
            // pour ne pas gêner un test voisin qui lit lui aussi `OMP_CONSOLE_OMP_BINARY`.
            let overridesOmp = path.hasPrefix("/v1/models")
            let previousOmp = getenv("OMP_CONSOLE_OMP_BINARY").map { String(cString: $0) }
            if overridesOmp { setenv("OMP_CONSOLE_OMP_BINARY", golden.root + "/bin/omp", 1) }
            let reply = try await send(request, path: path, stack: stack, token: token, fixture: golden)
            if overridesOmp {
                if let previousOmp { setenv("OMP_CONSOLE_OMP_BINARY", previousOmp, 1) } else { unsetenv("OMP_CONSOLE_OMP_BINARY") }
            }
            outcome = ["status": reply.status, "body": golden.normalize(parseBody(reply.body))]
        }
        if let expectation = request.expect {
            #expect(outcome["status"] as? Int == expectation["status"] as? Int, "#\(request.n) \(request.name) : statut")
            if let code = expectation["code"] as? String {
                let body = outcome["body"] as? [String: Any]
                let error = body?["error"] as? [String: Any]
                #expect(error?["code"] as? String == code, "#\(request.n) \(request.name) : code d'erreur")
            }
        }
        guard request.golden else { continue }
        let url = goldenDirectory.appendingPathComponent(request.goldenFile)
        if writing {
            try (canonical(outcome) + "\n").write(to: url, atomically: true, encoding: .utf8)
            written.append(request.goldenFile)
        } else {
            let expected = try? Data(contentsOf: url)
            #expect(expected != nil, "#\(request.n) \(request.name) : golden absent (\(request.goldenFile)) — relancer avec MEM0_OMP_WRITE_GOLDEN=1")
            guard let expected, let parsed = try? JSONSerialization.jsonObject(with: expected, options: [.fragmentsAllowed]) else { continue }
            let want = canonical(parsed), have = canonical(outcome)
            #expect(want == have, "#\(request.n) \(request.name) \(request.method) \(path)\n\(lineDiff(expected: want, actual: have))")
        }
    }

    // --- les effets : commandes postées au contrôleur, audits demandés au service, livraisons écrites dans l'inbox
    let effects = effectsOutcome(transport: transport, stateDir: stateDir, fixture: golden)
    let effectsURL = goldenDirectory.appendingPathComponent("effects.json")
    if writing {
        try (canonical(effects) + "\n").write(to: effectsURL, atomically: true, encoding: .utf8)
    } else if let expected = try? Data(contentsOf: effectsURL),
              let parsed = try? JSONSerialization.jsonObject(with: expected, options: [.fragmentsAllowed]) {
        let want = canonical(parsed), have = canonical(effects)
        #expect(want == have, "effets (commandes, audits, inbox)\n\(lineDiff(expected: want, actual: have))")
    } else {
        Issue.record("golden des effets absent (effects.json) — relancer avec MEM0_OMP_WRITE_GOLDEN=1")
    }
    if writing {
        // Un golden orphelin (requête supprimée ou rendue non déterministe) est retiré : le dossier dit exactement ce qui est comparé.
        let keep = Set(written + ["effects.json"])
        for name in (try? FileManager.default.contentsOfDirectory(atPath: goldenDirectory.path)) ?? [] where !keep.contains(name) {
            try? FileManager.default.removeItem(at: goldenDirectory.appendingPathComponent(name))
        }
    }
}
}

// MARK: - Exécution d'une requête

private struct Reply {
    let status: Int
    let body: Data
}

@MainActor
private func send(_ request: GoldenRequest, path: String, stack: RemoteStack, token: String, fixture: GoldenFixture) async throws -> Reply {
    var bearer: String? = token
    switch request.token {
    case "none": bearer = nil
    case "unknown": bearer = "jeton-inconnu-" + String(repeating: "x", count: 20)
    default: break
    }
    var protocolVersion: Int? = ConsoleAPI.protocolVersion
    var omit = false
    if let value = request.protocolValue {
        if let text = value as? String, text == "omit" { omit = true }
        else if let number = value as? Int { protocolVersion = number }
    }
    var data: Data?
    if let raw = request.rawBody {
        data = Data(raw.utf8)
    } else if let body = request.body {
        data = try JSONSerialization.data(withJSONObject: fixture.resolveJSON(body), options: [.sortedKeys, .fragmentsAllowed])
    }
    var headers: [String: String] = [:]
    for (name, value) in request.headers { headers[name] = fixture.resolve(value) }
    let reply = try await stack.call(
        request.method,
        path,
        token: bearer,
        body: data,
        headers: headers,
        protocolVersion: protocolVersion,
        omitProtocolHeader: omit
    )
    return Reply(status: reply.status, body: reply.body)
}

/// Les gestes sur le disque ou les doublures AVANT une requête (`before`) : écrire, supprimer, renommer, créer.
@MainActor
private func applyBefore(_ operations: [[String: Any]], fixture: GoldenFixture) throws {
    let fileManager = FileManager.default
    for operation in operations {
        let kind = operation["op"] as? String ?? ""
        let path = fixture.root + "/" + fixture.template(operation["path"] as? String ?? "")
        switch kind {
        case "write":
            try fixture.template(operation["text"] as? String ?? "").write(toFile: path, atomically: true, encoding: .utf8)
        case "remove":
            try? fileManager.removeItem(atPath: path)
        case "rename":
            let target = fixture.root + "/" + fixture.template(operation["to"] as? String ?? "")
            try fileManager.moveItem(atPath: path, toPath: target)
        case "mkdir":
            try fileManager.createDirectory(atPath: path, withIntermediateDirectories: true)
        case "chmod":
            try fileManager.setAttributes([.posixPermissions: operation["mode"] as? Int ?? 0o644], ofItemAtPath: path)
        default:
            Issue.record("opération `before` inconnue : \(kind)")
        }
    }
}

/// Le flux `/v1/stream` : les trames d'OUVERTURE (hello, store, conduite, devices, components,
/// journal, pull-request-states), lues sur la vraie connexion SSE, puis la connexion est fermée.
@MainActor
private func captureStream(stack: RemoteStack, token: String, path: String, fixture: GoldenFixture) async throws -> [String: Any] {
    let request = stack.request("GET", path, token: token)
    let (bytes, response) = try await URLSession.shared.bytes(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    var frames: [[String: Any]] = []
    var event: String?
    let reader = Task { @MainActor in
        // `AsyncLineSequence` OMET les lignes vides : une trame se clôt donc à sa ligne `data:`
        // (le Mac n'écrit jamais une charge sur plusieurs lignes).
        for try await line in bytes.lines {
            if line.hasPrefix("event: ") {
                event = String(line.dropFirst(7))
            } else if line.hasPrefix("data: "), let name = event {
                let payload = String(line.dropFirst(6))
                let parsed = (try? JSONSerialization.jsonObject(with: Data(payload.utf8), options: [.fragmentsAllowed])) ?? payload
                frames.append(["event": name, "data": fixture.normalize(parsed)])
                event = nil
                if frames.count == 7 { return }
            }
        }
    }
    let deadline = Date().addingTimeInterval(15)
    while frames.count < 7, Date() < deadline { try? await Task.sleep(for: .milliseconds(20)) }
    reader.cancel()
    // Le flux fermé, l'appareil n'est plus « connecté » : aucune requête suivante ne dépend de cet instant.
    _ = await awaitMainTrue(timeout: 5) { stack.registry.connected.isEmpty }
    return ["status": status, "body": frames]
}

/// Les EFFETS de la séquence : commandes envoyées au contrôleur, demandes d'audit faites au service,
/// livraisons écrites dans les boîtes de l'inbox.
@MainActor
private func effectsOutcome(transport: ParityServiceTransport, stateDir: String, fixture: GoldenFixture) -> [String: Any] {
    let calls = transport.mutatingCalls
    let commands = calls.filter { $0.path.hasSuffix("/commands") }.map { call -> [String: Any] in
        ["path": fixture.normalize(text: call.path), "body": fixture.normalize(call.body ?? [:])]
    }
    let audits = calls.filter { $0.path.hasPrefix("/v1/audits") }.map { call -> [String: Any] in
        ["method": call.method, "path": call.path, "body": fixture.normalize(call.body ?? [:])]
    }
    // Par boîte, les LIVRAISONS (contenus) triées : le nom d'un fichier porte un sel aléatoire côté
    // production, seul ce qui est livré compte.
    var inbox: [String: [Any]] = [:]
    let root = stateDir + "/inbox"
    if let walker = FileManager.default.enumerator(atPath: root) {
        for case let relative as String in walker where relative.hasSuffix(".json") {
            guard let data = FileManager.default.contents(atPath: root + "/" + relative),
                  let parsed = try? JSONSerialization.jsonObject(with: data) else { continue }
            let box = fixture.normalize(text: (relative as NSString).deletingLastPathComponent)
            inbox[box, default: []].append(fixture.normalize(parsed))
        }
    }
    // La clé de tri est celle du TypeScript : instant, sorte, texte (jamais une forme sérialisée).
    func key(_ delivery: Any) -> String {
        let object = delivery as? [String: Any] ?? [:]
        let sentAt = String(Int(object["sentAt"] as? Double ?? 0))
        let text = object["text"] as? String ?? object["selected"] as? String ?? object["custom"] as? String ?? ""
        return String(repeating: "0", count: max(0, 20 - sentAt.count)) + sentAt + "\u{0}" + (object["kind"] as? String ?? "") + "\u{0}" + text
    }
    let sortedInbox = inbox.mapValues { deliveries in deliveries.sorted { key($0) < key($1) } }
    return ["commands": commands, "audits": audits, "inbox": sortedInbox]
}
