// Preuves des compteurs (BR-3, S-1) : ils comptent l'ardoise que la fenêtre affiche,
// et rien d'autre — les deux catégories sont exclusives (AC-7, AC-8).

import Foundation
import Testing
@testable import OMPConsole
@testable import ConsoleCore

/// Le compte des cartes d'une colonne, tel que l'en-tête de la fenêtre l'écrit.
private func columnCount(_ board: KanbanBoard, _ column: KanbanColumn) -> Int {
    board.cards.filter { $0.column == column }.count
}

@Test("notifications-et-barre-de-menus/AC-7 : les deux compteurs égalent exactement les colonnes affichées")
func countersMatchDisplayedColumns() {
    let fixture = StoreFixture()
    let repoRoot = "/Users/millian/Experiments/mem0-omp"

    // Occupés : un run hors lot sans question.
    publishBusyRun(fixture, id: fixtureId(0x41))
    // En attente : une question en vol.
    publishPendingAnswer(fixture, id: fixtureId(0x42))
    // En attente : les deux jalons d'un lot.
    fixture.publish(
        .lots, "\(fixtureId(0x43)).json",
        object: lotObject(
            id: fixtureId(0x43), repoRoot: repoRoot,
            features: [
                lotFeatureObject(slug: "jalon-specs", state: "waiting", waitKind: "specs"),
                lotFeatureObject(slug: "jalon-revue", state: "waiting", waitKind: "review"),
            ]
        )
    )
    // Ni occupé ni en attente : une fusion de projet et une clôture.
    fixture.publish(
        .projects, "\(fixtureId(0x44)).json",
        object: projectObject(
            repoKey: fixtureId(0x44), repoRoot: repoRoot,
            segments: [["name": "S", "features": [projectFeatureObject(slug: "mergee", status: "merged")]]],
            current: 0
        )
    )
    fixture.publish(
        .history, "\(fixtureId(0x45)).json",
        object: historyObject(
            id: fixtureId(0x45), cwd: "/tmp/alerts/fini", label: "depot/fini",
            finalState: "done", phaseStartedAt: fixtureT0 - 9_000, endedAt: fixtureT0 - 1_000
        )
    )

    let board = kanbanBoard(fixture)
    let counters = RunCounters.of(board: board)
    // Chiffres explicites : un run occupé et trois attentes actionnables.
    #expect(counters.busy == 1)
    #expect(counters.waiting == 3)
    // Et EXACTEMENT ce que les colonnes affichent.
    #expect(counters.busy == columnCount(board, .enCours))
    #expect(counters.waiting == columnCount(board, .questionEnVol)
        + columnCount(board, .jalonSpecs) + columnCount(board, .jalonReview))
    // Exclusivité : aucune carte n'est comptée deux fois.
    #expect(counters.busy + counters.waiting
        == columnCount(board, .enCours) + columnCount(board, .questionEnVol)
            + columnCount(board, .jalonSpecs) + columnCount(board, .jalonReview))

    // La bande (S-9) et l'item de barre (S-2) lisent le MÊME état dérivé.
    #expect(AlertsStatus.from(boardState: kanbanState(fixture)).counters == counters)
}

@Test("notifications-et-barre-de-menus/AC-7 : la colonne « En attente » du Kanban n'est PAS le compteur d'attente")
func pendingColumnIsNotWaitingCounter() {
    let fixture = StoreFixture()
    // Une feature de lot `pending` (non lancée) tombe dans la colonne « En attente »
    // du tableau, mais n'est pas une attente actionnable.
    fixture.publish(
        .lots, "\(fixtureId(0x46)).json",
        object: lotObject(
            id: fixtureId(0x46),
            features: [lotFeatureObject(slug: "a-venir", state: "pending")]
        )
    )
    let board = kanbanBoard(fixture)
    #expect(columnCount(board, .enAttente) == 1)
    #expect(RunCounters.of(board: board) == .zero)
}

@Test("notifications-et-barre-de-menus/AC-8 : un magasin vide vaut zéro, un magasin absent n'a PAS de compteurs")
func emptyStoreIsZeroAbsentIsNil() {
    let fixture = StoreFixture()
    let emptyState = kanbanState(fixture)
    #expect(emptyState == .storeEmpty(dir: fixture.root))
    #expect(AlertsStatus.from(boardState: emptyState).counters == RunCounters.zero)

    // Racine absente : les compteurs valent `nil`, jamais `0 · 0`.
    let absent = StoreFixture(stores: [])
    let absentState = kanbanState(absent)
    #expect(absentState == .storeAbsent(dir: absent.root))
    #expect(AlertsStatus.from(boardState: absentState).counters == nil)
    #expect(AlertsStatus.from(boardState: absentState) == .storeAbsent(dir: absent.root))
    // `.loading` n'a pas non plus de compteurs.
    #expect(AlertsStatus.loading.counters == nil)
}
