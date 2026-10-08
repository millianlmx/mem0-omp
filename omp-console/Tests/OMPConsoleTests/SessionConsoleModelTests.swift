// Preuves du MODÈLE de la fenêtre « Session OMP » (S-9, S-10, S-15) : le statut
// et la cible du raccourci ⌘., les disponibilités, le message d'un service absent
// et la conversation qui suit le fichier de session publié par l'API.
//
// Le modèle ne parle plus RPC : il appelle la session servie par l'API locale, et
// les preuves substituent un transport HTTP scripté (`ScriptedServiceTransport`) —
// aucun process `omp` n'est lancé.

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

// MARK: - Outils (transport HTTP scripté)

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

/// Stub la création de session : le service rend l'identité, l'état et — quand il
/// le connaît déjà — le fichier de session.
private func stubSession(
    _ transport: ScriptedServiceTransport,
    id: String = "session-abcdef12",
    file: String? = nil
) {
    var json: [String: Any] = ["id": id, "cwd": "/tmp/repo", "purpose": "session", "state": "running"]
    if let file { json["sessionFile"] = file }
    transport.stubJSON("POST", "/v1/sessions", json)
}

/// Le flux scripté se termine, puis le double — à court de flux — lève « service
/// arrêté » : la session passerait `dead` aussitôt. Ces flux de queue la
/// maintiennent vivante le temps des assertions (chaque réouverture coûte un
/// `retryDelay`, ici 25 ms).
private func keepSessionAlive(_ transport: ScriptedServiceTransport, _ count: Int = 20) {
    for _ in 0..<count {
        transport.scriptStream(serviceFrame("state", ["state": "running"]))
    }
}

/// Une trame `dialog` de méthode `select`, telle que le service la publie.
private func selectDialogFrame(id: String = "d-select", title: String) -> [String] {
    serviceFrame("dialog", [
        "id": id, "method": "select", "title": title,
        "options": ["rouge", "bleu"], "optionDescriptions": [NSNull(), NSNull()],
    ])
}

@MainActor
private func makeHost(_ transport: ScriptedServiceTransport) -> ServiceSessionModel {
    ServiceSessionModel(
        purpose: "session",
        makeClient: { scriptedClient(transport) },
        maxAttempts: 5,
        retryDelay: { _ in .milliseconds(25) }
    )
}

/// Modèle branché sur une session servie scriptée et sur des `UserDefaults`
/// jetables : le projet est CHOISI dans le magasin de test, jamais deviné depuis
/// le cwd.
@MainActor
private func makeModel(host: ServiceSessionModel, projectRoot: URL) -> SessionConsoleModel {
    let suite = UserDefaults(suiteName: "session-console-model-\(UUID().uuidString)") ?? .standard
    suite.set(projectRoot.path, forKey: SessionConsoleModel.projectRootKey)
    return SessionConsoleModel(host: host, defaults: suite)
}

// MARK: - S-9 : statut de la session vivante

@MainActor
@Test("omp-console-redesign/HIG : le statut d'une session active ne répète pas l'état et ne montre ni pid ni identifiant")
func runningStatusShowsNoTechnicalIdentity() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedServiceTransport()
    stubSession(transport, file: "/tmp/omp-model-\(UUID().uuidString).jsonl")
    transport.scriptStream(serviceFrame("state", ["state": "running"]))
    keepSessionAlive(transport)
    let host = makeHost(transport)
    let model = makeModel(host: host, projectRoot: project)

    #expect(model.projectRoot?.path == project.path)
    #expect(model.canLaunch)

    model.launch()
    #expect(await waitUntil { host.state == .running })
    #expect(await waitUntil { model.statusMessage == SessionConsoleModel.statusText(for: .running) })
    #expect(model.statusNotice == nil)
    // Ni le pid du service (4242, l'endpoint scripté) ni l'identifiant de session
    // n'ont leur place dans le statut : l'inspecteur les porte.
    #expect(!model.statusMessage.contains("4242"))
    #expect(!model.statusMessage.contains("session-"))
    #expect(host.sessionId == "session-abcdef12")
}

// MARK: - S-9 : cible du raccourci ⌘.

@MainActor
@Test("client-rpc-omp/AC-9 : ⌘. annule le dialogue en attente, et n'arrête la session que sans dialogue")
func stopShortcutCancelsPendingDialog() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedServiceTransport()
    stubSession(transport)
    transport.stubJSON("POST", "/v1/sessions/session-abcdef12/dialogs/d-select", ["accepted": true])
    transport.stubJSON("DELETE", "/v1/sessions/session-abcdef12", ["closed": true])
    transport.scriptStream(
        serviceFrame("state", ["state": "running"]) + selectDialogFrame(title: "Choisis une couleur")
    )
    keepSessionAlive(transport)
    let host = makeHost(transport)
    let model = makeModel(host: host, projectRoot: project)

    model.launch()
    #expect(await waitUntil { host.state == .running })
    #expect(await waitUntil { model.hasPendingDialog })
    // Le bouton d'arrêt reste disponible À LA SOURIS pendant le dialogue (S-9).
    #expect(model.canStop)

    model.performStopShortcut()

    // AC-9 : l'annulation est un geste EXPLICITE, corrélé au dialogue, et elle
    // n'arrête ni ne coupe la session.
    let cancelled = await waitUntil {
        transport.requests.contains { $0.method == "POST" && $0.path.hasSuffix("/dialogs/d-select") }
    }
    #expect(cancelled)
    let cancel = transport.requests.last { $0.path.hasSuffix("/dialogs/d-select") }
    let cancelledBody = cancel?.body?["cancelled"] as? Bool
    #expect(cancelledBody == true)
    let anyDelete = transport.requests.contains { $0.method == "DELETE" }
    #expect(!anyDelete)
    #expect(host.state == .running)
    #expect(await waitUntil { !model.hasPendingDialog })

    // Sans dialogue en attente, le même raccourci arrête la session.
    model.performStopShortcut()
    #expect(await waitUntil { host.state == .stopped })
    let deleted = transport.requests.contains {
        $0.method == "DELETE" && $0.path.hasSuffix("/v1/sessions/session-abcdef12")
    }
    #expect(deleted)
}

