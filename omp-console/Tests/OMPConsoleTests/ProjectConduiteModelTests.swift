// Preuves du noyau de conduite (BR-1) : AC-1 … AC-6, session servie scriptée.
//
// Chaque test porte son identifiant dans le TITRE affiché (`@Test("<slug>/AC-<n> :
// …")`), retrouvé par grep à la revue.
//
// Aucun process : `POST /projects/{repo}/conduite` arme la conduite, les dialogues
// arrivent par le flux SSE scripté et les réponses repartent par HTTP.

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

/// Monte un modèle vivant : `POST /conduite` armé et flux entretenu par l'appelant.
@MainActor
private func liveModel(
    repo: URL,
    name: String = "Mon projet",
    stateDir: String,
    transport: ScriptedServiceTransport
) async -> (ProjectConsoleModel, ScriptedServiceTransport) {
    stubProjectConduite(transport, repo: repo.path)
    let host = makeScriptedProjectHost(transport)
    let model = makeProjectModel(host: host, stateDir: stateDir)
    await model.startConduite(repoRoot: repo, name: name)
    return (model, transport)
}

private extension ScriptedServiceTransport {
    var conduitePosts: [ScriptedRequest] {
        requests.filter { $0.method == "POST" && $0.path.hasSuffix("/conduite") }
    }
    func lastRequest(endingWith suffix: String) -> ScriptedRequest? {
        requests.last { $0.path.hasSuffix(suffix) }
    }
}

// MARK: - S-1 / AC-1

@MainActor
@Test("conduite-de-projet/AC-1 : l'action démarre une session hébergée et arme /project sans terminal")
func conduiteStartsSessionAndArmsProject() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    keepProjectAlive(transport)
    let (model, t) = await liveModel(repo: repo, stateDir: stateDir, transport: transport)

    #expect(t.conduitePosts.count == 1)
    #expect(t.conduitePosts.first?.body?["name"] as? String == "Mon projet")
    #expect(model.state == .live)
    #expect(model.identity?.name == "Mon projet")
    #expect(model.identity?.repoRoot.path == repo.path)
    model.stop()
}

@MainActor
@Test("conduite-de-projet/AC-1 : un dossier sans .git ne lance aucun process")
func conduiteRefusesNonGitDirectory() async throws {
    let plain = FileManager.default.temporaryDirectory.appendingPathComponent("omp-plain-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: plain, withIntermediateDirectories: true)
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    let host = makeScriptedProjectHost(transport)
    let model = makeProjectModel(host: host, stateDir: stateDir)

    await model.startConduite(repoRoot: plain, name: "X")
    #expect(transport.requests.isEmpty)
    #expect(model.state == .none)
    #expect(model.statusMessage == ProjectViewText.notGitRepository)
}

@MainActor
@Test("conduite-de-projet/AC-1 : un nom vide après normalisation ne lance rien")
func conduiteRefusesEmptyName() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    let host = makeScriptedProjectHost(transport)
    let model = makeProjectModel(host: host, stateDir: stateDir)

    await model.startConduite(repoRoot: repo, name: "   \n  ")
    #expect(transport.requests.isEmpty)
    #expect(model.state == .none)
    #expect(ProjectConsoleModel.normalizeName("  a\n\n b   c  ") == "a b c")
}

// MARK: - S-2 / AC-2

@MainActor
@Test("conduite-de-projet/AC-2 : une seconde conduite est refusée jusqu'à la clôture")
func conduiteRefusesSecondStart() async throws {
    let repoA = try makeGitRepository()
    let repoB = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    keepProjectAlive(transport)
    let (model, t) = await liveModel(repo: repoA, name: "Alpha", stateDir: stateDir, transport: transport)

    await model.startConduite(repoRoot: repoB, name: "Beta")
    #expect(t.conduitePosts.count == 1)
    #expect(model.state == .live)
    // Le chemin du message est formaté (`~/…`), jamais brut ; le champ garde le vrai.
    #expect(model.refusal?.message == ProjectViewText.refusal(name: "Alpha", path: ConsoleFormat.path(repoA.path)))
    #expect(model.refusal?.repositoryName == "Alpha")
    #expect(model.refusal?.repositoryPath == repoA.path)

    model.dismissRefusal()
    #expect(model.refusal == nil)

    await model.closeConduite()
    #expect(model.state == .closed)
    #expect(model.identity == nil)
    #expect(model.canStartConduite)
    #expect(t.requests.contains { $0.method == "DELETE" && $0.path.hasSuffix("/conduite") })

    await model.startConduite(repoRoot: repoB, name: "Beta")
    #expect(model.state == .live)
    #expect(t.conduitePosts.count == 2)
    #expect(model.identity?.repoRoot.path == repoB.path)
    model.stop()
}

// MARK: - S-3 / AC-3

