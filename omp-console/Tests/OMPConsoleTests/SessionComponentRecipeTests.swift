// Recette gatée (S-4, BR-4) : la session RPC réelle vit sur le composant de
// l'app, et un run `omp -p` au terminal — sans l'app ouverte — retrouve la
// mémoire du projet. Ce sont les preuves machines d'AC-3 et AC-5 ; la procédure
// humaine (renommer l'`omp` système) est décrite dans omp-console/README.md.
//
// Désactivée par défaut : `MEM0_SESSION_COMPONENT_RECIPE=1`.
// Prérequis : la préparation a installé les composants (racine de support réelle,
// ou `OMP_CONSOLE_SUPPORT_ROOT`), la pile mémoire tourne, et oMLX répond.
//
//   cd omp-console && MEM0_SESSION_COMPONENT_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel \
//     --filter sessionComponent -Xswiftc -plugin-path \
//     -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"

import Darwin
import Foundation
import Testing
@testable import OMPConsole

private var recipeEnabled: Bool {
    ProcessInfo.processInfo.environment["MEM0_SESSION_COMPONENT_RECIPE"] != nil
}

@MainActor
private func waitUntil(_ timeout: Double = 60, _ condition: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        try? await Task.sleep(for: .milliseconds(50))
    }
    return condition()
}

/// Un dépôt git neuf, dans un dossier temporaire.
private func makeGitRepo() throws -> URL {
    let repo = FileManager.default.temporaryDirectory
        .appendingPathComponent("session-component-recipe-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
    let git = Process()
    git.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    git.arguments = ["init", "-q", repo.path]
    try git.run()
    git.waitUntilExit()
    return repo
}

/// Les fichiers `.jsonl` sous `~/.omp/agent/sessions` (le dossier n'existe pas
/// encore sur une installation neuve).
private func sessionFiles(under root: URL) -> [String] {
    guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
    var files: [String] = []
    for case let url as URL in enumerator where url.pathExtension == "jsonl" {
        files.append(url.path)
    }
    return files
}

@MainActor
@Test(
    "all-in-one-app/AC-3 : une session RPC réelle vit sur le composant de l'app, sans aucun PATH système",
    .enabled(if: recipeEnabled)
)
func sessionRunsOnTheAppComponent() async throws {
    let paths = AppPaths.standard()
    let resolved = try #require(
        try? OmpBinaryResolver.resolve(environment: ProcessInfo.processInfo.environment).get(),
        "composant OMP introuvable : lancez d'abord la préparation d'OMP Console"
    )
    let component = paths.ompDir(ComponentManifest.current.ompVersion).appendingPathComponent("omp")
    #expect(resolved.path == component.path, "la session doit tourner sur le composant de l'app, pas sur un binaire système")

    // Le binaire du composant répond en version, sans PATH.
    let version = try await CommandRunner.live(
        resolved, ["--version"], ["HOME": NSHomeDirectory(), "PATH": "/nonexistent"], 60
    )
    #expect(version.code == 0)
    #expect(version.stdout.contains("omp/\(ComponentManifest.current.ompVersion)"))

    // Une session RPC réelle démarre : aucun binaire système n'est consulté
    // (PATH vidé), le process vit dans l'app.
    let repo = try makeGitRepo()
    let host = SessionHost(environment: ["HOME": NSHomeDirectory(), "PATH": "/nonexistent"])
    defer {
        if let pid = host.pid { kill(pid, SIGKILL) }
    }
    try await host.start(mode: .rpc, projectRoot: repo, resume: false)
    let running = await waitUntil { if case .running = host.state { return true }; return false }
    #expect(running, "la session doit atteindre `running` (état : \(host.state))")
    #expect(host.pid != nil, "le process hébergé vit dans l'app")
    await host.stop()
}

@Test(
    "all-in-one-app/AC-5 : un run `omp -p` au terminal retrouve la mémoire du projet, sans l'app",
    .enabled(if: recipeEnabled)
)
func terminalRunRecallsMemoryWithoutTheApp() async throws {
    let binary = try #require(
        try? OmpBinaryResolver.resolve(environment: ProcessInfo.processInfo.environment).get(),
        "composant OMP introuvable : lancez d'abord la préparation d'OMP Console"
    )
    let repo = try makeGitRepo()
    let sessionsRoot = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".omp/agent/sessions")
    let before = Set(sessionFiles(under: sessionsRoot))

    let child = ProcessRunner.child(
        binary: binary,
        arguments: ["-p", "Réponds simplement « bonjour » et termine. N'appelle aucun outil."],
        cwd: repo,
        environment: ProcessInfo.processInfo.environment,
        input: .nullDevice
    )
    let run = try await ProcessRunner.run(child, timeout: 300)
    #expect(run.code == 0, "omp -p doit réussir (stdout : \(run.stdout.suffix(300)) / stderr : \(run.stderr.suffix(300)))")

    let created = Set(sessionFiles(under: sessionsRoot)).subtracting(before)
    // Le nom d'un fichier de session est `<horodatage ISO>_<id>.jsonl` : l'ordre
    // lexicographique est l'ordre chronologique.
    let newest = created.sorted().last
    let file = try #require(newest, "aucun fichier de session créé par le run")
    let text = try String(contentsOfFile: file, encoding: .utf8)
    #expect(text.contains("mem0-recall"), "le run terminal doit recevoir le rappel mémoire (fichier : \(file))")
}
