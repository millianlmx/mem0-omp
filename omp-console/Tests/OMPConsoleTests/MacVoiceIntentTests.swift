// Preuves tracées de Siri sur le Mac (siri-mac-questions-en-attente, S-8.1) : la
// conversation des attentes de ConsoleCore (`VoicePendingWalk`, la même que sur
// l'iPhone) branchée par `MacSiriPending` sur une pile RÉELLE (`RemoteStack`), avec
// les gestes typés de `RemoteActions` que sert aussi l'API distante. Les tours de
// parole de Siri sont scriptés ; l'effet de chaque réponse est observé là où le
// geste l'écrit (boîte du run, commande postée, requête au service scripté). Le
// contexte est passé directement : un test ne lit jamais `intent.voice`
// (`AppDependency` hors du déroulé d'un intent est fatal).

import AppIntents
import ConsoleCore
import Darwin
import Foundation
import Testing
@testable import OMPConsole

// MARK: - Doublures

/// Les instants de la fixture : la plus ancienne demande d'abord. L'horloge de la
/// pile reste sur `fixtureT0`.
private enum Ages {
    static let editor = fixtureT0 - 6_000
    static let ask = fixtureT0 - 5_000
    static let text = fixtureT0 - 4_000
    static let conduite = fixtureT0 - 3_000
    static let session = fixtureT0 - 2_000
    static let audit = fixtureT0 - 1_000
}

private let auditId = "a0d1700000000077"

/// Ce que le service a reçu de l'écrivain de pipeline (`POST /v1/repos/{repo}/commands`).
private final class PostedCommands: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [[String: Any]] = []

    var bodies: [[String: Any]] { lock.withLock { stored } }

    func post(_ body: [String: Any]) -> ServiceCommandAck {
        lock.withLock { stored.append(body) }
        return ServiceCommandAck(id: "x", repo: "", kind: nil, state: .taken, reason: nil, at: 0)
    }
}

/// La bascule d'échec d'écriture du canal (doublure des tests de routes).
private final class WriteFailure: @unchecked Sendable {
    var failing = false
}

private func failingFileOps(_ failure: WriteFailure) -> PipelineFileOps {
    let live = PipelineFileOps.live
    return PipelineFileOps(
        createExclusive: { path in failure.failing ? (-1, EACCES) : live.createExclusive(path) },
        write: live.write,
        close: live.close,
        link: live.link,
        unlink: live.unlink,
        mkdir: live.mkdir
    )
}

/// Un « non » dit à Siri : `confirm` lève, sans annuler la tâche.
private struct Declined: Error {}

/// Les tours de parole scriptés : chaque étape de `ask` rend l'énoncé de
/// l'utilisateur (ou lève : annulation), chaque `confirm` rejoue une réponse
/// oui/non (« non » ou file vide lève) ; les dialogues dits sont notés.
@MainActor
private final class SpokenScript: VoiceConversation {
    private(set) var prompts: [String] = []
    private(set) var confirms: [String] = []
    private var steps: [@MainActor () async throws -> String]
    private var confirmations: [Bool]

    init(steps: [@MainActor () async throws -> String], confirmations: [Bool] = []) {
        self.steps = steps
        self.confirmations = confirmations
    }

    /// « annuler » lève `CancellationError`, comme Siri quand la personne annule.
    convenience init(_ utterances: [String], confirmations: [Bool] = []) {
        self.init(steps: utterances.map { said in
            { @MainActor in
                if said == "annuler" { throw CancellationError() }
                return said
            }
        }, confirmations: confirmations)
    }

    func ask(_ prompt: String) async throws -> String {
        prompts.append(prompt)
        guard !steps.isEmpty else {
            Issue.record("question inattendue : \(prompt)")
            throw CancellationError()
        }
        return try await steps.removeFirst()()
    }

    func confirm(_ prompt: String) async throws {
        confirms.append(prompt)
        guard !confirmations.isEmpty, confirmations.removeFirst() else { throw Declined() }
    }
}

/// Le magasin d'un dépôt : des features à question en vol, à question en texte ou
/// à escalade d'audit, publiées en un seul lot.
@MainActor
private final class VoiceStore {
    let store = StoreFixture()
    let repoRoot: String
    private var features: [[String: Any]] = []
    private var runs: [String: [String: Any]] = [:]
    private var seed = 0xB0
    /// La boîte du run de chaque feature, par slug.
    private(set) var inboxes: [String: String] = [:]

    init() throws {
        repoRoot = store.root + "/depot"
        try FileManager.default.createDirectory(atPath: repoRoot + "/.git", withIntermediateDirectories: true)
    }

