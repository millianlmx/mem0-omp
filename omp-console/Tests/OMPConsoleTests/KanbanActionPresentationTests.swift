// Preuves de l'AIGUILLAGE et du catalogue des dépôts (S-3, S-7) : les quatre cas
// de la règle, la liste d'options vide, « jamais les deux zones », et les options
// de lancement triées/dédupliquées.

import Foundation
import Testing
@testable import OMPConsole

private func card(_ action: KanbanCardAction?) -> KanbanCard {
    KanbanCard(
        id: "feature:x:alpha", column: .enCours, repo: "depot", title: "alpha", state: "en cours",
        phase: .impl, model: nil, prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: [],
        action: action
    )
}

private func action(
    run: KanbanCardRun?,
    slug: String? = "alpha",
    waitKind: LotWaitKind? = nil,
    featureState: LotFeatureState? = .running,
    repoRoot: String? = "/tmp/depot"
) -> KanbanCardAction {
    KanbanCardAction(
        repoRoot: repoRoot, slug: slug, waitKind: waitKind, featureState: featureState, run: run
    )
}

private let ask = PanelPendingAsk(
    toolCallId: "call-1", id: "q", question: "On garde ?",
    options: [PanelAskOption(label: "oui", description: "on garde"), PanelAskOption(label: "non", description: nil)]
)

// MARK: - la règle d'aiguillage (S-3)

@Test("reponses-et-jalons/AC-4 : une question en vol offre la réponse et JAMAIS le steer")
func pendingQuestionNeverSteers() {
    let run = KanbanCardRun(id: "r1", label: "depot/alpha", inbox: "/tmp/box", pendingAsk: ask)
    let zones = KanbanActionPresentation.zones(for: card(action(run: run, waitKind: nil)))

    #expect(zones.contains(.pendingQuestion(toolCallId: "call-1", question: "On garde ?", options: ask.options)))
    #expect(!zones.contains(.steer), "les deux voies ne coexistent jamais")
    #expect(KanbanActionPresentation.motif(for: card(action(run: run))) == nil)
}

@Test("reponses-et-jalons/AC-3 : un run vivant sans question n'offre QUE le steer")
func liveRunWithoutQuestionSteers() {
    let run = KanbanCardRun(id: "r1", label: "depot/alpha", inbox: "/tmp/box", pendingAsk: nil)
    // Une carte de RUN hors lot : aucun slug, aucun dépôt de lot — donc aucun arrêt.
    let zones = KanbanActionPresentation.zones(
        for: card(action(run: run, slug: nil, waitKind: nil, featureState: nil, repoRoot: nil))
    )

    #expect(zones == [.steer])
}

@Test("reponses-et-jalons/AC-10 : un run sans boîte publiée n'offre rien et dit pourquoi")
func unarmedRunHasMotif() {
    let run = KanbanCardRun(id: "r1", label: "depot/alpha", inbox: nil, pendingAsk: nil)
    let armed = card(action(run: run, slug: nil, waitKind: nil, featureState: nil, repoRoot: nil))

    #expect(KanbanActionPresentation.zones(for: armed).isEmpty)
    #expect(KanbanActionPresentation.motif(for: armed)
        == "Ce run (depot/alpha) n'accepte pas d'écriture : aucune boîte n'est publiée (run non armé).")
}

@Test("reponses-et-jalons/AC-4 : une carte sans run ni jalon ne porte aucun geste")
func cardWithoutRunHasNoGesture() {
    let bare = card(action(run: nil, slug: nil, waitKind: nil, featureState: nil, repoRoot: nil))
    #expect(KanbanActionPresentation.zones(for: bare).isEmpty)
    #expect(KanbanActionPresentation.motif(for: bare)
        == "Aucun geste depuis cette carte : elle ne porte ni run vivant ni jalon de lot.")

    let history = card(nil)
    #expect(KanbanActionPresentation.zones(for: history).isEmpty)
    #expect(KanbanActionPresentation.motif(for: history) == ActionsText.noGesture)
}

