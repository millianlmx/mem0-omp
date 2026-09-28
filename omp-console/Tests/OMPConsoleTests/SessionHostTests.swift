// Preuves de S-1 à S-8 sur transport scripté (BR-5 step 4) : AC-2, AC-3, AC-4,
// AC-5, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14, AC-15, AC-16.
//
// Le transport scripté donne la main sur l'ORDRE et sur le MOMENT : réponse
// inversée (AC-3), expiration (AC-13), mort subie (AC-10), escalade sans réponse
// (AC-15). Aucun de ces cas ne se déclenche à la demande sur un vrai `omp`.

import Foundation
import Testing
@testable import OMPConsole

// MARK: - Outils

private func jsonLine(_ object: [String: Any]) -> String {
    guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
}

private func jsonObject(_ line: String) -> [String: Any]? {
    guard let data = line.data(using: .utf8), let raw = try? JSONSerialization.jsonObject(with: data) else {
        return nil
    }
    return raw as? [String: Any]
}

private func field(_ key: String, in line: String) -> String? {
    jsonObject(line)?[key] as? String
}

private func boolField(_ key: String, in line: String) -> Bool? {
    jsonObject(line)?[key] as? Bool
}

private func keys(in line: String) -> Set<String> {
    Set(jsonObject(line)?.keys.map { $0 } ?? [])
}

private func readyLine(versions: [Int] = [1, 2]) -> String {
    jsonLine([
        "type": "ready",
        "protocolVersion": versions.first ?? 1,
        "supportedProtocolVersions": versions,
        "maxFrameBytes": 1_048_576,
        "maxReassembledFrameBytes": 67_108_864,
    ])
}

private func responseLine(
    id: String,
    command: String,
    success: Bool = true,
    data: [String: Any]? = nil,
    error: String? = nil
) -> String {
    var object: [String: Any] = ["type": "response", "id": id, "command": command, "success": success]
    if let data { object["data"] = data }
    if let error { object["error"] = error }
    return jsonLine(object)
}

private func dialogLine(id: String, method: String, extra: [String: Any] = [:]) -> String {
    var object: [String: Any] = ["type": "extension_ui_request", "method": method]
    if method != "cancel" { object["id"] = id }
    object.merge(extra) { _, new in new }
    return jsonLine(object)
}

private func chunkFrames(for payload: String, count: Int, chunkId: String = "chunk-1") -> [String] {
    let bytes = Array(payload.utf8)
    let total = bytes.count
    let size = max(1, (total + count - 1) / count)
    return (0..<count).map { index in
        let start = min(total, index * size)
        let end = min(total, start + size)
        return jsonLine([
            "type": "rpc_chunk",
            "chunkId": chunkId,
            "index": index,
            "count": count,
            "byteLength": total,
            "data": Data(bytes[start..<end]).base64EncodedString(),
        ])
    }
}

private let defaultSessionFile = "/tmp/omp-session-\(UUID().uuidString).jsonl"

