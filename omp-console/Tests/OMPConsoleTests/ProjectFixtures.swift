// Harnais des preuves de la conduite de projet (BR-5) : une session servie
// scriptée (API REST), des doubles d'attention et de présence, et des dépôts git
// jetables.
//
// Aucun `omp` n'est lancé (sauf la recette, désactivée par défaut) : le transport
// HTTP scripté permet de piloter les réponses des routes, le flux SSE et les
// dialogues.

import AppKit
import Combine
import ConsoleCore
import Foundation
@testable import OMPConsole

// MARK: - Session servie scriptée (API REST)

/// Le délai avant la réouverture d'un flux scripté. Le service scripté ferme ses
/// flux après les avoir rendus ; la session les rouvre après ce délai, ce qui
/// laisse aux preuves le temps d'agir AVANT la réouverture suivante.
let projectRetryDelay: Duration = .milliseconds(500)

/// Empile `count` flux vides. Le service scripté ne sait pas garder un flux
/// OUVERT : sans ces flux, la session mourrait à la première réouverture faute de
/// script. Ils entretiennent donc la vie de la session le temps du test.
func keepProjectAlive(_ transport: ScriptedServiceTransport, count: Int = 600) {
    for _ in 0..<count { transport.scriptStream([]) }
}

/// Stub la route `POST /projects/{repo}/conduite` et la relecture de session qui
/// suit (`GET /v1/sessions/{id}`), plus la clôture `DELETE /conduite` (S-7).
func stubProjectConduite(
    _ transport: ScriptedServiceTransport,
    repo: String,
    sessionId: String = "s1",
    sessionFile: String? = nil
) {
    transport.stubJSON("POST", "/conduite", ["sessionId": sessionId, "state": "running"])
    var session: [String: Any] = [
        "id": sessionId,
        "cwd": repo,
        "purpose": "project",
        "state": "running",
    ]
    if let sessionFile { session["sessionFile"] = sessionFile } else { session["sessionFile"] = NSNull() }
    transport.stubJSON("GET", "/v1/sessions/\(sessionId)", session)
    transport.stubJSON("DELETE", "/conduite", ["closed": true])
}

/// Stub la vie d'une session SERVIE (`session` : prompt, dialogues, relecture,
/// fermeture) : l'équivalent service de la poignée de main et des réponses
/// automatiques du transport RPC. Un transport scripté rend la PREMIÈRE route dont
/// le suffixe correspond, donc ces stubs se complètent sans se masquer.
func stubServiceSession(
    _ transport: ScriptedServiceTransport,
    sessionId: String = "sess-1234",
    cwd: String = "/tmp",
    purpose: String = "session",
    sessionFile: String? = "/tmp/session.jsonl"
) {
    var session: [String: Any] = ["id": sessionId, "cwd": cwd, "purpose": purpose, "state": "running"]
    session["sessionFile"] = sessionFile ?? NSNull()
    transport.stubJSON("POST", "/v1/sessions", session)
    transport.stubJSON("GET", "/v1/sessions/\(sessionId)", session)
    transport.stubJSON("POST", "/v1/sessions/\(sessionId)/prompt", ["accepted": true])
    transport.stubJSON("DELETE", "/v1/sessions/\(sessionId)", ["closed": true])
}

/// Une session SERVIE prête à lancer (`session`), sans réseau ni process : le
/// service scripté publie `sessionFile` à la création, et `streams` flux OUVERTS
/// sont empilés — chaque (re)démarrage de la session en consomme un.
@MainActor
func makeScriptedHostedHost(
    _ transport: ScriptedServiceTransport,
    sessionFile: String,
    sessionId: String = "sess-1234",
    streams: Int = 2
) -> ServiceSessionModel {
    stubServiceSession(transport, sessionId: sessionId, sessionFile: sessionFile)
    openServiceStream(transport, count: streams)
    return makeProjectHost(purpose: "session", makeClient: { scriptedClient(transport) })
}

