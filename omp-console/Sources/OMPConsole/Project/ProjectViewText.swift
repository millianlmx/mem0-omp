// TOUS les textes affichés par la vue « Projet » (S-1 … S-10, BR-3) : un seul
// endroit à corriger, et des constantes pures donc testables sans UI.
//
// Aucun de ces textes n'est un message d'ÉCHEC de session : ceux-là viennent de
// `SessionHostError.userMessage`, seule table de traduction des erreurs du host.

import Foundation

enum ProjectViewText {
    // MARK: - États de la fenêtre

    static let emptyTitle = "Aucun projet piloté."
    static let emptyHelp = "Choisissez un dépôt pour piloter un projet de bout en bout depuis l'app."
    static let notGitRepository = "Ce dossier n'est pas un dépôt git."
    static let docMissing = "PROJECT.md n'est pas encore publié."
    static let projectMissing = "Le plan n'est pas encore disponible."
    static let sessionStarting = "Lancement de la session…"
    static let sessionClosing = "Arrêt de la session…"
    static let waitingBanner = "Le projet attend votre réponse."
    static let refusalTitle = "Un projet est déjà piloté"
    static let windowTitle = "Projet"
    static let planTitle = "Plan"
    static let docTitle = "Document"

    // MARK: - Bannières paramétrées

    /// `path` est déjà formaté (`ConsoleFormat.path`) : jamais un chemin absolu brut.
    static func refusal(name: String, path: String) -> String {
        "« \(name) » est déjà piloté (\(path)). Arrêtez le pilotage en cours avant d'en démarrer un autre."
    }

    static func doneBanner(m: Int, n: Int) -> String {
        "Projet terminé — \(progress(merged: m, total: n))."
    }

    /// « 1 feature fusionnée sur 2 » : le pluriel suit le nombre de fusionnées.
    static func progress(merged: Int, total: Int) -> String {
        "\(ConsoleFormat.count(merged, "feature fusionnée", "features fusionnées")) sur \(total)"
    }

    static func waitingCount(_ n: Int) -> String {
        "\(waitingBanner) \(ConsoleFormat.count(n, "question", "questions")) à traiter."
    }

    /// « Segment 2 sur 3 · Lire le réel ».
    static func segmentTitle(index: Int, count: Int, name: String) -> String {
        "Segment \(index) sur \(count) · \(name)"
    }

    // MARK: - Conversation, composeur et dialogue (S-19 R3)

    static let conversationWaitingTitle = "Conversation à venir"
    static let conversationWaiting = "La conversation s'affiche dès que la session publie son fichier."
    static let composerLive = "Écrivez à OMP…"
    static let composerIdle = "Le pilotage n'est pas actif."
    static let composerBlocked = "Répondez au dialogue en cours pour débloquer le tour."
    static let dialogCancel = "Annuler"

    // MARK: - Libellés de l'en-tête

    static let launchTitle = "Piloter un projet"
    static let launchRepository = "Dépôt"
    static let launchName = "Nom du projet"
    static let launchCommit = "Piloter"
    static let launchCancel = "Annuler"
    static let closeConduite = "Arrêter le pilotage"
    static let closeConfirmTitle = "Arrêter le pilotage de ce projet ?"
    static let closeConfirmMessage = "La session d'OMP qui pilote ce projet s'arrête."
    static let chooseRepository = "Choisir…"
    static let startConduite = "Piloter un projet…"

    static let repositoryPlaceholder = "Aucun dépôt choisi."
    static let namePlaceholder = "Nom du projet"

    // MARK: - Vocabulaire d'état (mots communs de l'app, une majuscule)

    static let statusDone = "Terminé"
    static let statusRunning = "En cours"
    static let statusStopped = "Arrêté"

    static let featurePlanned = "À venir"
    static let featureLaunched = "En cours"
    static let featurePR = "PR ouverte"
    static let featureMerged = "Fusionnée"
    static let featureRemoved = "Retirée"
    static let featureFailed = "Échec"

    static let segmentMerged = "Fusionné"
    static let segmentCurrent = "En cours"
    static let segmentUpcoming = "À venir"

    // MARK: - États de ligne

    static let removedTitle = "Features retirées"
    static let emptyPlan = "Le plan n'est pas encore publié."

    // MARK: - Volet « PR et CI » (BR-3)

