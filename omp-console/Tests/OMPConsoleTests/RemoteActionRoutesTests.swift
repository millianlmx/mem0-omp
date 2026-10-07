// Preuves des routes de GESTE (S-10, S-11, S-12) : les gestes de la coque servis à
// distance produisent EXACTEMENT l'effet du geste local — une livraison dans une
// boîte d'inbox, une commande dans le canal, un pilote armé, un jalon validé.

import ConsoleCore
import Darwin
import Foundation
import Testing
@testable import OMPConsole

/// Le pilote de doublure : il note les dépôts armés, peut suspendre avant de
/// répondre, et peut échouer.
@MainActor
private final class RecordingPilot: PipelinePilot {
    private(set) var roots: [String] = []
    var failure: Error?
    /// Fait suspendre `ensurePilot` : la fenêtre pendant laquelle un autre geste
    /// peut se glisser en tête du journal partagé.
    var delay: Duration?

    func ensurePilot(repoRoot: String) async throws {
        roots.append(repoRoot)
        if let delay { try? await Task.sleep(for: delay) }
        if let failure { throw failure }
    }
}

/// Une bascule lue par les appels système de l'écrivain : le test sature le journal
/// avec un canal SAIN, puis fait échouer l'écriture pour prouver le 500.
private final class WriteFailToggle: @unchecked Sendable {
    var failing = false
}

private func togglingFileOps(_ toggle: WriteFailToggle) -> PipelineFileOps {
    let live = PipelineFileOps.live
    return PipelineFileOps(
        createExclusive: { path in toggle.failing ? (-1, EACCES) : live.createExclusive(path) },
        write: live.write,
        close: live.close,
        link: live.link,
        unlink: live.unlink,
        mkdir: live.mkdir
    )
}

/// Un lot avec une feature appariée à un run vivant : de quoi exercer tous les
/// gestes de carte.
@MainActor
private struct ActionFixture {
    let store: StoreFixture
    let stack: RemoteStack
    let token: String
    let pilot: RecordingPilot
    let repoRoot: String
    let repoKey: String
    let worktree: String
    let inbox: String
    let runId: String
    let slug = "alpha"

    var featureCardId: String { "feature:\(repoKey):\(slug)" }
    var idleCardId: String { "feature:\(repoKey):beta" }
    var commandDir: String { joinPath(store.root, "commands") }

    func board() -> KanbanBoard? { stack.kanban.state.kanbanBoard }

    func card(_ id: String) -> KanbanCard? { stack.kanban.state.card(id) }
}

@MainActor
private func makeActionFixture(
    waitKind: String? = nil,
    waitPrompt: String? = nil,
    pendingAsk: [String: Any]? = nil,
    withInbox: Bool = true,
    withPilot: Bool = true,
    fileOps: PipelineFileOps = .live
) async throws -> ActionFixture {
    let store = StoreFixture()
    let repoRoot = store.root + "/depot"
    let worktree = repoRoot + "/alpha"
    try FileManager.default.createDirectory(atPath: repoRoot + "/.git", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: worktree, withIntermediateDirectories: true)

    let runId = fixtureId(0xA1)
    let boxId = fixtureId(0xA2)
    let inbox = joinPath(PipelineStore.directory(.inbox, stateDir: store.root), "\(boxId)-0")
    try FileManager.default.createDirectory(atPath: inbox, withIntermediateDirectories: true)

    var feature = lotFeatureObject(
        slug: "alpha",
        state: "waiting",
        worktree: worktree,
        waitKind: waitKind
    )
    if let waitPrompt { feature["waitPrompt"] = waitPrompt }
    // Une seconde feature SANS worktree : elle n'absorbe aucun run, donc sa carte
    // n'a ni question en vol ni boîte — c'est le cas « carte sans run vivant ».
    let idle = lotFeatureObject(slug: "beta", state: "pending", worktree: "")
    store.publish(.lots, "\(fixtureId(0xA3)).json", object: lotObject(
        repoRoot: repoRoot,
        features: [feature, idle]
    ))
    store.publish(.running, "\(runId).json", object: runningObject(
        id: runId,
        cwd: worktree,
        label: "depot/alpha",
        phaseStartedAt: fixtureT0 - 5_000,
        updatedAt: fixtureT0 - 1_000,
        ownerPid: Double(getpid()),
        sessionFile: store.root + "/session.jsonl",
        inbox: withInbox ? inbox : nil,
        pendingAsk: pendingAsk
    ))
    store.publish(.projects, "\(realProjectKey(repoRoot)).json", object: projectObject(
        repoKey: realProjectKey(repoRoot),
        repoRoot: repoRoot
    ))

    let pilot = RecordingPilot()
    let actions = ActionsModel(
        writer: PipelineWriter(stateDir: store.root, fileOps: fileOps),
        clock: .live,
        pilot: withPilot ? pilot : nil
    )
    let project = makeLiveProjectModel(stateDir: store.root)
    let stack = try await RemoteStack.make(
        stateDir: store.root,
        projectModel: project,
        actionsModel: actions
    )
    stack.kanban.start()
    let ready = await awaitMainTrue { stack.kanban.state.kanbanBoard?.cards.count ?? 0 >= 2 }
    try #require(ready, "le tableau doit publier ses cartes")
    return ActionFixture(
        store: store,
        stack: stack,
        token: try await stack.pair(),
        pilot: pilot,
        repoRoot: repoRoot,
        repoKey: realProjectKey(repoRoot),
        worktree: worktree,
        inbox: inbox,
        runId: runId
    )
}

