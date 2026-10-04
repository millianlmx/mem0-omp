// Harnais de preuve RÉEL et sa garde d'exécution (S-1, S-2, S-4).
//
// Les quatre tests réels lancent un VRAI `omp` (avec appel modèle). Ils sont
// DÉSACTIVÉS par défaut : le trait `.enabled(if:)` ne porte QUE la présence de
// `MEM0_HARNESS_RECIPE`, et aucun script du dépôt (`scripts/swift-app.sh`,
// `scripts/check.sh`, `.github/workflows/`) ne pose cette variable. La présence
// d'un `omp` sur la machine n'active donc plus rien. La résolubilité du binaire est
// vérifiée DANS le corps du test (`SessionHarness.shouldRun`), jamais dans le
// trait : une condition fausse de `.enabled(if:)` ne peut que skipper le test,
// jamais le faire échouer.
//
// Recette manuelle, à la demande, hors intégration continue :
//
//   cd omp-console && MEM0_HARNESS_RECIPE=1 swift test --scratch-path .build-tests --no-parallel \
//     --filter harness -Xswiftc -plugin-path \
//     -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
//
// `--filter harness` porte sur le nom de FONCTION du test (pas sur son titre
// affiché) et sélectionne exactement les quatre : `harnessRoundTripDialogue`,
// `harnessHeadlessMode`, `harnessMortEtRelance`, `harnessAucunOrphelin`. `omp` doit
// être résoluble (`OmpBinaryResolver`, échappatoire `OMP_CONSOLE_OMP_BINARY`) :
// variable posée sans `omp` ⇒ chaque test échoue explicitement, jamais un faux
// succès ni un skip silencieux.
//
// Chaque test travaille dans un dossier temporaire : aucune extension du dépôt
// n'est chargée. Chaque attente est bornée (30 s pour une poignée de main, 180 s
// pour un tour) et le process est tué dans un `defer` si le test échoue.

import Darwin
import Foundation
import Testing
@testable import OMPConsole

/// Garde unique des tests réels (S-1, S-2). L'activation est la PRÉSENCE de
/// `recipeKey` ; la résolubilité d'`omp` est constatée par `shouldRun`, appelé en
/// première instruction du test — pas par le trait, qui ne saurait que skipper.
enum SessionHarness {
    /// Variable d'opt-in : le nom n'existe qu'ici et dans la documentation.
    static let recipeKey = "MEM0_HARNESS_RECIPE"

    enum Status: Equatable {
        /// Variable d'opt-in absente : le test a été exécuté par erreur (trait retiré).
        case disabled
        /// Variable posée, mais aucun `omp` exécutable résoluble.
        case missingBinary
        /// Variable posée et `omp` résoluble : le test réel peut tourner.
        case ready
    }

    /// Activé dès que la variable est PRÉSENTE (valeur vide comprise), jamais
    /// d'après sa vacuité — même règle que les autres recettes du dépôt.
    static func optedIn(environment: [String: String]) -> Bool {
        environment[recipeKey] != nil
    }

    static func status(environment: [String: String]) -> Status {
        guard optedIn(environment: environment) else { return .disabled }
        if case .success = OmpBinaryResolver.resolve(environment: environment) { return .ready }
        return .missingBinary
    }

