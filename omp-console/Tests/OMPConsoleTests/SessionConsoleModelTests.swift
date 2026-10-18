// Preuves du MODÈLE de la fenêtre « Session OMP » (S-9, S-10, S-15) : le statut
// et la cible du raccourci ⌘., les disponibilités, le message d'un service absent
// et la conversation qui suit le fichier de session publié par l'API.
//
// Le modèle ne parle plus RPC : il appelle la session servie par l'API locale, et
// les preuves substituent un transport HTTP scripté (`ScriptedServiceTransport`) —
// aucun process `omp` n'est lancé.

import AppKit
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

// MARK: - jargon-technique-expose-mac-et-ios, S-3 (BR-3)

@Test("jargon-technique-expose-mac-et-ios/AC-3 : la ligne « État » des inspecteurs dit En marche, En attente ou Arrêtée, sans pid ni motif brut")
func inspectorStateIsReadable() {
    let expected: [(ServiceSessionModel.State, String)] = [
        (.idle, "En attente"),
        (.launching, "En attente"),
        (.running, "En marche"),
        (.stopping, "En attente"),
        (.stopped, "Arrêtée"),
        (.dead, "Arrêtée"),
        (.failed(message: "pid 4242 : omp introuvable"), "Arrêtée"),
    ]
    for (state, word) in expected {
        let shown = SessionConsoleText.inspectorState(state)
        #expect(shown == word)
        #expect(!shown.localizedCaseInsensitiveContains("pid"))
        #expect(!shown.contains("4242"))
    }
}

