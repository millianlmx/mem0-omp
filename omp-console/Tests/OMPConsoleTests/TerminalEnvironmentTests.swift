// Preuves de BR-1 étape 1 (AC-1) : l'environnement du `omp` hébergé dans le PTY.
//
// `TerminalEnvironment.child` est PURE : ces preuves n'ouvrent aucun process et ne
// lisent rien du poste — l'environnement de base est injecté. Ce qui est figé ici
// n'est pas cosmétique : `omp` est un script à shebang `#!/usr/bin/env bun` (Doc-1
// §6), donc un `PATH` sans `~/.bun/bin` fait échouer le lancement sans que rien ne
// le dise, et `TERM_PROGRAM` hérité fait diverger omp du flux mesuré (Doc-1 §5).

import Foundation
import Testing
@testable import OMPConsole

@Test("terminal-integre/AC-1 : l'enfant reçoit TERM et COLORTERM et n'hérite pas de TERM_PROGRAM")
func childSetsTerminalVariables() {
    let environment = TerminalEnvironment.child(
        base: [
            "TERM_PROGRAM": "iTerm.app",
            "TERM_PROGRAM_VERSION": "3.5.0",
            "LANG": "fr_FR.UTF-8",
        ],
        executable: URL(fileURLWithPath: "/opt/homebrew/bin/omp")
    )

    #expect(environment["TERM"] == "xterm-256color")
    #expect(environment["COLORTERM"] == "truecolor")
    // Doc-1 §5 : `terminal-capabilities.ts` lit `TERM_PROGRAM` AVANT `COLORTERM` ;
    // l'hériter ferait prendre à omp le chemin spécifique d'iTerm ou d'Apple_Terminal.
    #expect(environment["TERM_PROGRAM"] == nil)
    #expect(environment["TERM_PROGRAM_VERSION"] == nil)
    // Tout le reste est hérité tel quel (c'est lui qui porte `HOME`, donc `~/.omp`).
    #expect(environment["LANG"] == "fr_FR.UTF-8")
}

@Test("terminal-integre/AC-1 : le PATH de l'enfant préfixe le dossier du binaire et les trois replis")
func childPathPrefixesBinaryDirectoryAndFallbacks() {
    let environment = TerminalEnvironment.child(
        base: ["HOME": "/Users/toto", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"],
        executable: URL(fileURLWithPath: "/Users/toto/.bun/bin/omp")
    )

    // Doc-5 : launchd ne donne que `/usr/bin:/bin:/usr/sbin:/sbin`, où `bun` n'est
    // pas — les replis doivent donc précéder l'héritage, et la déduplication garde
    // la PREMIÈRE occurrence (`/Users/toto/.bun/bin` est ici aussi le dossier du
    // binaire).
    #expect(environment["PATH"] == "/Users/toto/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
}

@Test("terminal-integre/AC-1 : le PATH déduplique en gardant la première occurrence et ignore le dossier racine")
func childPathDeduplicatesAndIgnoresRoot() {
    // `/opt/homebrew/bin` est à la fois le dossier du binaire et une entrée héritée :
    // il n'apparaît qu'une fois, à sa première place.
    let deduplicated = TerminalEnvironment.child(
        base: ["HOME": "/Users/toto", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin"],
        executable: URL(fileURLWithPath: "/opt/homebrew/bin/omp")
    )
    #expect(deduplicated["PATH"] == "/opt/homebrew/bin:/Users/toto/.bun/bin:/usr/local/bin:/usr/bin")

    // Un binaire à la racine (`/omp`) n'ajoute pas `/` : un `PATH` qui commence par
    // `/` serait absurde et masquerait les replis.
    let rootBinary = TerminalEnvironment.child(
        base: ["HOME": "/Users/toto"],
        executable: URL(fileURLWithPath: "/omp")
    )
    #expect(rootBinary["PATH"] == "/Users/toto/.bun/bin:/opt/homebrew/bin:/usr/local/bin")

    // Sans `HOME`, `$HOME/.bun/bin` n'existe pas : les deux replis fixes restent.
    let withoutHome = TerminalEnvironment.child(
        base: [:],
        executable: URL(fileURLWithPath: "/omp")
    )
    #expect(withoutHome["PATH"] == "/opt/homebrew/bin:/usr/local/bin")
}

@Test("terminal-integre/AC-1 : l'environnement de base n'est pas modifié")
func childDoesNotMutateBase() {
    let base = ["PATH": "/usr/bin", "TERM_PROGRAM": "Apple_Terminal"]
    _ = TerminalEnvironment.child(base: base, executable: URL(fileURLWithPath: "/usr/local/bin/omp"))
    #expect(base["TERM_PROGRAM"] == "Apple_Terminal")
    #expect(base["TERM"] == nil)
}
