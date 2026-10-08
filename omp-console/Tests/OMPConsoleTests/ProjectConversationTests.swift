// Preuves de la vue « Projet » au patron de « Session OMP » (S-19 R3 de
// omp-console-redesign) : la conversation suit le fichier de session de l'hôte,
// et le titre multi-lignes d'un dialogue (revue du plan) se découpe en titre et
// corps.

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

@MainActor
@Test("omp-console-redesign/S-19 : la conversation de Projet suit le fichier de session de l'hôte")
func projectConversationFollowsHostSessionFile() async throws {
    let repo = try makeGitRepository()
    let stateDir = try makeProjectStateDir()
    let file = "/tmp/omp-project-conversation-\(UUID().uuidString).jsonl"
    let other = "/tmp/omp-project-conversation-\(UUID().uuidString).jsonl"

    // Deux étapes : la première sert la session et son premier fichier, la seconde
    // le MÊME `GET /v1/sessions/{id}` avec un AUTRE fichier (relu après bascule).
    let firstStage = ScriptedServiceTransport()
    stubProjectConduite(firstStage, repo: repo.path, sessionFile: file)
    keepProjectAlive(firstStage)
    let secondStage = ScriptedServiceTransport()
    secondStage.stubJSON("GET", "/v1/sessions/s1", [
        "id": "s1", "cwd": repo.path, "purpose": "project", "state": "running", "sessionFile": other,
    ])
    secondStage.stubJSON("DELETE", "/conduite", ["closed": true])
    keepProjectAlive(secondStage)
    let rolling = RollingServiceTransport([firstStage, secondStage])

    let host = makeProjectHost(makeClient: { projectServiceClient(rolling) })
    let model = makeProjectModel(host: host, stateDir: stateDir)

    await model.startConduite(repoRoot: repo, name: "Mon projet")
    #expect(model.state == .live)
    #expect(await awaitProject { model.conversation?.target.sessionFile == file })
    let first = try #require(model.conversation)
    #expect(first.target.title == "Mon projet")

    // Un second `get_state` au MÊME fichier garde la même conversation.
    await host.refreshState()
    try? await Task.sleep(for: .milliseconds(50))
    #expect(model.conversation === first)

    // Un AUTRE fichier remplace la conversation.
    rolling.advance()
    await host.refreshState()
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

@Test("omp-console-redesign/C6 : la notice est le message décodé d'une trame notice, jamais la trame")
func projectNoticeDecodesNotifyFrame() {
    let message = "## Plan\n- socle — poser \"le\" modèle"
    let payload: [String: Any] = ["level": "info", "message": message]
    let data = String(
        data: try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
        encoding: .utf8
    )!
    #expect(ServiceFrame.decode(event: "notice", data: data) == .notice(level: "info", message: message))

    // Une trame tronquée par le host n'est plus du JSON : aucune notice plutôt
    // que le texte brut échappé.
    let truncated = String(data.prefix(20)) + "…[3282 octets tronqués]"
    #expect(ServiceFrame.decode(event: "notice", data: truncated) == nil)
    // Une notice SANS message, ou un autre évènement, ne fait pas de notice.
    #expect(ServiceFrame.decode(event: "notice", data: #"{"level":"info"}"#) == nil)
    #expect(ServiceFrame.decode(event: "notice", data: #"{"message":"x"}"#) == nil)
    #expect(ServiceFrame.decode(event: "setStatus", data: #"{"level":"info","message":"x"}"#) == nil)
}
