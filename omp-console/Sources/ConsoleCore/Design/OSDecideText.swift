// Les mots de « Décider et agir dans un fil » (OS agentique), partagés par le Mac et
// l'iPhone/iPad : la carte de décision (la preuve d'abord, l'échéance d'une question,
// « Toujours ainsi », « Corriger… »), l'arrêt avec son motif, le tri par lots, la page
// d'un fil (curseur d'autonomie, carte « Bloqué », « Refaire ») et le fil d'une session
// locale. Les mots déjà posés restent où ils sont (`OSText`, `PipelineServerText`,
// `ControlText`, `ProofsText`) : ce fichier ne porte que ceux de la tranche.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française et glossaire
// GLOSSAIRE.md. Chaque phrase passe par `L10n` : sa clé est le texte français, sa
// traduction anglaise vit dans `Resources/en.lproj/Localizable.strings`. L'aiguillage
// d'un type du client vers son mot vit côté écrans (`ConsoleUI/OS/OSDecide*.swift`).

import Foundation

public enum OSDecideText {
    // MARK: - Carte de décision

    public static let amend = L10n.text("Corriger…")
    public static let amendNow = L10n.text("Corriger")
    public static let amendPrompt = L10n.text("Ce qu’il faut changer")
    public static let always = L10n.text("Toujours ainsi")
    public static let more = L10n.text("Autres gestes")
    public static let stop = L10n.text("Arrêter…")
    public static let waitForMe = L10n.text("Attendre ma réponse")

    /// « Toujours valider seul « Bogue » sur mem0-omp » : la règle de palier du type, sur le dépôt.
    public static func alwaysAlone(kind: String, repo: String) -> String {
        L10n.format("Toujours valider seul « %@ » sur %@", AutonomyText.kind(kind), repo)
    }

    /// « « Garder le cache » dans 12 min sauf avis contraire » : l'échéance d'une question ;
    /// passée, « « Garder le cache » s’applique ».
    public static func deadline(option: String, seconds: Double) -> String {
        guard seconds >= 1 else { return L10n.format("« %@ » s’applique", option) }
        return L10n.format("« %@ » dans %@ sauf avis contraire", option, PipelineServerText.duration(seconds))
    }

    // MARK: - Preuve d'une revue

    /// « 4 fichiers »
    public static func files(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("fichier"), L10n.text("fichiers"))
    }

    /// « 412 lignes »
    public static func lines(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("ligne"), L10n.text("lignes"))
    }

    // MARK: - Arrêter avec un motif

    public static let stopNow = L10n.text("Arrêter")
    public static let noCause = L10n.text("Sans motif")
    public static let note = L10n.text("Note (facultative)")

    /// « Arrêter « Exporter les commandes » »
    public static func stopTitle(_ title: String) -> String {
        L10n.format("Arrêter « %@ »", title)
    }

    /// Le motif d'un arrêt (`CancelCause` du serveur) ; un motif inconnu se montre tel quel.
    public static func cause(_ raw: String) -> String {
        switch raw {
        case "off_target": L10n.text("À côté de la demande")
        case "too_big": L10n.text("Trop gros")
        case "obsolete": L10n.text("Plus besoin")
        case "duplicate": L10n.text("Doublon")
        case "too_costly": L10n.text("Trop cher")
        case "other": L10n.text("Autre")
        default: raw
        }
    }

    // MARK: - Tri par lots

    /// « Tout envoyer (3) »
    public static func sendAll(_ count: Int) -> String {
        L10n.format("Tout envoyer (%lld)", count)
    }

    /// « Tout valider (3) »
    public static func validateAll(_ count: Int) -> String {
        L10n.format("Tout valider (%lld)", count)
    }

    /// « 3 commentaires Jira »
    public static func jiraLot(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("commentaire Jira"), L10n.text("commentaires Jira"))
    }

    /// « 3 envois du poste »
    public static func sendLot(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("envoi du poste"), L10n.text("envois du poste"))
    }

    /// « 3 revues à risque faible »
    public static func reviewLot(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("revue à risque faible"), L10n.text("revues à risque faible"))
    }

    // MARK: - Page d'un fil

    public static let autonomy = L10n.text("Autonomie")
    public static let askAll = L10n.text("Tout me demander")
    public static let repoRules = L10n.text("Règles du dépôt")
    public static let deliver = L10n.text("Livre et préviens-moi")
    public static let resume = L10n.text("Reprendre")
    public static let open = L10n.text("Ouvrir")
    public static let restrictModules = L10n.text("Restreindre les modules…")
    public static let modulesPrompt = L10n.text("Un chemin par ligne")
    public static let redo = L10n.text("Refaire")
    public static let redoElsewhere = L10n.text("Refaire ailleurs")
    public static let makeRoutine = L10n.text("En faire une routine…")

    /// « 4,20 $ au total » : le coût de toutes les features du fil.
    public static func total(_ cost: Double) -> String {
        L10n.format("%@ au total", MonitoringText.cost(cost))
    }

    /// « Modules de « Trier les commandes » » : le titre de la feuille qui les restreint.
    public static func modulesTitle(_ title: String) -> String {
        L10n.format("Modules de « %@ »", title)
    }

    /// Ce qui retient une feature en file, en une ligne ; les causes d'avant l'OS gardent
    /// leurs mots (`ControlText.waitCause`).
    public static func waitCause(_ raw: String) -> String {
        switch raw {
        case "parent": L10n.text("Attend la fusion de la feature dont elle dépend")
        case "backoff": L10n.text("Reprise différée après un échec")
        case "inferring": L10n.text("Le serveur cherche ses modules")
        case "paused": L10n.text("Tout est suspendu")
        case "space_budget": L10n.text("Budget du jour de l’espace atteint")
        default: ControlText.waitCause(raw)
        }
    }

    /// « Client Acme : 50,00 $ par jour » : le plafond de l'espace qui retient la feature.
    public static func spaceCeiling(_ name: String, ceiling: Double) -> String {
        L10n.format("%@ : %@ par jour", name, MonitoringText.cost(ceiling))
    }

    // MARK: - Session locale

    public static let localSession = L10n.text("Session locale")
    public static let machine = L10n.text("Machine")
    public static let folder = L10n.text("Dossier")
    public static let branch = L10n.text("Branche")
    public static let model = L10n.text("Modèle")
    public static let cost = L10n.text("Coût")
    public static let handoff = L10n.text("Continuer sur le serveur")
    public static let copyResume = L10n.text("Copier la commande de reprise")
    public static let copied = L10n.text("Copié")
    public static let forget = L10n.text("Oublier")
    public static let sessionIdle = L10n.text("en attente")
    public static let sessionEnded = L10n.text("terminée")
}
