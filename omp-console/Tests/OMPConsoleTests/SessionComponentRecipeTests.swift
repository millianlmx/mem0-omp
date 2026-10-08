// Recette gatée (S-4, BR-4) : le composant `omp` de l'app est le seul binaire
// qu'elle utilise — il répond en version sans aucun PATH système — et un run
// `omp -p` au terminal, sans l'app ouverte, retrouve la mémoire du projet. Ce sont
// les preuves machines d'AC-3 et AC-5 ; la procédure humaine (renommer l'`omp`
// système) est décrite dans omp-console/README.md.
//
// Depuis le cutover, l'app n'héberge PLUS de session `omp` : « Session OMP » et la
// conduite de projet sont clientes du service (voir Service/ServiceSessionModelTests).
// Le composant reste utilisé par la préparation des composants, `omp models --json`
// et « Lancer omp » du terminal ; c'est ce que la recette gatée vérifie.
//
// Désactivée par défaut : `MEM0_SESSION_COMPONENT_RECIPE=1`.
// Prérequis : la préparation a installé les composants (racine de support réelle,
// ou `OMP_CONSOLE_SUPPORT_ROOT`), la pile mémoire tourne, et oMLX répond.
//
//   cd omp-console && MEM0_SESSION_COMPONENT_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel \
//     --filter sessionComponent -Xswiftc -plugin-path \
//     -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"

import Foundation
import Testing
@testable import OMPConsole

private var recipeEnabled: Bool {
    ProcessInfo.processInfo.environment["MEM0_SESSION_COMPONENT_RECIPE"] != nil
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

/// Un binaire `omp` absent n'est jamais deviné : l'erreur typée porte le texte lu
/// par l'utilisateur, qui nomme le chemin cherché.
@Test("client-rpc-omp/AC-14 : un binaire `omp` introuvable donne son texte, sans être deviné")
func missingBinaryGivesItsMessage() {
    let missing = "/nonexistent/omp"
    let resolution = OmpBinaryResolver.resolve(environment: [OmpBinaryResolver.overrideKey: missing])
    guard case .failure(let error) = resolution else {
        Issue.record("un binaire absent doit échouer, jamais être deviné")
        return
    }
    #expect(error == .binaryNotFound(searched: [missing], override: missing))
    #expect(error.userMessage.contains(missing))
}

@MainActor
@Test(
    "all-in-one-app/AC-3 : le composant `omp` de l'app répond en version, sans aucun PATH système",
    .enabled(if: recipeEnabled)
)
func componentOmpAnswersWithoutSystemPath() async throws {
    let paths = AppPaths.standard()
    let resolved = try #require(
        try? OmpBinaryResolver.resolve(environment: ProcessInfo.processInfo.environment).get(),
        "composant OMP introuvable : lancez d'abord la préparation d'OMP Console"
    )
    let component = paths.ompDir(ComponentManifest.current.ompVersion).appendingPathComponent("omp")
    #expect(resolved.path == component.path, "l'app n'utilise que son composant, jamais un binaire système")

    // Le binaire du composant répond en version, sans PATH.
    let version = try await CommandRunner.live(
        resolved, ["--version"], ["HOME": NSHomeDirectory(), "PATH": "/nonexistent"], 60
    )
    #expect(version.code == 0)
    #expect(version.stdout.contains("omp/\(ComponentManifest.current.ompVersion)"))
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
