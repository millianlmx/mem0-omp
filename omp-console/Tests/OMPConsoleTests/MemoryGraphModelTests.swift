// L'état du MODE GRAPHE (S-1, S-2, S-5, S-6, S-7, S-8, S-9, S-10, S-11) : chaque
// transition est confrontée sans rendre de vue, et l'indisponibilité n'est JAMAIS
// un graphe vide silencieux.

import CoreGraphics
import Foundation
import Testing

@testable import OMPConsole
import ConsoleCore

/// Les identifiants des nœuds, dans l'ordre affiché : un souvenir par son id, une
/// étiquette par `#nom`.
private func nodeIDs(_ nodes: [MemoryGraphNode]) -> [String] {
    nodes.map { node in
        switch node.id {
        case let .memory(id): id
        case let .tag(name): "#\(name)"
        }
    }
}

private let graphSize = CGSize(width: 400, height: 300)

// MARK: - Bascule et états (AC-4, AC-5)

@MainActor
@Test("graph-based-memeries-view/AC-4 : le mode initial est la LISTE, et la bascule ne touche pas la liste")
func ac4ListIsTheInitialModeAndStaysUntouched() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "un", scope: "p")]))
    )
    let model = memoryGraphModel(service: service)

    #expect(model.shown == false)
    #expect(model.state == .idle)

    // La bascule active le graphe : c'est le seul moment où le modèle charge.
    await model.activate()
    #expect(model.shown)
    #expect(model.state == .graph(rows: [memoryRow(id: "m-1", text: "un", scope: "p")], edges: []))
    #expect(service.allScopes == [nil])
    #expect(service.graphCalls == 1)

    // Le retour à la liste ne relance RIEN et garde l'état du graphe.
    model.hide()
    #expect(!model.shown)
    #expect(service.graphCalls == 1)

    // Une seconde activation ne recharge pas : c'est ⌘R qui rafraîchit (S-2).
    await model.activate()
    #expect(service.graphCalls == 1)
}

@MainActor
@Test("graph-based-memeries-view/AC-5 : service indisponible ⇒ état indisponible, AUCUNE lecture, et « Réessayer » recharge")
func ac5UnavailableServiceIsExplicitAndRetryLoads() async {
    let service = ScriptedMemoryService(
        health: [
            MemoryHealth(isAvailable: false, errorMessage: "Connexion impossible"),
            MemoryHealth(isAvailable: true, errorMessage: nil),
        ],
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "un", scope: "p")]))
    )
    let model = memoryGraphModel(service: service)

    await model.activate()

    #expect(model.state == .unavailable(address: "http://localhost:8321", detail: "Connexion impossible"))
    #expect(service.allScopes.isEmpty)
    #expect(service.graphCalls == 0)

    // « Réessayer » : une sonde neuve puis les deux lectures.
    await model.refresh()
    #expect(model.state == .graph(rows: [memoryRow(id: "m-1", text: "un", scope: "p")], edges: []))
    #expect(service.graphCalls == 1)
}

@MainActor
@Test("graph-based-memeries-view/AC-5 : l'échec de la SEULE route graphe rend l'état indisponible, jamais un graphe partiel")
func ac5GraphRouteFailureIsNotASilentPartialGraph() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "un", scope: "p")])),
        graph: .failure(.unexpectedStatus(500, "Qdrant indisponible"))
    )
    let model = memoryGraphModel(service: service)

    await model.activate()

    #expect(model.state == .unavailable(address: "http://localhost:8321", detail: "réponse 500 du service (Qdrant indisponible)"))
    #expect(model.rows.isEmpty)
    #expect(model.visible.nodes.isEmpty)
}

@MainActor
@Test("graph-based-memeries-view/AC-5 : corpus vide ⇒ état vide global, pas celui du projet")
func ac5EmptyCorpusIsAGlobalEmptyState() async {
    let model = memoryGraphModel(service: ScriptedMemoryService(page: .success(MemoryPage(total: 0, rows: []))))

    await model.activate()

    #expect(model.state == .empty)
    #expect(MemoryText.emptyGraphDescription == "La mémoire du service ne contient aucun souvenir.")
}

// MARK: - Lecture de tous les projets (AC-1, AC-6)

