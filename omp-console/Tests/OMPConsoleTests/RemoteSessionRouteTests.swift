// Preuves de la session hébergée (S-11) : un prompt atteint la session de la coque
// et les dialogues NOUVEAUX remontent au client — sans que la coque ait à sonder.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// Le harnais local du test : une session hébergée scriptée, comme
/// `SessionHostTests` en a l'habitude.
@MainActor
private func makeHostedSession() async throws -> (transport: ScriptedRpcTransport, session: SessionConsoleModel, root: URL) {
    let transport = ScriptedRpcTransport()
    transport.onWrite = { [weak transport] line in
        MainActor.assumeIsolated {
            guard let transport,
                  let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let type = object["type"] as? String else { return }
            let id = object["id"] as? String ?? "?"
            let data: [String: Any]
            switch type {
            case "negotiate_protocol": data = ["protocolVersion": 2]
            case "get_state": data = ["sessionId": "sess-1234", "sessionFile": "/tmp/session.jsonl"]
            case "prompt": data = [:]
            default: return
            }
            var body: [String: Any] = ["type": "response", "id": id, "command": type, "success": true]
            if !data.isEmpty { body["data"] = data }
            let text = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            transport.emit(text)
        }
    }
    transport.readyLine = """
    {"type":"ready","protocolVersion":2,"supportedProtocolVersions":[1,2],\
    "maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
    """
    let host = SessionHost(
        transport: transport,
        resolveBinary: { _ in .success(URL(fileURLWithPath: "/usr/bin/true")) },
        environment: [:],
        requestTimeout: .seconds(2),
        readyTimeout: .seconds(2),
        stopGrace: .milliseconds(80),
        killGrace: .milliseconds(80)
    )
    let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("omp-console-session-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try await host.start(mode: .rpcUI, projectRoot: root, resume: false)
    return (transport, SessionConsoleModel(host: host), root)
}

@MainActor
@Test("api-distante-du-console/AC-13 : un prompt atteint la session hébergée et ses dialogues remontent")
func aPromptReachesTheHostedSession() async throws {
    let hosted = try await makeHostedSession()
    let stack = try await RemoteStack.make(sessionModel: hosted.session)
    defer {
        stack.stop()
        try? FileManager.default.removeItem(at: hosted.root)
    }
    let token = try await stack.pair()

    let prompt = try await stack.call(
        "POST", "/v1/session/prompt",
        token: token,
        json: ["message": "fais avancer le lot"]
    )
    #expect(prompt.status == 200)
    #expect(try prompt.json(RemoteSentPayload.self).sent)
    #expect(
        hosted.transport.written.contains { $0.contains("\"prompt\"") && $0.contains("fais avancer le lot") },
        "la trame `prompt` doit être écrite sur le transport"
    )

    // Un dialogue NOUVEAU remonte sans sondage : il est dans le GET suivant, et dans
    // le flux (`event: hosted`).
    hosted.transport.emit(
        #"{"type":"extension_ui_request","id":"d1","method":"select","title":"Choisir","options":["a","b"]}"#
    )
    let state = try await stack.call("GET", "/v1/session", token: token)
    #expect(state.status == 200)
    let payload = try state.json(RemoteHostedSessionPayload.self)
    #expect(payload.state == "running")
    #expect(payload.stateLabel == SessionConsoleModel.statusText(for: .running))
    #expect(payload.sessionId == "sess-1234")
    #expect(payload.dialogs.count == 1)
    #expect(payload.dialogs.first?.id == "d1")
    #expect(payload.truncated == false)
}

@MainActor
@Test("une session au repos n'est pas une erreur, un message vide est un 400, un prompt hors marche un 409")
func hostedSessionEdgeCases() async throws {
    // Aucune session lancée : `idle`, dialogues et transcript vides.
    let idle = try await RemoteStack.make()
    defer { idle.stop() }
    let token = try await idle.pair()
    let idleReply = try await idle.call("GET", "/v1/session", token: token)
    #expect(idleReply.status == 200)
    let idlePayload = try idleReply.json(RemoteHostedSessionPayload.self)
    #expect(idlePayload.state == "idle")
    #expect(idlePayload.dialogs.isEmpty)
    #expect(idlePayload.transcript.isEmpty)
    let idlePrompt = try await idle.call("POST", "/v1/session/prompt", token: token, json: ["message": "bonjour"])
    #expect(idlePrompt.status == 409)

    let hosted = try await makeHostedSession()
    let stack = try await RemoteStack.make(sessionModel: hosted.session)
    defer {
        stack.stop()
        try? FileManager.default.removeItem(at: hosted.root)
    }
    let live = try await stack.pair()
    let empty = try await stack.call("POST", "/v1/session/prompt", token: live, json: ["message": "   "])
    #expect(empty.status == 400)
    #expect(empty.errorCode == "bad_request")
}