@MainActor
@Test("conduite-de-projet/AC-3 : aucune reprise à la construction du modèle")
func conduiteDoesNotResumeOnInit() async throws {
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    let host = makeScriptedProjectHost(transport)
    let suite = UserDefaults(suiteName: "project-conduite-\(UUID().uuidString)") ?? .standard
    let before = suite.dictionaryRepresentation()

    let model = ProjectConsoleModel(host: host, attention: RecordingAttention(), presence: StubPresence(), stateDir: stateDir, defaults: suite)

    #expect(transport.requests.isEmpty)
    #expect(model.state == .none)
    #expect(model.identity == nil)
    #expect(model.canStartConduite)
    #expect(suite.dictionaryRepresentation() as NSDictionary == before as NSDictionary)
}

// MARK: - S-4 / AC-4

@MainActor
@Test("conduite-de-projet/AC-4 : la saisie libre part, le dialogue suivant s'affiche")
func conduiteSendsTextThenShowsDialog() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    // Premier flux vide : le dialogue n'arrive qu'à la RÉOUVERTURE, donc APRÈS la
    // saisie libre que le test envoie aussitôt.
    transport.scriptStream([])
    emitProjectDialog(
        transport,
        id: "d-plan",
        method: "select",
        title: "Le plan du projet vous convient-il ?",
        options: ["Valider le plan", "Corriger le plan", "Abandonner"]
    )
    keepProjectAlive(transport)
    transport.stubJSON("POST", "/v1/sessions/s1/prompt", ["accepted": true])
    transport.stubJSON("POST", "/v1/sessions/s1/dialogs/d-plan", ["accepted": true])
    let (model, t) = await liveModel(repo: repo, stateDir: stateDir, transport: transport)

    model.prompt = "La description de mon projet"
    await model.sendText()
    #expect(t.lastRequest(endingWith: "/prompt")?.body?["text"] as? String == "La description de mon projet")
    #expect(model.prompt.isEmpty)

    #expect(await awaitProject { model.pendingDialog != nil })
    #expect(model.pendingDialog?.title == "Le plan du projet vous convient-il ?")
    #expect(model.canSendText == false)
    #expect(model.canAnswerDialog == false)

    model.selectedOptionIndex = 0
    #expect(model.canAnswerDialog)
    model.answerSelectedOption()
    #expect(await awaitProject { t.requests.contains { $0.path.hasSuffix("/dialogs/d-plan") } })
    #expect(t.lastRequest(endingWith: "/dialogs/d-plan")?.body?["value"] as? String == "Valider le plan")
    model.stop()
}

@MainActor
@Test("conduite-de-projet/AC-4 : une présentation n'écrit jamais")
func conduiteNeverAnswersAPresentation() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    emitProjectNotice(transport, message: "[project] rien à faire\nligne 2")
    keepProjectAlive(transport)
    let (model, t) = await liveModel(repo: repo, stateDir: stateDir, transport: transport)
    let countBefore = t.requests.count

    // La notice est le message DÉCODÉ de la trame, jamais la trame JSON brute.
    #expect(await awaitProject { model.notice == "[project] rien à faire\nligne 2" })
    #expect(t.requests.count == countBefore)
    model.stop()
}

// MARK: - S-5 / AC-5

@MainActor
@Test("conduite-de-projet/AC-5 : « Corriger le plan » puis l'éditeur prérempli")
func conduiteCorrectsPlanThroughEditor() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    emitProjectDialog(
        transport,
        id: "d-revue",
        method: "select",
        title: "Revue du plan",
        options: ["Valider le plan", "Corriger le plan", "Abandonner"]
    )
    let plan = "## Fondations\n- socle-app-swift — la coque"
    emitProjectDialog(transport, id: "d-correction", method: "editor", title: "Corrige le plan", prefill: plan)
    keepProjectAlive(transport)
    transport.stubJSON("POST", "/v1/sessions/s1/dialogs/d-revue", ["accepted": true])
    transport.stubJSON("POST", "/v1/sessions/s1/dialogs/d-correction", ["accepted": true])
    let (model, t) = await liveModel(repo: repo, stateDir: stateDir, transport: transport)

    #expect(await awaitProject { model.pendingDialog?.id == "d-revue" })
    model.selectedOptionIndex = 1
    model.answerSelectedOption()
    #expect(await awaitProject { t.requests.contains { $0.path.hasSuffix("/dialogs/d-revue") } })
    #expect(t.lastRequest(endingWith: "/dialogs/d-revue")?.body?["value"] as? String == "Corriger le plan")

    #expect(await awaitProject { model.pendingDialog?.method == .editor })
    #expect(await awaitProject { model.dialogText == plan })

    let edited = plan + "\n- projet — la conduite depuis l'app"
    model.dialogText = edited
    model.answerDialogText()
    #expect(await awaitProject { t.requests.contains { $0.path.hasSuffix("/dialogs/d-correction") } })
    #expect(t.lastRequest(endingWith: "/dialogs/d-correction")?.body?["value"] as? String == edited)
    model.stop()
}

// MARK: - S-6 / AC-6