@MainActor
private func realProjectKey(_ root: String) -> String {
    ProjectPaths.key(forRoot: root)
}

/// Un modèle Projet dont la session hébergée répond à la poignée de main : la
/// conduite démarre sans lancer de process.
@MainActor
private func makeLiveProjectModel(stateDir: String) -> ProjectConsoleModel {
    let transport = ScriptedRpcTransport()
    transport.readyLine = projectReadyLine()
    wireProjectAutoResponses(transport)
    makeProjectTransportRenderOnClose(transport)
    return makeProjectModel(host: makeScriptedProjectHost(transport), stateDir: stateDir)
}

// MARK: - AC-9

@MainActor
@Test("api-distante-du-console/AC-9 : un run vivant avance sur le geste de l'appareil appairé")
func aLiveRunAdvancesOnTheDeviceGesture() async throws {
    let fixture = try await makeActionFixture(waitPrompt: "Que faire ensuite ?")
    defer { fixture.stack.stop() }

    // 1. `text` — un texte libre sur un run vivant : la livraison part dans sa boîte.
    let text = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/text",
        token: fixture.token,
        json: ["text": "avance sur le magasin"]
    )
    #expect(text.status == 202, "text → \(text.status) \(text.text)")
    #expect(try text.json(RemoteAcceptedPayload.self).accepted)
    let deliveries = try FileManager.default.contentsOfDirectory(atPath: fixture.inbox)
    #expect(deliveries.count == 1, "la livraison doit être publiée dans la boîte du run")

    // 2. `reply` — une question en TEXTE d'un maillon terminé : une commande part.
    let reply = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/reply",
        token: fixture.token,
        json: ["text": "fusionne"]
    )
    #expect(reply.status == 202)
    #expect(try FileManager.default.contentsOfDirectory(atPath: fixture.commandDir).isEmpty == false)

    // 3. `resume` — le pilote est armé, et la route attend son retour.
    let resume = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/resume",
        token: fixture.token
    )
    #expect(resume.status == 202)
    #expect(fixture.pilot.roots.last == fixture.repoRoot)
    #expect(fixture.pilot.roots.count == 2, "reply puis resume : deux sollicitations du pilote")

    // 4. `stop` — la commande d'arrêt est déposée, sans armer de pilote.
    let before = fixture.pilot.roots.count
    let stop = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/stop",
        token: fixture.token
    )
    #expect(stop.status == 202)
    #expect(fixture.pilot.roots.count == before, "arrêter ne démarre jamais un conducteur")
}

// MARK: - AC-10