    /// Une question en vol (`ask`) d'un run vivant.
    func ask(_ slug: String, at: Double, toolCallId: String, question: String, options: [String]) throws {
        let worktree = try makeWorktree(slug)
        features.append(lotFeatureObject(slug: slug, state: "running", phase: "impl", worktree: worktree, sinceAt: at - 10_000))
        publishRun(slug, worktree: worktree, at: at, pendingAsk: askObject(toolCallId, question, options))
    }

    /// Une question en TEXTE d'une feature en attente, son run vivant.
    func textQuestion(_ slug: String, at: Double, prompt: String) throws {
        let worktree = try makeWorktree(slug)
        var feature = lotFeatureObject(slug: slug, state: "waiting", phase: "impl", worktree: worktree, waitKind: "answer", sinceAt: at)
        feature["waitPrompt"] = prompt
        features.append(feature)
        publishRun(slug, worktree: worktree, at: at, pendingAsk: nil)
    }

    /// Une escalade `ask` d'une feature lancée par un audit vivant.
    func auditEscalation(_ slug: String, at: Double, question: String, options: [String]) {
        var feature = lotFeatureObject(slug: slug, state: "waiting", phase: "req", waitKind: "answer", sinceAt: at)
        feature["auditSession"] = joinPath(store.directory(.audits), auditId)
        feature["escalation"] = [
            "key": "ask:\(slug):call-9",
            // La sorte de l'arbitre (`question` | `jalon`) ; la sorte de réponse
            // (`ask`) vient du préfixe de la clé.
            "kind": "question",
            "phase": "req",
            "question": question,
            "options": options,
            "reason": "Le brief ne dit rien.",
            "at": at,
        ]
        features.append(feature)
        store.publish(.audits, "\(auditId).json", object: [
            "version": 1,
            "id": auditId,
            "repoRoot": repoRoot,
            "repoKey": ProjectPaths.key(forRoot: repoRoot),
            "key": joinPath(store.directory(.audits), auditId),
            "orientation": "fiabilité",
            "status": "launched",
            "createdAt": at - 10_000,
            "updatedAt": at - 10_000,
            "proposal": NSNull(),
            "launches": [
                ["slug": slug, "launched": true, "reason": NSNull(), "state": "running", "phase": "req", "prUrl": NSNull()],
            ],
            "failure": NSNull(),
        ])
    }

    /// Publie le lot et la fiche projet du dépôt.
    func publishLot() {
        let repoKey = ProjectPaths.key(forRoot: repoRoot)
        store.publish(.lots, "\(fixtureId(0xA3)).json", object: lotObject(repoRoot: repoRoot, features: features))
        store.publish(.projects, "\(repoKey).json", object: projectObject(repoKey: repoKey, repoRoot: repoRoot))
    }

    /// Remplace la question en vol du run de `slug` (nil : la retire).
    func replaceAsk(_ slug: String, toolCallId: String?, question: String = "", options: [String] = []) {
        guard var run = runs[slug], let id = run["id"] as? String else {
            Issue.record("run inconnu : \(slug)")
            return
        }
        run["updatedAt"] = (run["updatedAt"] as? Double ?? fixtureT0) + 1
        if let toolCallId {
            run["pendingAsk"] = askObject(toolCallId, question, options)
        } else {
            run.removeValue(forKey: "pendingAsk")
        }
        runs[slug] = run
        store.publish(.running, "\(id).json", object: run)
    }

    private func makeWorktree(_ slug: String) throws -> String {
        let worktree = repoRoot + "/" + slug
        try FileManager.default.createDirectory(atPath: worktree, withIntermediateDirectories: true)
        return worktree
    }

    private func publishRun(_ slug: String, worktree: String, at: Double, pendingAsk: [String: Any]?) {
        seed += 2
        let id = fixtureId(seed)
        let inbox = store.createBox("\(fixtureId(seed + 1))-0")
        inboxes[slug] = inbox
        let run = runningObject(
            id: id,
            cwd: worktree,
            label: "depot/\(slug)",
            phaseStartedAt: at - 10_000,
            updatedAt: at,
            ownerPid: Double(getpid()),
            sessionFile: store.root + "/\(slug).jsonl",
            inbox: inbox,
            pendingAsk: pendingAsk
        )
        runs[slug] = run
        store.publish(.running, "\(id).json", object: run)
    }

    private func askObject(_ toolCallId: String, _ question: String, _ options: [String]) -> [String: Any] {
        ["toolCallId": toolCallId, "id": "ask-\(toolCallId)", "question": question, "options": options.map { ["label": $0] }]
    }
}

