// TOUS les textes de l'action depuis le Kanban, en UN endroit (convention
// `FilesText`, Files/FilesText.swift:9) : un message à un seul endroit, c'est ce
// qui permet à un test de le figer sans rendre une vue, et à la vue de ne jamais
// composer une phrase.
//
// Le journal (S-4) se compose ICI, en une fonction pure : la vue affiche la ligne
// rendue, elle ne l'assemble pas.

import Foundation

enum ActionsText {
    // --- libellés des gestes (la première colonne d'une ligne de journal) -----
    static let answerLabel = "réponse"
    static let textLabel = "texte"
    static let specsLabel = "jalon specs"
    static let reviewLabel = "jalon revue"
    static let launchLabel = "lancement"
    static let stopLabel = "arrêt"

    // --- états du journal (S-4) ----------------------------------------------
    static let awaitingAck = "en attente dans le canal"
    static let taken = "prise en charge"
    static let refused = "refusée"
    static let delivered = "déposé"

    // --- zone d'action (S-9) -------------------------------------------------
    static let launchToggle = "Lancer une feature…"
    static let noGesture =
        "Aucun geste depuis cette carte : elle ne porte ni run vivant ni jalon de lot."
    static let questionTitle = "Question en vol"
    static let answerFieldPlaceholder = "ou saisissez votre réponse"
    static let answer = "Répondre"
    static let steerTitle = "Envoyer un texte à ce run"
    static let steerFieldLabel = "Votre message"
    static let send = "Envoyer"
    static let validate = "Valider les specs"
    static let accept = "Accepter la revue"
    static let stop = "Arrêter le lot"

    // --- formulaire de lancement (S-9) ---------------------------------------
    static let titleLabel = "Titre"
    static let descriptionLabel = "Description"
    static let repoLabel = "Dépôt"
    static let submit = "Lancer"
    static let cancel = "Annuler"

    // --- journal (S-9) -------------------------------------------------------
    static let journalTitle = "Gestes"
    static let journalEmpty = "Aucun geste pour l'instant."

    /// Le motif d'un run sans boîte publiée (S-9) : sans elle, aucune écriture
    /// n'est possible.
    static func notArmed(_ label: String) -> String {
        "Ce run (\(label)) n'accepte pas d'écriture : aucune boîte n'est publiée (run non armé)."
    }

    /// Le motif d'un refus du pilote : le texte EXACT du canal (AC-9), jamais
    /// recomposé.
    static func refused(_ reason: String) -> String {
        "refusée : \(reason)"
    }

    /// Le motif d'un échec d'écriture local : `<strerror>` porté par l'erreur.
    static func failed(_ reason: String) -> String {
        "échec : \(reason)"
    }

    /// Le message d'un magasin sans aucun dépôt connu (S-7).
    static func noRepos() -> String {
        "Aucun dépôt connu : aucun lot dans le magasin et aucun projet ouvert."
    }

    /// L'état d'une entrée de journal, en texte exact (S-4).
    static func stateText(_ state: ActionJournalState) -> String {
        switch state {
        case .awaitingAck: awaitingAck
        case .taken: taken
        case .refused(nil): refused
        case .refused(let reason?): refused(reason)
        case .delivered: delivered
        case .failed(let reason): failed(reason)
        }
    }

    /// La ligne EXACTE d'une entrée : `<libellé du geste> · <cible> · <état>`.
    static func journalLine(for entry: ActionJournalEntry) -> String {
        "\(entry.kindLabel) · \(entry.targetLabel) · \(stateText(entry.state))"
    }
}
