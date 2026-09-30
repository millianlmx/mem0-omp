// Preuves du noyau de conduite (BR-1) : AC-1 … AC-6, transport scripté.
//
// Chaque test porte son identifiant dans le TITRE affiché (`@Test("<slug>/AC-<n> :
// …")`), retrouvé par grep à la revue.

import Foundation
import Testing
@testable import OMPConsole

/// Monte un modèle vivant : poignée de main répondue, `/project` armé.
@MainActor
private func startLiveModel(
    repo: URL,
    name: String = "Mon projet",
    stateDir: String
) async throws -> (ProjectConsoleModel, ScriptedRpcTransport) {
    let transport = ScriptedRpcTransport()
    transport.readyLine = projectReadyLine()
    wireProjectAutoResponses(transport)
    makeProjectTransportRenderOnClose(transport)
    let host = makeScriptedProjectHost(transport)
    let model = makeProjectModel(host: host, stateDir: stateDir)
    await model.startConduite(repoRoot: repo, name: name)
    return (model, transport)
}

// MARK: - S-1 / AC-1

@MainActor
@Test("conduite-de-projet/AC-1 : l'action démarre une session hébergée et arme /project sans terminal")
func conduiteStartsSessionAndArmsProject() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let (model, transport) = try await startLiveModel(repo: repo, stateDir: stateDir)

    #expect(transport.startCount == 1)
    #expect(transport.startedWith?.arguments == ["--mode", "rpc-ui", "--cwd", repo.path])
    #expect(projectField("message", in: transport.writtenCommands.first ?? "") == "/project Mon projet")
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
    let transport = ScriptedRpcTransport()
    transport.readyLine = projectReadyLine()
    wireProjectAutoResponses(transport)
    let host = makeScriptedProjectHost(transport)
    let model = makeProjectModel(host: host, stateDir: stateDir)

    await model.startConduite(repoRoot: plain, name: "X")
    #expect(transport.startCount == 0)
    #expect(model.state == .none)
    #expect(model.statusMessage == ProjectViewText.notGitRepository)
}

@MainActor
@Test("conduite-de-projet/AC-1 : un nom vide après normalisation ne lance rien")
func conduiteRefusesEmptyName() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedRpcTransport()
    transport.readyLine = projectReadyLine()
    wireProjectAutoResponses(transport)
    let host = makeScriptedProjectHost(transport)
    let model = makeProjectModel(host: host, stateDir: stateDir)

    await model.startConduite(repoRoot: repo, name: "   \n  ")
    #expect(transport.startCount == 0)
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
    let (model, transport) = try await startLiveModel(repo: repoA, name: "Alpha", stateDir: stateDir)

    await model.startConduite(repoRoot: repoB, name: "Beta")
    #expect(transport.startCount == 1)
    #expect(model.state == .live)
    #expect(model.refusal?.message == ProjectViewText.refusal(name: "Alpha", path: repoA.path))
    #expect(model.refusal?.repositoryName == "Alpha")
    #expect(model.refusal?.repositoryPath == repoA.path)

    model.dismissRefusal()
    #expect(model.refusal == nil)

    await model.closeConduite()
    #expect(model.state == .closed)
    #expect(model.identity == nil)
    #expect(model.canStartConduite)

    await model.startConduite(repoRoot: repoB, name: "Beta")
    #expect(model.state == .live)
    #expect(transport.startCount == 2)
    #expect(transport.startedWith?.arguments[3] == repoB.path)
    #expect(model.identity?.repoRoot.path == repoB.path)
    model.stop()
}

// MARK: - S-3 / AC-3

@MainActor
@Test("conduite-de-projet/AC-3 : aucune reprise à la construction du modèle")
func conduiteDoesNotResumeOnInit() async throws {
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedRpcTransport()
    transport.readyLine = projectReadyLine()
    wireProjectAutoResponses(transport)
    let host = makeScriptedProjectHost(transport)
    let suite = UserDefaults(suiteName: "project-conduite-\(UUID().uuidString)") ?? .standard
    let before = suite.dictionaryRepresentation()

    let model = ProjectConsoleModel(host: host, attention: RecordingAttention(), presence: StubPresence(), stateDir: stateDir, defaults: suite)

    #expect(transport.startCount == 0)
    #expect(transport.written.isEmpty)
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
    let (model, transport) = try await startLiveModel(repo: repo, stateDir: stateDir)

    model.prompt = "La description de mon projet"
    await model.sendText()
    #expect(projectField("message", in: transport.writtenCommands.last ?? "") == "La description de mon projet")
    #expect(model.prompt.isEmpty)

    transport.emit(projectDialogLine(
        id: "d-plan",
        method: "select",
        extra: ["title": "Le plan du projet vous convient-il ?", "options": ["Valider le plan", "Corriger le plan", "Abandonner"]]
    ))
    #expect(await awaitProject { model.pendingDialog != nil })
    #expect(model.pendingDialog?.title == "Le plan du projet vous convient-il ?")
    #expect(model.canSendText == false)
    #expect(model.canAnswerDialog == false)

    model.selectedOptionIndex = 0
    #expect(model.canAnswerDialog)
    model.answerSelectedOption()
    let answer = transport.writtenCommands.last ?? ""
    #expect(projectField("type", in: answer) == "extension_ui_response")
    #expect(projectField("id", in: answer) == "d-plan")
    #expect(projectField("value", in: answer) == "Valider le plan")
    model.stop()
}

