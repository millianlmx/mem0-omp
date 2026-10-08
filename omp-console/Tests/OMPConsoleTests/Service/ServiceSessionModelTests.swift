// Preuves de la session servie (BR-6, S-6, S-10) : trames SSE, réponse de dialogue
// qui poursuit le tour, reconnexion après coupure, et « service arrêté » sur les
// trois surfaces qui l'affichent.
//
// Aucun process : le transport scripté fournit les réponses et les flux.

import Foundation
import Testing
@testable import OMPConsole

@MainActor
private func waitUntil(timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}

private func makeProjectDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("omp-session-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Stub la création de session, commune à toutes les preuves.
private func stubSession(_ transport: ScriptedServiceTransport, id: String = "sess-1", file: String? = "/tmp/s.jsonl") {
    transport.stubJSON("POST", "/v1/sessions", [
        "id": id, "cwd": "/tmp/repo", "purpose": "session", "state": "idle",
        "sessionFile": file as Any,
    ])
}

@MainActor
private func makeModel(_ transport: ScriptedServiceTransport, purpose: String = "session") -> ServiceSessionModel {
    ServiceSessionModel(
        purpose: purpose,
        makeClient: { scriptedClient(transport) },
        maxAttempts: 5,
        retryDelay: { _ in .milliseconds(1) }
    )
}

@MainActor
@Test("coque-service : la session s'ouvre, reçoit ses trames et publie son état")
func sessionReceivesFrames() async throws {
    let transport = ScriptedServiceTransport()
    stubSession(transport)
    transport.stubJSON("GET", "/v1/sessions/sess-1", [
        "id": "sess-1", "cwd": "/tmp/repo", "purpose": "session", "state": "running",
        "sessionFile": "/tmp/s.jsonl",
    ])
    var stream: [String] = []
    stream += serviceFrame("state", ["state": "running"])
    stream += serviceFrame("notice", ["level": "info", "message": "## Plan"])
    stream += serviceFrame("dialog", [
        "id": "d1", "method": "select", "title": "Choisir",
        "options": ["a", "b"], "optionDescriptions": [NSNull(), NSNull()],
    ])
    stream += serviceFrame("prompt_end", ["status": "completed"])
    transport.scriptStream(stream, keepOpen: true)

    let model = makeModel(transport)
    try await model.start(projectRoot: try makeProjectDirectory(), resumeFile: nil)
    #expect(model.sessionId == "sess-1")
    #expect(model.sessionFile == "/tmp/s.jsonl")

    let gotDialog = await waitUntil { model.dialogQueue.count == 1 }
    #expect(gotDialog)
    #expect(model.dialogQueue.first?.id == "d1")
    #expect(model.lastNotice == "## Plan")
}

@MainActor
@Test("coque-service : répondre à un dialogue le retire de la file et poursuit le tour")
func answerDialogRemovesItFromQueue() async throws {
    let transport = ScriptedServiceTransport()
    stubSession(transport)
    transport.stubJSON("POST", "/v1/sessions/sess-1/dialogs/d1", ["accepted": true])
    transport.scriptStream(serviceFrame("dialog", [
        "id": "d1", "method": "confirm", "title": "Confirmer ?", "options": [],
    ]), keepOpen: true)

    let model = makeModel(transport)
    try await model.start(projectRoot: try makeProjectDirectory(), resumeFile: nil)
    #expect(await waitUntil { model.dialogQueue.count == 1 })

    try await model.answer(.confirmed(id: "d1", confirmed: true))
    #expect(model.dialogQueue.isEmpty)
    let body = transport.requests.last?.body
    #expect(body?["confirmed"] as? Bool == true)
    #expect(transport.requests.last?.path.hasSuffix("/dialogs/d1") == true)
}

@MainActor
@Test("coque-service : une coupure du flux est retentée, les trames suivantes arrivent")
func streamReconnectsAfterCut() async throws {
    let transport = ScriptedServiceTransport()
    stubSession(transport)
    transport.scriptStream(serviceFrame("state", ["state": "running"]))
    transport.scriptStream(serviceFrame("notice", ["level": "warning", "message": "reprise"]))
    transport.scriptStream(serviceFrame("state", ["state": "running"]), keepOpen: true)

    let model = makeModel(transport)
    try await model.start(projectRoot: try makeProjectDirectory(), resumeFile: nil)
    #expect(await waitUntil { model.lastNotice == "reprise" })
    #expect(transport.streamOpenCount >= 2)
    #expect(model.state == .running)
}

@MainActor
@Test("coque-service : un service qui ferme le flux passe la session en échec, sans tuer de process")
func streamExhaustedGoesDead() async throws {
    // Un seul flux scripté, deux ouvertures possibles : après la coupure, la
    // seconde ouverture lève « unavailable ».
    let transport = ScriptedServiceTransport()
    stubSession(transport)
    transport.scriptStream(serviceFrame("state", ["state": "running"]))

    let model = makeModel(transport)
    try await model.start(projectRoot: try makeProjectDirectory(), resumeFile: nil)
    #expect(await waitUntil { model.state == .dead })
    #expect(model.sessionId != nil)
}

@MainActor
@Test("coque-service : un service absent à l'ouverture affiche « service arrêté »")
func missingServiceFailsWithStoppedText() async throws {
    let model = ServiceSessionModel(
        purpose: "session",
        makeClient: { throw ServiceUnavailable.stopped },
        retryDelay: { _ in .milliseconds(1) }
    )
    await #expect(throws: ServiceUnavailable.stopped) {
        try await model.start(projectRoot: try makeProjectDirectory(), resumeFile: nil)
    }
    #expect(model.state == .failed(message: "service arrêté"))
}