@MainActor
@Test("api-distante-du-console/AC-10 : répondre à un ask le résout dans la coque")
func answeringAnAskResolvesIt() async throws {
    let fixture = try await makeActionFixture(pendingAsk: [
        "toolCallId": "call-1",
        "id": "ask-1",
        "question": "Quelle branche ?",
        "options": [
            ["label": "main", "description": "la branche par défaut"],
            ["label": "feat/x"],
        ],
    ])
    defer { fixture.stack.stop() }

    let reply = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/answer",
        token: fixture.token,
        json: ["toolCallId": "call-1", "kind": "selected", "label": "main"]
    )
    #expect(reply.status == 202)
    let files = try FileManager.default.contentsOfDirectory(atPath: fixture.inbox)
    #expect(files.count == 1)
    let published = try #require(files.first)
    let payload = try String(contentsOfFile: fixture.inbox + "/" + published, encoding: .utf8)
    #expect(payload.contains("\"kind\":\"ask\""))
    #expect(payload.contains("main"))

    // Un libellé hors des options est un 400, jamais un geste silencieux.
    let wrong = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/answer",
        token: fixture.token,
        json: ["toolCallId": "call-1", "kind": "selected", "label": "develop"]
    )
    #expect(wrong.status == 400)
    #expect(wrong.errorCode == "bad_request")

    // Une carte inconnue est un 404.
    let unknown = try await fixture.stack.call(
        "POST", "/v1/cards/feature:0000000000000000:beta/answer",
        token: fixture.token,
        json: ["kind": "custom", "text": "bonjour"]
    )
    #expect(unknown.status == 404)

    // Une carte sans question en vol est un 409.
    let other = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.idleCardId)/answer",
        token: fixture.token,
        json: ["kind": "custom", "text": "bonjour"]
    )
    #expect(other.status == 409)
}

// MARK: - AC-11

@MainActor
@Test("api-distante-du-console/AC-11 : valider un jalon le valide dans la coque")
func validatingAMilestoneValidatesIt() async throws {
    let specs = try await makeActionFixture(waitKind: "specs")
    defer { specs.stack.stop() }
    let verdict = try await specs.stack.call(
        "POST", "/v1/cards/\(specs.featureCardId)/verdict",
        token: specs.token,
        json: ["verdict": "specs"]
    )
    #expect(verdict.status == 202, "verdict → \(verdict.status) \(verdict.text)")
    #expect(try FileManager.default.contentsOfDirectory(atPath: specs.commandDir).isEmpty == false)

    let review = try await makeActionFixture(waitKind: "review")
    defer { review.stack.stop() }
    let accepted = try await review.stack.call(
        "POST", "/v1/cards/\(review.featureCardId)/verdict",
        token: review.token,
        json: ["verdict": "review"]
    )
    #expect(accepted.status == 202)

    // Le mauvais jalon est un 409 : jamais un accord donné à la place de l'utilisateur.
    let wrong = try await review.stack.call(
        "POST", "/v1/cards/\(review.featureCardId)/verdict",
        token: review.token,
        json: ["verdict": "specs"]
    )
    #expect(wrong.status == 409)
    #expect(wrong.errorCode == "conflict")
}

// MARK: - AC-12

