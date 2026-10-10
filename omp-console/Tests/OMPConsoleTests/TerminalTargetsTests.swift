// Preuves de la feuille « Choisir un répertoire » (S-2, BR-4) : le catalogue EST
// celui de la visionneuse de fichiers, et choisir une entrée lance le shell avec CE
// répertoire comme répertoire courant.
//
// Le répertoire effectif du process est prouvé par le programme lui-même : le shell
// de substitution (`$SHELL`, S-18 R6) exécute `/bin/pwd`, donc ce qui s'affiche dans
// la grille EST le cwd de l'enfant.

import AppKit
import Foundation
import Testing
@testable import OMPConsole

/// Un shell de substitution qui imprime son répertoire courant : `/bin/pwd` seul
/// refuserait le `-l` du shell de connexion.
private func makePwdShell() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("terminal-targets-shell-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let script = directory.appendingPathComponent("pwd-shell")
    try Data("#!/bin/sh\nexec /bin/pwd\n".utf8).write(to: script)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    return script
}

@MainActor
private func makeTerminalModel(
    root: String,
    store: StoreReader,
    shell: URL,
    host: TerminalHost = TerminalHost()
) -> TerminalConsoleModel {
    let suite = UserDefaults(suiteName: "terminal-targets-\(UUID().uuidString)") ?? .standard
    suite.set(root, forKey: ProjectRoot.defaultsKey)
    return TerminalConsoleModel(
        host: host,
        defaults: suite,
        environment: [
            "SHELL": shell.path,
            "PATH": "/usr/bin:/bin",
        ],
        store: store,
        git: filesGit()
    )
}

/// Les rangées concaténées SANS séparateur : un chemin plus long que la largeur de
/// la grille est coupé par l'autowrap, donc c'est cette forme qui doit contenir le
/// cwd imprimé par le programme.
@MainActor
private func flatGridText(_ model: TerminalConsoleModel) -> String {
    guard let screen = model.emulator?.screen else { return "" }
    return (0..<screen.rows).map { screen.text(row: $0) }.joined()
}

@MainActor
@Test("terminal-integre/AC-4 : la liste contient le principal et les worktrees, et le choix lance le programme DANS ce répertoire")
func choosingATargetLaunchesTheProgramInThatDirectory() async throws {
    let fixture = try FilesFixture()
    let initial = try fixture.head()
    let worktree = try fixture.makeWorktree(slug: "socle")
    let store = StoreFixture()
    let reader = filesStore(
        store,
        principal: fixture.root,
        features: [("socle", "feat/socle", worktree, initial)]
    )
    let host = TerminalHost()
    let model = makeTerminalModel(root: fixture.root, store: reader, shell: try makePwdShell(), host: host)

    await model.loadTargets()

    #expect(model.targetsState == .ready(2))
    #expect(model.targets.count == 2)
    #expect(model.targets[0].isPrimary)
    #expect(model.targets[0].path == fixture.root)
    #expect(model.targets[0].label == "\((fixture.root as NSString).lastPathComponent) (dépôt principal)")
    #expect(model.targets[1].path == worktree)
    #expect(model.targets[1].branch == "feat/socle")
    // Le principal est présélectionné : le projet ouvert EST le principal.
    #expect(model.selectedTargetPath == fixture.root)

    // Choisir le worktree fait démarrer le programme AVEC ce répertoire.
    model.selectedTargetPath = worktree
    #expect(model.canOpenSelected)
    model.openSelectedTarget()

    #expect(!model.isPickerPresented)
    #expect(await awaitMainTrue(timeout: 5) { flatGridText(model).contains(worktree) })
    #expect(model.target?.path == worktree)
    await host.kill()
}

@MainActor
@Test("terminal-integre/AC-4 : un dépôt sans worktree garde le principal sélectionnable")
func repositoryWithoutWorktreesKeepsThePrimarySelectable() async throws {
    let fixture = try FilesFixture()
    let store = StoreFixture()
    let reader = filesStore(store, principal: fixture.root, features: [])
    let host = TerminalHost()
    let model = makeTerminalModel(root: fixture.root, store: reader, shell: try makePwdShell(), host: host)

    await model.loadTargets()

    #expect(model.targetsState == .empty)
    #expect(model.targets.count == 1)
    #expect(model.targets[0].isPrimary)
    #expect(model.selectedTargetPath == fixture.root)
    #expect(model.canOpenSelected)
    _ = host
}

@MainActor
@Test("terminal-integre/AC-4 : une cible disparue entre l'affichage et le clic est refusée, la feuille reste ouverte")
func vanishedTargetIsRefusedAndTheSheetStaysOpen() async throws {
    let fixture = try FilesFixture()
    let initial = try fixture.head()
    let worktree = try fixture.makeWorktree(slug: "ephemere")
    let store = StoreFixture()
    let reader = filesStore(
        store,
        principal: fixture.root,
        features: [("ephemere", "feat/ephemere", worktree, initial)]
    )
    let host = TerminalHost()
    let model = makeTerminalModel(root: fixture.root, store: reader, shell: try makePwdShell(), host: host)

    model.openPicker()
    #expect(await awaitMainTrue { !model.targets.isEmpty })
    model.selectedTargetPath = worktree

    // Le répertoire disparaît APRÈS l'affichage de la liste.
    try FileManager.default.removeItem(atPath: worktree)
    model.openSelectedTarget()

    #expect(model.sheetError == TerminalViewText.cwdMissing(worktree))
    #expect(model.isPickerPresented)
    #expect(!model.isRunning)
    #expect(host.pid == nil)
}

@MainActor
@Test("terminal-integre/AC-4 : git introuvable met la feuille en échec avec le message existant")
func withoutGitTheSheetFails() async throws {
    let fixture = try FilesFixture()
    let store = StoreFixture()
    let reader = filesStore(store, principal: fixture.root, features: [])
    let suite = UserDefaults(suiteName: "terminal-targets-\(UUID().uuidString)") ?? .standard
    suite.set(fixture.root, forKey: ProjectRoot.defaultsKey)
    let missingGit = (fixture.root as NSString).appendingPathComponent("git-absent")
    // Aucun `git` injecté : c'est la résolution de `GitBinary` qui échoue.
    let model = TerminalConsoleModel(
        host: TerminalHost(),
        defaults: suite,
        environment: [GitBinary.overrideKey: missingGit],
        store: reader
    )

    await model.loadTargets()

    let expected = FilesError.gitNotFound(searched: [missingGit], override: missingGit, path: fixture.root)
    #expect(model.targetsState == .failed(expected.userMessage))
    #expect(model.targetsDiagnostic == expected.diagnostic)
    #expect(model.targets.isEmpty)
    #expect(!model.canOpenSelected)
}
