// La recette manuelle des composants (BR-1) : hors suite, hors CI.
//
// Désactivée par défaut (`MEM0_COMPONENTS_RECIPE` non posée) : elle touche le
// RÉSEAU RÉEL et télécharge ~208 Mo (omp seul : l'app n'installe plus podman).
// Elle installe omp dans une racine TEMPORAIRE (`OMP_CONSOLE_SUPPORT_ROOT` n'est
// pas requis, la racine est passée directement), vérifie qu'aucun
// `components/podman` n'y est créé, puis exécute `omp --version` sur le binaire
// obtenu — c'est la preuve de bout en bout d'AC-2.

import Foundation
import Testing

@testable import OMPConsole

@MainActor
@Test(
    "all-in-one-app/AC-2 : recette réelle — télécharge omp dans une racine temporaire et exécute son --version",
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
    print("[recette] omp     : \(omp.path)")
    #expect(steps.allSatisfy { if case .omp = $0 { return true }; return $0 == .ompInstall })
    let podmanRoot = AppPaths(supportRoot: root).componentsRoot.appendingPathComponent("podman")
    #expect(!FileManager.default.fileExists(atPath: podmanRoot.path))

    let ompRun = try await CommandRunner.live(omp, ["--version"], [:], 60)
    print("[recette] omp --version    : \(ompRun.stdout.trimmingCharacters(in: .whitespacesAndNewlines))")
    #expect(ompRun.stdout.contains("omp/18.6.0"))

    // Deuxième passe : idempotence réelle (aucun téléchargement).
    var second: [ComponentInstallStep] = []
    try await installer.install { second.append($0) }
    #expect(second.isEmpty)
    print("[recette] deuxième installation : \(second.count) étape(s) (idempotente)")
}
