// Le pilotage vocal des pipelines (siri-iphone-pilotage-pipelines, BR-1) : le
// moteur PUR de ConsoleCore — éligibilité par les prédicats des boutons,
// désignation, porte de confirmation, lancement — sur un canal factice et une
// conversation scriptée. Aucune vue, aucune E/S.

import ConsoleCore
import Foundation
import Testing

private let nbsp = "\u{00A0}"

private struct ScriptedError: Error {}

// MARK: - Fixtures de carte

private enum Fixture {
    /// Marque `mort` sur une feature vivante : « Reprendre ».
    case dead
    /// Feature de lot en échec : « Relancer ».
    case failed
    /// Feature qui attend le jalon `kind`.
    case waiting(LotWaitKind)
    /// Feature de lot qui tourne : arrêt seul.
    case running
    /// Carte de projet seule, sans lot : aucun geste.
    case projectOnly
    /// Carte sans valeurs de geste (historique).
    case noAction
}

private func card(_ slug: String, _ title: String, _ fixture: Fixture, repo: String = "depot") -> KanbanCard {
    let root = "/Users/x/\(repo)"
    let column: KanbanColumn
    let marks: [KanbanMark]
    let action: KanbanCardAction?
    switch fixture {
    case .dead:
        column = .enCours
        marks = [.mort]
        action = KanbanCardAction(repoRoot: root, slug: slug, waitKind: nil, featureState: .running, run: nil)
    case .failed:
        column = .echec
        marks = []
        action = KanbanCardAction(repoRoot: root, slug: slug, waitKind: nil, featureState: .failed, run: nil)
    case let .waiting(kind):
        column = kind == .specs ? .jalonSpecs : .jalonReview
        marks = []
        action = KanbanCardAction(repoRoot: root, slug: slug, waitKind: kind, featureState: .waiting, run: nil)
    case .running:
        column = .enCours
        marks = []
        action = KanbanCardAction(repoRoot: root, slug: slug, waitKind: nil, featureState: .running, run: nil)
    case .projectOnly:
        column = .enCours
        marks = []
        action = KanbanCardAction(repoRoot: root, slug: nil, waitKind: nil, featureState: nil, run: nil)
    case .noAction:
        column = .enCours
        marks = []
        action = nil
    }
    return KanbanCard(
        id: "feature:\(repo):\(slug)", column: column, repo: repo, title: title, state: "en cours",
        phase: nil, models: nil, prUrl: nil, startMs: 0, endMs: nil, marks: marks, sources: [], action: action
    )
}

// MARK: - Doublures

@MainActor
private final class Conversation: VoiceConversation {
    private var answers: [String]
    private var approvals: [Bool]
    private(set) var asks: [String] = []
    private(set) var confirms: [String] = []

    init(answers: [String] = [], approvals: [Bool] = []) {
        self.answers = answers
        self.approvals = approvals
    }

    func ask(_ dialog: String) async throws -> String {
        asks.append(dialog)
        guard !answers.isEmpty else { throw ScriptedError() }
        return answers.removeFirst()
    }

    func confirm(_ dialog: String) async throws {
        confirms.append(dialog)
        guard !approvals.isEmpty, approvals.removeFirst() else { throw ScriptedError() }
    }
}

@MainActor
private final class Channel: VoicePilotChannel {
    var board: [KanbanCard] = []
    var repos: [String] = []
    var readError: Error?
    var deliverError: Error?
    var scriptedIssue: VoiceIssue = .macUnreachable
    private(set) var deliveries: [VoicePilotDelivery] = []
    private(set) var issuedFor: [Error] = []

    func cards() async throws -> [KanbanCard] {
        if let readError { throw readError }
        return board
    }

    func launchRepos() async throws -> [String] {
        if let readError { throw readError }
        return repos
    }

    func deliver(_ delivery: VoicePilotDelivery) async throws {
        if let deliverError { throw deliverError }
        deliveries.append(delivery)
    }