/// La trame d'un dialogue, prête pour un flux (`scriptStream`) ou pour une poussée
/// sur un flux ouvert (`emit`).
func serviceDialogFrame(
    id: String,
    method: String,
    title: String,
    options: [String] = [],
    optionDescriptions: [String?] = [],
    prefill: String? = nil,
    placeholder: String? = nil
) -> [String] {
    let descriptions: [Any] = optionDescriptions.map { $0.map { $0 as Any } ?? NSNull() }
    var json: [String: Any] = [
        "id": id,
        "method": method,
        "title": title,
        "options": options,
        "optionDescriptions": descriptions,
    ]
    if let prefill { json["prefill"] = prefill }
    if let placeholder { json["placeholder"] = placeholder }
    return serviceFrame("dialog", json)
}

/// Empile un flux portant UNE demande de dialogue — l'équivalent HTTP du
/// `emit(dialogLine)` de l'ancien protocole.
func emitProjectDialog(
    _ transport: ScriptedServiceTransport,
    id: String,
    method: String,
    title: String,
    options: [String] = [],
    optionDescriptions: [String?] = [],
    prefill: String? = nil,
    placeholder: String? = nil
) {
    transport.scriptStream(serviceDialogFrame(
        id: id,
        method: method,
        title: title,
        options: options,
        optionDescriptions: optionDescriptions,
        prefill: prefill,
        placeholder: placeholder
    ))
}

/// Ouvre le flux d'une session servie et le GARDE OUVERT : la session reste
/// vivante sans reconnexion, et les trames poussées ensuite par
/// `emitServiceDialog`/`emitServiceNotice` arrivent par cette même connexion —
/// l'équivalent service de la poignée de main maintenue, plus léger que
/// `keepProjectAlive`. `count` en empile plusieurs : chaque (re)démarrage de
/// session consomme le suivant.
func openServiceStream(_ transport: ScriptedServiceTransport, count: Int = 1) {
    for _ in 0..<count { transport.scriptStream([], keepOpen: true) }
}

/// Pousse une demande de dialogue sur le flux OUVERT (l'équivalent service du
/// `transport.emit(dialogLine)` de l'ancien protocole).
func emitServiceDialog(
    _ transport: ScriptedServiceTransport,
    id: String,
    method: String,
    title: String,
    options: [String] = [],
    prefill: String? = nil,
    placeholder: String? = nil
) {
    transport.emit(serviceDialogFrame(
        id: id,
        method: method,
        title: title,
        options: options,
        prefill: prefill,
        placeholder: placeholder
    ))
}

/// Pousse une notice sur le flux OUVERT.
func emitServiceNotice(_ transport: ScriptedServiceTransport, level: String = "info", message: String) {
    transport.emit(serviceFrame("notice", ["level": level, "message": message]))
}

/// Empile un flux portant une seule trame de notice (S-7).
func emitProjectNotice(_ transport: ScriptedServiceTransport, level: String = "info", message: String) {
    transport.scriptStream(serviceFrame("notice", ["level": level, "message": message]))
}

// MARK: - Dépôts et magasins jetables

/// Un répertoire temporaire portant un `.git` : `isGitRepository` est satisfait
/// sans lancer git.
func makeGitRepository() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("omp-project-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    try Data("gitdir: .\n".utf8).write(to: url.appendingPathComponent(".git"))
    return url
}

/// Un magasin d'état temporaire dont le répertoire `projects/` existe déjà (la
/// veille du document s'arme ainsi directement sur `.doc`).
func makeProjectStateDir() throws -> String {
    let root = (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-project-state-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
        atPath: (root as NSString).appendingPathComponent("projects"),
        withIntermediateDirectories: true
    )
    return root
}

// MARK: - Host scripté

/// La session servie de projet, branchée sur un transport scripté.
@MainActor
func makeScriptedProjectHost(
    _ transport: ScriptedServiceTransport,
    purpose: String = "project"
) -> ServiceSessionModel {
    makeProjectHost(purpose: purpose, makeClient: { scriptedClient(transport) })
}

