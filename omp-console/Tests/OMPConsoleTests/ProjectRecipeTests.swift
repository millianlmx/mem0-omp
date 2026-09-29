// La recette mécanique de la conduite (BR-5) : hors suite, hors CI.
//
// Le paquet ne vend aucun produit exécutable, donc le véhicule de la recette est ce
// test, DÉSACTIVÉ par défaut. Aucune étape de `.github/workflows/check.yml` ni
// `scripts/swift-app.sh` ne pose `MEM0_PROJECT_RECIPE` : la CI le rapporte
// « skipped » et ne l'exécute jamais.

import Foundation
import Testing
@testable import OMPConsole

@MainActor
private func makeRecipeGitRepository() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("omp-recipe-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["init", "-q"]
    process.currentDirectoryURL = url
    try process.run()
    process.waitUntilExit()
    return url
}

@MainActor
@Test(
    "conduite-de-projet/AC-1 : recette — /project armé sur un dépôt sans remote GitHub",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_PROJECT_RECIPE"] != nil)
)
/// Le nom de la FONCTION porte « recette » : `swift test --filter` filtre sur
/// l'identifiant du test, pas sur son titre affiché.
func recetteArmeProjectSurDepotSansRemote() async throws {
    let repo = try makeRecipeGitRepository()
    let stateDir = (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-recipe-state-\(UUID().uuidString)")
    let model = ProjectConsoleModel(stateDir: stateDir)

    await model.startConduite(repoRoot: repo, name: "recette")
    let observed = await awaitProject(40) {
        model.notice?.contains("aucun dépôt distant GitHub") == true
    }
    print(
        "recette /project : notice observée = \(model.notice ?? "aucune"), "
            + "état = \(model.state), armé = \(observed), prompt = \(transportPrompt(model.host))"
    )
    model.stop()
}

@MainActor
private func transportPrompt(_ host: SessionHost) -> String {
    host.transcript.last(where: { $0.kind == .outbound })?.text ?? "aucun"
}
