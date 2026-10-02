// L'environnement du shell hébergé dans le PTY, donc de l'`omp` qu'il lance
// (BR-1 étape 1, Doc-1 §5-6, Doc-5 ; S-18 R6).
//
// Fonction PURE : aucune lecture d'état global, aucun accès disque — c'est ce qui
// la rend testable sans lancer de process, et ce qui garantit que le lancement
// réel et sa preuve voient exactement le même environnement.
//
// Le `PATH` suit la règle commune de tout `omp` hébergé (`OmpEnvironment.child`,
// S-3 de la feature omp-console-redesign). Deux faits mesurés commandent les
// règles PROPRES au terminal :
//
//   1. `terminal-capabilities.ts` lit `TERM_PROGRAM` AVANT `COLORTERM` : hériter de
//      `TERM_PROGRAM=iTerm.app` ferait prendre à omp un chemin spécifique iTerm
//      (différent du flux mesuré). Les deux variables sont donc RETIRÉES.
//   2. La couleur vient de `COLORTERM=truecolor` et le nom du terminal de
//      `TERM=xterm-256color`, qui sont les deux valeurs de la capture de Doc-1.

import Foundation

enum TerminalEnvironment {
    /// Environnement de l'enfant : celui de tout `omp` hébergé (`PATH` complété, où
    /// le shell trouve `omp`) augmenté des variables du terminal, moins celles que
    /// omp ne doit pas hériter.
    static func child(base: [String: String], executable: URL) -> [String: String] {
        var environment = OmpEnvironment.child(base: base, executable: executable)
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        // Doc-1 §5 : hérités d'un vrai terminal (iTerm, Apple_Terminal, tmux), ils
        // feraient diverger omp du chemin mesuré.
        environment.removeValue(forKey: "TERM_PROGRAM")
        environment.removeValue(forKey: "TERM_PROGRAM_VERSION")
        return environment
    }
}
