// TOUS les textes affichés par la fenêtre « Terminal » (S-10, BR-3) : un seul
// endroit à corriger, et des constantes pures donc testables sans UI.
//
// C'est aussi la SEULE table de texte des échecs du terminal : `TerminalHostError
// .userMessage` (BR-1) y délègue, sauf pour `binaryNotFound` qui délègue à
// `SessionHostError` — la table existante de résolution du binaire, jamais
// reformulée ici.
//
// Aucun de ces textes n'est un message de la session RPC : ceux-là viennent de
// `SessionHostError.userMessage`.

import Foundation

enum TerminalViewText {
    // MARK: - Titres et libellés

    static let windowTitle = "Terminal"
    static let menuOpen = "Ouvrir un terminal OMP…"
    static let pickerTitle = "Choisir un répertoire"
    static let chooseTarget = "Choisir un répertoire…"
    static let relaunch = "Relancer"
    static let open = "Ouvrir"
    static let cancel = "Annuler"
    static let retry = "Réessayer"
    static let noTarget = "Aucun répertoire"

    // MARK: - États de la fenêtre (S-10)

    /// État initial : aucun process, rien à afficher tant qu'un répertoire n'est pas
    /// choisi. Le second libellé est celui de l'état `listing` de S-10 : la feuille
    /// est ouverte et le catalogue se charge, la fenêtre le dit.
    static let chooseHint = "Choisissez un répertoire…"
    static let listing = "Lecture des worktrees…"
    static let starting = "Lancement d'omp…"

    /// Ligne d'état `running` : `omp vivant (pid <n>)`. Le libellé de la cible est
    /// ajouté par `running(pid:target:)` — même source, deux précisions.
    static func running(pid: Int32) -> String {
        "omp vivant (pid \(pid))"
    }

    static func running(pid: Int32, target: String?) -> String {
        guard let target, !target.isEmpty else { return running(pid: pid) }
        return "\(running(pid: pid)) · \(target)"
    }

    /// Forme `<exited|signal> <n>` de S-2, réutilisée telle quelle.
    static func exited(_ exit: ProcessExit) -> String {
        switch exit.reason {
        case .exited: "omp s'est terminé (code \(exit.status))."
        case .uncaughtSignal: "omp s'est terminé (signal \(exit.status))."
        }
    }

    // MARK: - Messages d'échec (table unique, S-10)

    static func cwdMissing(_ path: String) -> String {
        "Répertoire introuvable : \(path)."
    }

    static func ptyUnavailable(_ code: Int32) -> String {
        "PTY indisponible (\(code)) : aucun process lancé."
    }

    static func writeFailed(_ code: Int32) -> String {
        "Écriture impossible vers le terminal (erreur \(code))."
    }

    static let notRunning = "Aucun terminal vivant."

    // MARK: - Feuille de choix (S-2, BR-4)

    static let noProject = "Aucun projet ouvert : choisissez d'abord un dossier dans la fenêtre « Session OMP »."
    static let loadingTargets = "Lecture des worktrees…"
    static let emptyTargets = "Aucun worktree de feature dans ce dépôt."
    static let targetPath = "Répertoire"
}