@MainActor
private func makeProjectDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("omp-host-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Un binaire RÉEL qui ne parle pas RPC et qui n'obéit pas à la fermeture de son
/// stdin : un `sleep` exécuté par `exec` ne rend la main qu'au signal. C'est le
/// chemin atteignable cité par la revue (binaire explicite exécutable, aucun
/// `ready` émis), prouvable sans `omp` et sans appel modèle.
@MainActor
private func makeIgnoringStdinBinary() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("omp-fake-\(UUID().uuidString)")
    try "#!/bin/sh\nexec sleep 30\n".write(to: url, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    return url
}

@MainActor
private func waitUntil(timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}

@MainActor
private func makeHost(
    _ transport: ScriptedRpcTransport,
    requestTimeout: Duration = .seconds(1),
    readyTimeout: Duration = .seconds(1),
    stopGrace: Duration = .milliseconds(80),
    killGrace: Duration = .milliseconds(80),
    resolve: SessionHost.BinaryResolver? = nil
) -> SessionHost {
    SessionHost(
        transport: transport,
        resolveBinary: resolve ?? { _ in .success(URL(fileURLWithPath: "/usr/bin/true")) },
        environment: [:],
        requestTimeout: requestTimeout,
        readyTimeout: readyTimeout,
        stopGrace: stopGrace,
        killGrace: killGrace
    )
}

/// Répond aux deux commandes de la poignée de main comme le fait `omp` (D1).
@MainActor
private func installStandardResponder(
    _ transport: ScriptedRpcTransport,
    protocolVersion: Int = 2,
    negotiateSuccess: Bool = true,
    sessionFile: String? = defaultSessionFile,
    sessionId: String? = "session-abcdef12"
) {
    transport.onWrite = { [weak transport] line in
        guard let transport, let type = field("type", in: line), let id = field("id", in: line) else { return }
        switch type {
        case "negotiate_protocol":
            if negotiateSuccess {
                transport.emit(responseLine(id: id, command: "negotiate_protocol", data: ["protocolVersion": protocolVersion]))
            } else {
                transport.emit(responseLine(id: id, command: "negotiate_protocol", success: false, error: "refusé"))
            }
        case "get_state":
            var data: [String: Any] = ["messageCount": 1]
            if let sessionFile { data["sessionFile"] = sessionFile }
            if let sessionId { data["sessionId"] = sessionId }
            transport.emit(responseLine(id: id, command: "get_state", data: data))
        default:
            break
        }
    }
}

/// Lance une session parvenue à l'état `running`, poignée de main comprise.
@MainActor
@discardableResult
private func startedHost(
    _ transport: ScriptedRpcTransport,
    projectRoot: URL,
    mode: RpcMode = .rpcUI,
    requestTimeout: Duration = .seconds(1),
    readyTimeout: Duration = .seconds(1),
    stopGrace: Duration = .milliseconds(80),
    killGrace: Duration = .milliseconds(80)
) async throws -> SessionHost {
    installStandardResponder(transport)
    transport.readyLine = readyLine()
    let host = makeHost(
        transport,
        requestTimeout: requestTimeout,
        readyTimeout: readyTimeout,
        stopGrace: stopGrace,
        killGrace: killGrace
    )
    try await host.start(mode: mode, projectRoot: projectRoot, resume: false)
    return host
}

// MARK: - S-1 / S-2 : lancement, poignée de main, version

@MainActor
@Test("client-rpc-omp/AC-1 : le lancement négocie la version 2 et atteint l'état running")
func launchNegotiatesAndRuns() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)

    #expect(host.state == .running)
    #expect(host.protocolVersion == 2)
    #expect(host.sessionId == "session-abcdef12")
    #expect(host.sessionFile == defaultSessionFile)
    #expect(host.pid == 4_242)
    #expect(transport.startedWith?.arguments == ["--mode", "rpc-ui", "--cwd", project.path])
    // La PREMIÈRE écriture est la négociation : rien n'est envoyé avant le `ready`.
    #expect(field("type", in: transport.written[0]) == "negotiate_protocol")
}

@MainActor
@Test("client-rpc-omp/AC-2 : un second lancement est refusé et aucun second process ne démarre")
func secondLaunchIsRefused() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)

    do {
        try await host.start(mode: .rpc, projectRoot: project, resume: false)
        Issue.record("un second lancement doit lever alreadyRunning")
    } catch let error as SessionHostError {
        #expect(error == .alreadyRunning)
        #expect(error.userMessage == "Une session est déjà ouverte : arrêtez-la avant d'en lancer une autre.")
    }
    #expect(transport.startCount == 1)
    #expect(host.state == .running)
}

@MainActor
@Test("client-rpc-omp/AC-4 : une version de protocole incompatible est refusée sans écrire sur stdin")
func incompatibleProtocolIsRefused() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    transport.readyLine = readyLine(versions: [1])
    let host = makeHost(transport)

    do {
        try await host.start(mode: .rpc, projectRoot: project, resume: false)
        Issue.record("une version 1 seule doit être refusée")
    } catch let error as SessionHostError {
        #expect(error == .incompatibleProtocol(announced: [1]))
        #expect(error.userMessage == "Version de protocole RPC incompatible : l'app exige la version 2, le process a annoncé [1]. Aucune commande n'a été envoyée.")
    }
    // AUCUNE écriture : la session n'a jamais existé.
    #expect(transport.written.isEmpty)
    #expect(host.state == .failed(message: SessionHostError.incompatibleProtocol(announced: [1]).userMessage))
}

@MainActor
@Test("client-rpc-omp/AC-4 : une négociation refusée aboutit à failed(negotiationRefused)")
func refusedNegotiationFails() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    installStandardResponder(transport, negotiateSuccess: false)
    transport.readyLine = readyLine()
    let host = makeHost(transport)

    do {
        try await host.start(mode: .rpc, projectRoot: project, resume: false)
        Issue.record("une négociation refusée doit faire échouer le démarrage")
    } catch let error as SessionHostError {
        #expect(error == .negotiationRefused("refusé"))
        #expect(error.userMessage == "Négociation de protocole refusée par le process : refusé")
    }
    #expect(host.state == .failed(message: "Négociation de protocole refusée par le process : refusé"))
}