    func issue(of error: Error) -> VoiceIssue {
        issuedFor.append(error)
        return scriptedIssue
    }
}

// MARK: - Tests

@Suite("VoicePilotTests")
@MainActor
struct VoicePilotTests {
    // --- lancement --------------------------------------------------------------

    @Test("siri-iphone-pilotage-pipelines/AC-2 : le dépôt se choisit parmi TOUS les dépôts du Mac, puis titre et besoin, sans question de modèle")
    func launchAsksRepoTitleNeedOnly() async throws {
        let channel = Channel()
        channel.repos = ["/Users/x/alpha", "/Users/x/beta", "/Users/x/gamma"]
        let conversation = Conversation(answers: ["beta", "Export CSV", "Exporter la liste"], approvals: [true])

        _ = try await VoicePilot.launch(channel: channel, conversation: conversation)

        let labels = KanbanLaunchRepos.choices(channel.repos).map(\.label)
        #expect(labels == ["alpha", "beta", "gamma"])
        #expect(conversation.asks == [
            VoiceSpeechText.launchRepoAsk(labels: labels),
            VoiceSpeechText.launchTitleAsk,
            VoiceSpeechText.launchNeedAsk,
        ])
        #expect(conversation.asks[0] == "Sur quel dépôt\(nbsp)? alpha, beta et gamma.")
        #expect(channel.deliveries == [.launch(repoRoot: "/Users/x/beta", title: "Export CSV", need: "Exporter la liste")])
    }

    @Test("siri-iphone-pilotage-pipelines/AC-2 : un dépôt non reconnu rappelle les choix, une réponse vide redemande le dépôt")
    func launchRepoRetries() async throws {
        let channel = Channel()
        channel.repos = ["/Users/x/alpha", "/Users/x/beta"]
        let conversation = Conversation(answers: ["delta", "  ", "la deuxième", "T", "B"], approvals: [true])

        _ = try await VoicePilot.launch(channel: channel, conversation: conversation)

        let ask = VoiceSpeechText.launchRepoAsk(labels: ["alpha", "beta"])
        #expect(Array(conversation.asks.prefix(3)) == [
            ask,
            VoiceSpeechText.optionNotFound(labels: ["alpha", "beta"]),
            VoiceSpeechText.nothingHeard + " " + ask,
        ])
        #expect(channel.deliveries == [.launch(repoRoot: "/Users/x/beta", title: "T", need: "B")])
    }

    @Test("siri-iphone-pilotage-pipelines/AC-3 : la confirmation relit les valeurs dictées épurées, et ce sont elles qui partent")
    func launchConfirmsDictatedValues() async throws {
        let channel = Channel()
        channel.repos = ["/Users/x/mem0-omp"]
        let conversation = Conversation(answers: ["  Export CSV ", " Exporter la liste  "], approvals: [true])

        let phrase = try await VoicePilot.launch(channel: channel, conversation: conversation)

        #expect(conversation.asks == [VoiceSpeechText.launchTitleAsk, VoiceSpeechText.launchNeedAsk])
        #expect(conversation.confirms == [
            VoiceGestureText.launchConfirmation(title: "Export CSV", repo: "mem0-omp", need: "Exporter la liste"),
        ])
        #expect(channel.deliveries == [.launch(repoRoot: "/Users/x/mem0-omp", title: "Export CSV", need: "Exporter la liste")])
        #expect(phrase == VoiceIssue.sent(.launchPipeline, target: "Export CSV").phrase)
        #expect(phrase == "La pipeline Export CSV est lancée.")
    }

    @Test("siri-iphone-pilotage-pipelines/AC-3 : une confirmation déclinée n'envoie aucun feature.launch")
    func launchDeclinedSendsNothing() async throws {
        let channel = Channel()
        channel.repos = ["/Users/x/mem0-omp"]
        let conversation = Conversation(answers: ["Export CSV", "Exporter la liste"], approvals: [false])

        let phrase = try await VoicePilot.launch(channel: channel, conversation: conversation)

        #expect(conversation.confirms.count == 1)
        #expect(channel.deliveries.isEmpty)
        #expect(phrase == VoiceGestureText.cancelled)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-4 : la phrase partagée du lancement est exacte et c'est elle que le moteur prononce")
    func launchConfirmationText() async throws {
        let expected = "Lancer Export CSV sur mem0-omp\(nbsp)? Besoin\(nbsp): Exporter la liste"
        #expect(VoiceGestureText.launchConfirmation(title: "Export CSV", repo: "mem0-omp", need: "Exporter la liste") == expected)

        let channel = Channel()
        channel.repos = ["/Users/x/mem0-omp"]
        let conversation = Conversation(answers: ["Export CSV", "Exporter la liste"], approvals: [false])
        _ = try await VoicePilot.launch(channel: channel, conversation: conversation)
        #expect(conversation.confirms == [expected])
    }

    @Test("siri-iphone-pilotage-pipelines/AC-3 : titre ou besoin vides trois fois de suite annulent sans rien envoyer")
    func launchBlankTitleCancels() async throws {
        let channel = Channel()
        channel.repos = ["/Users/x/mem0-omp"]
        let conversation = Conversation(answers: ["", " ", "\n"])

        let phrase = try await VoicePilot.launch(channel: channel, conversation: conversation)

        let again = VoiceSpeechText.nothingHeard + " " + VoiceSpeechText.launchTitleAsk
        #expect(conversation.asks == [VoiceSpeechText.launchTitleAsk, again, again])
        #expect(conversation.confirms.isEmpty)
        #expect(channel.deliveries.isEmpty)
        #expect(phrase == VoiceGestureText.cancelled)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-2 : un Mac sans dépôt le dit sans poser de question")
    func launchWithoutRepo() async throws {
        let channel = Channel()
        let conversation = Conversation()

        let phrase = try await VoicePilot.launch(channel: channel, conversation: conversation)

        #expect(phrase == VoiceSpeechText.launchNoRepo)
        #expect(conversation.asks.isEmpty)
        #expect(channel.deliveries.isEmpty)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-12 : un lancement refusé par le Mac énonce la cause du canal")
    func launchRefused() async throws {
        let channel = Channel()
        channel.repos = ["/Users/x/mem0-omp"]
        channel.deliverError = ScriptedError()
        channel.scriptedIssue = .macRefused(motive: "titre déjà pris")
        let conversation = Conversation(answers: ["Export CSV", "Exporter la liste"], approvals: [true])

        let phrase = try await VoicePilot.launch(channel: channel, conversation: conversation)

        #expect(phrase == "Le Mac a refusé la demande\(nbsp): titre déjà pris.")
        #expect(channel.issuedFor.count == 1)
    }

    // --- reprendre ----------------------------------------------------------------

    @Test("siri-iphone-pilotage-pipelines/AC-5 : seules les features reprenables ou relançables sont proposées, et la reprise part sans confirmation")
    func resumeOnlyEligible() async throws {
        let channel = Channel()
        channel.board = [
            card("login", "Connexion OAuth", .dead),
            card("export", "Export CSV", .failed),
            card("cache", "Cache disque", .running),
            card("hist", "Ancienne", .noAction),
        ]
        let conversation = Conversation(answers: ["connexion oauth"])

        let phrase = try await VoicePilot.run(.resume, channel: channel, conversation: conversation)

        #expect(VoicePilot.eligible(.resume, in: channel.board).map(\.id) == ["feature:depot:login", "feature:depot:export"])
        #expect(conversation.asks == [VoiceSpeechText.pilotAsk(.resume, titles: ["Connexion OAuth", "Export CSV"], more: 0)])
        #expect(conversation.confirms.isEmpty)
        #expect(channel.deliveries == [.resume(cardId: "feature:depot:login")])
        #expect(phrase == VoiceIssue.sent(.resume, target: "Connexion OAuth").phrase)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-5 : une feature non reprenable n'est pas désignable")
    func resumeIneligibleNotDesignable() async throws {
        let channel = Channel()
        channel.board = [card("login", "Connexion OAuth", .dead), card("cache", "Cache disque", .running)]
        let conversation = Conversation(answers: ["cache disque"])

        let phrase = try await VoicePilot.run(.resume, channel: channel, conversation: conversation)

        #expect(conversation.asks == [VoiceSpeechText.pilotAsk(.resume, titles: ["Connexion OAuth"], more: 0)])
        #expect(phrase == VoiceSpeechText.featureNotFound)
        #expect(channel.deliveries.isEmpty)
    }

    // --- arrêter --------------------------------------------------------------------

    @Test("siri-iphone-pilotage-pipelines/AC-7 : seule une feature arrêtable est proposée, l'arrêt confirme sur le dépôt entier puis envoie card.stop")
    func stopConfirmsRepo() async throws {
        let channel = Channel()
        channel.board = [
            card("cache", "Cache disque", .running, repo: "mem0-omp"),
            card("projet", "Projet seul", .projectOnly),
            card("hist", "Ancienne", .noAction),
        ]
        let conversation = Conversation(answers: ["cache disque"], approvals: [true])

        let phrase = try await VoicePilot.run(.stop, channel: channel, conversation: conversation)

        #expect(conversation.asks == [VoiceSpeechText.pilotAsk(.stop, titles: ["Cache disque"], more: 0)])
        #expect(conversation.confirms == [VoiceGestureText.stopConfirmation(repo: "mem0-omp", feature: "Cache disque")])
        #expect(conversation.confirms == ["Arrêter les pipelines de mem0-omp\(nbsp)? (feature Cache disque)"])
        #expect(channel.deliveries == [.stop(cardId: "feature:mem0-omp:cache")])
        #expect(phrase == VoiceIssue.sent(.stopFeature, target: "mem0-omp").phrase)
        #expect(phrase == "Les pipelines de mem0-omp sont arrêtées.")
    }

    @Test("siri-iphone-pilotage-pipelines/AC-7 : un arrêt décliné n'envoie rien")
    func stopDeclined() async throws {
        let channel = Channel()
        channel.board = [card("cache", "Cache disque", .running)]
        let conversation = Conversation(answers: ["cache"], approvals: [false])

        let phrase = try await VoicePilot.run(.stop, channel: channel, conversation: conversation)

        #expect(conversation.confirms.count == 1)
        #expect(channel.deliveries.isEmpty)
        #expect(phrase == VoiceGestureText.cancelled)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-7 : la porte prononce le prompt explicite, retombe sur la table s'il est blanc et l'ignore sans confirmation")
    func applyPrompt() async throws {
        var heard: [String] = []
        var sent = 0
        let confirm: @MainActor (String) async throws -> Void = { heard.append($0) }
        let send: @MainActor () async throws -> Void = { sent += 1 }

        _ = try await VoiceGesturePolicy.apply(.stopFeature, target: "x", prompt: "Arrêter tout\(nbsp)?", on: .ios,
                                               confirm: confirm, send: send)
        _ = try await VoiceGesturePolicy.apply(.stopFeature, target: "x", prompt: " \n", on: .ios,
                                               confirm: confirm, send: send)
        let resumed = try await VoiceGesturePolicy.apply(.resume, target: "x", prompt: "jamais dit", on: .ios,
                                                         confirm: confirm, send: send)
        let unnamed = try await VoiceGesturePolicy.apply(.stopFeature, target: "  ", prompt: "Arrêter tout\(nbsp)?",
                                                         on: .ios, confirm: confirm, send: send)

        #expect(heard == ["Arrêter tout\(nbsp)?", VoiceGestureText.confirmation(for: .stopFeature, target: "x")])
        #expect(resumed == .sent)
        #expect(unnamed == .cancelled(dialog: VoiceGestureText.cancelled))
        #expect(sent == 3)
    }

    // --- jalons ---------------------------------------------------------------------

    @Test("siri-iphone-pilotage-pipelines/AC-8 : valider les specs ne propose que la feature au jalon specs et envoie le verdict specs")
    func validateSpecs() async throws {
        let channel = Channel()
        channel.board = [card("a", "Audit UI", .waiting(.specs)), card("b", "Bascule thème", .waiting(.review))]
        let conversation = Conversation(answers: ["audit ui"], approvals: [true])

        let phrase = try await VoicePilot.run(.validateSpecs, channel: channel, conversation: conversation)

        #expect(conversation.asks == [VoiceSpeechText.pilotAsk(.validateSpecs, titles: ["Audit UI"], more: 0)])
        #expect(conversation.confirms == [VoiceGestureText.confirmation(for: .validateSpecs, target: "Audit UI")])
        #expect(channel.deliveries == [.verdict(cardId: "feature:depot:a", milestone: .specs)])
        #expect(phrase == VoiceIssue.sent(.validateSpecs, target: "Audit UI").phrase)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-8 : accepter la revue ne propose que la feature au jalon revue et envoie le verdict revue")
    func acceptReview() async throws {
        let channel = Channel()
        channel.board = [card("a", "Audit UI", .waiting(.specs)), card("b", "Bascule thème", .waiting(.review))]
        let conversation = Conversation(answers: ["bascule theme"], approvals: [true])

        let phrase = try await VoicePilot.run(.acceptReview, channel: channel, conversation: conversation)

        #expect(conversation.asks == [VoiceSpeechText.pilotAsk(.acceptReview, titles: ["Bascule thème"], more: 0)])
        #expect(conversation.confirms == [VoiceGestureText.confirmation(for: .acceptReview, target: "Bascule thème")])
        #expect(channel.deliveries == [.verdict(cardId: "feature:depot:b", milestone: .review)])
        #expect(phrase == VoiceIssue.sent(.acceptReview, target: "Bascule thème").phrase)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-8 : un jalon décliné n'envoie aucun verdict")
    func milestoneDeclined() async throws {
        let channel = Channel()
        channel.board = [card("a", "Audit UI", .waiting(.specs))]
        let conversation = Conversation(answers: ["audit"], approvals: [false])

        let phrase = try await VoicePilot.run(.validateSpecs, channel: channel, conversation: conversation)

        #expect(channel.deliveries.isEmpty)
        #expect(phrase == VoiceGestureText.cancelled)
    }

    // --- désignation ------------------------------------------------------------------

    @Test("siri-iphone-pilotage-pipelines/AC-10 : un titre ambigu fait préciser, puis la feature précisée part")
    func ambiguousTitleAsksAgain() async throws {
        let channel = Channel()
        channel.board = [card("pdf", "Export PDF", .running), card("csv", "Export CSV", .running)]
        let conversation = Conversation(answers: ["export", "export pdf"], approvals: [true])

        _ = try await VoicePilot.run(.stop, channel: channel, conversation: conversation)

        #expect(conversation.asks == [
            VoiceSpeechText.pilotAsk(.stop, titles: ["Export CSV", "Export PDF"], more: 0),
            VoiceSpeechText.featureAmbiguous(titles: ["Export CSV", "Export PDF"], more: 0),
        ])
        #expect(channel.deliveries == [.stop(cardId: "feature:depot:pdf")])
    }

    @Test("siri-iphone-pilotage-pipelines/AC-10 : un titre sans correspondance le dit et n'envoie rien")
    func unknownTitle() async throws {
        let channel = Channel()
        channel.board = [card("csv", "Export CSV", .running)]
        let conversation = Conversation(answers: ["tableau de bord"], approvals: [true])

        let phrase = try await VoicePilot.run(.stop, channel: channel, conversation: conversation)

        #expect(phrase == VoiceSpeechText.featureNotFound)
        #expect(conversation.confirms.isEmpty)
        #expect(channel.deliveries.isEmpty)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-10 : au-delà de 3 features éligibles la question en nomme 3 puis « et N autres »")
    func pilotAskCapsAtThree() async throws {
        let channel = Channel()
        channel.board = ["a", "b", "c", "d", "e"].map { card($0, "Feature \($0)", .dead) }
        let conversation = Conversation(answers: ["feature e"])

        _ = try await VoicePilot.run(.resume, channel: channel, conversation: conversation)

        #expect(conversation.asks == ["Quelle feature reprendre\(nbsp)? Feature a, Feature b, Feature c et 2 autres."])
        #expect(channel.deliveries == [.resume(cardId: "feature:depot:e")])
    }

    @Test("siri-iphone-pilotage-pipelines/AC-10 : trois réponses blanches annulent sans rien envoyer")
    func blankDesignationCancels() async throws {
        let channel = Channel()
        channel.board = [card("csv", "Export CSV", .running)]
        let conversation = Conversation(answers: ["", "  ", "\t"])

        let phrase = try await VoicePilot.run(.stop, channel: channel, conversation: conversation)

        let ask = VoiceSpeechText.pilotAsk(.stop, titles: ["Export CSV"], more: 0)
        let again = VoiceSpeechText.nothingHeard + " " + ask
        #expect(conversation.asks == [ask, again, again])
        #expect(phrase == VoiceGestureText.cancelled)
        #expect(channel.deliveries.isEmpty)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-5 : sans feature éligible, Siri le dit sans rien demander")
    func noEligible() async throws {
        let channel = Channel()
        channel.board = [card("cache", "Cache disque", .running)]
        for gesture in [VoicePilotGesture.resume, .validateSpecs, .acceptReview] {
            let conversation = Conversation()
            let phrase = try await VoicePilot.run(gesture, channel: channel, conversation: conversation)
            #expect(phrase == VoiceSpeechText.pilotNone(gesture))
            #expect(conversation.asks.isEmpty)
        }
        #expect(channel.deliveries.isEmpty)
    }

    // --- issues ---------------------------------------------------------------------

    @Test("siri-iphone-pilotage-pipelines/AC-12 : un refus du Mac à l'envoi énonce sa cause, sans relire l'ardoise")
    func refusalSpeaksMacCause() async throws {
        let channel = Channel()
        channel.board = [card("a", "Audit UI", .waiting(.specs))]
        channel.deliverError = ScriptedError()
        channel.scriptedIssue = .macRefused(motive: "ce jalon n’est pas attendu")
        let conversation = Conversation(answers: ["audit ui"], approvals: [true])

        let phrase = try await VoicePilot.run(.validateSpecs, channel: channel, conversation: conversation)

        #expect(phrase == "Le Mac a refusé la demande\(nbsp): ce jalon n’est pas attendu.")
        #expect(channel.issuedFor.count == 1)
        #expect(channel.issuedFor.first is ScriptedError)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-12 : une ardoise illisible énonce la cause du canal, sans question ni envoi")
    func unreadableBoard() async throws {
        let channel = Channel()
        channel.readError = ScriptedError()
        channel.scriptedIssue = .macUnreachable
        let conversation = Conversation()

        let phrase = try await VoicePilot.run(.stop, channel: channel, conversation: conversation)
        let launched = try await VoicePilot.launch(channel: channel, conversation: conversation)

        #expect(phrase == VoiceIssue.macUnreachable.phrase)
        #expect(launched == VoiceIssue.macUnreachable.phrase)
        #expect(conversation.asks.isEmpty)
        #expect(channel.deliveries.isEmpty)
    }

    @Test("siri-iphone-pilotage-pipelines/AC-12 : une annulation de tâche est relancée telle quelle")
    func cancellationRethrown() async throws {
        let channel = Channel()
        channel.readError = CancellationError()
        await #expect(throws: CancellationError.self) {
            _ = try await VoicePilot.run(.resume, channel: channel, conversation: Conversation())
        }
        #expect(channel.issuedFor.isEmpty)
    }
}