/// La session servie de projet, sur une fabrique de client quelconque (les preuves
/// qui font varier la réponse d'une route empilent plusieurs transports).
@MainActor
func makeProjectHost(
    purpose: String = "project",
    makeClient: @escaping @Sendable () throws -> ServiceClient
) -> ServiceSessionModel {
    ServiceSessionModel(
        purpose: purpose,
        makeClient: makeClient,
        maxAttempts: 5,
        retryDelay: { _ in projectRetryDelay }
    )
}

/// Un client sur un transport quelconque, pour les transports qui ne sont pas un
/// `ScriptedServiceTransport` (l'endpoint est factice, seul le transport compte).
func projectServiceClient(_ transport: any ServiceTransport) -> ServiceClient {
    ServiceClient(
        endpoint: ServiceEndpoint(
            baseURL: URL(string: "http://127.0.0.1:8788/v1")!,
            token: String(repeating: "a", count: 32),
            pid: 4_242,
            port: 8788,
            stateDir: "/tmp/omp-state"
        ),
        transport: transport
    )
}

/// Plusieurs `ScriptedServiceTransport` servis l'un APRÈS l'autre : les preuves
/// qui font varier la réponse d'une MÊME route (le fichier de session relu)
/// avancent d'un cran, ce qu'un transport seul (première route gagnante) ne sait
/// pas faire.
final class RollingServiceTransport: ServiceTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let stages: [ScriptedServiceTransport]
    private var index = 0

    init(_ stages: [ScriptedServiceTransport]) {
        precondition(!stages.isEmpty, "au moins une étape")
        self.stages = stages
    }

    /// Passe à l'étape suivante (la dernière se répète).
    func advance() {
        lock.lock(); defer { lock.unlock() }
        index = min(index + 1, stages.count - 1)
    }

    private var current: ScriptedServiceTransport {
        lock.lock(); defer { lock.unlock() }
        return stages[index]
    }

    func send(_ request: URLRequest) async throws -> ServiceHTTPResponse {
        try await current.send(request)
    }

    func lines(_ request: URLRequest) async throws -> AsyncThrowingStream<String, Error> {
        try await current.lines(request)
    }
}

// MARK: - Doubles

@MainActor
final class RecordingAttention: AttentionRequesting {
    private(set) var requested: [AttentionKind] = []
    private(set) var cancelled: [Int] = []
    private var nextID = 1

    @discardableResult
    func request(_ kind: AttentionKind) -> Int {
        requested.append(kind)
        let id = nextID
        nextID += 1
        return id
    }

    func cancel(_ id: Int) {
        cancelled.append(id)
    }
}

@MainActor
final class StubPresence: WindowFrontmostReporting {
    @Published var isFrontmost: Bool = false
    var isFrontmostPublisher: AnyPublisher<Bool, Never> { $isFrontmost.eraseToAnyPublisher() }
}

// MARK: - Modèle

@MainActor
func makeProjectModel(
    host: ServiceSessionModel,
    stateDir: String,
    presence: (any WindowFrontmostReporting)? = nil,
    attention: (any AttentionRequesting)? = nil,
    prService: (any PRServicing)? = nil,
    urlOpener: (any URLOpening)? = nil,
    prRefreshInterval: Duration = .seconds(60),
    environment: [String: String] = [:]
) -> ProjectConsoleModel {
    let suite = UserDefaults(suiteName: "project-model-\(UUID().uuidString)") ?? .standard
    return ProjectConsoleModel(
        host: host,
        attention: attention ?? RecordingAttention(),
        presence: presence ?? StubPresence(),
        stateDir: stateDir,
        prService: prService,
        urlOpener: urlOpener ?? RecordingURLOpener(),
        prRefreshInterval: prRefreshInterval,
        environment: environment,
        defaults: suite,
        makeConversation: { SessionViewerModel(target: $0, watch: false) }
    )
}

// MARK: - Doubles du suivi de PR (BR-2)

/// Un `gh` DOUBLURE sur disque : un script `sh` jetable qui rend le JSON attendu
/// selon `$1 $2` et journalise son `argv` (une ligne par argument, dans l'ordre des
/// invocations). Partagé par les preuves du service (`PRServiceTests`) et du modèle
/// (`ProjectPRModelTests`), qui l'injectent comme binaire réel de `GhCLI`.
struct GhStub {
    let directory: URL
    let script: URL
    let log: URL

