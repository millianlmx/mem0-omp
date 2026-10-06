// Preuves du MODÈLE de la fenêtre « Session OMP » (S-9) : le statut et la cible
// du raccourci ⌘. — les deux comportements observables que la revue a bloqués.
//
// Ces tests existent parce que S-9 n'avait AUCUNE preuve automatisée (sa preuve
// était la recette manuelle) : les deux défauts relevés (statut sans identifiant
// de session après `get_state` ; ⌘. qui arrêtait la session au lieu d'annuler le
// dialogue en attente) tiennent tous deux dans le modèle, donc s'y prouvent sans
// ouvrir de fenêtre.

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

// MARK: - Outils (trames JSONL et pilotage du transport scripté)

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

private func readyLine() -> String {
    jsonLine([
        "type": "ready",
        "protocolVersion": 1,
        "supportedProtocolVersions": [1, 2],
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
    var object: [String: Any] = ["type": "extension_ui_request", "method": method, "id": id]
    object.merge(extra) { _, new in new }
    return jsonLine(object)
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
private func makeProjectDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("omp-model-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

@MainActor
private func makeHost(_ transport: ScriptedRpcTransport) -> SessionHost {
    SessionHost(
        transport: transport,
        resolveBinary: { _ in .success(URL(fileURLWithPath: "/usr/bin/true")) },
        environment: [:],
        requestTimeout: .seconds(1),
        readyTimeout: .seconds(1),
        stopGrace: .milliseconds(80),
        killGrace: .milliseconds(80)
    )
}

/// Modèle branché sur un host scripté et sur des `UserDefaults` jetables : le
/// projet est CHOISI dans le magasin de test, jamais deviné depuis le cwd.
@MainActor
private func makeModel(host: SessionHost, projectRoot: URL) -> SessionConsoleModel {
    let suite = UserDefaults(suiteName: "session-console-model-\(UUID().uuidString)") ?? .standard
    suite.set(projectRoot.path, forKey: SessionConsoleModel.projectRootKey)
    return SessionConsoleModel(host: host, defaults: suite)
}

// MARK: - S-9 : statut de la session vivante

@MainActor
@Test("omp-console-redesign/HIG : le statut d'une session active ne répète pas l'état et ne montre ni pid ni identifiant")
func runningStatusShowsNoTechnicalIdentity() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = makeHost(transport)
    let model = makeModel(host: host, projectRoot: project)
    #expect(model.projectRoot?.path == project.path)
    #expect(model.canLaunch)

    // La poignée de main est répondue, la réponse de `get_state` est RETENUE :
    // le statut est vérifié avant, puis après la publication de l'identifiant.
    var pendingStateId: String?
    transport.readyLine = readyLine()
    transport.onWrite = { line in
        guard let type = field("type", in: line), let id = field("id", in: line) else { return }
        switch type {
        case "negotiate_protocol":
            transport.emit(responseLine(id: id, command: "negotiate_protocol", data: ["protocolVersion": 2]))
        case "get_state":
            pendingStateId = id
        default:
            break
        }
    }

    model.launch()
    #expect(await waitUntil { host.state == .running })
    #expect(await waitUntil { model.statusMessage == SessionConsoleModel.statusText(for: .running) })
    #expect(model.statusNotice == nil)
    #expect(!model.statusMessage.contains("4242"))

    // `get_state` répond : `sessionId` est publié SANS changement d'état.
    let stateId = try #require(pendingStateId)
    transport.emit(responseLine(id: stateId, command: "get_state", data: [
        "sessionId": "session-abcdef12",
        "sessionFile": "/tmp/omp-model-\(UUID().uuidString).jsonl",
    ]))

    #expect(await waitUntil { host.sessionId == "session-abcdef12" })
    #expect(host.state == .running)
    #expect(model.statusNotice == nil)
    #expect(!model.statusMessage.contains("session-"))
}

// MARK: - S-9 : cible du raccourci ⌘.

@MainActor
@Test("client-rpc-omp/AC-9 : ⌘. annule le dialogue en attente, et n'arrête la session que sans dialogue")
func stopShortcutCancelsPendingDialog() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    transport.readyLine = readyLine()
    transport.onWrite = { line in
        guard let type = field("type", in: line), let id = field("id", in: line) else { return }
        switch type {
        case "negotiate_protocol":
            transport.emit(responseLine(id: id, command: "negotiate_protocol", data: ["protocolVersion": 2]))
        case "get_state":
            transport.emit(responseLine(id: id, command: "get_state", data: [
                "sessionId": "session-abcdef12",
                "sessionFile": "/tmp/omp-model-\(UUID().uuidString).jsonl",
            ]))
        default:
            break
        }
    }
    let host = makeHost(transport)
    let model = makeModel(host: host, projectRoot: project)
    transport.onCloseStdin = { transport.emitExit(ProcessExit(status: 0, reason: .exited)) }

    model.launch()
    #expect(await waitUntil { host.state == .running })

    transport.emit(dialogLine(id: "d-select", method: "select", extra: [
        "title": "Choisis une couleur",
        "options": ["rouge", "bleu"],
    ]))
    #expect(await waitUntil { model.hasPendingDialog })
    // Le bouton d'arrêt reste disponible À LA SOURIS pendant le dialogue (S-9).
    #expect(model.canStop)

    let baseline = transport.written.count
    model.performStopShortcut()

    // AC-9 : l'annulation est un geste EXPLICITE, corrélé au dialogue, et elle
    // n'arrête ni ne coupe la session.
    let written = Array(transport.written.dropFirst(baseline))
    #expect(written.count == 1)
    #expect(field("type", in: written[0]) == "extension_ui_response")
    #expect(field("id", in: written[0]) == "d-select")
    #expect(boolField("cancelled", in: written[0]) == true)
    #expect(transport.closeStdinCount == 0)
    #expect(transport.signals.isEmpty)
    #expect(host.state == .running)
    #expect(!model.hasPendingDialog)

    // Sans dialogue en attente, le même raccourci arrête la session.
    model.performStopShortcut()
    #expect(await waitUntil { host.state == .stopped })
    #expect(transport.closeStdinCount == 1)
}

// MARK: - S-9 : disponibilités (le « Lancer » unique et le prompt bloqué)

@MainActor
@Test("client-rpc-omp/AC-2 : l'état vivant interdit un second lancement, et un dialogue bloque le prompt")
func modelGatesLaunchAndPrompt() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    transport.readyLine = readyLine()
    transport.onWrite = { line in
        guard let type = field("type", in: line), let id = field("id", in: line) else { return }
        if type == "negotiate_protocol" {
            transport.emit(responseLine(id: id, command: "negotiate_protocol", data: ["protocolVersion": 2]))
        } else if type == "get_state" {
            transport.emit(responseLine(id: id, command: "get_state", data: ["sessionId": "session-abcdef12"]))
        }
    }
    let host = makeHost(transport)
    let model = makeModel(host: host, projectRoot: project)

    #expect(model.canLaunch)
    #expect(!model.canSendPrompt)

    model.launch()
    #expect(await waitUntil { host.state == .running })
    // AC-2 : « Lancer la session » est inactif dès qu'une session vit.
    #expect(!model.canLaunch)
    #expect(model.canStop)

    model.prompt = "bonjour"
    #expect(model.canSendPrompt)

    transport.emit(dialogLine(id: "d-select", method: "select", extra: [
        "title": "Couleur",
        "options": ["rouge", "bleu"],
    ]))
    #expect(await waitUntil { model.hasPendingDialog })
    // Le tour est bloqué par le dialogue : plus de prompt tant qu'on n'a pas répondu.
    #expect(!model.canSendPrompt)
    // `select` sans choix : « Répondre » reste inactif (S-6).
    model.selectedOptionIndex = nil
    #expect(!model.canAnswerDialog)
    model.selectedOptionIndex = 1
    #expect(model.canAnswerDialog)

    model.answerSelectedOption()
    #expect(await waitUntil { !model.hasPendingDialog })
    #expect(model.canSendPrompt)
}

// MARK: - transport-rpc-bloquant-sans-sigpipe : ce que l'utilisateur voit

@MainActor
@Test("transport-rpc-bloquant-sans-sigpipe/AC-3 : le modèle affiche le message exact d'une écriture impossible")
func modelShowsWriteFailureMessage() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    transport.readyLine = readyLine()
    transport.onWrite = { line in
        guard let type = field("type", in: line), let id = field("id", in: line) else { return }
        switch type {
        case "negotiate_protocol":
            transport.emit(responseLine(id: id, command: "negotiate_protocol", data: ["protocolVersion": 2]))
        case "get_state":
            transport.emit(responseLine(id: id, command: "get_state", data: ["sessionId": "session-abcdef12"]))
        default:
            break
        }
    }
    let host = makeHost(transport)
    let model = makeModel(host: host, projectRoot: project)

    model.launch()
    #expect(await waitUntil { host.state == .running })
    #expect(model.canSendPrompt == false)

    model.prompt = "bonjour"
    #expect(model.canSendPrompt)
    transport.writeFailure = .writeFailed(32)
    model.sendPrompt()

    // « l'utilisateur voit » : c'est le texte affiché par la fenêtre, produit par
    // `SessionHostError.userMessage` et par elle seule.
    let expected = "Écriture impossible vers la session : le process ne lit plus son entrée (EPIPE)."
    #expect(await waitUntil { model.statusMessage == expected })
    #expect(host.state == .running)
    // L'échec ne répète pas l'état : l'inspecteur le montre.
    #expect(model.statusNotice == expected)
}

