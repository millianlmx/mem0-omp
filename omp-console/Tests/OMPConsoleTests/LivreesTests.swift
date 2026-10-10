// Preuves de la voie « Livrées » (pipelines-livrees-statut-pr-faux-et-doub,
// lot BR-1) : le libellé d'une carte livrée avec PR suit le FAIT GitHub (S-2),
// les clôtures de `history/` se rattachent à leur feature (S-3) et les
// livraisons closes depuis plus de 7 jours quittent l'ardoise (S-4, S-8).
//
// Tout passe par `KanbanBoardState.derive` — la dérivation que partagent le Mac
// et l'app iOS — sur un magasin de fixtures RÉEL, avec des faits de PR explicites
// et une horloge FIXE.

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

/// L'instant FIXE de la lecture.
private let livreesNow: Double = 1_800_000_000_000
private let dayMs: Double = 86_400_000
private let livreesRepo = "/tmp/livrees/mem0-omp"

/// Une feature de lot TERMINÉE, close à `endedAt`, avec ou sans URL de PR.
private func doneFeature(_ slug: String, prUrl: String? = nil, endedAt: Double, worktree: String? = nil) -> [String: Any] {
    lotFeatureObject(slug: slug, state: "done", phase: "release", worktree: worktree, prUrl: prUrl, endedAt: endedAt)
}

/// Publie un lot portant `features` dans le dépôt de la suite.
private func publishLot(_ fixture: StoreFixture, _ features: [[String: Any]]) {
    let repoKey = KanbanRepoKey.key(forRoot: livreesRepo)
    fixture.publish(.lots, "\(repoKey).json", object: lotObject(id: repoKey, repoRoot: livreesRepo, features: features))
}

private func featureID(_ slug: String) -> String {
    "feature:\(KanbanRepoKey.key(forRoot: livreesRepo)):\(slug)"
}

private func merged(_ url: String, at closedAtMs: Double?) -> PullRequestFact {
    PullRequestFact(url: url, state: .merged, closedAtMs: closedAtMs)
}

/// L'état de l'ardoise à l'instant fixe.
private func livrees(_ fixture: StoreFixture, _ facts: [PullRequestFact] = []) -> KanbanBoardState {
    kanbanState(fixture, nowMs: livreesNow, prFacts: PullRequestFacts.index(facts))
}

/// Les cartes de la voie « Livrées ».
private func deliveredLane(_ state: KanbanBoardState) -> [KanbanCard] {
    state.kanbanBoard?.lanes.first { $0.lane == .livrees }?.cards ?? []
}