    /// `stateJSON`/`stateCode` : la sortie et le code de la lecture d'ÉTAT (`pr view`
    /// portant `state,mergedAt,closedAt`), routée à part des autres `pr view`.
    init(
        viewJSON: String?,
        checksJSON: String?,
        viewStderr: String? = nil,
        mergeSucceeds: Bool = true,
        stateJSON: String = "{}",
        stateCode: Int32 = 0
    ) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("gh-stub-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        script = directory.appendingPathComponent("gh")
        log = directory.appendingPathComponent("args.log")

        let view = directory.appendingPathComponent("view.json")
        let checks = directory.appendingPathComponent("checks.json")
        try Data((viewJSON ?? "{}").utf8).write(to: view)
        try Data((checksJSON ?? "[]").utf8).write(to: checks)
        let state = directory.appendingPathComponent("state.json")
        try Data(stateJSON.utf8).write(to: state)

        var lines = [
            "#!/bin/sh",
            "printf '%s\\n' \"$@\" >> '#LOG#'",
            "if [ \"$1 $2 $4\" = \"pr view state,mergedAt,closedAt\" ]; then cat '#STATE#'; exit #STATECODE#; fi",
        ]
        if let viewStderr {
            let line = "if [ \"$1 $2\" = \"pr view\" ]; then printf '%s\\n' '#VIEWERR#' >&2; exit 1; fi"
            lines.append(line.replacingOccurrences(of: "#VIEWERR#", with: viewStderr))
        }
        lines.append("case \"$1 $2\" in")
        lines.append("  \"pr view\") cat '#VIEW#' ;;")
        lines.append("  \"pr checks\") cat '#CHECKS#' ;;")
        lines.append("  \"pr merge\") exit #MERGECODE# ;;")
        lines.append("esac")
        lines.append("exit 0")

        var body = lines.joined(separator: "\n")
        body = body
            .replacingOccurrences(of: "#LOG#", with: log.path)
            .replacingOccurrences(of: "#VIEW#", with: view.path)
            .replacingOccurrences(of: "#CHECKS#", with: checks.path)
            .replacingOccurrences(of: "#STATE#", with: state.path)
            .replacingOccurrences(of: "#STATECODE#", with: String(stateCode))
            .replacingOccurrences(of: "#MERGECODE#", with: mergeSucceeds ? "0" : "1")
        try Data(body.utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    }

    /// Les lignes du journal : une par argument, dans l'ordre des invocations ; vide
    /// quand le script n'a JAMAIS tourné.
    func logged() -> [String] {
        (try? String(contentsOf: log, encoding: .utf8))?
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
            .filter { !$0.isEmpty } ?? []
    }
}

/// Un lecteur d'état de PR scripté (registre des faits, S-5 de pipelines-livrees) :
/// chaque URL reçoit une suite de résultats consommés dans l'ordre (le dernier se
/// répète) ; une URL sans script échoue. Il compte les lectures par URL et le
/// nombre maximal de lectures simultanées ; `delay` retient chaque lecture.
final class ScriptedPullRequestStateReader: PullRequestStateReading, @unchecked Sendable {
    private let lock = NSLock()
    private var scripts: [String: [Result<PullRequestFact, GhError>]] = [:]
    private var counts: [String: Int] = [:]
    private var inFlight = 0
    private var _maxInFlight = 0
    private var _completed = 0
    private var _delay: Duration

    init(delay: Duration = .zero) {
        _delay = delay
    }

    func script(_ url: String, _ results: [Result<PullRequestFact, GhError>]) {
        withLock { scripts[url] = results }
    }

    func script(_ url: String, _ state: PullRequestState, closedAtMs: Double? = nil) {
        script(url, [.success(PullRequestFact(url: url, state: state, closedAtMs: closedAtMs))])
    }

    func fail(_ url: String) {
        script(url, [.failure(.commandFailed(command: "pr view", code: 1, detail: "hors ligne"))])
    }

    var delay: Duration {
        get { withLock { _delay } }
        set { withLock { _delay = newValue } }
    }

