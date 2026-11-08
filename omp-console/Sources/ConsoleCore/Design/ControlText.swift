// Le vocabulaire de la TOUR DE CONTRÔLE, partagé par la coque Mac et l'app iOS : la
// consigne et le budget d'une feature, la raison d'une file, l'arrêt d'urgence et les
// demandes du poste, la vigie, les planifications, l'administration et les issues.
// Les mots qui existent ailleurs (Annuler, Envoyer, Raison) se reprennent de
// `PipelineServerText` et de `WorkstationText`.
//
// Les codes du serveur (mode et statut de la vigie, cause d'une file, issue d'une
// échéance, rôle d'un client) se traduisent ici, une seule fois pour les deux apps ;
// un code inconnu de cette version se rend tel quel.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?) et glossaire GLOSSAIRE.md.

public enum ControlText {
    // MARK: - Sections

    public static let groupTitle = L10n.text("Exploitation")
    public static let vigieTitle = L10n.text("Vigie")
    public static let schedulesTitle = L10n.text("Planifications")
    public static let issuesTitle = L10n.text("Issues")
    public static let adminTitle = L10n.text("Administration")
    public static let vigieSymbol = "binoculars"
    public static let schedulesSymbol = "calendar.badge.clock"
    public static let issuesSymbol = "exclamationmark.bubble"
    public static let adminSymbol = "person.badge.key"
    /// Une fonction que le serveur relié ne connaît pas encore.
    public static let absent = L10n.text("Ce serveur ne connaît pas encore cette fonction : mettez omp-harness à jour.")
    public static let adminOnly = L10n.text("Réservé aux administrateurs du serveur : ce jeton ne les voit pas.")

    // MARK: - Consigne à une feature

    public static let instructionsTitle = L10n.text("Consigne à l’agent")
    public static let instructionsAction = L10n.text("Envoyer une consigne…")
    public static let instructionsPrompt = L10n.text("Par exemple : garde l’ancien format de date")
    public static let instructionsSend = L10n.text("Envoyer la consigne")
    public static let instructionsHint = L10n.text("L’agent la lit au prochain tour de sa session ; s’il ne travaille pas à l’instant, elle part avec la prochaine étape.")
    public static let instructionsSession = L10n.text("Consigne transmise à l’agent en cours de travail.")
    public static let instructionsPending = L10n.text("Consigne gardée : elle part avec la prochaine étape.")
    public static let instructionsSymbol = "text.bubble"

    /// Ce que le serveur a fait de la consigne, en une phrase.
    public static func delivered(session: Bool) -> String {
        session ? instructionsSession : instructionsPending
    }

    // MARK: - Relance avec consigne

    public static let retryTitle = L10n.text("Relancer la feature")
    public static let retryInstructionsLabel = L10n.text("Consigne pour la relance (facultative)")
    public static let retryInstructionsHint = L10n.text("Elle rejoint les instructions de l’étape qui reprend.")

    // MARK: - Budget d'une feature

    public static let budgetTitle = L10n.text("Budget de la feature")
    public static let budgetAction = L10n.text("Modifier le budget…")
    public static let budgetLabel = L10n.text("Budget (en dollars)")
    public static let budgetPrompt = L10n.text("Par exemple : 5")
    public static let budgetSave = L10n.text("Enregistrer le budget")
    public static let budgetReset = L10n.text("Revenir au budget du serveur")
    public static let budgetInvalid = L10n.text("Un montant positif d’au plus 10 000 dollars.")
    public static let budgetHint = L10n.text("Au-delà, la feature s’arrête et attend votre accord. Sans budget propre, celui du serveur s’applique.")
    public static let budgetSymbol = "dollarsign.circle"
    public static let budgetNone = L10n.text("Sans plafond")

    /// « Dépensé : 1,24 $ ».
    public static func spent(_ amount: String) -> String { L10n.format("Dépensé : %@", amount) }
    /// « Plafond : 5,00 $ (propre à la feature) » ou « (celui du serveur) ».
    public static func ceiling(_ amount: String, own: Bool) -> String {
        own ? L10n.format("Plafond : %@ (propre à la feature)", amount) : L10n.format("Plafond : %@ (celui du serveur)", amount)
    }

    // MARK: - File d'admission

