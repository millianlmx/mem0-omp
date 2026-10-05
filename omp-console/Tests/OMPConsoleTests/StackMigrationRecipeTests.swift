// La recette manuelle de la migration (S-3, BR-3 ; AC-4) : hors suite, hors CI.
//
// Le paquet ne vend aucun produit exécutable, donc le véhicule de la recette est ce
// test, DÉSACTIVÉ par défaut : aucune étape de `.github/workflows/check.yml` ni
// `scripts/swift-app.sh` ne pose `MEM0_MIGRATION_RECIPE`, donc la CI le rapporte
// « skipped » et ne l'exécute jamais.
//
// Il ARRÊTE RÉELLEMENT l'ancienne pile du poste (via le socket Docker système),
// copie sa base dans une racine de support TEMPORAIRE, puis rend la main. Il ne
// supprime jamais la source : il relève ce que la migration a fait pour que la
// revue confronte le résultat aux commandes du poste.

import Foundation
import Testing

@testable import OMPConsole

@MainActor
@Test(
    "all-in-one-app/AC-4 : recette manuelle — arrêt réel de l'ancienne pile, copie dans une racine temporaire, source intacte",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_MIGRATION_RECIPE"] != nil)
)
/// Le nom de la FONCTION doit porter « recette » : `swift test --filter` filtre sur
/// l'identifiant du test (module et nom de fonction), pas sur son titre affiché.
func recetteMigrationArreteEtCopieLAncienneBase() async throws {
    let environment = ProcessInfo.processInfo.environment
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory
        .appendingPathComponent("omp-migration-recipe-\(UUID().uuidString)", isDirectory: true)
    let paths = AppPaths(supportRoot: root)
    defer { try? fileManager.removeItem(at: root) }

    let migration = StackMigration(paths: paths, environment: environment)
    var steps: [MigrationStep] = []
    let outcome = try await migration.run(progress: { steps.append($0) })
    print("[recette] source      : \(outcome.legacyStorage?.path ?? "aucune")")
    print("[recette] arrêtés     : \(outcome.stoppedContainers.isEmpty ? "aucun" : outcome.stoppedContainers.joined(separator: ", "))")
    print("[recette] copiée      : \(outcome.copied)")
    print("[recette] config      : \(outcome.configImported)")
    print("[recette] étapes      : \(steps)")

    guard let source = outcome.legacyStorage else {
        print("[recette] aucune ancienne pile trouvée — rien à migrer (base neuve)")
        return
    }

    // La source reste INTACTE et la copie est complète.
    #expect(fileManager.fileExists(atPath: source.path))
    #expect(fileManager.fileExists(atPath: source.appendingPathComponent("collections").path))
    let collections = paths.qdrantStorage.appendingPathComponent("collections")
    let entries = (try? fileManager.contentsOfDirectory(atPath: collections.path)) ?? []
    #expect(!entries.isEmpty)
    print("[recette] collections : \(entries.count) (\(entries.prefix(3).joined(separator: ", ")))")

    // Le `.env` de l'app est posé en 0600.
    #expect(fileManager.fileExists(atPath: paths.stackEnv.path))
    let attributes = try fileManager.attributesOfItem(atPath: paths.stackEnv.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)

    // Le marqueur est écrit et informatif.
    #expect(fileManager.fileExists(atPath: paths.migrationState.path))
}