@MainActor
@Test("client-rpc-omp/AC-4 : une négociation qui n'annonce pas la version 2 est refusée")
func negotiationWithoutVersionTwoIsRefused() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    installStandardResponder(transport, protocolVersion: 1)
    transport.readyLine = readyLine()
    let host = makeHost(transport)

    do {
        try await host.start(mode: .rpc, projectRoot: project, resume: false)
        Issue.record("une négociation sans version 2 doit être refusée")
    } catch let error as SessionHostError {
        #expect(error == .negotiationRefused("le process a annoncé une autre version"))
    }
    #expect(host.state != .running)
}

@MainActor
@Test("client-rpc-omp/AC-4 : une trame ready illisible n'est jamais un running")
func unreadableReadyFrameFails() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    transport.readyLine = #"{"type":"ready"}"#
    let host = makeHost(transport, readyTimeout: .milliseconds(150))

    do {
        try await host.start(mode: .rpc, projectRoot: project, resume: false)
        Issue.record("une trame ready illisible doit faire échouer le démarrage")
    } catch let error as SessionHostError {
        #expect(error == .readyFrameMissing)
    }
    #expect(host.state == .failed(message: SessionHostError.readyFrameMissing.userMessage))
    #expect(host.protocolVersion == nil)
}

@MainActor
@Test("client-rpc-omp/AC-4 : aucune trame ready dans le délai laisse la session en échec")
func missingReadyFrameFails() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = makeHost(transport, readyTimeout: .milliseconds(150))

    do {
        try await host.start(mode: .rpc, projectRoot: project, resume: false)
        Issue.record("l'absence de ready doit faire échouer le démarrage")
    } catch let error as SessionHostError {
        #expect(error == .readyFrameMissing)
    }
    #expect(host.state == .failed(message: "Aucune trame `ready` reçue du process : la session ne peut pas démarrer."))
    #expect(transport.written.isEmpty)
}

@MainActor
@Test("client-rpc-omp/AC-4 : la mort du process avant la poignée de main est un échec nommé")
func processDeathBeforeHandshakeFails() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = makeHost(transport, readyTimeout: .seconds(5))
    let exit = ProcessExit(status: 9, reason: .uncaughtSignal)

    let start = Task { @MainActor in
        try await host.start(mode: .rpc, projectRoot: project, resume: false)
    }
    #expect(await waitUntil { transport.startedWith != nil })
    transport.emitExit(exit)

    do {
        try await start.value
        Issue.record("la mort pendant la poignée de main doit lever")
    } catch let error as SessionHostError {
        #expect(error == .processDiedBeforeHandshake(exit: exit))
    }
    #expect(host.state == .failed(message: "Le process s'est terminé avant la poignée de main (signal 9)."))
}

// BLOQUANT 1 de la revue : la sortie du process qui suit l'arrêt technique d'un
// échec de démarrage ne doit PAS écraser `failed` par `stopped` (S-2, S-9). Deux
// preuves, parce qu'aucune des deux ne suffit seule : la première fixe l'instant
// exact du défaut (la sortie arrive APRÈS que `start` a rendu la main), la seconde
// fait passer cette sortie par le vrai `terminationHandler` d'un process réel.

@MainActor
@Test("client-rpc-omp/AC-4 : l'état failed survit à la sortie du process après un échec de poignée de main")
func failedStateSurvivesScriptedExit() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    transport.readyLine = readyLine(versions: [1])
    let host = makeHost(transport)
    let expected = SessionHostError.incompatibleProtocol(announced: [1]).userMessage

    do {
        try await host.start(mode: .rpc, projectRoot: project, resume: false)
        Issue.record("une version 1 seule doit être refusée")
    } catch let error as SessionHostError {
        #expect(error == .incompatibleProtocol(announced: [1]))
    }
    #expect(host.state == .failed(message: expected))

    // La sortie arrive après l'échec : l'état doit rester l'échec, et le journal
    // doit nommer la sortie comme telle — jamais « session arrêtée ».
    transport.emitExit(ProcessExit(status: 0, reason: .exited))

    #expect(host.state == .failed(message: expected))
    #expect(!host.journal.contains { $0.message.hasPrefix("session arrêtée") })
    #expect(host.journal.contains { $0.kind == .processExit && $0.message.contains("process terminé après un échec (code 0)") })
}

