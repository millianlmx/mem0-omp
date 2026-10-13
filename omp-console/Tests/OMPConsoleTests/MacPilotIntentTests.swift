// Preuves tracées du pilotage des pipelines par Siri sur le Mac
// (siri-mac-pilotage-pipelines, S-5 à S-7) : une session `MacPilotSession` sur une
// pile RÉELLE (`RemoteStack`), avec les gestes typés de `RemoteActions` que sert
// aussi l'API distante. Les dictées et la confirmation sont scriptées ; l'effet de
// chaque geste (commande postée au service, pilote sollicité, entrée de journal)
// est comparé à celui du bouton de la fenêtre, appelé sur une pile JUMELLE qui lit
// le même magasin. Le contexte est passé directement : un test ne lit jamais
// `intent.voice` (`AppDependency` hors du déroulé d'un intent est fatal).

import AppIntents
import ConsoleCore
import Darwin
import Foundation
import Testing
@testable import OMPConsole

// MARK: - Doublures

/// Le service des pipelines : les commandes POSTÉES, les dépôts pilotés, et
/// l'accusé que rend chaque POST (prise en charge, refus motivé, ou POST qui lève).
private final class PilotService: @unchecked Sendable {
    enum Reply: Sendable {
        case taken
        case refused(String)
        case failing(String)
    }

    private let lock = NSLock()
    private var storedPosts: [(repo: String, body: [String: Any])] = []
    private var storedPilots: [String] = []
    private var storedReply: Reply = .taken

    var posts: [(repo: String, body: [String: Any])] { lock.withLock { storedPosts } }
    var pilots: [String] { lock.withLock { storedPilots } }

    var reply: Reply {
        get { lock.withLock { storedReply } }
        set { lock.withLock { storedReply = newValue } }
    }

    func post(_ repo: String, _ body: [String: Any]) throws -> ServiceCommandAck {
        lock.lock()
        defer { lock.unlock() }
        storedPosts.append((repo, body))
        switch storedReply {
        case .taken:
            return ServiceCommandAck(id: "x", repo: "", kind: nil, state: .taken, reason: nil, at: 0)
        case let .refused(reason):
            return ServiceCommandAck(id: "x", repo: "", kind: nil, state: .refused, reason: reason, at: 0)
        case let .failing(reason):
            throw PipelineWriteFailure(reason: reason)
        }
    }

    func pilot(_ repo: String) {
        lock.withLock { storedPilots.append(repo) }
    }
}

/// Les dictées de Siri, scriptées : chaque question rend l'énoncé suivant (ou
/// lève quand il n'y en a plus) ; les questions posées sont notées.
@MainActor
private final class Dictation {
    private(set) var prompts: [String] = []
    private(set) var fields: [VoiceLaunchField] = []
    private var answers: [String]

    init(_ answers: [String] = []) {
        self.answers = answers
    }

    func ask(_ prompt: String) async throws -> String {
        prompts.append(prompt)
        guard !answers.isEmpty else {
            Issue.record("question inattendue : \(prompt)")
            throw CancellationError()
        }
        return answers.removeFirst()
    }

    func ask(_ field: VoiceLaunchField, _ prompt: String) async throws -> String {
        fields.append(field)
        return try await ask(prompt)
    }
}

/// L'enregistreur de la confirmation Siri : il note chaque question, puis accepte
/// ou lève (refus).
@MainActor
private final class Confirmations {
    private(set) var prompts: [String] = []
    private let accepts: Bool

    init(accepts: Bool) {
        self.accepts = accepts
    }

    func confirm(_ prompt: String) async throws {
        prompts.append(prompt)
        if !accepts { throw CancellationError() }
    }
}

/// La politique RÉELLE de la table pour le Mac, la confirmation scriptée.
@MainActor
private func tablePolicy(_ gesture: VoiceGesture, _ confirmations: Confirmations) -> MacPilotSession.Policy {
    { target, prompt, send in
        try await VoiceGesturePolicy.apply(
            gesture,
            target: target,
            prompt: prompt,
            on: .mac,
            confirm: { try await confirmations.confirm($0) },
            send: send
        )
    }
}

