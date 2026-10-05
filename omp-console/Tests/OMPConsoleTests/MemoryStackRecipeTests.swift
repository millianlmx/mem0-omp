// La recette réelle de la pile (BR-2, S-2) : hors suite, hors CI.
//
// Elle est DÉSACTIVÉE par défaut : aucune étape de `.github/workflows/check.yml`
// ni `scripts/swift-app.sh` ne pose `MEM0_STACK_RECIPE`, donc la CI la rapporte
// « skipped » et ne l'exécute jamais. Elle touche la VRAIE racine de l'app (celle
// qu'`OMP_CONSOLE_SUPPORT_ROOT` déplace) : c'est le point du contrat — prouver que
// la machine `omp-console`, ses conteneurs et `/health` fonctionnent pour de vrai.
//
// Prérequis : le composant podman installé sous la racine (S-1) et le contexte de
// build mem0-http (le dossier du bundle, ou `MEM0_STACK_RECIPE_BUILD_CONTEXT`).
// Rien n'est arrêté à la fin : la pile doit SURVIVRE (AC-5).

import Foundation
import Testing

@testable import OMPConsole

/// Le contexte de build mem0-http : le dossier du bundle s'il existe, sinon la
/// source unique du dépôt (recette lancée depuis `omp-console/`), sinon l'override.
private func recipeBuildContext(environment: [String: String]) -> URL {
    if let override = environment["MEM0_STACK_RECIPE_BUILD_CONTEXT"], !override.isEmpty {
        return URL(fileURLWithPath: override, isDirectory: true)
    }
    let bundled = Bundle.main.bundleURL
        .appendingPathComponent("Contents/Resources/Stack/mem0-http", isDirectory: true)
    if FileManager.default.fileExists(atPath: bundled.path) { return bundled }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        .appendingPathComponent("../mem0-stack/mem0-http", isDirectory: true)
        .standardizedFileURL
}

@MainActor
@Test(
    "all-in-one-app/AC-1 : recette réelle — machine dédiée, conteneurs et `/health` sur le vrai podman",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_STACK_RECIPE"] != nil)
)
func recetteReelleDeLaPile() async throws {
    let environment = ProcessInfo.processInfo.environment
    let paths = AppPaths.standard()
    let manifest = ComponentManifest.current
    let podman = paths.podmanDir(manifest.podmanVersion).appendingPathComponent("bin/podman")
    print("[recette] racine    : \(paths.supportRoot.path)")
    print("[recette] podman    : \(podman.path)")

    guard FileManager.default.isExecutableFile(atPath: podman.path) else {
        Issue.record("podman du composant absent (\(podman.path)) — lancez d'abord la préparation des composants")
        return
    }
    let buildContext = recipeBuildContext(environment: environment)
    print("[recette] contexte  : \(buildContext.path)")
    guard FileManager.default.fileExists(atPath: buildContext.path) else {
        Issue.record("contexte de build introuvable (\(buildContext.path)) — posez MEM0_STACK_RECIPE_BUILD_CONTEXT")
        return
    }

    let stack = MemoryStack(paths: paths, manifest: manifest, buildContext: buildContext)
    var steps: [StackStep] = []
    try await stack.ensureRunning { steps.append($0) }
    print("[recette] étapes    : \(steps)")
    print("[recette] machine   : \(MemoryStack.machineName) (état \(paths.machineState.path))")

    // Les conteneurs existent VRAIMENT : preuve par podman, pas par l'app.
    let runner = CommandRunner.live
    let podmanEnvironment = PodmanCommand.environment(base: environment, paths: paths)
    for name in [MemoryStack.qdrantContainer, MemoryStack.mem0Container] {
        let result = try await runner(podman, PodmanCommand.containerInspect(name), podmanEnvironment, 60)
        print("[recette] \(name) : exit \(result.code)")
        #expect(result.code == 0, "conteneur \(name) introuvable")
    }

    let healthy = await stack.health()
    print("[recette] /health   : \(healthy ? "ok" : "indisponible")")
    #expect(healthy, "GET http://127.0.0.1:8321/health ne rend pas {\"ok\":true}")
}
