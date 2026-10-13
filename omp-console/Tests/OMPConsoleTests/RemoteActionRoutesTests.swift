// Preuves des routes de GESTE (S-10, S-11, S-12) : les gestes de la coque servis à
// distance produisent EXACTEMENT l'effet du geste local — une livraison dans une
// boîte d'inbox, une commande POSTÉE au service, un dépôt piloté, un jalon validé.

import ConsoleClient
import ConsoleCore
import Darwin
import Foundation
import Testing
@testable import OMPConsole

/// Le pilote de doublure : il note les dépôts pilotés, peut suspendre avant de
/// répondre, et peut échouer. Le protocole de pilote et le pool de conducteurs de
/// l'ancien mode RPC n'existent plus : c'est la fermeture `pilot` de
/// `PipelineWriter` (`POST /v1/repos/{repo}/pilot`) que ce double remplace, côté app.
private final class RecordingPilot: @unchecked Sendable {
    private let lock = NSLock()
    private var storedRoots: [String] = []
    private var storedFailure: Error?
    /// Fait suspendre `ensurePilot` : la fenêtre pendant laquelle un autre geste
    /// peut se glisser en tête du journal partagé.
    private var storedDelay: Duration?

    var roots: [String] { lock.withLock { storedRoots } }

    var failure: Error? {
        get { lock.withLock { storedFailure } }
        set { lock.withLock { storedFailure = newValue } }
    }

    var delay: Duration? {
        get { lock.withLock { storedDelay } }
        set { lock.withLock { storedDelay = newValue } }
    }

    func ensurePilot(repoRoot: String) async throws {
        lock.withLock { storedRoots.append(repoRoot) }
        let delay = lock.withLock { storedDelay }
        if let delay { try? await Task.sleep(for: delay) }
        if let failure = lock.withLock({ storedFailure }) { throw failure }
    }
}

/// Ce que le service a REÇU : les commandes POSTÉES (`POST /v1/repos/{repo}/commands`)
/// et l'accusé (ou l'échec) que chaque appel rend. L'app ne dépose plus de fichier
/// dans un répertoire `commands/` : elle poste, et la réponse porte l'accusé.
private final class ServiceRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [(repo: String, body: [String: Any])] = []
    private var storedFailure: Error?
    private var storedAck = ServiceCommandAck(id: "x", repo: "", kind: nil, state: .taken, reason: nil, at: 0)

    var posts: [(repo: String, body: [String: Any])] { lock.withLock { stored } }

    var ack: ServiceCommandAck {
        get { lock.withLock { storedAck } }
        set { lock.withLock { storedAck = newValue } }
    }

    var failure: Error? {
        get { lock.withLock { storedFailure } }
        set { lock.withLock { storedFailure = newValue } }
    }

    func post(_ repo: String, _ body: [String: Any]) throws -> ServiceCommandAck {
        lock.lock()
        defer { lock.unlock() }
        stored.append((repo, body))
        if let storedFailure { throw storedFailure }
        return storedAck
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
    let commands: ServiceRecorder
    let repoRoot: String
    let repoKey: String
    let worktree: String
    let inbox: String
    let runId: String
    let slug = "alpha"

    var featureCardId: String { "feature:\(repoKey):\(slug)" }
    var idleCardId: String { "feature:\(repoKey):beta" }

    func board() -> KanbanBoard? { stack.kanban.state.kanbanBoard }

    func card(_ id: String) -> KanbanCard? { stack.kanban.state.card(id) }

    /// La dernière commande POSTÉE au service : le canal n'est plus un répertoire
    /// de fichiers, l'app poste et le service répond l'accusé.
    var lastPostedBody: [String: Any]? { commands.posts.last?.body }

    /// Attend la fin du POST de la dernière commande : elle part dans une tâche, et
    /// seule la route `resume` l'attend (les autres rendent 202 sur l'entrée
    /// `awaitingAck`).
    func awaitCommand() async {
        await stack.actions.commandTask?.value
    }
}

@MainActor
private func makeActionFixture(
    waitKind: String? = nil,
    waitPrompt: String? = nil,
    pendingAsk: [String: Any]? = nil,
    withInbox: Bool = true,
    withPilot: Bool = true,
    fileOps: PipelineFileOps = .live,
    featureState: String = "waiting",
    ownerPid: Double = Double(getpid())
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
        state: featureState,
        worktree: worktree,
        waitKind: waitKind
    )
    if let waitPrompt { feature["waitPrompt"] = waitPrompt }
    // Une seconde feature SANS worktree : elle n'absorbe aucun run, donc sa carte
    // n'a ni question en vol ni boîte — c'est le cas « carte sans run vivant ».
    let idle = lotFeatureObject(slug: "beta", state: "pending", worktree: "")
    store.publish(.lots, "\(fixtureId(0xA3)).json", object: lotObject(
        repoRoot: repoRoot,
        features: [feature, idle],
        ownerPid: ownerPid
    ))
    store.publish(.running, "\(runId).json", object: runningObject(
        id: runId,
        cwd: worktree,
        label: "depot/alpha",
        phaseStartedAt: fixtureT0 - 5_000,
        updatedAt: fixtureT0 - 1_000,
        ownerPid: ownerPid,
        sessionFile: store.root + "/session.jsonl",
        inbox: withInbox ? inbox : nil,
        pendingAsk: pendingAsk
    ))
    store.publish(.projects, "\(realProjectKey(repoRoot)).json", object: projectObject(
        repoKey: realProjectKey(repoRoot),
        repoRoot: repoRoot
    ))

    let pilot = RecordingPilot()
    let commands = ServiceRecorder()
    let actions = ActionsModel(
        writer: PipelineWriter(
            stateDir: store.root,
            fileOps: fileOps,
            post: { repo, body in try commands.post(repo, body) },
            pilot: { repo in
                guard withPilot else { return }
                try await pilot.ensurePilot(repoRoot: repo)
            }
        ),
        clock: .live
    )
    let project = makeLiveProjectModel(stateDir: store.root, repoRoot: repoRoot)
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
        commands: commands,
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