@MainActor
@Test("api-distante-du-console/AC-12 : lancer une feature ou conduire un projet démarre l'orchestration")
func launchingAFeatureOrConductingAProjectStartsOrchestration() async throws {
    let fixture = try await makeActionFixture()
    defer { fixture.stack.stop() }

    let launch = try await fixture.stack.call(
        "POST", "/v1/features",
        token: fixture.token,
        json: [
            "repoRoot": fixture.repoRoot,
            "title": "une feature",
            "description": "son besoin",
        ]
    )
    #expect(launch.status == 202, "launch → \(launch.status) \(launch.text)")
    let commands = try FileManager.default.contentsOfDirectory(atPath: fixture.commandDir)
    #expect(!commands.isEmpty, "la commande de lancement doit être déposée dans le canal")
    #expect(
        await awaitMainTrue { fixture.pilot.roots == [fixture.repoRoot] },
        "et le pilote armé sur ce dépôt"
    )

    // Un dépôt qui n'est pas une racine git est un 400.
    let badRepo = try await fixture.stack.call(
        "POST", "/v1/features",
        token: fixture.token,
        json: ["repoRoot": "/tmp/pas-un-depot-\(UUID().uuidString)", "title": "x", "description": "y"]
    )
    #expect(badRepo.status == 400)

    // Une description BLANCHE est un 400 : `ActionsModel.launch` sort sans déposer
    // de commande, un 202 serait mensonger (S-10).
    let commandsBefore = try FileManager.default.contentsOfDirectory(atPath: fixture.commandDir).count
    let blank = try await fixture.stack.call(
        "POST", "/v1/features",
        token: fixture.token,
        json: ["repoRoot": fixture.repoRoot, "title": "une feature", "description": "   "]
    )
    #expect(blank.status == 400, "description blanche → \(blank.status) \(blank.text)")
    #expect(blank.errorCode == "bad_request")
    #expect(
        try FileManager.default.contentsOfDirectory(atPath: fixture.commandDir).count == commandsBefore,
        "une description blanche ne dépose AUCUNE commande"
    )

    // La conduite d'un projet : la session de conduite s'ouvre dans la coque.
    let conduite = try await fixture.stack.call(
        "POST", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token,
        json: ["name": "pilotage distant"]
    )
    #expect(conduite.status == 200, "conduite → \(conduite.status) \(conduite.text)")
    #expect(try conduite.json(RemoteConduitePayload.self).state == "live")
    #expect(fixture.stack.project.state == .live)

    // Second démarrage pendant que la conduite est vive : 409 (motif
    // `ConduiteRefusal`), et la conduite vive n'est pas touchée.
    let refused = try await fixture.stack.call(
        "POST", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token,
        json: ["name": "un autre nom"]
    )
    #expect(refused.status == 409, "second POST → \(refused.status) \(refused.text)")
    #expect(refused.errorCode == "conflict")
    #expect(fixture.stack.project.state == .live)

    let closed = try await fixture.stack.call(
        "DELETE", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token
    )
    #expect(closed.status == 200)
    #expect(try closed.json(RemoteConduitePayload.self).state == "closed")

    // Le refus ci-dessus est COLLANT dans le modèle (`refusal` n'est remis à `nil`
    // que par `dismissRefusal()`, appelé par l'alerte de la vue) : le démarrage
    // suivant RÉUSSIT et doit rendre 200 — jamais le 409 d'un refus antérieur non
    // acquitté à l'écran, qui ferait croire à un échec alors qu'une orchestration
    // tourne (S-10).
    let restarted = try await fixture.stack.call(
        "POST", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token,
        json: ["name": "reprise"]
    )
    #expect(restarted.status == 200, "redémarrage → \(restarted.status) \(restarted.text)")
    #expect(try restarted.json(RemoteConduitePayload.self).state == "live")
    #expect(fixture.stack.project.state == .live, "la conduite a réellement redémarré")

    let closedAgain = try await fixture.stack.call(
        "DELETE", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token
    )
    #expect(closedAgain.status == 200)
    #expect(try closedAgain.json(RemoteConduitePayload.self).state == "closed")

    // Plus aucune conduite pour ce projet : un second DELETE est un 409, jamais un
    // 200 (S-10).
    let again = try await fixture.stack.call(
        "DELETE", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token
    )
    #expect(again.status == 409, "second DELETE → \(again.status) \(again.text)")
    #expect(again.errorCode == "conflict")
}

// MARK: - Complémentaires (sans id)

@MainActor
@Test("une carte sans run vivant refuse le texte, et un corps illisible est un 400")
func textOnACardWithoutLiveRunIsConflict() async throws {
    let fixture = try await makeActionFixture(withInbox: false)
    defer { fixture.stack.stop() }

    let missing = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/text",
        token: fixture.token,
        json: ["text": "bonjour"]
    )
    #expect(missing.status == 409)

    let live = try await makeActionFixture()
    defer { live.stack.stop() }
    let empty = try await live.stack.call(
        "POST", "/v1/cards/\(live.featureCardId)/text",
        token: live.token,
        body: Data("pas du json".utf8)
    )
    #expect(empty.status == 400, "empty → \(empty.status) \(empty.text)")
    #expect(empty.errorCode == "bad_request")
}

