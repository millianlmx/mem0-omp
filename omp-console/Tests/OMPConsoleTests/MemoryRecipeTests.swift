// La recette manuelle de la mémoire du projet (BR-4) : hors suite, hors CI.
//
// Le paquet ne vend aucun produit exécutable, donc le véhicule de la recette est ce
// test, DÉSACTIVÉ par défaut : aucune étape de `.github/workflows/check.yml` ni
// `scripts/swift-app.sh` ne pose `MEM0_MEMORY_RECIPE`, donc la CI le rapporte
// « skipped » et ne l'exécute jamais.
//
// Il ne juge rien : il relève, sur le VRAI service mem0-http et le VRAI projet
// désigné par `MEM0_MEMORY_RECIPE_PROJECT`, ce que la section afficherait — la
// portée calculée, l'état du service, le compte du sommaire, ses trois premières
// lignes, puis les résultats d'une recherche — pour que la revue confronte le rendu
// aux commandes du poste. Il n'écrit RIEN dans le projet.

import Foundation
import Testing

@testable import OMPConsole

@MainActor
@Test(
    "memoire-mem0/AC-1 : recette manuelle — portée, état du service, sommaire et recherche d'un vrai projet",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_MEMORY_RECIPE"] != nil)
)
/// Le nom de la FONCTION doit porter « recette » : `swift test --filter` filtre sur
/// l'identifiant du test (module et nom de fonction), pas sur son titre affiché.
func recetteManuelleRendLaMemoireDuProjet() async throws {
    let environment = ProcessInfo.processInfo.environment
    let project = environment["MEM0_MEMORY_RECIPE_PROJECT"] ?? FileManager.default.currentDirectoryPath
    let config = MemoryServiceConfig.fromEnvironment(environment)
    print("[recette] service     : \(config.baseURL.absoluteString) (jeton \(config.token.isEmpty ? "absent" : "posé"))")
    print("[recette] projet      : \(project)")

    guard case let .success(binary) = GitBinary.resolve(environment: environment, path: project) else {
        print("[recette] git introuvable — recette abandonnée")
        return
    }
    let git = GitCLI(binary: binary)
    guard let scope = await MemoryScope.scope(projectRoot: project, environment: environment, git: git) else {
        print("[recette] portée non calculable — la section afficherait « Aucun projet ouvert »")
        return
    }
    print("[recette] portée      : \(scope)")

    let service = HTTPMemoryService(config: config)
    let health = await service.health()
    print("[recette] état        : \(health.isAvailable ? "disponible" : "indisponible") — \(config.baseURL.absoluteString)")
    if let error = health.errorMessage { print("[recette] erreur      : \(error)") }
    guard health.isAvailable else { return }

    let page = try await service.all(scope: scope)
    print("[recette] sommaire    : \(page.total) souvenir(s)")
    for row in page.rows.prefix(3) {
        print("[recette]   [\(row.id)] \(MemoryText.preview(row.text))")
    }

    let received = try await service.search(
        query: "mémoire du projet",
        scope: scope,
        pool: MemorySearch.pool(requested: MemorySearch.defaultLimit)
    )
    let selection = MemorySearch.select(
        rows: received,
        floor: MemorySearch.threshold,
        limit: MemorySearch.defaultLimit
    )
    print("[recette] recherche   : \(selection.candidates) candidat(s), \(selection.scored) score(s), \(selection.kept.count) retenu(s)")
    for row in selection.kept {
        print("[recette]   [\(row.id)] \(row.semanticScore.map { String(format: "%.3f", $0) } ?? "?") \(MemoryText.preview(row.text))")
    }
}