@MainActor
@Test("client-rpc-omp/AC-4 : l'état failed survit à la sortie RÉELLE du process après un échec de poignée de main")
func failedStateSurvivesRealExit() async throws {
    let project = try makeProjectDirectory()
    let binary = try makeIgnoringStdinBinary()
    let transport = ProcessTransport()
    let host = SessionHost(
        transport: transport,
        resolveBinary: { _ in .success(binary) },
        environment: [:],
        requestTimeout: .seconds(1),
        readyTimeout: .milliseconds(200),
        stopGrace: .milliseconds(150),
        killGrace: .milliseconds(150)
    )
    let expected = SessionHostError.readyFrameMissing.userMessage

    do {
        try await host.start(mode: .rpc, projectRoot: project, resume: false)
        Issue.record("un binaire qui n'émet jamais `ready` doit faire échouer le démarrage")
    } catch let error as SessionHostError {
        #expect(error == .readyFrameMissing)
    }
    #expect(host.state == .failed(message: expected))

    // L'arrêt technique escalade jusqu'au signal, et la sortie est délivrée par le
    // `terminationHandler` du process : l'échec doit tenir jusqu'au bout.
    #expect(await waitUntil { host.journal.contains { $0.message.contains("process terminé après un échec") } })
    #expect(host.state == .failed(message: expected))
    #expect(!transport.isRunning)
    #expect(host.pid == nil)
}

@MainActor
@Test("client-rpc-omp/AC-14 : un binaire introuvable échoue sans lancer de process")
func missingBinaryFailsWithoutLaunching() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let failure = SessionHostError.binaryNotFound(searched: ["/nonexistent/omp"], override: nil)
    let host = makeHost(transport, resolve: { _ in .failure(failure) })

    do {
        try await host.start(mode: .rpc, projectRoot: project, resume: false)
        Issue.record("un binaire introuvable doit lever")
    } catch let error as SessionHostError {
        #expect(error == failure)
    }
    #expect(host.state == .failed(message: failure.userMessage))
    #expect(transport.startedWith == nil)
    #expect(transport.written.isEmpty)
    #expect(host.pid == nil)
}

@MainActor
@Test("client-rpc-omp/AC-14 : un dossier de projet disparu n'est pas lancé")
func missingProjectDirectoryIsNotLaunched() async throws {
    let transport = ScriptedRpcTransport()
    let host = makeHost(transport)
    let missing = URL(fileURLWithPath: "/nonexistent/project-\(UUID().uuidString)")

    try await host.start(mode: .rpc, projectRoot: missing, resume: false)

    #expect(host.state == .failed(message: "Le dossier du projet n'existe plus : \(missing.path)."))
    #expect(transport.startedWith == nil)
    #expect(transport.written.isEmpty)
}

// MARK: - S-3 : corrélation et délais

@MainActor
@Test("client-rpc-omp/AC-3 : deux requêtes en vol sont rattachées à leur identifiant malgré l'ordre inverse")
func responsesAreCorrelatedById() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)

    var getStateLines: [String] = []
    transport.onWrite = { [weak transport] line in
        guard let transport, field("type", in: line) == "get_state" else { return }
        getStateLines.append(line)
        guard getStateLines.count == 2 else { return }
        // Réponses émises dans l'ordre INVERSE de l'émission (S-3).
        for (index, request) in getStateLines.enumerated().reversed() {
            guard let requestId = field("id", in: request) else { continue }
            transport.emit(responseLine(
                id: requestId,
                command: "get_state",
                data: ["sessionId": "s\(index)"]
            ))
        }
    }

    let outboundBaseline = host.transcript.filter { $0.kind == .outbound }.count
    let inboundBaseline = host.transcript.filter { $0.kind == .inbound }.count

    async let first = host.getState()
    async let second = host.getState()
    let firstResponse = try await first
    let secondResponse = try await second

    #expect(getStateLines.count == 2)
    let sentIds = getStateLines.compactMap { field("id", in: $0) }
    #expect(Set(sentIds).count == 2)
    #expect(Set([firstResponse.id, secondResponse.id].compactMap { $0 }) == Set(sentIds))
    // Chaque appelant reçoit le `data` de SA requête, pas celui arrivé en premier.
    for response in [firstResponse, secondResponse] {
        guard let index = sentIds.firstIndex(of: response.id ?? "") else {
            Issue.record("réponse sans identifiant émis")
            continue
        }
        #expect(response.data?["sessionId"]?.stringValue == "s\(index)")
    }
    // La transcription montre deux émissions et deux réceptions.
    #expect(host.transcript.filter { $0.kind == .outbound }.count == outboundBaseline + 2)
    #expect(host.transcript.filter { $0.kind == .inbound }.count == inboundBaseline + 2)
}

