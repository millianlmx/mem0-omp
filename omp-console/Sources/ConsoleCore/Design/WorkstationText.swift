// Le vocabulaire de la section « Poste » (le poste de travail : l'extension Chrome
// qui observe et agit dans le navigateur, l'agent 24/24 du serveur), partagé par la
// coque Mac et l'app iOS : état de l'extension, autonomie, envois à approuver, pages
// poussées (réglages, profil, journal…), journal des décisions et réunions. Les mots
// qui existent ailleurs (Refuser, Raison, Annuler, Envoyer) se reprennent de
// `PipelineServerText`.
//
// Les codes du serveur (sorte d'action, état, origine, autonomie) se traduisent ici,
// une seule fois pour les deux apps ; un code inconnu de cette version se rend tel quel.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?) et glossaire GLOSSAIRE.md.

public enum WorkstationText {
    // MARK: - Extension et observation

    public static let online = L10n.text("Extension en ligne")
    public static let offline = L10n.text("Extension hors ligne")
    public static let onlineSymbol = "dot.radiowaves.left.and.right"
    public static let offlineSymbol = "wifi.slash"
    public static let neverSeen = L10n.text("L’extension Chrome ne s’est encore jamais connectée : appairez-la avec le code du serveur.")
    public static let statusTitle = L10n.text("Extension et agent 24/24")
    public static let observedTitle = L10n.text("Observation")
    public static let observedHint = L10n.text("En mode Auto, l’agent 24/24 commence à agir une fois le seuil atteint.")
    public static let absent = L10n.text("Ce serveur ne connaît pas encore le poste de travail : mettez omp-harness à jour.")

    // MARK: - Page principale et pages poussées

    public static let askTitle = L10n.text("Demander au poste")
    public static let settingsTitle = L10n.text("Réglages")
    public static let settingsSymbol = "slider.horizontal.3"
    public static let commandSymbol = "safari"
    public static let profileSymbol = "person.text.rectangle"
    public static let meetingsSymbol = "person.2.wave.2"
    public static let journalSymbol = "list.bullet.rectangle"
    public static let requestsSymbol = "text.bubble"
    public static let allJournal = L10n.text("Tout le journal")
    public static let allRequests = L10n.text("Toutes les demandes")
    /// L'état du poste mis en pause depuis une app (pas un arrêt d'urgence).
    public static let paused = L10n.text("En pause")
    public static let resumeSymbol = "play.circle.fill"

    /// « Dernier contact il y a 2 minutes ».
    public static func lastSeen(_ relative: String) -> String { L10n.format("Dernier contact %@", relative) }
    /// « Version 0.3.1 » de l'extension.
    public static func version(_ value: String) -> String { L10n.format("Version %@", value) }
    /// « 3 h et 12 min observées sur 8 h ».
    public static func observed(seconds: Double, thresholdHours: Double) -> String {
        let observed = ConsoleFormat.duration(ms: seconds * 1000)
        return L10n.format("%@ observées sur %@", observed, ConsoleFormat.duration(ms: thresholdHours * 3_600_000))
    }

    /// « 2 h et 5 min » : un temps observé (un site, une heure de la journée).
    public static func observedTime(seconds: Double) -> String { ConsoleFormat.duration(ms: seconds * 1000) }

    // MARK: - Autonomie

    public static let autonomyLabel = L10n.text("Autonomie")
    public static let autonomyAuto = L10n.text("Auto")
    public static let autonomyObserve = L10n.text("Observer")
    public static let autonomyPropose = L10n.text("Proposer")
    public static let autonomyAct = L10n.text("Agir")
    public static let autonomyAutoHint = L10n.text("Observe jusqu’au seuil d’heures, puis agit seul.")
    public static let autonomyObserveHint = L10n.text("L’agent 24/24 ne fait rien ; le profil continue de s’établir.")
    public static let autonomyProposeHint = L10n.text("Chaque action de l’agent 24/24 attend votre approbation.")
    public static let autonomyActHint = L10n.text("L’agent 24/24 fait seul les petites actions.")
    /// L'invariant du poste, dit sous le choix de l'autonomie : aucun mode ne le lève.
    public static let sendGuard = L10n.text("Quel que soit le mode, envoyer un message à quelqu’un d’autre que vous demande toujours votre approbation. Sans réponse, l’envoi est refusé.")
    public static let sendGuardSymbol = "hand.raised"