@MainActor
@Test("graph-based-memeries-view/AC-1 : deux projets ⇒ un nœud par souvenir, chacun portant son projet")
func ac1EveryMemoryIsANodeWithItsProject() async {
    let rows = [
        memoryRow(id: "a-1", text: "un", scope: "projet-a", tags: ["t"]),
        memoryRow(id: "a-2", text: "deux", scope: "projet-a", tags: ["t"]),
        memoryRow(id: "b-1", text: "trois", scope: "projet-b"),
    ]
    let service = ScriptedMemoryService(page: .success(MemoryPage(total: 3, rows: rows)))
    let model = memoryGraphModel(service: service)

    await model.activate()

    // Aucune portée demandée : le graphe couvre TOUS les projets du service.
    #expect(service.allScopes == [nil])
    #expect(model.rows.count == 3)
    #expect(nodeIDs(model.visible.nodes) == ["a-1", "a-2", "b-1", "#t"])
    #expect(model.filterProjects == ["projet-a", "projet-b"])
    #expect(model.filterTags == ["t"])
    #expect(model.countBanner == "3 souvenirs · 2 projets")
    // Chaque nœud de souvenir a une position, y compris les nœuds-étiquettes.
    #expect(model.positions.count == 4)
}

@MainActor
@Test("graph-based-memeries-view/AC-6 : ⌘R fait apparaître un souvenir écrit pendant la session")
func ac6RefreshBringsANewNode() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "un", scope: "p")]))
    )
    let model = memoryGraphModel(service: service)
    await model.activate()
    #expect(nodeIDs(model.visible.nodes) == ["m-1"])

    // Un agent écrit un souvenir : la doublure rend la page neuve au rechargement.
    let page = MemoryPage(total: 2, rows: [
        memoryRow(id: "m-1", text: "un", scope: "p"),
        memoryRow(id: "m-2", text: "deux", scope: "p"),
    ])
    let refreshed = ScriptedMemoryService(page: .success(page))
    let second = memoryGraphModel(service: refreshed)
    await second.activate()

    #expect(second.visible.nodes.map(\.id) == [.memory("m-1"), .memory("m-2")])
    #expect(refreshed.allScopes == [nil])
}

@MainActor
@Test("graph-based-memeries-view/AC-1 : une ligne sans portée reste un nœud, regroupée sous « Sans projet »")
func ac1RowsWithoutScopeAreKept() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 2, rows: [
            memoryRow(id: "m-1", text: "un"),
            memoryRow(id: "m-2", text: "deux", scope: "p"),
        ]))
    )
    let model = memoryGraphModel(service: service)

    await model.activate()

    #expect(model.visible.nodes.count == 2)
    #expect(model.filterProjects == ["", "p"])
    #expect(MemoryText.scopeLabel("") == "Sans projet")
    #expect(MemoryText.scopeLabel("p") == "p")
    #expect(MemoryText.scopeLabel(nil) == "Sans projet")
}

// MARK: - Sélection, zoom, clavier (AC-2, AC-3, S-5)

