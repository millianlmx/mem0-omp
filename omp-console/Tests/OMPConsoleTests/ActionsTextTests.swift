// Preuves des textes DÉRIVÉS d'un état (S-4, S-9) : les états du journal, les
// formes de ligne de journal et les motifs sont figés ici, sans rendre une vue.

import Foundation
import Testing
@testable import OMPConsole

private func entry(_ state: ActionJournalState, kind: String = "texte", target: String = "depot/alpha")
    -> ActionJournalEntry {
    ActionJournalEntry(id: "x", kindLabel: kind, targetLabel: target, state: state, at: 0)
}

@Test("reponses-et-jalons/AC-10 : les six états du journal ont leur texte exact")
func journalStatesAreFrozen() {
    #expect(ActionsText.stateText(.awaitingAck) == "en attente dans le canal")
    #expect(ActionsText.stateText(.taken) == "prise en charge")
    #expect(ActionsText.stateText(.refused(reason: nil)) == "refusée")
    #expect(ActionsText.stateText(.refused(reason: "sans objet : rien")) == "refusée : sans objet : rien")
    #expect(ActionsText.stateText(.delivered) == "déposé")
    #expect(ActionsText.stateText(.failed(reason: "écriture impossible (Permission denied)"))
        == "échec : écriture impossible (Permission denied)")
}

@Test("reponses-et-jalons/AC-10 : une ligne de journal est « libellé · cible · état »")
func journalLineIsFrozen() {
    #expect(ActionsText.journalLine(for: entry(.awaitingAck, kind: ActionsText.specsLabel, target: "alpha"))
        == "jalon specs · alpha · en attente dans le canal")
    #expect(ActionsText.journalLine(for: entry(.taken, kind: ActionsText.reviewLabel, target: "beta"))
        == "jalon revue · beta · prise en charge")
    #expect(ActionsText.journalLine(for: entry(.delivered, kind: ActionsText.answerLabel))
        == "réponse · depot/alpha · déposé")
    #expect(ActionsText.journalLine(for: entry(.delivered, kind: ActionsText.textLabel))
        == "texte · depot/alpha · déposé")
    #expect(ActionsText.journalLine(for: entry(.failed(reason: "échec x"), kind: ActionsText.launchLabel, target: "T"))
        == "lancement · T · échec : échec x")
    #expect(ActionsText.journalLine(for: entry(.awaitingAck, kind: ActionsText.stopLabel, target: "depot"))
        == "arrêt · depot · en attente dans le canal")
}

@Test("reponses-et-jalons/AC-10 : les motifs de la zone d'action sont figés")
func motifsAreFrozen() {
    #expect(ActionsText.notArmed("depot/alpha")
        == "Ce run (depot/alpha) n'accepte pas d'écriture : aucune boîte n'est publiée (run non armé).")
    #expect(ActionsText.noRepos() == "Aucun dépôt connu : aucun lot dans le magasin et aucun projet ouvert.")
}
