// Preuves de la vue « Projet » au patron de « Session OMP » (S-19 R3 de
// omp-console-redesign) : la conversation suit le fichier de session de l'hôte,
// et le titre multi-lignes d'un dialogue (revue du plan) se découpe en titre et
// corps.

import Foundation
import Testing
@testable import OMPConsole

@MainActor
@Test("omp-console-redesign/S-19 : la conversation de Projet suit le fichier de session de l'hôte")
func projectConversationFollowsHostSessionFile() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let transport = ScriptedRpcTransport()
    transport.readyLine = projectReadyLine()
    makeProjectTransportRenderOnClose(transport)
    var pendingStateId: String?
    transport.onWrite = { line in
        guard let object = projectJsonObject(line), let type = object["type"] as? String else { return }
        let id = object["id"] as? String ?? "?"
        switch type {
        case "negotiate_protocol":
            transport.emit(projectResponseLine(id: id, command: "negotiate_protocol", data: ["protocolVersion": 2]))
        case "get_state":
            pendingStateId = id
        case "prompt":
            transport.emit(projectResponseLine(id: id, command: "prompt"))
        default:
            break
        }
    }
    let host = makeScriptedProjectHost(transport)
    let model = makeProjectModel(host: host, stateDir: stateDir)
    let file = "/tmp/omp-project-conversation-\(UUID().uuidString).jsonl"

    // Avant la réponse de `get_state`, aucun fichier n'est connu : pas de conversation.
    let start = Task { @MainActor in await model.startConduite(repoRoot: repo, name: "Mon projet") }
    #expect(await awaitProject { host.state == .running && pendingStateId != nil })
    #expect(model.conversation == nil)

    let firstId = try #require(pendingStateId)
    pendingStateId = nil
    transport.emit(projectResponseLine(id: firstId, command: "get_state", data: [
        "sessionId": "session-abcdef12",
        "sessionFile": file,
    ]))
    await start.value
    #expect(model.state == .live)
    #expect(await awaitProject { model.conversation?.target.sessionFile == file })
    let first = try #require(model.conversation)
    #expect(first.target.title == "Mon projet")

    // Un second `get_state` au MÊME fichier garde la même conversation.
    let refresh = Task { @MainActor in await host.refreshState() }
    #expect(await awaitProject { pendingStateId != nil })
    let secondId = try #require(pendingStateId)
    pendingStateId = nil
    transport.emit(projectResponseLine(id: secondId, command: "get_state", data: [
        "sessionId": "session-abcdef12",
        "sessionFile": file,
    ]))
    await refresh.value
    try await Task.sleep(for: .milliseconds(50))
    #expect(model.conversation === first)

    // Un AUTRE fichier remplace la conversation.
    let other = "/tmp/omp-project-conversation-\(UUID().uuidString).jsonl"
    let moved = Task { @MainActor in await host.refreshState() }
    #expect(await awaitProject { pendingStateId != nil })
    let thirdId = try #require(pendingStateId)
    pendingStateId = nil
    transport.emit(projectResponseLine(id: thirdId, command: "get_state", data: [
        "sessionId": "session-abcdef12",
        "sessionFile": other,
    ]))
    await moved.value
    #expect(await awaitProject { model.conversation?.target.sessionFile == other })
    #expect(model.conversation !== first)

    // Clore la conduite retire la conversation.
    await model.closeConduite()
    #expect(model.conversation == nil)
    model.stop()
}

@Test("omp-console-redesign/S-19 : un dialogue à plusieurs lignes se découpe en titre et corps")
func projectDialogTitleSplitsIntoHeadingAndBody() {
    // La revue du plan, au format de `planDialogTitle` (omp-mem0-req/project.ts).
    let plan = """
    Plan du projet — 2 segment(s), 3 feature(s)
    But : livrer la conduite
    Fonction : piloter les features

    ## Socle
    - socle-1 — poser le modèle
    - socle-2 — brancher la vue

    ## Finition
    - finition-1 — polir le rendu

    """
    let split = ProjectDialogText.split(plan)
    #expect(split.heading == "Plan du projet — 2 segment(s), 3 feature(s)")
    // Le corps est le plan COMPLET, sans la ligne de titre ni les blancs qui
    // l'encadrent : rien n'est coupé ni réécrit.
    #expect(split.body == """
    But : livrer la conduite
    Fonction : piloter les features

    ## Socle
    - socle-1 — poser le modèle
    - socle-2 — brancher la vue

    ## Finition
    - finition-1 — polir le rendu
    """)

    // Une seule ligne : pas de corps.
    let single = ProjectDialogText.split("Le cadrage du projet est-il complet ?")
    #expect(single.heading == "Le cadrage du projet est-il complet ?")
    #expect(single.body == nil)

    // Lignes vides en tête, fins de ligne CRLF, corps fait de blancs seulement.
    let padded = ProjectDialogText.split("\n  \r\nÉchec de la feature x\r\nAucun segment ne démarre.\r\n")
    #expect(padded.heading == "Échec de la feature x")
    #expect(padded.body == "Aucun segment ne démarre.")
    #expect(ProjectDialogText.split("Titre\n \n\n").body == nil)
    #expect(ProjectDialogText.split("").heading.isEmpty)
}

@Test("omp-console-redesign/C12a : le suffixe « (n/m) » d'une question devient « Question n sur m »")
func projectDialogStepCounter() {
    let step = ProjectDialogText.step("Quel est l'objectif principal du projet en l'état ? (1/2)")
    #expect(step.question == "Quel est l'objectif principal du projet en l'état ?")
    #expect(step.counter == "Question 1 sur 2")

    // Aucun compteur hors d'un suffixe « (n/m) » valide : le titre reste intact.
    for heading in [
        "Plan du projet — 2 segment(s), 3 feature(s)",
        "Combien ? (3/2)",
        "Combien ? (0/2)",
        "Combien ? (a/b)",
        "(1/2)",
        "Choisir (1/2) puis valider",
    ] {
        let plain = ProjectDialogText.step(heading)
        #expect(plain.question == heading)
        #expect(plain.counter == nil)
    }
}

@Test("omp-console-redesign/C6 : la notice est le message décodé d'une trame notify, jamais la trame")
func projectNoticeDecodesNotifyFrame() {
    let frame = ###"{"type":"extension_ui_request","id":"n1","method":"notify","message":"## Plan\n- socle — poser \"le\" modèle"}"###
    #expect(ProjectConsoleModel.notifyMessage(frame: frame) == "## Plan\n- socle — poser \"le\" modèle")

    // Une trame tronquée par le host n'est plus du JSON : aucune notice plutôt
    // que le texte brut échappé.
    let truncated = String(frame.prefix(60)) + "…[3282 octets tronqués]"
    #expect(ProjectConsoleModel.notifyMessage(frame: truncated) == nil)
    // Une autre méthode, ou un message vide, ne fait pas de notice.
    #expect(ProjectConsoleModel.notifyMessage(frame: #"{"type":"extension_ui_request","method":"setStatus","message":"x"}"#) == nil)
    #expect(ProjectConsoleModel.notifyMessage(frame: #"{"type":"extension_ui_request","method":"notify","message":"  "}"#) == nil)
}