/// Le magasin de deux dépôts git : `depot-a`, son lot vivant, porte deux features
/// au nom voisin en cours, une au jalon specs, une au jalon revue et une en échec ;
/// `depot-b`, son pilote mort, porte une feature en pause. `milestones: false`
/// retire les deux jalons.
@MainActor
private final class PilotWorld {
    let store = StoreFixture()
    let repoA: String
    let repoB: String
    let slugs: [String]

    init(milestones: Bool = true) throws {
        repoA = store.root + "/depot-a"
        repoB = store.root + "/depot-b"
        for repo in [repoA, repoB] {
            try FileManager.default.createDirectory(atPath: repo + "/.git", withIntermediateDirectories: true)
        }
        var featuresA = [
            lotFeatureObject(slug: "audit-ui", state: "running", worktree: repoA + "/audit-ui"),
            lotFeatureObject(slug: "audit-ui-redesign", state: "running", worktree: repoA + "/audit-ui-redesign"),
            lotFeatureObject(slug: "import-echoue", state: "failed", worktree: repoA + "/import-echoue"),
        ]
        if milestones {
            featuresA.append(lotFeatureObject(slug: "export-csv", state: "waiting", phase: "specs", worktree: repoA + "/export-csv", waitKind: "specs"))
            featuresA.append(lotFeatureObject(slug: "revue-paiement", state: "waiting", phase: "review", worktree: repoA + "/revue-paiement", waitKind: "review"))
        }
        let featuresB = [lotFeatureObject(slug: "pause-longue", state: "running", worktree: repoB + "/pause-longue")]
        slugs = (featuresA + featuresB).compactMap { $0["slug"] as? String }
        store.publish(.lots, "\(fixtureId(0xC1)).json", object: lotObject(id: fixtureId(0xC1), repoRoot: repoA, features: featuresA))
        store.publish(.lots, "\(fixtureId(0xC2)).json", object: lotObject(
            id: fixtureId(0xC2),
            repoRoot: repoB,
            features: featuresB,
            ownerPid: Double(deadPid())
        ))
    }
}

/// Une pile du Mac sur le magasin de `world`, son service et son contexte vocal.
@MainActor
private struct Pile {
    let stack: RemoteStack
    let service: PilotService
    let context: MacVoiceContext

    var actions: ActionsModel { stack.actions }
    var cards: [KanbanCard] { stack.kanban.state.kanbanBoard?.cards ?? [] }

    func card(_ slug: String) throws -> KanbanCard {
        try #require(cards.first { $0.id.hasPrefix("feature:") && $0.title == slug }, "carte \(slug) absente")
    }

    func action(_ slug: String) throws -> KanbanCardAction {
        try #require(try card(slug).action, "carte \(slug) sans geste")
    }

    func session(_ policy: @escaping MacPilotSession.Policy) -> MacPilotSession {
        MacPilotSession(context: context, policy: policy)
    }

    /// La fin du POST (ou de la sollicitation du pilote) du dernier geste.
    func settle() async {
        await actions.commandTask?.value
    }
}

@MainActor
private func makePile(_ world: PilotWorld) async throws -> Pile {
    let service = PilotService()
    let actions = ActionsModel(
        writer: PipelineWriter(
            stateDir: world.store.root,
            post: { repo, body in try service.post(repo, body) },
            pilot: { repo in service.pilot(repo) }
        ),
        clock: .live
    )
    let stack = try await RemoteStack.make(stateDir: world.store.root, actionsModel: actions)
    let kanban = stack.kanban
    kanban.start()
    let ready = await awaitMainTrue(timeout: 5.0) {
        let titles = Set((kanban.state.kanbanBoard?.cards ?? []).map(\.title))
        return world.slugs.allSatisfy(titles.contains)
    }
    try #require(ready, "l'ardoise doit publier les features du magasin")
    let context = MacVoiceContext(
        storeHub: stack.storeHub,
        kanban: kanban,
        project: stack.project,
        session: stack.session,
        remoteActions: stack.remoteActions,
        startModels: { kanban.start() },
        projectRoot: { nil }
    )
    return Pile(stack: stack, service: service, context: context)
}

/// Le corps d'une commande sans ce qui change à chaque émission (`id`, `sentAt`).
private func stable(_ body: [String: Any]) -> NSDictionary {
    var body = body
    body.removeValue(forKey: "id")
    body.removeValue(forKey: "sentAt")
    return NSDictionary(dictionary: body)
}