    /// Le nom d'un réglage d'autonomie du serveur.
    public static func autonomy(_ raw: String) -> String {
        switch raw {
        case "auto": autonomyAuto
        case "observe": autonomyObserve
        case "propose": autonomyPropose
        case "act": autonomyAct
        default: raw
        }
    }

    /// Ce que fait un réglage d'autonomie, en une phrase.
    public static func autonomyHint(_ raw: String) -> String? {
        switch raw {
        case "auto": autonomyAutoHint
        case "observe": autonomyObserveHint
        case "propose": autonomyProposeHint
        case "act": autonomyActHint
        default: nil
        }
    }

    /// « Appliqué : Observer » — l'autonomie effective quand le réglage est Auto.
    public static func effective(_ name: String) -> String { L10n.format("Appliqué : %@", name) }

    // MARK: - Pause et identités

    public static let pauseLabel = L10n.text("Mettre le poste en pause")
    public static let pauseHint = L10n.text("En pause, aucune action ne part et l’observation est refusée.")
    public static let pausedSymbol = "pause.circle"
    public static let identitiesLabel = L10n.text("Vos adresses et pseudos")
    public static let identitiesPrompt = L10n.text("Une adresse ou un pseudo par ligne")
    public static let identitiesHint = L10n.text("Un message dont tous les destinataires sont dans cette liste part sans approbation : c’est un message à vous-même.")
    public static let identitiesSave = L10n.text("Enregistrer les adresses")

    // MARK: - Agent 24/24

    /// « Dernier passage de l'agent le 29 oct. 2026 à 14:05 : 3 actions » (« 1 action »).
    public static func lastShift(_ date: String, actions: Int) -> String {
        actions == 1
            ? L10n.format("Dernier passage de l’agent le %@ : 1 action", date)
            : L10n.format("Dernier passage de l’agent le %@ : %lld actions", date, actions)
    }

    /// « Prochain passage le 29 oct. 2026 à 14:35 ».
    public static func nextShift(_ date: String) -> String { L10n.format("Prochain passage le %@", date) }

    // MARK: - À approuver

    public static let approvalsTitle = L10n.text("Envois à approuver")
    public static let approvalsHint = L10n.text("L’agent attend votre accord avant d’envoyer ces messages. Sans réponse, l’envoi expire et vaut refus.")
    public static let approve = L10n.text("Approuver l’envoi")
    public static let refuseTitle = L10n.text("Refuser l’envoi")
    public static let refuseHint = L10n.text("La raison, facultative, est gardée au journal des décisions.")
    public static let unknownRecipients = L10n.text("Destinataires inconnus")
    public static let previewLabel = L10n.text("Message")
    /// L'envoi a changé entre son affichage et le geste (autre appareil, brouillon recalculé).
    public static let approvalChanged = L10n.text("L’envoi a changé depuis son affichage : relisez-le avant d’approuver.")
    /// Le jeton de cette app n'est pas l'approbateur (403 `APPROVER_ONLY` du serveur) : où obtenir le bon.
    public static let approverOnly = L10n.text("Seul l’appareil approbateur peut approuver, refuser ou régler le poste : appairez cette app avec le code approbateur : harness.sh approver sur le VPS, omp-harness-stack approver dans la console du conteneur harness (Portainer), ou le jeton de sudo omp-harness-client approver (systemd).")
    /// Une action proposée par l'agent 24/24 (autonomie « Proposer ») : un geste, pas un envoi.
    public static let proposal = L10n.text("Action proposée par l’agent 24/24")
    public static let proposalHint = L10n.text("Approuver ce geste n’autorise aucun envoi de message : un envoi demandera sa propre approbation.")
    public static let proposalSymbol = "lightbulb"

    /// « À : paul@exemple.fr, Marie ».
    public static func recipients(_ list: [String]) -> String {
        list.isEmpty ? unknownRecipients : L10n.format("À : %@", list.joined(separator: ", "))
    }

    // MARK: - Profil

