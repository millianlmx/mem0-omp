// Preuves des textes DÉRIVÉS d'un état (S-4, S-9) : le motif du pilote passe tel
// quel dans le journal, et une ligne de journal se compose toujours
// « libellé · cible · état », sans rendre une vue.

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

private func entry(_ state: ActionJournalState, kind: String = "texte", target: String = "depot/alpha")
    -> ActionJournalEntry {
    ActionJournalEntry(id: "x", kindLabel: kind, targetLabel: target, state: state, at: 0)
}

@Test("reponses-et-jalons/AC-10 : un refus ou un échec garde son motif EXACT")
func journalReasonsAreVerbatim() {
    #expect(ActionsText.stateText(.refused(reason: nil)) == ActionsText.refused)
    #expect(ActionsText.stateText(.refused(reason: "sans objet : rien")) == "refusée : sans objet : rien")
    #expect(ActionsText.stateText(.failed(reason: "écriture impossible (Permission denied)"))
        == "échec : écriture impossible (Permission denied)")
}

@Test("reponses-et-jalons/AC-10 : une ligne de journal est « libellé · cible · état »")
func journalLineIsFrozen() {
    #expect(ActionsText.journalLine(for: entry(.awaitingAck, kind: ActionsText.specsLabel, target: "alpha"))
        == "\(ActionsText.specsLabel) · alpha · \(ActionsText.awaitingAck)")
    #expect(ActionsText.journalLine(for: entry(.taken, kind: ActionsText.reviewLabel, target: "beta"))
        == "\(ActionsText.reviewLabel) · beta · \(ActionsText.taken)")
    #expect(ActionsText.journalLine(for: entry(.failed(reason: "échec x"), kind: ActionsText.launchLabel, target: "T"))
        == "\(ActionsText.launchLabel) · T · échec : échec x")
}
