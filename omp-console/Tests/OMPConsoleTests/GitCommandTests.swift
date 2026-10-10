// Les `argv` de la fonctionnalité, figés (S-3, S-4, S-8).
//
// Deux preuves distinctes : la FORME exacte de chaque commande (une option perdue
// ferait diverger le diff de celui de git, ou écrirait dans l'index), et
// l'appartenance de chaque sous-commande à la liste blanche de lecture — aucune
// commande d'écriture n'est constructible.

import Foundation
import Testing

@testable import OMPConsole

/// Tous les `argv` que la fonctionnalité sait produire : c'est la liste COMPLÈTE,
/// et c'est elle que l'invariant de lecture seule confronte à S-8.
private let allCommands: [[String]] = [
    GitCommand.lsTracked(),
    GitCommand.lsUntracked(),
    GitCommand.diffTracked(base: "HEAD", path: "folder/inner.txt"),
    GitCommand.diffUntracked(path: "folder/new.txt"),
    GitCommand.worktreeList(),
    GitCommand.gitCommonDir(),
    GitCommand.originHead(),
    GitCommand.mergeBase(a: "HEAD", b: "main"),
    GitCommand.abbrevRefHead(),
    GitCommand.gitPath("index"),
]

@Test("visionneuse-de-fichiers-et-diffs/AC-1 : l'arbre interroge git par `ls-files -z --cached` et `ls-files -z --others --exclude-standard`")
func treeCommandsAreTheTwoLsFiles() {
    // `-z` : aucun échappement, donc un chemin à espaces ou accents arrive tel quel.
    #expect(GitCommand.lsTracked() == ["ls-files", "-z", "--cached"])
    #expect(GitCommand.lsUntracked() == ["ls-files", "-z", "--others", "--exclude-standard"])
}

@Test("visionneuse-de-fichiers-et-diffs/AC-3 : le diff d'un fichier suivi est `git diff --no-color --no-ext-diff <base> -- <chemin>`")
func trackedDiffCommandIsExact() {
    #expect(
        GitCommand.diffTracked(base: "abc1234", path: "folder/inner.txt")
            == ["diff", "--no-color", "--no-ext-diff", "abc1234", "--", "folder/inner.txt"]
    )
}

@Test("visionneuse-de-fichiers-et-diffs/AC-5 : le diff d'un fichier non suivi passe par `--no-index -- /dev/null`, jamais par l'index")
func untrackedDiffCommandIsExact() {
    #expect(
        GitCommand.diffUntracked(path: "folder/new.txt")
            == ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", "folder/new.txt"]
    )
}

@Test("visionneuse-de-fichiers-et-diffs/AC-6 : la base du dépôt principal est littéralement HEAD")
func primaryBaseIsHead() {
    #expect(FilesBase.head.gitArgument == "HEAD")
    #expect(FilesBase.head.label == "HEAD")
    // Une base indisponible n'a AUCUN argument : la vue n'appelle alors pas git.
    #expect(FilesBase.unavailable("pas de base").gitArgument == nil)
    #expect(FilesBase.commit("0123456789abcdef0123456789abcdef01234567").label == "base 0123456")
}

@Test("visionneuse-de-fichiers-et-diffs/AC-13 : aucune sous-commande de GitCommand n'est hors de la liste blanche de lecture")
func commandsStayInsideTheWhitelist() {
    let banned = [
        "add", "update-index", "status", "checkout", "restore", "commit", "stash",
        "apply", "gc", "fetch", "prune", "repair", "rm", "mv", "reset", "switch",
    ]
    for argv in allCommands {
        #expect(gitAllowedSubcommands.contains(argv[0]), "\(argv) : sous-commande hors liste blanche")
        for argument in argv.dropFirst() where banned.contains(argument) {
            Issue.record("\(argv) : « \(argument) » est un argument d'écriture")
        }
    }
    // `worktree` n'est admise que sous la forme `list` : `add`, `remove`, `prune` et
    // `repair` écrivent dans le dépôt.
    #expect(Array(GitCommand.worktreeList().dropFirst()) == ["list", "--porcelain"])
}

@Test("visionneuse-de-fichiers-et-diffs/AC-13 : le binaire git est résolu dans l'ordre de S-8, l'override seul")
func gitBinaryResolutionOrder() {
    let environment = ["PATH": "/usr/bin:/bin", "OMP_CONSOLE_GIT_BINARY": "/custom/git"]
    #expect(GitBinary.candidates(environment: environment) == ["/custom/git"])

    let plain = ["PATH": "/usr/bin:/bin"]
    #expect(
        GitBinary.candidates(environment: plain)
            == ["/usr/bin/git", "/bin/git", "/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
    )
}

@Test("visionneuse-de-fichiers-et-diffs/AC-13 : git introuvable est une erreur nommée, jamais un chemin vide")
func gitNotFoundIsNamed() {
    let result = GitBinary.resolve(environment: ["OMP_CONSOLE_GIT_BINARY": "/nowhere/git"], path: "/tmp/projet")
    guard case let .failure(error) = result else {
        Issue.record("un override inexistant doit échouer")
        return
    }
    #expect(error == .gitNotFound(searched: ["/nowhere/git"], override: "/nowhere/git", path: "/tmp/projet"))
    #expect(error.diagnostic.contains("git est introuvable"))
    #expect(error.diagnostic.contains("/tmp/projet"))
    #expect(error.userMessage == FilesText.gitNotFound)
}