// MARK: - S-9 : disponibilités (le « Lancer » unique et le prompt bloqué)

@MainActor
@Test("client-rpc-omp/AC-2 : l'état vivant interdit un second lancement, et un dialogue bloque le prompt")
func modelGatesLaunchAndPrompt() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedServiceTransport()
    stubSession(transport)
    transport.stubJSON("POST", "/v1/sessions/session-abcdef12/dialogs/d-select", ["accepted": true])
    // Le dialogue n'arrive QU'APRÈS les flux de queue : les assertions d'avant le
    // dialogue (prompt encore possible) sont donc tenues avant qu'il ne bloque.
    transport.scriptStream(serviceFrame("state", ["state": "running"]))
    keepSessionAlive(transport)
    transport.scriptStream(selectDialogFrame(title: "Couleur"))
    keepSessionAlive(transport)
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

// MARK: - S-10 : un service absent, ce que l'utilisateur voit

@MainActor
@Test("coque-service : sans service, le modèle affiche « service arrêté » et ne lance rien")
func modelShowsMissingServiceMessage() async throws {
    let project = try makeProjectDirectory()
    let host = ServiceSessionModel(
        purpose: "session",
        makeClient: { throw ServiceUnavailable.stopped },
        retryDelay: { _ in .milliseconds(1) }
    )
    let model = makeModel(host: host, projectRoot: project)

    model.launch()

    // Le texte affiché vient de `UserFacingError.userMessage` et de lui seul.
    #expect(await waitUntil { model.statusMessage == "service arrêté" })
    #expect(host.state == .failed(message: "service arrêté"))
    // L'échec EST l'état : le statut ne le répète pas comme une notice.
    #expect(model.statusNotice == nil)
    // Aucune session n'a été créée : rien à arrêter.
    #expect(!model.canStop)
    #expect(host.sessionId == nil)
}

// MARK: - omp-console-redesign S-15 : la conversation de Session OMP

@MainActor
@Test("omp-console-redesign/S-15 : la conversation de Session OMP suit le fichier de session publié par l'API")
func conversationFollowsHostSessionFile() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedServiceTransport()
    let file = "/tmp/omp-conversation-\(UUID().uuidString).jsonl"
    // La session est créée SANS fichier : la conversation n'existe pas encore.
    stubSession(transport, file: nil)
    transport.stubJSON("GET", "/v1/sessions/session-abcdef12", [
        "id": "session-abcdef12", "cwd": project.path, "purpose": "session", "state": "running",
        "sessionFile": file,
    ])
    transport.scriptStream(serviceFrame("state", ["state": "running"]))
    keepSessionAlive(transport)

    let host = makeHost(transport)
    let suite = UserDefaults(suiteName: "session-console-model-\(UUID().uuidString)") ?? .standard
    suite.set(project.path, forKey: SessionConsoleModel.projectRootKey)
    let model = SessionConsoleModel(
        host: host,
        defaults: suite,
        makeConversation: { SessionViewerModel(target: $0, watch: false) }
    )

    // Avant que le service ne publie le fichier, aucun fichier n'est connu : pas
    // de conversation.
    model.launch()
    #expect(await waitUntil { host.state == .running })
    #expect(host.sessionFile == nil)
    #expect(model.conversation == nil)

    // Le service publie le fichier : la conversation naît et le suit.
    await host.refreshState()
    #expect(await waitUntil { model.conversation?.target.sessionFile == file })
    let first = try #require(model.conversation)

    // Une seconde interrogation au MÊME fichier garde la même conversation.
    await host.refreshState()
    try await Task.sleep(for: .milliseconds(50))
    #expect(model.conversation === first)
    #expect(host.sessionFile == file)
}

@Test("omp-console-redesign/S-15 : l'état de la session se dit en mots")
func sessionStateIsSaidInWords() {
    let expected: [(ServiceSessionModel.State, String, String)] = [
        (.idle, "Prête", "Aucun projet"),
        (.launching, "Démarrage…", "Démarrage…"),
        (.running, "Active", "Active"),
        (.stopping, "Arrêt…", "Arrêt…"),
        (.stopped, "Arrêtée", "Arrêtée"),
        (.dead, "Interrompue", "Interrompue"),
        (.failed(message: "omp introuvable"), "Échec", "Échec"),
    ]
    for (state, withProject, withoutProject) in expected {
        #expect(SessionConsoleText.stateTitle(state, hasProject: true) == withProject)
        #expect(SessionConsoleText.stateTitle(state, hasProject: false) == withoutProject)
    }
}
