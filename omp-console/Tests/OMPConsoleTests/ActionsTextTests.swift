// Preuves des TEXTES de l'action (S-4, S-9) : chaque libellé et chaque forme de
// ligne de journal sont figés ici, sans rendre une vue.

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

@Test("reponses-et-jalons/AC-1 : les textes de la zone d'action sont figés")
func actionTextsAreFrozen() {
    #expect(ActionsText.launchToggle == "Lancer une feature…")
    #expect(ActionsText.questionTitle == "Question en vol")
    #expect(ActionsText.answerFieldPlaceholder == "ou saisissez votre réponse")
    #expect(ActionsText.answer == "Répondre")
    #expect(ActionsText.steerTitle == "Envoyer un texte à ce run")
    #expect(ActionsText.steerFieldLabel == "Votre message")
    #expect(ActionsText.send == "Envoyer")
    #expect(ActionsText.validate == "Valider les specs")
    #expect(ActionsText.accept == "Accepter la revue")
    #expect(ActionsText.stop == "Arrêter le lot")
    #expect(ActionsText.journalTitle == "Gestes")
    #expect(ActionsText.journalEmpty == "Aucun geste pour l'instant.")
    #expect(ActionsText.titleLabel == "Titre")
    #expect(ActionsText.descriptionLabel == "Description")
    #expect(ActionsText.repoLabel == "Dépôt")
    #expect(ActionsText.submit == "Lancer")
    #expect(ActionsText.cancel == "Annuler")
}

@Test("reponses-et-jalons/AC-10 : les motifs de la zone d'action sont figés")
func motifsAreFrozen() {
    #expect(ActionsText.notArmed("depot/alpha")
        == "Ce run (depot/alpha) n'accepte pas d'écriture : aucune boîte n'est publiée (run non armé).")
    #expect(ActionsText.noGesture
        == "Aucun geste depuis cette carte : elle ne porte ni run vivant ni jalon de lot.")
    #expect(ActionsText.noRepos() == "Aucun dépôt connu : aucun lot dans le magasin et aucun projet ouvert.")
}
