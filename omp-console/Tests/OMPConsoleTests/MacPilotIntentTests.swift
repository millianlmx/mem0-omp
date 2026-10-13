// Preuves tracées du pilotage des pipelines par Siri sur le Mac
// (siri-mac-pilotage-pipelines) : la conversation de ConsoleCore (`VoicePilot.run`
// et `VoicePilot.launch`, la même que sur l'iPhone) sur le canal du Mac
// `MacPilotChannel`, branché sur une pile RÉELLE (`RemoteStack`) et les gestes
// typés de `RemoteActions` que sert aussi l'API distante. Les tours de parole sont
// scriptés ; l'effet de chaque geste (commande postée au service, pilote
// sollicité, entrée de journal) est comparé à celui du bouton de la fenêtre,
// appelé sur une pile JUMELLE qui lit le même magasin. Le contexte est passé
// directement : un test ne lit jamais `intent.voice` (`AppDependency` hors du
// déroulé d'un intent est fatal).

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

/// L'abandon de Siri quand le script n'a plus de réponse.
private struct Abandoned: Error {}
/// Un « non » à la confirmation.
private struct Declined: Error {}

/// Les tours de parole scriptés : chaque `ask` rend la réponse suivante (ou lève
/// quand il n'y en a plus), chaque `confirm` accepte ou refuse ; tout est noté.
@MainActor
private final class Script: VoiceConversation {
    private(set) var asks: [String] = []
    private(set) var confirms: [String] = []
    private var answers: [String]
    private let accepts: Bool

    init(_ answers: [String] = [], accepts: Bool = true) {
        self.answers = answers
        self.accepts = accepts
    }

    func ask(_ dialog: String) async throws -> String {
        asks.append(dialog)
        guard !answers.isEmpty else { throw Abandoned() }
        return answers.removeFirst()
    }

