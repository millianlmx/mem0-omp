// La recette manuelle de l'union (S-8, BR-5 ; AC-9) : hors suite, hors CI.
//
// Désactivée par défaut (`MEM0_UNION_RECIPE` non posée) : elle touche le podman de
// l'app, copie une VRAIE base de l'ancienne pile sur un staging, lance un
// conteneur lecteur réel et unit vers la base vivante de l'app. La seconde passe
// ne recopie rien (empreinte inchangée). Échec EXPLICITE quand le prérequis
// manque (podman embarqué absent, cible de l'app injoignable).

import Foundation
import Testing

@testable import OMPConsole

@MainActor
@Test(
    "bug-embedded-podman-machine/AC-9 : recette manuelle — union réelle (staging, conteneur lecteur, idempotence)",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_UNION_RECIPE"] != nil)
)
func recetteUnionReelleContreLaPileDeLApp() async throws {
    let environment = ProcessInfo.processInfo.environment
    let paths = AppPaths.standard(environment: environment)

    // Prérequis explicite : le binaire podman embarqué doit être installé.
    let installer = ComponentInstaller(paths: paths)
    guard let podman = installer.installedPodmanBinary() else {
        Issue.record("prérequis manquant : le binaire podman embarqué n'est pas installé sous \(paths.supportRoot.path)")
        return
    }
    print("[recette] podman : \(podman.path)")

    // Prérequis explicite : la cible de l'app répond.
    guard await reachable("http://127.0.0.1:6333/readyz") else {
        Issue.record("prérequis manquant : la base de l'app ne répond pas sur 127.0.0.1:6333 (lancez la préparation)")
        return
    }

    let runner = MemoryUnionRunner(
        paths: paths,
        manifest: .current,
        environment: environment,
        run: .live,
        session: .shared
    )
    let first = await runner.run()
    print("[recette] première passe : \(first)")

    switch first {
    case .nothingCopied, .caughtUp:
        let second = await runner.run()
        print("[recette] seconde passe : \(second)")
        // L'empreinte enregistrée fait sauter la seconde passe.
        #expect(second == .nothingToDo)
    default:
        print("[recette] rien à unir (source absente, ancienne pile en marche, ou empreinte inchangée)")
    }
}

private func reachable(_ url: String) async -> Bool {
    guard let url = URL(string: url) else { return false }
    var request = URLRequest(url: url)
    request.timeoutInterval = 5
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
    return (response as? HTTPURLResponse)?.statusCode == 200
}