/// Une entrée de journal sans son identifiant ni son instant.
private struct EntryShape: Equatable {
    let kind: String
    let target: String
    let state: ActionJournalState

    init(_ entry: ActionJournalEntry) {
        kind = entry.kindLabel
        target = entry.targetLabel
        state = entry.state
    }
}

@MainActor
private func head(_ pile: Pile) throws -> EntryShape {
    EntryShape(try #require(pile.actions.journal.first, "aucune entrée de journal"))
}

/// La dernière commande postée, sans `id` ni `sentAt`.
private func lastPost(_ pile: Pile) throws -> NSDictionary {
    stable(try #require(pile.service.posts.last, "aucune commande postée").body)
}

/// Une sonde dont le littéral diverge de la table : l'arrêt exige le déverrouillage.
private struct DivergentStopProbe: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Sonde d’arrêt divergente"
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    static let voiceGesture: VoiceGesture = .stopFeature

    func perform() async throws -> some IntentResult { .result() }
}

/// Un intent de pilotage, son geste attendu (écrit à la main) et la façon de le
/// jouer dans une session.
private struct PilotIntentCase: @unchecked Sendable {
    let name: String
    let expected: VoiceGesture
    let gesture: VoiceGesture
    let authenticationPolicy: IntentAuthenticationPolicy
    let play: @MainActor (MacPilotSession, Dictation) async -> String
}

private let pilotIntentCases: [PilotIntentCase] = [
    PilotIntentCase(
        name: "MacLaunchPipelineIntent",
        expected: .launchPipeline,
        gesture: MacLaunchPipelineIntent.voiceGesture,
        authenticationPolicy: MacLaunchPipelineIntent.authenticationPolicy,
        play: { session, dictation in
            await session.launch(repo: "depot-a", title: "export pdf", need: "exporter en pdf", ask: { try await dictation.ask($0, $1) })
        }
    ),
    PilotIntentCase(
        name: "MacResumeFeatureIntent",
        expected: .resume,
        gesture: MacResumeFeatureIntent.voiceGesture,
        authenticationPolicy: MacResumeFeatureIntent.authenticationPolicy,
        play: { session, dictation in
            await session.pilot(.resume, spoken: "pause longue", ask: { try await dictation.ask($0) })
        }
    ),
    PilotIntentCase(
        name: "MacStopFeatureIntent",
        expected: .stopFeature,
        gesture: MacStopFeatureIntent.voiceGesture,
        authenticationPolicy: MacStopFeatureIntent.authenticationPolicy,
        play: { session, dictation in
            await session.pilot(.stop, spoken: "audit ui redesign", ask: { try await dictation.ask($0) })
        }
    ),
    PilotIntentCase(
        name: "MacValidateSpecsIntent",
        expected: .validateSpecs,
        gesture: MacValidateSpecsIntent.voiceGesture,
        authenticationPolicy: MacValidateSpecsIntent.authenticationPolicy,
        play: { session, dictation in
            await session.pilot(.validateSpecs, spoken: "export csv", ask: { try await dictation.ask($0) })
        }
    ),
    PilotIntentCase(
        name: "MacAcceptReviewIntent",
        expected: .acceptReview,
        gesture: MacAcceptReviewIntent.voiceGesture,
        authenticationPolicy: MacAcceptReviewIntent.authenticationPolicy,
        play: { session, dictation in
            await session.pilot(.acceptReview, spoken: "revue paiement", ask: { try await dictation.ask($0) })
        }
    ),
]

// MARK: - Preuves

@Suite("Siri pilote le Mac")
@MainActor
struct MacPilotIntentTests {
    @Test("siri-mac-pilotage-pipelines/AC-1 : un lancement dicté crée la feature comme la feuille « Nouvelle feature », même commande et même entrée de journal")
    func launchMatchesNewFeatureSheet() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        let twin = try await makePile(world)
        defer { voice.stack.stop(); twin.stack.stop() }

        let choices = try #require(await voice.context.launchRepos())
        #expect(choices.map(\.label) == ["depot-a", "depot-b"], "les deux dépôts connus de l'ardoise")
        let chosen = try #require(choices.first { $0.label == "depot-a" })

        let dictation = Dictation([chosen.label, "export csv", "exporter les stats"])
        let confirmations = Confirmations(accepts: true)
        let phrase = await voice.session(tablePolicy(.launchPipeline, confirmations))
            .launch(repo: nil, title: nil, need: nil, ask: { try await dictation.ask($0, $1) })

        #expect(dictation.fields == [.repo, .title, .need])
        #expect(phrase == "La pipeline export csv est lancée.")
        #expect(voice.service.posts.count == 1)

        // Le bouton « Lancer » de la feuille : l'appel exact de `NewFeatureSheet.submit`.
        twin.actions.launch(
            title: "export csv",
            description: "exporter les stats",
            repoRoot: chosen.root,
            modelReqSpecs: nil,
            modelImplReview: nil
        )
        await twin.settle()
        #expect(try lastPost(voice) == lastPost(twin))
        #expect(try lastPost(voice)["kind"] as? String == "launch")
        #expect(try lastPost(voice)["repo"] as? String == realpathOr(world.repoA))
        #expect(try head(voice) == head(twin))
        #expect(try head(voice) == EntryShape(ActionJournalEntry(
            id: "", kindLabel: ActionsText.launchLabel, targetLabel: "export csv", state: .taken, at: 0
        )))
    }

    @Test("siri-mac-pilotage-pipelines/AC-2 : la confirmation du lancement relit le dépôt, le titre et le besoin dictés")
    func launchConfirmationReadsBackDictation() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }

        let confirmations = Confirmations(accepts: true)
        let dictation = Dictation(["depot-b", "  export csv ", "exporter les stats\n"])
        _ = await voice.session(tablePolicy(.launchPipeline, confirmations))
            .launch(repo: nil, title: nil, need: nil, ask: { try await dictation.ask($0, $1) })

        #expect(confirmations.prompts == [
            VoiceGestureText.launchConfirmation(title: "export csv", repo: "depot-b", need: "exporter les stats"),
        ])
        #expect(confirmations.prompts.first == "Lancer export csv sur depot-b\u{00A0}? Besoin\u{00A0}: exporter les stats")
    }

    @Test("siri-mac-pilotage-pipelines/AC-3 : une confirmation refusée annule lancer, arrêter, valider et accepter sans rien écrire")
    func refusedConfirmationWritesNothing() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }
        let before = voice.cards

        let plays: [(VoiceGesture, @MainActor (MacPilotSession) async -> String)] = [
            (.launchPipeline, { session in
                await session.launch(repo: "depot-a", title: "export pdf", need: "exporter en pdf", ask: { _, _ in throw CancellationError() })
            }),
            (.stopFeature, { session in
                await session.pilot(.stop, spoken: "audit ui redesign", ask: { _ in throw CancellationError() })
            }),
            (.validateSpecs, { session in
                await session.pilot(.validateSpecs, spoken: "export csv", ask: { _ in throw CancellationError() })
            }),
            (.acceptReview, { session in
                await session.pilot(.acceptReview, spoken: "revue paiement", ask: { _ in throw CancellationError() })
            }),
        ]
        for (gesture, play) in plays {
            let confirmations = Confirmations(accepts: false)
            let phrase = await play(voice.session(tablePolicy(gesture, confirmations)))
            #expect(confirmations.prompts.count == 1, "\(gesture) : la confirmation est demandée")
            #expect(phrase == VoiceGestureText.cancelled, "\(gesture)")
        }
        #expect(voice.actions.journal.isEmpty)
        #expect(voice.service.posts.isEmpty)
        #expect(voice.service.pilots.isEmpty)
        #expect(voice.cards == before)
    }

    @Test("siri-mac-pilotage-pipelines/AC-4 : un titre ou un besoin dicté vide arrête le lancement, aucune feature créée")
    func emptyTitleOrNeedCreatesNothing() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }

        let blankTitle = Dictation(["depot-a", "   "])
        let confirmations = Confirmations(accepts: true)
        let titlePhrase = await voice.session(tablePolicy(.launchPipeline, confirmations))
            .launch(repo: nil, title: nil, need: nil, ask: { try await blankTitle.ask($0, $1) })
        #expect(titlePhrase == VoiceSpeechText.launchEmptyTitle)
        #expect(blankTitle.fields == [.repo, .title], "le besoin n'est pas demandé")

        let blankNeed = Dictation(["depot-a", "export csv", ""])
        let needPhrase = await voice.session(tablePolicy(.launchPipeline, confirmations))
            .launch(repo: nil, title: nil, need: nil, ask: { try await blankNeed.ask($0, $1) })
        #expect(needPhrase == VoiceSpeechText.launchEmptyNeed)

        #expect(confirmations.prompts.isEmpty)
        #expect(voice.service.posts.isEmpty)
        #expect(voice.actions.journal.isEmpty)
    }

    @Test("siri-mac-pilotage-pipelines/AC-5 : reprendre une feature en pause ou relançable, sans confirmation, comme le bouton « Reprendre »")
    func resumeMatchesResumeButton() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        let twin = try await makePile(world)
        defer { voice.stack.stop(); twin.stack.stop() }
        #expect(KanbanActionPresentation.resumable(try voice.card("pause-longue")), "la feature doit être en pause")
        #expect(KanbanActionPresentation.relaunchable(try voice.card("import-echoue")), "la feature doit être relançable")

        // En pause : le pilote du dépôt est sollicité.
        let confirmations = Confirmations(accepts: true)
        let paused = await voice.session(tablePolicy(.resume, confirmations))
            .pilot(.resume, spoken: "pause longue", ask: { _ in throw CancellationError() })
        twin.actions.resume(try twin.action("pause-longue"))
        await twin.settle()
        #expect(paused == "La pipeline pause-longue est reprise.")
        #expect(voice.service.pilots == twin.service.pilots)
        #expect(voice.service.pilots == [realpathOr(world.repoB)])
        #expect(try head(voice) == head(twin))
        #expect(try head(voice).kind == ActionsText.resumeLabel)

        // Relançable : la commande `relaunch`.
        let relaunched = await voice.session(tablePolicy(.resume, confirmations))
            .pilot(.resume, spoken: "import echoue", ask: { _ in throw CancellationError() })
        twin.actions.relaunch(try twin.action("import-echoue"))
        await twin.settle()
        #expect(relaunched == "La pipeline import-echoue est reprise.")
        #expect(try lastPost(voice) == lastPost(twin))
        #expect(try lastPost(voice)["kind"] as? String == "relaunch")
        #expect(try head(voice) == head(twin))

        #expect(confirmations.prompts.isEmpty, "reprendre ne demande aucune confirmation")
    }

    @Test("siri-mac-pilotage-pipelines/AC-6 : une feature que la fenêtre ne propose pas de reprendre n'est ni proposée ni reprise")
    func notResumableIsRefused() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }
        let card = try voice.card("audit-ui-redesign")
        #expect(!KanbanActionPresentation.resumable(card) && !KanbanActionPresentation.relaunchable(card))

        #expect(!MacPilotSession.featureTitles(.resume, in: voice.cards).contains("audit-ui-redesign"))
        let phrase = await voice.session(tablePolicy(.resume, Confirmations(accepts: true)))
            .pilot(.resume, spoken: "audit ui redesign", ask: { _ in throw CancellationError() })
        #expect(phrase == VoiceSpeechText.pilotNotOffered(.resume))
        #expect(voice.actions.journal.isEmpty)
        #expect(voice.service.posts.isEmpty)
        #expect(voice.service.pilots.isEmpty)
    }

    @Test("siri-mac-pilotage-pipelines/AC-7 : arrêter une feature arrête son dépôt comme le bouton « Arrêter » de la carte, après sa confirmation")
    func stopMatchesStopButton() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        let twin = try await makePile(world)
        defer { voice.stack.stop(); twin.stack.stop() }
        let card = try voice.card("audit-ui-redesign")
        #expect(card.repo == "depot-a")

        let confirmations = Confirmations(accepts: true)
        let phrase = await voice.session(tablePolicy(.stopFeature, confirmations))
            .pilot(.stop, spoken: "audit ui redesign", ask: { _ in throw CancellationError() })

        #expect(confirmations.prompts == [VoiceGestureText.stopConfirmation(repo: "depot-a", feature: "audit-ui-redesign")])
        #expect(confirmations.prompts.first == "Arrêter les pipelines de depot-a\u{00A0}? (feature audit-ui-redesign)")

        twin.actions.stopLot(try twin.action("audit-ui-redesign"))
        await twin.settle()
        #expect(try lastPost(voice) == lastPost(twin))
        #expect(try lastPost(voice) == NSDictionary(dictionary: [
            "version": 1, "repo": realpathOr(world.repoA), "kind": "stop",
        ]))
        #expect(try head(voice) == head(twin))
        #expect(try head(voice).kind == ActionsText.stopLabel)
        #expect(try head(voice).target == "depot-a")
        #expect(phrase == "Les pipelines de depot-a sont arrêtées.")
    }

    @Test("siri-mac-pilotage-pipelines/AC-8 : valider les specs puis accepter la revue écrivent les entrées des boutons de la fenêtre")
    func milestonesMatchButtons() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        let twin = try await makePile(world)
        defer { voice.stack.stop(); twin.stack.stop() }

        let specs = await voice.session(tablePolicy(.validateSpecs, Confirmations(accepts: true)))
            .pilot(.validateSpecs, spoken: "export csv", ask: { _ in throw CancellationError() })
        twin.actions.validate(try twin.action("export-csv"))
        await twin.settle()
        #expect(specs == "Les specs de la feature export-csv sont validées.")
        #expect(try lastPost(voice) == lastPost(twin))
        #expect(try lastPost(voice)["verdict"] as? String == "v")
        #expect(try head(voice) == head(twin))
        #expect(try head(voice).kind == ActionsText.specsLabel)

        let review = await voice.session(tablePolicy(.acceptReview, Confirmations(accepts: true)))
            .pilot(.acceptReview, spoken: "revue paiement", ask: { _ in throw CancellationError() })
        twin.actions.accept(try twin.action("revue-paiement"))
        await twin.settle()
        #expect(review == "La revue de la feature revue-paiement est acceptée.")
        #expect(try lastPost(voice) == lastPost(twin))
        #expect(try lastPost(voice)["verdict"] as? String == "y")
        #expect(try head(voice) == head(twin))
        #expect(try head(voice).kind == ActionsText.reviewLabel)
    }

    @Test("siri-mac-pilotage-pipelines/AC-9 : une carte hors du jalon demandé est refusée avec sa cause, rien n'est envoyé")
    func offMilestoneIsRefused() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }
        let confirmations = Confirmations(accepts: true)

        let specs = await voice.session(tablePolicy(.validateSpecs, confirmations))
            .pilot(.validateSpecs, spoken: "revue paiement", ask: { _ in throw CancellationError() })
        #expect(specs == VoiceSpeechText.pilotNotOffered(.validateSpecs))
        let review = await voice.session(tablePolicy(.acceptReview, confirmations))
            .pilot(.acceptReview, spoken: "export csv", ask: { _ in throw CancellationError() })
        #expect(review == VoiceSpeechText.pilotNotOffered(.acceptReview))

        let bare = try PilotWorld(milestones: false)
        let quiet = try await makePile(bare)
        defer { quiet.stack.stop() }
        let none = await quiet.session(tablePolicy(.validateSpecs, confirmations))
            .pilot(.validateSpecs, spoken: "audit ui", ask: { _ in throw CancellationError() })
        #expect(none == VoiceSpeechText.pilotNoEligible(.validateSpecs))
        let noReview = await quiet.session(tablePolicy(.acceptReview, confirmations))
            .pilot(.acceptReview, spoken: nil, ask: { _ in throw CancellationError() })
        #expect(noReview == VoiceSpeechText.pilotNoEligible(.acceptReview))

        #expect(confirmations.prompts.isEmpty)
        #expect(voice.service.posts.isEmpty && quiet.service.posts.isEmpty)
        #expect(voice.actions.journal.isEmpty && quiet.actions.journal.isEmpty)
    }

    @Test("siri-mac-pilotage-pipelines/AC-10 : un refus du service ou un POST en échec est dit, jamais le succès")
    func serviceRefusalIsSpoken() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }
        let refused = VoiceIssue.macRefused(motive: "lot occupé").phrase
        #expect(refused == "Le Mac a refusé la demande\u{00A0}: lot occupé.")

        voice.service.reply = .refused("lot occupé")
        let stop = await voice.session(tablePolicy(.stopFeature, Confirmations(accepts: true)))
            .pilot(.stop, spoken: "audit ui redesign", ask: { _ in throw CancellationError() })
        #expect(stop == refused)
        #expect(!stop.contains("sont arrêtées"))
        #expect(try head(voice).state == .refused(reason: "lot occupé"))

        let specs = await voice.session(tablePolicy(.validateSpecs, Confirmations(accepts: true)))
            .pilot(.validateSpecs, spoken: "export csv", ask: { _ in throw CancellationError() })
        #expect(specs == refused)
        #expect(!specs.contains("sont validées"))

        voice.service.reply = .failing("service des pipelines injoignable")
        let failed = await voice.session(tablePolicy(.acceptReview, Confirmations(accepts: true)))
            .pilot(.acceptReview, spoken: "revue paiement", ask: { _ in throw CancellationError() })
        #expect(try head(voice).state == .failed(reason: "service des pipelines injoignable"))
        #expect(failed == VoiceIssue.macRefused(motive: "service des pipelines injoignable").phrase)
        #expect(!failed.contains("est acceptée"))
        #expect(voice.service.posts.count == 3)
    }

    @Test("siri-mac-pilotage-pipelines/AC-12 : un nom ambigu fait demander laquelle, un nom inconnu n'envoie rien")
    func ambiguousThenUnknownName() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }

        let dictation = Dictation(["la deuxième"])
        let confirmations = Confirmations(accepts: true)
        let phrase = await voice.session(tablePolicy(.stopFeature, confirmations))
            .pilot(.stop, spoken: "audit ui", ask: { try await dictation.ask($0) })
        #expect(dictation.prompts == [VoiceSpeechText.featureAmbiguous(titles: ["audit-ui", "audit-ui-redesign"], more: 0)])
        #expect(dictation.prompts.first == "Plusieurs features correspondent\u{00A0}: audit-ui et audit-ui-redesign. Laquelle\u{00A0}?")
        #expect(confirmations.prompts == [VoiceGestureText.stopConfirmation(repo: "depot-a", feature: "audit-ui-redesign")])
        #expect(phrase == "Les pipelines de depot-a sont arrêtées.")
        #expect(voice.service.posts.count == 1)

        let unknown = await voice.session(tablePolicy(.stopFeature, confirmations))
            .pilot(.stop, spoken: "zorglub", ask: { _ in throw CancellationError() })
        #expect(unknown == VoiceSpeechText.featureNotFound)
        #expect(voice.service.posts.count == 1, "nom inconnu : aucune commande")
        #expect(confirmations.prompts.count == 1)
    }

    @Test("siri-mac-pilotage-pipelines/AC-13 : le littéral et la confirmation de chaque intent de pilotage concordent avec la table du Mac")
    func intentLiteralsMatchPolicy() async throws {
        #expect(pilotIntentCases.map(\.name) == [
            "MacLaunchPipelineIntent", "MacResumeFeatureIntent", "MacStopFeatureIntent",
            "MacValidateSpecsIntent", "MacAcceptReviewIntent",
        ])
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }

        for intent in pilotIntentCases {
            #expect(intent.gesture == intent.expected, "\(intent.name) : geste")
            #expect(
                intent.authenticationPolicy == VoiceGesturePolicy.authenticationPolicy(for: intent.gesture, on: .mac),
                "\(intent.name) : littéral authenticationPolicy"
            )
            let confirmations = Confirmations(accepts: true)
            let posts = voice.service.posts.count + voice.service.pilots.count
            _ = await intent.play(voice.session(tablePolicy(intent.gesture, confirmations)), Dictation())
            let needs = VoiceGesturePolicy.rule(for: intent.gesture, on: .mac).needsConfirmation
            #expect(confirmations.prompts.count == (needs ? 1 : 0), "\(intent.name) : confirmation")
            #expect(voice.service.posts.count + voice.service.pilots.count == posts + 1, "\(intent.name) : un envoi")
        }

        // Une sonde au littéral divergent : rien n'est demandé ni envoyé.
        let posts = voice.service.posts.count
        let misconfigured = await voice.session({ target, prompt, send in
            try await DivergentStopProbe().applyVoicePolicy(target: target, prompt: prompt, send: send)
        }).pilot(.stop, spoken: "audit ui redesign", ask: { _ in throw CancellationError() })
        #expect(misconfigured == VoiceGestureText.misconfigured)
        #expect(voice.service.posts.count == posts)
    }
}