@MainActor
@Test("conduite-de-projet/AC-4 : une présentation n'écrit jamais")
func conduiteNeverAnswersAPresentation() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let (model, transport) = try await startLiveModel(repo: repo, stateDir: stateDir)
    let countBefore = transport.written.count

    transport.emit(projectDialogLine(id: "n1", method: "notify", extra: ["message": "[project] rien à faire"]))
    #expect(await awaitProject { model.notice != nil })
    #expect(transport.written.count == countBefore)
    model.stop()
}

// MARK: - S-5 / AC-5

@MainActor
@Test("conduite-de-projet/AC-5 : « Corriger le plan » puis l'éditeur prérempli")
func conduiteCorrectsPlanThroughEditor() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let (model, transport) = try await startLiveModel(repo: repo, stateDir: stateDir)

    transport.emit(projectDialogLine(
        id: "d-revue",
        method: "select",
        extra: ["title": "Revue du plan", "options": ["Valider le plan", "Corriger le plan", "Abandonner"]]
    ))
    #expect(await awaitProject { model.pendingDialog != nil })
    model.selectedOptionIndex = 1
    model.answerSelectedOption()
    #expect(projectField("value", in: transport.writtenCommands.last ?? "") == "Corriger le plan")

    let plan = "## Fondations\n- socle-app-swift — la coque"
    transport.emit(projectDialogLine(
        id: "d-correction",
        method: "editor",
        extra: ["title": "Corrige le plan", "prefill": plan]
    ))
    #expect(await awaitProject { model.pendingDialog?.method == .editor })
    #expect(await awaitProject { model.dialogText == plan })

    let edited = plan + "\n- projet — la conduite depuis l'app"
    model.dialogText = edited
    model.answerDialogText()
    #expect(projectField("value", in: transport.writtenCommands.last ?? "") == edited)
    model.stop()
}

// MARK: - S-6 / AC-6

@MainActor
@Test("conduite-de-projet/AC-6 : une escalade de lot s'affiche et la réponse repart")
func conduiteAnswersLotEscalation() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let (model, transport) = try await startLiveModel(repo: repo, stateDir: stateDir)

    transport.emit(projectDialogLine(
        id: "d-echec",
        method: "select",
        extra: [
            "title": "Échec de la feature conduite-de-projet (segment 1 « Fondations ») : la compilation échoue",
            "options": ["Relancer la feature", "Retirer la feature du plan", "Arrêter le projet"],
        ]
    ))
    #expect(await awaitProject { model.pendingDialog != nil })
    #expect(model.pendingDialog?.title.contains("Échec de la feature") == true)
    model.selectedOptionIndex = 1
    model.answerSelectedOption()
    let answer = transport.writtenCommands.last ?? ""
    #expect(projectField("id", in: answer) == "d-echec")
    #expect(projectField("value", in: answer) == "Retirer la feature du plan")
    #expect(model.pendingDialog == nil)
    model.stop()
}

@MainActor
@Test("conduite-de-projet/AC-6 : deux dialogues en file sont traités dans l'ordre")
func conduiteQueuesDialogs() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let (model, transport) = try await startLiveModel(repo: repo, stateDir: stateDir)

    transport.emit(projectDialogLine(id: "d1", method: "select", extra: ["title": "Premier", "options": ["A", "B"]]))
    transport.emit(projectDialogLine(id: "d2", method: "input", extra: ["title": "Second", "placeholder": "texte"]))
    #expect(await awaitProject { model.waitingDialogCount == 2 })
    #expect(model.pendingDialog?.id == "d1")

    model.selectedOptionIndex = 0
    model.answerSelectedOption()
    #expect(await awaitProject { model.pendingDialog?.id == "d2" })
    #expect(model.waitingDialogCount == 1)
    model.stop()
}
