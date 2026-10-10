// Preuves de l'état publié de l'item de barre de menus (S-6 de
// accueil-en-cours-melange-pause-et-compte) : il compte les listes « À vous » et
// « En cours » de l'Accueil, et rien d'autre ; « magasin vide » et « magasin
// absent » restent deux états distincts.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

@Test("accueil-en-cours-melange-pause-et-compte/AC-5 : sur une ardoise, l'état publié porte exactement HomePresentation.counts (les listes de l'Accueil)")
func alertsStatusCountsTheHomeLists() {
    let fixture = StoreFixture()
    // « À vous » : une question en vol.
    publishPendingAnswer(fixture, id: fixtureId(0x61))
    // « En cours » : un run hors lot sans question.
    publishBusyRun(fixture, id: fixtureId(0x62))
    // « Pas commencées » : une feature de lot `pending`, jamais comptée.
    fixture.publish(
        .lots, "\(fixtureId(0x63)).json",
        object: lotObject(id: fixtureId(0x63), features: [lotFeatureObject(slug: "a-venir", state: "pending")])
    )

    let state = kanbanState(fixture)
    guard case .board(let board) = state else {
        Issue.record("ardoise attendue, reçu \(state)")
        return
    }
    let dashboard = HomePresentation.dashboard(board)
    #expect(dashboard.notStarted.map(\.action?.slug) == ["a-venir"])
    #expect(AlertsStatus.from(boardState: state) == .ready(HomeCounts(attention: 1, running: 1)))
    #expect(AlertsStatus.from(boardState: state).counts
        == HomeCounts(attention: dashboard.attention.count, running: dashboard.running.count))
}

@Test("accueil-en-cours-melange-pause-et-compte/AC-6 : un magasin vide vaut zéro, un magasin absent ou un état initial n'ont PAS de comptes")
func emptyStoreIsZeroAbsentIsNil() {
    let fixture = StoreFixture()
    let emptyState = kanbanState(fixture)
    #expect(emptyState == .storeEmpty(dir: fixture.root))
    #expect(AlertsStatus.from(boardState: emptyState) == .ready(.zero))
    #expect(AlertsStatus.from(boardState: emptyState).counts == HomeCounts.zero)

    // Racine absente : `nil`, jamais deux zéros.
    let absent = StoreFixture(stores: [])
    let absentState = kanbanState(absent)
    #expect(absentState == .storeAbsent(dir: absent.root))
    #expect(AlertsStatus.from(boardState: absentState) == .storeAbsent(dir: absent.root))
    #expect(AlertsStatus.from(boardState: absentState).counts == nil)
    #expect(AlertsStatus.loading.counts == nil)
    #expect(AlertsStatus.from(boardState: .loading) == .loading)
}
