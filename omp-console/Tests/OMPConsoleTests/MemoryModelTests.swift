// Les états et les transitions du modèle de la section « Mémoire » (BR-3) : chaque
// ligne du tableau d'états est confrontée sans rendre de vue, et l'indisponibilité
// n'est JAMAIS une liste vide (S-6.3, AC-8).

import Foundation
import Testing

@testable import OMPConsole

// MARK: - Sommaire (S-3)

@MainActor
@Test("memoire-mem0/AC-3 : le sommaire affiche le compte et l'ordre du service, sur la portée du projet")
func ac3SummaryShowsServiceOrderAndCount() async throws {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 3, rows: [
            memoryRow(id: "m-3", text: "récent"),
            memoryRow(id: "m-2", text: "moyen"),
            memoryRow(id: "m-1", text: "ancien"),
        ]))
    )
    let model = memoryModel(service: service)

    #expect(model.state == .loading)
    await model.refresh()

    #expect(model.state == .summary(scope: "memoire-mem0", total: 3, rows: [
        memoryRow(id: "m-3", text: "récent"),
        memoryRow(id: "m-2", text: "moyen"),
        memoryRow(id: "m-1", text: "ancien"),
    ]))
    #expect(service.allScopes == ["memoire-mem0"])
    #expect(service.searches.isEmpty)
}

@MainActor
@Test("memoire-mem0/AC-3 : un sommaire vide est un état VIDE explicite, jamais un silence")
func ac3EmptySummaryIsExplicit() async {
    let service = ScriptedMemoryService(page: .success(MemoryPage(total: 0, rows: [])))
    let model = memoryModel(service: service)

    await model.refresh()

    #expect(model.state == .summaryEmpty(scope: "memoire-mem0"))
    #expect(MemoryText.emptySummary("memoire-mem0").contains("Aucun souvenir"))
}

// MARK: - Recherche (S-1)

@MainActor
@Test("memoire-mem0/AC-1 : la recherche demande le pool du plugin et rend les souvenirs triés par cosinus")
func ac1SearchUsesPluginPoolAndSelects() async {
    let service = ScriptedMemoryService(search: .success([
        memoryRow(id: "m-1", text: "un", score: 0.9),
        memoryRow(id: "m-2", text: "deux", score: 0.4),
        memoryRow(id: "m-3", text: "trois", score: 0.8),
        memoryRow(id: "m-4", text: "quatre"),
        memoryRow(id: "m-5", text: "cinq", score: 0.55),
        memoryRow(id: "m-6", text: "six", score: 0.7),
        memoryRow(id: "m-7", text: "sept", score: 0.6),
    ]))
    let model = memoryModel(service: service, query: "sujet")

    await model.search()

    // Le pool demandé est `min(6 × 4, 50)` = 24, la portée est celle du projet.
    #expect(service.searches == [
        ScriptedMemoryService.Search(query: "sujet", scope: "memoire-mem0", pool: 24),
    ])
    #expect(model.state == .search(query: "sujet", rows: [
        memoryRow(id: "m-1", text: "un", score: 0.9),
        memoryRow(id: "m-3", text: "trois", score: 0.8),
        memoryRow(id: "m-6", text: "six", score: 0.7),
        memoryRow(id: "m-7", text: "sept", score: 0.6),
        memoryRow(id: "m-5", text: "cinq", score: 0.55),
    ]))
}

@MainActor
@Test("memoire-mem0/AC-1 : une recherche sans ligne, sans score ou sous le seuil a TROIS messages distincts")
func ac1SearchEmptyStatesAreDistinct() async {
    let empty = memoryModel(service: ScriptedMemoryService(search: .success([])), query: "sujet")
    await empty.search()
    #expect(empty.state == .searchEmptyNoMatch)

    let unscored = memoryModel(
        service: ScriptedMemoryService(search: .success([memoryRow(id: "m-1", text: "a")])),
        query: "sujet"
    )
    await unscored.search()
    #expect(unscored.state == .searchEmptyNoScore)

    let below = memoryModel(
        service: ScriptedMemoryService(search: .success([memoryRow(id: "m-1", text: "a", score: 0.2)])),
        query: "sujet"
    )
    await below.search()
    #expect(below.state == .searchEmptyBelowThreshold)
}

