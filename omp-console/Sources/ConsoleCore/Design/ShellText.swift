// Le vocabulaire de la COQUE refondue, partagé par le Mac et l'iPhone/iPad : la file
// « À traiter », la ligne de pouls, la liste et la page d'une feature, le hub Système.
// Ce qui existe déjà ailleurs (états, étapes, gestes) se reprend de `PipelineServerText`,
// `MonitoringText` et `ControlText`.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?) et glossaire GLOSSAIRE.md.

public enum ShellText {
    // MARK: - À traiter

    public static let allClearTitle = L10n.text("Rien ne vous attend")
    public static let allClearHint = L10n.text("Les agents travaillent seuls. Une question, des specs ou un verdict à valider arriveront ici, et en notification.")
    public static let allClearSymbol = "checkmark.circle"
    public static let openRun = L10n.text("Ouvrir la feature")
    public static let openRunSymbol = "arrow.up.right.square"
    public static let openAudit = L10n.text("Trier les propositions")

    public static func kindQuestions(_ count: Int) -> String {
        count == 1 ? L10n.text("Question à trancher") : L10n.format("%d questions à trancher", count)
    }

    public static let kindSpecs = L10n.text("Specs à valider")
    public static let kindVerdict = L10n.text("Revue à valider")
    public static let kindStopped = L10n.text("Feature arrêtée")
    public static let kindAlert = L10n.text("Alerte")
    public static let kindAudit = L10n.text("Audit à trier")

    public static func kindDecisions(_ count: Int) -> String {
        count == 1 ? L10n.text("Décision prise seule") : L10n.format("%d décisions prises seules", count)
    }

    public static let symbolQuestions = "questionmark.bubble"
    public static let symbolSpecs = "doc.text.magnifyingglass"
    public static let symbolVerdict = "checkmark.seal"
    public static let symbolAlert = "exclamationmark.triangle"
    public static let symbolAudit = "checklist"
    public static let symbolDecisions = "arrow.triangle.branch"

    public static func auditProposals(_ count: Int) -> String {
        count == 1 ? L10n.text("1 proposition") : L10n.format("%d propositions", count)
    }

    // MARK: - Pouls

    public static let live = L10n.text("En direct")
    public static let offline = L10n.text("Hors ligne")

    public static func running(_ count: Int) -> String { L10n.format("%d en cours", count) }
    public static func queued(_ count: Int) -> String { L10n.format("%d en file", count) }
    public static func weekCost(_ amount: String) -> String { L10n.format("%@ sur 7 jours", amount) }

    // MARK: - Features

    public static let groupNeedsYou = L10n.text("À vous")
    public static let groupRunning = L10n.text("En cours")
    public static let groupQueued = L10n.text("En file")
    public static let groupDone = L10n.text("Terminées")
    public static let noRun = L10n.text("Aucune feature pour l’instant.")
    public static let noMatch = L10n.text("Aucune feature ne correspond.")
    public static let pickRun = L10n.text("Choisissez une feature")
    public static let pickRunHint = L10n.text("Sa page montre l’étape, ce qu’elle attend de vous, le direct de l’agent, ses fichiers et ses tests.")
    public static let allRepos = L10n.text("Tous les dépôts")
    public static let allProjects = L10n.text("Tous les projets")
    public static let filters = L10n.text("Filtres")
    public static let filtersSymbol = "line.3.horizontal.decrease.circle"
    public static let newMenu = L10n.text("Nouveau")
    public static let newProject = L10n.text("Nouveau projet…")
    public static let newAudit = L10n.text("Nouvel audit…")
    public static let newSchedule = L10n.text("Nouvelle planification…")
    public static let scope = L10n.text("Afficher")

    // MARK: - Page d'une feature

    public static let actions = L10n.text("Actions")
    public static let actionsSymbol = "ellipsis.circle"
    public static let openPR = L10n.text("Ouvrir la PR")
    public static let openPRSymbol = "arrow.triangle.pull"
    public static let waitsForYou = L10n.text("Elle attend votre décision")
    public static let tabOverview = L10n.text("Aperçu")
    public static let request = L10n.text("Demande")
    public static let specs = L10n.text("Specs")
    public static let verdict = L10n.text("Verdict")
    public static let priority = L10n.text("Priorité")
    public static let unknownRun = L10n.text("Cette feature n’est plus connue du serveur.")

    public static func created(_ relative: String) -> String { L10n.format("Lancée %@", relative) }
    public static func fixes(_ count: Int) -> String {
        count == 1 ? L10n.text("1 correction") : L10n.format("%d corrections", count)
    }

    /// Les jalons de la frise d'une feature, dans l'ordre du chemin nominal.
    public static let stepNeeds = L10n.text("Besoins")
    public static let stepSpecs = L10n.text("Specs")
    public static let stepBuild = L10n.text("Implémentation")
    public static let stepReview = L10n.text("Revue")
    public static let stepMerge = L10n.text("Fusion")

    // MARK: - Système

    public static let systemHint = L10n.text("Ce qui se règle ou se consulte rarement.")
    public static let vigieSilent = L10n.text("Muette")
    public static let unavailable = L10n.text("Absent de ce serveur")

    public static func schedulesCount(_ active: Int, of total: Int) -> String {
        L10n.format("%d actives sur %d", active, total)
    }
}
