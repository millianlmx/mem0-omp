// L'environnement du `omp` hébergé dans le PTY (BR-1 étape 1, Doc-1 §5-6, Doc-5).
//
// Fonction PURE : aucune lecture d'état global, aucun accès disque — c'est ce qui
// la rend testable sans lancer de process, et ce qui garantit que le lancement
// réel et sa preuve voient exactement le même environnement.
//
// Trois faits mesurés commandent ces règles :
//
//   1. `omp` est un script à shebang `#!/usr/bin/env bun` : le `bun` doit être
//      trouvable dans le `PATH` de l'enfant. Une app lancée par le Finder hérite du
//      `PATH` de launchd (`/usr/bin:/bin:/usr/sbin:/sbin`) et ne verrait donc
//      JAMAIS `~/.bun/bin`, où omp 18.4.1 est installé sur le poste de référence
//      (Doc-5). Les trois replis sont préfixés pour cette raison.
//   2. `terminal-capabilities.ts` lit `TERM_PROGRAM` AVANT `COLORTERM` : hériter de
//      `TERM_PROGRAM=iTerm.app` ferait prendre à omp un chemin spécifique iTerm
//      (différent du flux mesuré). Les deux variables sont donc RETIRÉES.
//   3. La couleur vient de `COLORTERM=truecolor` et le nom du terminal de
//      `TERM=xterm-256color`, qui sont les deux valeurs de la capture de Doc-1.

import Foundation

enum TerminalEnvironment {
    /// Environnement de l'enfant : `base` (l'environnement de l'app) augmenté des
    /// variables du terminal, moins celles que omp ne doit pas hériter.
    ///
    /// L'ordre du `PATH` est DÉTERMINISTE et dédupliqué en gardant la première
    /// occurrence : le répertoire du binaire, les trois emplacements de repli, puis
    /// l'héritage dans son ordre d'origine.
    static func child(base: [String: String], executable: URL) -> [String: String] {
        var environment = base
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        // Doc-1 §5 : hérités d'un vrai terminal (iTerm, Apple_Terminal, tmux), ils
        // feraient diverger omp du chemin mesuré.
        environment.removeValue(forKey: "TERM_PROGRAM")
        environment.removeValue(forKey: "TERM_PROGRAM_VERSION")

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

        if let home = environment["HOME"], !home.isEmpty { append("\(home)/.bun/bin") }
        append("/opt/homebrew/bin")
        append("/usr/local/bin")

        for inherited in (base["PATH"] ?? "").split(separator: ":", omittingEmptySubsequences: true) {
            append(String(inherited))
        }
        environment["PATH"] = entries.joined(separator: ":")

        return environment
    }
}