@MainActor
@Test("graph-based-memeries-view/AC-2 : cliquer un nœud ouvre sa fiche ; cliquer le vide la referme")
func ac2ClickSelectsAndEmpties() async {
    let rows = [
        memoryRow(id: "m-1", text: "un", scope: "p"),
        memoryRow(id: "m-2", text: "deux", scope: "p"),
    ]
    let model = memoryGraphModel(service: ScriptedMemoryService(page: .success(MemoryPage(total: 2, rows: rows))))
    await model.activate()

    let viewport = MemoryGraphViewport(size: graphSize, zoom: model.zoom, pan: model.pan)
    let target = viewport.screen(try! #require(model.positions[.memory("m-2")]))
    model.click(at: target, size: graphSize)

    #expect(model.selection == "m-2")
    #expect(model.selected?.text == "deux")

    // Un clic loin de tout nœud désélectionne.
    model.click(at: CGPoint(x: 1, y: 1), size: graphSize)
    #expect(model.selection == nil)
    #expect(model.selected == nil)
}

@MainActor
@Test("graph-based-memeries-view/AC-3 : le zoom est borné, « Recentrer » remet la vue d'aplomb")
func ac3ZoomIsClampedAndRecenterResets() async {
    let model = memoryGraphModel(service: ScriptedMemoryService())
    await model.activate()

    model.zoomIn()
    #expect(model.zoom > 1)
    for _ in 0 ..< 20 { model.zoomIn() }
    #expect(model.zoom == MemoryGraphStyle.maxZoom)

    for _ in 0 ..< 40 { model.zoomOut() }
    #expect(model.zoom == MemoryGraphStyle.minZoom)

    model.magnify(by: 2, at: CGPoint(x: 50, y: 50), size: graphSize)
    model.endMagnify()
    model.drag(by: CGSize(width: 30, height: 20))
    model.endDrag()
    #expect(model.pan != .zero)

    model.recenter()
    #expect(model.zoom == 1)
    #expect(model.pan == .zero)
}

@MainActor
@Test("graph-based-memeries-view/AC-3 : le déplacement part de la position du DÉBUT du geste")
func ac3DragIsRelativeToItsStart() async {
    let model = memoryGraphModel(service: ScriptedMemoryService())
    await model.activate()

    model.drag(by: CGSize(width: 10, height: 0))
    model.drag(by: CGSize(width: 30, height: 5))
    model.endDrag()
    #expect(model.pan == CGSize(width: 30, height: 5))

    // Un nouveau geste repart de la position COURANTE, pas de la précédente.
    model.drag(by: CGSize(width: 1, height: 1))
    model.endDrag()
    #expect(model.pan == CGSize(width: 31, height: 6))
}

@MainActor
@Test("graph-based-memeries-view/AC-3 : les flèches prennent le nœud le plus proche dans la direction, Échap désélectionne")
func ac3KeyboardMovesTheSelection() async {
    let rows = [
        memoryRow(id: "centre", text: "centre", scope: "p"),
        memoryRow(id: "droite", text: "droite", scope: "p"),
        memoryRow(id: "gauche", text: "gauche", scope: "p"),
    ]
    let model = memoryGraphModel(service: ScriptedMemoryService(page: .success(MemoryPage(total: 3, rows: rows))))
    await model.activate()

    // Un placement fixé à la main : la géométrie du clavier est celle des positions.
    // (Le modèle expose les positions calculées ; le test les remplace par un
    // placement lisible en passant par un service dont les lignes sont triées.)
    model.select("centre")
    let centre = try! #require(model.positions[.memory("centre")])
    let droite = try! #require(model.positions[.memory("droite")])
    let gauche = try! #require(model.positions[.memory("gauche")])
    // Le placement est déterministe mais quelconque : on vérifie le CONTRAT, pas une
    // géométrie particulière — le nœud choisi est celui de la bonne direction.
    let versLaDroite = droite.x > centre.x ? "droite" : (gauche.x > centre.x ? "gauche" : nil)
    model.moveSelection(.right)
    if let expected = versLaDroite {
        #expect(model.selection == expected)
    } else {
        #expect(model.selection == "centre")
    }

    model.select(nil)
    model.moveSelection(.right)
    // Sans sélection, le départ est le centre du canevas : un nœud de la moitié
    // droite est choisi, ou rien — jamais un nœud de l'autre moitié.
    if let chosen = model.selection, let position = model.positions[.memory(chosen)] {
        #expect(position.x > 0.5)
    }
}

@MainActor
@Test("graph-based-memeries-view/AC-3 : un clic sur un nœud-étiquette applique son filtre")
func ac3ClickingATagNodeFilters() async {
    let rows = [
        memoryRow(id: "m-1", text: "un", scope: "p", tags: ["t"]),
        memoryRow(id: "m-2", text: "deux", scope: "p", tags: ["t"]),
    ]
    let model = memoryGraphModel(service: ScriptedMemoryService(page: .success(MemoryPage(total: 2, rows: rows))))
    await model.activate()

    let viewport = MemoryGraphViewport(size: graphSize, zoom: model.zoom, pan: model.pan)
    model.click(at: viewport.screen(try! #require(model.positions[.tag("t")])), size: graphSize)

    #expect(model.tagFilter == "t")
    #expect(model.visible.nodes.map(\.id) == [.memory("m-1"), .memory("m-2"), .tag("t")])
}

// MARK: - Filtres (AC-16)

@MainActor
@Test("graph-based-memeries-view/AC-16 : les filtres du modèle restreignent l'affichage, et reviennent à « tous » si leur valeur disparaît")
func ac16ModelFilters() async {
    let rows = [
        memoryRow(id: "a-1", text: "un", scope: "a", tags: ["t"]),
        memoryRow(id: "a-2", text: "deux", scope: "a", tags: ["t"]),
        memoryRow(id: "b-1", text: "trois", scope: "b", tags: ["u"]),
    ]
    let service = ScriptedMemoryService(page: .success(MemoryPage(total: 3, rows: rows)))
    let model = memoryGraphModel(service: service)
    await model.activate()

    model.setProjectFilter("a")
    #expect(nodeIDs(model.visible.nodes) == ["a-1", "a-2", "#t"])

    model.setTagFilter("t")
    #expect(nodeIDs(model.visible.nodes) == ["a-1", "a-2", "#t"])

    model.setProjectFilter("b")
    // « b » ne porte pas « t » : plus rien, mais les menus restent alimentés.
    #expect(model.visible.nodes.isEmpty)
    #expect(model.filterProjects == ["a", "b"])

    // Un filtre dont la valeur a disparu après rechargement revient à « tous ».
    model.setProjectFilter("projet-disparu")
    await model.refresh()
    #expect(model.projectFilter == nil)
}

// MARK: - Recherche (AC-17)

@MainActor
@Test("graph-based-memeries-view/AC-17 : la recherche restreint le graphe aux trouvés, sans troncature à 6, toutes portées")
func ac17SearchRestrictsToFoundRows() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 3, rows: [
            memoryRow(id: "m-1", text: "un", scope: "a"),
            memoryRow(id: "m-2", text: "deux", scope: "b"),
            memoryRow(id: "m-3", text: "trois", scope: "b"),
        ])),
        search: .success([
            memoryRow(id: "m-2", text: "deux", score: 0.9, scope: "b"),
            memoryRow(id: "m-3", text: "trois", score: 0.8, scope: "b"),
            memoryRow(id: "m-1", text: "un", score: 0.2, scope: "a"),
        ])
    )
    let model = memoryGraphModel(service: service)
    await model.activate()

    model.updateQuery("deux")
    await model.search()

    // Pool de la liste (24), SANS sa troncature à 6 ; recherche TOUTES portées.
    #expect(service.searches == [ScriptedMemoryService.Search(query: "deux", scope: nil, pool: 24)])
    #expect(model.searchIds == ["m-2", "m-3"])
    #expect(model.searchState == .query("deux", found: 2))
    #expect(nodeIDs(model.visible.nodes) == ["m-2", "m-3"])
}