@MainActor
@Test("une panne du conducteur à resume est un 503 portant son message")
func conductorFailureIsUnavailable() async throws {
    let fixture = try await makeActionFixture()
    defer { fixture.stack.stop() }
    fixture.pilot.failure = SessionHostError.notRunning

    let reply = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/resume",
        token: fixture.token
    )
    #expect(reply.status == 503)
    #expect(reply.errorCode == "unavailable")
    #expect(reply.errorMessage == SessionHostError.notRunning.userMessage)
}

/// Le journal est PARTAGÉ par tous les gestes et borné à 20 entrées : pendant qu'un
/// `resume` attend le conducteur, l'entrée d'un AUTRE geste (ici un `text` d'un
/// second appareil) ne doit pas être prise pour son résultat. La réponse attend la
/// FIN RÉELLE du conducteur, puis relit SA propre entrée (S-10).
@MainActor
@Test("une entrée d'un autre geste ne conclut pas un resume en vol")
func anotherGestureDoesNotConcludeAResumeInFlight() async throws {
    let fixture = try await makeActionFixture()
    defer { fixture.stack.stop() }

    // Le conducteur échoue APRÈS un délai : la fenêtre pendant laquelle un autre
    // geste peut se glisser en tête du journal.
    fixture.pilot.failure = SessionHostError.notRunning
    fixture.pilot.delay = .milliseconds(500)

    let resumeTask = Task { try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/resume",
        token: fixture.token
    ) }
    // Le `resume` est en vol dès que le conducteur est sollicité : sa réponse n'est
    // pas encore écrite, et sa fenêtre d'attente est ouverte.
    #expect(await awaitMainTrue { fixture.pilot.roots.count == 1 })

    let text = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/text",
        token: fixture.token,
        json: ["text": "un autre geste"]
    )
    #expect(text.status == 202)
    // La preuve de la mise en scène : c'est l'entrée de l'AUTRE geste qui est en
    // tête du journal partagé, exactement ce que l'ancienne corrélation lisait.
    #expect(fixture.stack.actions.journal.first?.kindLabel == ActionsText.textLabel)

    let reply = try await resumeTask.value
    #expect(reply.status == 503, "503 attendu, obtenu \(reply.status) \(reply.text)")
    #expect(reply.errorCode == "unavailable")
    #expect(reply.errorMessage == SessionHostError.notRunning.userMessage)
}

/// Le journal est BORNÉ à 20 : la détection d'un échec ne peut pas comparer les
/// comptes. Un canal qui échoue alors que le journal est plein doit rendre 500,
/// jamais un 202 mensonger (S-10).
@MainActor
@Test("un échec d'écriture du canal est un 500 même quand le journal est plein")
func writeFailureIsServerEvenWithFullJournal() async throws {
    let toggle = WriteFailToggle()
    let fixture = try await makeActionFixture(fileOps: togglingFileOps(toggle))
    defer { fixture.stack.stop() }

    for index in 0..<ActionsModel.journalLimit {
        let reply = try await fixture.stack.call(
            "POST", "/v1/cards/\(fixture.featureCardId)/text",
            token: fixture.token,
            json: ["text": "geste \(index)"]
        )
        #expect(reply.status == 202)
    }
    #expect(fixture.stack.actions.journal.count == ActionsModel.journalLimit)

    toggle.failing = true
    let failed = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/text",
        token: fixture.token,
        json: ["text": "après la panne"]
    )
    #expect(failed.status == 500, "500 attendu, obtenu \(failed.status) \(failed.text)")
    #expect(failed.errorCode == "server")
}