    public static let profileTitle = L10n.text("Profil")
    public static let noProfile = L10n.text("Le profil s’établit après quelques heures d’observation.")
    public static let habits = L10n.text("Habitudes")
    public static let tools = L10n.text("Outils")
    public static let schedule = L10n.text("Horaires")
    public static let repetitiveTasks = L10n.text("Tâches répétitives")
    public static let clientNeeds = L10n.text("Besoins des clients")
    public static let preferences = L10n.text("Préférences")
    public static let automatable = L10n.text("Automatisable")
    public static let automatableSymbol = "gearshape.2"
    public static let rebuild = L10n.text("Reconstruire le profil")
    public static let rebuildQueued = L10n.text("Reconstruction demandée : le profil se met à jour d’ici quelques minutes.")

    /// « Version 4, mise à jour il y a 3 heures ».
    public static func profileVersion(_ version: Int, updated: String) -> String {
        L10n.format("Version %lld, mise à jour %@", version, updated)
    }

    /// « Pour Paul Martin ».
    public static func forWhom(_ who: String) -> String { L10n.format("Pour %@", who) }

    /// « Échéance : vendredi ».
    public static func due(_ when: String) -> String { L10n.format("Échéance : %@", when) }

    /// « « il me le faut vendredi » » : la citation qui porte un besoin.
    public static func quote(_ text: String) -> String { L10n.format("« %@ »", text) }

    // MARK: - Activité observée

    public static let activityTitle = L10n.text("Activité observée")
    public static let noActivity = L10n.text("Aucune activité observée pour l’instant.")
    public static let topSites = L10n.text("Sites les plus fréquentés")
    public static let activeHours = L10n.text("Heures actives")
    public static let sequences = L10n.text("Enchaînements récurrents")
    public static let axisSite = L10n.text("Site")
    public static let axisTime = L10n.text("Temps")
    public static let axisHour = L10n.text("Heure")

    /// « Depuis le 20 oct. 2026 à 09:12 ».
    public static func since(_ date: String) -> String { L10n.format("Depuis le %@", date) }

    /// « 9 h », une heure de la journée sur l'axe des heures actives.
    public static func hour(_ value: Int) -> String { L10n.format("%lld h", value) }

    /// « mail.google.com : 2 h et 5 min (34 %) », la valeur d'une barre pour VoiceOver.
    public static func siteShare(_ site: String, seconds: Double, share: Double) -> String {
        L10n.format("%@ : %@ (%@)", site, observedTime(seconds: seconds), PipelineServerText.percent(share))
    }

    /// « 4 fois » : la récurrence d'un enchaînement.
    public static func times(_ count: Int) -> String { L10n.format("%lld fois", count) }

    // MARK: - Journal des décisions

    public static let journalTitle = L10n.text("Journal des décisions")
    public static let journalHint = L10n.text("Chaque action et chaque décision, avec sa raison, la plus récente d’abord.")
    public static let noAction = L10n.text("Aucune décision au journal.")
    public static let originSession = L10n.text("Session")
    public static let originAgent = L10n.text("Agent 24/24")

    /// La sorte d'une action, en français.
    public static func kind(_ raw: String) -> String {
        switch raw {
        case "tabs": L10n.text("Lister les onglets")
        case "open": L10n.text("Ouvrir une page")
        case "navigate": L10n.text("Changer de page")
        case "snapshot": L10n.text("Lire la page")
        case "click": L10n.text("Cliquer")
        case "type": L10n.text("Saisir du texte")
        case "key": L10n.text("Appuyer sur une touche")
        case "scroll": L10n.text("Faire défiler")
        case "screenshot": L10n.text("Capturer l’écran")
        case "wait": L10n.text("Attendre")
        case "close": L10n.text("Fermer un onglet")
        case "select": L10n.text("Choisir une option")
        case "hover": L10n.text("Survoler")
        case "back": L10n.text("Revenir à la page précédente")
        case "forward": L10n.text("Aller à la page suivante")
        case "reload": L10n.text("Recharger la page")
        case "wait_for": L10n.text("Attendre un élément")
        case "upload": L10n.text("Joindre un fichier")
        case "download": L10n.text("Télécharger un fichier")
        case "decision": L10n.text("Décision")
        default: raw
        }
    }

    /// L'état d'une action, en français.
    public static func state(_ raw: String) -> String {
        switch raw {
        case "queued": L10n.text("En file")
        case "running": L10n.text("En cours")
        case "awaiting_approval": L10n.text("À approuver")
        case "done": L10n.text("Faite")
        case "failed": L10n.text("Échouée")
        case "refused": L10n.text("Refusée")
        case "expired": L10n.text("Expirée")
        default: raw
        }
    }