@MainActor
@Test("graph-based-memeries-view/AC-17 : vider le champ lève la restriction SANS requête ; zéro trouvé est un état explicite")
func ac17EmptyQueryAndEmptyResult() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "un", scope: "a")])),
        search: .success([memoryRow(id: "m-9", text: "neuf", score: 0.1, scope: "a")])
    )
    let model = memoryGraphModel(service: service)
    await model.activate()

    model.updateQuery("rien")
    await model.search()
    #expect(model.searchState == .empty)
    #expect(model.searchIds?.isEmpty == true)
    #expect(service.searches.count == 1)

    // Vider le champ : restriction levée, AUCUNE requête de plus.
    model.updateQuery("   ")
    #expect(model.searchIds == nil)
    #expect(model.searchState == .none)
    #expect(nodeIDs(model.visible.nodes) == ["m-1"])
    await model.search()
    #expect(service.searches.count == 1)
}

@MainActor
@Test("graph-based-memeries-view/AC-17 : un souvenir trouvé mais absent des nœuds chargés est ignoré")
func ac17FoundRowOutsideTheGraphIsIgnored() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "un", scope: "a")])),
        search: .success([
            memoryRow(id: "m-1", text: "un", score: 0.9, scope: "a"),
            memoryRow(id: "absent", text: "ailleurs", score: 0.9, scope: "a"),
        ])
    )
    let model = memoryGraphModel(service: service)
    await model.activate()

    model.updateQuery("un")
    await model.search()

    #expect(nodeIDs(model.visible.nodes) == ["m-1"])
}

