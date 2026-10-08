// TOUS les textes affichés par la vue « Projet » (S-1 … S-10, BR-3) : un seul
// endroit à corriger, et des constantes pures donc testables sans UI.
//
// Aucun de ces textes n'est un message d'ÉCHEC de session : ceux-là viennent de
// la table de traduction de la coque (`ServiceSessionModel.userMessage`).

import Foundation

public enum ProjectViewText {
    // MARK: - États de la fenêtre

    public static let emptyTitle = "Aucun projet piloté."
    public static let emptyHelp = "Choisissez un dépôt pour piloter un projet de bout en bout depuis l'app."
    public static let notGitRepository = "Ce dossier n'est pas un dépôt git."
    /// Le nom du document du plan et celui du contrat : la MÊME constante que
    /// `RemoteReads.documents` (formule unique).
    public static let docFileName = "PROJECT.md"
    public static let contractFileName = "contract.md"
    public static let noRepository = "Aucun dépôt connu de la coque."
    public static let docLoading = "Lecture du document…"
    public static let docMissing = "PROJECT.md n'est pas encore publié."
    public static let projectMissing = "Le plan n'est pas encore disponible."
    public static let sessionStarting = "Lancement de la session…"
    public static let sessionClosing = "Arrêt de la session…"
    public static let waitingBanner = "Le projet attend votre réponse."
    public static let refusalTitle = "Un projet est déjà piloté"
    public static let windowTitle = "Projet"
    public static let planTitle = "Plan"
    public static let docTitle = "Document"

    // MARK: - Bannières paramétrées

    /// `path` est déjà formaté (`ConsoleFormat.path`) : jamais un chemin absolu brut.
    public static func refusal(name: String, path: String) -> String {
        "« \(name) » est déjà piloté (\(path)). Arrêtez le pilotage en cours avant d'en démarrer un autre."
    }

    public static func doneBanner(m: Int, n: Int) -> String {
        "Projet terminé — \(progress(merged: m, total: n))."
    }

    /// « 1 feature fusionnée sur 2 » : le pluriel suit le nombre de fusionnées.
    public static func progress(merged: Int, total: Int) -> String {
        "\(ConsoleFormat.count(merged, "feature fusionnée", "features fusionnées")) sur \(total)"
    }

    public static func waitingCount(_ n: Int) -> String {
        "\(waitingBanner) \(ConsoleFormat.count(n, "question", "questions")) à traiter."
    }

    /// « Segment 2 sur 3 · Lire le réel ».
    public static func segmentTitle(index: Int, count: Int, name: String) -> String {
        "Segment \(index) sur \(count) · \(name)"
    }

    // MARK: - Conversation, composeur et dialogue (S-19 R3)

    public static let conversationWaitingTitle = "Conversation à venir"
    public static let conversationWaiting = "La conversation s'affiche dès que la session publie son fichier."
    public static let composerLive = "Écrivez à OMP…"
    public static let composerIdle = "Le pilotage n'est pas actif."
    public static let composerBlocked = "Répondez au dialogue en cours pour débloquer le tour."
    public static let dialogCancel = "Annuler"

    // MARK: - Libellés de l'en-tête

    public static let launchTitle = "Piloter un projet"
    public static let launchRepository = "Dépôt"
    public static let launchName = "Nom du projet"
    public static let launchCommit = "Piloter"
    public static let launchCancel = "Annuler"
    public static let closeConduite = "Arrêter le pilotage"
    public static let closeConfirmTitle = "Arrêter le pilotage de ce projet ?"
    public static let closeConfirmMessage = "La session d'OMP qui pilote ce projet s'arrête."
    public static let chooseRepository = "Choisir…"
    public static let startConduite = "Piloter un projet…"

    public static let repositoryPlaceholder = "Aucun dépôt choisi."
    public static let namePlaceholder = "Nom du projet"

    // MARK: - Vocabulaire d'état (mots communs de l'app, une majuscule)

    public static let statusDone = "Terminé"
    public static let statusRunning = "En cours"
    public static let statusStopped = "Arrêté"

    public static let featurePlanned = "À venir"
    public static let featureLaunched = "En cours"
    public static let featurePR = "PR ouverte"
    public static let featureMerged = "Fusionnée"
    public static let featureRemoved = "Retirée"
    public static let featureFailed = "Échec"