@Test("reponses-et-jalons/AC-5 : une feature en attente specs offre « Valider les specs »")
func waitingSpecsOffersMilestone() {
    let zones = KanbanActionPresentation.zones(
        for: card(action(run: nil, waitKind: .specs, featureState: .waiting, repoRoot: "/tmp/depot"))
    )
    #expect(zones.contains(.milestone(slug: "alpha", kind: .specs)))
    #expect(zones.contains(.stopLot(repoRoot: "/tmp/depot")))
}

@Test("reponses-et-jalons/AC-6 : une feature en attente de revue offre « Accepter la revue »")
func waitingReviewOffersAccept() {
    let zones = KanbanActionPresentation.zones(
        for: card(action(run: nil, waitKind: .review, featureState: .waiting, repoRoot: "/tmp/depot"))
    )
    #expect(zones.contains(.milestone(slug: "alpha", kind: .review)))
}

@Test("reponses-et-jalons/AC-5 : le jalon « answer » n'ouvre aucun bouton de verdict")
func answerMilestoneHasNoVerdictButton() {
    let zones = KanbanActionPresentation.zones(
        for: card(action(run: nil, waitKind: .answer, featureState: .waiting, repoRoot: "/tmp/depot"))
    )
    #expect(!zones.contains { if case .milestone = $0 { return true } else { return false } })
}

@Test("reponses-et-jalons/AC-8 : l'arrêt n'est offert qu'à une carte portant un LOT")
func stopRequiresALot() {
    let run = KanbanCardRun(id: "r1", label: "depot/run", inbox: "/tmp/box", pendingAsk: nil)
    let unmatched = card(action(run: run, slug: nil, waitKind: nil, featureState: nil, repoRoot: nil))
    #expect(KanbanActionPresentation.zones(for: unmatched) == [.steer], "aucun arrêt hors lot")
}

@Test("reponses-et-jalons/AC-1 : une question à zéro option reste posée, le champ libre seul")
func emptyOptionsStayAnswerable() {
    let askNoOptions = PanelPendingAsk(toolCallId: "call-2", id: "q", question: "Et alors ?", options: [])
    let run = KanbanCardRun(id: "r1", label: "depot/alpha", inbox: "/tmp/box", pendingAsk: askNoOptions)
    let zones = KanbanActionPresentation.zones(for: card(action(run: run, waitKind: nil)))
    #expect(zones.first == .pendingQuestion(toolCallId: "call-2", question: "Et alors ?", options: []))
    #expect(!zones.contains(.steer), "la question garde la main sur l'envoi libre")
}

// MARK: - le catalogue des dépôts (S-7)

@Test("reponses-et-jalons/AC-7 : les dépôts proposés sont dédupliqués, triés, projet ouvert compris")
func launchReposAreSortedAndDeduped() {
    let cards = [
        card(action(run: nil, repoRoot: "/tmp/beta")),
        card(action(run: nil, repoRoot: "/tmp/alpha")),
        card(action(run: nil, slug: nil, featureState: nil, repoRoot: "/tmp/beta")),
    ]
    #expect(KanbanLaunchRepos.options(cards: cards, projectRoot: "/tmp/gamma") == [
        "/tmp/alpha", "/tmp/beta", "/tmp/gamma",
    ])
    #expect(KanbanLaunchRepos.options(cards: cards, projectRoot: nil) == ["/tmp/alpha", "/tmp/beta"])
    #expect(KanbanLaunchRepos.options(cards: [], projectRoot: nil) == [])
}

@Test("reponses-et-jalons/AC-7 : le dépôt par défaut est celui de la carte, sinon le projet, sinon le premier")
func launchDefaultSelection() {
    let options = ["/tmp/alpha", "/tmp/beta"]
    #expect(KanbanLaunchRepos.defaultSelection(
        options: options, selectedRepoRoot: "/tmp/beta", projectRoot: "/tmp/alpha"
    ) == "/tmp/beta")
    #expect(KanbanLaunchRepos.defaultSelection(
        options: options, selectedRepoRoot: "/tmp/zzz", projectRoot: "/tmp/alpha"
    ) == "/tmp/alpha")
    #expect(KanbanLaunchRepos.defaultSelection(
        options: options, selectedRepoRoot: nil, projectRoot: nil
    ) == "/tmp/alpha")
    #expect(KanbanLaunchRepos.defaultSelection(options: [], selectedRepoRoot: nil, projectRoot: nil) == nil)
}
