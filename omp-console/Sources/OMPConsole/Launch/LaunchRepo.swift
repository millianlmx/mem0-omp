// Les règles PURES de la feuille « Nouvelle feature » (S-6 de
// omp-console-redesign) : les dépôts proposés et la garde « racine git ». Aucune
// vue ici ; le disque n'est lu que par le `FileManager` injecté.

import ConsoleCore
import Foundation

enum LaunchRepo {
    /// Les dépôts connus du tableau (∪ projet ouvert), plus le dossier choisi à la
    /// main — triés, dédupliqués.
    static func options(cards: [KanbanCard], projectRoot: String?, chosen: String?) -> [String] {
        var roots = Set(KanbanLaunchRepos.options(cards: cards, projectRoot: projectRoot))
        if let chosen, !chosen.isEmpty { roots.insert(chosen) }
        return roots.sorted()
    }

    /// Une racine de dépôt git : `<path>/.git` existe, dossier OU fichier (un
    /// worktree lié porte un FICHIER `.git`) — la règle de ProjectRoot.
    static func isGitRoot(path: String, fileManager: FileManager = .default) -> Bool {
        guard !path.isEmpty else { return false }
        return fileManager.fileExists(atPath: (path as NSString).appendingPathComponent(".git"))
    }
}