/// Un modèle Projet dont la conduite est armée par le SERVICE scripté : la
/// conduite démarre sans lancer de process, l'escalade arrive par le flux SSE et la
/// réponse repart en HTTP.
@MainActor
private func makeLiveProjectModel(stateDir: String, repoRoot: String) -> ProjectConsoleModel {
    let transport = ScriptedServiceTransport()
    stubProjectConduite(transport, repo: repoRoot)
    // Trois flux ouverts : la conduite peut être démarrée, arrêtée et redémarrée
    // dans un même test sans tomber `dead` (chaque démarrage consomme le suivant).
    openServiceStream(transport, count: 3)
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
    #expect(try text.json(OMPConsole.RemoteAcceptedPayload.self).accepted)
    let deliveries = try FileManager.default.contentsOfDirectory(atPath: fixture.inbox)
    #expect(deliveries.count == 1, "la livraison doit être publiée dans la boîte du run")

    // 2. `reply` — une question en TEXTE d'un maillon terminé : une commande est
    // POSTÉE au service (l'app n'écrit plus de fichier de commande).
    let reply = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/reply",
        token: fixture.token,
        json: ["text": "fusionne"]
    )
    #expect(reply.status == 202)
    await fixture.awaitCommand()
    #expect(fixture.lastPostedBody?["kind"] as? String == "reply")
    #expect(fixture.lastPostedBody?["text"] as? String == "fusionne")

    // 3. `resume` — le dépôt est piloté, et la route attend son retour.
    let resume = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/resume",
        token: fixture.token
    )
    #expect(resume.status == 202)
    #expect(fixture.pilot.roots == [realpathOr(fixture.repoRoot)], "seul `resume` sollicite le pilote")

    // 4. `stop` — la commande d'arrêt est POSTÉE, sans piloter de dépôt.
    let before = fixture.pilot.roots.count
    let stop = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/stop",
        token: fixture.token
    )
    #expect(stop.status == 202)
    await fixture.awaitCommand()
    #expect(fixture.lastPostedBody?["kind"] as? String == "stop")
    #expect(fixture.pilot.roots.count == before, "arrêter ne pilote jamais un dépôt")
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
    await specs.awaitCommand()
    #expect(specs.lastPostedBody?["kind"] as? String == "verdict")
    #expect(specs.lastPostedBody?["verdict"] as? String == "v")

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
    // La commande de lancement est POSTÉE au service (l'app n'écrit aucun canal de
    // fichiers) : c'est le SERVICE qui arme le conducteur, sur SA lecture de cette
    // commande — l'app n'a donc plus à piloter elle-même.
    await fixture.awaitCommand()
    let posted = try #require(fixture.commands.posts.last)
    #expect(posted.body["kind"] as? String == "launch")
    #expect(posted.body["title"] as? String == "une feature")
    #expect(posted.body["description"] as? String == "son besoin")
    #expect(posted.repo == realpathOr(fixture.repoRoot), "la commande est adressée au dépôt")
    let commandsAfterLaunch = fixture.commands.posts.count

    // Un dépôt qui n'est pas une racine git est un 400.
    let badRepo = try await fixture.stack.call(
        "POST", "/v1/features",
        token: fixture.token,
        json: ["repoRoot": "/tmp/pas-un-depot-\(UUID().uuidString)", "title": "x", "description": "y"]
    )
    #expect(badRepo.status == 400)

    // Une description BLANCHE est un 400 : `ActionsModel.launch` sort sans poster
    // de commande, un 202 serait mensonger (S-10).
    let blank = try await fixture.stack.call(
        "POST", "/v1/features",
        token: fixture.token,
        json: ["repoRoot": fixture.repoRoot, "title": "une feature", "description": "   "]
    )
    #expect(blank.status == 400, "description blanche → \(blank.status) \(blank.text)")
    #expect(blank.errorCode == "bad_request")
    #expect(
        fixture.commands.posts.count == commandsAfterLaunch,
        "une description blanche ne poste AUCUNE commande"
    )

    // La conduite d'un projet : la session de conduite s'ouvre dans la coque.
    let conduite = try await fixture.stack.call(
        "POST", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token,
        json: ["name": "pilotage distant"]
    )
    #expect(conduite.status == 200, "conduite → \(conduite.status) \(conduite.text)")
    #expect(try conduite.json(OMPConsole.RemoteConduitePayload.self).state == "live")
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
    #expect(try closed.json(OMPConsole.RemoteConduitePayload.self).state == "closed")

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
    #expect(try restarted.json(OMPConsole.RemoteConduitePayload.self).state == "live")
    #expect(fixture.stack.project.state == .live, "la conduite a réellement redémarré")

    let closedAgain = try await fixture.stack.call(
        "DELETE", "/v1/projects/\(fixture.repoKey)/conduite",
        token: fixture.token
    )
    #expect(closedAgain.status == 200)
    #expect(try closedAgain.json(OMPConsole.RemoteConduitePayload.self).state == "closed")

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
    fixture.pilot.failure = ServiceSessionError.notRunning

    let reply = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/resume",
        token: fixture.token
    )
    #expect(reply.status == 503)
    #expect(reply.errorCode == "unavailable")
    #expect(reply.errorMessage == ServiceSessionError.notRunning.userMessage)
}

// MARK: - accueil-en-cours-melange-pause-et-compte, AC-4

