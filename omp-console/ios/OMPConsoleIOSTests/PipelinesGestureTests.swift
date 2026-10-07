import ConsoleCore
import Testing

@testable import OMPConsoleIOS
@testable import ConsoleCore

/// Les preuves Swift de la table des gestes d'une carte (S-5, BR-5) : la liste
/// offerte est une fonction PURE de la carte, dans l'ordre de S-5, et le geste
/// `.steer` de macOS n'est jamais offert.
@Suite("ios-pipelines — la table des gestes d'une carte")
struct PipelinesGestureTests {
    private func card(
        column: KanbanColumn,
        prUrl: String? = nil,
        marks: [KanbanMark] = [],
        action: KanbanCardAction? = nil
    ) -> KanbanCard {
        KanbanCard(
            id: "feature:abc:slug",
            column: column,
            repo: "depot",
            title: "slug",
            state: "attend",
            phase: nil,
            models: nil,
            prUrl: prUrl,
            startMs: 0,
            endMs: nil,
            marks: marks,
            sources: [],
            action: action
        )
    }

    private func action(
        repoRoot: String? = "/depot",
        repoKey: String? = "abc",
        slug: String? = "slug",
        waitKind: LotWaitKind? = nil,
        featureState: LotFeatureState? = nil,
        run: KanbanCardRun? = nil
    ) -> KanbanCardAction {
        KanbanCardAction(
            repoRoot: repoRoot,
            repoKey: repoKey,
            slug: slug,
            waitKind: waitKind,
            featureState: featureState,
            run: run
        )
    }

    @Test("ios-pipelines/AC-5 : une question à options offre « répondre à la question »")
    func pendingQuestionOffersAnswer() {
        let ask = PanelPendingAsk(
            toolCallId: "call-1",
            id: "ask-1",
            question: "Quel format ?",
            options: [PanelAskOption(label: "CSV", description: nil)]
        )
        let run = KanbanCardRun(id: "r1", label: "depot/slug", inbox: "/box", pendingAsk: ask)
        let c = card(
            column: .questionEnVol,
            action: action(waitKind: .answer, featureState: .waiting, run: run)
        )
        let gestures = PipelinesGesture.gestures(of: c)
        #expect(gestures.first == .answerQuestion(toolCallId: "call-1", question: "Quel format ?", options: ask.options))
    }

    @Test("ios-pipelines/AC-6 : la question en texte d'un maillon terminé offre « répondre en texte »")
    func textQuestionOffersAnswerText() {
        let c = card(
            column: .questionEnVol,
            action: action(waitKind: .answer, featureState: .waiting, run: nil)
        )
        #expect(PipelinesGesture.gestures(of: c).contains(.answerText(prompt: nil)))
        #expect(!PipelinesGesture.gestures(of: c).contains { if case .answerQuestion = $0 { return true } else { return false } })
    }

    @Test("ios-pipelines/AC-7 : le jalon specs puis revue offre le bon verdict")
    func milestoneOffersVerdict() {
        let specs = card(column: .jalonSpecs, action: action(waitKind: .specs, featureState: .waiting))
        #expect(PipelinesGesture.gestures(of: specs).contains(.validateMilestone(kind: .specs)))
        #expect(LotWaitKind.specs.verdict == "specs")

        let review = card(column: .jalonReview, action: action(waitKind: .review, featureState: .waiting))
        #expect(PipelinesGesture.gestures(of: review).contains(.validateMilestone(kind: .review)))
        #expect(LotWaitKind.review.verdict == "review")
    }

    @Test("ios-pipelines/AC-8 : une carte morte vivante offre « reprendre », avec « arrêter »")
    func deadFeatureOffersResume() {
        let c = card(column: .echec, marks: [.mort], action: action(featureState: .running, run: nil))
        let gestures = PipelinesGesture.gestures(of: c)
        #expect(gestures.contains(.resume))
        #expect(gestures.contains(.stop))
    }

    @Test("ios-pipelines/AC-9 : une feature de lot offre « arrêter »")
    func lotCardOffersStop() {
        let c = card(column: .enCours, action: action(slug: "slug", featureState: .running))
        #expect(PipelinesGesture.gestures(of: c).contains(.stop))
    }

    @Test("ios-pipelines/AC-12 : une carte jamais en route offrant un dépôt propose « lancer »")
    func waitingCardOffersLaunch() {
        let c = card(column: .enAttente, action: action(slug: nil, waitKind: nil, featureState: nil, run: nil))
        #expect(PipelinesGesture.gestures(of: c).contains(.launch))
    }

    @Test("ios-pipelines/AC-10 : une adresse de PR ouvrable propose « ouvrir la PR »")
    func openPRWhenAddressPresent() {
        let c = card(column: .prOuverte, prUrl: "https://example.test/pull/1", action: action())
        #expect(PipelinesGesture.gestures(of: c).contains(.openPR))

        let invalid = card(column: .prOuverte, prUrl: "pas-une-adresse", action: action())
        #expect(!PipelinesGesture.gestures(of: invalid).contains(.openPR))
    }

    @Test("ios-pipelines/AC-11 : une PR ouverte avec slug et clé de dépôt propose « fusionner »")
    func mergeWhenSlugAndRepoKey() {
        let c = card(column: .prOuverte, prUrl: "https://example.test/pull/1", action: action())
        #expect(PipelinesGesture.gestures(of: c).contains(.merge))

        let noKey = card(
            column: .prOuverte,
            prUrl: "https://example.test/pull/1",
            action: action(repoKey: nil)
        )
        #expect(!PipelinesGesture.gestures(of: noKey).contains(.merge))
    }

    @Test("ios-pipelines/AC-1 : une carte d'historique n'offre aucun geste et dit pourquoi")
    func historyCardOffersNothing() {
        let c = card(column: .termineeSansPr, action: nil)
        #expect(PipelinesGesture.gestures(of: c).isEmpty)
        #expect(PipelinesGesture.motif(of: c) == KanbanText.noGesture)
    }
}