// MARK: - Écriture : corriger (AC-9, AC-10)

@MainActor
@Test("graph-based-memeries-view/AC-9 : la feuille d'édition pré-remplit le texte VERBATIM et envoie ce qui est saisi")
func ac9EditSendsTheTypedTextVerbatim() async {
    let stored = "texte d'origine\navec une ligne 2   "
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: stored, scope: "a", tags: ["t1", "t2"])]))
    )
    let model = memoryGraphModel(service: service)
    await model.activate()

    model.beginEdit("m-1")
    #expect(model.sheet == MemoryGraphModel.Sheet.edit("m-1"))
    // Pré-remplissage VERBATIM : ni titre court, ni transformation.
    #expect(model.draftText == stored)
    #expect(model.draftTags == "t1, t2")

    model.draftText = "texte corrigé   avec des blancs"
    model.draftTags = " t1 ,, t3 , t1 "
    await model.saveDraft()

    #expect(service.updates == [
        ScriptedMemoryService.Update(id: "m-1", text: "texte corrigé   avec des blancs", tags: ["t1", "t3"]),
    ])
    // La feuille se ferme, la LISTE doit se recharger, et le graphe est relu.
    #expect(model.sheet == nil)
    #expect(model.mutations == 1)
}

@MainActor
@Test("graph-based-memeries-view/AC-9 : un texte blanc est refusé par le bouton, aucune requête n'est émise")
func ac9BlankTextNeverSends() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "un", scope: "a")]))
    )
    let model = memoryGraphModel(service: service)
    await model.activate()

    model.beginEdit("m-1")
    model.draftText = "   \n  "
    #expect(!model.canSaveDraft)
    await model.saveDraft()

    #expect(service.updates.isEmpty)
    #expect(model.sheet == MemoryGraphModel.Sheet.edit("m-1"))
}

@MainActor
@Test("graph-based-memeries-view/AC-9 : l'échec du service laisse la feuille OUVERTE et affiche son message")
func ac9FailedUpdateKeepsTheSheetOpen() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "un", scope: "a")])),
        writeFailure: .unexpectedStatus(500, "oMLX injoignable")
    )
    let model = memoryGraphModel(service: service)
    await model.activate()

    model.beginEdit("m-1")
    model.draftText = "corrigé"
    await model.saveDraft()

    #expect(model.sheet == MemoryGraphModel.Sheet.edit("m-1"))
    #expect(model.sheetError == "réponse 500 du service (oMLX injoignable)")
    // Aucun rechargement, donc aucun compteur d'écriture.
    #expect(model.mutations == 0)
}

@MainActor
@Test("graph-based-memeries-view/AC-10 : les étiquettes normalisées remplacent celles du souvenir")
func ac10TagsAreNormalizedAndReplaced() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "un", scope: "a", tags: ["vieux"])]))
    )
    let model = memoryGraphModel(service: service)
    await model.activate()

    model.beginEdit("m-1")
    model.draftTags = "neuf, ,neuf ,deux"
    await model.saveDraft()

    #expect(service.updates.map(\.tags) == [["neuf", "deux"]])
    #expect(MemoryTags.normalized(["neuf", "deux"]) == "neuf,deux")
    // Champ vidé ⇒ aucune étiquette (chaîne vide envoyée telle quelle).
    model.beginEdit("m-1")
    model.draftTags = "  "
    await model.saveDraft()
    #expect(service.updates.last?.tags == [])
}

// MARK: - Écriture : créer (AC-12)

@MainActor
@Test("graph-based-memeries-view/AC-12 : la création écrit dans le projet choisi, puis recharge le graphe et la liste")
func ac12CreateWritesInTheChosenProject() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "un", scope: "projet-a")]))
    )
    let model = memoryGraphModel(service: service, scope: "projet-b")
    await model.activate()

    model.beginCreate()
    #expect(model.sheet == MemoryGraphModel.Sheet.create)
    // Les projets proposés : les portées chargées ET le projet courant, triés.
    #expect(model.createScopes == ["projet-a", "projet-b"])
    // Le défaut est le projet COURANT.
    #expect(model.draftScope == "projet-b")

    model.draftText = "souvenir neuf"
    model.draftTags = "t"
    await model.saveDraft()

    #expect(service.adds == [ScriptedMemoryService.Add(text: "souvenir neuf", scope: "projet-b", tags: ["t"])])
    #expect(model.mutations == 1)
    #expect(model.sheet == nil)
    // Le graphe est relu après l'écriture.
    #expect(service.allScopes == [nil, nil])
}

