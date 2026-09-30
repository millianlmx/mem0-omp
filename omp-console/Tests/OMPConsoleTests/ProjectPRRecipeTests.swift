// La recette mécanique du suivi de PR (BR-4) : hors suite, hors CI.
//
// Le paquet ne vend aucun produit exécutable, donc le véhicule de la recette est ce
// test, DÉSACTIVÉ par défaut. Aucune étape de `.github/workflows/check.yml` ni
// `scripts/swift-app.sh` ne pose `MEM0_PR_RECIPE` : la CI le rapporte « skipped ».
//
// L'URL de la PR vient de l'environnement — jamais d'une URL en dur dans le dépôt
// (contrainte `docs/AC-21`).

import Foundation
import Testing
@testable import OMPConsole

@MainActor
@Test(
    "suivi-pr-ci/AC-1 : recette — lecture réelle d'une PR par GhPRService",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_PR_RECIPE"] != nil)
)
func recetteLectureReelleDUnePR() async throws {
    let environment = ProcessInfo.processInfo.environment
    let url = environment["MEM0_PR_RECIPE_URL"] ?? ""
    guard !url.isEmpty else {
        Issue.record("MEM0_PR_RECIPE_URL doit porter l'URL d'une PR réelle")
        return
    }
    let directory = environment["MEM0_PR_RECIPE_DIR"] ?? FileManager.default.currentDirectoryPath
    let binary = try GhBinary.resolve(environment: environment).get()
    let service = GhPRService(cli: GhCLI(binary: binary))

    let snapshot = try await service.read(prUrl: url, in: directory)
    let checks = snapshot.checks
        .map { "\($0.name)=\($0.state.label)\($0.link.map { " (\($0))" } ?? "")" }
        .joined(separator: ", ")
    print("recette PR : titre=« \(snapshot.title) », sha=\(snapshot.headOid), statuts=\(checks)")
}
