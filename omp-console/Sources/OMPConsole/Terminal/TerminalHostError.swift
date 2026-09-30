// Les échecs du PTY, en liste close (BR-1, S-1). `userMessage` est l'UNIQUE table
// de traduction vers le texte affiché de la fenêtre « Terminal » (S-10) : l'hôte
// ne compose jamais de phrase, et la fenêtre ne reformule jamais ce qu'elle reçoit.
//
// `binaryNotFound` DÉLÈGUE à `SessionHostError.binaryNotFound(searched:override:)`
// et n'écrit pas sa propre phrase : le binaire `omp` est le même pour la session
// RPC et pour le terminal, donc son message d'absence doit l'être aussi — deux
// formulations divergeraient à la première retouche.

import Foundation

enum TerminalHostError: Error, Equatable, Sendable {
    /// Le chemin demandé n'est pas un fichier exécutable : `searched` porte le
    /// chemin testé (un seul, celui de `start`) et `override` l'échappatoire
    /// `OMP_CONSOLE_OMP_BINARY` quand c'est elle qui a désigné ce chemin.
    case binaryNotFound(searched: [String], override: String?)
    /// `forkpty` a échoué : `errno` tel que rendu par l'appel (EAGAIN, ENXIO…).
    case ptyUnavailable(Int32)
    /// Le répertoire de travail n'existe pas (S-1 : le fils sort en 127).
    case cwdMissing(String)
    /// Écriture refusée par le maître du PTY : `errno` de l'appel.
    case writeFailed(Int32)
    /// Aucun enfant vivant : rien à écrire.
    case notRunning

    var userMessage: String {
        switch self {
        case .binaryNotFound(let searched, let override):
            return SessionHostError.binaryNotFound(searched: searched, override: override).userMessage
        case .ptyUnavailable(let code):
            return TerminalViewText.ptyUnavailable(code)
        case .cwdMissing(let path):
            return TerminalViewText.cwdMissing(path)
        case .writeFailed(let code):
            return TerminalViewText.writeFailed(code)
        case .notRunning:
            return TerminalViewText.notRunning
        }
    }
}