@MainActor
@Test("coque-service : la fenêtre « Session OMP » affiche « service arrêté » au lancement")
func sessionConsoleSurfacesStopped() async throws {
    let model = ServiceSessionModel(
        purpose: "session",
        makeClient: { throw ServiceUnavailable.stopped },
        retryDelay: { _ in .milliseconds(1) }
    )
    let console = SessionConsoleModel(
        host: model,
        defaults: UserDefaults(suiteName: "session-\(UUID().uuidString)") ?? .standard
    )
    console.projectRoot = try makeProjectDirectory()
    console.launch()
    #expect(await waitUntil { console.statusMessage == "service arrêté" })
    #expect(console.host.dialogQueue.isEmpty)
}

@MainActor
@Test("coque-service : l'arrêt ferme la session par DELETE et coupe le flux")
func stopClosesSession() async throws {
    let transport = ScriptedServiceTransport()
    stubSession(transport)
    transport.stubJSON("DELETE", "/v1/sessions/sess-1", ["closed": true])
    transport.scriptStream([])

    let model = makeModel(transport)
    try await model.start(projectRoot: try makeProjectDirectory(), resumeFile: nil)
    await model.stop()
    #expect(model.state == .stopped)
    #expect(transport.requests.contains { $0.method == "DELETE" })
}

@MainActor
@Test("coque-service : la conduite s'ouvre par POST /projects/{repo}/conduite")
func conduiteStartsThroughRoute() async throws {
    let transport = ScriptedServiceTransport()
    transport.stubJSON("POST", "/conduite", ["sessionId": "proj-1", "state": "running"])
    transport.stubJSON("GET", "/v1/sessions/proj-1", [
        "id": "proj-1", "cwd": "/tmp/repo", "purpose": "project", "state": "running",
        "sessionFile": "/tmp/p.jsonl",
    ])
    transport.scriptStream([])
    let model = makeModel(transport, purpose: "project")
    try await model.startConduite(repoRoot: URL(fileURLWithPath: "/tmp/repo"), name: "socle")
    #expect(model.sessionId == "proj-1")
    let body = transport.requests.first?.body
    #expect(body?["name"] as? String == "socle")
    #expect(transport.requests.first?.path.hasSuffix("/projects//tmp/repo/conduite") == true
        || transport.requests.first?.path.contains("conduite") == true)
}

