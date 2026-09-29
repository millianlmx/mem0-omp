// Les chemins du projet dans le magasin d'état (S-7).
//
// La clé d'un dépôt est celle du pilote : `sha1(realpath(repoRoot))[:16]`
// (`KanbanRepoKey`). Elle n'est PAS recalculée ici — elle est déléguée, pour qu'il
// n'existe pas deux formules à tenir synchronisées.

import Foundation

enum ProjectPaths {
    /// La clé du dépôt : délégation à `KanbanRepoKey`, seule implémentation.
    static func key(forRoot root: String) -> String {
        KanbanRepoKey.key(forRoot: root)
    }

    /// Le fichier `PROJECT.md` publié par le pilote :
    /// `<stateDir>/projects/<repoKey>.doc/PROJECT.md`.
    static func docFile(stateDir: String, repoKey: String) -> String {
        joinPath(joinPath(joinPath(stateDir, PipelineStore.projects.rawValue), repoKey + ".doc"), "PROJECT.md")
    }
}