/// Même saturation que ci-dessus, pour l'attente asynchrone du conducteur : un
/// échec à `resume` doit rendre 503 même le journal plein (S-10).
@MainActor
@Test("une panne du conducteur à resume est un 503 même quand le journal est plein")
func conductorFailureIsUnavailableWithFullJournal() async throws {
    let fixture = try await makeActionFixture()
    defer { fixture.stack.stop() }

    for index in 0..<ActionsModel.journalLimit {
        let reply = try await fixture.stack.call(
            "POST", "/v1/cards/\(fixture.featureCardId)/text",
            token: fixture.token,
            json: ["text": "geste \(index)"]
        )
        #expect(reply.status == 202)
    }
    #expect(fixture.stack.actions.journal.count == ActionsModel.journalLimit)

    fixture.pilot.failure = SessionHostError.notRunning
    let reply = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/resume",
        token: fixture.token
    )
    #expect(reply.status == 503, "503 attendu, obtenu \(reply.status) \(reply.text)")
    #expect(reply.errorCode == "unavailable")
    #expect(reply.errorMessage == SessionHostError.notRunning.userMessage)
}

/// Fermer la conduite d'un AUTRE projet que celui conduit ne doit rien fermer : la
/// route rend 409 et la conduite vive reste entière (S-10).
@MainActor
@Test("fermer la conduite d'un autre projet est un 409")
func closingAnotherProjectsConduiteIsConflict() async throws {
    let fixture = try await makeActionFixture()
    defer { fixture.stack.stop() }

    let started = try await fixture.stack.call(
        "POST", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token,
        json: ["name": "conduite"]
    )
    #expect(started.status == 200)
    #expect(fixture.stack.project.state == .live)

    let otherRoot = fixture.store.root + "/autre-depot"
    try FileManager.default.createDirectory(atPath: otherRoot + "/.git", withIntermediateDirectories: true)
    let otherKey = realProjectKey(otherRoot)
    fixture.store.publish(.projects, "\(fixtureId(0xC1)).json", object: projectObject(
        repoKey: otherKey,
        repoRoot: otherRoot
    ))
    #expect(await awaitMainTrue {
        fixture.stack.storeHub.current().projects.projects.contains { $0.repoKey == otherKey }
    })

    let closed = try await fixture.stack.call(
        "DELETE", "/v1/projects/\(otherKey)/conduite",
        token: fixture.token
    )
    #expect(closed.status == 409, "409 attendu, obtenu \(closed.status) \(closed.text)")
    #expect(closed.errorCode == "conflict")
    #expect(fixture.stack.project.state == .live, "la conduite vive n'est pas touchée")
}

// MARK: - S-8/S-9/S-10/S-11 : dépôts connus, conduite, escalades

/// Un dépôt git jetable présent UNIQUEMENT comme lot dans le magasin (jamais
/// cadré), une conduite armée par un host scripté, la pile distante complète.
@MainActor
private struct ConduiteFixture {
    let store: StoreFixture
    let stack: RemoteStack
    let token: String
    let transport: ScriptedRpcTransport
    let repoRoot: String
    let repoKey: String
}

@MainActor
private func makeConduiteFixture() async throws -> ConduiteFixture {
    let store = StoreFixture()
    let repoRoot = store.root + "/depot"
    try FileManager.default.createDirectory(atPath: repoRoot + "/.git", withIntermediateDirectories: true)
    // Un LOT seul : ce dépôt n'est JAMAIS cadré (aucun projet dans le magasin).
    store.publish(.lots, "\(fixtureId(0xD1)).json", object: lotObject(id: fixtureId(0xD1), repoRoot: repoRoot))

    let transport = ScriptedRpcTransport()
    transport.readyLine = projectReadyLine()
    wireProjectAutoResponses(transport)
    makeProjectTransportRenderOnClose(transport)
    let project = makeProjectModel(host: makeScriptedProjectHost(transport), stateDir: store.root)
    let stack = try await RemoteStack.make(stateDir: store.root, projectModel: project)
    return ConduiteFixture(
        store: store,
        stack: stack,
        token: try await stack.pair(),
        transport: transport,
        repoRoot: repoRoot,
        repoKey: realProjectKey(repoRoot)
    )
}

