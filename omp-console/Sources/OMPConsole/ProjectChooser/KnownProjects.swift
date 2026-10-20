// Les projets connus de la coque (S-2 de mac-etats-vides-sans-issue) : la liste
// que l'iPhone reçoit par `GET /v1/repos` ET celle du sélecteur des états vides
// de Mémoire, Fichiers et Terminal. UNE seule règle, donc les deux surfaces ne
// peuvent pas diverger.

import ConsoleCore
import Foundation

enum KnownProjects {
    /// Les racines des lots ∪ les racines des projets du magasin ∪ les dépôts
    /// adoptés par une bascule (`repos.json` du dossier d'état, S-5 de
    /// orchestrator-living-in-a-vps ; `stateDir` nul : sans eux), `realpath`ées,
    /// filtrées par la règle « racine git » de `LaunchRepo`, dédupliquées par
    /// chemin puis triées par ordre croissant. Un magasin absent ou illisible est
    /// un instantané vide : la liste l'est aussi.
    static func roots(in snapshot: StoreSnapshot, stateDir: String? = nil, fileManager: FileManager = .default) -> [String] {
        var roots = Set<String>()
        for lot in snapshot.lots.lots where !lot.repoRoot.isEmpty {
            roots.insert(realpathOr(lot.repoRoot))
        }
        for project in snapshot.projects.projects where !project.repoRoot.isEmpty {
            roots.insert(realpathOr(project.repoRoot))
        }
        if let stateDir {
            for repo in RepoDirectory.adopted(stateDir: stateDir) where !repo.repoRoot.isEmpty {
                roots.insert(realpathOr(repo.repoRoot))
            }
        }
        return roots
            .filter { LaunchRepo.isGitRoot(path: $0, fileManager: fileManager) }
            .sorted()
    }
}