    /// À appeler en PREMIÈRE instruction d'un test réel : `Issue.record` fait
    /// échouer le test (sévérité `.error` par défaut), là où `Test.cancel` le
    /// terminerait sans échec — proscrit.
    static func shouldRun(environment: [String: String]) -> Bool {
        switch status(environment: environment) {
        case .ready:
            return true
        case .missingBinary:
            Issue.record("\(recipeKey) est posée mais `omp` est introuvable : posez \(OmpBinaryResolver.overrideKey) sur un `omp` exécutable, ou retirez \(recipeKey) pour désactiver ce test réel.")
            return false
        case .disabled:
            Issue.record("\(recipeKey) est absente alors que ce test réel s'exécute : le trait `.enabled(if:)` a été retiré.")
            return false
        }
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

// MARK: - AC-4 (ex-`client-rpc-omp/AC-17`) : la garde elle-même

@Test("harnais-omp-reel-non-opt-in/AC-4 : sans variable d'opt-in, la garde est désactivée même avec un omp résoluble")
func guardDisabledWithoutRecipe() throws {
    let binary = try makeFakeBinary(executable: true)
    let directory = (binary as NSString).deletingLastPathComponent
    let environment = ["PATH": directory, "HOME": "/nonexistent"]
    #expect(SessionHarness.status(environment: environment) == .disabled)
    #expect(SessionHarness.optedIn(environment: environment) == false)
}

@Test("harnais-omp-reel-non-opt-in/AC-4 : variable posée sans omp résoluble, la garde signale le binaire manquant")
func guardMissingBinaryWithRecipe() {
    var environment = ["PATH": "/nonexistent", "HOME": "/nonexistent"]
    environment[SessionHarness.recipeKey] = "1"
    #expect(SessionHarness.status(environment: environment) == .missingBinary)

    environment[OmpBinaryResolver.overrideKey] = "/nonexistent/omp"
    #expect(SessionHarness.status(environment: environment) == .missingBinary)
}

@Test("harnais-omp-reel-non-opt-in/AC-4 : variable posée et omp du composant exécutable, la garde est prête")
func guardReadyWithExecutableBinary() throws {
    let binary = try makeFakeBinary(executable: true)
    // Depuis S-4, la garde ne découvre plus un `omp` du PATH : le seul chemin
    // trouvable est celui du composant, ou l'échappatoire de test.
    var environment = ["PATH": "/nonexistent", "HOME": "/nonexistent"]
    environment[SessionHarness.recipeKey] = "1"
    environment[OmpBinaryResolver.overrideKey] = binary
    #expect(SessionHarness.status(environment: environment) == .ready)
    #expect(SessionHarness.optedIn(environment: environment) == true)
}

@Test("harnais-omp-reel-non-opt-in/AC-4 : la garde ne se contente pas d'un binaire non exécutable")
func guardRejectsNonExecutableBinary() throws {
    let binary = try makeFakeBinary(executable: false)
    var environment = ["PATH": "/nonexistent", "HOME": "/nonexistent"]
    environment[SessionHarness.recipeKey] = "1"
    environment[OmpBinaryResolver.overrideKey] = binary
    #expect(SessionHarness.status(environment: environment) == .missingBinary)
}

// MARK: - AC-1, AC-5, AC-7, AC-15 : aller-retour réel avec dialogue

@MainActor
@Test(
    "client-rpc-omp/AC-1 : une session rpc-ui réelle négocie, transcrit le tour, répond à un ask et s'arrête proprement",
    .enabled(if: SessionHarness.optedIn(environment: ProcessInfo.processInfo.environment))
)
func harnessRoundTripDialogue() async throws {
    guard SessionHarness.shouldRun(environment: ProcessInfo.processInfo.environment) else { return }
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
    .enabled(if: SessionHarness.optedIn(environment: ProcessInfo.processInfo.environment))
)
func harnessHeadlessMode() async throws {
    guard SessionHarness.shouldRun(environment: ProcessInfo.processInfo.environment) else { return }
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
    .enabled(if: SessionHarness.optedIn(environment: ProcessInfo.processInfo.environment))
)
func harnessMortEtRelance() async throws {
    guard SessionHarness.shouldRun(environment: ProcessInfo.processInfo.environment) else { return }
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
    .enabled(if: SessionHarness.optedIn(environment: ProcessInfo.processInfo.environment))
)
func harnessAucunOrphelin() async throws {
    guard SessionHarness.shouldRun(environment: ProcessInfo.processInfo.environment) else { return }
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
