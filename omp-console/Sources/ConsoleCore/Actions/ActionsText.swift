// TOUS les textes de l'action depuis le Kanban, en UN endroit (convention
// `FilesText`, Files/FilesText.swift:9) : un message à un seul endroit, c'est ce
// qui permet à un test de le figer sans rendre une vue, et à la vue de ne jamais
// composer une phrase.
//
// Le journal (S-4) se compose ICI, en une fonction pure : la vue affiche la ligne
// rendue, elle ne l'assemble pas.
//
// VIT DANS `ConsoleCore` : les deux coques partagent le vocabulaire.

import Foundation

public enum ActionsText {
    // --- libellés des gestes (la première colonne d'une ligne de journal) -----
    public static let answerLabel = "réponse"
    public static let textLabel = "message"
    public static let specsLabel = "validation des specs"
    public static let reviewLabel = "acceptation de la revue"
    public static let launchLabel = "lancement"
    public static let stopLabel = "arrêt"
    public static let resumeLabel = "reprise"

    // --- états du journal (S-4) ----------------------------------------------
    public static let awaitingAck = "envoyé au pilote"
    public static let taken = "prise en charge"
    public static let refused = "refusée"
    public static let delivered = "remis à l'agent"
    /// Une commande restée sans accusé après `ActionsModel.ackTimeoutMs` (S-8 de
    /// omp-console-redesign) : aucun pilote ne l'a prise — le plus souvent, le
    /// plugin chargé par omp ne porte pas le canal.
    public static let unacknowledged =
        "le pilote n'a pas répondu après 20 s — vérifiez que le plugin omp-mem0-req est installé"

    // --- zone d'action (S-9) -------------------------------------------------
    public static let answer = "Répondre"
    public static let steerTitle = "Envoyer un message à l'agent"
    public static let steerFieldLabel = "Votre message"
    public static let replyTitle = "Question de l'agent"
    public static let resumeNote = "Le pilote de cette pipeline est arrêté."

    // --- journal (S-9, « Activité récente » de S-14) ------------------------
    public static let journalTitle = "Activité récente"
    public static let journalEmpty = "Aucun geste pour l'instant."

    // --- modèles (B-1, B-3, B-4) --------------------------------------------
    /// Le libellé du geste d'édition des deux modèles dans le journal.
    public static let modelsLabel = "modèles"
    /// Le bouton de la feuille d'édition qui émet la commande.
    public static let applyModelChanges = "Appliquer"

    /// Le titre de la feuille d'édition des modèles d'une feature.
    public static func modelsSheetTitle(_ slug: String) -> String {
        "Modèles de \(slug)"
    }


    /// Le motif d'un refus du pilote : le texte EXACT du canal (AC-9), jamais
    /// recomposé.
    public static func refused(_ reason: String) -> String {
        "refusée : \(reason)"
    }

    /// Le motif d'un échec d'écriture local : `<strerror>` porté par l'erreur.
    public static func failed(_ reason: String) -> String {
        "échec : \(reason)"
    }

    /// L'état d'une entrée de journal, en texte exact (S-4).
    public static func stateText(_ state: ActionJournalState) -> String {
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
    public static func journalLine(for entry: ActionJournalEntry) -> String {
        "\(entry.kindLabel) · \(entry.targetLabel) · \(stateText(entry.state))"
    }
}