@MainActor
@Test("coque-service : un 409 de conduite affiche le texte exact du service")
func conduiteConflictShowsServiceText() async throws {
    let transport = ScriptedServiceTransport()
    let reason = "une conduite est déjà vivante pour ce dépôt"
    transport.stubStatus("POST", "/conduite", status: 409, json: ["error": "conflict", "reason": reason])
    let host = makeModel(transport, purpose: "project")
    let project = ProjectConsoleModel(
        host: host,
        stateDir: try makeProjectStateDirForSession(),
        defaults: UserDefaults(suiteName: "conduite-\(UUID().uuidString)") ?? .standard,
        makeConversation: { SessionViewerModel(target: $0, watch: false) }
    )
    let repo = try makeGitRepositoryForSession()
    await project.startConduite(repoRoot: repo, name: "socle")
    #expect(project.statusMessage == reason)
}

@MainActor
@Test("coque-service : la relance reprend la conversation par le CHEMIN de session publié")
func relaunchResumesByPath() async throws {
    let transport = ScriptedServiceTransport()
    stubSession(transport, file: "/tmp/s.jsonl")
    // Un seul flux : il se termine aussitôt et la session meurt — l'état depuis
    // lequel « Relancer » est offert.
    transport.scriptStream(serviceFrame("state", ["state": "running"]))

    let model = makeModel(transport)
    try await model.start(projectRoot: try makeProjectDirectory(), resumeFile: nil)
    #expect(await waitUntil { model.state == .dead })
    #expect(model.sessionFile == "/tmp/s.jsonl")
    #expect(transport.requests.first?.body?["resume"] == nil, "une ouverture NEUVE n'envoie aucun `resume`")

    transport.scriptStream(serviceFrame("state", ["state": "running"]), keepOpen: true)
    try await model.relaunch()

    #expect(model.state == .running)
    let posted = transport.requests.last { $0.method == "POST" && $0.path.hasSuffix("/v1/sessions") }
    #expect(
        posted?.body?["resume"] as? String == "/tmp/s.jsonl",
        "la reprise porte le CHEMIN publié ; un booléen rendrait 400 (« chemin de fichier de session attendu »)"
    )
    await model.stop()
}

@MainActor
@Test("coque-service : le rattachement reconnaît le dépôt sous son chemin RÉEL (lien symbolique)")
func conduiteAttachMatchesResolvedRepoPath() async throws {
    // Le service publie le chemin RÉEL (`realpathOr` de `requireRepo`), l'app tient
    // le chemin choisi : un dépôt ouvert par un LIEN symbolique est le même dépôt.
    let real = try makeGitRepositoryForSession()
    let linkParent = FileManager.default.temporaryDirectory
        .appendingPathComponent("omp-link-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: linkParent, withIntermediateDirectories: true)
    let link = linkParent.appendingPathComponent("repo-link")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)

    let transport = ScriptedServiceTransport()
    transport.stubStatus("POST", "/conduite", status: 409, json: [
        "error": "conflict", "reason": "une conduite vit déjà pour \(real.path) (s1)",
    ])
    transport.stubJSON("GET", "/v1/sessions", ["sessions": [[
        "id": "s1", "cwd": real.path, "purpose": "project", "state": "running", "sessionFile": "/tmp/p.jsonl",
    ]]])
    transport.stubJSON("GET", "/v1/sessions/s1", [
        "id": "s1", "cwd": real.path, "purpose": "project", "state": "running", "sessionFile": "/tmp/p.jsonl",
    ])
    transport.scriptStream(serviceFrame("state", ["state": "running"]), keepOpen: true)

    let model = makeModel(transport, purpose: "project")
    try await model.startConduite(repoRoot: link, name: "socle")

    #expect(model.sessionId == "s1")
    #expect(model.state == .running)
    await model.terminateForQuit()
}