    func confirm(_ dialog: String) async throws {
        confirms.append(dialog)
        if !accepts { throw Declined() }
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

    /// Un geste sur une feature : la conversation de ConsoleCore sur le canal du Mac.
    func run(_ gesture: VoicePilotGesture, _ script: Script) async throws -> String {
        try await VoicePilot.run(gesture, channel: MacPilotChannel(context: context), conversation: script)
    }

    /// Un lancement : la conversation de ConsoleCore sur le canal du Mac.
    func launch(_ script: Script) async throws -> String {
        try await VoicePilot.launch(channel: MacPilotChannel(context: context), conversation: script)
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

    @Parameter(title: "Réponse") var answer: String?

    func perform() async throws -> some IntentResult { .result() }
}

extension DivergentStopProbe: MacSiriDictation {
    var answerParameter: IntentParameter<String?> { $answer }
}

/// Le succès qu'énonce Siri pour `gesture` sur la cible `target`.
private func sent(_ gesture: VoiceGesture, _ target: String) -> String {
    VoiceIssue.sent(gesture, target: target).phrase
}

/// La question précédée de « je n'ai rien entendu », telle que Siri la redit.
private func again(_ ask: String) -> String {
    VoiceSpeechText.nothingHeard + " " + ask
}

/// Un intent de pilotage, son geste attendu (écrit à la main) et la façon de le
/// jouer : la conversation de ConsoleCore sur le canal du Mac, réponses scriptées.
private struct PilotIntentCase: @unchecked Sendable {
    let name: String
    let expected: VoiceGesture
    let gesture: VoiceGesture
    let authenticationPolicy: IntentAuthenticationPolicy
    let play: @MainActor (Pile, Script) async throws -> String
}

private let pilotIntentCases: [PilotIntentCase] = [
    PilotIntentCase(
        name: "MacLaunchPipelineIntent",
        expected: .launchPipeline,
        gesture: MacLaunchPipelineIntent.voiceGesture,
        authenticationPolicy: MacLaunchPipelineIntent.authenticationPolicy,
        play: { pile, script in try await pile.launch(script) }
    ),
    PilotIntentCase(
        name: "MacResumeFeatureIntent",
        expected: .resume,
        gesture: MacResumeFeatureIntent.voiceGesture,
        authenticationPolicy: MacResumeFeatureIntent.authenticationPolicy,
        play: { pile, script in try await pile.run(.resume, script) }
    ),
    PilotIntentCase(
        name: "MacStopFeatureIntent",
        expected: .stopFeature,
        gesture: MacStopFeatureIntent.voiceGesture,
        authenticationPolicy: MacStopFeatureIntent.authenticationPolicy,
        play: { pile, script in try await pile.run(.stop, script) }
    ),
    PilotIntentCase(
        name: "MacValidateSpecsIntent",
        expected: .validateSpecs,
        gesture: MacValidateSpecsIntent.voiceGesture,
        authenticationPolicy: MacValidateSpecsIntent.authenticationPolicy,
        play: { pile, script in try await pile.run(.validateSpecs, script) }
    ),
    PilotIntentCase(
        name: "MacAcceptReviewIntent",
        expected: .acceptReview,
        gesture: MacAcceptReviewIntent.voiceGesture,
        authenticationPolicy: MacAcceptReviewIntent.authenticationPolicy,
        play: { pile, script in try await pile.run(.acceptReview, script) }
    ),
]

/// Ce que dit l'utilisateur pour chaque intent de `pilotIntentCases`.
private let pilotSpoken: [String: [String]] = [
    "MacLaunchPipelineIntent": ["depot-a", "export pdf", "exporter en pdf"],
    "MacResumeFeatureIntent": ["pause longue"],
    "MacStopFeatureIntent": ["audit ui redesign"],
    "MacValidateSpecsIntent": ["export csv"],
    "MacAcceptReviewIntent": ["revue paiement"],
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

        let choices = KanbanLaunchRepos.choices(try await voice.context.launchRepos())
        #expect(choices.map(\.label) == ["depot-a", "depot-b"], "les deux dépôts connus de l'ardoise")
        let chosen = try #require(choices.first { $0.label == "depot-a" })

        let script = Script([chosen.label, "export csv", "exporter les stats"])
        let phrase = try await voice.launch(script)

        #expect(script.asks == [
            VoiceSpeechText.launchRepoAsk(labels: ["depot-a", "depot-b"]),
            VoiceSpeechText.launchTitleAsk,
            VoiceSpeechText.launchNeedAsk,
        ])
        #expect(phrase == sent(.launchPipeline, "export csv"))
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

        let script = Script(["depot-b", "  export csv ", "exporter les stats\n"])
        _ = try await voice.launch(script)

