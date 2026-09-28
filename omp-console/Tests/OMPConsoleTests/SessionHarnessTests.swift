// Harnais de preuve RÉEL et sa garde d'exécution (S-10, BR-5 step 5).
//
// Les quatre tests réels lancent un VRAI `omp` (avec appel modèle) : ils sont donc
// décorés `.enabled(if: SessionHarness.available(...))`, ce qui les rend « non
// exécutés » — et la suite verte — là où `omp` est absent, notamment en CI, qui
// n'installe aucun binaire `omp` (note de /project). La garde est la CONJONCTION de
// la plateforme macOS et d'un `omp` résoluble : jamais la seule présence d'un
// binaire, jamais la seule plateforme.
//
// Chaque test travaille dans un dossier temporaire : aucune extension du dépôt
// n'est chargée. Chaque attente est bornée (30 s pour une poignée de main, 180 s
// pour un tour) et le process est tué dans un `defer` si le test échoue.

import Darwin
import Foundation
import Testing
@testable import OMPConsole

/// Garde unique des tests réels (S-10). `false` hors macOS, et `false` dès qu'un
/// `omp` exécutable n'est pas résoluble dans l'environnement donné.
enum SessionHarness {
    static func available(environment: [String: String]) -> Bool {
        #if os(macOS)
        if case .success = OmpBinaryResolver.resolve(environment: environment) { return true }
        return false
        #else
        return false
        #endif
    }
}

// MARK: - Outils

@MainActor
private func makeHarnessProject() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("omp-harness-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Écrit un faux `omp` dans un dossier temporaire et rend son chemin.
@discardableResult
private func makeFakeBinary(executable: Bool) throws -> String {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("omp-fake-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let binary = directory.appendingPathComponent("omp")
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: binary)
    try FileManager.default.setAttributes(
        [.posixPermissions: executable ? 0o755 : 0o644],
        ofItemAtPath: binary.path
    )
    return binary.path
}

@MainActor
private func waitUntil(timeout: Duration = .seconds(5), _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(20))
    }
    return condition()
}

private func processExists(_ pid: Int32) -> Bool {
    kill(pid, 0) == 0
}

@MainActor
private func waitUntilProcessGone(_ pid: Int32, timeout: Duration = .seconds(10)) async -> Bool {
    await waitUntil(timeout: timeout) { !processExists(pid) }
}

/// Nettoyage de `defer` : synchrone, donc utilisable même quand le test a échoué.
@MainActor
private func forceKill(_ transport: ProcessTransport) {
    transport.closeStdin()
    if let pid = transport.pid { kill(pid, SIGKILL) }
}

/// Prompt du harnais : il nomme les arguments exacts de l'outil `ask` pour que la
/// demande de dialogue soit reproductible (schéma relevé : `questions[].question`,
/// `questions[].options[].label`).
private let askPrompt = """
Appelle l'outil ask UNE SEULE FOIS, avec exactement ces arguments : \
{"questions":[{"id":"couleur","question":"Choisis une couleur","options":[{"label":"rouge"},{"label":"bleu"}]}]}. \
N'appelle aucun autre outil. Quand tu recevras la réponse, réponds simplement « merci » et termine.
"""

private let simplePrompt = "Réponds simplement « bonjour » et termine. N'appelle aucun outil."

// MARK: - S-10 : la garde elle-même (AC-17)

@Test("client-rpc-omp/AC-17 : la garde est fausse quand omp est absent du PATH et du HOME")
func guardIsFalseWithoutOmp() {
    #expect(SessionHarness.available(environment: ["PATH": "/nonexistent", "HOME": "/nonexistent"]) == false)
}

@Test("client-rpc-omp/AC-17 : la garde est fausse quand la variable d'échappement pointe un binaire absent")
func guardIsFalseWithOverride() {
    var environment = ProcessInfo.processInfo.environment
    environment[OmpBinaryResolver.overrideKey] = "/nonexistent/omp"
    #expect(SessionHarness.available(environment: environment) == false)
}

@Test("client-rpc-omp/AC-17 : la garde est vraie quand le PATH porte un omp exécutable")
func guardIsTrueWithExecutableBinary() throws {
    let binary = try makeFakeBinary(executable: true)
    let directory = (binary as NSString).deletingLastPathComponent
    #expect(SessionHarness.available(environment: ["PATH": directory, "HOME": "/nonexistent"]) == true)
}