/// Une conduite de projet vivante dont la file porte un dialogue.
@MainActor
private func conduite(dialogId: String, method: String, title: String, options: [String], at: Double) async throws -> (ProjectConsoleModel, ScriptedServiceTransport, URL) {
    let repo = try makeGitRepository()
    let transport = ScriptedServiceTransport()
    emitProjectDialog(transport, id: dialogId, method: method, title: title, options: options, at: at)
    keepProjectAlive(transport)
    stubProjectConduite(transport, repo: repo.path)
    transport.stubJSON("POST", "/dialogs/\(dialogId)", ["accepted": true])
    let model = makeProjectModel(host: makeScriptedProjectHost(transport), stateDir: try makeProjectStateDir())
    await model.startConduite(repoRoot: repo, name: "Mon projet")
    try #require(await awaitMainTrue(timeout: 5.0) { model.host.dialogQueue.first?.id == dialogId })
    return (model, transport, repo)
}

/// Une session OMP hébergée vivante dont la file porte un dialogue.
@MainActor
private func hostedSession(dialogId: String, method: String, title: String, options: [String], at: Double) async throws -> (SessionConsoleModel, ScriptedServiceTransport, URL) {
    let root = try makeGitRepository()
    let transport = ScriptedServiceTransport()
    stubServiceSession(transport, cwd: root.path, sessionFile: "/tmp/session.jsonl")
    transport.stubJSON("POST", "/dialogs/\(dialogId)", ["accepted": true])
    openServiceStream(transport, count: 2)
    let host = ServiceSessionModel(
        purpose: "session",
        makeClient: { scriptedClient(transport) },
        maxAttempts: 5,
        retryDelay: { _ in projectRetryDelay }
    )
    let session = SessionConsoleModel(host: host)
    try await host.start(projectRoot: root, resumeFile: nil)
    // Une trame poussée avant l'ouverture du flux serait perdue.
    try #require(await awaitTrue(timeout: 5.0) { transport.streamOpenCount >= 1 })
    emitServiceDialog(transport, id: dialogId, method: method, title: title, options: options, at: at)
    try #require(await awaitMainTrue(timeout: 5.0) { host.dialogQueue.first?.id == dialogId })
    return (session, transport, root)
}

/// Le modèle d'audit du Mac, son service scripté acceptant les réponses d'escalade.
@MainActor
private func auditModel(_ transport: ScriptedServiceTransport) -> AuditConsoleModel {
    transport.stubJSON("POST", "/v1/audits/\(auditId)/escalations", ["accepted": true])
    return AuditConsoleModel(
        stateDir: "/tmp/omp-audit-absent",
        snapshots: { AsyncStream { $0.finish() } },
        makeClient: { scriptedClient(transport) },
        defaults: UserDefaults(suiteName: "siri-mac-\(UUID().uuidString)")!
    )
}

/// La pile du Mac sur le magasin de `world`, ses gestes écrits par un écrivain de
/// pipeline local.
@MainActor
private func makeStack(
    _ world: VoiceStore,
    commands: PostedCommands = PostedCommands(),
    fileOps: PipelineFileOps = .live,
    project: ProjectConsoleModel? = nil,
    session: SessionConsoleModel? = nil,
    audit: AuditConsoleModel? = nil
) async throws -> RemoteStack {
    let actions = ActionsModel(
        writer: PipelineWriter(
            stateDir: world.store.root,
            fileOps: fileOps,
            post: { _, body in commands.post(body) },
            pilot: { _ in }
        ),
        clock: .live
    )
    return try await RemoteStack.make(
        stateDir: world.store.root,
        projectModel: project,
        actionsModel: actions,
        sessionModel: session,
        auditModel: audit
    )
}

/// Le contexte vocal du Mac sur les modèles mêmes de la pile.
@MainActor
private func voiceContext(
    _ stack: RemoteStack,
    startModels: (@MainActor () -> Void)? = nil,
    readinessTimeout: Duration = MacVoiceContext.readinessTimeout
) -> MacVoiceContext {
    let kanban = stack.kanban
    return MacVoiceContext(
        storeHub: stack.storeHub,
        kanban: kanban,
        project: stack.project,
        session: stack.session,
        remoteActions: stack.remoteActions,
        startModels: startModels ?? { kanban.start() },
        projectRoot: { nil },
        readinessTimeout: readinessTimeout
    )
}

/// La conversation des attentes du Mac sur `context`.
@MainActor
private func walk(_ context: MacVoiceContext, _ script: SpokenScript, announcing: Bool = true) async throws -> String {
    try await MacSiriPending.walk(context: context, conversation: script, announcing: announcing)
}