@MainActor
@Test("accueil-en-cours-melange-pause-et-compte/AC-4 : resume sur une feature en échec ou bloquée poste relaunch, jamais pilot")
func resumeOnARelaunchableCardPostsRelaunch() async throws {
    for state in ["failed", "blocked"] {
        let fixture = try await makeActionFixture(featureState: state)
        defer { fixture.stack.stop() }
        let card = try #require(fixture.card(fixture.featureCardId))
        #expect(KanbanActionPresentation.relaunchable(card), "la carte \(state) doit être relançable")

        let reply = try await fixture.stack.call(
            "POST", "/v1/cards/\(fixture.featureCardId)/resume",
            token: fixture.token
        )
        #expect(reply.status == 202, "\(state) : 202 attendu, obtenu \(reply.status) \(reply.text)")
        #expect(fixture.pilot.roots.isEmpty, "\(state) : la relance ne sollicite pas le pilote")
        let post = try #require(fixture.commands.posts.last)
        #expect(fixture.commands.posts.count == 1)
        #expect(post.repo == realpathOr(fixture.repoRoot))
        #expect(Set(post.body.keys) == ["version", "id", "sentAt", "repo", "kind", "slug"])
        #expect(post.body["kind"] as? String == "relaunch")
        #expect(post.body["slug"] as? String == fixture.slug)
        #expect(post.body["repo"] as? String == realpathOr(fixture.repoRoot))
        let entry = try #require(fixture.stack.actions.journal.first)
        #expect(entry.id == post.body["id"] as? String)
        #expect(entry.kindLabel == ActionsText.resumeLabel)
        #expect(entry.targetLabel == fixture.slug)
        #expect(entry.state == .taken)
    }
}

@MainActor
@Test("accueil-en-cours-melange-pause-et-compte/AC-4 : resume sur une carte en pause garde le chemin pilote, sans commande")
func resumeOnAPausedCardStillPilots() async throws {
    let fixture = try await makeActionFixture(featureState: "running", ownerPid: Double(deadPid()))
    defer { fixture.stack.stop() }
    let card = try #require(fixture.card(fixture.featureCardId))
    #expect(KanbanActionPresentation.resumable(card), "la carte doit être en pause")
    #expect(!KanbanActionPresentation.relaunchable(card))

    let reply = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/resume",
        token: fixture.token
    )
    #expect(reply.status == 202, "202 attendu, obtenu \(reply.status) \(reply.text)")
    #expect(fixture.pilot.roots == [realpathOr(fixture.repoRoot)])
    #expect(fixture.commands.posts.isEmpty, "une reprise de pilote ne poste aucune commande")
}

@MainActor
@Test("accueil-en-cours-melange-pause-et-compte/AC-4 : une relance refusée est un 409 au motif du service, une panne d'envoi un 503")
func relaunchRefusalIsConflictAndFailureIsUnavailable() async throws {
    let fixture = try await makeActionFixture(featureState: "failed")
    defer { fixture.stack.stop() }
    let motif = "relance possible sur une feature bloquée, échouée ou annulée"
    fixture.commands.ack = ServiceCommandAck(
        id: "x", repo: "", kind: "relaunch", state: .refused, reason: motif, at: 0
    )

    let refused = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/resume",
        token: fixture.token
    )
    #expect(refused.status == 409, "409 attendu, obtenu \(refused.status) \(refused.text)")
    #expect(refused.errorCode == "conflict")
    #expect(refused.errorMessage == motif)
    #expect(fixture.stack.actions.journal.first?.state == .refused(reason: motif))

    // Un refus sans motif garde un message lisible.
    fixture.commands.ack = ServiceCommandAck(
        id: "x", repo: "", kind: "relaunch", state: .refused, reason: nil, at: 0
    )
    let bare = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/resume",
        token: fixture.token
    )
    #expect(bare.status == 409)
    #expect(bare.errorMessage == "relance refusée")

    // Service injoignable : l'envoi échoue, la route rend 503 au motif journalisé.
    fixture.commands.failure = ServiceSessionError.notRunning
    let unavailable = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/resume",
        token: fixture.token
    )
    #expect(unavailable.status == 503, "503 attendu, obtenu \(unavailable.status) \(unavailable.text)")
    #expect(unavailable.errorCode == "unavailable")
    #expect(unavailable.errorMessage == ServiceSessionError.notRunning.userMessage)
    #expect(fixture.pilot.roots.isEmpty)
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
    fixture.pilot.failure = ServiceSessionError.notRunning
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
    #expect(reply.errorMessage == ServiceSessionError.notRunning.userMessage)
}

/// Le journal est BORNÉ à 20 : la détection d'un échec ne peut pas comparer les
/// comptes. Un canal qui échoue alors que le journal est plein doit rendre 409 au
/// motif relu dans le journal, jamais un 202 mensonger (S-10).
@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-5 : un échec d'écriture du canal est un 409 au motif du journal même quand le journal est plein")
func writeFailureIsConflictEvenWithFullJournal() async throws {
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
    #expect(failed.status == 409, "409 attendu, obtenu \(failed.status) \(failed.text)")
    #expect(failed.errorCode == "conflict")
    let head = try #require(fixture.stack.actions.journal.first)
    guard case .failed(let reason) = head.state else {
        Issue.record("la tête du journal doit être l'échec d'écriture, obtenu \(head.state)")
        return
    }
    #expect(failed.errorMessage == reason)
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

    fixture.pilot.failure = ServiceSessionError.notRunning
    let reply = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/resume",
        token: fixture.token
    )
    #expect(reply.status == 503, "503 attendu, obtenu \(reply.status) \(reply.text)")
    #expect(reply.errorCode == "unavailable")
    #expect(reply.errorMessage == ServiceSessionError.notRunning.userMessage)
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
/// cadré), une conduite armée par le SERVICE scripté, la pile distante complète.
@MainActor
private struct ConduiteFixture {
    let store: StoreFixture
    let stack: RemoteStack
    let token: String
    let transport: ScriptedServiceTransport
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

