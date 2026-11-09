// Les mots de l'« OS agentique », partagés par le Mac et l'iPhone/iPad : la liste des
// fils, « Maintenant », le radar des agents, la page d'un fil, les cartes de décision, le
// tri, « Comprendre » et les automatismes.
//
// Règle du paradigme : quatre noms (fil, agent, décision, savoir), aucune phrase d'aide,
// un état = un symbole et un mot. Les états d'un fil et d'une feature s'écrivent en
// minuscules : ils se lisent en étiquette, ou à la suite d'un lieu (« mem0-omp · en file »).
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française et glossaire
// GLOSSAIRE.md. Chaque phrase passe par `L10n` : sa clé est le texte français, sa
// traduction anglaise vit dans `Resources/en.lproj/Localizable.strings`. L'aiguillage
// d'un type du client (section, origine, phase, feature) vers son mot, et les symboles
// SF, vivent côté écrans : `ConsoleUI/OS/OSLabels.swift`.

import Foundation

public enum OSText {
    // MARK: - Coque

    public static let ask = L10n.text("Demander à l’OS…")
    public static let reply = L10n.text("Consigne à l’agent…")
    public static let followUp = L10n.text("Demander une suite…")
    public static let classic = L10n.text("Interface classique")
    public static let toggle = L10n.text("Nouvelle interface (prototype)")
    public static let understand = L10n.text("Comprendre")
    public static let now = L10n.text("Maintenant")

    /// « Demander : « corrige le bandeau » » : la saisie de la liste des fils, prête à partir.
    public static func askThis(_ text: String) -> String {
        L10n.format("Demander : « %@ »", text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    // MARK: - Maintenant

    public static let yours = L10n.text("À vous")
    public static let atWork = L10n.text("Au travail")
    public static let delivered = L10n.text("Livré aujourd’hui")
    public static let mergedTile = L10n.text("Fusionnées · 24 h")
    public static let failedTile = L10n.text("Échecs · 24 h")
    public static let aloneTile = L10n.text("Décidé seul · 24 h")
    public static let calm = L10n.text("Aucun agent ne travaille")
    public static let nothing = L10n.text("Rien ne vous attend")

    // MARK: - Lieux

    public static let vps = L10n.text("VPS")
    public static let vpsBrowser = L10n.text("VPS · Moli")
    public static let yourChrome = L10n.text("Votre Chrome")
    public static let defaultBrowser = L10n.text("navigateur par défaut")
    public static let poste = L10n.text("Poste")
    public static let everywhere = L10n.text("Partout")
    public static let places = L10n.text("Lieu")
    public static let openPR = L10n.text("PR")

    /// « PR #438 »
    public static func pr(_ number: String) -> String {
        L10n.format("PR #%@", number)
    }

    // MARK: - Créer

    public static let create = L10n.text("Nouveau")
    public static let newFeature = L10n.text("Nouvelle feature…")
    public static let newProject = L10n.text("Nouveau projet…")
    public static let newAudit = L10n.text("Nouvel audit…")
    public static let newSchedule = L10n.text("Nouvelle planification…")

    // MARK: - Automatismes

    public static let automations = L10n.text("Automatismes")
    public static let scheduled = L10n.text("Planifié")
    public static let posteRoutines = L10n.text("Routines du poste")
    public static let posteService = L10n.text("Service 24/24 du poste")
    public static let atlassian = L10n.text("Jira et Confluence")
    public static let vigie = L10n.text("Vigie")
    public static let launch = L10n.text("Lancer")
    public static let noSchedule = L10n.text("Aucune planification")
    public static let noRoutine = L10n.text("Aucune routine")
    public static let absentHere = L10n.text("Pas sur ce serveur")

    /// « prochaine dans 3 heures » : la prochaine échéance, relative à `nowMs`.
    public static func next(ms: Double, nowMs: Double) -> String {
        L10n.format("prochaine %@", ConsoleFormat.relative(ms: ms, nowMs: nowMs))
    }

    /// « dernière il y a 2 heures » : la dernière passe, relative à `nowMs`.
    public static func last(ms: Double, nowMs: Double) -> String {
        L10n.format("dernière %@", ConsoleFormat.relative(ms: ms, nowMs: nowMs))
    }

    /// « 3 actions »
    public static func actions(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("action"), L10n.text("actions"))
    }

    // MARK: - Radar

    public static let os = L10n.text("OS")
    public static let idle = L10n.text("en veille")
    public static let offline = L10n.text("hors ligne")
    public static let paused = L10n.text("en pause")
    public static let stopped = L10n.text("arrêté")
    public static let silent = L10n.text("muette")
    public static let live = L10n.text("En direct")
    public static let reconnecting = L10n.text("Reconnexion…")
    public static let suspend = L10n.text("Tout suspendre")
    public static let stopPoste = L10n.text("Arrêter le poste")

    /// « Arrêter les 3 fils en cours »
    public static func stopThreads(_ count: Int) -> String {
        count == 1 ? L10n.text("Arrêter le fil en cours") : L10n.format("Arrêter les %lld fils en cours", count)
    }

    /// « 4,20 $ aujourd’hui » : le coût du jour.
    public static func today(_ cost: Double) -> String {
        L10n.format("%@ aujourd’hui", MonitoringText.cost(cost))
    }

    /// « rien de neuf », « 2 nouveaux » : les incidents neufs de la vigie.
    public static func incidents(_ count: Int) -> String {
        count == 0 ? L10n.text("rien de neuf") : ConsoleFormat.count(count, L10n.text("nouveau"), L10n.text("nouveaux"))
    }

    // MARK: - Liste des fils

    public static let triage = L10n.text("Trier")
    public static let skip = L10n.text("Passer")
    public static let done = L10n.text("OK")
    public static let sectionWorking = L10n.text("En cours")
    public static let sectionQueued = L10n.text("En file")
    public static let sectionToday = L10n.text("Aujourd’hui")
    public static let sectionYesterday = L10n.text("Hier")
    public static let sectionWeek = L10n.text("Cette semaine")
    public static let sectionEarlier = L10n.text("Plus tôt")
    public static let sectionStopped = L10n.text("Arrêtés")

    /// « 3 décisions »
    public static func decisions(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("décision"), L10n.text("décisions"))
    }

