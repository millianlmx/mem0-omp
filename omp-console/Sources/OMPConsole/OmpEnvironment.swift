// L'environnement de tout `omp` hébergé par l'app (S-3) : terminal intégré,
// Session OMP, conduite de projet et conducteurs.
//
// Fonction PURE : aucune lecture d'état global, aucun accès disque — c'est ce qui
// la rend testable sans lancer de process, et ce qui garantit que le lancement
// réel et sa preuve voient exactement le même environnement.
//
// Le fait mesuré qui commande la règle : `omp` est un script à shebang
// `#!/usr/bin/env bun`, donc `bun` doit être trouvable dans le `PATH` de l'enfant.
// Une app lancée par le Finder hérite du `PATH` de launchd
// (`/usr/bin:/bin:/usr/sbin:/sbin`) et ne verrait JAMAIS `~/.bun/bin`, où omp est
// installé sur le poste de référence. Les runs `omp -p` d'un lot, lancés par le
// pilote, héritent de SON `PATH` : un conducteur sans ces replis ferait échouer
// chacun de ses maillons.

import Foundation

enum OmpEnvironment {
    /// Environnement de l'enfant : `base` (l'environnement de l'app) dont seul le
    /// `PATH` change. Aucune autre variable n'est ajoutée, retirée ni modifiée —
    /// `HOME` et `MEM0_PIPELINE_STATE_DIR` passent tels quels.
    ///
    /// L'ordre du `PATH` est DÉTERMINISTE et dédupliqué en gardant la première
    /// occurrence : le répertoire du binaire, les trois emplacements de repli, puis
    /// l'héritage dans son ordre d'origine.
    static func child(base: [String: String], executable: URL) -> [String: String] {
        var entries: [String] = []
        var seen = Set<String>()
        func append(_ entry: String) {
            guard !entry.isEmpty, seen.insert(entry).inserted else { return }
            entries.append(entry)
        }

        // Le dossier du binaire : c'est ce qui rend un `omp` explicite (variable
        // d'échappement ou chemin absolu) utilisable même hors des replis.
        let directory = executable.deletingLastPathComponent().path
        if directory != "/" { append(directory) }

        if let home = base["HOME"], !home.isEmpty { append("\(home)/.bun/bin") }
        append("/opt/homebrew/bin")
        append("/usr/local/bin")

        for inherited in (base["PATH"] ?? "").split(separator: ":", omittingEmptySubsequences: true) {
            append(String(inherited))
        }

        var environment = base
        environment["PATH"] = entries.joined(separator: ":")
        return environment
    }
}
