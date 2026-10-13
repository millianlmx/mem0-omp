// Preuves du noyau vocal du pilotage (siri-mac-pilotage-pipelines, BR-1) : les
// features éligibles à un geste, la désignation d'une feature par la voix et le
// brouillon d'un lancement dicté. Les ensembles attendus sont écrits À LA MAIN :
// dérivés du code de production, ils prouveraient le moteur par lui-même.

import ConsoleCore
import Testing
@testable import OMPConsole

private let nbsp = "\u{00A0}"

/// Une carte de feature de lot du dépôt `depot`.
private func lotCard(
    _ slug: String,
    _ title: String,
    column: KanbanColumn,
    state: LotFeatureState,
    waitKind: LotWaitKind? = nil,
    marks: [KanbanMark] = []
) -> KanbanCard {
    KanbanCard(
        id: "feature:abc:\(slug)", column: column, repo: "depot", title: title, state: "état", phase: nil,
        models: nil, prUrl: nil, startMs: 0, endMs: nil, marks: marks, sources: [],
        action: KanbanCardAction(repoRoot: "/tmp/depot", slug: slug, waitKind: waitKind, featureState: state, run: nil)
    )
}

/// L'ardoise de fixture : une carte par état qui compte pour un geste.
private enum Board {
    static let paused = lotCard("pause", "cache sessions", column: .enCours, state: .running, marks: [.mort])
    static let failed = lotCard("echec", "export csv", column: .echec, state: .failed)
    static let running = lotCard("cours", "login oauth", column: .enCours, state: .running)
    static let specs = lotCard("specs", "audit UI", column: .jalonSpecs, state: .waiting, waitKind: .specs)
    static let review = lotCard("revue", "audit UI redesign", column: .jalonReview, state: .waiting, waitKind: .review)
    static let delivered = lotCard("livree", "theme sombre", column: .fusionne, state: .done)
    static let history = KanbanCard(
        id: "history:0123456789abcdef", column: .termineeSansPr, repo: "depot", title: "ancien run", state: "terminé",
        phase: .impl, models: nil, prUrl: nil, startMs: 0, endMs: 1, marks: [], sources: []
    )
    static let run = KanbanCard(
        id: "run:fedcba9876543210", column: .enCours, repo: "depot", title: "run libre", state: "en cours",
        phase: .impl, models: nil, prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: [],
        action: KanbanCardAction(
            repoRoot: nil, slug: nil, waitKind: nil, featureState: nil,
            run: KanbanCardRun(id: "fedcba9876543210", label: "run libre", inbox: "/tmp/inbox", pendingAsk: nil)
        )
    )
    static let all = [paused, failed, running, specs, review, delivered, history, run]
}

/// Les réponses dites à Siri, dans l'ordre ; les questions posées sont notées. Une
/// question de trop lève, comme une annulation.
@MainActor
private final class Voice {
    struct Exhausted: Error {}
    var answers: [String]
    var prompts: [String] = []
    var fields: [VoiceLaunchField] = []

    init(_ answers: [String] = []) { self.answers = answers }

    func ask(_ prompt: String) async throws -> String {
        prompts.append(prompt)
        guard !answers.isEmpty else { throw Exhausted() }
        return answers.removeFirst()
    }

    func ask(_ field: VoiceLaunchField, _ prompt: String) async throws -> String {
        fields.append(field)
        return try await ask(prompt)
    }
}

private let twoRepos = [
    KanbanLaunchRepoChoice(root: "/src/mem0-omp", label: "mem0-omp"),
    KanbanLaunchRepoChoice(root: "/src/piket", label: "piket"),
]

@Suite("VoicePilotTests")
@MainActor
struct VoicePilotTests {
    // --- éligibilité (S-2) ------------------------------------------------------

