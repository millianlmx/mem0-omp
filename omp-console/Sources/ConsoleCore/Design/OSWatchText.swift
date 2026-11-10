// Les mots de « Voir et savoir » dans l'« OS agentique », partagés par le Mac et
// l'iPhone/iPad : le Radar et sa pause, « Maintenant » (le brief, les trois chiffres, la
// réponse de l'OS), la liste des fils (espaces, entrées fixes), les Propositions, le
// Savoir (consignes permanentes, paliers d'autonomie, espaces) et la page d'un espace.
//
// Règle du paradigme : aucune phrase d'aide, une ligne par idée ; les états s'écrivent
// en minuscules (ils se lisent en étiquette ou à la suite d'un lieu).
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française et glossaire
// GLOSSAIRE.md. Chaque phrase passe par `L10n` : sa clé est le texte français, sa
// traduction anglaise vit dans `Resources/en.lproj/Localizable.strings`. Les codes du
// serveur (source d'une proposition, attente, motif d'arrêt, origine d'une consigne) se
// traduisent ici ; un code inconnu se rend tel quel, ou par le mot neutre de sa famille.

import Foundation

public enum OSWatchText {
    /// Une valeur absente : un tiret, jamais un zéro trompeur.
    public static let none = "—"

    // MARK: - Radar

    public static let localSessions = L10n.text("Sessions locales")
    public static let pausedTitle = L10n.text("En pause")
    public static let resume = L10n.text("Reprendre")
    public static let pauseAfterStep = L10n.text("Après l’étape en cours")
    public static let pauseNow = L10n.text("Tout de suite")
    public static let confirmAfterStep = L10n.text("Tout suspendre après l’étape en cours ?")
    public static let confirmNow = L10n.text("Tout interrompre tout de suite ?")
    public static let interrupt = L10n.text("Tout interrompre")
    public static let interrupted = L10n.text("tout interrompu")

