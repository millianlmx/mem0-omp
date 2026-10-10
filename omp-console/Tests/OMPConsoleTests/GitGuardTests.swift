// Preuves de S-4 (AC-5, AC-6) : la liste blanche git est REFUSÉE À L'EXÉCUTION,
// avant toute création de process.
//
// Trois preuves distinctes, comme pour les autres invariants du dépôt :
//  - la règle pure (`GitGuard.refusedCommand`), pour les dix `argv` admis et toutes
//    les formes d'écriture refusées, avec le nom exact ;
//  - le refus par `GitCLI.run`, avec le cas d'erreur dédié ;
//  - « aucun process créé », par une doublure git jetable qui laisse un TÉMOIN quand
//    elle est lancée : un refus ne doit jamais le créer, une commande admise le crée.

import Foundation
import Testing

@testable import OMPConsole

// MARK: - Outils

private func makeGuardDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("git-guard-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Un faux `git` qui ignore ses arguments et laisse une trace de son lancement.
private func makeWitnessGit(witness: URL) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("guard-fake-git-\(UUID().uuidString)")
    try "#!/bin/sh\necho lance >> \(witness.path)\n".write(to: url, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    return url
}

/// Les dix `argv` que la fonctionnalité sait produire (mêmes constructeurs que
/// `GitCommandTests`), tous ADMIS par la garde.
private let admittedCommands: [[String]] = [
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

/// Les formes REFUSÉES et le nom que le refus doit porter.
private let refusedForms: [(arguments: [String], name: String)] = [
    ([], ""),
    (["push"], "push"),
    (["push", "--force"], "push"),
    (["add", "folder/inner.txt"], "add"),
    (["status"], "status"),
    (["fetch"], "fetch"),
    (["commit", "-m", "x"], "commit"),
    (["worktree"], "worktree"),
    (["worktree", "add", "/tmp/w"], "worktree add"),
    (["worktree", "remove", "/tmp/w"], "worktree remove"),
    (["worktree", "prune"], "worktree prune"),
    (["worktree", "repair"], "worktree repair"),
    (["symbolic-ref", "refs/heads/x", "refs/heads/y"], "symbolic-ref"),
    (["symbolic-ref", "-m", "raison", "HEAD", "refs/heads/x"], "symbolic-ref"),
    (["symbolic-ref", "--message", "raison", "HEAD"], "symbolic-ref"),
    (["symbolic-ref", "-d", "HEAD"], "symbolic-ref"),
    (["symbolic-ref", "--delete", "HEAD"], "symbolic-ref"),
    (["symbolic-ref", "--short", "refs/a", "refs/b"], "symbolic-ref"),
]

/// Les formes ADMISES d'une sous-commande présente dans la liste, y compris les
/// options de lecture ajoutées (`-v`, `-z`, `--no-recurse`).
private let admittedVariants: [[String]] = [
    ["worktree", "list", "-v"],
    ["worktree", "list", "--porcelain", "-z"],
    ["symbolic-ref", "--no-recurse", "HEAD"],
    ["symbolic-ref", "--short", "--quiet", "refs/remotes/origin/HEAD"],
]

// MARK: - La règle pure

@Test("runner-de-process-swift-duplique/AC-5 : les dix argv de GitCommand passent la garde")
func allGitCommandsAreAdmitted() {
    for argv in admittedCommands {
        #expect(GitGuard.refusedCommand(argv) == nil, "\(argv) doit être admis")
    }
}

@Test("runner-de-process-swift-duplique/AC-6 : toute sous-commande hors liste est refusée, sous son nom")
func outOfListSubcommandsAreRefused() {
    for (arguments, name) in refusedForms {
        #expect(GitGuard.refusedCommand(arguments) == name, "\(arguments) doit être refusé sous « \(name) »")
    }
}

@Test("runner-de-process-swift-duplique/AC-6 : les formes de lecture de worktree et symbolic-ref restent admises")
func readFormsOfAdmittedSubcommandsPass() {
    for argv in admittedVariants {
        #expect(GitGuard.refusedCommand(argv) == nil, "\(argv) doit être admis")
    }
}

@Test("runner-de-process-swift-duplique/AC-5 : le refus a son texte exact")
func refusedCommandMessageIsExact() {
    #expect(
        FilesError.gitCommandRefused(command: "push").diagnostic
            == "git push n'est pas une commande de lecture autorisée — aucun process n'a été lancé."
    )
    #expect(
        FilesError.gitCommandRefused(command: "worktree add").diagnostic
            == "git worktree add n'est pas une commande de lecture autorisée — aucun process n'a été lancé."
    )
}

// MARK: - Le refus à l'exécution

@Test("runner-de-process-swift-duplique/AC-5 : une sous-commande hors liste échoue sans créer de process git")
func refusedSubcommandsNeverLaunchGit() async throws {
    let directory = try makeGuardDirectory()
    let witness = directory.appendingPathComponent("temoin")
    let cli = GitCLI(binary: try makeWitnessGit(witness: witness), timeout: 5)

    for (arguments, name) in refusedForms {
        do {
            _ = try await cli.run(arguments, in: directory.path)
            Issue.record("\(arguments) devait être refusé")
        } catch let error as FilesError {
            #expect(error == .gitCommandRefused(command: name))
        }
        #expect(
            !FileManager.default.fileExists(atPath: witness.path),
            "un process git a été créé pour \(arguments)"
        )
    }
}

@Test("runner-de-process-swift-duplique/AC-6 : contre-épreuve — chaque argv admis atteint bien git")
func admittedCommandsReachGit() async throws {
    let directory = try makeGuardDirectory()
    let witness = directory.appendingPathComponent("temoin")
    let cli = GitCLI(binary: try makeWitnessGit(witness: witness), timeout: 5)

    for argv in admittedCommands + admittedVariants {
        try? FileManager.default.removeItem(at: witness)
        let output = try await cli.run(argv, in: directory.path)
        #expect(output.code == 0, "\(argv) doit être exécuté")
        #expect(FileManager.default.fileExists(atPath: witness.path), "\(argv) n'a pas atteint le binaire git")
    }
}