@MainActor
@Test("conduite-de-projet/AC-6 : une escalade de lot s'affiche et la réponse repart")
func conduiteAnswersLotEscalation() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    emitProjectDialog(
        transport,
        id: "d-echec",
        method: "select",
        title: "Échec de la feature conduite-de-projet (segment 1 « Fondations ») : la compilation échoue",
        options: ["Relancer la feature", "Retirer la feature du plan", "Arrêter le projet"]
    )
    keepProjectAlive(transport)
    transport.stubJSON("POST", "/v1/sessions/s1/dialogs/d-echec", ["accepted": true])
    let (model, t) = await liveModel(repo: repo, stateDir: stateDir, transport: transport)

    #expect(await awaitProject { model.pendingDialog != nil })
    #expect(model.pendingDialog?.title.contains("Échec de la feature") == true)
    model.selectedOptionIndex = 1
    model.answerSelectedOption()
    #expect(await awaitProject { t.requests.contains { $0.path.hasSuffix("/dialogs/d-echec") } })
    #expect(t.lastRequest(endingWith: "/dialogs/d-echec")?.body?["value"] as? String == "Retirer la feature du plan")
    #expect(await awaitProject { model.pendingDialog == nil })
    model.stop()
}

@MainActor
@Test("conduite-de-projet/AC-6 : deux dialogues en file sont traités dans l'ordre")
func conduiteQueuesDialogs() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    emitProjectDialog(transport, id: "d1", method: "select", title: "Premier", options: ["A", "B"])
    emitProjectDialog(transport, id: "d2", method: "input", title: "Second", placeholder: "texte")
    keepProjectAlive(transport)
    transport.stubJSON("POST", "/v1/sessions/s1/dialogs/d1", ["accepted": true])
    let (model, _) = await liveModel(repo: repo, stateDir: stateDir, transport: transport)

    #expect(await awaitProject { model.waitingDialogCount == 2 })
    #expect(model.pendingDialog?.id == "d1")

    model.selectedOptionIndex = 0
    model.answerSelectedOption()
    #expect(await awaitProject { model.pendingDialog?.id == "d2" })
    #expect(model.waitingDialogCount == 1)
    model.stop()
}

// MARK: - S-7 : conduite DÉJÀ vivante et fermeture de l'app

@MainActor
@Test("conduite-de-projet : une conduite déjà vivante est retrouvée, question en attente comprise")
func conduiteAttachesToLiveConduite() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    // Le service conduit déjà ce dépôt (il l'a reprise seul après un redémarrage) :
    // `/conduite` rend 409, la liste le dit, et l'instantané du flux rejoue la
    // question en attente.
    transport.stubStatus("POST", "/conduite", status: 409, json: [
        "error": "conflict", "reason": "une conduite vit déjà pour \(repo.path) (s1)",
    ])
    transport.stubJSON("GET", "/v1/sessions", ["sessions": [[
        "id": "s1", "cwd": repo.path, "purpose": "project", "state": "running", "sessionFile": "/tmp/p.jsonl",
    ]]])
    transport.stubJSON("GET", "/v1/sessions/s1", [
        "id": "s1", "cwd": repo.path, "purpose": "project", "state": "running", "sessionFile": "/tmp/p.jsonl",
    ])
    emitProjectDialog(transport, id: "d-attente", method: "select", title: "Une question attend", options: ["A", "B"])
    keepProjectAlive(transport)
    let model = makeProjectModel(host: makeScriptedProjectHost(transport), stateDir: stateDir)

    await model.startConduite(repoRoot: repo, name: "Mon projet")

    #expect(model.state == .live, "une conduite vivante se retrouve, elle ne se refuse pas")
    #expect(model.identity?.repoRoot.path == repo.path)
    #expect(model.statusMessage.isEmpty)
    #expect(model.host.sessionId == "s1")
    #expect(await awaitProject { model.pendingDialog?.id == "d-attente" })
    model.stop()
}

@MainActor
@Test("conduite-de-projet : la fermeture de l'app laisse la conduite au service")
func conduiteSurvivesAppQuit() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedServiceTransport()
    keepProjectAlive(transport)
    let saved = AppDelegate.terminateProject
    defer { AppDelegate.terminateProject = saved }

    let (model, t) = await liveModel(repo: repo, stateDir: stateDir, transport: transport)
    #expect(model.state == .live)
    #expect(AppDelegate.terminateProject != nil)

    // Le geste EXACT de la fermeture de l'app : l'app se détache, rien ne part au
    // service — la conduite y reste vivante (S-7), son `DELETE` appartient au
    // geste « Arrêter le pilotage ».
    await AppDelegate.terminateProject?()

    #expect(!t.requests.contains { $0.method == "DELETE" && $0.path.hasSuffix("/conduite") })
    // L'état suit par le `@Published` du host, donc à la tâche du fil principal près.
    #expect(await awaitProject { model.state == .closed })
    model.stop()
}