    public static let queueTitle = L10n.text("File d’attente")
    public static let queueSymbol = "hourglass"

    /// Le nom d'une cause qui retient une feature en file.
    public static func waitCause(_ raw: String) -> String {
        switch raw {
        case "memory": L10n.text("Mémoire du serveur insuffisante")
        case "slots": L10n.text("Plus de place pour un agent")
        case "repo_cap": L10n.text("Plafond du dépôt atteint")
        case "modules": L10n.text("Modules partagés avec une feature en cours")
        case "daily_budget": L10n.text("Plafond de dépense du jour atteint")
        case "unknown_repo": L10n.text("Dépôt retiré du serveur")
        default: raw
        }
    }

    /// « 3 features retenues en file ».
    public static func held(_ count: Int) -> String {
        count == 1 ? L10n.text("1 feature retenue en file") : L10n.format("%lld features retenues en file", count)
    }

    // MARK: - Poste : arrêt d'urgence

    public static let stop = L10n.text("Arrêt d’urgence")
    public static let stopSymbol = "stop.circle.fill"
    public static let stopConfirm = L10n.text("Arrêter le poste maintenant ?")
    public static let stopMessage = L10n.text("Le poste passe en pause, toute action en file, en cours ou à approuver est annulée, et l’agent 24/24 s’interrompt. Seul l’appareil approbateur peut le reprendre.")
    public static let stopHint = L10n.text("Toujours permis, quel que soit le jeton de cet appareil.")
    public static let resume = L10n.text("Reprendre le poste")

    /// « Arrêté le 7 nov. 2026 à 22:05 par mac-millian ».
    public static func stopped(_ date: String, by: String) -> String { L10n.format("Arrêté le %@ par %@", date, by) }

    // MARK: - Poste : détail d'une action

    public static let actionTitle = L10n.text("Action du poste")
    public static let actionOpen = L10n.text("Détail")
    public static let actionCancel = L10n.text("Annuler l’action")
    public static let actionCancelConfirm = L10n.text("Annuler cette action ?")
    public static let actionParams = L10n.text("Paramètres")
    public static let actionResult = L10n.text("Résultat")
    public static let actionData = L10n.text("Données")
    public static let actionCapture = L10n.text("Capture")
    public static let noCapture = L10n.text("Aucune capture gardée pour cette action (elles s’effacent après quelques heures).")
    public static let actionLoading = L10n.text("Lecture de l’action…")
    public static let captureLabel = L10n.text("Capture d’écran de l’onglet")

    /// « Action n° 42 ».
    public static func actionNumber(_ seq: Int) -> String { L10n.format("Action n° %lld", seq) }

    // MARK: - Poste : réunions

    public static let meetingTitle = L10n.text("Réunion")
    public static let transcript = L10n.text("Transcription")
    public static let noTranscript = L10n.text("Aucune transcription gardée pour cette réunion.")
    public static let needs = L10n.text("Besoins relevés")
    public static let speakerSelf = L10n.text("Vous")
    public static let speakerOthers = L10n.text("Les autres")

    /// Qui parle dans une transcription.
    public static func speaker(isSelf: Bool) -> String { isSelf ? speakerSelf : speakerOthers }

    // MARK: - Poste : sessions des jobs

    public static let sessionsTitle = L10n.text("Sessions de l’agent 24/24")
    public static let sessionsHint = L10n.text("Ce que l’agent du poste lit et décide, comme le direct d’une feature.")

    /// Le nom d'un job du poste.
    public static func job(_ raw: String) -> String {
        switch raw {
        case "profil": L10n.text("Établissement du profil")
        case "digest": L10n.text("Résumé des réunions")
        case "service": L10n.text("Service de l’agent 24/24")
        default: raw
        }
    }

    // MARK: - Poste : commander une action

    public static let commandTitle = L10n.text("Commander le navigateur")
    public static let commandKind = L10n.text("Geste")
    public static let commandOpen = L10n.text("Ouvrir une page")
    public static let commandNavigate = L10n.text("Changer la page d’un onglet")
    public static let commandURL = L10n.text("Adresse")
    public static let commandURLPrompt = L10n.text("exemple.fr/factures")
    public static let commandTab = L10n.text("Onglet (numéro)")
    public static let commandRationale = L10n.text("Pourquoi (gardé au journal)")
    public static let commandSend = L10n.text("Envoyer l’action")
    public static let commandHint = L10n.text("L’action part dans la fenêtre de l’agent ; un hôte hors de la liste permise attend l’approbation.")

