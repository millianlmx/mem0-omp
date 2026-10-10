// TOUS les textes affichés par la fenêtre « Terminal » (S-10, BR-3) : un seul
// endroit à corriger, et des constantes pures donc testables sans UI.
//
// C'est aussi la SEULE table de texte des échecs du terminal : `TerminalHostError
// .userMessage` (BR-1) y délègue.
//
// Le programme hébergé est le shell de connexion de l'utilisateur, `omp` étant
// lancé à la demande (S-18 R6) : les états parlent du SHELL.
//
// Aucun de ces textes n'est un message de la session servie : ceux-là viennent de
// `ServiceSessionModel.userMessage`.

import Foundation

enum TerminalViewText {
    // MARK: - Titres et libellés

    /// Le titre de la scène, et celui de la fenêtre tant qu'aucun répertoire
    /// n'est choisi ; ensuite, la fenêtre porte le nom du répertoire.
    static let windowTitle = "Terminal"
    static let pickerTitle = "Choisir un répertoire"
    static let chooseTarget = "Choisir un dossier…"
    static let relaunch = "Relancer"
    static let launchOmp = "Lancer OMP"
    static let open = "Ouvrir"
    static let cancel = "Annuler"
    static let retry = "Réessayer"

    /// Le programme au premier plan, en tête du sous-titre : le shell, ou `omp`
    /// une fois lancé depuis la barre d'outils.
    static let shellKind = "Shell"
    static let ompKind = "OMP"

    // MARK: - États de la fenêtre (S-10)

    /// État initial : aucun process, rien à afficher tant qu'un répertoire n'est pas
    /// choisi. Le second libellé est celui de l'état `listing` de S-10 : la feuille
    /// est ouverte et le catalogue se charge, la fenêtre le dit.
    static let chooseHint = "Choisissez un répertoire…"
    static let listing = "Recherche des dossiers de features…"
    static let starting = "Lancement du shell…"
    static let running = "Le shell est actif."

    /// L'état en un mot, pour le sous-titre de la fenêtre.
    static let stateStarting = "Démarrage…"
    static let stateRunning = "Actif"
    static let stateExited = "Terminé"
    static let stateFailed = "Échec"

    /// Le sous-titre : « Shell · Actif », « omp · Actif » ; vide tant qu'aucun
    /// shell n'a été lancé.
    static func subtitle(kind: String, state: String?) -> String {
        guard let state else { return "" }
        return "\(kind) · \(state)"
    }

    /// La fin du shell : le code de sortie n'apprend rien à l'utilisateur, la
    /// relance est l'unique geste utile.
    static let exited = "Le shell s'est terminé. Relancez-le pour continuer."

    // MARK: - Messages d'échec (table unique, S-10)

    static func cwdMissing(_ path: String) -> String {
        "Répertoire introuvable : \(path)."
    }

    static func executableMissing(_ path: String) -> String {
        "Exécutable introuvable : \(path)."
    }

    /// La phrase affichée (S-7) : la cause en mots, puis le geste.
    static let ptyUnavailable = "Le terminal n'a pas pu s'ouvrir : le Mac refuse d'en créer un de plus pour l'instant. Fermez des fenêtres de terminal inutiles, puis relancez."

    /// Le brut copié par « Copier le diagnostic » (S-7).
    static func ptyUnavailableDiagnostic(code: Int32) -> String {
        "PTY indisponible (\(code)) : aucun process lancé."
    }

    static func writeFailed(_ code: Int32) -> String {
        "Écriture impossible vers le terminal (erreur \(code))."
    }

    static let notRunning = "Aucun terminal actif."

    // MARK: - Feuille de choix (S-2, BR-4)

    static let noProject = "Aucun projet ouvert : choisissez d'abord un dossier dans la section « Session OMP »."
    static let loadingTargets = "Recherche des dossiers de features…"
    static let emptyTargets = "Aucun dossier de feature dans ce projet."
    static let targetPath = "Répertoire"
}
