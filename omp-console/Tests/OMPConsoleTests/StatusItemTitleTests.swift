// Preuves de l'item de barre de menus (S-6, S-7 de accueil-en-cours-melange-pause-et-compte) :
// son TITRE et son RÉSUMÉ sont des fonctions pures de l'état publié, calculées avec
// les listes « À vous » et « En cours » de l'Accueil ; et la vie de l'app après
// fermeture de la fenêtre est un retour de délégué directement testable.
//
// Aucun `NSStatusBar` n'est construit ici : mesuré (Doc-9), l'instancier tue un
// processus de test. `StatusItemController` se borne à recopier `title`, `toolTip`
// et `setAccessibilityLabel` ; ce câblage est prouvé par lecture AX dans la recette.

import AppKit
import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// L'état publié de l'item pour une ardoise, comme `AlertsModel` le calcule.
private func status(_ board: KanbanBoardState) -> AlertsStatus {
    AlertsStatus.from(boardState: board)
}

private func unwrap(_ state: KanbanBoardState) -> KanbanBoard {
    guard case .board(let board) = state else {
        Issue.record("ardoise attendue, reçu \(state)")
        return KanbanBoard(cards: [], anomalies: [])
    }
    return board
}

/// Une ardoise dérivée du magasin réel : un lot VIVANT (propriétaire = ce
/// processus) dont la feature `bascule` est dans l'état `state`, à côté d'une
/// feature déjà bloquée et d'une feature en marche qui ne changent pas.
private func liveLotBoard(basculeState state: String) -> KanbanBoardState {
    let fixture = StoreFixture()
    fixture.publish(
        .lots, "\(fixtureId(0x71)).json",
        object: lotObject(
            id: fixtureId(0x71),
            features: [
                lotFeatureObject(slug: "deja-bloquee", state: "blocked", phase: "specs"),
                lotFeatureObject(slug: "stable", state: "running", phase: "impl"),
                lotFeatureObject(slug: "bascule", state: state, phase: "impl"),
            ]
        )
    )
    return kanbanState(fixture)
}

// MARK: - AC-5 / AC-6 : un seul chiffre, celui d'« À vous »

@Test("accueil-en-cours-melange-pause-et-compte/AC-5 : 1 ligne « À vous » et 2 « En cours » ⇒ l'item affiche « 1 », jamais « a·b »")
func menuBarTitleIsAttentionCount() {
    let board = HomeParity.menuBarBoard
    let dashboard = HomePresentation.dashboard(unwrap(board))
    #expect(dashboard.attention.count == 1)
    #expect(dashboard.running.count == 2)
    #expect(StatusItemTitle.text(for: status(board)) == "1")

    // Les autres comptes de l'Accueil : le titre est toujours « À vous » seul.
    #expect(StatusItemTitle.text(for: status(HomeParity.board)) == "5")
    #expect(StatusItemTitle.text(for: .ready(HomeCounts(attention: 12, running: 4))) == "12")
    #expect(StatusItemTitle.text(for: .ready(HomeCounts(attention: 3, running: 0))) == "3")
    // L'ancienne forme « occupés·en attente » ne sort plus jamais.
    for counts in [HomeCounts(attention: 1, running: 2), HomeCounts(attention: 0, running: 7), HomeCounts(attention: 9, running: 9)] {
        #expect(!StatusItemTitle.text(for: .ready(counts)).contains("\u{00B7}"))
    }
}

@Test("accueil-en-cours-melange-pause-et-compte/AC-6 : aucune ligne « À vous », seulement des pauses ou des features pas commencées ⇒ icône seule")
func menuBarTitleIsEmptyWithoutAttention() {
    let board = HomeParity.pausedOnlyBoard
    let dashboard = HomePresentation.dashboard(unwrap(board))
    #expect(!dashboard.paused.isEmpty)
    #expect(!dashboard.notStarted.isEmpty)
    #expect(StatusItemTitle.text(for: status(board)) == "")

    // Des pipelines en cours sans rien « À vous » : icône seule aussi.
    #expect(StatusItemTitle.text(for: .ready(HomeCounts(attention: 0, running: 2))) == "")
    // Rien de connu, ou magasin absent : icône seule.
    #expect(StatusItemTitle.text(for: .loading) == "")
    #expect(StatusItemTitle.text(for: .storeAbsent(dir: "/tmp/magasin")) == "")
    #expect(StatusItemTitle.text(for: .ready(.zero)) == "")
}