    /// Qui a déposé l'action : une session OMP, ou l'agent 24/24 du serveur.
    public static func origin(_ raw: String) -> String {
        switch raw {
        case "session": originSession
        case "agent": originAgent
        default: raw
        }
    }

    /// « Approuvé par iphone-paul ».
    public static func approvedBy(_ who: String) -> String { L10n.format("Approuvé par %@", who) }

    /// « Refusé par iphone-paul ».
    public static func refusedBy(_ who: String) -> String { L10n.format("Refusé par %@", who) }

    /// « Raison : pas avant lundi ».
    public static func reason(_ text: String) -> String { L10n.format("Raison : %@", text) }

    /// « Erreur : l'extension n'a pas rendu le résultat ».
    public static func error(_ text: String) -> String { L10n.format("Erreur : %@", text) }

    /// « Résultat : 3 onglets ».
    public static func result(_ text: String) -> String { L10n.format("Résultat : %@", text) }

    // MARK: - Réunions

    public static let meetingsTitle = L10n.text("Réunions")
    public static let noMeeting = L10n.text("Aucune réunion transcrite.")

    /// L'état d'une réunion, en français.
    public static func meetingState(_ raw: String) -> String {
        switch raw {
        case "live": L10n.text("En direct")
        case "ended": L10n.text("Terminée")
        case "digested": L10n.text("Résumée")
        case "failed": L10n.text("Résumé en échec")
        default: raw
        }
    }

    /// « 42 segments transcrits ».
    public static func segments(_ count: Int) -> String {
        count == 1 ? L10n.text("1 segment transcrit") : L10n.format("%lld segments transcrits", count)
    }
}

/// Le vocabulaire du pont corpo ↔ usine : les signalements des collègues devenus
/// propositions dans « À traiter », leur feuille de confirmation, et l’origine d’une
/// feature lancée depuis l’une d’elles. Les codes du serveur (canal, sorte, politique)
/// se traduisent ici ; un code inconnu de cette version se rend tel quel.
public enum SignalText {
    // MARK: - À traiter

    public static let sectionTitle = L10n.text("Signalements de collègues")
    public static let sectionHint = L10n.text("Chaque proposition vient du message d’un collègue. Rien n’est créé sur la forge avant votre confirmation.")
    public static let sectionSymbol = "person.bubble"
    public static let review = L10n.text("Relire et confirmer")
    public static let reviewSymbol = "doc.text.magnifyingglass"
    /// « Ouvrir une issue et lancer un correctif dans demo ».
    public static func proposal(repo: String?) -> String {
        guard let repo, !repo.isEmpty else { return L10n.text("Ouvrir une issue et lancer un correctif") }
        return L10n.format("Ouvrir une issue et lancer un correctif dans %@", repo)
    }

    /// « Signalé par paul@exemple.fr ».
    public static func reportedBy(_ person: String) -> String { L10n.format("Signalé par %@", person) }
    /// La dernière confirmation a échoué : le motif du serveur, tel quel.
    public static func lastError(_ error: String) -> String { L10n.format("La dernière confirmation a échoué : %@", error) }
    public static let approverOnly = L10n.text("Seul l’appareil approbateur peut confirmer ou écarter une proposition : appairez cette app avec le code approbateur (harness.sh approver sur le VPS).")

    // MARK: - Feuille de confirmation

    public static let sheetTitle = L10n.text("Proposition d’issue")
    public static let messageHeader = L10n.text("Message du collègue")
    public static let draftHeader = L10n.text("Votre texte")
    public static let repoLabel = L10n.text("Dépôt")
    public static let titleLabel = L10n.text("Titre")
    public static let bodyLabel = L10n.text("Description")
    public static let sentHeader = L10n.text("Ce qui partira à la forge")
    public static let sentHint = L10n.text("Le serveur caviarde votre texte : voici exactement le titre et la description que la forge recevra.")
    public static let previewing = L10n.text("Lecture de l’aperçu…")
    public static let confirm = L10n.text("Confirmer")
    public static let dismiss = L10n.text("Écarter la proposition")
    public static let dismissHint = L10n.text("Une proposition écartée n’est jamais reproposée pour ce fil.")
    /// « Issue n° 12 déjà créée dans demo ».
    public static func issueExists(repo: String, number: Int) -> String {
        L10n.format("Issue n° %lld déjà créée dans %@ : elle n’est pas renvoyée à la forge.", number, repo)
    }

