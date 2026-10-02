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
    static let textLabel = "message"
    static let specsLabel = "validation des specs"
    static let reviewLabel = "acceptation de la revue"
    static let launchLabel = "lancement"
    static let stopLabel = "arrêt"
    static let resumeLabel = "reprise"

    // --- états du journal (S-4) ----------------------------------------------
    static let awaitingAck = "envoyé au pilote"
    static let taken = "prise en charge"
    static let refused = "refusée"
    static let delivered = "remis à l'agent"
    /// Une commande restée sans accusé après `ActionsModel.ackTimeoutMs` (S-8 de
    /// omp-console-redesign) : aucun pilote ne l'a prise — le plus souvent, le
    /// plugin chargé par omp ne porte pas le canal.
    static let unacknowledged =
        "le pilote n'a pas répondu après 20 s — vérifiez que le plugin omp-mem0-req est installé"

    // --- zone d'action (S-9) -------------------------------------------------
    static let noGesture = "Aucune action possible sur cette pipeline pour l'instant."
    /// Le motif d'une exécution sans boîte publiée (S-9) : sans elle, aucune
    /// écriture n'est possible.
    static let notArmed = "Cette exécution n'accepte pas de message pour l'instant."
    static let questionTitle = "Question de l'agent"
    static let answerFieldPlaceholder = "Autre réponse…"
    static let answer = "Répondre"
    static let steerTitle = "Envoyer un message à l'agent"
    static let steerFieldLabel = "Votre message"
    static let send = "Envoyer"
    static let validate = "Valider les specs"
    static let accept = "Accepter la revue"
    static let stop = "Arrêter…"
    static let stopConfirm = "Arrêter"
    static let stopConfirmMessage =
        "Le pilote s'arrête et les pipelines en cours dans ce dépôt sont interrompues."
    static let cancel = "Annuler"
    static let replyTitle = "Question de l'agent"
    static let replyFieldPlaceholder = "Votre réponse"
    static let resumeNote = "Le pilote de cette pipeline est arrêté."
    static let resume = "Reprendre"

    // --- journal (S-9, « Activité récente » de S-14) ------------------------
    static let journalTitle = "Activité récente"
    static let journalEmpty = "Aucun geste pour l'instant."

    /// Le titre de la confirmation d'arrêt : l'arrêt vise le dépôt entier.
    static func stopConfirmTitle(repo: String) -> String {
        "Arrêter les pipelines de \(repo) ?"
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

    /// L'état d'une entrée de journal, en texte exact (S-4).
    static func stateText(_ state: ActionJournalState) -> String {
        switch state {
        case .awaitingAck: awaitingAck
        case .taken: taken
        case .refused(nil): refused
        case .refused(let reason?): refused(reason)
        case .delivered: delivered
        case .failed(let reason): failed(reason)
        case .unacknowledged: unacknowledged
        }
    }

    /// La ligne EXACTE d'une entrée : `<libellé du geste> · <cible> · <état>`.
    static func journalLine(for entry: ActionJournalEntry) -> String {
        "\(entry.kindLabel) · \(entry.targetLabel) · \(stateText(entry.state))"
    }
}
