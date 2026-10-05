// La recette manuelle des composants (BR-1) : hors suite, hors CI.
//
// Désactivée par défaut (`MEM0_COMPONENTS_RECIPE` non posée) : elle touche le
// RÉSEAU RÉEL et télécharge ~285 Mo (omp 208 Mo + pkg podman 76 Mo). Elle installe
// les deux composants dans une racine TEMPORAIRE (`OMP_CONSOLE_SUPPORT_ROOT` n'est
// pas requis, la racine est passée directement), puis exécute les deux `--version`
// sur les binaires obtenus — c'est la preuve de bout en bout d'AC-2.

import Foundation
import Testing

@testable import OMPConsole

@MainActor
@Test(
    "all-in-one-app/AC-2 : recette réelle — télécharge omp et podman dans une racine temporaire et exécute leurs --version",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_COMPONENTS_RECIPE"] != nil)
)
func recetteReelleInstalleLesDeuxComposants() async throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("omp-console-components-recipe-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    print("[recette] racine : \(root.path)")

    let installer = ComponentInstaller(paths: AppPaths(supportRoot: root))
    var steps: [ComponentInstallStep] = []
    try await installer.install { step in
        steps.append(step)
        print("[recette] étape  : \(step)")
    }

    let omp = try #require(installer.installedOmpBinary())
    let podman = try #require(installer.installedPodmanBinary())
    print("[recette] omp     : \(omp.path)")
    print("[recette] podman  : \(podman.path)")

    let ompRun = try await CommandRunner.live(omp, ["--version"], [:], 60)
    let podmanRun = try await CommandRunner.live(podman, ["--version"], [:], 60)
    print("[recette] omp --version    : \(ompRun.stdout.trimmingCharacters(in: .whitespacesAndNewlines))")
    print("[recette] podman --version : \(podmanRun.stdout.trimmingCharacters(in: .whitespacesAndNewlines))")
    #expect(ompRun.stdout.contains("omp/18.6.0"))
    #expect(podmanRun.stdout.contains("podman version 6.1.3"))

    // Deuxième passe : idempotence réelle (aucun téléchargement).
    var second: [ComponentInstallStep] = []
    try await installer.install { second.append($0) }
    #expect(second.isEmpty)
    print("[recette] deuxième installation : \(second.count) étape(s) (idempotente)")
}