    let transport = ScriptedServiceTransport()
    stubProjectConduite(transport, repo: repoRoot)
    transport.stubJSON("POST", "/v1/sessions/s1/dialogs/d-select", ["accepted": true])
    transport.stubJSON("POST", "/v1/sessions/s1/dialogs/d-editor", ["accepted": true])
    transport.stubJSON("POST", "/v1/sessions/s1/dialogs/d-confirm", ["accepted": true])
    transport.stubJSON("POST", "/v1/sessions/s1/dialogs/d-input", ["accepted": true])
    transport.stubJSON("POST", "/v1/sessions/s1/dialogs/d-annule", ["accepted": true])
    transport.stubJSON("POST", "/v1/sessions/s1/dialogs/d-kind", ["accepted": true])
    // Le flux reste OUVERT : les escalades sont poussées par `emitServiceDialog`,
    // une seule connexion servant tout le dialogue.
    openServiceStream(transport, count: 3)
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
    let idle = try before.json(OMPConsole.RemoteConduiteStatePayload.self)
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
    #expect(try started.json(OMPConsole.RemoteConduitePayload.self).state == "live")

    let live = try (await fixture.stack.call("GET", "/v1/conduite", token: fixture.token))
        .json(OMPConsole.RemoteConduiteStatePayload.self)
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
    #expect(try closed.json(OMPConsole.RemoteConduitePayload.self).state == "closed")

    let gone = try (await fixture.stack.call("GET", "/v1/conduite", token: fixture.token))
        .json(OMPConsole.RemoteConduiteStatePayload.self)
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
    emitServiceDialog(
        fixture.transport,
        id: "d-select",
        method: "select",
        title: "Le plan",
        options: ["Valider le plan", "Corriger le plan"]
    )
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog?.id == "d-select" })
    let pushed = try (await fixture.stack.call("GET", "/v1/conduite", token: fixture.token))
        .json(OMPConsole.RemoteConduiteStatePayload.self)
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
    // La réponse part en HTTP vers le service (la route rend 202 sur l'ordre, la
    // requête suit) : l'attente porte sur la requête réelle.
    #expect(await awaitMainTrue {
        fixture.transport.requests
            .last { $0.path.hasSuffix("/dialogs/d-select") }?
            .body?["value"] as? String == "Corriger le plan"
    })

    // editor : une valeur VIDE est ACCEPTÉE (parité `canAnswerDialog`).
    emitServiceDialog(
        fixture.transport,
        id: "d-editor",
        method: "editor",
        title: "Corrige",
        prefill: "plan"
    )
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog?.id == "d-editor" })
    let empty = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-editor",
        token: fixture.token,
        json: ["kind": "value", "value": ""]
    )
    #expect(empty.status == 202, "editor → \(empty.status) \(empty.text)")

    // confirm : `confirmed: false` envoie le refus.
    emitServiceDialog(fixture.transport, id: "d-confirm", method: "confirm", title: "Sûr ?")
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog?.id == "d-confirm" })
    let declined = try await fixture.stack.call(
        "POST", "/v1/conduite/dialogs/d-confirm",
        token: fixture.token,
        json: ["kind": "confirmed", "confirmed": false]
    )
    #expect(declined.status == 202)
    #expect(await awaitMainTrue {
        fixture.transport.requests
            .last { $0.path.hasSuffix("/dialogs/d-confirm") }?
            .body?["confirmed"] as? Bool == false
    })

    // input : une saisie blanche est un 400, une saisie réelle un 202.
    emitServiceDialog(fixture.transport, id: "d-input", method: "input", title: "Nom", placeholder: "texte")
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
    emitServiceDialog(fixture.transport, id: "d-annule", method: "input", title: "Dernier", placeholder: "texte")
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
    emitServiceDialog(fixture.transport, id: "d-kind", method: "input", title: "Encore", placeholder: "texte")
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

    // La file poussée est repartie à vide après chaque réponse (la réponse part en
    // HTTP : on attend que la file se vide, jamais un délai deviné).
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog == nil })
    let final = try (await fixture.stack.call("GET", "/v1/conduite", token: fixture.token))
        .json(OMPConsole.RemoteConduiteStatePayload.self)
    #expect(final.dialogs.isEmpty)
}

// MARK: - validations-de-geste-enfermees-dans-le-h (BR-1 : gestes de carte typés)

/// La question en vol `call-1` des preuves de gestes typés.
private var typedAsk: [String: Any] {
    [
        "toolCallId": "call-1",
        "id": "ask-1",
        "question": "Quelle branche ?",
        "options": [["label": "main"], ["label": "feat/x"]],
    ]
}

/// Une carte d'une forme valide mais absente du tableau.
private let unknownCardId = "feature:0000000000000000:beta"

/// Ce qu'un geste pourrait avoir émis : livraisons dans la boîte du run,
/// commandes postées au service, dépôts pilotés, entrées de journal.
private struct EmittedEffects: Equatable {
    let deliveries: [String]
    let posts: Int
    let pilotedRoots: [String]
    let journal: [String]

    @MainActor
    init(_ fixture: ActionFixture) throws {
        deliveries = try FileManager.default.contentsOfDirectory(atPath: fixture.inbox).sorted()
        posts = fixture.commands.posts.count
        pilotedRoots = fixture.pilot.roots
        journal = fixture.stack.actions.journal.map(\.id)
    }
}