    /// « 2 actives » : les sessions omp ouvertes sur les machines de l'humain.
    public static func activeSessions(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("active"), L10n.text("actives"))
    }

    /// « par alice » : qui a suspendu.
    public static func pausedBy(_ who: String) -> String {
        L10n.format("par %@", who)
    }

    /// « reste 15,80 $ » : ce qu'il reste du budget du jour de l'espace choisi.
    public static func budgetLeft(_ amount: Double) -> String {
        L10n.format("reste %@", MonitoringText.cost(max(0, amount)))
    }

    // MARK: - Maintenant (le brief)

    public static let seen = L10n.text("Vu")
    public static let sectionDelivered = L10n.text("Livré")
    public static let sectionBlocked = L10n.text("Bloqué")
    public static let sectionFailed = L10n.text("Échecs")
    public static let sectionDecided = L10n.text("Décidé seul")
    public static let alone = L10n.text("seul")
    public static let scoreAlone = L10n.text("Livré sans vous")
    public static let scoreDelay = L10n.text("Délai d’une décision")
    public static let scoreStarted = L10n.text("Lancé sans vous")
    public static let trendUp = L10n.text("en hausse")
    public static let trendDown = L10n.text("en baisse")
    public static let trendFlat = L10n.text("stable")

    /// « depuis 3 h et 12 min » : la fenêtre du brief, de son début à `nowMs`.
    public static func since(ms: Double, nowMs: Double) -> String {
        L10n.format("depuis %@", ConsoleFormat.duration(ms: nowMs - ms))
    }

    /// Ce qu'une feature attend de l'humain (`wait` du brief).
    public static func wait(_ raw: String) -> String {
        switch raw {
        case "questions": OSText.runQuestion
        case "specs": OSText.runAwaitsSpecs
        case "verdict": OSText.runAwaitsVerdict
        case "irreversible": L10n.text("geste irréversible")
        case "arbitration": L10n.text("arbitrage")
        case "budget": L10n.text("budget atteint")
        case "failure": L10n.text("échec à relancer")
        default: raw
        }
    }

    /// Le motif d'un arrêt (`cancelCause`) ; sans motif connu, « sans motif ».
    public static func cancelCause(_ raw: String?) -> String {
        switch raw {
        case "off_target": L10n.text("à côté de la demande")
        case "too_big": L10n.text("trop gros")
        case "obsolete": L10n.text("plus besoin")
        case "duplicate": L10n.text("doublon")
        case "too_costly": L10n.text("trop cher")
        case "other": L10n.text("autre motif")
        default: L10n.text("sans motif")
        }
    }

    // MARK: - Liste des fils

    public static let space = L10n.text("Espace")
    public static let allSpaces = L10n.text("Tous les espaces")
    public static let openSpace = L10n.text("Ouvrir l’espace")
    public static let decisions = L10n.text("Décisions")
    public static let proposals = L10n.text("Propositions")
    public static let knowledge = L10n.text("Savoir")

    // MARK: - Propositions

    public static let noProposal = L10n.text("Aucune proposition")
    public static let openLink = L10n.text("Ouvrir")

    /// Le titre du groupe d'une source de propositions (`source`).
    public static func proposalSource(_ raw: String) -> String {
        switch raw {
        case "issue": L10n.text("Issues")
        case "vigie": L10n.text("Vigie")
        case "audit": L10n.text("Audits")
        case "jira": L10n.text("Jira")
        case "signal": L10n.text("Signalements")
        case "autonomy": L10n.text("Paliers")
        case "retry": L10n.text("Relances")
        case "pr": L10n.text("PR dormantes")
        case "ci": L10n.text("Intégration continue en échec")
        default: L10n.text("Autres")
        }
    }

    /// Le geste qui accepte une proposition (`action`).
    public static func proposalAction(_ raw: String) -> String {
        switch raw {
        case "fix": L10n.text("Corriger")
        case "apply": L10n.text("Appliquer")
        case "confirm": L10n.text("Confirmer")
        case "retry": L10n.text("Relancer")
        default: OSText.launch
        }
    }

    // MARK: - Savoir : consignes permanentes

    public static let standingRules = L10n.text("Consignes permanentes")
    public static let noRule = L10n.text("Aucune consigne")
    public static let add = L10n.text("Ajouter")
    public static let edit = L10n.text("Modifier")
    public static let delete = L10n.text("Supprimer")
    public static let save = L10n.text("Enregistrer")
    public static let newRule = L10n.text("Nouvelle consigne")
    public static let editRule = L10n.text("Modifier la consigne")
    public static let deleteRule = L10n.text("Supprimer cette consigne ?")
    public static let rulePrompt = L10n.text("Par exemple : les messages d’erreur sont en français")
    public static let ruleRepo = L10n.text("Dépôt")
    public static let ruleEverywhere = L10n.text("partout")

    /// D'où vient une consigne (`source`).
    public static func ruleOrigin(_ raw: String) -> String {
        switch raw {
        case "answer": L10n.text("d’une réponse")
        case "correction": L10n.text("d’une correction")
        case "cancel": L10n.text("d’un arrêt")
        case "manual": L10n.text("écrite à la main")
        default: raw
        }
    }

    // MARK: - Savoir : paliers d'autonomie

    public static let tiers = L10n.text("Paliers d’autonomie")
    public static let tierNone = L10n.text("Tout vous revient")
    public static let apply = L10n.text("Appliquer")
    public static let suggestionRaise = L10n.text("peut monter")
    public static let suggestionLower = L10n.text("à reprendre en main")

    /// « Bogue : specs validées seules » : ce qu'une règle de palier laisse valider seul
    /// pour un type de travail (`kind`, déjà traduit).
    public static func tier(kind: String, specsAlone: Bool, reviewAlone: Bool) -> String {
        switch (specsAlone, reviewAlone) {
        case (true, true): L10n.format("%@ : specs et revue validées seules", kind)
        case (true, false): L10n.format("%@ : specs validées seules", kind)
        case (false, true): L10n.format("%@ : revue validée seule", kind)
        case (false, false): L10n.format("%@ : tout vous revient", kind)
        }
    }

    /// « 92 % de réussite » : la confiance d'un dépôt (`rate`, de 0 à 1).
    public static func confidence(_ rate: Double) -> String {
        L10n.format("%@ de réussite", PipelineServerText.percent(rate))
    }

    // MARK: - Savoir : espaces

    public static let spaces = L10n.text("Espaces")
    public static let noSpace = L10n.text("Aucun espace")
    public static let newSpace = L10n.text("Nouvel espace")
    public static let editSpace = L10n.text("Modifier l’espace")
    public static let deleteSpace = L10n.text("Supprimer cet espace ?")
    public static let spaceName = L10n.text("Nom")
    public static let spaceRepos = L10n.text("Dépôts")
    public static let spaceJira = L10n.text("Projets Jira")
    public static let spaceJiraPrompt = L10n.text("Par exemple : WEB, MOBILE")
    public static let spaceBudget = L10n.text("Budget journalier (en dollars)")
    public static let spaceBudgetPrompt = L10n.text("Sans plafond")
    public static let spaceAutonomy = L10n.text("Autonomie par défaut")
    public static let autonomyAsk = L10n.text("Tout me demander")
    public static let autonomyRules = L10n.text("Règles du dépôt")
    public static let autonomyDeliver = L10n.text("Livre et préviens-moi")
    public static let memory = L10n.text("Mémoire")

    /// Le niveau d'autonomie par défaut d'un espace (`ask`, `deliver`, sinon les règles du dépôt).
    public static func autonomy(_ raw: String?) -> String {
        switch raw {
        case "ask": autonomyAsk
        case "deliver": autonomyDeliver
        default: autonomyRules
        }
    }

    /// « 2 dépôts »
    public static func repos(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("dépôt"), L10n.text("dépôts"))
    }

    /// « 20,00 $ par jour »
    public static func perDay(_ amount: Double) -> String {
        L10n.format("%@ par jour", MonitoringText.cost(amount))
    }

    /// « dans Client Acme » : l'espace qui tient déjà un dépôt.
    public static func inSpace(_ name: String) -> String {
        L10n.format("dans %@", name)
    }

    // MARK: - Page d'un espace

    public static let weekDelivered = L10n.text("Livrées")
    public static let weekFailed = L10n.text("Échecs")
    public static let weekStopped = L10n.text("Arrêtées")
    public static let weekCost = L10n.text("Coût")
    public static let budgetToday = L10n.text("Budget du jour")
    public static let weeklyReport = L10n.text("Rapport hebdomadaire")
    public static let noReport = L10n.text("Aucun rapport")
    public static let copy = L10n.text("Copier")
    public static let copied = L10n.text("Copié")
    public static let share = L10n.text("Partager")

    /// « 4,20 $ sur 20,00 $ » : la dépense du jour sur le plafond de l'espace.
    public static func budgetUse(spent: Double, ceiling: Double) -> String {
        L10n.format("%@ sur %@", MonitoringText.cost(spent), MonitoringText.cost(ceiling))
    }
}
