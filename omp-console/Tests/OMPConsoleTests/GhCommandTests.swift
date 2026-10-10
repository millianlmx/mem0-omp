// Les `argv` de la couche `gh`, figés (S-2, S-6), et la résolution du binaire.
//
// L'invariant : la sous-commande est TOUJOURS `pr`, et ses seconds mots sont
// exactement `view`, `checks`, `merge` — aucune autre forme n'est produite.

import Foundation
import Testing

@testable import OMPConsole

/// Tous les `argv` que la fonctionnalité sait produire : c'est la liste COMPLÈTE.
private let allGhCommands: [[String]] = [
    GhCommand.prView(url: "https://github.com/proprietaire/depot/pull/45"),
    GhCommand.prState(url: "https://github.com/proprietaire/depot/pull/45"),
    GhCommand.prChecks(url: "https://github.com/proprietaire/depot/pull/45"),
    GhCommand.prMerge(
        url: "https://github.com/proprietaire/depot/pull/45", title: "t", body: "b", headOid: "abc"
    ),
]

/// L'invariant de `--` (S-2), vérifié sur chaque commande : l'URL est le
/// DERNIER argument, immédiatement précédé du seul `--`, et aucune option ne suit
/// le terminateur.
private func expectOptionTerminator(_ argv: [String], url: String) {
    #expect(argv.last == url, "l'URL est le dernier argument : \(argv)")
    #expect(argv.count >= 2 && argv[argv.count - 2] == "--", "`--` précède l'URL : \(argv)")
    #expect(argv.filter { $0 == "--" }.count == 1, "un seul `--` : \(argv)")
    let tail = argv.drop(while: { $0 != "--" })
    #expect(tail.count == 2, "rien ne suit l'URL : \(argv)")
}

@Test("suivi-pr-ci/AC-1 : la lecture d'une PR est `gh pr view --json … -- <url>`")
func viewCommandIsExact() {
    let url = "https://github.com/proprietaire/depot/pull/45"
    #expect(GhCommand.prView(url: url) == ["pr", "view", "--json", "title,headRefOid,body", "--", url])
}

@Test("pipelines-livrees-statut-pr-faux-et-doub/AC-1 : l'état d'une PR est lu par `gh pr view --json state,mergedAt,closedAt -- <url>`")
func stateCommandIsExact() {
    let url = "https://github.com/proprietaire/depot/pull/45"
    #expect(GhCommand.prState(url: url) == ["pr", "view", "--json", "state,mergedAt,closedAt", "--", url])
}

@Test("suivi-pr-ci/AC-1 : les statuts sont lus par `gh pr checks --json … -- <url>`")
func checksCommandIsExact() {
    let url = "https://github.com/proprietaire/depot/pull/45"
    #expect(GhCommand.prChecks(url: url) == ["pr", "checks", "--json", "name,bucket,link", "--", url])
}

@Test("suivi-pr-ci/AC-4 : la fusion est `gh pr merge --squash … -- <url>`")
func mergeCommandIsExact() {
    let url = "https://github.com/proprietaire/depot/pull/45"
    #expect(
        GhCommand.prMerge(url: url, title: "Mon titre", body: "Corps", headOid: "abc123")
            == [
                "pr", "merge",
                "--squash", "--subject", "Mon titre", "--body", "Corps", "--match-head-commit", "abc123",
                "--", url,
            ]
    )
    // Aucune option interdite n'est constructible (S-6) : ni fusion non-squash, ni
    // suppression de branche, ni fusion automatique, ni contournement d'admin.
    let argv = GhCommand.prMerge(url: "u", title: "t", body: "b", headOid: "h")
    for banned in ["--merge", "--rebase", "--delete-branch", "-d", "--auto", "--admin"] {
        #expect(!argv.contains(banned), "« \(banned) » ne doit jamais figurer dans l'argv de fusion")
    }
}