    /// La politique `issues.corporate` appliquée au dépôt.
    public static func policy(_ applied: String) -> String {
        switch applied {
        case "redacted": L10n.text("Texte caviardé")
        case "full": L10n.text("Texte complet (dépôt privé)")
        default: applied
        }
    }

    /// La sorte de la proposition.
    public static func kind(_ raw: String) -> String {
        switch raw {
        case "bug": L10n.text("Bogue")
        case "feature": L10n.text("Nouvelle feature")
        default: raw
        }
    }

    // MARK: - Origine d’une feature

    public static let originTitle = L10n.text("Origine")
    public static let channelLabel = L10n.text("Canal")
    public static let personLabel = L10n.text("Signalé par")
    public static let threadLabel = L10n.text("Fil")
    public static let excerptLabel = L10n.text("Extrait")
    public static let issueLabel = L10n.text("Issue")
    public static let openThreadSymbol = "arrow.up.right.square"
    /// « Confirmé par app-approbateur · 8 nov. 2026 à 14:05 ».
    public static func confirmed(by: String?, at: String?) -> String {
        switch (by, at) {
        case let (by?, at?): L10n.format("Confirmé par %@ · %@", by, at)
        case let (by?, nil): L10n.format("Confirmé par %@", by)
        case let (nil, at?): L10n.format("Confirmé · %@", at)
        case (nil, nil): L10n.text("Confirmé")
        }
    }

    /// Le canal d’un signalement.
    public static func channel(_ raw: String) -> String {
        switch raw {
        case "slack": L10n.text("Slack")
        case "gmail": L10n.text("Gmail")
        case "chrome": L10n.text("Page lue dans Chrome")
        case "manual": L10n.text("Demande au poste")
        default: raw
        }
    }
}

/// L’écran Canaux du Poste : l’état de Gmail, de l’Agenda et de Slack, et leur connexion
/// (client OAuth, page d’autorisation, URL de retour recollée, blocage par l’administrateur).
public enum ChannelText {
    public static let title = L10n.text("Canaux")
    public static let pageSymbol = "tray.2"
    public static let channelsHeader = L10n.text("Canaux corpo")
    public static let channelsHint = L10n.text("La veille lit ces canaux côté serveur, en lecture seule : rien n’est envoyé sans votre geste.")
    public static let accountLabel = L10n.text("Compte")
    public static let neverRead = L10n.text("Aucune lecture réussie")
    /// « Dernière lecture il y a 5 minutes ».
    public static func lastRead(_ when: String) -> String { L10n.format("Dernière lecture %@", when) }

    /// Le canal, brut (`gmail`, `calendar`, `slack`) ; un canal inconnu se rend tel quel.
    public static func channel(_ raw: String) -> String {
        switch raw {
        case "gmail": L10n.text("Gmail")
        case "calendar": L10n.text("Agenda")
        case "slack": L10n.text("Slack")
        default: raw
        }
    }

    /// La connexion, brute (`google`, `slack`) ; une connexion inconnue se rend telle quelle.
    public static func connection(_ raw: String) -> String {
        switch raw {
        case "google": L10n.text("Google")
        case "slack": L10n.text("Slack")
        default: raw
        }
    }

    /// L’état d’un canal, brut ; un état inconnu se rend tel quel.
    public static func state(_ raw: String) -> String {
        switch raw {
        case "disconnected": L10n.text("Non connecté")
        case "connected": L10n.text("Connecté")
        case "reconnect": L10n.text("À reconnecter")
        case "blocked": L10n.text("Bloqué par l’administrateur")
        case "error": L10n.text("En erreur")
        default: raw
        }
    }

    /// L’état d’un canal en pastille : son mot et son ton.
    public static func status(_ raw: String) -> ConsoleStatus {
        let tone: ConsoleTone = switch raw {
        case "connected": .success
        case "reconnect": .attention
        case "blocked": .paused
        case "error": .danger
        default: .neutral
        }
        return ConsoleStatus(text: state(raw), tone: tone)
    }