// MARK: - omp-console-redesign S-15 : la conversation de Session OMP

@MainActor
@Test("omp-console-redesign/S-15 : la conversation de Session OMP suit le fichier de session de l'hôte")
func conversationFollowsHostSessionFile() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedRpcTransport()
    let host = makeHost(transport)
    let suite = UserDefaults(suiteName: "session-console-model-\(UUID().uuidString)") ?? .standard
    suite.set(project.path, forKey: SessionConsoleModel.projectRootKey)
    let model = SessionConsoleModel(
        host: host,
        defaults: suite,
        makeConversation: { SessionViewerModel(target: $0, watch: false) }
    )
    let file = "/tmp/omp-conversation-\(UUID().uuidString).jsonl"

    var pendingStateId: String?
    transport.readyLine = readyLine()
    transport.onWrite = { line in
        guard let type = field("type", in: line), let id = field("id", in: line) else { return }
        switch type {
        case "negotiate_protocol":
            transport.emit(responseLine(id: id, command: "negotiate_protocol", data: ["protocolVersion": 2]))
        case "get_state":
            pendingStateId = id
        default:
            break
        }
    }

    // Avant la réponse de `get_state`, aucun fichier n'est connu : pas de conversation.
    model.launch()
    #expect(await waitUntil { host.state == .running && pendingStateId != nil })
    #expect(model.conversation == nil)

    let firstId = try #require(pendingStateId)
    pendingStateId = nil
    transport.emit(responseLine(id: firstId, command: "get_state", data: [
        "sessionId": "session-abcdef12",
        "sessionFile": file,
    ]))
    #expect(await waitUntil { model.conversation?.target.sessionFile == file })
    let first = try #require(model.conversation)

    // Un second `get_state` au MÊME fichier garde la même conversation.
    let refresh = Task { @MainActor in await host.refreshState() }
    #expect(await waitUntil { pendingStateId != nil })
    let secondId = try #require(pendingStateId)
    transport.emit(responseLine(id: secondId, command: "get_state", data: [
        "sessionId": "session-abcdef12",
        "sessionFile": file,
    ]))
    await refresh.value
    try await Task.sleep(for: .milliseconds(50))
    #expect(model.conversation === first)
    #expect(host.sessionFile == file)
}

@Test("omp-console-redesign/S-15 : l'état de la session se dit en mots")
func sessionStateIsSaidInWords() {
    let exit = ProcessExit(status: 9, reason: .uncaughtSignal)
    let expected: [(SessionHost.State, String, String)] = [
        (.idle, "Prête", "Aucun projet"),
        (.launching, "Démarrage…", "Démarrage…"),
        (.running, "Active", "Active"),
        (.stopping, "Arrêt…", "Arrêt…"),
        (.stopped, "Arrêtée", "Arrêtée"),
        (.dead(exit: exit), "Interrompue", "Interrompue"),
        (.failed(message: "omp introuvable"), "Échec", "Échec"),
    ]
    for (state, withProject, withoutProject) in expected {
        #expect(SessionConsoleText.stateTitle(state, hasProject: true) == withProject)
        #expect(SessionConsoleText.stateTitle(state, hasProject: false) == withoutProject)
    }
}
