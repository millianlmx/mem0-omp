// Les mots de la section Audit (audit-panel-in-omp-console S-5, S-6, S-8) : ceux
// de la section du Mac et de l'écran de l'iPhone, au vouvoiement et en
// typographie française. Les deux coques n'écrivent AUCUN mot de l'audit
// ailleurs qu'ici.
//
// VIT DANS `ConsoleCore` : les deux coques partagent le vocabulaire.

public enum AuditText {
    // --- section vide (S-6) --------------------------------------------------
    public static let emptyTitle = "Aucun audit."
    public static let emptyHelp = "Lancez un audit pour analyser un dépôt selon l’orientation de votre choix."
    /// Le bouton de la barre d'outils et de la section vide.
    public static let startAudit = "Lancer un audit…"

    // --- statut d'un audit (liste et en-tête) --------------------------------
    public static let statusAnalysing = "Analyse en cours…"
    public static let statusProposed = "Propositions à valider"
    public static let statusLaunched = "Pipelines lancées"
    public static let statusStopped = "Arrêté"
    public static let statusFailed = "Échec de l’analyse"

    public static func status(_ status: AuditStatus) -> String {
        switch status {
        case .analysing: statusAnalysing
        case .proposed: statusProposed
        case .launched: statusLaunched
        case .stopped: statusStopped
        case .failed: statusFailed
        }
    }

    // --- en-tête du détail ---------------------------------------------------
    public static let orientation = "Orientation"
    public static let stopAudit = "Arrêter l’audit…"

    // --- feuille de lancement ------------------------------------------------
    public static let launchTitle = "Lancer un audit"
    public static let repository = "Dépôt"
    public static let choose = "Choisir…"
    public static let choosePanelMessage = "Choisissez le dépôt à auditer."
    public static let choosePanelPrompt = "Choisir"
    public static let orientationPrompt = "Ce que l’audit doit examiner, par exemple « accessibilité VoiceOver »."
    public static let commitLaunch = "Lancer l’audit"
    public static let cancel = "Annuler"
    /// Le même contrôle `.git` que la conduite de projet : le même message.
    public static let notGitRepository = ProjectViewText.notGitRepository
    public static let orientationTooLong = "2 000 caractères au plus."

    // --- propositions --------------------------------------------------------
    public static let weaknesses = "Faiblesses"
    public static let proposedFeatures = "Features proposées"
    public static let taken = "Déjà dans le lot des pipelines"
    public static let reviewBrief = "Relire le brief…"
    /// L'état d'une case, lu par VoiceOver sur iPhone.
    public static let checked = "Cochée"
    public static let unchecked = "Non cochée"

    /// Le compteur des cases cochées : « Aucune proposition cochée »,
    /// « 1 proposition cochée », « <n> propositions cochées ».
    public static func checkedCount(_ count: Int) -> String {
        switch count {
        case ...0: "Aucune proposition cochée"
        case 1: "1 proposition cochée"
        default: "\(count) propositions cochées"
        }
    }

    // --- brief ---------------------------------------------------------------
    public static let briefTitle = "Brief de l’audit"
    public static let briefHelp = "Relisez et corrigez le brief : chaque pipeline lancée le relira avant de poser une question."
    public static let commitBrief = "Valider et lancer"

    /// Une rubrique manquante, signalée avant tout envoi.
    public static func briefIncomplete(rubric: String) -> String {
        "Le brief est incomplet : la rubrique « \(rubric) » manque."
    }

    // --- avancement (S-5) ----------------------------------------------------
    public static let progressTitle = "Avancement"
    public static let openPR = "Ouvrir la PR"
    public static let waitingEscalated = "Attend votre réponse"
    public static let waitingArbitrating = "L’arbitre examine une question"
    public static let waitingNotStarted = "En attente de démarrage"
    public static let waitingRunning = "En cours"
    public static let waitingWaiting = "En attente — voir Pipelines"
    public static let waitingBlocked = "Bloquée — voir Pipelines"
    public static let waitingFailed = "En échec — voir Pipelines"
    public static let waitingPRCreated = "PR créée"
    public static let waitingDone = "Terminée"
    public static let waitingCancelled = "Annulée"

    public static func waiting(_ waiting: AuditWaiting) -> String {
        switch waiting {
        case .escalated: waitingEscalated
        case .arbitrating: waitingArbitrating
        case .notStarted: waitingNotStarted
        case .running: waitingRunning
        case .waiting: waitingWaiting
        case .blocked: waitingBlocked
        case .failed: waitingFailed
        case .prCreated: waitingPRCreated
        case .done: waitingDone
        case .cancelled: waitingCancelled
        }
    }

    // --- questions en attente (S-6) ------------------------------------------
    public static let escalationsTitle = "Questions en attente"
    public static let noEscalation = "Aucune question en attente."
    public static let otherAnswer = "Autre réponse"
    public static let answer = "Répondre"
    public static let approveSpecs = "Valider les specs"
    public static let approveReview = "Accepter la revue et livrer (PR)"
    public static let abandonFeature = "Abandonner la feature"
    public static let alreadyAnswered = "Cette question a déjà reçu une réponse."

    /// L'en-tête d'une escalade : « <slug> · <phase> ».
    public static func escalationHeader(slug: String, phase: PipelinePhase) -> String {
        "\(slug) · \(PhaseText.title(phase))"
    }

    public static func arbiterReason(_ reason: String) -> String {
        "Motif de l’arbitre : \(reason)"
    }

    /// Le badge d'escalades d'une rangée, tel que VoiceOver le lit.
    public static func pendingQuestions(_ count: Int) -> String {
        count == 1 ? "1 question en attente" : "\(count) questions en attente"
    }

    // --- décisions de l'arbitre (S-6) ----------------------------------------
    public static let decisionsTitle = "Décisions de l’arbitre"
    public static let noDecision = "Aucune décision pour l’instant."
    public static let sourceContexte = "Déjà tranchée"
    public static let sourceArbitrage = "Tranchée par l’arbitre"

    public static func source(_ source: AuditDecisionSource) -> String {
        switch source {
        case .contexte: sourceContexte
        case .arbitrage: sourceArbitrage
        }
    }

    // --- arrêt (S-6) ---------------------------------------------------------
    public static let stopTitle = "Arrêter cet audit ?"
    public static let stopMessage = "Les pipelines non livrées de cet audit seront annulées ; leurs dossiers et branches sont conservés. Les PR déjà créées restent ouvertes. Les autres audits ne sont pas touchés."
    public static let stopConfirm = "Arrêter l’audit"

    // --- échecs (S-6) --------------------------------------------------------
    public static let startFailed = "L’audit n’a pas démarré. Vérifiez que le service OMP tourne, puis réessayez."
    public static let launchConflict = "Cet audit n’attend plus de validation : il a été lancé ou arrêté entre-temps."
    public static let launchFailed = "Le lancement n’a pas eu lieu. Vérifiez le brief et la sélection, puis réessayez."
    public static let answerFailed = "La réponse n’a pas été transmise. La question reste en attente : réessayez."
    public static let stopFailed = "L’audit n’a pas été arrêté. Réessayez."
    public static let analysisFailed = "L’analyse n’a rien proposé. Relancez un audit."
}
