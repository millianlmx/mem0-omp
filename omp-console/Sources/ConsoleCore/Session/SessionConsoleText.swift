// Les textes de la section « Session OMP » (S-15 de omp-console-redesign) :
// l'état de la session hébergée en un mot (la pilule de la barre d'outils),
// les états vides, le composeur, la feuille de dialogue (partagée avec
// « Projet » par `RpcDialogPane`), la barre d'outils et l'inspecteur
// « Détails techniques » (S-18 R8), dont les titres des trames humanisées.
//
// Fonctions PURES ; `statusMessage` et `relaunchNote` (SessionConsoleModel)
// restent les textes détaillés de l'inspecteur.

import Foundation

public enum SessionConsoleText {
    public static let noProjectTitle = "Aucune session"
    public static let noProjectBody = "Choisissez un dossier de projet pour converser avec OMP."
    public static let readyTitle = "Prête à démarrer"
    public static let starting = "Démarrage de la session…"
    public static let failedTitle = "La session n'a pas démarré"
    public static let interrupted = "La session s'est arrêtée. Relancez-la pour reprendre la conversation."
    public static let composerRunning = "Écrivez à OMP…"
    public static let composerIdle = "Lancez la session pour écrire."
    public static let dialogTitle = "OMP vous demande"
    public static let details = "Détails techniques"
    public static let options = "Options"
    public static let modeLabel = "Dialogues"
    public static let send = "Envoyer"
    public static let chooseFolder = "Choisir un dossier…"
    public static let launch = "Lancer la session"
    public static let relaunch = "Relancer"
    public static let retry = "Réessayer"
    public static let stop = "Arrêter la session"
    /// Le motif d'un lancement refusé : une session est déjà en marche (S-1).
    public static let launchBusy = "Une session est déjà en marche."
    /// Le motif d'une relance refusée : la session n'est pas `dead` (S-1).
    public static let relaunchNotDead = "Aucune session interrompue à relancer."

    // MARK: Dialogue d'OMP (`RpcDialogPane`)

    public static let cancel = "Annuler"
    public static let answer = "Répondre"
    public static let confirm = "Confirmer"
    public static let decline = "Refuser"
    public static let noOption = "Aucune option proposée."
    public static let noEvent = "Aucun événement pour l'instant."

    /// Le libellé affiché d'une option : la marque anglaise d'OMP
    /// « (Recommended) », en fin de libellé, se dit « (recommandé) ». La valeur
    /// RENVOYÉE à OMP reste l'option d'origine.
    public static func optionLabel(_ option: String) -> String {
        let marker = "(Recommended)"
        let trimmed = option.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasSuffix(marker) else { return option }
        return String(trimmed.dropLast(marker.count)) + "(recommandé)"
    }

    /// L'état détaillé de l'inspecteur, sans pid ni identifiant.
    public enum Status {
        public static let idle = "Aucune session"
        /// L'état d'une session jamais lancée faute de projet choisi : le mot que
        /// la coque macOS rend par `stateTitle(.idle, hasProject: false)` et que
        /// l'app iOS affiche en pastille (S-4 de design-ios).
        public static let idleNoProject = "Aucun projet"
        public static let launching = "Démarrage…"
        public static let running = "Session active"
        public static let stopping = "Arrêt en cours…"
        public static let stopped = "Session arrêtée"
        public static let dead = "La session s'est interrompue."
    }

    public static func relaunchNote(sessionFile: String) -> String {
        "La relance reprend la conversation de \(sessionFile)."
    }

    // MARK: Inspecteur « Détails techniques » (S-18 R8)

    public static let sectionSession = "Session"
    public static let sectionActivity = "Activité"
    public static let sectionJournal = "Journal"
    public static let rawFrames = "Trames brutes"
    public static let fieldProject = "Projet"
    public static let fieldState = "État"
    /// L'état lisible de la ligne « État » des inspecteurs Session OMP et Projet
    /// du Mac (S-3 de jargon-technique-expose-mac-et-ios) : le pid n'y figure
    /// plus, il ne vit que dans « Copier le diagnostic ».
    public static let stateRunning = "En marche"
    public static let stateWaiting = "En attente"
    public static let stateStopped = "Arrêtée"
    public static let fieldSessionId = "Identifiant de session"
    public static let fieldMode = "Mode"
    public static let none = "—"
    public static let noActivity = "Aucune trame pour l'instant."
    public static let noJournal = "Aucune entrée de journal."

    /// Les titres des trames du protocole, humanisées (inspecteur « Détails
    /// techniques » d'avant le cutover ; conservés pour les écrans qui les citent).
    public enum Frame {
        public static let unreadable = "Trame illisible"
        public static let truncated = "message tronqué"
        public static let localError = "Erreur locale"
        public static let ready = "Session prête"
        public static let promptSent = "Message envoyé"
        public static let stateRequest = "Demande d'état"
        public static let negotiation = "Négociation du protocole"
        public static let hostAnswer = "Réponse à l'hôte"
        public static let confirmed = "confirmé"
        public static let declined = "refusé"
        public static let cancelled = "annulé"
        public static let turnResult = "Résultat du tour"
        public static let settled = "Session stabilisée"
        public static let agentStart = "Agent au travail"
        public static let agentEnd = "Agent au repos"
        public static let turnStart = "Début du tour"
        public static let turnEnd = "Fin du tour"
        public static let userMessage = "Message de l'utilisateur"
        public static let agentMessage = "Message de l'agent"
        public static let otherMessage = "Message"
        public static let messageStart = "début"
        public static let thinking = "réflexion"
        public static let hostQuestion = "Question de l'hôte"
        public static let questionWithdrawn = "Question retirée"
        public static let notification = "Notification de l'hôte"
        public static let hostStatus = "Statut de l'hôte"
        public static let hostTitle = "Titre de l'hôte"
        public static let hostWidget = "Panneau de l'hôte"
        public static let hostEditorText = "Texte proposé par l'hôte"
        public static let hostLink = "Lien proposé par l'hôte"
        public static let commandsUpdate = "Commandes disponibles"
        public static let thinkingLevel = "Niveau de réflexion"
        public static let advisorCost = "Coût du conseiller"

        /// L'issue d'un tour (`prompt_result.status`), traduite ; une valeur
        /// inconnue reste telle quelle plutôt que d'être devinée.
        public static func turnStatus(_ status: String) -> String {
            switch status {
            case "completed": return "terminé"
            case "aborted": return "interrompu"
            case "cancelled": return "annulé"
            case "failed", "error": return "échec"
            default: return status
            }
        }

        public static func response(_ command: String) -> String { "Réponse · \(command)" }
        public static func failedResponse(_ command: String) -> String { "Échec · \(command)" }
        public static func command(_ type: String) -> String { "Commande · \(type)" }
        public static func toolCall(_ name: String) -> String { "Appel d'outil · \(name)" }
        public static func toolProgress(_ name: String) -> String { "Outil en cours · \(name)" }
        public static func toolDone(_ name: String) -> String { "Outil terminé · \(name)" }
        public static func toolFailed(_ name: String) -> String { "Échec d'outil · \(name)" }
        public static func toolResult(_ name: String) -> String { "Résultat d'outil · \(name)" }
        public static func hostDisplay(_ method: String) -> String { "Affichage de l'hôte · \(method)" }
        public static func event(_ type: String) -> String { "Événement · \(type)" }
    }

}