        #expect(script.confirms == [
            VoiceGestureText.launchConfirmation(title: "export csv", repo: "depot-b", need: "exporter les stats"),
        ])
        #expect(script.confirms.first == "Lancer export csv sur depot-b\u{00A0}? Besoin\u{00A0}: exporter les stats")
    }

    @Test("siri-mac-pilotage-pipelines/AC-3 : une confirmation refusée annule lancer, arrêter, valider et accepter sans rien écrire")
    func refusedConfirmationWritesNothing() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }
        let before = voice.cards

        let plays: [(String, @MainActor (Script) async throws -> String, [String])] = [
            ("lancer", { try await voice.launch($0) }, ["depot-a", "export pdf", "exporter en pdf"]),
            ("arrêter", { try await voice.run(.stop, $0) }, ["audit ui redesign"]),
            ("valider", { try await voice.run(.validateSpecs, $0) }, ["export csv"]),
            ("accepter", { try await voice.run(.acceptReview, $0) }, ["revue paiement"]),
        ]
        for (name, play, answers) in plays {
            let script = Script(answers, accepts: false)
            let phrase = try await play(script)
            #expect(script.confirms.count == 1, "\(name) : la confirmation est demandée")
            #expect(phrase == VoiceGestureText.cancelled, "\(name)")
        }
        #expect(voice.actions.journal.isEmpty)
        #expect(voice.service.posts.isEmpty)
        #expect(voice.service.pilots.isEmpty)
        #expect(voice.cards == before)
    }

    @Test("siri-mac-pilotage-pipelines/AC-4 : un titre ou un besoin dicté vide fait redire « rien entendu », puis annule sans créer de feature")
    func emptyTitleOrNeedCreatesNothing() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }

        let blankTitle = Script(["depot-a", "   ", "", "\n"])
        #expect(try await voice.launch(blankTitle) == VoiceGestureText.cancelled)
        #expect(blankTitle.asks.dropFirst() == [
            VoiceSpeechText.launchTitleAsk,
            again(VoiceSpeechText.launchTitleAsk),
            again(VoiceSpeechText.launchTitleAsk),
        ], "la cause est dite à chaque relance, le besoin n'est jamais demandé")

        let blankNeed = Script(["depot-a", "export csv", "", " ", ""])
        #expect(try await voice.launch(blankNeed) == VoiceGestureText.cancelled)
        #expect(blankNeed.asks.suffix(3) == [
            VoiceSpeechText.launchNeedAsk,
            again(VoiceSpeechText.launchNeedAsk),
            again(VoiceSpeechText.launchNeedAsk),
        ])

        #expect(blankTitle.confirms.isEmpty && blankNeed.confirms.isEmpty)
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
        let paused = Script(["pause longue"])
        let pausedPhrase = try await voice.run(.resume, paused)
        twin.actions.resume(try twin.action("pause-longue"))
        await twin.settle()
        #expect(pausedPhrase == "La pipeline pause-longue est reprise.")
        #expect(voice.service.pilots == twin.service.pilots)
        #expect(voice.service.pilots == [realpathOr(world.repoB)])
        #expect(try head(voice) == head(twin))
        #expect(try head(voice).kind == ActionsText.resumeLabel)

        // Relançable : la commande `relaunch`.
        let failed = Script(["import echoue"])
        let relaunched = try await voice.run(.resume, failed)
        twin.actions.relaunch(try twin.action("import-echoue"))
        await twin.settle()
        #expect(relaunched == "La pipeline import-echoue est reprise.")
        #expect(try lastPost(voice) == lastPost(twin))
        #expect(try lastPost(voice)["kind"] as? String == "relaunch")
        #expect(try head(voice) == head(twin))

        #expect(paused.confirms.isEmpty && failed.confirms.isEmpty, "reprendre ne demande aucune confirmation")
    }

    @Test("siri-mac-pilotage-pipelines/AC-6 : une feature que la fenêtre ne propose pas de reprendre n'est ni proposée ni reprise")
    func notResumableIsRefused() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }
        let card = try voice.card("audit-ui-redesign")
        #expect(!KanbanActionPresentation.resumable(card) && !KanbanActionPresentation.relaunchable(card))

        let script = Script(["audit ui redesign"])
        let phrase = try await voice.run(.resume, script)
        let offered = VoicePilot.eligible(.resume, in: voice.cards).map(\.title)
        #expect(!offered.contains("audit-ui-redesign"))
        #expect(script.asks == [VoiceSpeechText.pilotAsk(.resume, titles: offered, more: 0)], "Siri ne la propose pas")
        #expect(phrase == VoiceSpeechText.featureNotFound)
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

        let script = Script(["audit ui redesign"])
        let phrase = try await voice.run(.stop, script)

        #expect(script.confirms == [VoiceGestureText.stopConfirmation(repo: "depot-a", feature: "audit-ui-redesign")])
        #expect(script.confirms.first == "Arrêter les pipelines de depot-a\u{00A0}? (feature audit-ui-redesign)")

        twin.actions.stopLot(try twin.action("audit-ui-redesign"))
        await twin.settle()
        #expect(try lastPost(voice) == lastPost(twin))
        #expect(try lastPost(voice) == NSDictionary(dictionary: [
            "version": 1, "repo": realpathOr(world.repoA), "kind": "stop",
        ]))
        #expect(try head(voice) == head(twin))
        #expect(try head(voice).kind == ActionsText.stopLabel)
        #expect(try head(voice).target == "depot-a")
        #expect(phrase == sent(.stopFeature, "audit-ui-redesign"))
    }

    @Test("siri-mac-pilotage-pipelines/AC-8 : valider les specs puis accepter la revue écrivent les entrées des boutons de la fenêtre")
    func milestonesMatchButtons() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        let twin = try await makePile(world)
        defer { voice.stack.stop(); twin.stack.stop() }

        let specs = try await voice.run(.validateSpecs, Script(["export csv"]))
        twin.actions.validate(try twin.action("export-csv"))
        await twin.settle()
        #expect(specs == "Les specs de la feature export-csv sont validées.")
        #expect(try lastPost(voice) == lastPost(twin))
        #expect(try lastPost(voice)["verdict"] as? String == "v")
        #expect(try head(voice) == head(twin))
        #expect(try head(voice).kind == ActionsText.specsLabel)

        let review = try await voice.run(.acceptReview, Script(["revue paiement"]))
        twin.actions.accept(try twin.action("revue-paiement"))
        await twin.settle()
        #expect(review == "La revue de la feature revue-paiement est acceptée.")
        #expect(try lastPost(voice) == lastPost(twin))
        #expect(try lastPost(voice)["verdict"] as? String == "y")
        #expect(try head(voice) == head(twin))
        #expect(try head(voice).kind == ActionsText.reviewLabel)
    }

    @Test("siri-mac-pilotage-pipelines/AC-9 : une carte hors du jalon demandé n'est pas proposée et rien n'est envoyé ; sans carte au jalon, Siri le dit")
    func offMilestoneIsRefused() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }

        let specs = Script(["revue paiement"])
        #expect(try await voice.run(.validateSpecs, specs) == VoiceSpeechText.featureNotFound)
        #expect(specs.asks == [VoiceSpeechText.pilotAsk(.validateSpecs, titles: ["export-csv"], more: 0)])
        let review = Script(["export csv"])
        #expect(try await voice.run(.acceptReview, review) == VoiceSpeechText.featureNotFound)
        #expect(review.asks == [VoiceSpeechText.pilotAsk(.acceptReview, titles: ["revue-paiement"], more: 0)])

        let bare = try PilotWorld(milestones: false)
        let quiet = try await makePile(bare)
        defer { quiet.stack.stop() }
        let none = Script()
        #expect(try await quiet.run(.validateSpecs, none) == VoiceSpeechText.pilotNone(.validateSpecs))
        let noReview = Script()
        #expect(try await quiet.run(.acceptReview, noReview) == VoiceSpeechText.pilotNone(.acceptReview))
        #expect(none.asks.isEmpty && noReview.asks.isEmpty, "rien n'est demandé")

        #expect((specs.confirms + review.confirms + none.confirms + noReview.confirms).isEmpty)
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
        let stop = try await voice.run(.stop, Script(["audit ui redesign"]))
        #expect(stop == refused)
        #expect(stop != sent(.stopFeature, "audit-ui-redesign"))
        #expect(try head(voice).state == .refused(reason: "lot occupé"))

        let specs = try await voice.run(.validateSpecs, Script(["export csv"]))
        #expect(specs == refused)
        #expect(!specs.contains("sont validées"))

        voice.service.reply = .failing("service des pipelines injoignable")
        let failed = try await voice.run(.acceptReview, Script(["revue paiement"]))
        #expect(try head(voice).state == .failed(reason: "service des pipelines injoignable"))
        #expect(failed == VoiceIssue.macRefused(motive: "service des pipelines injoignable").phrase)
        #expect(!failed.contains("est acceptée"))
        #expect(voice.service.posts.count == 3)
    }

    @Test("siri-mac-pilotage-pipelines/AC-11 : chaque geste propose exactement les cartes que le prédicat existant de l'app offre")
    func eligibleCardsFollowAppPredicates() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }
        let cards = voice.cards

        func offers(_ gesture: VoicePilotGesture, _ card: KanbanCard) -> Bool {
            let zones = KanbanActionPresentation.zones(for: card)
            switch gesture {
            case .resume:
                return KanbanActionPresentation.resumable(card) || KanbanActionPresentation.relaunchable(card)
            case .stop:
                return zones.contains { if case .stopLot = $0 { return true }; return false }
            case .validateSpecs:
                return zones.contains { if case .milestone(_, .specs) = $0 { return true }; return false }
            case .acceptReview:
                return zones.contains { if case .milestone(_, .review) = $0 { return true }; return false }
            }
        }

        let expected: [VoicePilotGesture: Set<String>] = [
            .resume: ["pause-longue", "import-echoue"],
            .validateSpecs: ["export-csv"],
            .acceptReview: ["revue-paiement"],
        ]
        for gesture in VoicePilotGesture.allCases {
            let eligible = VoicePilot.eligible(gesture, in: cards)
            #expect(Set(eligible.map(\.id)) == Set(cards.filter { offers(gesture, $0) }.map(\.id)), "\(gesture)")
            if let titles = expected[gesture] {
                #expect(Set(eligible.map(\.title)) == titles, "\(gesture)")
            }
            #expect(!eligible.isEmpty, "\(gesture) : la fixture offre le geste")

            // Siri propose ces cartes, et elles seules.
            let script = Script()
            _ = try? await voice.run(gesture, script)
            #expect(script.asks == [VoiceSpeechText.pilotAsk(
                gesture, titles: eligible.prefix(3).map(\.title), more: max(eligible.count - 3, 0)
            )])
        }
        #expect(voice.service.posts.isEmpty && voice.actions.journal.isEmpty)
    }

    @Test("siri-mac-pilotage-pipelines/AC-12 : un nom ambigu fait demander laquelle, un nom inconnu n'envoie rien")
    func ambiguousThenUnknownName() async throws {
        let world = try PilotWorld()
        let voice = try await makePile(world)
        defer { voice.stack.stop() }

        let script = Script(["audit ui", "audit ui redesign"])
        let phrase = try await voice.run(.stop, script)
        #expect(script.asks.dropFirst() == [VoiceSpeechText.featureAmbiguous(titles: ["audit-ui", "audit-ui-redesign"], more: 0)])
        #expect(script.asks.last == "Plusieurs features correspondent\u{00A0}: audit-ui et audit-ui-redesign. Laquelle\u{00A0}?")
        #expect(script.confirms == [VoiceGestureText.stopConfirmation(repo: "depot-a", feature: "audit-ui-redesign")])
        #expect(phrase == sent(.stopFeature, "audit-ui-redesign"))
        #expect(voice.service.posts.count == 1)

        let unknown = Script(["zorglub"])
        #expect(try await voice.run(.stop, unknown) == VoiceSpeechText.featureNotFound)
        #expect(unknown.confirms.isEmpty)
        #expect(voice.service.posts.count == 1, "nom inconnu : aucune commande")
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
            #expect(VoiceGesturePolicy.admits(intent.authenticationPolicy, for: [intent.gesture], on: .mac), "\(intent.name)")
            let script = Script(pilotSpoken[intent.name] ?? [])
            let sends = voice.service.posts.count + voice.service.pilots.count
            _ = try await intent.play(voice, script)
            let needs = VoiceGesturePolicy.rule(for: intent.gesture, on: .mac).needsConfirmation
            #expect(script.confirms.count == (needs ? 1 : 0), "\(intent.name) : confirmation")
            #expect(voice.service.posts.count + voice.service.pilots.count == sends + 1, "\(intent.name) : un envoi")
        }

        // Une sonde au littéral divergent : rien n'est demandé ni envoyé.
        let sends = voice.service.posts.count
        let misconfigured = try await MacSiriPilot.run(.stop, intent: DivergentStopProbe(), context: voice.context)
        #expect(misconfigured == VoiceGestureText.misconfigured)
        #expect(voice.service.posts.count == sends)
    }
}