    /// « Action n° 42 : En file ».
    public static func commandSent(_ seq: Int, state: String) -> String { L10n.format("Action n° %lld : %@", seq, state) }

    // MARK: - Poste : demandes

    public static let requestsTitle = L10n.text("Demandes au poste")
    public static let requestPrompt = L10n.text("Par exemple : télécharge la dernière facture du fournisseur")
    public static let requestSend = L10n.text("Demander")
    public static let requestCancel = L10n.text("Annuler la demande")
    public static let requestsHint = L10n.text("L’agent mène chaque demande dans votre navigateur, une à la fois ; un envoi à un tiers attend toujours votre approbation.")
    public static let noRequest = L10n.text("Aucune demande pour l’instant.")
    public static let requestReport = L10n.text("Compte rendu")
    public static let requestSymbol = "text.badge.plus"

    /// L'état d'une demande.
    public static func requestState(_ raw: String) -> String {
        switch raw {
        case "queued": L10n.text("En file")
        case "running": L10n.text("En cours")
        case "done": L10n.text("Faite")
        case "failed": L10n.text("Échouée")
        case "cancelled": L10n.text("Annulée")
        default: raw
        }
    }

    // MARK: - Poste : automatisations

    public static let automationsTitle = L10n.text("Automatisations")
    public static let automationsHint = L10n.text("Une tâche répétitive du profil gardée comme consigne : lancée à la demande, ou à chaque échéance de son expression cron.")
    public static let noAutomation = L10n.text("Aucune automatisation : automatisez une tâche répétitive du profil.")
    public static let automate = L10n.text("Automatiser")
    public static let automationLaunch = L10n.text("Lancer")
    public static let automationDelete = L10n.text("Supprimer l’automatisation")
    public static let automationDeleteConfirm = L10n.text("Supprimer cette automatisation ?")
    public static let automationDeleteMessage = L10n.text("Ses demandes passées restent au journal.")
    public static let cronLabel = L10n.text("Expression cron (facultative)")
    public static let cronPrompt = L10n.text("0 8 * * 1-5")
    public static let automatableTasks = L10n.text("Tâches à automatiser")

    /// « Chaque échéance de 0 8 * * 1-5 ».
    public static func scheduled(_ cron: String) -> String { L10n.format("Planifiée : %@", cron) }

    // MARK: - Poste : navigateurs et navigation gardée

    public static let browsersTitle = L10n.text("Navigateurs")
    public static let noBrowser = L10n.text("Aucun navigateur appairé : installez l’extension Chrome et appairez-la.")
    public static let defaultBrowser = L10n.text("Navigateur par défaut")
    public static let defaultBrowserHint = L10n.text("Il reçoit les actions, demandes et automatisations qui n’en ciblent aucun.")
    public static let firstSeen = L10n.text("Le premier vu")
    public static let browserTarget = L10n.text("Navigateur")
    public static let isDefault = L10n.text("Par défaut")
    public static let navigationTitle = L10n.text("Navigation gardée")
    public static let allowedHosts = L10n.text("Hôtes permis sans approbation")
    public static let allowedHostsPrompt = L10n.text("Un hôte par ligne (exemple.fr couvre ses sous-domaines)")
    public static let allowedHostsHint = L10n.text("Vide : tout hôte. Une adresse hors de la liste attend l’approbation, quelle que soit l’origine de l’action.")
    public static let allowedHostsSave = L10n.text("Enregistrer les hôtes")
    public static let exfiltrationGuard = L10n.text("Garde anti-exfiltration de l’agent 24/24")
    public static let exfiltrationGuardHint = L10n.text("Retient pour approbation une adresse vers un hôte jamais vu, ou dont la requête porte une valeur longue ou opaque.")
    public static let backToConfig = L10n.text("Revenir à la configuration du serveur")
    public static let fromConfig = L10n.text("Selon la configuration du serveur")
    public static let fromSetting = L10n.text("Réglé depuis une app")
    public static let navigationApproverHint = L10n.text("Seul l’appareil approbateur règle la navigation et le navigateur par défaut.")