    // MARK: - Connexion

    public static let clientMissing = L10n.text("Client OAuth non configuré")
    /// « Client 1234.apps.googleusercontent.com ».
    public static func client(_ id: String) -> String { L10n.format("Client %@", id) }
    public static let configureClient = L10n.text("Configurer le client…")
    public static let changeClient = L10n.text("Changer de client…")
    public static let clientSymbol = "key"
    public static let connect = L10n.text("Connecter")
    public static let connectAll = L10n.text("Connecter Gmail et l’Agenda")
    public static let connectGmailOnly = L10n.text("Gmail seul")
    public static let connectCalendarOnly = L10n.text("L’Agenda seul")
    public static let connectSymbol = "link"
    public static let connectHint = L10n.text("Si l’administrateur bloque Gmail, connectez l’Agenda seul.")
    public static let loginHeader = L10n.text("Connexion en cours")
    public static let openAuthorization = L10n.text("Ouvrir la page d’autorisation")
    public static let openSymbol = "arrow.up.right.square"
    /// « Expire dans 9 minutes ».
    public static func expires(_ when: String) -> String { L10n.format("Expire %@", when) }
    public static let answerLabel = L10n.text("Adresse de retour, code ou erreur affichée")
    public static let answerHint = L10n.text("Après l’autorisation, le navigateur affiche une page qui ne se charge pas : copiez son adresse et collez-la ici. Si le fournisseur affiche une erreur, collez son texte.")
    public static let answer = L10n.text("Valider la connexion")
    public static let declareBlocked = L10n.text("L’administrateur bloque l’app")
    public static let blockedSymbol = "hand.raised"
    public static let blockAll = L10n.text("Toute la connexion")
    public static let blockGmailOnly = L10n.text("Gmail seulement")
    public static let blockCalendarOnly = L10n.text("L’Agenda seulement")
    public static let blockedHint = L10n.text("Une app Slack qui attend l’approbation d’un administrateur ne redirige pas : déclarez le blocage.")
    /// La dernière connexion a échoué : la phrase du serveur.
    public static func loginFailed(_ error: String) -> String { L10n.format("Dernière connexion échouée : %@", error) }
    public static let approverOnly = L10n.text("Seul l’appareil approbateur configure et connecte les canaux : appairez cette app avec le code approbateur (harness.sh approver sur le VPS).")

    // MARK: - Feuille du client OAuth

    public static let googleSheetTitle = L10n.text("Client Google")
    public static let slackSheetTitle = L10n.text("App Slack")
    public static let pasteJSON = L10n.text("Coller le JSON")
    public static let typeCredentials = L10n.text("Identifiant et secret")
    public static let jsonLabel = L10n.text("JSON du client « Application de bureau »")
    public static let clientIdLabel = L10n.text("Identifiant client")
    public static let clientSecretLabel = L10n.text("Secret client")
    public static let googleHint = L10n.text("Dans un projet Google Cloud à vous : activez Gmail et Google Calendar, créez un client OAuth « Application de bureau » et téléchargez son JSON.")
    public static let secretHint = L10n.text("Le secret part au serveur, qui le garde : l’app ne le réaffiche ni ne le garde.")
    public static let slackHint = L10n.text("Créez l’app depuis le manifeste omp-harness/deploy/slack-app-manifest.json : en PKCE, aucun secret.")
    public static let save = L10n.text("Enregistrer")
}

/// Les canaux Slack suivis, dans l’écran Canaux : la case « suivi » de chaque canal de l’espace.
public enum SlackFollowText {
    public static let header = L10n.text("Canaux Slack suivis")
    public static let hint = L10n.text("La veille lit vos messages privés et vos mentions partout, et en entier les canaux cochés.")
    public static let empty = L10n.text("Aucun canal dans l’espace Slack")
    public static let privateChannel = L10n.text("Canal privé")
    public static let privateSymbol = "lock"
}