@MainActor
@Test("client-rpc-omp/AC-13 : une commande sans réponse expire et la session reste vivante")
func commandTimeoutKeepsSessionAlive() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project, requestTimeout: .milliseconds(120))

    transport.onWrite = nil
    do {
        _ = try await host.getState()
        Issue.record("une commande sans réponse doit lever requestTimedOut")
    } catch let error as SessionHostError {
        guard case .requestTimedOut(let command, let seconds) = error else {
            Issue.record("attendu requestTimedOut, obtenu \(error)")
            return
        }
        #expect(command == "get_state")
        #expect(seconds > 0 && seconds <= 0.5)
        #expect(error.userMessage.contains("Aucune réponse à « get_state »"))
        #expect(error.userMessage.contains("la session reste vivante."))
    }

    #expect(host.state == .running)
    #expect(host.transcript.contains { $0.kind == .clientError && $0.text.hasPrefix("! Aucune réponse à « get_state »") })
    #expect(host.journal.contains { $0.kind == .clientError && $0.message.contains("Aucune réponse à « get_state »") })

    // La session reste utilisable : la commande suivante reçoit sa réponse.
    installStandardResponder(transport)
    let response = try await host.getState()
    #expect(response.success)
    #expect(response.data?["sessionFile"]?.stringValue == defaultSessionFile)
}

@MainActor
@Test("client-rpc-omp/AC-13 : une réponse success:false est rapportée sans tuer la session")
func failedResponseIsReported() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)

    transport.onWrite = { [weak transport] line in
        guard let transport, field("type", in: line) == "get_state", let id = field("id", in: line) else { return }
        transport.emit(responseLine(id: id, command: "get_state", success: false, error: "indisponible"))
    }

    do {
        _ = try await host.getState()
        Issue.record("une réponse en échec doit lever")
    } catch let error as SessionHostError {
        #expect(error == .commandFailed(command: "get_state", error: "indisponible", code: nil))
        #expect(error.userMessage == "La commande « get_state » a échoué : indisponible.")
    }
    #expect(host.state == .running)
    #expect(host.journal.contains { $0.kind == .clientError })
}

@MainActor
@Test("client-rpc-omp/AC-13 : la mort avec une commande en vol la solde en processDied")
func deathSettlesPendingCommands() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project, requestTimeout: .seconds(3))
    transport.onWrite = nil
    let exit = ProcessExit(status: 9, reason: .uncaughtSignal)

    async let pending = host.getState()
    #expect(await waitUntil { transport.written.filter { $0.contains("\"get_state\"") }.count == 2 })
    transport.emitExit(exit)

    do {
        _ = try await pending
        Issue.record("une commande en vol doit être soldée à la mort du process")
    } catch let error as SessionHostError {
        guard case .processDied(let command) = error else {
            Issue.record("attendu processDied, obtenu \(error)")
            return
        }
        #expect(command == "get_state")
    }
    #expect(host.state == .dead(exit: exit))
}

// MARK: - S-4 / S-5 : lignes illisibles, fragments, transcription

@MainActor
@Test("client-rpc-omp/AC-12 : une ligne non-JSON est ignorée, journalisée, et la trame suivante est traitée")
func unparsableLineIsAbsorbed() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)

    transport.emit("ceci n'est pas du JSON")
    transport.emit(#"{"type":"agent_start"}"#)

    #expect(host.journal.contains { $0.kind == .ignoredFrame && $0.message.contains("trame JSONL illisible ignorée") })
    #expect(host.transcript.contains { $0.kind == .inbound && $0.text == #"{"type":"agent_start"}"# })
    #expect(host.state == .running)
}

@MainActor
@Test("client-rpc-omp/AC-12 : une séquence de fragments est délivrée comme une seule réponse")
func chunkedResponseIsDelivered() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)

    transport.onWrite = { [weak transport] line in
        guard let transport, field("type", in: line) == "get_state", let id = field("id", in: line) else { return }
        let payload = responseLine(id: id, command: "get_state", data: ["sessionId": "chunked-1", "sessionFile": "/tmp/chunked.jsonl"])
        for frame in chunkFrames(for: payload, count: 3) {
            transport.emit(frame)
        }
    }

    let response = try await host.getState()
    #expect(response.data?["sessionId"]?.stringValue == "chunked-1")
    #expect(host.sessionFile == "/tmp/chunked.jsonl")
}

