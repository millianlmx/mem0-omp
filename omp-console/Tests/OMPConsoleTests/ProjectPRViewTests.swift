// Preuves du volet « PR et CI » (BR-3) : les textes EXACTS et les dérivations pures.
// Aucune fenêtre n'est ouverte — les textes sont des constantes pures.

import Foundation
import Testing

@testable import OMPConsole

@MainActor
@Test("suivi-pr-ci/AC-1 : les textes exacts du volet « PR et CI »")
func prPaneTextsAreExact() {
    // Le message de lecture préfixe le `userMessage` d'une GhError (S-7).
    #expect(
        ProjectViewText.prUnavailable("gh est introuvable")
            == "Statuts indisponibles : gh est introuvable"
    )
}

@MainActor
@Test("suivi-pr-ci/AC-3 : les textes d'ouverture d'une PR")
func prOpenTextsAreExact() {
    #expect(
        ProjectViewText.prNotOpenable(url: "issoir-1 pane")
            == "L'adresse de cette PR n'est pas ouvrable dans un navigateur : issoir-1 pane."
    )
    #expect(
        ProjectViewText.prOpenFailed(number: 45)
            == "L'ouverture de la PR #45 dans le navigateur a échoué."
    )
}

@MainActor
@Test("suivi-pr-ci/AC-5 : les textes de refus et de confirmation de fusion")
func prMergeTextsAreExact() {
    #expect(
        ProjectViewText.prMergeRefused(number: 45)
            == "Fusion refusée : les trois statuts requis ne sont pas verts (PR #45)."
    )
    #expect(
        ProjectViewText.prMergeRejected(detail: "la branche a divergé", number: 45)
            == "Fusion refusée par GitHub : la branche a divergé (PR #45)."
    )
    #expect(ProjectViewText.prMergeConfirmTitle(number: 45) == "Fusionner la PR #45 ?")
    #expect(
        ProjectViewText.prMergeConfirmMessage(title: "Ma PR")
            == "Ma PR — les trois statuts requis sont verts."
    )
}

@Test("suivi-pr-ci/AC-1 : la ligne d'un statut a ses quatre états en toutes lettres")
func checkLineHasFourStates() {
    #expect(ProjectViewText.prCheckLine(name: "check (ubuntu-latest)", state: PRCheckState.green.label)
        == "check (ubuntu-latest) : vert")
    #expect(ProjectViewText.prCheckLine(name: "check (macos-latest)", state: PRCheckState.red.label)
        == "check (macos-latest) : rouge")
    #expect(ProjectViewText.prCheckLine(name: "release-simulation", state: PRCheckState.pending.label)
        == "release-simulation : en cours")
    #expect(ProjectViewText.prCheckLine(name: "release-simulation", state: PRCheckState.ignored.label)
        == "release-simulation : ignoré")
}

@Test("suivi-pr-ci/AC-1 : `headline` a ses trois formes")
func headlineFormsAreExact() {
    func row(number: Int?, title: String?) -> ProjectPRRow {
        ProjectPRRow(
            slug: "a",
            number: number,
            title: title,
            url: "https://exemple.test/pull/45",
            checks: [],
            freshness: .unknown
        )
    }
    #expect(row(number: 45, title: "Un titre").headline == "PR #45 — Un titre")
    #expect(row(number: 45, title: nil).headline == "PR #45")
    #expect(row(number: nil, title: nil).headline == "https://exemple.test/pull/45")
}
