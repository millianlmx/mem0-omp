// Le programme hébergé par la fenêtre « Terminal » (S-18 R6) : le shell de
// connexion de l'utilisateur, `omp` à la demande.
//
// `command` ne lit QUE ce qu'on lui passe (l'environnement, le gestionnaire de
// fichiers) : le lancement réel et sa preuve voient donc la même décision. La
// règle d'exécutabilité est celle de tout binaire de l'app : c'est le fichier
// EXÉCUTABLE qui gagne, jamais le seul fait d'exister.

import Foundation

enum TerminalShell {
    /// Le shell de connexion par défaut de macOS : celui de tout compte qui n'en a
    /// pas choisi d'autre.
    static let fallback = "/bin/zsh"

    /// Ce que « Lancer omp » tape dans le shell : la commande et un Retour (`0x0D`,
    /// l'octet que la touche Retour envoie). Le shell cherche `omp` dans le `PATH`
    /// complété par `TerminalEnvironment.child`.
    static let launchOmpKeys: [UInt8] = Array("omp\r".utf8)

    struct Command: Equatable, Sendable {
        let executable: URL
        /// Arguments APRÈS `argv[0]` (qui est toujours le chemin de l'exécutable).
        let arguments: [String]
    }

    /// `$SHELL` s'il désigne un FICHIER exécutable par un chemin ABSOLU, sinon
    /// `/bin/zsh` ; toujours en shell de connexion (`-l`), pour que les fichiers de
    /// profil de l'utilisateur posent son `PATH` comme dans Terminal.app. Un
    /// répertoire est écarté : `isExecutableFile` le dit « exécutable » (bit x de
    /// traversée), mais `execve` le refuse.
    static func command(environment: [String: String], fileManager: FileManager) -> Command {
        var isDirectory: ObjCBool = false
        let path: String
        if let shell = environment["SHELL"], shell.hasPrefix("/"),
           fileManager.fileExists(atPath: shell, isDirectory: &isDirectory), !isDirectory.boolValue,
           fileManager.isExecutableFile(atPath: shell) {
            path = shell
        } else {
            path = fallback
        }
        return Command(executable: URL(fileURLWithPath: path), arguments: ["-l"])
    }
}