/// La page Personnes du Poste : le graphe des collègues que le serveur tient (canaux lus,
/// observations du poste), et la correction de chaque champ par l’appareil approbateur.
public enum PeopleText {
    public static let title = L10n.text("Personnes")
    public static let pageSymbol = "person.2"
    public static let empty = L10n.text("Aucune personne : le graphe se remplit à la lecture des canaux.")
    public static let hint = L10n.text("Une personne vue dans les canaux naît au niveau Jamais : rien ne lui est proposé tant que vous ne changez pas son niveau.")
    public static let unnamed = L10n.text("Sans nom")
    public static let corrected = L10n.text("Corrigé")
    public static let correctedSymbol = "pencil.circle.fill"
    public static let release = L10n.text("Relâcher")
    public static let releaseHint = L10n.text("Un champ corrigé est figé : la lecture des canaux ne le change plus. Relâcher le rend aux suggestions.")
    public static let listHint = L10n.text("Plusieurs valeurs : séparez-les par des virgules.")
    public static let save = L10n.text("Enregistrer la correction")
    public static let approverOnly = L10n.text("Seul l’appareil approbateur corrige les personnes : appairez cette app avec le code approbateur (harness.sh approver sur le VPS).")

    /// Le nom d’un champ, brut (`name`, `emails`…) ; un champ inconnu se rend tel quel.
    public static func field(_ raw: String) -> String {
        switch raw {
        case "name": L10n.text("Nom")
        case "emails": L10n.text("Adresses")
        case "slackIds": L10n.text("Identifiants Slack")
        case "role": L10n.text("Rôle")
        case "team": L10n.text("Équipe")
        case "projects": L10n.text("Projets")
        case "tone": L10n.text("Style à adopter")
        case "delegation": L10n.text("Délégation")
        case "topics": L10n.text("Sujets de réponse")
        default: raw
        }
    }

    /// Le niveau de délégation, brut (`jamais`, `brouillon`, `réponse`).
    public static func delegation(_ raw: String) -> String {
        switch raw {
        case "jamais": L10n.text("Jamais")
        case "brouillon": L10n.text("Brouillon")
        case "réponse": L10n.text("Réponse sur les sujets listés")
        default: raw
        }
    }
}

/// Le vocabulaire de la VEILLE PROACTIVE du poste dans « À traiter » : réponses proposées,
/// relances, préparations de réunions et brief du matin. Un code inconnu se rend tel quel.
public enum WatchText {
    public static let sectionTitle = L10n.text("Veille du poste")
    public static let sectionSymbol = "tray.full"
    public static let sectionHint = L10n.text("Ce que la veille a trouvé dans vos canaux. Rien ne part sans votre geste.")
    public static let ready = L10n.text("Prête à valider")
    public static let toReview = L10n.text("À relire")
    public static let gmailDraft = L10n.text("Brouillon Gmail créé")
    public static let gmailDraftPending = L10n.text("Brouillon Gmail pas encore créé")
    public static let internalDraft = L10n.text("Brouillon gardé par le serveur")

    // MARK: - Validation d’une réponse proposée

    public static let validate = L10n.text("Valider")
    public static let edit = L10n.text("Modifier")
    public static let validateEdited = L10n.text("Valider ce texte")
    public static let cancelEdit = L10n.text("Annuler")
    public static let dismiss = L10n.text("Écarter")
    public static let editorLabel = L10n.text("Texte de la réponse")
    /// Validée : la demande du poste rattachée l’enverra (sa raison d’attente suit, s’il y en a une).
    public static let validated = L10n.text("Validée, en attente d’envoi")
    public static let validatedSymbol = "paperplane"
    /// L’envoi n’a pas abouti (la raison du serveur suit) : la réponse se revalide.
    public static let failed = L10n.text("Envoi non abouti")
    public static let failedSymbol = "exclamationmark.triangle"
    /// 412 : la réponse a changé depuis sa lecture ; rien n’est validé, la liste est relue.
    public static let changed = L10n.text("Cette réponse a changé depuis votre lecture : la liste vient d’être relue, relisez-la avant de la valider.")
    public static let approverOnly = L10n.text("Seul l’appareil approbateur peut valider, modifier ou écarter une réponse proposée : appairez cette app avec le code approbateur (harness.sh approver sur le VPS).")

    public static func kind(_ raw: String) -> String {
        switch raw {
        case "reply": L10n.text("Réponse proposée")
        case "followup": L10n.text("Rappel proposé")
        case "prep": L10n.text("Préparation de réunion")
        case "brief": L10n.text("Brief du matin")
        default: raw
        }
    }
}