@MainActor
@Test("memoire-mem0/AC-1 : une requête vide après trim n'émet AUCUNE requête et ramène la liste au sommaire")
func ac1EmptyQueryNeverHitsTheNetwork() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "a")])),
        search: .success([memoryRow(id: "m-2", text: "b", score: 0.9)])
    )
    let model = memoryModel(service: service, query: "sujet")
    await model.refresh()
    await model.search()
    #expect(model.state == .search(query: "sujet", rows: [memoryRow(id: "m-2", text: "b", score: 0.9)]))
    let scopeCalls = service.allScopes.count
    let searches = service.searches.count

    // Vider le champ ramène au sommaire à lui seul ; le valider ensuite n'émet rien.
    model.updateQuery("   ")
    #expect(model.state == .summary(scope: "memoire-mem0", total: 1, rows: [memoryRow(id: "m-1", text: "a")]))
    await model.search()

    // Ni requête de recherche, ni rechargement du sommaire : le sommaire DÉJÀ lu
    // revient tel quel.
    #expect(service.searches.count == searches)
    #expect(service.allScopes.count == scopeCalls)
    #expect(model.state == .summary(scope: "memoire-mem0", total: 1, rows: [memoryRow(id: "m-1", text: "a")]))
}

// MARK: - Indisponibilité (S-6)

@MainActor
@Test("memoire-mem0/AC-8 : un service arrêté affiche l'adresse ET la dernière erreur, jamais une liste vide")
func ac8UnavailableServiceIsExplicit() async {
    let service = ScriptedMemoryService(
        health: [MemoryHealth(isAvailable: false, errorMessage: "Connexion impossible")],
        page: .success(MemoryPage(total: 0, rows: []))
    )
    let model = memoryModel(service: service)

    await model.refresh()

    #expect(model.state == .unavailable(address: "http://localhost:8321", detail: "Connexion impossible"))
    #expect(model.serviceAvailable == false)
    #expect(model.serviceError == "Connexion impossible")
    // Aucune requête de portée n'a été émise : l'indisponibilité n'est pas un
    // sommaire vide déguisé.
    #expect(service.allScopes.isEmpty)

    // Et une recherche demandée dans cet état n'est pas émise non plus.
    model.updateQuery("sujet")
    await model.search()
    #expect(service.searches.isEmpty)
    #expect(model.state == .unavailable(address: "http://localhost:8321", detail: "Connexion impossible"))
}

@MainActor
@Test("memoire-mem0/AC-7 : un service joignable passe directement à la liste, sans état « indisponible »")
func ac7AvailableServiceShowsTheList() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "a")]))
    )
    let model = memoryModel(service: service)

    await model.refresh()

    #expect(model.serviceAvailable)
    #expect(model.address == "http://localhost:8321")
    #expect(model.state == .summary(scope: "memoire-mem0", total: 1, rows: [memoryRow(id: "m-1", text: "a")]))
}

@MainActor
@Test("memoire-mem0/AC-8 : un service redevenu joignable repasse à « disponible » au rafraîchissement")
func ac8RefreshRecovers() async {
    let service = ScriptedMemoryService(
        health: [
            MemoryHealth(isAvailable: false, errorMessage: "Connexion impossible"),
            MemoryHealth(isAvailable: true, errorMessage: nil),
        ],
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "a")]))
    )
    let model = memoryModel(service: service)

    await model.refresh()
    #expect(model.serviceAvailable == false)

    await model.refresh()
    #expect(model.serviceAvailable)
    #expect(model.serviceError == nil)
    #expect(model.state == .summary(scope: "memoire-mem0", total: 1, rows: [memoryRow(id: "m-1", text: "a")]))
}

@MainActor
@Test("memoire-mem0/AC-8 : une requête en échec en cours de route rend le service indisponible")
func ac8TransportFailureDuringLoadMarksUnavailable() async {
    let service = ScriptedMemoryService(
        page: .failure(.notReachable("Connexion interrompue"))
    )
    let model = memoryModel(service: service)

    await model.refresh()

    #expect(model.state == .unavailable(address: "http://localhost:8321", detail: "Connexion interrompue"))
}

// MARK: - Portée (S-4)