@MainActor
@Test("client-rpc-omp/AC-5 : un prompt acquitté et les trames du tour s'affichent dans l'ordre")
func promptRoundTripTranscribesEveryFrame() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)

    transport.onWrite = { [weak transport] line in
        guard let transport, field("type", in: line) == "prompt", let id = field("id", in: line) else { return }
        transport.emit(responseLine(id: id, command: "prompt", data: ["agentInvoked": true]))
    }

    try await host.send(prompt: "Bonjour")
    #expect(transport.written.contains { $0.contains("\"type\":\"prompt\"") && $0.contains("\"message\":\"Bonjour\"") })

    transport.emit(#"{"type":"agent_start"}"#)
    transport.emit(#"{"type":"message_update"}"#)
    transport.emit(#"{"type":"prompt_result","id":"app-2","agentInvoked":true,"status":"completed","sessionSettled":true}"#)

    #expect(host.turnOutcome == TurnOutcome(status: "completed", agentInvoked: true, sessionSettled: true))
    let inbound = host.transcript.filter { $0.kind == .inbound }.map(\.text)
    #expect(inbound.suffix(3) == [
        #"{"type":"agent_start"}"#,
        #"{"type":"message_update"}"#,
        #"{"type":"prompt_result","id":"app-2","agentInvoked":true,"status":"completed","sessionSettled":true}"#,
    ])
    // Aucun délai client ne s'applique à la fin de tour : elle est arrivée après le
    // `send`, sans que rien n'expire.
    #expect(host.state == .running)
}

@MainActor
@Test("client-rpc-omp/AC-5 : un prompt vide n'est pas envoyé")
func emptyPromptIsNotSent() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)
    let baseline = transport.written.count

    do {
        try await host.send(prompt: "   ")
        Issue.record("un prompt vide doit lever emptyPrompt")
    } catch let error as SessionHostError {
        #expect(error == .emptyPrompt)
        #expect(error.userMessage == "Le prompt est vide.")
    }
    #expect(transport.written.count == baseline)
}

@MainActor
@Test("client-rpc-omp/AC-5 : un prompt hors session lève notRunning sans rien écrire")
func promptOutsideSessionThrows() async throws {
    let transport = ScriptedRpcTransport()
    let host = makeHost(transport)

    do {
        try await host.send(prompt: "Bonjour")
        Issue.record("un prompt hors session doit lever notRunning")
    } catch let error as SessionHostError {
        #expect(error == .notRunning)
        #expect(error.userMessage == "Aucune session vivante.")
    }
    #expect(transport.written.isEmpty)
}

// MARK: - S-6 : dialogues

@MainActor
@Test("client-rpc-omp/AC-8 : les quatre méthodes répondent avec leur identifiant et leur seul champ")
func fourDialogMethodsAnswerWithExactFields() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)
    let baseline = transport.written.count

    transport.emit(dialogLine(id: "d-select", method: "select", extra: [
        "title": "Choisis une couleur",
        "options": ["rouge", "bleu"],
        "optionDetails": [["description": "chaud"], ["description": "froid"]],
    ]))
    transport.emit(dialogLine(id: "d-confirm", method: "confirm", extra: ["title": "Confirmer", "message": "Sûr ?"]))
    transport.emit(dialogLine(id: "d-input", method: "input", extra: ["title": "Ton nom", "placeholder": "nom"]))
    transport.emit(dialogLine(id: "d-editor", method: "editor", extra: ["title": "Texte", "prefill": "déjà là"]))

    #expect(host.dialogQueue.count == 4)
    #expect(host.dialogQueue[0].method == .select)
    #expect(host.dialogQueue[0].title == "Choisis une couleur")
    #expect(host.dialogQueue[0].options == ["rouge", "bleu"])
    #expect(host.dialogQueue[0].optionDescriptions == ["chaud", "froid"])
    #expect(host.dialogQueue[3].prefill == "déjà là")

    try host.answer(.value(id: "d-select", value: "bleu"))
    try host.answer(.confirmed(id: "d-confirm", confirmed: true))
    // La valeur part TELLE QUELLE : l'espace final n'est pas rogné (S-6).
    try host.answer(.value(id: "d-input", value: "Millian "))
    try host.answer(.value(id: "d-editor", value: "texte édité"))

    let written = Array(transport.written.dropFirst(baseline))
    #expect(written.count == 4)
    #expect(keys(in: written[0]) == ["type", "id", "value"])
    #expect(field("id", in: written[0]) == "d-select")
    #expect(field("value", in: written[0]) == "bleu")
    #expect(keys(in: written[1]) == ["type", "id", "confirmed"])
    #expect(field("id", in: written[1]) == "d-confirm")
    #expect(boolField("confirmed", in: written[1]) == true)
    #expect(keys(in: written[2]) == ["type", "id", "value"])
    #expect(field("id", in: written[2]) == "d-input")
    #expect(field("value", in: written[2]) == "Millian ")
    #expect(keys(in: written[3]) == ["type", "id", "value"])
    #expect(field("value", in: written[3]) == "texte édité")
    // Un dialogue répondu quitte la file ; les quatre sont partis.
    #expect(host.dialogQueue.isEmpty)
}