@Suite("pipelines-livrees-statut-pr-faux-et-doub (ardoise partagée)")
struct LivreesTests {
    // MARK: - S-2 : le libellé suit l'état GitHub

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-1 : une PR fusionnée porte « PR fusionnée », jamais « PR ouverte »")
    func mergedPullRequestReadsMerged() throws {
        let fixture = StoreFixture()
        let url = "https://github.com/o/r/pull/1"
        let stale = "https://github.com/o/r/pull/2"
        // La pipeline a fini il y a des semaines ; la PR a été fusionnée.
        publishLot(fixture, [
            doneFeature("fusion-recente", prUrl: url, endedAt: livreesNow - 21 * dayMs),
            doneFeature("fusion-ancienne", prUrl: stale, endedAt: livreesNow - 30 * dayMs),
        ])
        let state = livrees(fixture, [
            merged(url, at: livreesNow - 2 * dayMs),
            merged(stale, at: livreesNow - 21 * dayMs),
        ])

        let card = try #require(state.card(featureID("fusion-recente")))
        #expect(card.column == .fusionne)
        #expect(ConsoleStatus.of(card: card) == ConsoleStatus(text: "PR fusionnée", tone: .success))
        #expect(deliveredLane(state).map(\.id).contains(card.id))
        // Fusionnée depuis des semaines : la borne des 7 jours la retire (S-4),
        // aucune carte « Livrées » ne la montre donc « PR ouverte ».
        #expect(state.card(featureID("fusion-ancienne")) == nil)
        #expect(!deliveredLane(state).contains { ConsoleStatus.of(card: $0).text == "PR ouverte" })
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-2 : une PR fermée sans fusion porte « PR fermée »")
    func closedPullRequestReadsClosed() throws {
        let fixture = StoreFixture()
        let url = "https://github.com/o/r/pull/3"
        publishLot(fixture, [doneFeature("fermee", prUrl: url, endedAt: livreesNow - 3 * dayMs)])
        let state = livrees(fixture, [PullRequestFact(url: url, state: .closed, closedAtMs: livreesNow - dayMs)])

        let card = try #require(state.card(featureID("fermee")))
        #expect(card.column == .prFermee)
        #expect(KanbanLane.of(card) == .livrees)
        #expect(ConsoleStatus.of(card: card) == ConsoleStatus(text: "PR fermée", tone: .neutral))
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-3 : une PR encore ouverte porte « PR ouverte »")
    func openPullRequestReadsOpen() throws {
        let fixture = StoreFixture()
        let url = "https://github.com/o/r/pull/4"
        publishLot(fixture, [doneFeature("ouverte", prUrl: url, endedAt: livreesNow - dayMs)])
        let state = livrees(fixture, [PullRequestFact(url: url, state: .open, closedAtMs: nil)])

        let card = try #require(state.card(featureID("ouverte")))
        #expect(card.column == .prOuverte)
        #expect(ConsoleStatus.of(card: card) == ConsoleStatus(text: "PR ouverte", tone: .success))
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-4 : sans état GitHub lisible, la carte porte « PR créée »")
    func unknownPullRequestReadsCreated() throws {
        let fixture = StoreFixture()
        let lotUrl = "https://github.com/o/r/pull/5"
        let projectUrl = "https://github.com/o/r/pull/6"
        publishLot(fixture, [doneFeature("inconnue", prUrl: lotUrl, endedAt: livreesNow - dayMs)])
        // Une feature de projet `pr` seule : même règle, aucun fait ⇒ « PR créée ».
        let projectKey = KanbanRepoKey.key(forRoot: "/tmp/livrees/autre")
        fixture.publish(.projects, "\(projectKey).json", object: projectObject(
            repoKey: projectKey, repoRoot: "/tmp/livrees/autre",
            segments: [["name": "S", "features": [projectFeatureObject(slug: "pr-projet", status: "pr", prUrl: projectUrl)]]],
            current: 0
        ))
        // Un fait pour une AUTRE URL ne touche pas ces cartes.
        let state = livrees(fixture, [merged("https://github.com/o/r/pull/999", at: livreesNow)])

        let lotCard = try #require(state.card(featureID("inconnue")))
        let projectCard = try #require(state.card("project:\(projectKey):pr-projet"))
        for card in [lotCard, projectCard] {
            #expect(card.column == .prCreee)
            let status = ConsoleStatus.of(card: card)
            #expect(status == ConsoleStatus(text: "PR créée", tone: .neutral))
            #expect(status.text != "PR ouverte" && status.text != "PR fusionnée")
            #expect(KanbanLane.of(card) == .livrees)
        }
    }

    // MARK: - S-3 : les clôtures rattachées à leur feature

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-6 : les 10 clôtures d'une feature de lot ne font aucune carte à part")
    func historyClosuresJoinTheirFeature() throws {
        let fixture = StoreFixture()
        let slug = "ios-erreurs-serveur-lisibles"
        let worktreeName = "mem0-omp-d0ef9a5/\(slug)"
        // Le worktree RÉEL côté lot, le chemin BRUT (lien `/var` → `/private/var`
        // sous macOS) côté clôtures : le rattachement passe par `realpath`.
        let worktree = makeDirectory(fixture, worktreeName)
        let rawWorktree = joinPath(fixture.root, worktreeName)
        let url = "https://github.com/o/r/pull/104"
        publishLot(fixture, [doneFeature(slug, prUrl: url, endedAt: livreesNow - dayMs, worktree: worktree)])
        for index in 0..<10 {
            fixture.publish(.history, "\(fixtureId(0x600 + index)).json", object: historyObject(
                id: fixtureId(0x600 + index), cwd: index.isMultiple(of: 2) ? rawWorktree : worktree,
                label: "mem0-omp/\(slug)", finalState: "done",
                phaseStartedAt: livreesNow - Double(20 - index) * 3_600_000,
                endedAt: livreesNow - Double(19 - index) * 3_600_000
            ))
        }
        let state = livrees(fixture, [PullRequestFact(url: url, state: .open, closedAtMs: nil)])
        let board = try #require(state.kanbanBoard)

        let carrying = board.cards.filter { KanbanCardPresentation.title($0) == slug }
        #expect(carrying.count == 1)
        #expect(carrying.first?.id == featureID(slug))
        #expect(!board.cards.contains { $0.id.hasPrefix("history:") })
        #expect(!board.cards.contains { $0.title == "mem0-omp/\(slug)" })
        // Les dix clôtures sont des SOURCES de la carte, la plus récente d'abord.
        let card = try #require(carrying.first)
        let historyRefs = card.sources.filter { $0.kind == .history }.map(\.ref)
        #expect(historyRefs == (0..<10).reversed().map { "history/\(fixtureId(0x600 + $0)).json" })
        #expect(card.sources.first?.kind == .lot)
        #expect(ConsoleStatus.of(card: card).text == "PR ouverte")
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-7 : une feature réduite à ses clôtures fait UNE carte « Terminée », la plus récente")
    func orphanClosuresMakeOneCard() throws {
        let fixture = StoreFixture()
        let cwd = makeDirectory(fixture, "orpheline")
        let endings = [livreesNow - 3 * dayMs, livreesNow - dayMs, livreesNow - 2 * dayMs]
        for (index, endedAt) in endings.enumerated() {
            fixture.publish(.history, "\(fixtureId(0x700 + index)).json", object: historyObject(
                id: fixtureId(0x700 + index), cwd: cwd, label: "mem0-omp/orpheline", finalState: "done",
                phaseStartedAt: endedAt - 60_000, endedAt: endedAt
            ))
        }
        let board = try #require(livrees(fixture).kanbanBoard)

        #expect(board.cards.count == 1)
        let card = try #require(board.cards.first)
        #expect(card.id == "history:\(fixtureId(0x701))")
        #expect(card.column == .termineeSansPr)
        #expect(ConsoleStatus.of(card: card).text == "Terminée")
        #expect(card.endMs == livreesNow - dayMs)
        #expect(card.sources.map(\.ref) == [0x701, 0x702, 0x700].map { "history/\(fixtureId($0)).json" })
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-7 : la clôture la plus récente en échec donne une seule carte « Échec »")
    func orphanClosuresEndingInFailureMakeOneFailedCard() throws {
        let fixture = StoreFixture()
        let cwd = makeDirectory(fixture, "orpheline-echouee")
        fixture.publish(.history, "\(fixtureId(0x710)).json", object: historyObject(
            id: fixtureId(0x710), cwd: cwd, label: "mem0-omp/orpheline-echouee", finalState: "done",
            phaseStartedAt: livreesNow - 2 * dayMs, endedAt: livreesNow - 2 * dayMs + 1_000
        ))
        fixture.publish(.history, "\(fixtureId(0x711)).json", object: historyObject(
            id: fixtureId(0x711), cwd: cwd, label: "mem0-omp/orpheline-echouee", finalState: "failed",
            phaseStartedAt: livreesNow - dayMs, endedAt: livreesNow - dayMs + 1_000
        ))
        let board = try #require(livrees(fixture).kanbanBoard)

        #expect(board.cards.map(\.id) == ["history:\(fixtureId(0x711))"])
        #expect(board.cards.first?.column == .echec)
        #expect(!board.cards.contains { $0.column == .termineeSansPr })
    }

    // MARK: - S-4 et S-8 : la borne de 7 jours

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-8 : une PR fusionnée il y a 8 jours quitte « Livrées » et l'Accueil")
    func mergedEightDaysAgoIsGone() throws {
        let fixture = StoreFixture()
        let url = "https://github.com/o/r/pull/8"
        let keptUrl = "https://github.com/o/r/pull/9"
        publishLot(fixture, [
            doneFeature("fusion-8j", prUrl: url, endedAt: livreesNow - 9 * dayMs),
            doneFeature("ouverte", prUrl: keptUrl, endedAt: livreesNow - 9 * dayMs),
        ])
        let state = livrees(fixture, [
            merged(url, at: livreesNow - 8 * dayMs),
            PullRequestFact(url: keptUrl, state: .open, closedAtMs: nil),
        ])
        let board = try #require(state.kanbanBoard)

        #expect(state.card(featureID("fusion-8j")) == nil)
        #expect(!deliveredLane(state).contains { $0.id == featureID("fusion-8j") })
        #expect(!HomePresentation.dashboard(board).delivered.contains { $0.id == featureID("fusion-8j") })
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-9 : fusionnée hier, pipeline finie il y a 3 semaines : visible « PR fusionnée »")
    func mergedYesterdayStaysDespiteOldPipeline() throws {
        let fixture = StoreFixture()
        let url = "https://github.com/o/r/pull/10"
        publishLot(fixture, [doneFeature("fusion-hier", prUrl: url, endedAt: livreesNow - 21 * dayMs)])
        let state = livrees(fixture, [merged(url, at: livreesNow - dayMs)])
        let board = try #require(state.kanbanBoard)

        let card = try #require(deliveredLane(state).first { $0.id == featureID("fusion-hier") })
        #expect(ConsoleStatus.of(card: card).text == "PR fusionnée")
        let home = HomePresentation.dashboard(board).delivered
        #expect(home.map(\.id) == [featureID("fusion-hier")])
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-10 : une livraison sans PR part après 7 jours, reste avant")
    func deliveryWithoutPullRequestFollowsTheWindow() throws {
        let fixture = StoreFixture()
        publishLot(fixture, [
            doneFeature("sans-pr-8j", endedAt: livreesNow - 8 * dayMs),
            doneFeature("sans-pr-2j", endedAt: livreesNow - 2 * dayMs),
        ])
        let state = livrees(fixture)

        #expect(state.card(featureID("sans-pr-8j")) == nil)
        let kept = try #require(state.card(featureID("sans-pr-2j")))
        #expect(kept.column == .termineeSansPr)
        #expect(deliveredLane(state).map(\.id) == [featureID("sans-pr-2j")])
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-11 : « PR ouverte » et « PR créée » restent quel que soit leur âge")
    func openAndUnknownStayForever() throws {
        let fixture = StoreFixture()
        let openUrl = "https://github.com/o/r/pull/11"
        let unknownUrl = "https://github.com/o/r/pull/12"
        publishLot(fixture, [
            doneFeature("ouverte-30j", prUrl: openUrl, endedAt: livreesNow - 30 * dayMs),
            doneFeature("creee-30j", prUrl: unknownUrl, endedAt: livreesNow - 30 * dayMs),
        ])
        let state = livrees(fixture, [PullRequestFact(url: openUrl, state: .open, closedAtMs: nil)])

        let lane = deliveredLane(state)
        #expect(Set(lane.map(\.id)) == [featureID("ouverte-30j"), featureID("creee-30j")])
        #expect(Set(lane.map { ConsoleStatus.of(card: $0).text }) == ["PR ouverte", "PR créée"])
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-12 : une « PR créée » ancienne disparaît quand GitHub la révèle fusionnée il y a plus de 7 jours")
    func unknownThenMergedLongAgoDisappears() throws {
        let fixture = StoreFixture()
        let url = "https://github.com/o/r/pull/13"
        publishLot(fixture, [doneFeature("revelee", prUrl: url, endedAt: livreesNow - 12 * dayMs)])

        let before = livrees(fixture)
        let card = try #require(before.card(featureID("revelee")))
        #expect(ConsoleStatus.of(card: card).text == "PR créée")

        let after = livrees(fixture, [merged(url, at: livreesNow - 10 * dayMs)])
        #expect(after.card(featureID("revelee")) == nil)
        // La seule carte de l'ardoise est partie : l'ardoise est vide.
        #expect(after == .storeEmpty(dir: fixture.root))
    }

    // MARK: - S-4 : cas limites de la borne

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-8 : exactement 7 jours reste, une date future reste")
    func windowBoundaries() throws {
        let fixture = StoreFixture()
        let exactUrl = "https://github.com/o/r/pull/14"
        let futureUrl = "https://github.com/o/r/pull/15"
        publishLot(fixture, [
            doneFeature("pile-7j", prUrl: exactUrl, endedAt: livreesNow - 20 * dayMs),
            doneFeature("futur", prUrl: futureUrl, endedAt: livreesNow - 20 * dayMs),
            doneFeature("sans-pr-7j", endedAt: livreesNow - KanbanBoard.deliveredWindowMs),
            doneFeature("sans-pr-7j-1ms", endedAt: livreesNow - KanbanBoard.deliveredWindowMs - 1),
        ])
        let state = livrees(fixture, [
            merged(exactUrl, at: livreesNow - KanbanBoard.deliveredWindowMs),
            merged(futureUrl, at: livreesNow + dayMs),
        ])

        #expect(KanbanBoard.deliveredWindowMs == 7 * dayMs)
        #expect(state.card(featureID("pile-7j"))?.column == .fusionne)
        #expect(state.card(featureID("futur"))?.column == .fusionne)
        #expect(state.card(featureID("sans-pr-7j"))?.column == .termineeSansPr)
        #expect(state.card(featureID("sans-pr-7j-1ms")) == nil)
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-9 : sans date GitHub, la fin de pipeline puis la date du projet servent de référence")
    func referenceFallsBackToPipelineThenProject() throws {
        let fixture = StoreFixture()
        let undatedUrl = "https://github.com/o/r/pull/16"
        publishLot(fixture, [doneFeature("fusion-non-datee", prUrl: undatedUrl, endedAt: livreesNow - 9 * dayMs)])
        // Deux features de projet `merged` sans fait : leur seule date est
        // `updatedAt`, l'une récente, l'autre ancienne.
        let projectKey = KanbanRepoKey.key(forRoot: "/tmp/livrees/projet")
        fixture.publish(.projects, "\(projectKey).json", object: projectObject(
            repoKey: projectKey, repoRoot: "/tmp/livrees/projet",
            segments: [["name": "S", "features": [
                projectFeatureObject(slug: "recente", status: "merged", updatedAt: livreesNow - dayMs),
                projectFeatureObject(slug: "ancienne", status: "merged", updatedAt: livreesNow - 9 * dayMs),
            ]]],
            current: 0
        ))
        let state = livrees(fixture, [merged(undatedUrl, at: nil)])

        #expect(state.card(featureID("fusion-non-datee")) == nil)
        #expect(state.card("project:\(projectKey):recente")?.column == .fusionne)
        #expect(state.card("project:\(projectKey):ancienne") == nil)
    }
}
