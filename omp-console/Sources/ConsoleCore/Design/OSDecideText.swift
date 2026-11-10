// Les mots de « Décider et agir dans un fil » (OS agentique), partagés par le Mac et
// l'iPhone/iPad : la carte de décision (son client, la preuve, pourquoi on vous demande,
// « Toujours ainsi », « Corriger… »), l'arrêt avec son motif, le tri (position, lots par
// espace, « Plus tard »), la page d'un fil (ses cartes Au travail, En attente, En échec,
// Livré, Arrêté ; « Refaire ») et le fil d'une session locale.
//
// Règle de la page d'un fil : AUCUNE phrase du serveur ni de l'agent n'y paraît. Chaque
// attente, chaque échec, chaque arrêt se dit par une phrase d'ici, tirée d'un CODE (cause
// de file, cause d'échec, motif d'arrêt, raison d'une porte) ; un code inconnu donne la
// phrase générique de sa famille, jamais le texte brut.
//
// Glossaire de l'interface : dire oui = Valider (une porte), Envoyer (un message), Lancer
// (un travail), Prendre « … » (une option) ; dire non = Corriger… (ça continue autrement),
// Écarter (ça disparaît), Arrêter… (ça s'arrête) ; Relancer (après un échec), Refaire (un
// fil fini), Reprendre (après une pause) ; un fil, ses tâches. Les mots déjà posés restent
// où ils sont et se réutilisent (`OSText` : « Au travail », « Envoyer », « Valider » ; `ControlText` : « Corriger » ;
// `OSWatchText` : « Livré », « Reprendre », « Copié », les trois niveaux d'autonomie ;
// `PipelineServerText` : « Relancer », « Fermer » ; `IntakeText`, `ProofsText`) : ce fichier
// ne porte que ceux de la tranche.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française et glossaire
// GLOSSAIRE.md. Chaque phrase passe par `L10n` : sa clé est le texte français, sa
// traduction anglaise vit dans `Resources/en.lproj/Localizable.strings`. L'aiguillage
// d'un type du client vers son mot vit côté écrans (`ConsoleUI/OS/OSDecide*.swift`).

import Foundation

public enum OSDecideText {
    // MARK: - Carte de décision

    public static let amend = L10n.text("Corriger…")
    public static let amendPrompt = L10n.text("Ce qu’il faut changer")
    public static let always = L10n.text("Toujours ainsi")
    public static let more = L10n.text("Autres gestes")
    public static let stop = L10n.text("Arrêter…")
    public static let waitForMe = L10n.text("Attendre ma réponse")
    public static let kindArbitration = L10n.text("Arbitrage")
    public static let kindBudget = L10n.text("Budget")
    public static let noSpace = L10n.text("Sans espace")

    /// « Lancer sur acme-web » : le plan d'une Demande part sur ce dépôt.
    public static func launchOn(_ repo: String) -> String {
        L10n.format("Lancer sur %@", repo)
    }

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

    // MARK: - Pourquoi on vous demande

    /// « Le changement fait 412 lignes, le plafond est 300 » : la taille qui réserve une revue à l'humain.
    public static func gateSize(lines: Int, ceiling: Int?) -> String {
        let size = ConsoleFormat.count(lines, L10n.text("ligne"), L10n.text("lignes"))
        guard let ceiling else { return L10n.format("Le changement fait %@", size) }
        return L10n.format("Le changement fait %@, le plafond est %lld", size, ceiling)
    }

    /// « La revue a relevé 2 points bloquants »
    public static func gateBlockers(_ count: Int) -> String {
        L10n.format("La revue a relevé %@", ConsoleFormat.count(count, L10n.text("point bloquant"), L10n.text("points bloquants")))
    }

    /// Pourquoi une porte attend l'humain, d'après le code de sa raison ; un code inconnu
    /// donne la phrase générique.
    public static func gate(_ code: String) -> String {
        switch code {
        case "risk_medium": L10n.text("Le risque est jugé moyen")
        case "risk_high": L10n.text("Le risque est jugé élevé")
        case "risk": L10n.text("Le risque n’est pas jugé faible")
        case "tests_red": L10n.text("Des tests échouent")
        case "tests_missing": L10n.text("Tous les tests n’ont pas été lancés")
        case "questions": L10n.text("Une question reste ouverte")
        case "criteria": L10n.text("Un critère de la demande n’est pas prouvé")
        case "unread": L10n.text("Des fichiers modifiés n’ont pas été relus")
        case "weak": L10n.text("La revue n’est pas sûre de son avis")
        case "ask": L10n.text("Vous avez demandé à tout valider")
        case "split": L10n.text("Les specs proposent de découper le travail")
        case "no_modules": L10n.text("Les specs ne disent pas quelle zone du code est touchée")
        case "irreversible": L10n.text("Les specs contiennent un geste irréversible")
        case "first_of_project": L10n.text("C’est la première tâche du projet")
        case "arbitration": L10n.text("La revue et la correction ne s’accordent pas")
        case "budget": L10n.text("Le budget de ce fil est dépassé")
        default: L10n.text("Votre validation est requise")
        }
    }