    // MARK: - Vigie

    public static let vigieSilent = L10n.text("La vigie ne donne plus signe de vie : son conteneur est peut-être arrêté.")
    public static let vigieSilentSymbol = "exclamationmark.octagon.fill"
    public static let vigieNeverSeen = L10n.text("La vigie ne s’est encore jamais signalée.")
    public static let vigieStateTitle = L10n.text("État de la vigie")
    public static let vigieSettingsTitle = L10n.text("Réglages de la vigie")
    public static let vigieMode = L10n.text("Mode")
    public static let vigieMaxIssues = L10n.text("Issues publiées par jour, au plus")
    public static let vigieMaxRuns = L10n.text("Corrections en cours, au plus")
    public static let vigieBudget = L10n.text("Budget du jour (en dollars)")
    public static let vigieRepos = L10n.text("Dépôts surveillés")
    public static let vigieReposPrompt = L10n.text("Noms des dépôts, séparés par des virgules")
    public static let vigieSave = L10n.text("Enregistrer les réglages")
    public static let vigieAdminHint = L10n.text("Seul un administrateur règle la vigie ; elle publie sur le dépôt public, caviardée par le serveur.")
    public static let incidentsTitle = L10n.text("Incidents")
    public static let noIncident = L10n.text("Aucun incident relevé.")
    public static let allStatuses = L10n.text("Tous")
    public static let fingerprint = L10n.text("Empreinte")
    public static let fixRun = L10n.text("Feature de correction")
    public static let incidentRun = L10n.text("Feature concernée")

    /// Le nom d'un mode de la vigie.
    public static func vigieMode(_ raw: String) -> String {
        switch raw {
        case "off": L10n.text("Coupée")
        case "shadow": L10n.text("Discrète")
        case "report": L10n.text("Signalement")
        case "fix": L10n.text("Correction")
        default: raw
        }
    }

    /// Ce que fait un mode de la vigie, en une phrase.
    public static func vigieModeHint(_ raw: String) -> String? {
        switch raw {
        case "off": L10n.text("Rien n’est relevé.")
        case "shadow": L10n.text("Tout est relevé en incidents, l’issue qu’elle publierait comprise ; rien ne sort.")
        case "report": L10n.text("Publication d’une issue caviardée pour chaque bogue trié.")
        case "fix": L10n.text("Publication de l’issue, puis correction conduite par la vigie.")
        default: nil
        }
    }

    /// Le statut d'un incident.
    public static func incidentStatus(_ raw: String) -> String {
        switch raw {
        case "new": L10n.text("Nouveau")
        case "noise": L10n.text("Bruit")
        case "bug": L10n.text("Bogue")
        case "reported": L10n.text("Publié")
        case "fixing": L10n.text("En correction")
        case "watching": L10n.text("Sous surveillance")
        case "resolved": L10n.text("Résolu")
        case "deferred": L10n.text("Rendu à l’humain")
        default: raw
        }
    }

    /// « Dernier battement il y a 2 minutes · version 1.2.0 ».
    public static func heartbeat(_ relative: String) -> String { L10n.format("Dernier battement %@", relative) }
    /// « Issues du jour : 2 sur 5 ».
    public static func todayIssues(_ count: Int, of max: Int) -> String { L10n.format("Issues du jour : %lld sur %lld", count, max) }
    /// « Corrections en cours : 1 sur 2 ».
    public static func todayRuns(_ count: Int, of max: Int) -> String { L10n.format("Corrections en cours : %lld sur %lld", count, max) }
    /// « Dépensé aujourd'hui : 1,20 $ sur 10,00 $ ».
    public static func todaySpent(_ spent: String, of budget: String) -> String { L10n.format("Dépensé aujourd’hui : %@ sur %@", spent, budget) }
    /// « 4 occurrences, la dernière il y a 3 minutes ».
    public static func occurrences(_ count: Int, last: String) -> String {
        count == 1 ? L10n.format("1 occurrence, %@", last) : L10n.format("%lld occurrences, la dernière %@", count, last)
    }
    /// « Issue n° 12 ».
    public static func issueNumber(_ number: Int) -> String { L10n.format("Issue n° %lld", number) }
    /// « Bogue : 3 » : un compte sous son nom (statut d'incident, cause d'une file).
    public static func countLine(_ label: String, count: Int) -> String { L10n.format("%@ : %lld", label, count) }