@MainActor
@Test("client-rpc-omp/AC-7 : une demande select affiche la question et la réponse corrélée débloque le tour")
func selectDialogUnblocksTurn() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project, mode: .rpcUI)

    transport.onWrite = { [weak transport] line in
        guard let transport, let type = field("type", in: line), let id = field("id", in: line) else { return }
        if type == "prompt" {
            transport.emit(responseLine(id: id, command: "prompt", data: ["agentInvoked": true]))
        }
    }
    try await host.send(prompt: "demande-moi une couleur")

    transport.emit(dialogLine(id: "ask-1", method: "select", extra: [
        "title": "Choisis une couleur",
        "options": ["rouge", "bleu", "Other (type your own)"],
    ]))
    #expect(host.dialogQueue.count == 1)
    #expect(host.dialogQueue[0].options.count == 3)

    try host.answer(.value(id: "ask-1", value: "rouge"))
    #expect(host.dialogQueue.isEmpty)
    #expect(transport.written.last.map { field("value", in: $0) } == "rouge")

    transport.emit(#"{"type":"prompt_result","id":"app-2","agentInvoked":true,"status":"completed","sessionSettled":true}"#)
    #expect(host.turnOutcome?.status == "completed")
}

@MainActor
@Test("client-rpc-omp/AC-9 : un dialogue sans réponse n'est jamais annulé par le client")
func unansweredDialogIsNeverCancelled() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)
    let baseline = transport.written.count

    // `timeout` présent dans la trame : c'est le SERVEUR qui tranche à l'expiration,
    // jamais le client (S-6).
    transport.emit(dialogLine(id: "d-timeout", method: "select", extra: [
        "title": "Choisis",
        "options": ["a", "b"],
        "timeout": 50,
    ]))
    try await Task.sleep(for: .milliseconds(300))

    #expect(host.dialogQueue.count == 1)
    #expect(host.state == .running)
    #expect(transport.written.count == baseline)
}

@MainActor
@Test("client-rpc-omp/AC-9 : présentation, annulation par la session et méthode inconnue n'écrivent jamais")
func presentationAndCancellationNeverWrite() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)
    let baseline = transport.written.count

    transport.emit(dialogLine(id: "d1", method: "select", extra: ["title": "T", "options": ["a"]]))
    transport.emit(#"{"type":"extension_ui_request","method":"notify","message":"coucou"}"#)
    transport.emit(dialogLine(id: "c1", method: "cancel", extra: ["targetId": "d1"]))
    transport.emit(#"{"type":"extension_ui_request","id":"x","method":"inconnue"}"#)

    #expect(host.dialogQueue.isEmpty)
    #expect(transport.written.count == baseline)
    #expect(host.journal.contains { $0.kind == .presentation && $0.message.contains("présentation notify") })
    #expect(host.journal.contains { $0.kind == .protocol && $0.message.contains("dialogue d1 annulé par la session") })
    #expect(host.journal.contains { $0.kind == .protocol && $0.message.contains("trame de type inconnu") })
}

@MainActor
@Test("client-rpc-omp/AC-9 : répondre à un dialogue absent n'écrit rien")
func answeringMissingDialogWritesNothing() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)
    let baseline = transport.written.count

    do {
        try host.answer(.cancelled(id: "inconnu"))
        Issue.record("un dialogue absent doit lever dialogNotPending")
    } catch let error as SessionHostError {
        #expect(error == .dialogNotPending)
        #expect(error.userMessage == "Aucun dialogue en attente.")
    }

    transport.emit(dialogLine(id: "d1", method: "select", extra: ["title": "T", "options": ["a"]]))
    try host.answer(.value(id: "d1", value: "a"))
    do {
        try host.answer(.value(id: "d1", value: "a"))
        Issue.record("un dialogue déjà répondu doit lever dialogNotPending")
    } catch let error as SessionHostError {
        #expect(error == .dialogNotPending)
    }
    #expect(transport.written.count == baseline + 1)
}

// MARK: - S-7 : mort et relance

