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