@MainActor
@Test("conduite : un dépôt jamais cadré est accepté et l'état réduit porte son repoKey")
func conduiteStartsOnANeverFramedRepo() async throws {
    let fixture = try await makeConduiteFixture()
    defer { fixture.stack.stop() }

    // Avant : aucune conduite vive, donc pas d'identité dans l'état réduit.
    let before = try await fixture.stack.call("GET", "/v1/conduite", token: fixture.token)
    #expect(before.status == 200)
    let idle = try before.json(RemoteConduiteStatePayload.self)
    #expect(idle.state == "none")
    #expect(idle.repoKey == nil)
    #expect(idle.name == nil)
    #expect(idle.repoRoot == nil)
    #expect(idle.dialogs.isEmpty)

    let started = try await fixture.stack.call(
        "POST", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token,
        json: ["name": "depuis l'app"]
    )
    #expect(started.status == 200, "POST → \(started.status) \(started.text)")
    #expect(try started.json(RemoteConduitePayload.self).state == "live")

    let live = try (await fixture.stack.call("GET", "/v1/conduite", token: fixture.token))
        .json(RemoteConduiteStatePayload.self)
    #expect(live.state == "live")
    #expect(live.repoKey == fixture.repoKey, "le client ne calcule jamais le repoKey")
    #expect(live.name == "depuis l'app")
    #expect(live.repoRoot == realpathOr(fixture.repoRoot))
    #expect(live.status != nil, "la pastille vient de la même source que l'en-tête macOS")

    // Fermeture sur l'IDENTITÉ VIVE : ce dépôt n'est pourtant dans aucun projet du
    // magasin, la route ne doit donc PAS le chercher dans le magasin (S-10).
    let closed = try await fixture.stack.call(
        "DELETE", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token
    )
    #expect(closed.status == 200, "DELETE → \(closed.status) \(closed.text)")
    #expect(try closed.json(RemoteConduitePayload.self).state == "closed")

    let gone = try (await fixture.stack.call("GET", "/v1/conduite", token: fixture.token))
        .json(RemoteConduiteStatePayload.self)
    #expect(gone.state == "closed")
    #expect(gone.repoKey == nil)

    // Un second DELETE est un 409 : plus aucune conduite vive.
    let again = try await fixture.stack.call(
        "DELETE", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token
    )
    #expect(again.status == 409, "second DELETE → \(again.status) \(again.text)")
    #expect(again.errorCode == "conflict")
}

@MainActor
@Test("conduite : un dépôt inconnu est un 404 et un nom blanc un 400")
func conduiteRefusesUnknownRepoAndBlankName() async throws {
    let fixture = try await makeConduiteFixture()
    defer { fixture.stack.stop() }

    let unknown = try await fixture.stack.call(
        "POST", "/v1/projects/inconnu/conduite",
        token: fixture.token,
        json: ["name": "x"]
    )
    #expect(unknown.status == 404, "404 attendu, obtenu \(unknown.status) \(unknown.text)")
    #expect(unknown.errorCode == "not_found")
    #expect(unknown.errorMessage == "dépôt inconnu")

    let blank = try await fixture.stack.call(
        "POST", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token,
        json: ["name": "   "]
    )
    #expect(blank.status == 400, "400 attendu, obtenu \(blank.status) \(blank.text)")
    #expect(blank.errorCode == "bad_request")
    #expect(fixture.stack.project.state == .none)
}