    @Test(
        "siri-mac-pilotage-pipelines/AC-11 : chaque geste propose exactement les cartes que le prédicat existant de l’app offre",
        arguments: VoicePilotGesture.allCases
    )
    func eligibleIsTheAppPredicate(gesture: VoicePilotGesture) {
        let expected: [String]
        let predicate: (KanbanCard) -> Bool
        switch gesture {
        case .resume:
            expected = ["feature:abc:pause", "feature:abc:echec"]
            predicate = { KanbanActionPresentation.resumable($0) || KanbanActionPresentation.relaunchable($0) }
        case .stop:
            expected = ["feature:abc:pause", "feature:abc:echec", "feature:abc:cours", "feature:abc:specs", "feature:abc:revue", "feature:abc:livree"]
            predicate = { KanbanActionPresentation.zones(for: $0).contains(.stopLot(repoRoot: "/tmp/depot")) }
        case .validateSpecs:
            expected = ["feature:abc:specs"]
            predicate = { KanbanActionPresentation.zones(for: $0).contains(.milestone(slug: "specs", kind: .specs)) }
        case .acceptReview:
            expected = ["feature:abc:revue"]
            predicate = { KanbanActionPresentation.zones(for: $0).contains(.milestone(slug: "revue", kind: .review)) }
        }
        let eligible = VoicePilot.eligible(gesture, in: Board.all)
        #expect(eligible.map(\.id) == expected)
        #expect(eligible == Board.all.filter(predicate))
        // Ce que Siri et Raccourcis proposent sur le Mac : les titres de ces cartes, dans l'ordre.
        #expect(MacPilotSession.featureTitles(gesture, in: Board.all) == Board.all.filter(predicate).map(\.title))
    }

    @Test("siri-mac-pilotage-pipelines/AC-11 : chaque geste du pilotage relève de sa ligne de la politique vocale")
    func pilotGestureMapsToPolicy() {
        #expect(VoicePilotGesture.resume.voiceGesture == .resume)
        #expect(VoicePilotGesture.stop.voiceGesture == .stopFeature)
        #expect(VoicePilotGesture.validateSpecs.voiceGesture == .validateSpecs)
        #expect(VoicePilotGesture.acceptReview.voiceGesture == .acceptReview)
    }

    // --- désignation (S-3) --------------------------------------------------------

    @Test("siri-mac-pilotage-pipelines/AC-12 : un nom ambigu fait demander laquelle, et « la deuxième » choisit la seconde")
    func ambiguousNameAsksWhich() async {
        let voice = Voice(["la deuxième"])
        let pick = await VoicePilot.pickFeature(.stop, spoken: "audit UI", cards: Board.all, ask: voice.ask)
        #expect(voice.prompts == ["Plusieurs features correspondent\(nbsp): audit UI et audit UI redesign. Laquelle\(nbsp)?"])
        #expect(pick == .card(Board.review))
    }

    @Test("siri-mac-pilotage-pipelines/AC-12 : une réponse qui précise le nom lève l’ambiguïté parmi les seules candidates")
    func narrowingAnswerPicksAmongCandidates() async {
        let voice = Voice(["redesign"])
        let pick = await VoicePilot.pickFeature(.stop, spoken: "audit", cards: Board.all, ask: voice.ask)
        #expect(voice.prompts.count == 1)
        #expect(pick == .card(Board.review))
    }

    @Test("siri-mac-pilotage-pipelines/AC-12 : un nom inconnu dit qu’aucune feature ne correspond, sans rien demander")
    func unknownNameIsNotFound() async {
        let voice = Voice()
        let pick = await VoicePilot.pickFeature(.stop, spoken: "facturation", cards: Board.all, ask: voice.ask)
        #expect(pick == .said(VoiceSpeechText.featureNotFound))
        #expect(voice.prompts.isEmpty)
    }

    @Test("siri-mac-pilotage-pipelines/AC-12 : sans nom dit, Siri demande la feature, puis la trouve")
    func missingNameIsAsked() async {
        let voice = Voice(["  login oauth "])
        let pick = await VoicePilot.pickFeature(.stop, spoken: "  ", cards: Board.all, ask: voice.ask)
        #expect(voice.prompts == [VoiceSpeechText.pilotWhichFeature(.stop)])
        #expect(VoiceSpeechText.pilotWhichFeature(.stop) == "Quelle feature arrêter\(nbsp)?")
        #expect(pick == .card(Board.running))
    }