@MainActor
private func pending(_ stack: RemoteStack) -> [PendingRequest] {
    LocalPendingRequests.list(storeHub: stack.storeHub, project: stack.project, session: stack.session)
}

/// Attend que le magasin ET l'ardoise aient publié `count` demandes.
@MainActor
private func awaitPending(_ stack: RemoteStack, count: Int) async throws {
    stack.kanban.start()
    try #require(await awaitMainTrue(timeout: 5.0) {
        stack.kanban.state != .loading && pending(stack).count == count
    }, "la pile doit lister \(count) demandes")
}

/// Les fichiers déposés dans une boîte de run.
private func deliveries(_ inbox: String?) throws -> [String] {
    guard let inbox else { return [] }
    return try FileManager.default.contentsOfDirectory(atPath: inbox).map { name in
        try String(contentsOfFile: inbox + "/" + name, encoding: .utf8)
    }
}

/// Ce que Siri dit d'une traite : les phrases non vides, séparées d'une espace.
private func spoken(_ parts: String...) -> String {
    parts.filter { !$0.isEmpty }.joined(separator: " ")
}

private func item(_ request: PendingRequest) -> String {
    VoicePendingSummary.item(request)
}

/// Les choix d'une question, suivis de l'offre « autre réponse » si elle l'accepte.
private func choices(_ labels: [String], freeText: Bool) -> String {
    spoken(VoiceSpeechText.choices(labels), freeText ? VoiceSpeechText.otherAnswerOffer : "")
}

private func sent(_ gesture: VoiceGesture, _ request: PendingRequest) -> String {
    VoiceIssue.sent(gesture, target: request.subject ?? "").phrase
}

/// Une sonde dont le littéral diverge de la table : rien ne doit être lu ni dit.
private struct LockedProbeIntent: AppIntent {
    static let title: LocalizedStringResource = "Sonde verrouillée"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    func perform() async throws -> some IntentResult { .result() }
}

extension LockedProbeIntent: VoiceConversation {
    func ask(_ dialog: String) async throws -> String {
        Issue.record("question inattendue : \(dialog)")
        throw CancellationError()
    }

    func confirm(_ dialog: String) async throws {
        Issue.record("confirmation inattendue : \(dialog)")
        throw CancellationError()
    }
}

private let answerGestures: [VoiceGesture] = [
    .answerOption, .answerText, .answerProjectDialog, .answerHostedDialog, .answerAuditEscalation,
]

// MARK: - Preuves