@Test("jargon-technique-expose-mac-et-ios/AC-4 : « Copier le diagnostic » des inspecteurs met le PID de la session au presse-papiers")
@MainActor
func inspectorDiagnosticCarriesThePid() {
    let running = SessionConsoleText.diagnostic(
        pid: 4242,
        state: .running,
        sessionId: "sess-1",
        projectPath: "/tmp/projet",
        sessionFile: "/tmp/projet/session.jsonl"
    )
    #expect(running == """
    numéro de processus : 4242
    état : running
    identifiant de session : sess-1
    projet : /tmp/projet
    fichier de session : /tmp/projet/session.jsonl
    """)

    let pasteboard = NSPasteboard.withUniqueName()
    defer { pasteboard.releaseGlobally() }
    DiagnosticPasteboard.copy(running, to: pasteboard)
    #expect(pasteboard.string(forType: .string)?.contains("numéro de processus : 4242") == true)

    // Service non joint : le pid est absent, le diagnostic reste copiable.
    let unreached = SessionConsoleText.diagnostic(
        pid: nil, state: .idle, sessionId: nil, projectPath: nil, sessionFile: nil
    )
    #expect(unreached.split(separator: "\n").count == 5)
    #expect(unreached.hasPrefix("numéro de processus : absent\n"))
    #expect(!unreached.isEmpty)

    // Échec : le motif brut vit dans le diagnostic, pas sur la ligne « État ».
    let failed = SessionConsoleText.diagnostic(
        pid: 4242, state: .failed(message: "omp introuvable"), sessionId: nil, projectPath: nil, sessionFile: nil
    )
    #expect(failed.contains("omp introuvable"))
}

// MARK: - model-selector-in-embedded-omp-session (S-6)

private let opus = "anthropic/claude-opus-5-5"
private let sonnet = "anthropic/claude-sonnet-5-5"
private let gpt = "openai/gpt-5"

/// Le catalogue authentifié d'`omp models --json` : un modèle aux cinq efforts, un
/// aux deux efforts `low`/`high`, un qui ne raisonne pas.
private let selectorListing = ModelCatalogListing(
    selectors: [opus, sonnet, gpt],
    names: [opus: "Claude Opus 5.5", sonnet: "Claude Sonnet 5.5", gpt: "GPT-5"],
    thinking: [opus: ["low", "medium", "high", "xhigh", "max"], sonnet: ["low", "high"]]
)

/// La description d'une session servie, modèle et niveau compris (`nil` ⇒ `null`).
private func modelSessionJSON(
    id: String = "sess-m",
    cwd: String,
    state: String = "idle",
    model: String?,
    level: String?
) -> [String: Any] {
    [
        "id": id, "cwd": cwd, "purpose": "session", "state": state, "sessionFile": NSNull(),
        "model": model ?? NSNull(), "thinkingLevel": level ?? NSNull(),
    ]
}

@MainActor
private func makeSelectorModel(host: ServiceSessionModel, projectRoot: URL) -> SessionConsoleModel {
    let suite = UserDefaults(suiteName: "session-console-model-\(UUID().uuidString)") ?? .standard
    suite.set(projectRoot.path, forKey: SessionConsoleModel.projectRootKey)
    return SessionConsoleModel(host: host, defaults: suite, modelListingLoader: { .success(selectorListing) })
}

/// Une session servie ouverte sur `model`/`level`, flux gardé OUVERT, catalogue chargé.
@MainActor
private func openModelSession(
    _ transport: ScriptedServiceTransport,
    project: URL,
    model: String?,
    level: String?
) async -> (host: ServiceSessionModel, session: SessionConsoleModel) {
    transport.stubJSON("POST", "/v1/sessions", modelSessionJSON(cwd: project.path, model: model, level: level))
    transport.scriptStream([], keepOpen: true)
    let host = makeHost(transport)
    let session = makeSelectorModel(host: host, projectRoot: project)
    await session.loadModelCatalog()
    session.launch()
    _ = await waitUntil { host.state == .running }
    _ = await waitUntil { transport.streamOpenCount >= 1 }
    return (host, session)
}

@MainActor
@Test("model-selector-in-embedded-omp-session/AC-1 : la section montre le modèle et le niveau de la description, puis ceux d'une trame `model`")
func selectorShowsModelFromDescriptionThenFrame() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedServiceTransport()
    transport.stubJSON("POST", "/v1/sessions", modelSessionJSON(cwd: project.path, model: opus, level: "high"))
    transport.scriptStream([], keepOpen: true)
    let host = makeHost(transport)
    let model = makeSelectorModel(host: host, projectRoot: project)
    await model.loadModelCatalog()

    // Aucune session ni défaut de projet : « défaut OMP ».
    #expect(model.modelLabel == SessionConsoleText.Model.defaultModel)

    // La description porte le modèle et le niveau : affichés sans rien ouvrir.
    model.launch()
    #expect(await waitUntil { host.state == .running })
    #expect(model.modelLabel == "Claude Opus 5.5 · réflexion élevée")
    #expect(host.model == opus && host.thinkingLevel == "high")

    // Une trame `model` (autre appareil, `/model` du terminal) REMPLACE la valeur.
    #expect(await waitUntil { transport.streamOpenCount >= 1 })
    transport.emit(serviceFrame("model", ["model": sonnet, "thinkingLevel": "low"]))
    #expect(await waitUntil { model.modelLabel == "Claude Sonnet 5.5 · réflexion faible" })
    // Niveau nul : le nom seul. Modèle hors catalogue : le sélecteur brut.
    transport.emit(serviceFrame("model", ["model": gpt, "thinkingLevel": NSNull()]))
    #expect(await waitUntil { model.modelLabel == "GPT-5" })
    transport.emit(serviceFrame("model", ["model": "x/inconnu", "thinkingLevel": "auto"]))
    #expect(await waitUntil { model.modelLabel == "x/inconnu · réflexion automatique" })
}

@MainActor
@Test("model-selector-in-embedded-omp-session/AC-7 : le sélecteur est indisponible pendant un tour et redevient utilisable à la trame `state idle`")
func selectorIsUnavailableDuringATurn() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedServiceTransport()
    let (host, model) = await openModelSession(transport, project: project, model: sonnet, level: "low")

    #expect(model.canChangeModel)
    transport.emit(serviceFrame("state", ["state": "running"]))
    #expect(await waitUntil { host.turnRunning })
    #expect(!model.canChangeModel)
    #expect(model.modelRefusal == .turnRunning)
    #expect(model.modelHelp == SessionConsoleText.Model.busyHelp)
    model.openModelPicker()
    #expect(!model.modelPickerShown, "un sélecteur indisponible ne s'ouvre pas")

    transport.emit(serviceFrame("state", ["state": "idle"]))
    #expect(await waitUntil { !host.turnRunning })
    #expect(model.canChangeModel)
    model.openModelPicker()
    #expect(model.modelPickerShown)

    // Sans projet, le sélecteur n'a pas de cible : indisponible, avec sa raison.
    model.cancelModelPicker()
    model.projectRoot = nil
    #expect(!model.canChangeModel)
    #expect(model.modelRefusal == .noProject)
    #expect(model.modelHelp == SessionConsoleText.Model.noProject)
}

@MainActor
@Test("model-selector-in-embedded-omp-session/AC-5 : la liste ne montre que les modèles du catalogue authentifié, filtrés sans tenir compte de la casse")
func selectorListsOnlyCatalogModels() async throws {
    let project = try makeProjectDirectory()
    let model = makeSelectorModel(host: makeHost(ScriptedServiceTransport()), projectRoot: project)

    // Catalogue en chargement : rien n'est offert.
    #expect(model.modelCatalog == .loading)
    #expect(model.visibleModels.isEmpty)

    await model.loadModelCatalog()
    // Un modèle connu d'OMP mais sans authentification n'est pas dans `omp models --json`.
    #expect(model.visibleModels == [opus, sonnet, gpt])
    #expect(!model.visibleModels.contains("anthropic/claude-haiku-5"))

    model.modelFilter = "OPUS"
    #expect(model.visibleModels == [opus], "le nom lisible compte")
    model.modelFilter = "OPENAI/"
    #expect(model.visibleModels == [gpt], "le sélecteur compte")
    model.modelFilter = "introuvable"
    #expect(model.visibleModels.isEmpty)

    // Un catalogue en échec ne propose rien et garde son motif.
    let failing = SessionConsoleModel(
        host: makeHost(ScriptedServiceTransport()),
        defaults: UserDefaults(suiteName: "session-console-model-\(UUID().uuidString)") ?? .standard,
        modelListingLoader: { .failure(ModelCatalogError(reason: "omp introuvable")) }
    )
    await failing.loadModelCatalog()
    #expect(failing.modelCatalog == .failed("omp introuvable"))
    #expect(failing.visibleModels.isEmpty)
}

@MainActor
@Test("model-selector-in-embedded-omp-session/AC-6 : le réglage de réflexion suit le modèle du brouillon (masqué sans effort, sinon seuls ses niveaux)")
func selectorOffersOnlyTheModelsThinkingLevels() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedServiceTransport()
    let (host, model) = await openModelSession(transport, project: project, model: sonnet, level: "high")

    model.openModelPicker()
    #expect(model.draftModel == sonnet)
    #expect(model.draftLevels == ["off", "low", "high"], "seuls les niveaux que le modèle supporte")
    #expect(model.draftLevel == "high")

    // Opus supporte plus de niveaux : `high` est proposé, il est conservé.
    model.selectDraftModel(opus)
    #expect(model.draftLevels == ["off", "low", "medium", "high", "xhigh", "max"])
    #expect(model.draftLevel == "high")
    // Retour sur Sonnet depuis `max` : le plus haut niveau proposé ≤ max, soit `high`.
    model.draftLevel = "max"
    model.selectDraftModel(sonnet)
    #expect(model.draftLevel == "high")
    // Un modèle sans effort : aucun niveau, réglage masqué.
    model.selectDraftModel(gpt)
    #expect(model.draftLevels.isEmpty)
    #expect(model.draftLevel == nil)
    // Depuis aucun niveau : le premier proposé.
    model.selectDraftModel(opus)
    #expect(model.draftLevel == "off")

    // Appliquer un modèle sans effort n'envoie AUCUN niveau.
    model.selectDraftModel(gpt)
    transport.stubJSON("POST", "/v1/sessions/sess-m/model", modelSessionJSON(cwd: project.path, model: gpt, level: nil))
    await model.applyModelDraft()
    let post = try #require(transport.requests.last { $0.method == "POST" && $0.path.hasSuffix("/model") })
    #expect(post.body?["model"] as? String == gpt)
    #expect(post.body?["thinkingLevel"] == nil)
    #expect(host.model == gpt && host.thinkingLevel == nil)
}

@MainActor
@Test("model-selector-in-embedded-omp-session/AC-3 : appliquer sur une session vivante poste sessions/{id}/model, sans création ni fermeture")
func applyingOnALiveSessionDoesNotRelaunch() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedServiceTransport()
    let (host, model) = await openModelSession(transport, project: project, model: sonnet, level: "low")

    model.openModelPicker()
    #expect(model.modelPickerShown)
    #expect(model.draftModel == sonnet && model.draftLevel == "low")
    model.selectDraftModel(opus)
    model.draftLevel = "max"
    transport.stubJSON("POST", "/v1/sessions/sess-m/model", modelSessionJSON(cwd: project.path, model: opus, level: "max"))
    await model.applyModelDraft()

    let posts = transport.requests.filter { $0.method == "POST" && $0.path.hasSuffix("/model") }
    #expect(posts.count == 1)
    #expect(posts.first?.path == "/v1/sessions/sess-m/model")
    #expect(posts.first?.body?["model"] as? String == opus)
    #expect(posts.first?.body?["thinkingLevel"] as? String == "max")
    // La même session : une seule création, aucune fermeture.
    #expect(transport.requests.filter { $0.method == "POST" && $0.path.hasSuffix("/v1/sessions") }.count == 1)
    #expect(!transport.requests.contains { $0.method == "DELETE" })
    #expect(host.state == .running && host.sessionId == "sess-m")
    // Succès : la valeur affichée est la réponse, le sélecteur se ferme.
    #expect(host.model == opus && host.thinkingLevel == "max")
    #expect(model.modelLabel == "Claude Opus 5.5 · réflexion maximale")
    #expect(!model.modelPickerShown)
    #expect(model.modelError == nil)
}

@MainActor
@Test("model-selector-in-embedded-omp-session/AC-8 : sans session, appliquer poste le défaut du projet, puis la session ouverte affiche ce modèle")
func applyingWithoutASessionSetsTheProjectDefault() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedServiceTransport()
    transport.stubJSON("GET", "/model", ["model": NSNull(), "thinkingLevel": NSNull()])
    transport.stubJSON("POST", "/model", ["model": opus, "thinkingLevel": "high"])
    transport.stubJSON("POST", "/v1/sessions", modelSessionJSON(cwd: project.path, model: opus, level: "high"))
    transport.scriptStream([], keepOpen: true)
    let host = makeHost(transport)
    let model = makeSelectorModel(host: host, projectRoot: project)
    await model.loadModelCatalog()
    await model.refreshProjectDefault()
    #expect(model.modelLabel == SessionConsoleText.Model.defaultModel)
    #expect(model.canChangeModel, "B-5 : le sélecteur reste utilisable sans session")

    model.openModelPicker()
    model.selectDraftModel(opus)
    model.draftLevel = "high"
    await model.applyModelDraft()

    // Le chemin du dépôt voyage en UN segment percent-encodé.
    let post = try #require(transport.requests.first { $0.method == "POST" && $0.path.hasSuffix("/model") })
    #expect(post.rawPath == "/v1/projects/" + project.path.replacingOccurrences(of: "/", with: "%2F") + "/model")
    #expect(post.body?["model"] as? String == opus)
    #expect(post.body?["thinkingLevel"] as? String == "high")
    #expect(model.projectDefault == ServiceModelChoice(model: opus, thinkingLevel: "high"))
    #expect(model.modelLabel == "Claude Opus 5.5 · réflexion élevée")
    #expect(!model.modelPickerShown)
    #expect(!transport.requests.contains { $0.method == "POST" && $0.path.hasSuffix("/v1/sessions") })

    // La session ouverte ensuite tourne sur ce modèle dès le premier message.
    model.launch()
    #expect(await waitUntil { host.state == .running })
    #expect(host.model == opus && host.thinkingLevel == "high")
    #expect(model.modelLabel == "Claude Opus 5.5 · réflexion élevée")
}

@MainActor
@Test("model-selector-in-embedded-omp-session/AC-12 : un refus du service garde le sélecteur ouvert avec sa raison et relit la valeur réelle")
func aRefusalShowsTheReasonAndKeepsTheRealValue() async throws {
    let project = try makeProjectDirectory()
    let transport = ScriptedServiceTransport()
    let reason = "Modèle inutilisable : OMP n'a pas d'authentification pour \(opus)."
    transport.stubJSON("POST", "/v1/sessions/sess-m/model", ["error": "conflict", "reason": reason], status: 409)
    // La valeur RÉELLE de la session, relue après le refus (≠ création, ≠ brouillon).
    transport.stubJSON("GET", "/v1/sessions/sess-m", modelSessionJSON(cwd: project.path, model: sonnet, level: "medium"))
    let (host, model) = await openModelSession(transport, project: project, model: sonnet, level: "low")

    model.openModelPicker()
    model.selectDraftModel(opus)
    model.draftLevel = "high"
    await model.applyModelDraft()

    #expect(model.modelError == reason, "la raison du service, mot pour mot")
    #expect(model.modelPickerShown, "le sélecteur reste ouvert")
    #expect(host.model == sonnet && host.thinkingLevel == "medium", "valeur relue, jamais le brouillon")
    #expect(model.displayedModel == ServiceModelChoice(model: sonnet, thinkingLevel: "medium"))
    #expect(model.modelLabel == "Claude Sonnet 5.5 · réflexion moyenne")
    #expect(host.state == .running, "un refus ne tue pas la session")

    // Sans session : un 500 (défaut non écrit) garde aussi la raison, et le défaut est relu.
    let alone = ScriptedServiceTransport()
    let writeReason = "Défaut du projet illisible : config.yml."
    alone.stubJSON("POST", "/model", ["error": "internal", "reason": writeReason], status: 500)
    alone.stubJSON("GET", "/model", ["model": sonnet, "thinkingLevel": "low"])
    let idle = makeSelectorModel(host: makeHost(alone), projectRoot: project)
    await idle.loadModelCatalog()
    idle.openModelPicker()
    idle.selectDraftModel(opus)
    idle.draftLevel = "high"
    await idle.applyModelDraft()
    #expect(idle.modelError == writeReason)
    #expect(idle.modelPickerShown)
    #expect(idle.projectDefault == ServiceModelChoice(model: sonnet, thinkingLevel: "low"))
    #expect(idle.modelLabel == "Claude Sonnet 5.5 · réflexion faible")
}