    // MARK: - Preuve d'une revue

    /// « 4 fichiers »
    public static func files(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("fichier"), L10n.text("fichiers"))
    }

    // MARK: - Arrêter avec un motif

    public static let stopNow = L10n.text("Arrêter")
    public static let noCause = L10n.text("Sans motif")
    public static let note = L10n.text("Note (facultative)")

    /// « Arrêter « Exporter les commandes » »
    public static func stopTitle(_ title: String) -> String {
        L10n.format("Arrêter « %@ »", title)
    }

    /// Le motif d'un arrêt (`CancelCause` du serveur) ; un motif inconnu se dit « Autre ».
    public static func cause(_ raw: String) -> String {
        switch raw {
        case "off_target": L10n.text("À côté de la demande")
        case "too_big": L10n.text("Trop gros")
        case "obsolete": L10n.text("Plus besoin")
        case "duplicate": L10n.text("Doublon")
        case "too_costly": L10n.text("Trop cher")
        default: L10n.text("Autre")
        }
    }

    // MARK: - Tri

    public static let later = L10n.text("Plus tard")

    /// « 1 sur 3 » : la décision montrée parmi celles du tri ; un lot dit « 1–3 sur 5 ».
    public static func position(first: Int, last: Int, total: Int) -> String {
        first == last ? L10n.format("%lld sur %lld", first, total) : L10n.format("%lld–%lld sur %lld", first, last, total)
    }

    /// « Client Acme — 2 » : l'espace des décisions qui suivent, et leur nombre.
    public static func spaceGroup(_ name: String, count: Int) -> String {
        L10n.format("%@ — %lld", name, count)
    }

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

    // MARK: - Page d'un fil : cartes et états

    public static let cardWaiting = L10n.text("En attente")
    public static let cardFailed = L10n.text("En échec")
    public static let cardStopped = L10n.text("Arrêté")
    /// L'état d'une tâche ou d'une session qui attend son tour, en minuscules.
    public static let stateWaiting = L10n.text("en attente")
    public static let autonomy = L10n.text("Autonomie")
    public static let autonomyLabel = L10n.text("Autonomie :")
    public static let finishing = L10n.text("Finit son étape, puis s’arrête")
    public static let restrictModules = L10n.text("Restreindre les modules…")
    public static let modulesPrompt = L10n.text("Un chemin par ligne")
    public static let redo = L10n.text("Refaire")
    public static let redoElsewhere = L10n.text("Refaire ailleurs")
    public static let makeRoutine = L10n.text("En faire une routine…")
    public static let seeProposals = L10n.text("Voir dans Propositions")
    public static let auditAnalysing = L10n.text("Analyse le dépôt")

    /// « Tâche 2 » : une tâche du fil qui n'a pas de titre à elle.
    public static func task(_ index: Int) -> String {
        L10n.format("Tâche %lld", index)
    }

    /// « Essai 2 » : un essai d'une même demande au poste.
    public static func attempt(_ index: Int) -> String {
        L10n.format("Essai %lld", index)
    }

    /// « 3 essais »
    public static func attempts(_ count: Int) -> String {
        ConsoleFormat.count(count, L10n.text("essai"), L10n.text("essais"))
    }

    /// « « Exporter les commandes en CSV » est livré » : ce qui a été livré, en une phrase.
    public static func delivered(_ title: String) -> String {
        L10n.format("« %@ » est livré", title)
    }

    /// « L’audit a rendu 3 propositions »
    public static func auditProposals(_ count: Int) -> String {
        L10n.format("L’audit a rendu %@", ConsoleFormat.count(count, L10n.text("proposition"), L10n.text("propositions")))
    }

    /// « Ouvrir « Trier les commandes » » : le fil dont on attend la fin.
    public static func openThread(_ title: String) -> String {
        L10n.format("Ouvrir « %@ »", title)
    }

    /// « Modules de « Trier les commandes » » : le titre de la feuille qui les restreint.
    public static func modulesTitle(_ title: String) -> String {
        L10n.format("Modules de « %@ »", title)
    }

    // MARK: - Page d'un fil : en attente

    public static let leavesAlone = L10n.text("Rien à faire, ça partira seul")
    public static let leavesOnResume = L10n.text("Repartira à la reprise")
    public static let allSuspended = L10n.text("Tout est suspendu")
    public static let requestWaiting = L10n.text("Attend que le poste soit libre")

    /// « Attend la fin de « Filtrer les commandes » (même zone du code) »
    public static func waitsFor(_ title: String) -> String {
        L10n.format("Attend la fin de « %@ » (même zone du code)", title)
    }

    /// « Attend la fin de 2 fils (même zone du code) »
    public static func waitsForMany(_ count: Int) -> String {
        L10n.format("Attend la fin de %lld fils (même zone du code)", count)
    }

    /// « Attend la livraison de « Refonte du formulaire » » : la tâche dont celle-ci dépend.
    public static func waitsForParent(_ title: String) -> String {
        L10n.format("Attend la livraison de « %@ »", title)
    }

    /// « Reprend à 14:05 » : la relance différée d'une tâche.
    public static func resumesAt(_ time: String) -> String {
        L10n.format("Reprend à %@", time)
    }

    /// « Client Acme est suspendu »
    public static func spaceSuspended(_ name: String) -> String {
        L10n.format("%@ est suspendu", name)
    }

    /// « Budget du jour de Client Acme atteint (50,00 $) » ; sans plafond connu, sans montant.
    public static func spaceBudget(_ name: String, ceiling: Double?) -> String {
        guard let ceiling else { return L10n.format("Budget du jour de %@ atteint", name) }
        return L10n.format("Budget du jour de %@ atteint (%@)", name, MonitoringText.cost(ceiling))
    }

    /// Ce qui retient une tâche en file, d'après le code de sa cause, quand rien de plus précis
    /// n'est connu (ni le fil attendu, ni l'heure, ni l'espace) ; un code inconnu : « Attend son tour ».
    public static func waitCause(_ raw: String?) -> String {
        switch raw {
        case "modules": L10n.text("Attend la fin d’un autre fil (même zone du code)")
        case "parent": L10n.text("Attend la livraison du fil dont il dépend")
        case "backoff": L10n.text("Reprend bientôt")
        case "inferring": L10n.text("Le serveur repère la zone du code concernée")
        case "paused": allSuspended
        case "space_budget": L10n.text("Budget du jour de l’espace atteint")
        case "slots": L10n.text("Attend qu’un agent se libère")
        case "memory": L10n.text("Attend que le serveur ait assez de mémoire")
        case "repo_cap": L10n.text("Attend son tour sur ce dépôt")
        case "daily_budget": L10n.text("Budget du jour du serveur atteint")
        case "unknown_repo": L10n.text("Ce dépôt n’est plus sur le serveur")
        default: L10n.text("Attend son tour")
        }
    }

    // MARK: - Page d'un fil : en échec

    public static let requestFailed = L10n.text("La demande au poste n’a pas abouti")

    /// Pourquoi une tâche est en échec, d'après le code de la cause (`lastFailCause`) ; sans
    /// code ou d'un code inconnu : « Une étape n’a pas abouti ».
    public static func failCause(_ raw: String?) -> String {
        switch raw {
        case "timeout": L10n.text("Une étape a dépassé son délai")
        case "rate_limit": L10n.text("Le modèle a reçu trop de demandes à la fois")
        case "server_error": L10n.text("Le modèle a renvoyé une erreur")
        case "network": L10n.text("La connexion au modèle a été coupée")
        case "provider": L10n.text("Le modèle est indisponible")
        case "context": L10n.text("Le travail dépasse ce que le modèle peut lire")
        case "runner": L10n.text("L’agent s’est arrêté en cours d’étape")
        case "missing_output": L10n.text("L’agent n’a pas rendu son travail")
        case "aborted": L10n.text("L’étape a été interrompue")
        default: L10n.text("Une étape n’a pas abouti")
        }
    }

    // MARK: - Session locale

    public static let localSession = L10n.text("Session locale")
    public static let machine = L10n.text("Machine")
    public static let folder = L10n.text("Dossier")
    public static let branch = L10n.text("Branche")
    public static let model = L10n.text("Modèle")
    public static let handoff = L10n.text("Continuer sur le serveur")
    public static let copyResume = L10n.text("Copier la commande de reprise")
    public static let sessionEnded = L10n.text("terminée")
}