    // MARK: - Origines

    public static let originYou = L10n.text("Vous")
    public static let originServer = L10n.text("Le serveur")
    public static let originAudit = L10n.text("Audit")
    public static let originFactory = L10n.text("Pilote de l’usine")

    /// « Issue #412 »
    public static func originIssue(_ number: Int) -> String {
        L10n.format("Issue #%@", String(number))
    }

    /// « Vigie · issue #412 »
    public static func originVigie(issue number: Int) -> String {
        L10n.format("Vigie · issue #%@", String(number))
    }

    // MARK: - Étapes et états

    /// Le chemin d'une feature, dans l'ordre de ses cinq points.
    public static let steps = [
        L10n.text("Besoins"),
        L10n.text("Specs"),
        L10n.text("Implémentation"),
        L10n.text("Revue"),
        L10n.text("Fusion"),
    ]

    public static let phaseYours = L10n.text("à vous")
    public static let phaseWorking = L10n.text("au travail")
    public static let phaseQueued = L10n.text("en file")
    public static let phaseDone = L10n.text("livré")
    public static let phaseFailed = L10n.text("en échec")
    public static let runQuestion = L10n.text("question")
    public static let runAwaitsSpecs = L10n.text("specs à valider")
    public static let runAwaitsVerdict = L10n.text("revue à valider")
    public static let runMerging = L10n.text("fusion")
    public static let runMerged = L10n.text("fusionnée")
    public static let runFailed = L10n.text("échec")
    public static let runStopped = L10n.text("arrêtée")

    /// « Tentative 2 »
    public static func attempt(_ index: Int) -> String {
        L10n.format("Tentative %lld", index)
    }

    /// « 3 tâches »
    public static func tasks(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("tâche"), L10n.text("tâches"))
    }

    // MARK: - Décisions

    public static let kindQuestion = L10n.text("Question")
    public static let kindSpecs = L10n.text("Specs")
    public static let kindVerdict = L10n.text("Revue")
    public static let kindSend = L10n.text("Envoi du poste")
    public static let kindPlan = L10n.text("Plan de l’OS")
    public static let kindClarify = L10n.text("L’OS demande")
    public static let kindProposals = L10n.text("Propositions d’audit")
    public static let kindJira = L10n.text("Commentaire Jira")
    public static let answer = L10n.text("Répondre")
    public static let other = L10n.text("Autre…")
    public static let validate = L10n.text("Valider")
    public static let merge = L10n.text("Fusionner")
    public static let refuse = L10n.text("Refuser…")
    public static let refuseNow = L10n.text("Refuser")
    public static let read = L10n.text("Lire")
    public static let approve = L10n.text("Approuver")
    public static let cancel = L10n.text("Annuler")
    public static let dismiss = L10n.text("Écarter")
    public static let send = L10n.text("Envoyer")
    public static let launchAll = L10n.text("Tout lancer")
    public static let keep = L10n.text("Garder")
    public static let revisit = L10n.text("Revoir")
    public static let reason = L10n.text("Pourquoi ?")
    public static let waitsStep = L10n.text("l’agent finit son étape")
    public static let autonomous = L10n.text("décidé seul")
    public static let specsReady = L10n.text("Specs prêtes")
    public static let recommended = L10n.text("recommandé")

    /// « Prendre « Garder le cache » » : le geste qui retient l'option recommandée.
    public static func take(_ option: String) -> String {
        L10n.format("Prendre « %@ »", option)
    }

    /// « à alice@exemple.fr, bob@exemple.fr » : les destinataires d'un envoi du poste.
    public static func to(_ recipients: [String]) -> String {
        recipients.isEmpty ? L10n.text("destinataire inconnu") : L10n.format("à %@", recipients.joined(separator: ", "))
    }

    // MARK: - Résultats

    public static let merged = L10n.text("Fusionnée")
    public static let readAll = L10n.text("Tout lire")
    public static let collapse = L10n.text("Replier")
    public static let reportTitle = L10n.text("Compte rendu")

    /// « 2 corrections »
    public static func fixes(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("correction"), L10n.text("corrections"))
    }

    // MARK: - Comprendre

    public static let levelSummary = L10n.text("Résumé")
    public static let levelStory = L10n.text("Récit")
    public static let levelProofs = L10n.text("Preuves")
    public static let levelRaw = L10n.text("Brut")
    public static let paneCaptures = L10n.text("Captures")
    public static let paneFiles = L10n.text("Fichiers")
    public static let paneTests = L10n.text("Tests")
    public static let request = L10n.text("Demande")
    public static let specsFull = L10n.text("Specs complètes")
    public static let noRun = L10n.text("Rien à comprendre ici")
}