/// Un corps posté sans ses clés propres à chaque émission.
private func comparable(_ body: [String: Any]?) -> NSDictionary {
    var body = body ?? [:]
    body.removeValue(forKey: "id")
    body.removeValue(forKey: "sentAt")
    return body as NSDictionary
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-1 : répondre par la méthode typée émet la réponse sans corps HTTP")
func typedAnswerDeliversTheAnswer() async throws {
    let fixture = try await makeActionFixture(pendingAsk: typedAsk)
    defer { fixture.stack.stop() }

    try await fixture.stack.remoteActions.answer(
        cardId: fixture.featureCardId,
        toolCallId: "call-1",
        answer: .selected(label: "main")
    )

    let files = try FileManager.default.contentsOfDirectory(atPath: fixture.inbox)
    #expect(files.count == 1)
    let published = try #require(files.first)
    let payload = try String(contentsOfFile: fixture.inbox + "/" + published, encoding: .utf8)
    #expect(payload.contains("\"kind\":\"ask\""))
    #expect(payload.contains("main"))
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-2 : une réponse à l'ancienne question est périmée quel que soit son libellé")
func typedAnswerToAStaleQuestionIsRefused() async throws {
    let fixture = try await makeActionFixture(pendingAsk: typedAsk)
    defer { fixture.stack.stop() }
    let before = try EmittedEffects(fixture)

    for label in ["main", "develop"] {
        await #expect(throws: GestureRefusal.staleQuestion) {
            try await fixture.stack.remoteActions.answer(
                cardId: fixture.featureCardId,
                toolCallId: "call-0",
                answer: .selected(label: label)
            )
        }
    }
    // Un identifiant VIDE est fourni : il ne désigne pas la question en vol.
    await #expect(throws: GestureRefusal.staleQuestion) {
        try await fixture.stack.remoteActions.answer(
            cardId: fixture.featureCardId,
            toolCallId: "",
            answer: .custom(text: "bonjour")
        )
    }
    #expect(try EmittedEffects(fixture) == before, "aucune réponse n'est émise")
    #expect(before.deliveries.isEmpty)
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-3 : un libellé hors des options est refusé sans rien émettre")
func typedAnswerWithALabelOutsideOptionsIsRefused() async throws {
    let fixture = try await makeActionFixture(pendingAsk: typedAsk)
    defer { fixture.stack.stop() }
    let before = try EmittedEffects(fixture)

    await #expect(throws: GestureRefusal.labelNotInOptions) {
        try await fixture.stack.remoteActions.answer(
            cardId: fixture.featureCardId,
            toolCallId: "call-1",
            answer: .selected(label: "develop")
        )
    }
    #expect(try EmittedEffects(fixture) == before, "aucune réponse n'est émise")
    #expect(before.deliveries.isEmpty)
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-4 : réplique, réponse personnalisée et texte blancs rendent « texte vide » sans rien émettre")
func typedBlankTextGesturesAreRefused() async throws {
    let fixture = try await makeActionFixture(waitPrompt: "Que faire ensuite ?", pendingAsk: typedAsk)
    defer { fixture.stack.stop() }
    let actions = fixture.stack.remoteActions
    let before = try EmittedEffects(fixture)

    for blank in ["", " \n\t"] {
        await #expect(throws: GestureRefusal.emptyText) {
            try await actions.reply(cardId: fixture.featureCardId, text: blank)
        }
        await #expect(throws: GestureRefusal.emptyText) {
            try await actions.answer(cardId: fixture.featureCardId, toolCallId: "call-1", answer: .custom(text: blank))
        }
        await #expect(throws: GestureRefusal.emptyText) {
            try await actions.text(cardId: fixture.featureCardId, text: blank)
        }
    }
    #expect(try EmittedEffects(fixture) == before, "rien n'est émis")
    #expect(before.deliveries.isEmpty)
    #expect(before.posts == 0)
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-5 : un échec consigné au journal rend « échec au journal » avec le motif relu")
func typedAnswerReportsTheJournalFailure() async throws {
    let toggle = WriteFailToggle()
    let fixture = try await makeActionFixture(pendingAsk: typedAsk, fileOps: togglingFileOps(toggle))
    defer { fixture.stack.stop() }
    toggle.failing = true

    let error = await #expect(throws: GestureRefusal.self) {
        try await fixture.stack.remoteActions.answer(
            cardId: fixture.featureCardId,
            toolCallId: "call-1",
            answer: .selected(label: "main")
        )
    }
    let head = try #require(fixture.stack.actions.journal.first)
    guard case .failed(let reason) = head.state else {
        Issue.record("la tête du journal doit être l'échec d'écriture, obtenu \(head.state)")
        return
    }
    #expect(error == .journalFailure(reason))
    #expect(reason.hasPrefix("écriture impossible"), "motif de l'écrivain : \(reason)")
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-6 : chaque geste de carte sur une carte inconnue rend « carte inconnue » sans rien émettre")
func typedCardGesturesOnAnUnknownCardAreRefused() async throws {
    let fixture = try await makeActionFixture(waitPrompt: "Que faire ensuite ?", pendingAsk: typedAsk)
    defer { fixture.stack.stop() }
    let actions = fixture.stack.remoteActions
    let before = try EmittedEffects(fixture)

    await #expect(throws: GestureRefusal.unknownCard) {
        try await actions.answer(cardId: unknownCardId, toolCallId: nil, answer: .custom(text: "bonjour"))
    }
    await #expect(throws: GestureRefusal.unknownCard) {
        try await actions.reply(cardId: unknownCardId, text: "x")
    }
    await #expect(throws: GestureRefusal.unknownCard) {
        try await actions.text(cardId: unknownCardId, text: "x")
    }
    await #expect(throws: GestureRefusal.unknownCard) {
        try await actions.verdict(cardId: unknownCardId, verdict: .specs)
    }
    await #expect(throws: GestureRefusal.unknownCard) {
        try await actions.resume(cardId: unknownCardId)
    }
    await #expect(throws: GestureRefusal.unknownCard) {
        try await actions.stop(cardId: unknownCardId)
    }
    #expect(try EmittedEffects(fixture) == before, "rien n'est émis")
    #expect(before.posts == 0)
    #expect(before.pilotedRoots.isEmpty)
    #expect(before.deliveries.isEmpty)
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-7 : répondre par la méthode typée réussit")
func typedAnswerSucceeds() async throws {
    let fixture = try await makeActionFixture(pendingAsk: typedAsk)
    defer { fixture.stack.stop() }

    try await fixture.stack.remoteActions.answer(
        cardId: fixture.featureCardId,
        toolCallId: nil,
        answer: .custom(text: "une autre branche")
    )
    let files = try FileManager.default.contentsOfDirectory(atPath: fixture.inbox)
    #expect(files.count == 1, "la réponse est livrée dans la boîte du run")
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-7 : répliquer par la méthode typée poste la commande reply")
func typedReplySucceeds() async throws {
    let fixture = try await makeActionFixture(waitPrompt: "Que faire ensuite ?")
    defer { fixture.stack.stop() }

    try await fixture.stack.remoteActions.reply(cardId: fixture.featureCardId, text: "fusionne")
    await fixture.awaitCommand()
    #expect(fixture.lastPostedBody?["kind"] as? String == "reply")
    #expect(fixture.lastPostedBody?["text"] as? String == "fusionne")
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-7 : valider un jalon par la méthode typée poste le verdict")
func typedVerdictSucceeds() async throws {
    let fixture = try await makeActionFixture(waitKind: "specs")
    defer { fixture.stack.stop() }

    try await fixture.stack.remoteActions.verdict(cardId: fixture.featureCardId, verdict: .specs)
    await fixture.awaitCommand()
    #expect(fixture.lastPostedBody?["kind"] as? String == "verdict")
    #expect(fixture.lastPostedBody?["verdict"] as? String == "v")

    // Le jalon non attendu est refusé sans commande.
    let posts = fixture.commands.posts.count
    await #expect(throws: GestureRefusal.milestoneNotAwaited) {
        try await fixture.stack.remoteActions.verdict(cardId: fixture.featureCardId, verdict: .review)
    }
    #expect(fixture.commands.posts.count == posts)
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-7 : reprendre par la méthode typée pilote le dépôt")
func typedResumeSucceeds() async throws {
    let fixture = try await makeActionFixture()
    defer { fixture.stack.stop() }

    try await fixture.stack.remoteActions.resume(cardId: fixture.featureCardId)
    #expect(fixture.pilot.roots == [realpathOr(fixture.repoRoot)])

    // Le pilote en panne : la cause porte le message utilisateur du service.
    fixture.pilot.failure = ServiceSessionError.notRunning
    await #expect(throws: GestureRefusal.serviceFailure(ServiceSessionError.notRunning.userMessage)) {
        try await fixture.stack.remoteActions.resume(cardId: fixture.featureCardId)
    }
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-7 : arrêter par la méthode typée poste la commande stop")
func typedStopSucceeds() async throws {
    let fixture = try await makeActionFixture()
    defer { fixture.stack.stop() }

    try await fixture.stack.remoteActions.stop(cardId: fixture.featureCardId)
    await fixture.awaitCommand()
    #expect(fixture.lastPostedBody?["kind"] as? String == "stop")
    #expect(fixture.pilot.roots.isEmpty, "arrêter ne pilote jamais un dépôt")
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-7 : lancer une feature par la méthode typée poste la commande launch")
func typedLaunchSucceeds() async throws {
    let fixture = try await makeActionFixture()
    defer { fixture.stack.stop() }

    try await fixture.stack.remoteActions.launch(
        repoRoot: fixture.repoRoot,
        title: "t",
        description: "d",
        modelReqSpecs: nil,
        modelImplReview: nil
    )
    await fixture.awaitCommand()
    let posted = try #require(fixture.commands.posts.last)
    #expect(posted.body["kind"] as? String == "launch")
    #expect(posted.body["title"] as? String == "t")
    #expect(posted.repo == realpathOr(fixture.repoRoot))

    // Chaque règle de lancement a sa cause, sans commande.
    let posts = fixture.commands.posts.count
    await #expect(throws: GestureRefusal.emptyTitle) {
        try await fixture.stack.remoteActions.launch(
            repoRoot: fixture.repoRoot, title: " ", description: "d", modelReqSpecs: nil, modelImplReview: nil
        )
    }
    await #expect(throws: GestureRefusal.emptyDescription) {
        try await fixture.stack.remoteActions.launch(
            repoRoot: fixture.repoRoot, title: "t", description: "\n", modelReqSpecs: nil, modelImplReview: nil
        )
    }
    await #expect(throws: GestureRefusal.invalidRepoRoot) {
        try await fixture.stack.remoteActions.launch(
            repoRoot: "/tmp/pas-un-depot-\(UUID().uuidString)",
            title: "t", description: "d", modelReqSpecs: nil, modelImplReview: nil
        )
    }
    #expect(fixture.commands.posts.count == posts)
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-8 : la route et la méthode typée produisent le même effet et la même cause traduite")
func routeAndTypedGestureHaveTheSameEffect() async throws {
    let fixture = try await makeActionFixture(waitKind: "specs")
    defer { fixture.stack.stop() }
    let actions = fixture.stack.remoteActions

    // Verdict : une fois par HTTP, une fois par la méthode typée.
    let routed = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/verdict",
        token: fixture.token,
        json: ["verdict": "specs"]
    )
    #expect(routed.status == 202, "verdict → \(routed.status) \(routed.text)")
    await fixture.awaitCommand()
    try await actions.verdict(cardId: fixture.featureCardId, verdict: .specs)
    await fixture.awaitCommand()
    try expectSameEffect(fixture, kind: "verdict")

    // Arrêter : même preuve.
    let stopped = try await fixture.stack.call(
        "POST", "/v1/cards/\(fixture.featureCardId)/stop",
        token: fixture.token
    )
    #expect(stopped.status == 202, "stop → \(stopped.status) \(stopped.text)")
    await fixture.awaitCommand()
    try await actions.stop(cardId: fixture.featureCardId)
    await fixture.awaitCommand()
    try expectSameEffect(fixture, kind: "stop")

    // Refus : la même cause typée, traduite par la table unique.
    let asking = try await makeActionFixture(pendingAsk: typedAsk)
    defer { asking.stack.stop() }
    let stale = try await asking.stack.call(
        "POST", "/v1/cards/\(asking.featureCardId)/answer",
        token: asking.token,
        json: ["toolCallId": "call-0", "kind": "selected", "label": "main"]
    )
    #expect(stale.status == 409)
    #expect(stale.errorCode == GestureRefusal.staleQuestion.apiError.code)
    #expect(stale.errorMessage == GestureRefusal.staleQuestion.apiError.message)
    await #expect(throws: GestureRefusal.staleQuestion) {
        try await asking.stack.remoteActions.answer(
            cardId: asking.featureCardId,
            toolCallId: "call-0",
            answer: .selected(label: "main")
        )
    }
}

