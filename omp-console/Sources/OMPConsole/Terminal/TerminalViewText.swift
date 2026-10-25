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

import ConsoleCore
import Foundation

enum TerminalViewText {
    // MARK: - Titres et libellés

    /// Le titre de la scène, et celui de la fenêtre tant qu'aucun répertoire
    /// n'est choisi ; ensuite, la fenêtre porte le nom du répertoire.
    static let windowTitle = L10n.text("Terminal")
    static let pickerTitle = L10n.text("Choisir un répertoire")
    static let chooseTarget = L10n.text("Choisir un dossier…")
    static let relaunch = L10n.text("Relancer")
    static let launchOmp = L10n.text("Lancer OMP")
    static let open = L10n.text("Ouvrir")
    static let cancel = L10n.text("Annuler")
    static let retry = L10n.text("Réessayer")

    /// Le programme au premier plan, en tête du sous-titre : le shell, ou `omp`
    /// une fois lancé depuis la barre d'outils.
    static let shellKind = L10n.text("Interpréteur")
    static let ompKind = "OMP"

    // MARK: - États de la fenêtre (S-10)

    /// État initial : aucun process, rien à afficher tant qu'un répertoire n'est pas
    /// choisi. Le second libellé est celui de l'état `listing` de S-10 : la feuille
    /// est ouverte et le catalogue se charge, la fenêtre le dit.
    static let chooseHint = L10n.text("Choisissez un répertoire…")
    static let listing = L10n.text("Recherche des dossiers de features…")
    static let starting = L10n.text("Lancement de l’interpréteur…")
    static let running = L10n.text("L’interpréteur est actif.")

    /// La zone sans shell ni projet choisi (S-1 de mac-etats-vides-sans-issue) :
    /// elle porte l'action « Choisir un projet… ». Aucun raccourci nommé.
    static let noProjectTitle = L10n.text("Aucun projet ouvert")
    static let noProjectDescription = L10n.text("Choisissez le projet dans lequel ouvrir un terminal.")

    /// La zone sans shell, projet choisi (S-4) : le projet dont la feuille
    /// listera les répertoires.
    static func projectNamed(_ name: String) -> String {
        L10n.format("Projet « %@ »", name)
    }

    /// L'état en un mot, pour le sous-titre de la fenêtre.
    static let stateStarting = L10n.text("Démarrage…")
    static let stateRunning = L10n.text("Actif")
    static let stateExited = L10n.text("Terminé")
    static let stateFailed = L10n.text("Échec")

    /// Le sous-titre : « Shell · Actif », « omp · Actif » ; vide tant qu'aucun
    /// shell n'a été lancé.
    static func subtitle(kind: String, state: String?) -> String {
        guard let state else { return "" }
        return "\(kind) · \(state)"
    }

    /// La fin du shell : le code de sortie n'apprend rien à l'utilisateur, la
    /// relance est l'unique geste utile.
    static let exited = L10n.text("L’interpréteur s’est terminé. Relancez-le pour continuer.")

    // MARK: - Messages d'échec (table unique, S-10)

    static func cwdMissing(_ path: String) -> String {
        L10n.format("Répertoire introuvable : %@.", path)
    }

    static func executableMissing(_ path: String) -> String {
        L10n.format("Exécutable introuvable : %@.", path)
    }

    /// La phrase affichée (S-7) : la cause en mots, puis le geste.
    static let ptyUnavailable = L10n.text("Le terminal n’a pas pu s’ouvrir : le Mac refuse d’en créer un de plus pour l’instant. Fermez des fenêtres de terminal inutiles, puis relancez.")

    /// Le brut copié par « Copier le diagnostic » (S-7).
    static func ptyUnavailableDiagnostic(code: Int32) -> String {
        "Pseudo-terminal indisponible (\(code)) : aucun processus lancé."
    }

    static func writeFailed(_ code: Int32) -> String {
        L10n.format("Écriture impossible vers le terminal (erreur %lld).", Int(code))
    }

    static let notRunning = L10n.text("Aucun terminal actif.")

    // MARK: - Feuille de choix (S-2, BR-4)

    static let noProject = L10n.text("Aucun projet ouvert : choisissez d’abord un dossier dans la section « Session OMP ».")
    static let loadingTargets = L10n.text("Recherche des dossiers de features…")
    static let emptyTargets = L10n.text("Aucun dossier de feature dans ce projet.")
    static let targetPath = L10n.text("Répertoire")
}