@Test("client-rpc-omp/AC-17 : la garde ne se contente pas d'un binaire non exécutable")
func guardRejectsNonExecutableBinary() throws {
    let binary = try makeFakeBinary(executable: false)
    var environment = ["PATH": "/nonexistent", "HOME": "/nonexistent"]
    environment[OmpBinaryResolver.overrideKey] = binary
    #expect(SessionHarness.available(environment: environment) == false)
}

// MARK: - AC-1, AC-5, AC-7, AC-15 : aller-retour réel avec dialogue

@MainActor
@Test(
    "client-rpc-omp/AC-1 : une session rpc-ui réelle négocie, transcrit le tour, répond à un ask et s'arrête proprement",
    .enabled(if: SessionHarness.available(environment: ProcessInfo.processInfo.environment))
)
func harnessRoundTripDialogue() async throws {
    let project = try makeHarnessProject()
    let transport = ProcessTransport()
    let host = SessionHost(transport: transport)
    defer { forceKill(transport) }

    // Poignée de main réelle : c'est AC-1 (process vivant, canal RPC abouti).
    try await host.start(mode: .rpcUI, projectRoot: project, resume: false)
    #expect(host.state == .running)
    #expect(host.protocolVersion == 2)
    let pid = try #require(host.pid)
    #expect(processExists(pid))

    // `hasUI == true` en rpc-ui : l'outil `ask` est enregistré (D1).
    let state = try await host.getState()
    let tools = state.data?["dumpTools"]?.arrayValue?.compactMap { $0.objectValue?["name"]?.stringValue } ?? []
    #expect(tools.contains("ask"), "l'outil `ask` doit être enregistré en mode rpc-ui")

    // AC-5 : le prompt part, le tour s'écrit dans la transcription.
    try await host.send(prompt: askPrompt)
    let gotDialog = await waitUntil(timeout: .seconds(180)) { !host.dialogQueue.isEmpty }
    #expect(gotDialog, "aucune demande de dialogue `ask` reçue en 180 s")

    // AC-7 : la question et ses choix sont affichés tels quels.
    let dialog = try #require(host.dialogQueue.first)
    #expect(dialog.method == .select)
    #expect(dialog.title.isEmpty == false)
    #expect(dialog.options.contains("rouge"))
    #expect(host.transcript.contains { $0.kind == .inbound && $0.text.contains("extension_ui_request") })

    try host.answer(.value(id: dialog.id, value: dialog.options[0]))
    #expect(host.dialogQueue.isEmpty)

    // Le tour reprend et se termine (AC-5 : la transcription croît jusqu'au résultat).
    let finished = await waitUntil(timeout: .seconds(180)) { host.turnOutcome != nil }
    #expect(finished, "aucun `prompt_result` reçu en 180 s")
    #expect(host.turnOutcome?.status == "completed")
    #expect(host.transcript.contains { $0.kind == .outbound && $0.text.contains("\"extension_ui_response\"") })

    // AC-15 : fin propre par fermeture de stdin, sans escalade, sans orphelin.
    await host.stop()
    #expect(host.state == .stopped)
    #expect(host.journal.contains { $0.kind == .processExit && $0.message.contains("session arrêtée : stdin fermé, sortie code 0") })
    #expect(await waitUntilProcessGone(pid), "le process hébergé (pid \(pid)) subsiste après l'arrêt")
}

// MARK: - AC-6 : mode conducteur sans dialogues

