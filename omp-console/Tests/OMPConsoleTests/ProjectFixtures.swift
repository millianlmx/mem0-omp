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
    attention: (any AttentionRequesting)? = nil
) -> ProjectConsoleModel {
    let suite = UserDefaults(suiteName: "project-model-\(UUID().uuidString)") ?? .standard
    return ProjectConsoleModel(
        host: host,
        attention: attention ?? RecordingAttention(),
        presence: presence ?? StubPresence(),
        stateDir: stateDir,
        defaults: suite
    )
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