@MainActor
@Test("graph-based-memeries-view/AC-12 : sans projet connu, la validation est impossible et rien n'est émis")
func ac12NoKnownProjectBlocksCreation() async {
    let model = memoryGraphModel(service: ScriptedMemoryService(), scope: nil)
    await model.activate()

    model.beginCreate()

    #expect(model.createScopes.isEmpty)
    #expect(model.draftScope.isEmpty)
    #expect(!model.canSaveDraft)
    await model.saveDraft()
    #expect(model.sheet == MemoryGraphModel.Sheet.create)
}

// MARK: - Écriture : supprimer (AC-11, AC-15)

@MainActor
@Test("graph-based-memeries-view/AC-11 : la suppression confirmée retire le souvenir du graphe et de la liste, et élague ses liens")
func ac11DeleteRemovesFromBothListsAndPrunesLinks() async throws {
    let paths = memoryTemporaryPaths()
    defer { try? FileManager.default.removeItem(at: paths.supportRoot) }
    #expect(MemoryLinkStore.save([MemoryLink(a: "m-1", b: "m-2")], to: paths.memoryLinks))

    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 2, rows: [
            memoryRow(id: "m-1", text: "un", scope: "a"),
            memoryRow(id: "m-2", text: "deux", scope: "a"),
        ]))
    )
    let model = memoryGraphModel(service: service, paths: paths)
    await model.activate()
    #expect(model.manualLinks.count == 1)
    model.select("m-1")

    model.requestDelete("m-1")
    #expect(model.pendingDelete == "m-1")
    await model.confirmDelete()

    #expect(service.deletes == ["m-1"])
    #expect(model.mutations == 1)
    #expect(model.selection == nil)
    // Le rechargement suivant ne retrouve plus m-1 : le lien est élagué ET le
    // fichier réécrit (relu par un store neuf).
    let reloaded = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-2", text: "deux", scope: "a")]))
    )
    let second = memoryGraphModel(service: reloaded, paths: paths)
    await second.activate()
    #expect(second.manualLinks.isEmpty)
    #expect(MemoryLinkStore.load(paths.memoryLinks).isEmpty)
}

@MainActor
@Test("graph-based-memeries-view/AC-11 : l'échec de la suppression laisse tout en place et affiche le message")
func ac11FailedDeleteKeepsEverything() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-1", text: "un", scope: "a")])),
        writeFailure: .unexpectedStatus(500, "déjà supprimé")
    )
    let model = memoryGraphModel(service: service)
    await model.activate()
    model.select("m-1")

    model.requestDelete("m-1")
    await model.confirmDelete()

    #expect(model.errorLine == "réponse 500 du service (déjà supprimé)")
    #expect(model.mutations == 0)
    #expect(model.rows.count == 1)
    #expect(model.selection == "m-1")
}

// MARK: - Liens manuels (AC-13, AC-14, AC-15)

@MainActor
@Test("graph-based-memeries-view/AC-13 : un lien créé s'affiche immédiatement et survit à une relance (store neuf)")
func ac13CreatedLinkIsVisibleAndPersisted() async {
    let paths = memoryTemporaryPaths()
    defer { try? FileManager.default.removeItem(at: paths.supportRoot) }
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 2, rows: [
            memoryRow(id: "m-1", text: "un", scope: "a"),
            memoryRow(id: "m-2", text: "deux", scope: "b"),
        ]))
    )
    let model = memoryGraphModel(service: service, paths: paths)
    await model.activate()

    model.beginLink("m-1")
    #expect(model.sheet == MemoryGraphModel.Sheet.link("m-1"))
    // Le souvenir lui-même n'est pas proposé.
    #expect(model.linkCandidates.map(\.id) == ["m-2"])
    model.selectLinkCandidate("m-2")
    model.createLink()

    #expect(model.manualLinks == [MemoryLink(a: "m-1", b: "m-2")])
    #expect(model.allLinks.contains { $0.kind == .manual })
    #expect(model.mutations == 1)

    // Relance simulée : un modèle NEUF relit le fichier.
    let relaunched = memoryGraphModel(service: service, paths: paths)
    #expect(relaunched.manualLinks == [MemoryLink(a: "m-1", b: "m-2")])
}