    func readCount(_ url: String) -> Int { withLock { counts[url] ?? 0 } }
    var totalReads: Int { withLock { counts.values.reduce(0, +) } }
    var maxInFlight: Int { withLock { _maxInFlight } }
    var completed: Int { withLock { _completed } }

    func state(prUrl: String) async throws -> PullRequestFact {
        let delay: Duration = withLock {
            counts[prUrl, default: 0] += 1
            inFlight += 1
            _maxInFlight = max(_maxInFlight, inFlight)
            return _delay
        }
        if delay != .zero { try? await Task.sleep(for: delay) }
        let result: Result<PullRequestFact, GhError>? = withLock {
            inFlight -= 1
            _completed += 1
            guard var queue = scripts[prUrl], !queue.isEmpty else { return nil }
            let next = queue.removeFirst()
            if !queue.isEmpty { scripts[prUrl] = queue }
            return next
        }
        guard let result else {
            throw GhError.unreadableOutput(command: "pr view", detail: "aucun script pour \(prUrl)")
        }
        return try result.get()
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// Un service de PR scripté : chaque `prUrl` reçoit une suite de résultats consommés
/// dans l'ordre (le dernier se répète), et chaque fusion est journalisée.
final class StubPRService: PRServicing, @unchecked Sendable {
    struct MergeCall: Equatable, Sendable {
        let prUrl: String
        let title: String
        let body: String
        let headOid: String
    }

    private let lock = NSLock()
    private var scripts: [String: [Result<PRSnapshot, GhError>]] = [:]
    private var counts: [String: Int] = [:]
    private var _merged: [MergeCall] = []
    private var _directories: [String] = []
    private var _reads: [String] = []

    /// Posé, il fait échouer la fusion suivante (S-6).
    var mergeError: GhError?
    /// Délai artificiel d'une lecture, pour prouver qu'un rafraîchissement en cours
    /// n'est pas empilé.
    var readDelay: Duration = .zero

    func script(_ prUrl: String, _ results: [Result<PRSnapshot, GhError>]) {
        withLock {
            scripts[prUrl] = results
            counts[prUrl] = 0
        }
    }

    func script(_ prUrl: String, _ snapshot: PRSnapshot) {
        script(prUrl, [.success(snapshot)])
    }

    var merged: [MergeCall] { withLock { _merged } }
    var readDirectories: [String] { withLock { _directories } }
    var readURLs: [String] { withLock { _reads } }
    func readCount(_ prUrl: String) -> Int { withLock { counts[prUrl] ?? 0 } }

    func read(prUrl: String, in directory: String) async throws -> PRSnapshot {
        let delay = withLock { readDelay }
        if delay != .zero { try? await Task.sleep(for: delay) }
        let result: Result<PRSnapshot, GhError>? = withLock {
            _directories.append(directory)
            _reads.append(prUrl)
            let index = counts[prUrl] ?? 0
            counts[prUrl] = index + 1
            guard let list = scripts[prUrl], !list.isEmpty else { return nil }
            return list[min(index, list.count - 1)]
        }
        guard let result else {
            throw GhError.unreadableOutput(command: "pr view", detail: "aucun script pour \(prUrl)")
        }
        return try result.get()
    }

    func merge(prUrl: String, title: String, body: String, headOid: String, in directory: String) async throws {
        let error: GhError? = withLock {
            _directories.append(directory)
            _merged.append(MergeCall(prUrl: prUrl, title: title, body: body, headOid: headOid))
            return mergeError
        }
        if let error { throw error }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// Un ouvreur d'URL qui journalise les ouvertures et rend un booléen programmable.
final class RecordingURLOpener: URLOpening, @unchecked Sendable {
    private let lock = NSLock()
    private var _opened: [URL] = []
    var result: Bool = true

    var opened: [URL] { withLock { _opened } }
    var openCount: Int { opened.count }

    func open(_ url: URL) -> Bool {
        withLock {
            _opened.append(url)
            return result
        }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// L'échéance des preuves du fil principal.
@MainActor
func awaitProject(_ timeout: Double = 5.0, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + .seconds(timeout)
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}