    // MARK: - Planifications

    public static let noSchedule = L10n.text("Aucune planification : créez-en une pour que le serveur travaille seul à heure fixe.")
    public static let newSchedule = L10n.text("Nouvelle planification")
    public static let scheduleName = L10n.text("Nom")
    public static let scheduleNamePrompt = L10n.text("Par exemple : audit du lundi")
    public static let scheduleCron = L10n.text("Expression cron")
    public static let scheduleCronPrompt = L10n.text("minute heure jour mois jour-de-semaine")
    public static let scheduleCronHint = L10n.text("Cinq champs : « 0 8 * * 1 » chaque lundi à 8 h, « 30 2 * * * » chaque nuit à 2 h 30, « 0 */6 * * * » toutes les 6 heures.")
    public static let scheduleTarget = L10n.text("Cible")
    public static let scheduleRepo = L10n.text("Dépôt")
    public static let scheduleTitle = L10n.text("Titre de la feature")
    public static let scheduleRequest = L10n.text("Demande")
    public static let scheduleFocus = L10n.text("Périmètre de l’audit (facultatif)")
    public static let scheduleLabel = L10n.text("Label des issues (facultatif)")
    public static let scheduleBudget = L10n.text("Budget de chaque feature (facultatif, en dollars)")
    public static let scheduleEnabled = L10n.text("Active")
    public static let scheduleCreate = L10n.text("Créer la planification")
    public static let scheduleRunNow = L10n.text("Déclencher maintenant")
    public static let scheduleDelete = L10n.text("Supprimer")
    public static let scheduleDeleteConfirm = L10n.text("Supprimer cette planification ?")
    public static let scheduleDeleteMessage = L10n.text("Ses échéances futures ne partiront plus ; ce qu’elle a lancé continue.")
    public static let scheduleDisabled = L10n.text("Désactivée")
    public static let scheduleProblemName = L10n.text("Donnez un nom à la planification.")
    public static let scheduleProblemCron = L10n.text("L’expression cron a cinq champs séparés par des espaces.")
    public static let scheduleProblemRepo = L10n.text("Choisissez un dépôt.")
    public static let scheduleProblemRequest = L10n.text("Une feature planifiée a un titre et une demande.")

    /// Le nom d'une cible de planification.
    public static func scheduleKind(_ raw: String) -> String {
        switch raw {
        case "run": L10n.text("Une feature")
        case "audit": L10n.text("Un audit")
        case "issues": L10n.text("La relève des issues")
        case "automation": L10n.text("Une automatisation du poste")
        default: raw
        }
    }

    /// L'issue d'une échéance.
    public static func outcome(_ raw: String) -> String {
        switch raw {
        case "fired": L10n.text("Lancée")
        case "busy": L10n.text("Sautée : la précédente n’est pas finie")
        case "daily_budget": L10n.text("Sautée : plafond du jour atteint")
        case "missed": L10n.text("Manquée pendant un arrêt du serveur")
        case "failed": L10n.text("Échouée")
        default: raw
        }
    }

    /// « Prochaine échéance le 10 nov. 2026 à 08:00 (Europe/Paris) ».
    public static func nextRun(_ date: String, timezone: String) -> String { L10n.format("Prochaine échéance le %@ (%@)", date, timezone) }
    /// « Dernière échéance le 3 nov. 2026 à 08:00 : Lancée ».
    public static func lastRun(_ date: String, outcome: String) -> String { L10n.format("Dernière échéance le %@ : %@", date, outcome) }
    /// « Déclenchée : Lancée ».
    public static func fired(_ outcome: String) -> String { L10n.format("Déclenchée : %@", outcome) }
    /// « Créée par mac-millian ».
    public static func createdBy(_ who: String) -> String { L10n.format("Créée par %@", who) }

    // MARK: - Administration

