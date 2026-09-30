// Les `argv` de la couche `gh`, figés (S-2, S-6), et la résolution du binaire.
//
// L'invariant : la sous-commande est TOUJOURS `pr`, et ses seconds mots sont
// exactement `view`, `checks`, `merge` — aucune autre forme n'est produite.

import Foundation
import Testing

@testable import OMPConsole

/// Tous les `argv` que la fonctionnalité sait produire : c'est la liste COMPLÈTE.
private let allGhCommands: [[String]] = [
    GhCommand.prView(url: "https://exemple.test/pull/45"),
    GhCommand.prChecks(url: "https://exemple.test/pull/45"),
    GhCommand.prMerge(url: "https://exemple.test/pull/45", title: "t", body: "b", headOid: "abc"),
]

@Test("suivi-pr-ci/AC-1 : la lecture d'une PR est `gh pr view <url> --json title,headRefOid,body`")
func viewCommandIsExact() {
    #expect(
        GhCommand.prView(url: "https://exemple.test/pull/45")
            == ["pr", "view", "https://exemple.test/pull/45", "--json", "title,headRefOid,body"]
    )
}

@Test("suivi-pr-ci/AC-1 : les statuts sont lus par `gh pr checks <url> --json name,bucket,link`")
func checksCommandIsExact() {
    #expect(
        GhCommand.prChecks(url: "https://exemple.test/pull/45")
            == ["pr", "checks", "https://exemple.test/pull/45", "--json", "name,bucket,link"]
    )
}

@Test("suivi-pr-ci/AC-4 : la fusion est `gh pr merge <url> --squash --subject … --body … --match-head-commit …`")
func mergeCommandIsExact() {
    #expect(
        GhCommand.prMerge(url: "https://exemple.test/pull/45", title: "Mon titre", body: "Corps", headOid: "abc123")
            == [
                "pr", "merge", "https://exemple.test/pull/45",
                "--squash", "--subject", "Mon titre", "--body", "Corps", "--match-head-commit", "abc123",
            ]
    )
    // Aucune option interdite n'est constructible (S-6) : ni fusion non-squash, ni
    // suppression de branche, ni fusion automatique, ni contournement d'admin.
    let argv = GhCommand.prMerge(url: "u", title: "t", body: "b", headOid: "h")
    for banned in ["--merge", "--rebase", "--delete-branch", "-d", "--auto", "--admin"] {
        #expect(!argv.contains(banned), "« \(banned) » ne doit jamais figurer dans l'argv de fusion")
    }
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