    @Test("siri-mac-pilotage-pipelines/AC-12 : une désignation sans fin s’arrête après trois questions, et une annulation n’envoie rien")
    func endlessOrCancelledPickSaysSo() async {
        let endless = Voice(["audit", "audit", "audit"])
        let tired = await VoicePilot.pickFeature(.stop, spoken: nil, cards: Board.all, ask: endless.ask)
        #expect(endless.prompts.count == VoiceConversation.maxAsks)
        #expect(tired == .said(VoiceSpeechText.walkNotUnderstood))

        let cancelled = await VoicePilot.pickFeature(.stop, spoken: nil, cards: Board.all, ask: Voice().ask)
        #expect(cancelled == .said(VoiceGestureText.cancelled))
    }

    @Test("siri-mac-pilotage-pipelines/AC-6 : une feature en cours que la fenêtre ne propose pas de reprendre ne l’est pas à la voix")
    func runningFeatureIsNotResumable() async {
        #expect(!VoicePilot.eligible(.resume, in: Board.all).contains(Board.running))
        let voice = Voice()
        let pick = await VoicePilot.pickFeature(.resume, spoken: "login oauth", cards: Board.all, ask: voice.ask)
        #expect(pick == .said(VoiceSpeechText.pilotNotOffered(.resume)))
        #expect(VoiceSpeechText.pilotNotOffered(.resume) == "Aucune feature à ce nom ne peut être reprise dans son état actuel, rien n’a été envoyé.")
        #expect(voice.prompts.isEmpty)
    }

    @Test("siri-mac-pilotage-pipelines/AC-9 : une carte hors du jalon demandé fait énoncer la cause, sans rien demander")
    func cardOffMilestoneIsNotOffered() async {
        let voice = Voice()
        let specs = await VoicePilot.pickFeature(.validateSpecs, spoken: "login oauth", cards: Board.all, ask: voice.ask)
        #expect(specs == .said(VoiceSpeechText.pilotNotOffered(.validateSpecs)))
        let review = await VoicePilot.pickFeature(.acceptReview, spoken: "cache sessions", cards: Board.all, ask: voice.ask)
        #expect(review == .said(VoiceSpeechText.pilotNotOffered(.acceptReview)))
        #expect(voice.prompts.isEmpty)
        // Une feature livrée n'est plus « en cours » : elle est introuvable, pas refusée.
        let delivered = await VoicePilot.pickFeature(.validateSpecs, spoken: "theme sombre", cards: Board.all, ask: voice.ask)
        #expect(delivered == .said(VoiceSpeechText.featureNotFound))
    }

    @Test("siri-mac-pilotage-pipelines/AC-9 : sans aucune carte au jalon, Siri dit qu’aucune feature ne l’attend")
    func noCardAtMilestone() async {
        let cards = [Board.paused, Board.running, Board.delivered]
        let voice = Voice()
        let specs = await VoicePilot.pickFeature(.validateSpecs, spoken: "audit UI", cards: cards, ask: voice.ask)
        #expect(specs == .said("Aucune feature n’attend la validation de ses specs."))
        let review = await VoicePilot.pickFeature(.acceptReview, spoken: nil, cards: cards, ask: voice.ask)
        #expect(review == .said("Aucune feature n’attend l’acceptation de sa revue."))
        #expect(voice.prompts.isEmpty)
    }

    // --- brouillon de lancement (S-4) ---------------------------------------------

