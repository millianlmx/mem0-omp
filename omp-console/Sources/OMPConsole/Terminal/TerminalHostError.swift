// Les échecs du PTY, en liste close (BR-1, S-1). `userMessage` est l'UNIQUE table
// de traduction vers le texte affiché de la fenêtre « Terminal » (S-10) : l'hôte
// ne compose jamais de phrase, et la fenêtre ne reformule jamais ce qu'elle reçoit.
//
// Le programme hébergé est le shell de connexion (S-18 R6), plus `omp` : son
// absence n'a donc rien à voir avec la résolution du binaire `omp`, et son message
// vit dans `TerminalViewText` comme les autres.

import Foundation

enum TerminalHostError: Error, Equatable, Sendable {
    /// Le chemin demandé n'est pas un fichier exécutable (le chemin testé, celui de
    /// `start`).
    case executableNotFound(String)
    /// `forkpty` a échoué : `errno` tel que rendu par l'appel (EAGAIN, ENXIO…).
    case ptyUnavailable(Int32)
    /// Le répertoire de travail n'existe pas (S-1 : le fils sort en 127).
    case cwdMissing(String)
    /// Écriture refusée par le maître du PTY : `errno` de l'appel.
    case writeFailed(Int32)
    /// Aucun enfant vivant : rien à écrire.
    case notRunning

    /// La phrase affichée : seul `.ptyUnavailable` diffère du diagnostic (S-7).
    var userMessage: String {
        if case .ptyUnavailable = self { return TerminalViewText.ptyUnavailable }
        return diagnostic
    }

    /// Le brut copié par « Copier le diagnostic » (S-7).
    var diagnostic: String {
        switch self {
        case .executableNotFound(let path):
            return TerminalViewText.executableMissing(path)
        case .ptyUnavailable(let code):
            return TerminalViewText.ptyUnavailableDiagnostic(code: code)
        case .cwdMissing(let path):
            return TerminalViewText.cwdMissing(path)
        case .writeFailed(let code):
            return TerminalViewText.writeFailed(code)
        case .notRunning:
            return TerminalViewText.notRunning
        }
    }
}