// MARK: - AC-7 : le chiffre augmente avec « À vous », sur le même instantané

@Test("accueil-en-cours-melange-pause-et-compte/AC-7 : une feature en marche passe en échec ⇒ « À vous » et le chiffre de l'item augmentent de un ensemble")
func menuBarTitleFollowsAttentionOnFailure() {
    let before = liveLotBoard(basculeState: "running")
    let after = liveLotBoard(basculeState: "failed")

    let attentionBefore = HomePresentation.dashboard(unwrap(before)).attention.count
    let attentionAfter = HomePresentation.dashboard(unwrap(after)).attention.count
    #expect(attentionBefore == 1)
    #expect(attentionAfter == attentionBefore + 1)
    #expect(HomePresentation.dashboard(unwrap(after)).attention.map(\.nature).contains(.failed))

    // Le chiffre suit, calculé par la même fonction sur le même instantané.
    #expect(StatusItemTitle.text(for: status(before)) == "\(attentionBefore)")
    #expect(StatusItemTitle.text(for: status(after)) == "\(attentionAfter)")
    // La feature a quitté « En cours » : le résumé le dit aussi.
    #expect(StatusItemTitle.summary(for: status(before)) == "1 à vous · 2 en cours")
    #expect(StatusItemTitle.summary(for: status(after)) == "2 à vous · 1 en cours")
}

// MARK: - AC-8 / AC-9 : info-bulle et description VoiceOver

@Test("accueil-en-cours-melange-pause-et-compte/AC-8 : 1 ligne « À vous » et 2 « En cours » ⇒ info-bulle et description « 1 à vous · 2 en cours »")
func menuBarSummaryNamesAttentionAndRunning() {
    #expect(StatusItemTitle.summary(for: status(HomeParity.menuBarBoard)) == "1 à vous · 2 en cours")
    // Point médian U+00B7 entouré d'espaces, mots en minuscules (ceux des sections).
    #expect(HomeText.countsSummary(HomeCounts(attention: 1, running: 2)) == "1 à vous \u{00B7} 2 en cours")
    #expect(StatusItemTitle.summary(for: status(HomeParity.board)) == "5 à vous · 2 en cours")
}

@Test("accueil-en-cours-melange-pause-et-compte/AC-9 : seulement des pauses ⇒ « 0 à vous · 0 en cours », zéros écrits, pauses non comptées")
func menuBarSummaryWritesZeros() {
    let board = HomeParity.pausedOnlyBoard
    #expect(!HomePresentation.dashboard(unwrap(board)).paused.isEmpty)
    #expect(StatusItemTitle.summary(for: status(board)) == "0 à vous · 0 en cours")
    // État inconnu ou magasin absent : deux zéros, jamais une chaîne vide.
    #expect(StatusItemTitle.summary(for: .loading) == "0 à vous · 0 en cours")
    #expect(StatusItemTitle.summary(for: .storeAbsent(dir: "/tmp/magasin")) == "0 à vous · 0 en cours")
}

// MARK: - Fermer la fenêtre ne quitte pas l'app

@MainActor
@Test("notifications-et-barre-de-menus/AC-9 : fermer la dernière fenêtre ne termine pas l'app (⌘Q seul quitte)")
func closingLastWindowDoesNotTerminate() {
    // Le retour du délégué est directement exécutable dans un processus de test
    // (mesuré, Doc-9) : `false` = l'app reste vivante, l'item de barre demeure.
    let delegate = AppDelegate()
    #expect(delegate.applicationShouldTerminateAfterLastWindowClosed(NSApplication.shared) == false)
}
