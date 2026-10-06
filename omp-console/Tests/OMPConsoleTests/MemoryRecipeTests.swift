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
    print("[recette] sommaire    : \(MemoryText.summaryCount(page.total))")
    let nowMs = Date().timeIntervalSince1970 * 1000
    for row in page.rows.prefix(3) {
        print("[recette]   [\(row.id)] \(MemoryText.title(row.text)) — \(MemoryText.subtitle(row: row, nowMs: nowMs))")
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
    print("[recette] recherche   : \(ConsoleFormat.count(selection.candidates, "candidat", "candidats")), \(ConsoleFormat.count(selection.scored, "score", "scores")), \(ConsoleFormat.count(selection.kept.count, "retenu", "retenus"))")
    for row in selection.kept {
        print("[recette]   [\(row.id)] \(row.semanticScore.map { String(format: "%.3f", $0) } ?? "?") \(MemoryText.title(row.text)) — \(MemoryText.subtitle(row: row, nowMs: nowMs))")
    }
}

/// Le cycle complet d'ÉCRITURE du mode graphe, sur le VRAI service (BR-5) : créer,
/// retrouver, corriger, relier, relire, détacher, supprimer. Chaque étape est
/// imprimée ; aucune assertion — c'est une recette, pas un test.
///
/// La portée est DÉDIÉE (`_graph-recipe`) et le souvenir créé est supprimé en fin de
/// course : la recette ne touche à aucune mémoire de projet réelle.
@MainActor
@Test(
    "graph-based-memeries-view/AC-12 : recette manuelle — cycle d'écriture complet sur le vrai service",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_MEMORY_RECIPE"] != nil)
)
/// Le nom de la FONCTION doit porter « recette » : `swift test --filter` filtre sur
/// l'identifiant du test, pas sur son titre affiché.
func recetteGrapheEcritSurLeVraiService() async throws {
    let environment = ProcessInfo.processInfo.environment
    let config = MemoryServiceConfig.fromEnvironment(environment)
    let service = HTTPMemoryService(config: config)
    print("[recette graphe] service : \(config.baseURL.absoluteString)")

    let health = await service.health()
    print("[recette graphe] état    : \(health.isAvailable ? "disponible" : "indisponible")")
    guard health.isAvailable else {
        print("[recette graphe] service indisponible — recette abandonnée")
        return
    }

    // Le fichier de liens vit dans une racine JETABLE : la recette ne touche pas à
    // celui de l'app.
    let paths = memoryTemporaryPaths()
    defer { try? FileManager.default.removeItem(at: paths.supportRoot) }

    let scope = "_graph-recipe"
    let original = "recette graphe \(UUID().uuidString.prefix(8)) : le texte est stocké mot pour mot"
    try await service.add(text: original, scope: scope, tags: ["recette", "graphe"])
    print("[recette graphe] 1. créé dans \(scope)")

    var found = try await service.search(query: original, scope: nil, pool: 24)
    let created = found.first { row in row.text == original }
    guard let created else {
        print("[recette graphe] le souvenir créé n'est pas retrouvé par la recherche — recette abandonnée")
        return
    }
    print("[recette graphe] 2. retrouvé par la recherche : \(created.id) (agent_id \(created.agentId ?? "—"))")

    let corrected = "\(original) — CORRIGÉ \(UUID().uuidString.prefix(4))"
    try await service.update(id: created.id, text: corrected, tags: ["recette", "corrige"])
    found = try await service.search(query: corrected, scope: nil, pool: 24)
    let reread = found.first { $0.id == created.id }
    print("[recette graphe] 3. corrigé : la recherche rend « \(MemoryText.title(reread?.text ?? "?")) » (verbatim : \(reread?.text == corrected))")

    let other = "recette graphe \(UUID().uuidString.prefix(8)) : le second souvenir à relier"
    try await service.add(text: other, scope: scope, tags: ["recette"])
    let second = try await service.search(query: other, scope: nil, pool: 24).first { $0.text == other }
    guard let second, let link = MemoryLinkStore.normalized(created.id, second.id) else {
        print("[recette graphe] second souvenir introuvable — recette abandonnée")
        return
    }

    print("[recette graphe] 4. lien manuel : \(MemoryLinkStore.save([link], to: paths.memoryLinks))")
    let relaunched = MemoryLinkStore.load(paths.memoryLinks)
    print("[recette graphe] 5. relu par un store NEUF (relance simulée) : \(relaunched == [link])")

    MemoryLinkStore.save([], to: paths.memoryLinks)
    print("[recette graphe] 6. détaché : \(MemoryLinkStore.load(paths.memoryLinks).isEmpty)")

    do {
        let graph = try await service.graph()
        let nodeIds = Set(([created.id, second.id]))
        let touching = graph.edges.filter { nodeIds.contains($0.source) || nodeIds.contains($0.target) }
        print("[recette graphe] 7. graphe : \(graph.total) souvenirs à vecteur, \(graph.edges.count) arêtes dont \(touching.count) touchent la recette")
    } catch {
        print("[recette graphe] 7. route graphe indisponible (\(MemoryServiceError.message(for: error))) — reconstruire l'image : compose build mem0-http && compose up -d")
    }

    try await service.delete(id: created.id)
    try await service.delete(id: second.id)
    found = try await service.search(query: corrected, scope: nil, pool: 24)
    print("[recette graphe] 8. supprimés : la recherche ne les rend plus : \(!found.contains { $0.id == created.id || $0.id == second.id })")
    let page = try await service.all(scope: scope)
    print("[recette graphe] 9. portée \(scope) : \(page.total) souvenir(s) restant(s)")
}