@MainActor
@Test("client-rpc-omp/AC-10 : la mort non demandée bascule sur dead sans action de l'utilisateur")
func unsolicitedDeathSetsDead() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)
    let exit = ProcessExit(status: 9, reason: .uncaughtSignal)

    transport.emitExit(exit)

    #expect(host.state == .dead(exit: exit))
    #expect(host.pid == nil)
    #expect(host.journal.contains { $0.kind == .processExit && $0.message.contains("process terminé sans arrêt demandé (signal 9)") })

    let baseline = transport.written.count
    do {
        try await host.send(prompt: "encore")
        Issue.record("une session morte ne reçoit plus de prompt")
    } catch let error as SessionHostError {
        #expect(error == .notRunning)
    }
    #expect(transport.written.count == baseline)
}

@MainActor
@Test("client-rpc-omp/AC-11 : la relance est manuelle, refusée hors dead, et reprend le même .jsonl")
func relaunchIsManualAndResumes() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)
    let exit = ProcessExit(status: 9, reason: .uncaughtSignal)

    // Refusée tant que la session vit.
    do {
        try await host.relaunch()
        Issue.record("une relance sur session vivante doit lever alreadyRunning")
    } catch let error as SessionHostError {
        #expect(error == .alreadyRunning)
    }

    transport.emitExit(exit)
    #expect(host.state == .dead(exit: exit))

    // Aucune relance automatique : sans geste, rien ne redémarre.
    try await Task.sleep(for: .milliseconds(200))
    #expect(transport.startCount == 1)
    #expect(host.state == .dead(exit: exit))

    try await host.relaunch()
    #expect(transport.startCount == 2)
    #expect(transport.startedWith?.arguments.contains("--resume") == true)
    #expect(transport.startedWith?.arguments.last == defaultSessionFile)
    #expect(host.state == .running)
    #expect(host.sessionFile == defaultSessionFile)
    #expect(host.sessionId == "session-abcdef12")
}

@MainActor
@Test("client-rpc-omp/AC-11 : une relance sans fichier de session connu démarre à neuf")
func relaunchWithoutSessionFileStartsFresh() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    installStandardResponder(transport, sessionFile: nil, sessionId: nil)
    transport.readyLine = readyLine()
    let host = makeHost(transport)
    try await host.start(mode: .rpc, projectRoot: project, resume: false)
    transport.emitExit(ProcessExit(status: 9, reason: .uncaughtSignal))

    installStandardResponder(transport)
    try await host.relaunch()

    #expect(transport.startedWith?.arguments.contains("--resume") == false)
    #expect(host.journal.contains { $0.kind == .protocol && $0.message.contains("aucun fichier de session connu : relance à neuf") })
    #expect(host.state == .running)
}

// MARK: - S-8 : arrêt propre

@MainActor
@Test("client-rpc-omp/AC-15 : l'arrêt ferme stdin avant toute escalade et termine en stopped")
func cleanStopClosesStdinFirst() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)
    transport.onCloseStdin = { [weak transport] in
        transport?.emitExit(ProcessExit(status: 0, reason: .exited))
    }

    await host.stop()

    #expect(transport.closeStdinCount == 1)
    #expect(transport.signals.isEmpty)
    #expect(host.state == .stopped)
    #expect(host.journal.contains { $0.kind == .processExit && $0.message.contains("session arrêtée : stdin fermé, sortie code 0") })

    // Idempotence : un second arrêt ne rejoue rien.
    await host.stop()
    #expect(transport.closeStdinCount == 1)
    #expect(transport.signals.isEmpty)
}

@MainActor
@Test("client-rpc-omp/AC-15 : un process qui ignore la fermeture de stdin est escaladé sans orphelin")
func stopEscalatesWhenProcessIgnoresStdin() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)

    await host.stop()

    #expect(transport.signals == [SIGTERM, SIGKILL])
    #expect(host.state == .stopped)
    #expect(host.journal.contains { $0.kind == .processExit && $0.message.contains("arrêt forcé (SIGTERM)") })
    #expect(host.journal.contains { $0.kind == .processExit && $0.message.contains("arrêt forcé (SIGKILL)") })

    // `stopped` n'est pas `dead` : la relance y est refusée (S-7).
    do {
        try await host.relaunch()
        Issue.record("une session arrêtée n'a rien à relancer")
    } catch let error as SessionHostError {
        #expect(error == .notRunning)
    }
}

@MainActor
@Test("client-rpc-omp/AC-16 : la fermeture de l'app suit exactement la séquence du bouton")
func quitTerminationMatchesStop() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = try await startedHost(transport, projectRoot: project)
    transport.onCloseStdin = { [weak transport] in
        transport?.emitExit(ProcessExit(status: 0, reason: .exited))
    }

    await host.terminateForQuit()

    #expect(transport.closeStdinCount == 1)
    #expect(transport.signals.isEmpty)
    #expect(host.state == .stopped)
    #expect(host.pid == nil)
}
