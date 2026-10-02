// Les textes de la section « Session OMP » (S-15 de omp-console-redesign) :
// l'état de la session hébergée en un mot (la pilule de la barre d'outils),
// les états vides, le composeur, la feuille de dialogue (partagée avec
// « Projet » par `RpcDialogPane`), la barre d'outils et l'inspecteur
// « Détails techniques » (S-18 R8), dont les titres des trames humanisées.
//
// Fonctions PURES ; `statusMessage` et `relaunchNote` (SessionConsoleModel)
// restent les textes détaillés de l'inspecteur.

import Foundation

enum SessionConsoleText {
    static let noProjectTitle = "Aucune session"
    static let noProjectBody = "Choisissez un dossier de projet pour converser avec OMP."
    static let readyTitle = "Prête à démarrer"
    static let starting = "Démarrage de la session…"
    static let failedTitle = "La session n'a pas démarré"
    static let interrupted = "La session s'est arrêtée. Relancez-la pour reprendre la conversation."
    static let composerRunning = "Écrivez à OMP…"
    static let composerIdle = "Lancez la session pour écrire."
    static let dialogTitle = "OMP vous demande"
    static let details = "Détails techniques"
    static let options = "Options"
    static let modeLabel = "Dialogues"
    static let send = "Envoyer"
    static let chooseFolder = "Choisir un dossier…"
    static let launch = "Lancer la session"
    static let relaunch = "Relancer"
    static let stop = "Arrêter la session"

    // MARK: Dialogue d'OMP (`RpcDialogPane`)

    static let cancel = "Annuler"
    static let answer = "Répondre"
    static let confirm = "Confirmer"
    static let decline = "Refuser"
    static let noOption = "Aucune option proposée."
    static let noEvent = "Aucun événement pour l'instant."

    /// Le libellé affiché d'une option : la marque anglaise d'OMP
    /// « (Recommended) », en fin de libellé, se dit « (recommandé) ». La valeur
    /// RENVOYÉE à OMP reste l'option d'origine.
    static func optionLabel(_ option: String) -> String {
        let marker = "(Recommended)"
        let trimmed = option.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasSuffix(marker) else { return option }
        return String(trimmed.dropLast(marker.count)) + "(recommandé)"
    }

    /// Le mode de la session, sans le nom du protocole.
    static func modeTitle(_ mode: RpcMode) -> String {
        switch mode {
        case .rpcUI: return "Dialogues : activés"
        case .rpc: return "Dialogues : désactivés"
        }
    }

    /// L'état détaillé de l'inspecteur, sans pid ni identifiant.
    enum Status {
        static let idle = "Aucune session"
        static let launching = "Démarrage…"
        static let running = "Session active"
        static let stopping = "Arrêt en cours…"
        static let stopped = "Session arrêtée"
        static let dead = "La session s'est interrompue."
    }

    static func relaunchNote(sessionFile: String) -> String {
        "La relance reprend la conversation de \(sessionFile)."
    }

    // MARK: Inspecteur « Détails techniques » (S-18 R8)

    static let sectionSession = "Session"
    static let sectionActivity = "Activité"
    static let sectionJournal = "Journal"
    static let rawFrames = "Trames brutes"
    static let fieldProject = "Projet"
    static let fieldState = "État"
    static let fieldPid = "pid"
    static let fieldSessionId = "Identifiant de session"
    static let fieldMode = "Mode"
    static let none = "—"
    static let noActivity = "Aucune trame pour l'instant."
    static let noJournal = "Aucune entrée de journal."

    /// Une ligne du journal, préfixée de sa catégorie.
    static func journalLine(_ entry: JournalEntry) -> String {
        "[\(entry.kind.rawValue)] \(entry.message)"
    }

    /// Les titres des trames du protocole, humanisées (`RpcEventSummary`).
    enum Frame {
        static let unreadable = "Trame illisible"
        static let truncated = "message tronqué"
        static let localError = "Erreur locale"
        static let ready = "Session prête"
        static let promptSent = "Message envoyé"
        static let stateRequest = "Demande d'état"
        static let negotiation = "Négociation du protocole"
        static let hostAnswer = "Réponse à l'hôte"
        static let confirmed = "confirmé"
        static let declined = "refusé"
        static let cancelled = "annulé"
        static let turnResult = "Résultat du tour"
        static let settled = "Session stabilisée"
        static let agentStart = "Agent au travail"
        static let agentEnd = "Agent au repos"
        static let turnStart = "Début du tour"
        static let turnEnd = "Fin du tour"
        static let userMessage = "Message de l'utilisateur"
        static let agentMessage = "Message de l'agent"
        static let otherMessage = "Message"
        static let messageStart = "début"
        static let thinking = "réflexion"
        static let hostQuestion = "Question de l'hôte"
        static let questionWithdrawn = "Question retirée"
        static let notification = "Notification de l'hôte"
        static let hostStatus = "Statut de l'hôte"
        static let hostTitle = "Titre de l'hôte"
        static let hostWidget = "Panneau de l'hôte"
        static let hostEditorText = "Texte proposé par l'hôte"
        static let hostLink = "Lien proposé par l'hôte"
        static let commandsUpdate = "Commandes disponibles"
        static let thinkingLevel = "Niveau de réflexion"
        static let advisorCost = "Coût du conseiller"

        /// L'issue d'un tour (`prompt_result.status`), traduite ; une valeur
        /// inconnue reste telle quelle plutôt que d'être devinée.
        static func turnStatus(_ status: String) -> String {
            switch status {
            case "completed": return "terminé"
            case "aborted": return "interrompu"
            case "cancelled": return "annulé"
            case "failed", "error": return "échec"
            default: return status
            }
        }

        static func response(_ command: String) -> String { "Réponse · \(command)" }
        static func failedResponse(_ command: String) -> String { "Échec · \(command)" }
        static func command(_ type: String) -> String { "Commande · \(type)" }
        static func toolCall(_ name: String) -> String { "Appel d'outil · \(name)" }
        static func toolProgress(_ name: String) -> String { "Outil en cours · \(name)" }
        static func toolDone(_ name: String) -> String { "Outil terminé · \(name)" }
        static func toolFailed(_ name: String) -> String { "Échec d'outil · \(name)" }
        static func toolResult(_ name: String) -> String { "Résultat d'outil · \(name)" }
        static func hostDisplay(_ method: String) -> String { "Affichage de l'hôte · \(method)" }
        static func event(_ type: String) -> String { "Événement · \(type)" }
    }

    /// L'état de la session hébergée en un mot.
    static func stateTitle(_ state: SessionHost.State, hasProject: Bool) -> String {
        switch state {
        case .idle: return hasProject ? "Prête" : "Aucun projet"
        case .launching: return "Démarrage…"
        case .running: return "Active"
        case .stopping: return "Arrêt…"
        case .stopped: return "Arrêtée"
        case .dead: return "Interrompue"
        case .failed: return "Échec"
        }
    }
}