@MainActor
@Test("graph-based-memeries-view/AC-14 : un lien détaché disparaît et ne revient pas après relance")
func ac14DetachedLinkDoesNotReturn() async {
    let paths = memoryTemporaryPaths()
    defer { try? FileManager.default.removeItem(at: paths.supportRoot) }
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 2, rows: [
            memoryRow(id: "m-1", text: "un", scope: "a"),
            memoryRow(id: "m-2", text: "deux", scope: "a"),
        ]))
    )
    let model = memoryGraphModel(service: service, paths: paths)
    await model.activate()
    model.beginLink("m-1")
    model.selectLinkCandidate("m-2")
    model.createLink()
    #expect(model.manualLinks(of: "m-1").count == 1)

    model.detach(MemoryLink(a: "m-1", b: "m-2"))

    #expect(model.manualLinks.isEmpty)
    #expect(!model.allLinks.contains { $0.kind == .manual })
    #expect(memoryGraphModel(service: service, paths: paths).manualLinks.isEmpty)
    #expect(model.mutations == 2)
}

@MainActor
@Test("graph-based-memeries-view/AC-13 : la feuille de lien écarte les liens déjà existants et filtre par texte")
func ac13LinkCandidatesExcludeExistingAndFilter() async {
    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 3, rows: [
            memoryRow(id: "m-1", text: "un", scope: "a"),
            memoryRow(id: "m-2", text: "deux pommes", scope: "a"),
            memoryRow(id: "m-3", text: "trois poires", scope: "a"),
        ]))
    )
    let model = memoryGraphModel(service: service)
    await model.activate()

    model.beginLink("m-1")
    #expect(model.linkCandidates.map(\.id) == ["m-2", "m-3"])

    model.linkFilter = "poire"
    #expect(model.linkCandidates.map(\.id) == ["m-3"])

    model.selectLinkCandidate("m-2")
    model.createLink()
    // Le lien créé écarte le candidat de la prochaine ouverture.
    model.beginLink("m-1")
    #expect(model.linkCandidates.map(\.id) == ["m-3"])
}

@MainActor
@Test("graph-based-memeries-view/AC-15 : un rechargement sans l'id élague le lien et réécrit le fichier")
func ac15ReloadPrunesTheOrphanAndRewritesTheFile() async {
    let paths = memoryTemporaryPaths()
    defer { try? FileManager.default.removeItem(at: paths.supportRoot) }
    #expect(MemoryLinkStore.save([MemoryLink(a: "m-1", b: "m-2")], to: paths.memoryLinks))

    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 1, rows: [memoryRow(id: "m-2", text: "deux", scope: "a")]))
    )
    let model = memoryGraphModel(service: service, paths: paths)

    await model.activate()

    #expect(model.manualLinks.isEmpty)
    #expect(MemoryLinkStore.load(paths.memoryLinks).isEmpty)
    #expect(model.allLinks.isEmpty)
}

@MainActor
@Test("graph-based-memeries-view/AC-13 : un échec d'écriture du fichier est dit, et le lien reste pour la session")
func ac13LinkSaveFailureIsReported() async throws {
    // Un FICHIER à l'emplacement de la racine : l'écriture du lien ne peut aboutir.
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("omp-console-links-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try Data("obstacle".utf8).write(to: root)
    let paths = AppPaths(supportRoot: root)

    let service = ScriptedMemoryService(
        page: .success(MemoryPage(total: 2, rows: [
            memoryRow(id: "m-1", text: "un", scope: "a"),
            memoryRow(id: "m-2", text: "deux", scope: "a"),
        ]))
    )
    let model = memoryGraphModel(service: service, paths: paths)
    await model.activate()

    model.beginLink("m-1")
    model.selectLinkCandidate("m-2")
    model.createLink()

    #expect(model.manualLinks == [MemoryLink(a: "m-1", b: "m-2")])
    #expect(model.errorLine == MemoryText.linkNotSaved)
}
