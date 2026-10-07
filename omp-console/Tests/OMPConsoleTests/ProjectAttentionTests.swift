// Preuves du signal d'attention (BR-4) : AC-9, AC-10, et la table de décision pure.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

private func planDialog(_ id: String) -> String {
    projectDialogLine(
        id: id,
        method: "select",
        extra: ["title": "Revue du plan", "options": ["Valider le plan", "Corriger le plan", "Abandonner"]]
    )
}

@MainActor
private func makeAttentionModel(
    repo: URL,
    stateDir: String,
    frontmost: Bool
) async throws -> (ProjectConsoleModel, ScriptedRpcTransport, RecordingAttention, StubPresence) {
    let transport = ScriptedRpcTransport()
    transport.readyLine = projectReadyLine()
    wireProjectAutoResponses(transport)
    makeProjectTransportRenderOnClose(transport)
    let host = makeScriptedProjectHost(transport)
    let attention = RecordingAttention()
    let presence = StubPresence()
    presence.isFrontmost = frontmost
    let model = makeProjectModel(host: host, stateDir: stateDir, presence: presence, attention: attention)
    model.start()
    await model.startConduite(repoRoot: repo, name: "Dépôt")
    return (model, transport, attention, presence)
}

// MARK: - Table de décision (pure)

@Test("la décision d'attention suit la table du contrat")
func attentionDecisionTable() {
    func action(_ awaiting: Bool, _ done: Bool, _ front: Bool, _ active: Bool) -> AttentionAction {
        AttentionDecision.action(for: AttentionInput(
            awaitingUser: awaiting, projectDone: done, windowFrontmost: front, activeRequest: active
        ))
    }
    #expect(action(true, false, false, false) == .request(.critical))
    #expect(action(true, false, false, true) == .none)
    #expect(action(true, false, true, false) == .none)
    #expect(action(true, true, false, false) == .request(.critical))
    #expect(action(false, false, true, true) == .cancel)
    #expect(action(false, false, false, true) == .cancel)
    #expect(action(false, false, false, false) == .none)
    #expect(action(false, true, false, false) == .request(.informational))
    #expect(action(false, true, true, false) == .none)
}

// MARK: - S-9 / AC-9

@MainActor
@Test("conduite-de-projet/AC-9 : une attente hors premier plan émet une demande critique, la réponse l'annule")
func attentionRequestsOnAwaitingOutOfForeground() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let (model, transport, attention, _) = try await makeAttentionModel(repo: repo, stateDir: stateDir, frontmost: false)

    transport.emit(planDialog("d1"))
    #expect(await awaitProject { attention.requested == [.critical] })

    model.selectedOptionIndex = 0
    model.answerSelectedOption()
    #expect(await awaitProject { attention.cancelled == [1] })
    #expect(model.attentionRequestID == nil)
    model.stop()
}

@MainActor
@Test("conduite-de-projet/AC-9 : la fenêtre au premier plan n'émet aucune demande")
func attentionSilentWhenFrontmost() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let (model, transport, attention, _) = try await makeAttentionModel(repo: repo, stateDir: stateDir, frontmost: true)

    transport.emit(planDialog("d1"))
    #expect(await awaitProject { model.pendingDialog != nil })
    // Laisse un tour au calcul d'attention.
    try? await Task.sleep(for: .milliseconds(50))
    #expect(attention.requested.isEmpty)
    model.stop()
}

@MainActor
@Test("conduite-de-projet/AC-9 : deux dialogues d'affilée ne font qu'UNE demande active")
func attentionSingleRequestForSuccessiveDialogs() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let (model, transport, attention, _) = try await makeAttentionModel(repo: repo, stateDir: stateDir, frontmost: false)

    transport.emit(planDialog("d1"))
    transport.emit(planDialog("d2"))
    #expect(await awaitProject { model.waitingDialogCount == 2 })
    try? await Task.sleep(for: .milliseconds(50))
    #expect(attention.requested == [.critical])
    model.stop()
}

// MARK: - S-10 / AC-10

@MainActor
@Test("conduite-de-projet/AC-10 : la fin du projet émet une demande informative et remplace l'attente")
func attentionInformsOnProjectDone() async throws {
    let fixture = StoreFixture()
    let repo = try makeGitRepository()
    let key = ProjectPaths.key(forRoot: repo.path)
    let (model, transport, attention, _) = try await makeAttentionModel(repo: repo, stateDir: fixture.root, frontmost: false)

    var running = projectObject(repoKey: key, current: 0)
    running["segments"] = [["name": "Fondations", "features": [projectFeatureObject(slug: "x", status: "merged")]]]
    fixture.publish(.projects, "\(key).json", object: running)
    #expect(await awaitProject { model.project != nil })

    // L'attente l'emporte : une demande critique, pas l'informative.
    transport.emit(planDialog("d1"))
    #expect(await awaitProject { attention.requested == [.critical] })

    model.selectedOptionIndex = 0
    model.answerSelectedOption()
    #expect(await awaitProject { attention.cancelled == [1] })

    var done = running
    done["status"] = "done"
    fixture.publish(.projects, "\(key).json", object: done)
    #expect(await awaitProject { attention.requested == [.critical, .informational] })
    #expect(model.isProjectDone)

    let counts = model.project.map(projectProgressCounts)
    #expect(counts?.merged == 1)
    #expect(counts?.total == 1)
    model.stop()
}

@MainActor
@Test("conduite-de-projet/AC-10 : la fenêtre au premier plan n'émet aucune demande à la fin")
func attentionSilentOnDoneWhenFrontmost() async throws {
    let fixture = StoreFixture()
    let repo = try makeGitRepository()
    let key = ProjectPaths.key(forRoot: repo.path)
    let (model, _, attention, _) = try await makeAttentionModel(repo: repo, stateDir: fixture.root, frontmost: true)

    var done = projectObject(repoKey: key, current: 0)
    done["status"] = "done"
    done["segments"] = [["name": "Fondations", "features": [projectFeatureObject(slug: "x", status: "merged")]]]
    fixture.publish(.projects, "\(key).json", object: done)
    #expect(await awaitProject { model.isProjectDone })
    try? await Task.sleep(for: .milliseconds(50))
    #expect(attention.requested.isEmpty)
    model.stop()
}