    @Test("siri-mac-pilotage-pipelines/AC-2 : la confirmation du lancement relit le titre, le dépôt et le besoin dictés")
    func launchConfirmationReadsBack() async {
        #expect(
            VoiceGestureText.launchConfirmation(title: "export csv", repo: "mem0-omp", need: "exporter les stats")
                == "Lancer export csv sur mem0-omp\(nbsp)? Besoin\(nbsp): exporter les stats"
        )
        let voice = Voice(["piket", "  export csv ", " exporter les stats\n"])
        let step = await VoicePilot.draftLaunch(repo: nil, title: nil, need: nil, choices: twoRepos, ask: voice.ask)
        let draft = VoiceLaunchDraft(repo: twoRepos[1], title: "export csv", need: "exporter les stats")
        #expect(step == .draft(draft))
        #expect(draft.confirmation == "Lancer export csv sur piket\(nbsp)? Besoin\(nbsp): exporter les stats")
        #expect(voice.fields == [.repo, .title, .need])
        #expect(voice.prompts == [
            "Sur quel dépôt lancer la pipeline\(nbsp)? Choix possibles\(nbsp): mem0-omp et piket.",
            VoiceSpeechText.launchAskTitle,
            VoiceSpeechText.launchAskNeed,
        ])
    }

    @Test("siri-mac-pilotage-pipelines/AC-1 : le dépôt se choisit par son libellé ou son rang, et un seul dépôt n’est pas demandé")
    func repoIsPickedByLabelOrRank() async {
        let byRank = Voice(["la première"])
        let first = await VoicePilot.draftLaunch(repo: nil, title: "a", need: "b", choices: twoRepos, ask: byRank.ask)
        #expect(first == .draft(VoiceLaunchDraft(repo: twoRepos[0], title: "a", need: "b")))

        let retry = Voice(["piket"])
        let second = await VoicePilot.draftLaunch(repo: "facturation", title: "a", need: "b", choices: twoRepos, ask: retry.ask)
        #expect(retry.prompts == [VoiceSpeechText.optionNotFound(labels: ["mem0-omp", "piket"])])
        #expect(second == .draft(VoiceLaunchDraft(repo: twoRepos[1], title: "a", need: "b")))

        let single = Voice()
        let only = await VoicePilot.draftLaunch(repo: nil, title: "a", need: "b", choices: [twoRepos[0]], ask: single.ask)
        #expect(only == .draft(VoiceLaunchDraft(repo: twoRepos[0], title: "a", need: "b")))
        #expect(single.prompts.isEmpty)

        let endless = Voice(["x", "y", "z"])
        let lost = await VoicePilot.draftLaunch(repo: nil, title: "a", need: "b", choices: twoRepos, ask: endless.ask)
        #expect(lost == .said(VoiceSpeechText.walkNotUnderstood))
        #expect(endless.prompts.count == VoiceConversation.maxAsks)

        let none = await VoicePilot.draftLaunch(repo: nil, title: "a", need: "b", choices: [], ask: Voice().ask)
        #expect(none == .said(VoiceSpeechText.launchNoRepo))

        let cancelled = await VoicePilot.draftLaunch(repo: nil, title: nil, need: nil, choices: twoRepos, ask: Voice().ask)
        #expect(cancelled == .said(VoiceGestureText.cancelled))
    }

    @Test("siri-mac-pilotage-pipelines/AC-4 : un titre ou un besoin dicté vide énonce la cause, et un titre vide ne fait pas demander le besoin")
    func emptyTitleOrNeedSaysWhy() async {
        let blankTitle = Voice()
        let noTitle = await VoicePilot.draftLaunch(repo: "piket", title: "   ", need: nil, choices: twoRepos, ask: blankTitle.ask)
        #expect(noTitle == .said(VoiceSpeechText.launchEmptyTitle))
        #expect(VoiceSpeechText.launchEmptyTitle == "Le titre dicté est vide, aucune feature n’a été créée.")
        #expect(blankTitle.fields.isEmpty)

        let dictatedBlank = Voice([" \n"])
        let askedTitle = await VoicePilot.draftLaunch(repo: "piket", title: nil, need: nil, choices: twoRepos, ask: dictatedBlank.ask)
        #expect(askedTitle == .said(VoiceSpeechText.launchEmptyTitle))
        #expect(dictatedBlank.fields == [.title])

        let blankNeed = Voice([""])
        let noNeed = await VoicePilot.draftLaunch(repo: "piket", title: "export csv", need: nil, choices: twoRepos, ask: blankNeed.ask)
        #expect(noNeed == .said(VoiceSpeechText.launchEmptyNeed))
        #expect(VoiceSpeechText.launchEmptyNeed == "Le besoin dicté est vide, aucune feature n’a été créée.")
        #expect(blankNeed.fields == [.need])
    }
}
