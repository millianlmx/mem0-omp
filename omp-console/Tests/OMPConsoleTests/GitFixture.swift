// Un dépôt git RÉEL, jetable, sur disque, pour la portée de la Mémoire et le choix du
// projet. Aucun mock : la portée se calcule par une commande git réelle. Tout vit sous
// `NSTemporaryDirectory()`, et la configuration git de la machine est neutralisée
// (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`).
//
// Le chemin est CANONISÉ à la création : `NSTemporaryDirectory()` rend `/var/...` alors
// que git rend `/private/var/...` sur macOS (mesuré).

import ConsoleCore
import Foundation
@testable import OMPConsole

final class GitFixture {
    /// Le dépôt principal (racine canonique).
    let root: String
    /// Tous les répertoires créés, retirés au `deinit`.
    private var created: [String] = []
    private let fileManager = FileManager.default

    init() throws {
        root = canonicalPath((NSTemporaryDirectory() as NSString).appendingPathComponent("omp-console-git-\(UUID().uuidString)"))
        try fileManager.createDirectory(atPath: root, withIntermediateDirectories: true)
        created.append(root)
        try git(["init", "-q", "-b", "main", "."])
        try write("tracked.txt", "a\n")
        try git(["add", "."])
        try git(["commit", "-qm", "init"])
    }

    deinit {
        for path in created {
            try? fileManager.removeItem(atPath: path)
        }
    }

    /// Exécute git dans la fixture ; l'échec n'est jamais silencieux — c'est le
    /// harnais qui est cassé, pas le test.
    @discardableResult
    func git(_ arguments: [String], in directory: String? = nil) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = [
            "-C", directory ?? root,
            "-c", "commit.gpgsign=false",
            "-c", "user.email=fixture@example.com",
            "-c", "user.name=Fixture",
        ] + arguments
        var environment = ["PATH": "/usr/bin:/bin", "LANG": "C", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"]
        if let home = ProcessInfo.processInfo.environment["HOME"] { environment["HOME"] = home }
        process.environment = environment
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        try process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw GitFixtureFailure(command: "git " + arguments.joined(separator: " "), code: process.terminationStatus)
        }
        return String(decoding: data, as: UTF8.self)
    }

    @discardableResult
    func write(_ relative: String, _ contents: String) throws -> String {
        let path = joinPath(root, relative)
        try fileManager.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try Data(contents.utf8).write(to: URL(fileURLWithPath: path))
        return path
    }

    func remove(_ relative: String) throws {
        try fileManager.removeItem(atPath: joinPath(root, relative))
    }

    /// Un worktree de feature, créé par `git worktree add` (le geste de la pipeline), à
    /// côté du principal.
    @discardableResult
    func makeWorktree(slug: String) throws -> String {
        let parent = (root as NSString).deletingLastPathComponent
        let path = canonicalPath(joinPath(parent, "omp-console-git-\(slug)-\(UUID().uuidString)"))
        created.append(path)
        try git(["worktree", "add", "-q", "-b", "feat/\(slug)", path])
        return path
    }
}

struct GitFixtureFailure: Error, CustomStringConvertible {
    let command: String
    let code: Int32

    var description: String { "\(command) a échoué (code \(code))" }
}

/// Le binaire git du poste, utilisé par les tests comme par le produit : le toolchain
/// des Command Line Tools en fournit toujours un à cet emplacement.
func fixtureGit() -> GitCLI {
    GitCLI(binary: URL(fileURLWithPath: "/usr/bin/git"))
}