@MainActor
@Test("escalades : les quatre formes atteignent la coque et une escalade périmée est un 409")
func dialogAnswerRoutes() async throws {
    let fixture = try await makeConduiteFixture()
    defer { fixture.stack.stop() }
    let started = try await fixture.stack.call(
        "POST", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token,
        json: ["name": "projet"]
    )
    #expect(started.status == 200)

    // select : la file poussée porte l'escalade ENTIÈRE.
    fixture.transport.emit(projectDialogLine(
        id: "d-select",
        method: "select",
        extra: ["title": "Le plan", "options": ["Valider le plan", "Corriger le plan"]]
    ))
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog?.id == "d-select" })
    let pushed = try (await fixture.stack.call("GET", "/v1/conduite", token: fixture.token))
        .json(RemoteConduiteStatePayload.self)
    #expect(pushed.dialogs.map(\.id) == ["d-select"])
    #expect(pushed.dialogs.first?.method == .select)

    // Un libellé hors des options est un 400, et l'escalade RESTE en file.
    let outOfRange = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-select",
        token: fixture.token,
        json: ["kind": "value", "value": "Autre"]
    )
    #expect(outOfRange.status == 400, "400 attendu, obtenu \(outOfRange.status) \(outOfRange.text)")
    #expect(outOfRange.errorCode == "bad_request")
    #expect(fixture.stack.project.pendingDialog?.id == "d-select")

    let selected = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-select",
        token: fixture.token,
        json: ["kind": "value", "value": "Corriger le plan"]
    )
    #expect(selected.status == 202, "select → \(selected.status) \(selected.text)")
    #expect(projectField("value", in: fixture.transport.writtenCommands.last ?? "") == "Corriger le plan")

    // editor : une valeur VIDE est ACCEPTÉE (parité `canAnswerDialog`).
    fixture.transport.emit(projectDialogLine(id: "d-editor", method: "editor", extra: ["title": "Corrige", "prefill": "plan"]))
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog?.id == "d-editor" })
    let empty = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-editor",
        token: fixture.token,
        json: ["kind": "value", "value": ""]
    )
    #expect(empty.status == 202, "editor → \(empty.status) \(empty.text)")

    // confirm : `confirmed: false` envoie le refus.
    fixture.transport.emit(projectDialogLine(id: "d-confirm", method: "confirm", extra: ["title": "Sûr ?"]))
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog?.id == "d-confirm" })
    let declined = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-confirm",
        token: fixture.token,
        json: ["kind": "confirmed", "confirmed": false]
    )
    #expect(declined.status == 202)
    #expect(projectJsonObject(fixture.transport.writtenCommands.last ?? "")?["confirmed"] as? Bool == false)

    // input : une saisie blanche est un 400, une saisie réelle un 202.
    fixture.transport.emit(projectDialogLine(id: "d-input", method: "input", extra: ["title": "Nom", "placeholder": "texte"]))
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog?.id == "d-input" })
    let blank = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-input",
        token: fixture.token,
        json: ["kind": "value", "value": "   "]
    )
    #expect(blank.status == 400)
    #expect(blank.errorMessage == "texte vide")
    let typed = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-input",
        token: fixture.token,
        json: ["kind": "value", "value": "socle"]
    )
    #expect(typed.status == 202)

    // Une escalade PÉRIMÉE (id qui n'est plus la tête) est un 409, avant tout acte.
    fixture.transport.emit(projectDialogLine(id: "d-annule", method: "input", extra: ["title": "Dernier", "placeholder": "texte"]))
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog?.id == "d-annule" })
    let stale = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-autre",
        token: fixture.token,
        json: ["kind": "cancelled"]
    )
    #expect(stale.status == 409, "409 attendu, obtenu \(stale.status) \(stale.text)")
    #expect(stale.errorCode == "conflict")
    #expect(stale.errorMessage == "l'escalade a changé depuis la demande")
    #expect(fixture.stack.project.pendingDialog?.id == "d-annule", "l'escalade n'est pas consommée")

    let cancelled = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-annule",
        token: fixture.token,
        json: ["kind": "cancelled"]
    )
    #expect(cancelled.status == 202)

    // Un kind hors du vocabulaire est un 400.
    fixture.transport.emit(projectDialogLine(id: "d-kind", method: "input", extra: ["title": "Encore", "placeholder": "texte"]))
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog?.id == "d-kind" })
    let unknownKind = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-kind",
        token: fixture.token,
        json: ["kind": "autre"]
    )
    #expect(unknownKind.status == 400)
    #expect(unknownKind.errorCode == "bad_request")
    // Elle reste en file : on l'annule pour prouver que la file poussée se vide
    // après CHAQUE réponse.
    let cleanup = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-kind",
        token: fixture.token,
        json: ["kind": "cancelled"]
    )
    #expect(cleanup.status == 202)

    // La file poussée est repartie à vide après chaque réponse.
    let final = try (await fixture.stack.call("GET", "/v1/conduite", token: fixture.token))
        .json(RemoteConduiteStatePayload.self)
    #expect(final.dialogs.isEmpty)
}