@MainActor
@Test(
    "client-rpc-omp/AC-6 : une session rpc réelle a hasUI=false (pas d'ask), reçoit ses événements et s'arrête proprement",
    .enabled(if: SessionHarness.available(environment: ProcessInfo.processInfo.environment))
)
func harnessHeadlessMode() async throws {
    let project = try makeHarnessProject()
    let transport = ProcessTransport()
    let host = SessionHost(transport: transport)
    defer { forceKill(transport) }

    try await host.start(mode: .rpc, projectRoot: project, resume: false)
    #expect(host.state == .running)
    let pid = try #require(host.pid)

    try await host.send(prompt: simplePrompt)
    let finished = await waitUntil(timeout: .seconds(180)) { host.turnOutcome != nil }
    #expect(finished, "aucun `prompt_result` reçu en 180 s")
    #expect(host.turnOutcome?.agentInvoked == true)
    // Les événements du tour sont arrivés, montrés tels quels.
    #expect(host.transcript.contains { $0.kind == .inbound && $0.text.contains("agent_start") })

    // `get_state` répond, et `dumpTools` ne porte PAS `ask` : c'est la preuve
    // observable du `hasUI == false` de D1.
    let state = try await host.getState()
    let tools = state.data?["dumpTools"]?.arrayValue?.compactMap { $0.objectValue?["name"]?.stringValue } ?? []
    #expect(tools.isEmpty == false, "`dumpTools` doit être renseigné par `get_state`")
    #expect(tools.contains("ask") == false)
    // Aucune demande de dialogue n'a été émise par l'hôte dans ce mode.
    #expect(host.transcript.contains { $0.text.contains("\"extension_ui_request\"") && $0.text.contains("\"method\":\"select\"") } == false)

    await host.stop()
    #expect(host.state == .stopped)
    #expect(await waitUntilProcessGone(pid))
}

// MARK: - AC-10, AC-11 : mort réelle et relance manuelle

@MainActor
@Test(
    "client-rpc-omp/AC-10 : un SIGKILL réel publie dead sans geste, et la relance reprend le même .jsonl",
    .enabled(if: SessionHarness.available(environment: ProcessInfo.processInfo.environment))
)
func harnessMortEtRelance() async throws {
    let project = try makeHarnessProject()
    let transport = ProcessTransport()
    let host = SessionHost(transport: transport)
    defer { forceKill(transport) }

    try await host.start(mode: .rpcUI, projectRoot: project, resume: false)
    try await host.send(prompt: simplePrompt)
    #expect(await waitUntil(timeout: .seconds(180)) { host.turnOutcome != nil }, "aucun `prompt_result` reçu en 180 s")

    let sessionId = try #require(host.sessionId)
    let sessionFile = try #require(host.sessionFile)
    let pid = try #require(host.pid)
    let stateBefore = try await host.getState()
    let countBefore = stateBefore.data?["messageCount"]?.numberValue ?? 0

    // Mort subie : aucun arrêt n'a été demandé.
    kill(pid, SIGKILL)
    let died = await waitUntil(timeout: .seconds(30)) {
        if case .dead = host.state { return true }
        return false
    }
    #expect(died, "la mort subie n'a pas publié `dead`")
    #expect(host.journal.contains { $0.kind == .processExit && $0.message.contains("process terminé sans arrêt demandé (signal 9)") })

    // Aucune relance automatique : sans geste, l'état ne bouge pas.
    try await Task.sleep(for: .milliseconds(300))
    if case .dead = host.state {} else {
        Issue.record("l'état a changé sans geste de l'utilisateur : \(host.state)")
    }

    // Relance manuelle : même fichier de session, même identifiant, contexte repris.
    try await host.relaunch()
    #expect(host.state == .running)
    #expect(host.sessionFile == sessionFile)
    #expect(host.sessionId == sessionId)
    let stateAfter = try await host.getState()
    let countAfter = stateAfter.data?["messageCount"]?.numberValue ?? 0
    #expect(countAfter >= countBefore, "la relance n'a pas repris le contexte (\(countAfter) < \(countBefore))")

    await host.stop()
    #expect(host.state == .stopped)
}

// MARK: - AC-16 : fermeture de l'app

@MainActor
@Test(
    "client-rpc-omp/AC-16 : la fermeture de l'app termine le process hébergé et ne laisse aucun orphelin",
    .enabled(if: SessionHarness.available(environment: ProcessInfo.processInfo.environment))
)
func harnessAucunOrphelin() async throws {
    let project = try makeHarnessProject()
    let transport = ProcessTransport()
    let host = SessionHost(transport: transport)
    defer { forceKill(transport) }

    try await host.start(mode: .rpc, projectRoot: project, resume: false)
    let pid = try #require(host.pid)
    #expect(processExists(pid))

    // C'est l'UNIQUE chemin de sortie de la fermeture de l'app (S-8).
    await host.terminateForQuit()

    #expect(host.state == .stopped)
    #expect(await waitUntilProcessGone(pid), "le process hébergé (pid \(pid)) subsiste après la fermeture de l'app")
}