@MainActor
@Test("coque-service : un 409 de conduite rattache la conduite vivante, question en attente comprise")
func conduiteConflictAttachesToLiveConduite() async throws {
    let transport = ScriptedServiceTransport()
    let repo = "/tmp/repo"
    transport.stubStatus("POST", "/conduite", status: 409, json: [
        "error": "conflict", "reason": "une conduite vit déjà pour \(repo) (s1)",
    ])
    transport.stubJSON("GET", "/v1/sessions", ["sessions": [[
        "id": "s1", "cwd": repo, "purpose": "project", "state": "running", "sessionFile": "/tmp/p.jsonl",
    ]]])
    transport.stubJSON("GET", "/v1/sessions/s1", [
        "id": "s1", "cwd": repo, "purpose": "project", "state": "running", "sessionFile": "/tmp/p.jsonl",
    ])
    // L'instantané du flux d'une session rejointe rejoue la question en vol (S-6).
    transport.scriptStream(serviceFrame("dialog", [
        "id": "d-attente", "method": "select", "title": "Une question attend",
        "options": ["A", "B"], "optionDescriptions": [NSNull(), NSNull()],
    ]), keepOpen: true)

    let model = makeModel(transport, purpose: "project")
    try await model.startConduite(repoRoot: URL(fileURLWithPath: repo), name: "socle")

    #expect(model.sessionId == "s1")
    #expect(model.state == .running)
    #expect(model.sessionFile == "/tmp/p.jsonl")
    #expect(await waitUntil { model.dialogQueue.first?.id == "d-attente" })
    #expect(!transport.requests.contains { $0.method == "DELETE" })
    await model.terminateForQuit()
}

@MainActor
@Test("coque-service : la fermeture de l'app laisse la conduite au service (aucun DELETE)")
func quitLeavesConduiteAlive() async throws {
    let transport = ScriptedServiceTransport()
    transport.stubJSON("POST", "/conduite", ["sessionId": "proj-1", "state": "running"])
    transport.stubJSON("GET", "/v1/sessions/proj-1", [
        "id": "proj-1", "cwd": "/tmp/repo", "purpose": "project", "state": "running",
        "sessionFile": "/tmp/p.jsonl",
    ])
    transport.scriptStream(serviceFrame("state", ["state": "running"]), keepOpen: true)

    let model = makeModel(transport, purpose: "project")
    try await model.startConduite(repoRoot: URL(fileURLWithPath: "/tmp/repo"), name: "socle")
    #expect(model.state == .running)

    // Ce que la fermeture de l'app appelle : l'app se DÉTACHE, la conduite reste
    // vivante dans le service (S-7) ; son `DELETE` appartient au geste explicite
    // « Arrêter le pilotage ».
    await model.terminateForQuit()
    #expect(model.state == .stopped)
    #expect(model.sessionId == nil)
    #expect(!transport.requests.contains { $0.method == "DELETE" })
}

@MainActor
@Test("coque-service : la fermeture de l'app libère la session « Session OMP » (DELETE)")
func quitClosesPlainSession() async throws {
    let transport = ScriptedServiceTransport()
    stubSession(transport)
    transport.stubJSON("DELETE", "/v1/sessions/sess-1", ["closed": true])
    transport.scriptStream(serviceFrame("state", ["state": "running"]), keepOpen: true)

    let model = makeModel(transport)
    try await model.start(projectRoot: try makeProjectDirectory(), resumeFile: nil)
    await model.terminateForQuit()
    #expect(model.state == .stopped)
    #expect(transport.requests.contains { $0.method == "DELETE" && $0.path.hasSuffix("/v1/sessions/sess-1") })
}

private func makeProjectStateDirForSession() throws -> String {
    let root = (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-conduite-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
        atPath: (root as NSString).appendingPathComponent("projects"),
        withIntermediateDirectories: true
    )
    return root
}

private func makeGitRepositoryForSession() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("omp-repo-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    try Data("gitdir: .\n".utf8).write(to: url.appendingPathComponent(".git"))
    return url
}
