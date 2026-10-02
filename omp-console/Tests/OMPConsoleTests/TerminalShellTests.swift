// Preuves de S-18 R6 : le terminal lance le shell de connexion de l'utilisateur,
// jamais `omp` lui-même. `TerminalShell.command` est PURE à l'environnement près :
// les shells candidats sont des fichiers écrits par le test, aucun n'est exécuté.

import Foundation
import Testing
@testable import OMPConsole

@Test("omp-console-redesign/S-18 : le terminal lance le shell de connexion, omp à la demande")
func terminalLaunchesTheLoginShell() throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("terminal-shell-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appendingPathComponent("fish")
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
    let notExecutable = directory.appendingPathComponent("plain")
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: notExecutable)

    func command(_ shell: String?) -> TerminalShell.Command {
        var environment = ["PATH": "/usr/bin:/bin", "HOME": directory.path]
        environment["SHELL"] = shell
        return TerminalShell.command(environment: environment, fileManager: .default)
    }
    let fallback = TerminalShell.Command(executable: URL(fileURLWithPath: "/bin/zsh"), arguments: ["-l"])

    // `$SHELL` valide : c'est LUI, en shell de connexion — argv = [shell, "-l"].
    #expect(command(executable.path) == TerminalShell.Command(executable: executable, arguments: ["-l"]))
    // Absent, vide, relatif (même résoluble par `PATH`), non exécutable, absent du
    // disque, ou répertoire : le shell par défaut de macOS, toujours en `-l`.
    #expect(command(nil) == fallback)
    #expect(command("") == fallback)
    #expect(command("sh") == fallback)
    #expect(command(notExecutable.path) == fallback)
    #expect(command(directory.appendingPathComponent("absent").path) == fallback)
    #expect(command(directory.path) == fallback)
}
