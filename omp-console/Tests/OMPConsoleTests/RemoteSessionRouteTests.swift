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

// MARK: - La session hébergée pilotée à distance (feature ios-session-omp)

/// Un hôte scripté PRÊT À LANCER (aucun process), dont `get_state` publie le
/// fichier de session demandé — la matière des routes de S-1 et du flux de S-4.
@MainActor
private func makeHostedHost(sessionFile: String, transport: ScriptedRpcTransport) -> SessionHost {
    transport.onWrite = { [weak transport] line in
        MainActor.assumeIsolated {
            guard let transport,
                  let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let type = object["type"] as? String else { return }
            let id = object["id"] as? String ?? "?"
            let data: [String: Any]
            switch type {
            case "negotiate_protocol": data = ["protocolVersion": 2]
            case "get_state": data = ["sessionId": "sess-1234", "sessionFile": sessionFile]
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
    return SessionHost(
        transport: transport,
        resolveBinary: { _ in .success(URL(fileURLWithPath: "/usr/bin/true")) },
        environment: [:],
        requestTimeout: .seconds(2),
        readyTimeout: .seconds(2),
        stopGrace: .milliseconds(80),
        killGrace: .milliseconds(80)
    )
}

/// Un dépôt git jetable, publié comme lot du magasin : `knownRepos()` le sert.
private func makeKnownRepo(_ store: StoreFixture) throws -> String {
    let repoRoot = store.root + "/depot"
    try FileManager.default.createDirectory(atPath: repoRoot + "/.git", withIntermediateDirectories: true)
    store.publish(.lots, "\(fixtureId(0xF1)).json", object: lotObject(id: fixtureId(0xF1), repoRoot: repoRoot))
    return repoRoot
}

@MainActor
private func launch(_ stack: RemoteStack, token: String, repoKey: String) async throws -> RemoteReply {
    try await stack.call("POST", "/v1/session/launch", token: token, json: ["repoKey": repoKey])
}

@MainActor
@Test("ios-session-omp/AC-1 : le lancement démarre l'hôte unique sur un dépôt connu et l'état servi passe à running")
func hostedLaunchStartsTheSingleSession() async throws {
    let store = StoreFixture()
    let repoRoot = try makeKnownRepo(store)
    let sessionFile = store.root + "/session.jsonl"
    let transport = ScriptedRpcTransport()
    let session = SessionConsoleModel(host: makeHostedHost(sessionFile: sessionFile, transport: transport))
    let stack = try await RemoteStack.make(stateDir: store.root, sessionModel: session)
    defer { stack.stop() }
    let token = try await stack.pair()

    // AC-4 : le sélecteur sert les dépôts connus, avec leur clé.
    let repos = try await stack.call("GET", "/v1/repos", token: token)
    #expect(repos.status == 200)
    let row = try #require(try repos.json(RemoteReposPayload.self).rows.first { $0.repoRoot == realpathOr(repoRoot) })
    #expect(row.name == "depot")

    // AC-1 : le lancement démarre l'hôte et l'état servi est `running`.
    let launched = try await launch(stack, token: token, repoKey: row.repoKey)
    #expect(launched.status == 200)
    let payload = try launched.json(RemoteHostedSessionPayload.self)
    #expect(payload.state == "running")
    #expect(payload.sessionFile == sessionFile)
    #expect(payload.projectName == "depot")

    // Le prompt part bien à la session (S-3, route existante).
    let sent = try await stack.call("POST", "/v1/session/prompt", token: token, json: ["message": "bonjour"])
    #expect(sent.status == 200)
    #expect(transport.written.contains { $0.contains("\"prompt\"") && $0.contains("bonjour") })

    // Le lancement sur une clé inconnue est refusé : aucun chemin n'est accepté.
    let unknown = try await launch(stack, token: token, repoKey: "inconnu")
    #expect(unknown.status == 404)
    #expect(unknown.errorMessage == "dépôt inconnu")
}
@MainActor
@Test("ios-session-omp/AC-4 : le sélecteur ne sert que les dépôts connus, un chemin à la place de la clé est un 404")
func hostedLaunchOnlyKnownRepos() async throws {
    let store = StoreFixture()
    _ = try makeKnownRepo(store)
    let session = SessionConsoleModel(host: makeHostedHost(sessionFile: store.root + "/s.jsonl", transport: ScriptedRpcTransport()))
    let stack = try await RemoteStack.make(stateDir: store.root, sessionModel: session)
    defer { stack.stop() }
    let token = try await stack.pair()
    let repos = try await stack.call("GET", "/v1/repos", token: token).json(RemoteReposPayload.self)
    #expect(repos.rows.count == 1)
    #expect(repos.rows.allSatisfy { !$0.repoKey.contains("/") }, "la clé n'est jamais un chemin")
    let byPath = try await launch(stack, token: token, repoKey: repos.rows[0].repoRoot)
    #expect(byPath.status == 404)
    #expect(byPath.errorMessage == "dépôt inconnu")
    #expect(session.host.state == .idle)
}

@MainActor
@Test("ios-session-omp/AC-3 : un second lancement pendant une session en marche est refusé (409) et la session en cours reste intacte")
func hostedLaunchRefusesSecondSession() async throws {
    let store = StoreFixture()
    let repoRoot = try makeKnownRepo(store)
    let sessionFile = store.root + "/session.jsonl"
    let transport = ScriptedRpcTransport()
    let session = SessionConsoleModel(host: makeHostedHost(sessionFile: sessionFile, transport: transport))
    let stack = try await RemoteStack.make(stateDir: store.root, sessionModel: session)
    defer { stack.stop() }
    let token = try await stack.pair()
    let repos = try await stack.call("GET", "/v1/repos", token: token).json(RemoteReposPayload.self)
    let row = try #require(repos.rows.first { $0.repoRoot == realpathOr(repoRoot) })

    _ = try await launch(stack, token: token, repoKey: row.repoKey)
    let again = try await launch(stack, token: token, repoKey: row.repoKey)
    #expect(again.status == 409)
    #expect(again.errorMessage == SessionConsoleText.launchBusy)
    #expect(session.host.state == .running, "aucun remplacement silencieux : la session reste en marche")
    #expect(session.host.sessionFile == sessionFile)
}

@MainActor
@Test("ios-session-omp/AC-13 : l'arrêt depuis la route rend `stopped` et le lancement redevient disponible")
func hostedStopReturnsStopped() async throws {
    let store = StoreFixture()
    let repoRoot = try makeKnownRepo(store)
    let sessionFile = store.root + "/session.jsonl"
    let transport = ScriptedRpcTransport()
    let session = SessionConsoleModel(host: makeHostedHost(sessionFile: sessionFile, transport: transport))
    let stack = try await RemoteStack.make(stateDir: store.root, sessionModel: session)
    defer { stack.stop() }
    let token = try await stack.pair()
    let row = try #require(try await stack.call("GET", "/v1/repos", token: token)
        .json(RemoteReposPayload.self).rows.first { $0.repoRoot == realpathOr(repoRoot) })

    _ = try await launch(stack, token: token, repoKey: row.repoKey)
    let stopped = try await stack.call("POST", "/v1/session/stop", token: token)
    #expect(stopped.status == 200)
    let payload = try stopped.json(RemoteHostedSessionPayload.self)
    #expect(payload.state == "stopped")
    // Le dépôt reste mémorisé : le lancement est de nouveau offert.
    #expect(payload.projectName == "depot")
    #expect(transport.closeStdinCount == 1)
}

@MainActor
@Test("la relance est réservée à `dead` et reprend le même fichier (S-1)")
func hostedRelaunchOnlyFromDead() async throws {
    let hosted = try await makeHostedSession()
    let stack = try await RemoteStack.make(sessionModel: hosted.session)
    defer {
        stack.stop()
        try? FileManager.default.removeItem(at: hosted.root)
    }
    let token = try await stack.pair()

    // `running` : la relance est refusée (409), aucune écriture de relance.
    let busy = try await stack.call("POST", "/v1/session/relaunch", token: token)
    #expect(busy.status == 409)

    // Mort subie : la session devient `dead`, relançable.
    hosted.transport.emitExit(ProcessExit(status: 1, reason: .exited))
    #expect(hosted.session.host.state != .running)
    let relaunched = try await stack.call("POST", "/v1/session/relaunch", token: token)
    #expect(relaunched.status == 200)
    let payload = try relaunched.json(RemoteHostedSessionPayload.self)
    #expect(payload.sessionFile == "/tmp/session.jsonl")
}

@MainActor
@Test("ios-session-omp/AC-9 : les quatre formes de dialogue sont répondables depuis la route, les erreurs sont des 400, et une tête de file périmée un 409")
func hostedDialogRouting() async throws {
    let hosted = try await makeHostedSession()
    let stack = try await RemoteStack.make(sessionModel: hosted.session)
    defer {
        stack.stop()
        try? FileManager.default.removeItem(at: hosted.root)
    }
    let token = try await stack.pair()

    func emit(_ json: String) { hosted.transport.emit(json) }
    func answer(_ id: String, _ body: [String: Any]) async throws -> RemoteReply {
        try await stack.call("POST", "/v1/session/dialogs/\(id)", token: token, json: body)
    }

    // 1. `select` : les erreurs d'abord (tête de file), puis la réponse qui vide.
    emit(#"{"type":"extension_ui_request","id":"s1","method":"select","title":"Choisir","options":["a","b"]}"#)
    #expect(hosted.session.host.dialogQueue.first?.id == "s1")
    #expect((try await answer("s1", ["kind": "value"])).status == 400)
    #expect((try await answer("s1", ["kind": "value", "value": "z"])).errorMessage == "libellé hors des options du dialogue")
    let selected = try await answer("s1", ["kind": "value", "value": "b"])
    #expect(selected.status == 200)
    #expect(try selected.json(RemoteAcceptedPayload.self).accepted)
    #expect(hosted.session.host.dialogQueue.isEmpty)
    #expect(hosted.transport.written.contains { $0.contains("\"value\"") && $0.contains("\"b\"") })

    // 2. `input` : un texte non blanc.
    emit(#"{"type":"extension_ui_request","id":"s2","method":"input","title":"Saisir"}"#)
    #expect((try await answer("s2", ["kind": "value", "value": "   "])).errorMessage == "texte vide")
    let input = try await answer("s2", ["kind": "value", "value": "texte"])
    #expect(input.status == 200)
    #expect(hosted.session.host.dialogQueue.isEmpty)

    // 3. `editor` : une valeur VIDE est acceptée.
    emit(#"{"type":"extension_ui_request","id":"s3","method":"editor","title":"Éditer","prefill":"plan"}"#)
    let edited = try await answer("s3", ["kind": "value", "value": ""])
    #expect(edited.status == 200)
    #expect(hosted.session.host.dialogQueue.isEmpty)

    // 4. `confirm` : `confirmed` requis, et rien ne remplace une confirmation.
    emit(#"{"type":"extension_ui_request","id":"s4","method":"confirm","title":"Confirmer"}"#)
    #expect((try await answer("s4", ["kind": "value", "value": "x"])).errorMessage == "ce dialogue n'attend pas de valeur")
    #expect((try await answer("s4", ["kind": "confirmed"])).errorMessage == "confirmation absente")
    let confirmed = try await answer("s4", ["kind": "confirmed", "confirmed": true])
    #expect(confirmed.status == 200)
    #expect(hosted.session.host.dialogQueue.isEmpty)

    // 5. `select` : pas de confirmation, `kind` inconnu, puis annulation (AC-11).
    emit(#"{"type":"extension_ui_request","id":"s5","method":"select","title":"Choisir","options":["a"]}"#)
    #expect((try await answer("s5", ["kind": "confirmed", "confirmed": true])).errorMessage == "ce dialogue n'attend pas de confirmation")
    #expect((try await answer("s5", ["kind": "autre"])).errorMessage == "kind inconnu")
    let stale = try await answer("inconnu", ["kind": "cancelled"])
    #expect(stale.status == 409)
    #expect(stale.errorMessage == "le dialogue a changé depuis la demande")
    let cancelled = try await answer("s5", ["kind": "cancelled"])
    #expect(cancelled.status == 200)
    #expect(hosted.session.host.dialogQueue.isEmpty)
}

/// Un lecteur SSE minimal, local au fichier : il attend la première trame d'un nom.
@MainActor
private final class HostedSSECollector {
    private(set) var events: [(name: String, data: String)] = []
    private var task: Task<Void, Never>?

    func start(_ request: URLRequest) {
        task = Task { @MainActor [weak self] in
            do {
                let (bytes, _) = try await URLSession.shared.bytes(for: request)
                var buffer = Data()
                let separator = Data("\n\n".utf8)
                for try await byte in bytes {
                    if Task.isCancelled { return }
                    buffer.append(byte)
                    while let range = buffer.range(of: separator) {
                        let frame = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
                        buffer.removeSubrange(buffer.startIndex..<range.upperBound)
                        var name = ""
                        var data = ""
                        for raw in String(decoding: frame, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false) {
                            let line = String(raw)
                            if line.hasPrefix("data: ") { data += String(line.dropFirst(6)) }
                            if line.hasPrefix("event: ") { name = String(line.dropFirst(7)) }
                        }
                        if !data.isEmpty { self?.events.append((name, data)) }
                    }
                }
            } catch {}
        }
    }

    func stop() { task?.cancel() }

    func waitFor(_ name: String, seconds: Double = 10) async -> String? {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let event = events.first(where: { $0.name == name }) { return event.data }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return events.first(where: { $0.name == name })?.data
    }
}

@MainActor
@Test("ios-session-omp/AC-7 : un ajout au fichier de la session hébergée produit une trame `sessions` pour CE fichier")
func hostedSessionFileIsWatched() async throws {
    let store = StoreFixture()
    let sessionFile = store.root + "/session.jsonl"
    let transport = ScriptedRpcTransport()
    let host = makeHostedHost(sessionFile: sessionFile, transport: transport)
    let session = SessionConsoleModel(host: host)
    try await host.start(mode: .rpcUI, projectRoot: URL(fileURLWithPath: store.root), resume: false)
    let stack = try await RemoteStack.make(stateDir: store.root, sessionModel: session)
    defer { stack.stop() }
    let token = try await stack.pair()

    // Le fichier existe AVANT l'ouverture du flux : la veille l'entre sous
    // surveillance, et son apparition plus tard serait couverte aussi (FileWatcher).
    let initial = """
    {"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z",\
    "message":{"role":"user","content":[{"type":"text","text":"premier"}]}}
    """
    try Data((initial + "\n").utf8).write(to: URL(fileURLWithPath: sessionFile))

    let collector = HostedSSECollector()
    collector.start(stack.request("GET", "/v1/stream", token: token))
    defer { collector.stop() }
    #expect(await collector.waitFor("store") != nil, "le flux doit s'ouvrir")

    let added = """
    {"type":"message","id":"e2","parentId":"e1","timestamp":"2026-01-01T00:00:01.000Z",\
    "message":{"role":"assistant","content":[{"type":"text","text":"deuxième"}]}}
    """
    let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: sessionFile))
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: Data((added + "\n").utf8))

    let frame = try #require(await collector.waitFor("sessions"), "un ajout doit produire une trame `sessions`")
    let object = try #require(
        try? JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: Any]
    )
    #expect(object["file"] as? String == sessionFile, "la trame doit porter CE fichier")
    #expect(frame.contains("deuxième"))
}

@MainActor
@Test("ios-session-omp/AC-6 : un prompt envoyé depuis l'iPad apparaît dans le fil comme message utilisateur, et la réponse s'y ajoute")
func hostedPromptReachesTheThread() async throws {
    let store = StoreFixture()
    let sessionFile = store.root + "/session.jsonl"
    let transport = ScriptedRpcTransport()
    let host = makeHostedHost(sessionFile: sessionFile, transport: transport)
    let session = SessionConsoleModel(host: host)
    try await host.start(mode: .rpcUI, projectRoot: URL(fileURLWithPath: store.root), resume: false)
    let stack = try await RemoteStack.make(stateDir: store.root, sessionModel: session)
    defer { stack.stop() }
    let token = try await stack.pair()

    let initial = """
    {"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z",\
    "message":{"role":"user","content":[{"type":"text","text":"premier"}]}}
    """
    try Data((initial + "\n").utf8).write(to: URL(fileURLWithPath: sessionFile))

    let collector = HostedSSECollector()
    collector.start(stack.request("GET", "/v1/stream", token: token))
    defer { collector.stop() }
    #expect(await collector.waitFor("store") != nil, "le flux doit s'ouvrir")

    let prompt = try await stack.call(
        "POST", "/v1/session/prompt",
        token: token,
        json: ["message": "corrige le lot"]
    )
    #expect(prompt.status == 200)
    #expect(transport.written.contains { $0.contains("corrige le lot") }, "le prompt doit partir à la session")

    // L'hôte écrit le tour dans son fichier : le message utilisateur, puis la réponse.
    let turn = """
    {"type":"message","id":"e2","parentId":"e1","timestamp":"2026-01-01T00:00:01.000Z",\
    "message":{"role":"user","content":[{"type":"text","text":"corrige le lot"}]}}
    {"type":"message","id":"e3","parentId":"e2","timestamp":"2026-01-01T00:00:02.000Z",\
    "message":{"role":"assistant","content":[{"type":"text","text":"lot corrigé"}]}}
    """
    let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: sessionFile))
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: Data((turn + "\n").utf8))

    // Le fil reçoit le tour : on attend la trame qui porte la réponse.
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline,
          !collector.events.contains(where: { $0.name == "sessions" && $0.data.contains("lot corrigé") }) {
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    let frames: [[String: Any]] = collector.events
        .filter { $0.name == "sessions" }
        .compactMap { try? JSONSerialization.jsonObject(with: Data($0.data.utf8)) as? [String: Any] }
    #expect(!frames.isEmpty, "un ajout doit produire une trame `sessions`")
    #expect(frames.allSatisfy { $0["file"] as? String == sessionFile }, "chaque trame doit porter CE fichier")
    let added = frames.flatMap { ($0["added"] as? [[String: Any]]) ?? [] }
    let entries = added.map { ($0["kind"] as? String ?? "") + ":" + ($0["text"] as? String ?? "") }
    #expect(entries.contains("user:corrige le lot"), "le prompt doit apparaître comme message utilisateur")
    #expect(entries.contains("assistant:lot corrigé"), "la réponse doit s'ajouter au fil")
}