/// Les deux dernières commandes postées sont identiques hors `id` et `sentAt`, et
/// leurs entrées de journal disent la même chose.
@MainActor
private func expectSameEffect(_ fixture: ActionFixture, kind: String) throws {
    let posts = fixture.commands.posts
    try #require(posts.count >= 2)
    let routed = posts[posts.count - 2]
    let typed = posts[posts.count - 1]
    #expect(typed.body["kind"] as? String == kind)
    #expect(routed.repo == typed.repo)
    #expect(comparable(routed.body) == comparable(typed.body), "\(kind) : même commande émise")
    let journal = fixture.stack.actions.journal
    try #require(journal.count >= 2)
    let typedEntry = journal[0]
    let routedEntry = journal[1]
    #expect(typedEntry.id == typed.body["id"] as? String)
    #expect(routedEntry.id == routed.body["id"] as? String)
    #expect(typedEntry.kindLabel == routedEntry.kindLabel)
    #expect(typedEntry.targetLabel == routedEntry.targetLabel)
    #expect(typedEntry.state == routedEntry.state)
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-9 : un corps mal formé est un 400 qui n'atteint jamais le geste")
func malformedBodiesNeverReachTheGesture() async throws {
    let fixture = try await makeActionFixture(waitKind: "specs", pendingAsk: typedAsk)
    defer { fixture.stack.stop() }
    let before = try EmittedEffects(fixture)
    let answer = "/v1/cards/\(fixture.featureCardId)/answer"
    let verdict = "/v1/cards/\(fixture.featureCardId)/verdict"

    let cases: [(path: String, body: Data?, message: String)] = [
        (answer, nil, "corps JSON absent"),
        (answer, Data("{".utf8), "corps JSON illisible"),
        (answer, jsonBody(["kind": "autre"]), "kind inconnu"),
        (answer, jsonBody(["kind": "selected"]), "libellé absent"),
        (answer, jsonBody(["kind": "custom"]), "texte absent"),
        (verdict, jsonBody(["verdict": "x"]), "verdict inconnu"),
        ("/v1/cards/\(fixture.featureCardId)/reply", Data("{".utf8), "corps JSON illisible"),
        ("/v1/cards/\(fixture.featureCardId)/text", nil, "corps JSON absent"),
        ("/v1/features", Data("{".utf8), "corps JSON illisible"),
        // Le corps est décodé AVANT tout contrôle d'état : une carte inconnue
        // avec un corps illisible est un 400, jamais un 404.
        ("/v1/cards/\(unknownCardId)/answer", Data("{".utf8), "corps JSON illisible"),
    ]
    for item in cases {
        let reply = try await fixture.stack.call("POST", item.path, token: fixture.token, body: item.body)
        #expect(reply.status == 400, "\(item.path) \(item.message) → \(reply.status) \(reply.text)")
        #expect(reply.errorCode == "bad_request")
        #expect(reply.errorMessage == item.message, "\(item.path) → \(reply.errorMessage ?? "-")")
        #expect(try EmittedEffects(fixture) == before, "\(item.path) \(item.message) : aucun modèle touché")
    }
    #expect(before.deliveries.isEmpty)
    #expect(before.posts == 0)
}

// MARK: - Dialogues de conduite typés (validations-de-geste-enfermees-dans-le-h, BR-2)

/// Une conduite vive démarrée par la méthode typée, avec une escalade `id` en tête
/// de file.
@MainActor
private func conduiteWithDialog(
    _ id: String,
    method: String,
    options: [String] = []
) async throws -> ConduiteFixture {
    let fixture = try await makeConduiteFixture()
    let started = try await fixture.stack.remoteActions.startConduite(repoKey: fixture.repoKey, name: "projet")
    #expect(started.state == "live")
    emitServiceDialog(fixture.transport, id: id, method: method, title: "Escalade", options: options)
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog?.id == id })
    return fixture
}