    public static let clientsTitle = L10n.text("Clients du serveur")
    public static let clientName = L10n.text("Nom du client")
    public static let clientNamePrompt = L10n.text("Par exemple : ipad-salon")
    public static let clientRole = L10n.text("Rôle")
    public static let clientRepos = L10n.text("Dépôts permis")
    public static let clientAllRepos = L10n.text("Tous les dépôts")
    public static let clientCreate = L10n.text("Créer le client")
    public static let clientRevoke = L10n.text("Révoquer")
    public static let clientRevokeConfirm = L10n.text("Révoquer ce client ?")
    public static let clientRevokeMessage = L10n.text("Son jeton cesse aussitôt de servir ; les appareils qui l’emploient perdent l’accès.")
    public static let clientToken = L10n.text("Jeton du nouveau client")
    public static let clientTokenHint = L10n.text("Copiez-le maintenant : il ne sera plus jamais montré.")
    public static let approverBadge = L10n.text("Approbateur")
    public static let pilotBadge = L10n.text("Pilote")
    public static let reposTitle = L10n.text("Dépôts déclarés")
    public static let repoURL = L10n.text("Adresse du dépôt")
    public static let repoURLPrompt = L10n.text("git@github.com:moi/projet.git")
    public static let repoShortName = L10n.text("Nom court (facultatif)")
    public static let repoAdd = L10n.text("Ajouter le dépôt")
    public static let deployKey = L10n.text("Clé de déploiement à poser")
    public static let deployKeyHint = L10n.text("Posez cette clé publique, en écriture, sur le dépôt, puis ajoutez-le de nouveau.")
    public static let deployKeyOpen = L10n.text("Ouvrir la page des clés")
    public static let reloadTitle = L10n.text("Configuration")
    public static let reload = L10n.text("Recharger la configuration")
    public static let reloadHint = L10n.text("Relit le fichier de configuration du serveur ; invalide, rien ne change.")
    public static let errorsTitle = L10n.text("Erreurs des clients")
    public static let noClientError = L10n.text("Aucune erreur remontée.")
    public static let allSources = L10n.text("Toutes les sources")

    /// Le nom d'un rôle de client.
    public static func role(_ raw: String) -> String {
        switch raw {
        case "viewer": L10n.text("Lecteur")
        case "operator": L10n.text("Opérateur")
        case "admin": L10n.text("Administrateur")
        default: raw
        }
    }

    /// Le nom d'une source d'erreur.
    public static func source(_ raw: String) -> String {
        switch raw {
        case "mac": L10n.text("App Mac")
        case "ios": L10n.text("App iOS")
        case "chrome": L10n.text("Extension Chrome")
        case "omp": L10n.text("OMP")
        case "vigie": L10n.text("Vigie")
        default: raw
        }
    }

    /// « Ajouté : demo » ou « Pas encore servi : demo ».
    public static func repoDeclared(_ name: String, added: Bool) -> String {
        added ? L10n.format("Ajouté : %@", name) : L10n.format("Pas encore servi : %@", name)
    }

    /// « Servis : a, b · ajoutés : c · retirés : d ».
    public static func reloaded(repos: [String], added: [String], removed: [String]) -> String {
        let none = L10n.text("aucun")
        return L10n.format("Servis : %@ · ajoutés : %@ · retirés : %@",
            repos.isEmpty ? none : repos.joined(separator: ", "),
            added.isEmpty ? none : added.joined(separator: ", "),
            removed.isEmpty ? none : removed.joined(separator: ", ")
        )
    }

    // MARK: - Issues

    public static let noIssue = L10n.text("Aucune issue ouverte sur ce dépôt.")
    public static let issuesRepo = L10n.text("Dépôt")
    public static let fix = L10n.text("Corriger")
    public static let issueCarried = L10n.text("Une feature la porte déjà.")
    public static let issuesHint = L10n.text("« Corriger » lance une feature qui corrige l’issue ; une issue déjà portée par une feature vivante ou fusionnée n’est pas relancée.")
    public static let issueOpen = L10n.text("Ouvrir l’issue")

    /// « Feature lancée pour l'issue n° 12 » ou « déjà portée ».
    public static func fixed(_ number: Int, launched: Bool) -> String {
        launched ? L10n.format("Feature lancée pour l’issue n° %lld.", number) : L10n.format("L’issue n° %lld est déjà portée par une feature.", number)
    }

    /// « n° 12 · ouverte par paul ».
    public static func issueLine(_ number: Int, author: String?) -> String {
        guard let author, !author.isEmpty else { return L10n.format("n° %lld", number) }
        return L10n.format("n° %lld · ouverte par %@", number, author)
    }
}