@MainActor
@Test("memoire-mem0/AC-4 : la portée est celle du projet, `_global` n'est JAMAIS envoyé")
func ac4ScopeIsTheProjectAndNeverGlobal() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "a")])),
        search: .success([memoryRow(id: "m-2", text: "b", score: 0.9)])
    )
    let model = memoryModel(service: service, scope: "mem0-omp", query: "sujet")

    await model.refresh()
    await model.search()

    #expect(service.allScopes == ["mem0-omp"])
    #expect(service.searches.map(\.scope) == ["mem0-omp"])
    #expect(!service.allScopes.contains("_global"))
    #expect(!service.searches.contains { $0.scope == "_global" })
}

@MainActor
@Test("memoire-mem0/AC-5 : le sommaire ne contient que la portée du projet, jamais la mémoire globale")
func ac5SummaryNeverCarriesGlobalMemories() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 2, rows: [
            memoryRow(id: "m-1", text: "projet un"),
            memoryRow(id: "m-2", text: "projet deux"),
        ]))
    )
    let model = memoryModel(service: service, scope: "mem0-omp")

    await model.refresh()

    #expect(service.allScopes == ["mem0-omp"])
    #expect(model.state == .summary(scope: "mem0-omp", total: 2, rows: [
        memoryRow(id: "m-1", text: "projet un"),
        memoryRow(id: "m-2", text: "projet deux"),
    ]))
}

@MainActor
@Test("memoire-mem0/AC-4 : sans portée calculable, aucun appel de portée n'est émis et l'état le dit")
func ac4NoScopeMeansNoScopeRequest() async {
    let service = ScriptedMemoryService()
    let model = memoryModel(service: service, scope: nil)

    await model.refresh()

    #expect(model.state == .noProject)
    #expect(service.allScopes.isEmpty)
    #expect(service.searches.isEmpty)
    // La sonde `/health` de S-6.1 reste la seule requête possible : c'est elle qui
    // rend l'en-tête véridique (S-6.2).
    #expect(service.healthCalls == 1)

    model.updateQuery("sujet")
    await model.search()
    #expect(service.searches.isEmpty)
}

// MARK: - Détail (S-5)

@MainActor
@Test("memoire-mem0/AC-6 : ouvrir un souvenir affiche son texte complet, à l'identique")
func ac6OpeningARowShowsTheFullText() async {
    let full = "ligne 1 avec des espaces   \n\nligne 3\n" + String(repeating: "x", count: 500)
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: full)]))
    )
    let model = memoryModel(service: service)

    await model.refresh()
    // Aucune sélection n'est posée d'emblée.
    #expect(model.selected == nil)

    model.select(memoryRow(id: "m-1", text: full))

    #expect(model.selected?.id == "m-1")
    #expect(model.selected?.text == full)
}

@MainActor
@Test("memoire-mem0/AC-6 : une nouvelle liste repose la sélection à zéro")
func ac6NewListClearsTheSelection() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "a")])),
        search: .success([memoryRow(id: "m-2", text: "b", score: 0.9)])
    )
    let model = memoryModel(service: service, query: "sujet")

    await model.refresh()
    model.select(memoryRow(id: "m-1", text: "a"))
    #expect(model.selected?.id == "m-1")

    await model.search()
    #expect(model.selected == nil)
}

// MARK: - Le bouton « Sommaire » (S-3)

@MainActor
@Test("memoire-mem0/AC-3 : le retour au sommaire recharge la liste et vide le champ de recherche")
func ac3ReturnToSummaryClearsTheQuery() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "a")])),
        search: .success([memoryRow(id: "m-2", text: "b", score: 0.9)])
    )
    let model = memoryModel(service: service, query: "sujet")

    await model.refresh()
    await model.search()
    #expect(model.state == .search(query: "sujet", rows: [memoryRow(id: "m-2", text: "b", score: 0.9)]))

    await model.showSummary()

    #expect(model.state == .summary(scope: "memoire-mem0", total: 1, rows: [memoryRow(id: "m-1", text: "a")]))
    #expect(model.query.isEmpty)
    #expect(model.canShowSummary == false)
    #expect(service.allScopes == ["memoire-mem0", "memoire-mem0"])
}