    public static let segmentMerged = "Fusionné"
    public static let segmentCurrent = "En cours"
    public static let segmentUpcoming = "À venir"

    // MARK: - États de ligne

    public static let removedTitle = "Features retirées"
    public static let emptyPlan = "Le plan n'est pas encore publié."

    // MARK: - Volet « PR et CI » (BR-3)

    public static let prPaneTitle = "PR et CI"
    public static let prEmpty = "Aucune PR ouverte pour ce projet."
    public static let prLoading = "Lecture des statuts…"
    public static let prUnknownSuffix = " (lecture en cours)"
    public static let prStaleSuffix = " (périmé)"
    public static let prOpen = "Ouvrir la PR"
    public static let prMerge = "Fusionner…"
    public static let prMergeHelp = "Fusion indisponible : les trois statuts requis doivent être verts."
    public static let prMergeConfirmButton = "Fusionner"
    public static let prMergeCancelButton = "Annuler"

    /// Le message de lecture, préfixe du `userMessage` d'une `GhError` (S-7).
    public static func prUnavailable(_ message: String) -> String {
        "Statuts indisponibles : \(message)"
    }

    /// Une ligne de statut : « <nom> : <état> ».
    public static func prCheckLine(name: String, state: String) -> String {
        "\(name) : \(state)"
    }

    /// « PR #<n> — <titre> », « PR #<n> », ou l'URL quand aucun numéro n'est connu.
    /// Formule unique, partagée avec la coque macOS (`ProjectPRRow.headline`).
    public static func prHeadline(number: Int?, title: String?, url: String) -> String {
        if let number, let title, !title.isEmpty { return "PR #\(number) — \(title)" }
        if let number { return "PR #\(number)" }
        return url
    }

    /// Une URL n'est cliquable que si elle est `http(s)` — jamais une chaîne
    /// bancale. Formule unique, partagée avec `ProjectPlanRowView.linkURL`.
    public static func prLinkURL(_ value: String) -> URL? {
        guard let url = URL(string: value), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return nil }
        return url
    }

    /// Le lien d'une vérification rouge vers le détail de son exécution.
    public static let prRunLink = "Voir l'échec"

    /// L'ouverture est refusée quand l'adresse n'est pas http(s) (S-4).
    public static func prNotOpenable(url: String) -> String {
        "L'adresse de cette PR n'est pas ouvrable dans un navigateur : \(url)."
    }

    public static func prOpenFailed(number: Int?) -> String {
        guard let number else { return "L'ouverture de la PR dans le navigateur a échoué." }
        return "L'ouverture de la PR #\(number) dans le navigateur a échoué."
    }

    /// Le refus d'une fusion dont les statuts frais ne sont pas tous verts (S-5).
    public static func prMergeRefused(number: Int?) -> String {
        guard let number else { return "Fusion refusée : les trois statuts requis ne sont pas verts." }
        return "Fusion refusée : les trois statuts requis ne sont pas verts (PR #\(number))."
    }

    /// L'échec d'une fusion refusée par GitHub (S-6).
    public static func prMergeRejected(detail: String, number: Int?) -> String {
        guard let number else { return "Fusion refusée par GitHub : \(detail)." }
        return "Fusion refusée par GitHub : \(detail) (PR #\(number))."
    }

    public static func prMergeConfirmTitle(number: Int?) -> String {
        guard let number else { return "Fusionner cette PR ?" }
        return "Fusionner la PR #\(number) ?"
    }

    public static func prMergeConfirmMessage(title: String) -> String {
        "\(title) — les trois statuts requis sont verts."
    }
}

/// Le titre d'un dialogue de `/project` (S-19 R3) : la revue du plan porte tout le
/// plan dans son titre, sur plusieurs lignes.
public enum ProjectDialogText {
    /// PURE : la première ligne non vide est le titre ; le reste, débarrassé des
    /// lignes vides qui l'encadrent, est le corps (Markdown) — `nil` s'il n'y a
    /// rien d'autre. Aucun caractère du corps n'est retiré ni réécrit.
    public static func split(_ title: String) -> (heading: String, body: String?) {
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
    public static func step(_ heading: String) -> (question: String, counter: String?) {
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