/// Les réponses de dialogue POSTées au service par la conduite.
@MainActor
private func dialogPosts(_ fixture: ConduiteFixture) -> Int {
    fixture.transport.requests.filter { $0.method == "POST" && $0.path.contains("/dialogs/") }.count
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-4 : une saisie blanche à une escalade de conduite rend « texte vide » sans rien émettre")
func typedBlankConduiteDialogIsRefused() async throws {
    let fixture = try await conduiteWithDialog("d-input", method: "input")
    defer { fixture.stack.stop() }

    for blank in ["  ", "", " \n\t"] {
        await #expect(throws: GestureRefusal.emptyText) {
            try await fixture.stack.remoteActions.answerDialog(id: "d-input", answer: .value(blank))
        }
    }
    #expect(fixture.stack.project.pendingDialog?.id == "d-input", "l'escalade reste en tête de file")
    #expect(dialogPosts(fixture) == 0, "aucune réponse ne part au service")
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-7 : répondre à une escalade de conduite par la méthode typée la consomme")
func typedConduiteDialogSucceeds() async throws {
    let fixture = try await conduiteWithDialog("d-select", method: "select", options: ["Valider le plan", "Corriger le plan"])
    defer { fixture.stack.stop() }

    try await fixture.stack.remoteActions.answerDialog(id: "d-select", answer: .value("Corriger le plan"))
    #expect(await awaitMainTrue { fixture.stack.project.pendingDialog == nil }, "la tête de file est consommée")
    #expect(await awaitMainTrue {
        fixture.transport.requests
            .last { $0.path.hasSuffix("/dialogs/d-select") }?
            .body?["value"] as? String == "Corriger le plan"
    }, "la réponse part au service")
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-9 : un corps de réponse d'escalade mal formé est un 400 qui laisse la file intacte")
func malformedConduiteDialogBodiesNeverReachTheGesture() async throws {
    let fixture = try await conduiteWithDialog("d-select", method: "select", options: ["Valider le plan"])
    defer { fixture.stack.stop() }
    let path = "/v1/conduite/dialogs/d-select"

    let cases: [(body: Data?, message: String)] = [
        (jsonBody(["kind": "value"]), "valeur absente"),
        (jsonBody(["kind": "confirmed"]), "confirmation absente"),
        (jsonBody(["kind": "autre"]), "kind inconnu"),
        (Data("{".utf8), "corps JSON illisible"),
        (nil, "corps JSON absent"),
    ]
    for item in cases {
        let reply = try await fixture.stack.call("POST", path, token: fixture.token, body: item.body)
        #expect(reply.status == 400, "\(item.message) → \(reply.status) \(reply.text)")
        #expect(reply.errorCode == "bad_request")
        #expect(reply.errorMessage == item.message)
        #expect(fixture.stack.project.pendingDialog?.id == "d-select", "\(item.message) : la tête de file est inchangée")
    }
    #expect(dialogPosts(fixture) == 0, "aucune réponse ne part au service")
}