    static let prPaneTitle = "PR et CI"
    static let prEmpty = "Aucune PR ouverte pour ce projet."
    static let prLoading = "Lecture des statuts…"
    static let prUnknownSuffix = " (lecture en cours)"
    static let prStaleSuffix = " (périmé)"
    static let prOpen = "Ouvrir la PR"
    static let prMerge = "Fusionner…"
    static let prMergeHelp = "Fusion indisponible : les trois statuts requis doivent être verts."
    static let prMergeConfirmButton = "Fusionner"
    static let prMergeCancelButton = "Annuler"

    /// Le message de lecture, préfixe du `userMessage` d'une `GhError` (S-7).
    static func prUnavailable(_ message: String) -> String {
        "Statuts indisponibles : \(message)"
    }

    /// Une ligne de statut : « <nom> : <état> ».
    static func prCheckLine(name: String, state: String) -> String {
        "\(name) : \(state)"
    }

    /// Le lien d'une vérification rouge vers le détail de son exécution.
    static let prRunLink = "Voir l'échec"

    /// L'ouverture est refusée quand l'adresse n'est pas http(s) (S-4).
    static func prNotOpenable(url: String) -> String {
        "L'adresse de cette PR n'est pas ouvrable dans un navigateur : \(url)."
    }

    static func prOpenFailed(number: Int?) -> String {
        guard let number else { return "L'ouverture de la PR dans le navigateur a échoué." }
        return "L'ouverture de la PR #\(number) dans le navigateur a échoué."
    }

    /// Le refus d'une fusion dont les statuts frais ne sont pas tous verts (S-5).
    static func prMergeRefused(number: Int?) -> String {
        guard let number else { return "Fusion refusée : les trois statuts requis ne sont pas verts." }
        return "Fusion refusée : les trois statuts requis ne sont pas verts (PR #\(number))."
    }

    /// L'échec d'une fusion refusée par GitHub (S-6).
    static func prMergeRejected(detail: String, number: Int?) -> String {
        guard let number else { return "Fusion refusée par GitHub : \(detail)." }
        return "Fusion refusée par GitHub : \(detail) (PR #\(number))."
    }

    static func prMergeConfirmTitle(number: Int?) -> String {
        guard let number else { return "Fusionner cette PR ?" }
        return "Fusionner la PR #\(number) ?"
    }

    static func prMergeConfirmMessage(title: String) -> String {
        "\(title) — les trois statuts requis sont verts."
    }
}

/// Le titre d'un dialogue de `/project` (S-19 R3) : la revue du plan porte tout le
/// plan dans son titre, sur plusieurs lignes.
enum ProjectDialogText {
    /// PURE : la première ligne non vide est le titre ; le reste, débarrassé des
    /// lignes vides qui l'encadrent, est le corps (Markdown) — `nil` s'il n'y a
    /// rien d'autre. Aucun caractère du corps n'est retiré ni réécrit.
    static func split(_ title: String) -> (heading: String, body: String?) {
        let lines = title.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        guard let first = lines.firstIndex(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else {
            return ("", nil)
        }
        let heading = lines[first].trimmingCharacters(in: .whitespaces)
        var rest = Array(lines[(first + 1)...])
        while let line = rest.first, line.trimmingCharacters(in: .whitespaces).isEmpty { rest.removeFirst() }
        while let line = rest.last, line.trimmingCharacters(in: .whitespaces).isEmpty { rest.removeLast() }
        return (heading, rest.isEmpty ? nil : rest.joined(separator: "\n"))
    }

    /// PURE : un titre de question terminé par « (n/m) » (1 ≤ n ≤ m) perd ce
    /// suffixe, rendu à part en « Question n sur m ». Tout autre titre est rendu
    /// tel quel, sans compteur.
    static func step(_ heading: String) -> (question: String, counter: String?) {
        let trimmed = heading.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasSuffix(")"), let open = trimmed.lastIndex(of: "(") else { return (heading, nil) }
        let inner = trimmed[trimmed.index(after: open)..<trimmed.index(before: trimmed.endIndex)]
        let parts = inner.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, let n = Int(parts[0]), let m = Int(parts[1]), n >= 1, n <= m else {
            return (heading, nil)
        }
        let question = trimmed[..<open].trimmingCharacters(in: .whitespaces)
        guard !question.isEmpty else { return (heading, nil) }
        return (question, "Question \(n) sur \(m)")
    }
}