@Test("chemins-du-magasin-non-confines/AC-3 : chaque argv place l'URL en positionnel APRÈS `--`")
func optionTerminatorPrecedesURL() {
    let url = "https://github.com/proprietaire/depot/pull/45"
    expectOptionTerminator(GhCommand.prView(url: url), url: url)
    expectOptionTerminator(GhCommand.prState(url: url), url: url)
    expectOptionTerminator(GhCommand.prChecks(url: url), url: url)
    expectOptionTerminator(
        GhCommand.prMerge(url: url, title: "t", body: "b", headOid: "abc"), url: url
    )
    // Une URL hostile commençant par `-` n'est plus interprétable comme une option :
    // elle reste positionnelle derrière `--` (et S-3 la refuse de son côté).
    let hostile = "-R evil"
    #expect(GhCommand.prView(url: hostile) == ["pr", "view", "--json", "title,headRefOid,body", "--", hostile])
    expectOptionTerminator(GhCommand.prView(url: hostile), url: hostile)
}

@Test("suivi-pr-ci/AC-1 : aucune sous-commande hors de `pr view|checks|merge` n'est produite")
func commandsStayOnPR() {
    for argv in allGhCommands {
        #expect(argv.first == "pr", "\(argv) : la sous-commande doit être `pr`")
        #expect(["view", "checks", "merge"].contains(argv[1]), "\(argv) : \(argv[1]) n'est pas une sous-commande admise")
    }
}

@Test("suivi-pr-ci/AC-1 : gh est résolu dans l'ordre de S-2, l'override seul, et son absence est nommée")
func ghBinaryResolution() throws {
    // Un override posé et non vide est le SEUL candidat.
    let override = ["PATH": "/usr/bin:/bin", "OMP_CONSOLE_GH_BINARY": "/custom/gh"]
    #expect(GhBinary.candidates(environment: override) == ["/custom/gh"])

    // Sans override : chaque entrée de PATH, puis les trois emplacements connus.
    let plain = ["PATH": "/usr/bin:/bin"]
    #expect(
        GhBinary.candidates(environment: plain)
            == ["/usr/bin/gh", "/bin/gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
    )

    // Un override inexistant échoue nommément, sans jamais retomber sur PATH.
    let missing = GhBinary.resolve(environment: ["OMP_CONSOLE_GH_BINARY": "/nowhere/gh"])
    guard case let .failure(error) = missing else {
        Issue.record("un override inexistant doit échouer")
        return
    }
    #expect(error == .ghNotFound(searched: ["/nowhere/gh"], override: "/nowhere/gh"))
    #expect(error.userMessage.contains("gh est introuvable"))

    // Un override EXÉCUTABLE gagne, et lui seul.
    let script = FileManager.default.temporaryDirectory.appendingPathComponent("gh-\(UUID().uuidString)")
    try Data("#!/bin/sh\n".utf8).write(to: script)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    defer { try? FileManager.default.removeItem(at: script) }
    let resolved = GhBinary.resolve(environment: [
        "PATH": "/usr/bin:/bin",
        "OMP_CONSOLE_GH_BINARY": script.path,
    ])
    #expect(resolved == .success(script))
}

@Test("suivi-pr-ci/AC-1 : l'environnement de gh est restreint et transmet le jeton s'il est posé")
func ghEnvironmentIsRestricted() {
    let source = [
        "PATH": "/usr/bin:/bin",
        "HOME": "/Users/test",
        "GH_TOKEN": "jeton",
        "GH_CONFIG_DIR": "/Users/test/.config/gh",
        "GIT_DIR": "/un/depot/.git",
    ]
    let environment = GhCLI.environment(source)
    #expect(environment["LANG"] == "C")
    #expect(environment["PATH"] == "/usr/bin:/bin")
    #expect(environment["HOME"] == "/Users/test")
    #expect(environment["GH_PROMPT_DISABLED"] == "1")
    #expect(environment["NO_COLOR"] == "1")
    #expect(environment["GH_NO_UPDATE_NOTIFIER"] == "1")
    #expect(environment["GH_TOKEN"] == "jeton")
    #expect(environment["GH_CONFIG_DIR"] == "/Users/test/.config/gh")
    #expect(environment["GIT_DIR"] == nil)
    // Un jeton vide n'est PAS transmis (il masquerait le trousseau).
    #expect(GhCLI.environment(["GH_TOKEN": "", "HOME": ""])["GH_TOKEN"] == nil)
}