// MARK: - validations-de-geste-enfermees-dans-le-h, AC-10 (rejeu iPhone)

/// Un vrai client iPhone (`ConsoleClientModel`) appairé à la pile d'une fixture :
/// adresse manuelle, code généré par la coque.
@MainActor
private func pairedPhone(_ fixture: ActionFixture) async throws -> ConsoleClientModel {
    let client = makeContractClient(discovery: ContractDiscovery())
    _ = client.setManualAddress("127.0.0.1:\(fixture.stack.port)")
    try await client.pair(code: fixture.stack.registry.generateCode().value, deviceName: "iPhone de recette")
    return client
}

@MainActor
@Test("validations-de-geste-enfermees-dans-le-h/AC-10 : les gestes iPhone répondre, verdict, reprendre et arrêter rejoués contre le Mac réussissent ou rendent leur cause")
func phoneGesturesReplayedAgainstTheMac() async throws {
    // Répondre : question en vol `call-1`, écriture du canal commutable.
    let toggle = WriteFailToggle()
    let asking = try await makeActionFixture(pendingAsk: typedAsk, fileOps: togglingFileOps(toggle))
    defer { asking.stack.stop() }
    let askingPhone = try await pairedPhone(asking)
    defer { askingPhone.stop() }

    await #expect(throws: ClientError.api(.conflict("la question a changé depuis la demande"))) {
        _ = try await askingPhone.answer(
            cardId: asking.featureCardId, kind: "selected", label: "main", text: nil, toolCallId: "call-0"
        )
    }
    #expect(try FileManager.default.contentsOfDirectory(atPath: asking.inbox).isEmpty, "question périmée : rien n'est livré")

    toggle.failing = true
    await #expect(throws: ClientError.api(.conflict("écriture impossible (Permission denied)"))) {
        _ = try await askingPhone.answer(
            cardId: asking.featureCardId, kind: "selected", label: "main", text: nil, toolCallId: "call-1"
        )
    }
    toggle.failing = false

    let answered = try await askingPhone.answer(
        cardId: asking.featureCardId, kind: "selected", label: "main", text: nil, toolCallId: "call-1"
    )
    #expect(answered.accepted)
    #expect(try FileManager.default.contentsOfDirectory(atPath: asking.inbox).count == 1, "la réponse est livrée au run")

    // Verdict : jalon specs attendu.
    let milestone = try await makeActionFixture(waitKind: "specs")
    defer { milestone.stack.stop() }
    let milestonePhone = try await pairedPhone(milestone)
    defer { milestonePhone.stop() }

    await #expect(throws: ClientError.api(.conflict("ce jalon n'est pas attendu"))) {
        _ = try await milestonePhone.verdict(cardId: milestone.featureCardId, verdict: "review")
    }
    #expect(milestone.commands.posts.isEmpty, "jalon non attendu : aucune commande")
    #expect(try await milestonePhone.verdict(cardId: milestone.featureCardId, verdict: "specs").accepted)
    await milestone.awaitCommand()
    #expect(milestone.lastPostedBody?["kind"] as? String == "verdict")

    // Reprendre puis arrêter : carte de lot.
    let lot = try await makeActionFixture()
    defer { lot.stack.stop() }
    let lotPhone = try await pairedPhone(lot)
    defer { lotPhone.stop() }

    lot.pilot.failure = ServiceSessionError.notRunning
    await #expect(throws: ClientError.api(.unavailable(ServiceSessionError.notRunning.userMessage))) {
        _ = try await lotPhone.resume(cardId: lot.featureCardId)
    }
    lot.pilot.failure = nil
    let pilotedBefore = lot.pilot.roots.count
    #expect(try await lotPhone.resume(cardId: lot.featureCardId).accepted)
    #expect(lot.pilot.roots.count == pilotedBefore + 1, "le pilote sain est sollicité")

    #expect(try await lotPhone.stop(cardId: lot.featureCardId).accepted)
    await lot.awaitCommand()
    #expect(lot.lastPostedBody?["kind"] as? String == "stop")

    let postsBefore = lot.commands.posts.count
    await #expect(throws: ClientError.api(.notFound("carte inconnue"))) {
        _ = try await lotPhone.stop(cardId: unknownCardId)
    }
    #expect(lot.commands.posts.count == postsBefore, "carte inconnue : aucune commande")
}