@Suite("Siri sur le Mac")
@MainActor
struct MacVoiceIntentTests {
    @Test("siri-mac-questions-en-attente/AC-2 : la phrase annonce N puis lit la plus ancienne et ses options dans l’ordre")
    func announcesCountThenOldest() async throws {
        let world = try VoiceStore()
        try world.textQuestion("f-texte", at: Ages.text, prompt: "Quelle suite pour la migration ?")
        try world.ask("f-ask", at: Ages.ask, toolCallId: "call-1", question: "Que faire du cache ?", options: ["Le garder", "Le vider", "Le compresser"])
        world.publishLot()
        let stack = try await makeStack(world)
        defer { stack.stop() }
        try await awaitPending(stack, count: 2)
        let list = pending(stack)
        let oldest = try #require(list.first)
        #expect(oldest.at < list[1].at)
        #expect(oldest.nature == .question)

        let script = SpokenScript(["annuler"])
        _ = try? await walk(voiceContext(stack), script)

        #expect(script.prompts.first == spoken(
            VoiceSpeechText.walkCount(2),
            VoiceSpeechText.walkFirst(item(oldest)),
            choices(["Le garder", "Le vider", "Le compresser"], freeText: true)
        ))
    }

    @Test("siri-mac-questions-en-attente/AC-3 : sans demande, Siri dit que rien n’attend et n’appelle aucun geste")
    func nothingPending() async throws {
        let world = try VoiceStore()
        world.publishLot()
        let stack = try await makeStack(world)
        defer { stack.stop() }
        try await awaitPending(stack, count: 0)

        let script = SpokenScript([])
        let phrase = try await walk(voiceContext(stack), script)

        #expect(phrase == VoiceSpeechText.noPending)
        #expect(script.prompts.isEmpty && script.confirms.isEmpty)
        #expect(stack.actions.journal.isEmpty)
        #expect(stack.project.host.dialogQueue.isEmpty && stack.session.host.dialogQueue.isEmpty)
    }

    @Test("siri-mac-questions-en-attente/AC-4 : une option désignée par libellé ou par rang part par le geste typé de chacune des cinq sources")
    func answersEachOfTheFiveSources() async throws {
        let world = try VoiceStore()
        try world.ask("f-ask", at: Ages.ask, toolCallId: "call-1", question: "Que faire du cache ?", options: ["Le garder", "Le vider"])
        try world.textQuestion("f-texte", at: Ages.text, prompt: "Quelle suite pour la migration ?")
        world.auditEscalation("f-audit", at: Ages.audit, question: "Faut-il journaliser ?", options: ["Oui", "Non"])
        world.publishLot()
        let commands = PostedCommands()
        let (project, conduiteTransport, conduiteRepo) = try await conduite(
            dialogId: "d-conduite", method: "select", title: "Le plan", options: ["Valider le plan", "Corriger le plan"], at: Ages.conduite)
        let (hosted, sessionTransport, sessionRoot) = try await hostedSession(
            dialogId: "d-session", method: "select", title: "La suite", options: ["Garder", "Jeter"], at: Ages.session)
        let auditTransport = ScriptedServiceTransport()
        let stack = try await makeStack(world, commands: commands, project: project, session: hosted, audit: auditModel(auditTransport))
        defer {
            stack.stop()
            project.stop()
            try? FileManager.default.removeItem(at: conduiteRepo)
            try? FileManager.default.removeItem(at: sessionRoot)
        }
        try await awaitPending(stack, count: 5)
        let list = pending(stack)
        #expect(list.map(\.nature) == [.question, .question, .conduiteDialog, .sessionDialog, .auditEscalation])

        let script = SpokenScript([
            "Le vider",                       // ask, par libellé
            "Reprends depuis le schéma",      // question en texte, dictée
            "la deuxième",                    // conduite, par rang
            "Garder",                         // session hébergée, par libellé
            "le dernier",                     // escalade d'audit, par rang
        ], confirmations: [true, true, true, true])
        let phrase = try await walk(voiceContext(stack), script)

        // La question en vol : la boîte du run reçoit l'option ET l'identifiant lu.
        let ask = try deliveries(world.inboxes["f-ask"])
        #expect(ask.count == 1)
        #expect(ask.first?.contains("\"kind\":\"ask\"") == true)
        #expect(ask.first?.contains("Le vider") == true)
        #expect(ask.first?.contains("call-1") == true)
        // La question en texte : une commande `reply` postée au service.
        await stack.actions.commandTask?.value
        #expect(commands.bodies.last?["kind"] as? String == "reply")
        #expect(commands.bodies.last?["text"] as? String == "Reprends depuis le schéma")
        // Les dialogues : la réponse part au service et quitte la file.
        #expect(await awaitMainTrue {
            conduiteTransport.requests.contains { $0.path.hasSuffix("/dialogs/d-conduite") && $0.body?["value"] as? String == "Corriger le plan" }
        })
        #expect(await awaitMainTrue {
            sessionTransport.requests.contains { $0.path.hasSuffix("/dialogs/d-session") && $0.body?["value"] as? String == "Garder" }
        })
        #expect(await awaitMainTrue {
            !pending(stack).contains { $0.nature == .conduiteDialog || $0.nature == .sessionDialog }
        }, "les dialogues répondus quittent la liste des attentes")
        // L'escalade : la réponse part au service de l'audit.
        #expect(auditTransport.requests.contains {
            $0.method == "POST" && $0.path.hasSuffix("/v1/audits/\(auditId)/escalations")
                && $0.body?["answer"] as? String == "Non" && $0.body?["key"] as? String == "ask:f-audit:call-9"
        })
        // Chaque demande répondue n'est plus proposée : chaque question suivante
        // présente la suivante, la dernière phrase dit que rien n'attend plus.
        #expect(script.prompts.count == 5)
        #expect(script.confirms.count == 4)
        for (index, prompt) in script.prompts.dropFirst().enumerated() {
            #expect(prompt.hasPrefix(VoiceSpeechText.walkNext(item(list[index + 1]))))
        }
        #expect(phrase == spoken(sent(.answerAuditEscalation, list[4]), VoiceSpeechText.noPending))
    }

    @Test("siri-mac-questions-en-attente/AC-5 : « autre réponse » envoie le texte dicté ; hors options sans texte libre, rien ne part et les options sont relues")
    func otherAnswerAndUnknownOption() async throws {
        // Question en vol à texte libre : « autre réponse » puis le texte dicté.
        let world = try VoiceStore()
        try world.ask("f-ask", at: Ages.ask, toolCallId: "call-1", question: "Que faire du cache ?", options: ["Le garder", "Le vider"])
        world.publishLot()
        let stack = try await makeStack(world)
        defer { stack.stop() }
        try await awaitPending(stack, count: 1)

        let free = SpokenScript(["autre réponse", "Garde-le encore une semaine"])
        _ = try await walk(voiceContext(stack), free, announcing: false)
        #expect(free.prompts.last == VoiceSpeechText.dictate)
        let ask = try deliveries(world.inboxes["f-ask"])
        #expect(ask.count == 1)
        #expect(ask.first?.contains("Garde-le encore une semaine") == true)

        // Dialogue `select` sans texte libre : un énoncé hors options n'envoie rien.
        let empty = try VoiceStore()
        empty.publishLot()
        let (hosted, transport, root) = try await hostedSession(
            dialogId: "d-select", method: "select", title: "La suite", options: ["Garder", "Jeter"], at: Ages.session)
        let dialogStack = try await makeStack(empty, session: hosted)
        defer {
            dialogStack.stop()
            try? FileManager.default.removeItem(at: root)
        }
        try await awaitPending(dialogStack, count: 1)

        let strict = SpokenScript(["peut-être plus tard", "annuler"])
        let context = voiceContext(dialogStack)
        await #expect(throws: CancellationError.self) { try await walk(context, strict, announcing: false) }
        #expect(strict.prompts.count == 2)
        #expect(!strict.prompts.contains { $0.contains(VoiceSpeechText.otherAnswerOffer) })
        #expect(strict.prompts.last == VoiceSpeechText.optionNotFound(labels: ["Garder", "Jeter"]))
        #expect(!transport.requests.contains { $0.path.hasSuffix("/dialogs/d-select") })
        #expect(hosted.host.dialogQueue.first?.id == "d-select")
    }

    @Test("siri-mac-questions-en-attente/AC-6 : après une réponse, Siri propose la suivante, puis dit qu’il n’en reste aucune")
    func proposesNextThenNoneLeft() async throws {
        let world = try VoiceStore()
        try world.ask("f-ask", at: Ages.ask, toolCallId: "call-1", question: "Que faire du cache ?", options: ["Le garder", "Le vider"])
        try world.textQuestion("f-texte", at: Ages.text, prompt: "Quelle suite pour la migration ?")
        world.publishLot()
        let commands = PostedCommands()
        let stack = try await makeStack(world, commands: commands)
        defer { stack.stop() }
        try await awaitPending(stack, count: 2)
        let list = pending(stack)

        let script = SpokenScript(["Le garder", "Continue"], confirmations: [true])
        let phrase = try await walk(voiceContext(stack), script)

        #expect(script.confirms == [spoken(sent(.answerOption, list[0]), VoiceSpeechText.nextPrompt)])
        #expect(script.prompts.count == 2)
        #expect(script.prompts.last == spoken(VoiceSpeechText.walkNext(item(list[1])), VoiceSpeechText.dictate))
        #expect(phrase == spoken(sent(.answerText, list[1]), VoiceSpeechText.noPending))
    }

    @Test("siri-mac-questions-en-attente/AC-7 : lancée sans fenêtre, l’app démarre ses modèles et lit la demande ; au-delà du délai, Siri dit la cause sans geste")
    func coldLaunchWaitsBoundedly() async throws {
        #expect(MacPendingIntent.supportedModes == .background)
        #expect(MacAnswerIntent.supportedModes == .background)

        let world = try VoiceStore()
        try world.ask("f-ask", at: Ages.ask, toolCallId: "call-1", question: "Que faire du cache ?", options: ["Le garder", "Le vider"])
        world.publishLot()
        let stack = try await makeStack(world)
        defer { stack.stop() }
        try #require(await awaitTrue(timeout: 5.0) { stack.storeHub.current().running.entries.count == 1 })

        // Délai dépassé : aucun modèle démarré, rien n'est lu ni envoyé.
        #expect(stack.kanban.state == .loading)
        let late = SpokenScript([])
        let unreadable = try await walk(voiceContext(stack, startModels: {}, readinessTimeout: .milliseconds(200)), late)
        #expect(unreadable == VoiceIssue.stateUnreadable.phrase)
        #expect(late.prompts.isEmpty && late.confirms.isEmpty)
        #expect(try deliveries(world.inboxes["f-ask"]).isEmpty)
        #expect(stack.actions.journal.isEmpty)

        // L'ardoise jamais démarrée : la lecture la démarre puis lit la demande.
        #expect(stack.kanban.state == .loading)
        let script = SpokenScript(["annuler"])
        _ = try? await walk(voiceContext(stack), script)
        let request = try #require(pending(stack).first)
        #expect(script.prompts.first == spoken(
            VoiceSpeechText.walkCount(1),
            VoiceSpeechText.walkFirst(item(request)),
            choices(["Le garder", "Le vider"], freeText: true)
        ))
    }

    @Test("siri-mac-questions-en-attente/AC-8 : un dialogue « editor » est compté, dit « à traiter dans l’app », sans réponse demandée, puis Siri passe à la question")
    func editorDialogIsAnnouncedThenSkipped() async throws {
        let world = try VoiceStore()
        try world.ask("f-ask", at: Ages.ask, toolCallId: "call-1", question: "Que faire du cache ?", options: ["Le garder", "Le vider"])
        world.publishLot()
        let (hosted, transport, root) = try await hostedSession(
            dialogId: "d-editor", method: "editor", title: "Corriger le plan", options: [], at: Ages.editor)
        let stack = try await makeStack(world, session: hosted)
        defer {
            stack.stop()
            try? FileManager.default.removeItem(at: root)
        }
        try await awaitPending(stack, count: 2)
        let list = pending(stack)
        #expect(list.first?.nature == .sessionDialog)

        let script = SpokenScript(["annuler"], confirmations: [true])
        let context = voiceContext(stack)
        await #expect(throws: CancellationError.self) { try await walk(context, script) }

        // L'editor : compté, présenté, « à traiter dans l'app », sans question posée.
        #expect(script.confirms == [spoken(
            VoiceSpeechText.walkCount(2),
            VoiceSpeechText.walkFirst(item(list[0])),
            VoiceSpeechText.appOnly,
            VoiceSpeechText.nextPrompt
        )])
        // Puis la question de run.
        #expect(script.prompts == [spoken(
            VoiceSpeechText.walkNext(item(list[1])),
            choices(["Le garder", "Le vider"], freeText: true)
        )])
        #expect(hosted.host.dialogQueue.first?.id == "d-editor")
        #expect(!transport.requests.contains { $0.path.hasSuffix("/dialogs/d-editor") })
    }

    @Test("siri-mac-questions-en-attente/AC-9 : une question changée avant l’envoi n’est jamais répondue : Siri relit la nouvelle, ou passe si la demande a disparu")
    func staleQuestionIsNeverAnswered() async throws {
        // La question est remplacée pendant que Siri écoute.
        let world = try VoiceStore()
        try world.ask("f-ask", at: Ages.ask, toolCallId: "call-1", question: "Que faire du cache ?", options: ["Le garder", "Le vider"])
        world.publishLot()
        let stack = try await makeStack(world)
        defer { stack.stop() }
        try await awaitPending(stack, count: 1)
        let cardId = try #require(pending(stack).first.flatMap { request -> String? in
            if case let .cardAnswer(cardId, _) = request.reply { return cardId }
            return nil
        })

        let replaced = SpokenScript(steps: [
            { @MainActor in
                world.replaceAsk("f-ask", toolCallId: "call-2", question: "Et les journaux ?", options: ["Les garder", "Les purger"])
                try #require(await awaitMainTrue(timeout: 5.0) {
                    pending(stack).first?.reply == .cardAnswer(cardId: cardId, toolCallId: "call-2")
                        && stack.kanban.state.card(cardId)?.action?.run?.pendingAsk?.toolCallId == "call-2"
                })
                return "Le garder"
            },
            { @MainActor in throw CancellationError() },
        ])
        _ = try? await walk(voiceContext(stack), replaced, announcing: false)
        let fresh = try #require(pending(stack).first)
        #expect(replaced.prompts.count == 2)
        #expect(replaced.prompts.last == spoken(
            VoiceIssue.staleQuestion.phrase,
            VoiceSpeechText.walkReplaced(item(fresh)),
            choices(["Les garder", "Les purger"], freeText: true)
        ))
        #expect(try deliveries(world.inboxes["f-ask"]).isEmpty)

        // La demande disparaît pendant que Siri écoute.
        let removed = SpokenScript(steps: [
            { @MainActor in
                world.replaceAsk("f-ask", toolCallId: nil)
                try #require(await awaitMainTrue(timeout: 5.0) {
                    pending(stack).isEmpty && stack.kanban.state.card(cardId)?.action?.run?.pendingAsk == nil
                })
                return "Les garder"
            },
        ])
        let phrase = try await walk(voiceContext(stack), removed, announcing: false)
        #expect(phrase == spoken(VoiceIssue.staleQuestion.phrase, VoiceSpeechText.noPending))
        #expect(try deliveries(world.inboxes["f-ask"]).isEmpty)
    }

    @Test("siri-mac-questions-en-attente/AC-10 : un geste refusé par le Mac fait dire le motif de la route HTTP, et la demande reste en attente")
    func macRefusalSaysTheRouteMotive() async throws {
        let world = try VoiceStore()
        try world.ask("f-ask", at: Ages.ask, toolCallId: "call-1", question: "Que faire du cache ?", options: ["Le garder", "Le vider"])
        world.publishLot()
        let failure = WriteFailure()
        let stack = try await makeStack(world, fileOps: failingFileOps(failure))
        defer { stack.stop() }
        try await awaitPending(stack, count: 1)
        let request = try #require(pending(stack).first)
        guard case let .cardAnswer(cardId, toolCallId) = request.reply else {
            Issue.record("question en vol attendue : \(request.reply)")
            return
        }
        failure.failing = true

        let token = try await stack.pair()
        let route = try await stack.call(
            "POST", "/v1/cards/\(cardId)/answer",
            token: token,
            json: ["toolCallId": toolCallId, "kind": "selected", "label": "Le garder"]
        )
        #expect(route.status == 409)
        let motive = try #require(route.errorMessage)

        let script = SpokenScript(["Le garder"])
        let phrase = try await walk(voiceContext(stack), script, announcing: false)

        #expect(phrase == spoken(VoiceIssue.macRefused(motive: motive).phrase, VoiceSpeechText.noPending))
        #expect(pending(stack).contains { $0.id == request.id })
        #expect(try deliveries(world.inboxes["f-ask"]).isEmpty)
    }

    @Test("siri-mac-questions-en-attente/AC-11 : l’annulation n’appelle aucun geste et laisse la demande en attente")
    func cancellationSendsNothing() async throws {
        let world = try VoiceStore()
        try world.ask("f-ask", at: Ages.ask, toolCallId: "call-1", question: "Que faire du cache ?", options: ["Le garder", "Le vider"])
        world.publishLot()
        let stack = try await makeStack(world)
        defer { stack.stop() }
        try await awaitPending(stack, count: 1)
        let request = try #require(pending(stack).first)

        let script = SpokenScript(["annuler"])
        let context = voiceContext(stack)
        await #expect(throws: CancellationError.self) { try await walk(context, script) }

        #expect(script.prompts.count == 1)
        #expect(try deliveries(world.inboxes["f-ask"]).isEmpty)
        #expect(stack.actions.journal.isEmpty)
        #expect(pending(stack).contains { $0.id == request.id })
    }

    @Test("siri-mac-questions-en-attente/AC-12 : le littéral authenticationPolicy et la confirmation de chaque intent vocal du Mac suivent la table")
    func intentsFollowThePolicyTable() async throws {
        // Les littéraux des deux intents, confrontés à la table pour chaque geste émis.
        #expect(MacSiriPending.gestures == answerGestures)
        for policy in [MacPendingIntent.authenticationPolicy, MacAnswerIntent.authenticationPolicy] {
            #expect(VoiceGesturePolicy.admits(policy, for: MacSiriPending.gestures, on: .mac))
            for gesture in MacSiriPending.gestures {
                #expect(policy == VoiceGesturePolicy.authenticationPolicy(for: gesture, on: .mac))
                #expect(!VoiceGesturePolicy.rule(for: gesture, on: .mac).needsConfirmation,
                        "aucune réponse vocale ne demande de confirmation sur le Mac")
            }
        }

        // Un jalon de carte (geste à confirmation hors des gestes du Mac) n'est
        // jamais proposé à la voix : il reste à traiter dans l'app.
        let verdict = PendingRequest(
            id: "v", nature: .milestoneSpecs, at: 0, subject: "f-specs", question: "Valider les specs ?", detail: nil,
            options: [], paused: false, reply: .cardVerdict(cardId: "c", milestone: .specs)
        )
        #expect(VoicePendingWalk.mode(of: verdict, on: .mac) == .approve)
        #expect(VoicePendingWalk.mode(of: verdict, on: .mac, admitting: MacSiriPending.gestures) == .appOnly)

        // Une réponse réelle part sans aucune confirmation.
        let world = try VoiceStore()
        try world.ask("f-ask", at: Ages.ask, toolCallId: "call-1", question: "Que faire du cache ?", options: ["Le garder", "Le vider"])
        world.publishLot()
        let stack = try await makeStack(world)
        defer { stack.stop() }
        try await awaitPending(stack, count: 1)
        let script = SpokenScript(["Le garder"])
        _ = try await walk(voiceContext(stack), script)
        #expect(script.confirms.isEmpty)
        #expect(try deliveries(world.inboxes["f-ask"]).count == 1)

        // Un littéral qui diverge de la table : rien n'est lu, demandé ni envoyé.
        let locked = try await MacSiriPending.answer(LockedProbeIntent(), context: voiceContext(stack), announcing: true)
        #expect(locked == VoiceGestureText.misconfigured)
        #expect(try deliveries(world.inboxes["f-ask"]).count == 1)
    }
}
