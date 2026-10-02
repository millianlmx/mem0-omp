// Harnais des preuves de la conduite de projet (BR-5) : un host scripté, des
// doubles d'attention et de présence, et des dépôts git jetables.
//
// Aucun `omp` n'est lancé (sauf la recette, désactivée par défaut) : le transport
// scripté permet de piloter la poignée de main, les trames et les dialogues.

import AppKit
import Combine
import Foundation
@testable import OMPConsole

// MARK: - Trames JSONL

func projectJsonLine(_ object: [String: Any]) -> String {
    guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
}

func projectJsonObject(_ line: String) -> [String: Any]? {
    guard let data = line.data(using: .utf8), let raw = try? JSONSerialization.jsonObject(with: data) else {
        return nil
    }
    return raw as? [String: Any]
}

func projectField(_ key: String, in line: String) -> String? {
    projectJsonObject(line)?[key] as? String
}

func projectReadyLine() -> String {
    projectJsonLine([
        "type": "ready",
        "protocolVersion": 1,
        "supportedProtocolVersions": [1, 2],
        "maxFrameBytes": 1_048_576,
        "maxReassembledFrameBytes": 67_108_864,
    ])
}

func projectResponseLine(
    id: String,
    command: String,
    success: Bool = true,
    data: [String: Any]? = nil,
    error: String? = nil
) -> String {
    var object: [String: Any] = ["type": "response", "id": id, "command": command, "success": success]
    if let data { object["data"] = data }
    if let error { object["error"] = error }
    return projectJsonLine(object)
}

func projectDialogLine(id: String, method: String, extra: [String: Any] = [:]) -> String {
    var object: [String: Any] = ["type": "extension_ui_request", "method": method, "id": id]
    object.merge(extra) { _, new in new }
    return projectJsonLine(object)
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

@MainActor
func makeScriptedProjectHost(_ transport: ScriptedRpcTransport) -> SessionHost {
    SessionHost(
        transport: transport,
        resolveBinary: { _ in .success(URL(fileURLWithPath: "/usr/bin/true")) },
        environment: [:],
        requestTimeout: .seconds(2),
        readyTimeout: .seconds(2),
        stopGrace: .milliseconds(80),
        killGrace: .milliseconds(80)
    )
}

/// Répond automatiquement aux commandes de la poignée de main et des prompt, pour
/// que les `await` du modèle ne dépendent pas d'un délai.
@MainActor
func wireProjectAutoResponses(_ transport: ScriptedRpcTransport) {
    transport.onWrite = { line in
        guard let object = projectJsonObject(line), let type = object["type"] as? String else { return }
        let id = object["id"] as? String ?? "?"
        switch type {
        case "negotiate_protocol":
            transport.emit(projectResponseLine(id: id, command: "negotiate_protocol", data: ["protocolVersion": 2]))
        case "get_state":
            transport.emit(projectResponseLine(
                id: id,
                command: "get_state",
                data: ["sessionId": "sess-1234", "sessionFile": "/tmp/session.jsonl"]
            ))
        case "prompt":
            transport.emit(projectResponseLine(id: id, command: "prompt"))
        default:
            break
        }
    }
}

/// Fait rendre la main au process dès la fermeture de stdin : `stop()` ne subit
/// alors aucune escalade.
@MainActor
func makeProjectTransportRenderOnClose(_ transport: ScriptedRpcTransport) {
    transport.onCloseStdin = {
        transport.emitExit(ProcessExit(status: 0, reason: .exited))
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
    host: SessionHost,
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

    init(viewJSON: String?, checksJSON: String?, viewStderr: String? = nil, mergeSucceeds: Bool = true) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("gh-stub-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        script = directory.appendingPathComponent("gh")
        log = directory.appendingPathComponent("args.log")

        let view = directory.appendingPathComponent("view.json")
        let checks = directory.appendingPathComponent("checks.json")
        try Data((viewJSON ?? "{}").utf8).write(to: view)
        try Data((checksJSON ?? "[]").utf8).write(to: checks)

        var lines = [
            "#!/bin/sh",
            "printf '%s\\n' \"$@\" >> '#LOG#'",
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
