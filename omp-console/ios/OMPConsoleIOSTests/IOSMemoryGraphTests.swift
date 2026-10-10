// Les preuves Swift du MODE GRAPHE de la section Mémoire de l'app iOS (S-3, S-4,
// S-5, S-6, S-7) : le relais de la charge utile du Mac, la lecture UNIQUE, les
// états, les gestes de vue, la fiche et le filtre d'étiquette.
//
// Aucune socket : la doublure `GraphReader` rend la charge utile de la fixture
// PARTAGÉE `MemoryGraphParity` (ConsoleCore) et compte ses lectures.

import ConsoleClient
import ConsoleCore
import CoreGraphics
import Foundation
import Testing

@testable import OMPConsoleIOS

/// La doublure de lecture du graphe : l'état du client, la charge utile ou la
/// panne, et le compte des lectures.
@MainActor
private final class GraphReader: IOSMemoryReading {
    var state: ClientState = .connected(endpoint: ClientEndpoint.manual(host: "127.0.0.1", port: 8787))
    var graph: Result<RemoteMemoryGraphPayload, Error>
    private(set) var graphReads = 0
    /// Une lecture qui ne rend qu'à son annulation (test de `suspend`).
    var hangs = false
    private(set) var cancelledReads = 0
    private(set) var pageReads = 0
    private(set) var searchReads = 0

    init(graph: Result<RemoteMemoryGraphPayload, Error> = .success(IOSMemoryGraphRecipe.graphe.payload)) {
        self.graph = graph
    }

    func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        pageReads += 1
        return RemoteMemoryPagePayload(scope: "projet", total: 0, offset: offset, rows: [], nextOffset: nil)
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        searchReads += 1
        return RemoteMemorySearchPayload(rows: [], candidates: 0, scored: 0)
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        graphReads += 1
        if hangs {
            do { try await Task.sleep(for: .seconds(60)) } catch {
                cancelledReads += 1
                throw error
            }
        }
        return try graph.get()
    }
}

@MainActor
@Suite("ios-memoire-graphe — le modèle de l'écran")
struct IOSMemoryGraphTests {
    private let size = CGSize(width: 390, height: 700)

    private func screenPoint(_ model: IOSMemoryGraphModel, _ id: MemoryGraphNodeID) -> CGPoint {
        let viewport = MemoryGraphViewport(size: size, zoom: model.zoom, pan: model.pan)
        return viewport.screen(model.positions[id] ?? CGPoint(x: 0.5, y: 0.5))
    }

    // MARK: - AC-10 : la LISTE est le mode d'ouverture

    @Test("ios-memoire-graphe/AC-10 : theListIsTheOpeningMode — rien n'est lu avant la bascule")
    func theListIsTheOpeningMode() async {
        let reader = GraphReader()
        let model = IOSMemoryGraphModel(client: reader)
        // Avant tout geste : le graphe n'est pas affiché et n'a rien lu.
        #expect(model.shown == false)
        #expect(model.state == .idle)
        #expect(reader.graphReads == 0)
        // La bascule affiche le graphe puis lit UNE fois.
        await model.activate()
        #expect(model.shown == true)
        #expect(reader.graphReads == 1)
    }

    // MARK: - AC-1 : le relais des faits du fil

    @Test("ios-memoire-graphe/AC-1 : graphShowsTheWireFacts — le graphe publie les nœuds et liens servis")
    func graphShowsTheWireFacts() async {
        let reader = GraphReader()
        let model = IOSMemoryGraphModel(client: reader)
        await model.activate()

        let facts = MemoryGraphParity.facts
        #expect(model.visible.nodes == facts.nodes)
        #expect(model.visible.links == facts.links)
        #expect(model.positions.count == facts.nodes.count)
        #expect(model.isTruncated == false)
        // Le lien manuel de la fixture est là, distinguable.
        #expect(model.visible.links.contains { $0.kind == .manual })
        // La fiche d'un souvenir lit ses FAITS de nœud.
        let row = model.row("m1")
        #expect(row?.text == "titre un")
        #expect(row?.tags == ["commun", "seul-a"])
        #expect(row?.agentId == "alpha")
    }

    // MARK: - AC-3 : une seule route de lecture

    @Test("ios-memoire-graphe/AC-3 : graphReadsOnlyTheGraphRouteOnce — une lecture par activation, aucune au retour")
    func graphReadsOnlyTheGraphRouteOnce() async {
        let reader = GraphReader()
        let model = IOSMemoryGraphModel(client: reader)

        await model.activate()
        #expect(reader.graphReads == 1)
        // Le retour à la liste ne lit RIEN et n'efface rien.
        model.hide()
        #expect(model.shown == false)
        #expect(model.state != .idle)
        // Un nouveau passage en graphe ne relit PAS.
        await model.activate()
        #expect(reader.graphReads == 1)
        // « Rafraîchir » est le SEUL qui relit.
        await model.refresh()
        #expect(reader.graphReads == 2)
        // Aucune autre lecture : jamais le sommaire ni la recherche.
        #expect(reader.pageReads == 0)
        #expect(reader.searchReads == 0)

        // Hors `.connected`, aucune lecture.
        reader.state = .unpaired
        await model.refresh()
        #expect(reader.graphReads == 2)
    }

    @Test("ios-memoire-graphe/AC-3 : suspendCancelsTheInFlightGraphRead — quitter la section annule la lecture en vol, et le retour relit")
    func suspendCancelsTheInFlightGraphRead() async {
        let reader = GraphReader()
        reader.hangs = true
        let model = IOSMemoryGraphModel(client: reader)

        let activation = Task { await model.activate() }
        while reader.graphReads == 0 { await Task.yield() }
        #expect(model.state == .loading)

        model.suspend()
        await activation.value
        #expect(reader.cancelledReads == 1)
        #expect(model.state == .idle)

        // Le retour sur la section relit : la lecture annulée n'a rien publié.
        reader.hangs = false
        await model.activate()
        #expect(reader.graphReads == 2)
        #expect(model.state != .idle)
    }

    // MARK: - États

    @Test("ios-memoire-graphe/AC-1 : partialGraphIsAnnounced — une charge tronquée est annoncée")
    func partialGraphIsAnnounced() async {
        let payload = IOSMemoryGraphRecipe.graphe.payload
        var truncated = payload
        truncated.truncated = true
        let reader = GraphReader(graph: .success(truncated))
        let model = IOSMemoryGraphModel(client: reader)
        await model.activate()
        #expect(model.isTruncated == true)
    }

    @Test("ios-memoire-graphe/AC-1 : graphUnavailableIsTheRelayDetail — panne mémoire et panne de transport distinctes")
    func graphUnavailableIsTheRelayDetail() async {
        let detail = MemoryText.unavailableDetail(address: "127.0.0.1:8321", error: "connexion refusée")
        let reader = GraphReader(graph: .failure(ClientError.api(.unavailable(detail))))
        let model = IOSMemoryGraphModel(client: reader)
        await model.activate()
        #expect(model.state == .failed(.serviceUnavailable))

        let transport = GraphReader(graph: .failure(ClientError.transport(.unreachable("refus"))))
        let other = IOSMemoryGraphModel(client: transport)
        await other.activate()
        #expect(other.state == .failed(.macUnreachable))

        // Un graphe VIDE est un état « vide », jamais un canevas muet.
        let empty = GraphReader(graph: .success(RemoteMemoryGraphPayload(scope: "projet", nodes: [], links: [], total: 0)))
        let blank = IOSMemoryGraphModel(client: empty)
        await blank.activate()
        #expect(blank.state == .empty)
    }

    // MARK: - ios-graphe-memoire-405-erreur-brute : « trop ancien » lisible

    /// Le prédicat « lisible » : ni adresse, ni JSON, ni code HTTP à trois chiffres.
    private func isReadable(_ text: String) -> Bool {
        let forbidden = ["localhost", "://", "{", "\"detail\""]
        guard !forbidden.contains(where: text.contains) else { return false }
        return text.range(of: #"\b\d{3}\b"#, options: .regularExpression) == nil
    }

    private func stateAfter(_ error: Error) async -> IOSMemoryGraphModel.State {
        let model = IOSMemoryGraphModel(client: GraphReader(graph: .failure(error)))
        await model.activate()
        return model.state
    }

    @Test("ios-graphe-memoire-405-erreur-brute/AC-3 : serviceOutdatedOn405IsReadable — le 405 relayé devient « serveur mémoire trop ancien »")
    func serviceOutdatedOn405IsReadable() async {
        let relayed = MemoryText.unavailableDetail(
            address: "http://localhost:8321",
            error: "réponse 405 du service ({\"detail\":\"Method Not Allowed\"})"
        )
        #expect(await stateAfter(ClientError.api(.outdatedService(relayed))) == .serviceOutdated)
        let text = IOSMemoryText.graphServiceOutdated
        #expect(text.contains("serveur mémoire trop ancien"))
        #expect(text.contains("mem0-http"))
        #expect(isReadable(text))
        #expect(!text.contains("mets-la à jour"))
    }

    @Test("ios-graphe-memoire-405-erreur-brute/AC-4 : serviceOutdatedOn404IsTheSameMessage — le 404 relayé donne le même état et le même texte")
    func serviceOutdatedOn404IsTheSameMessage() async {
        let relayed = MemoryText.unavailableDetail(
            address: "http://localhost:8321",
            error: "réponse 404 du service ({\"detail\":\"Not Found\"})"
        )
        let state = await stateAfter(ClientError.api(.outdatedService(relayed)))
        #expect(state == .serviceOutdated)
        #expect(state == (await stateAfter(ClientError.api(.outdatedService("autre détail")))))
        #expect(isReadable(IOSMemoryText.graphServiceOutdated))
    }

    @Test("ios-graphe-memoire-405-erreur-brute/AC-5 : macOutdatedOnNotFound — la coque qui ne connaît pas la route donne « app Mac trop ancienne »")
    func macOutdatedOnNotFound() async {
        #expect(await stateAfter(ClientError.api(.notFound("route inconnue"))) == .macOutdated)
        #expect(await stateAfter(ClientError.api(.notFound("autre"))) == .macOutdated)
        let text = IOSMemoryText.graphMacOutdated
        #expect(text.contains("app Mac trop ancienne, mets-la à jour"))
        #expect(!text.contains("serveur mémoire trop ancien"))
        #expect(isReadable(text))
    }

    @Test("ios-graphe-memoire-405-erreur-brute/AC-6 : otherFailuresNeverClaimOutdated — les autres pannes restent celles d'avant, sans « trop ancien »")
    func otherFailuresNeverClaimOutdated() async {
        let detail = MemoryText.unavailableDetail(address: "127.0.0.1:8321", error: "réponse 500 du service (boom)")
        let unavailable = await stateAfter(ClientError.api(.unavailable(detail)))
        #expect(unavailable == .failed(.serviceUnavailable))

        let server = await stateAfter(ClientError.api(.server("mémoire indisponible")))
        #expect(server == .failed(.generic))

        let transport = await stateAfter(ClientError.transport(.unreachable("refus")))
        #expect(transport == .failed(.macUnreachable))

        let texts = [
            IOSMacErrorText.message(for: .serviceUnavailable),
            IOSMacErrorText.message(for: .generic),
            IOSMacErrorText.message(for: .macUnreachable),
        ]
        for text in texts {
            #expect(!text.contains("trop ancien"))
            #expect(!text.contains("mets-la à jour"))
        }
    }

    // MARK: - ios-erreurs-serveur-lisibles (S-4)

    /// La doublure du Mac : ce que le client lève pour une réponse d'erreur.
    private func macError(status: Int, code: String, message: String) -> ClientError {
        let body = (try? JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message]])) ?? Data()
        return ClientErrorMapping.translate(status: status, protocolVersion: 1, body: body)
    }

    /// Le 503 que rend le Mac quand mem0-http répond 405 : l'adresse et le JSON amont
    /// sont dans le message.
    private var relayed503: ClientError {
        macError(
            status: 503,
            code: "unavailable",
            message: MemoryText.unavailableDetail(
                address: "localhost:8321",
                error: "réponse 405 du service ({\"detail\":\"Method Not Allowed\"})"
            )
        )
    }

    @Test("ios-erreurs-serveur-lisibles/AC-9 : graphKeepsOutdatedDistinction — outdated_service dit « serveur mémoire trop ancien », 404 not_found dit « app Mac trop ancienne »")
    func graphKeepsOutdatedDistinction() async {
        let outdated = macError(status: 503, code: "outdated_service", message: "localhost:8321 réponse 405 du service")
        #expect(await stateAfter(outdated) == .serviceOutdated)
        #expect(IOSMemoryText.graphServiceOutdated.contains("serveur mémoire trop ancien"))

        let notFound = macError(status: 404, code: "not_found", message: "route inconnue")
        #expect(await stateAfter(notFound) == .macOutdated)
        #expect(IOSMemoryText.graphMacOutdated.contains("app Mac trop ancienne"))
        #expect(IOSMemoryText.graphServiceOutdated != IOSMemoryText.graphMacOutdated)
    }

    @Test("ios-erreurs-serveur-lisibles/AC-8 : graphShowsTranslatedFailure — le graphe porte la cause du traducteur partagé, lisible")
    func graphShowsTranslatedFailure() async {
        let unavailable = await stateAfter(relayed503)
        #expect(unavailable == .failed(.serviceUnavailable))
        let server = await stateAfter(macError(status: 500, code: "server", message: "erreur inattendue"))
        #expect(server == .failed(.generic))
        let transport = await stateAfter(ClientError.transport(.unreachable("Could not connect to the server. (127.0.0.1:8787)")))
        #expect(transport == .failed(.macUnreachable))

        for cause in [IOSMacFailure.serviceUnavailable, .generic, .macUnreachable] {
            #expect(isReadable(IOSMacErrorText.message(for: cause)))
        }
        #expect(IOSMacErrorText.message(for: .serviceUnavailable).contains("Service indisponible sur le Mac"))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-7 : graphRetryShowsGraph — Réessayer relit le graphe et l'affiche")
    func graphRetryShowsGraph() async {
        let reader = GraphReader(graph: .failure(relayed503))
        let model = IOSMemoryGraphModel(client: reader)
        await model.activate()
        #expect(model.state == .failed(.serviceUnavailable))

        reader.graph = .success(IOSMemoryGraphRecipe.graphe.payload)
        await model.refresh()
        #expect(reader.graphReads == 2)
        if case .graph = model.state {} else {
            Issue.record("le graphe n'est pas affiché après Réessayer : \(model.state)")
        }
    }

    @Test("ios-erreurs-serveur-lisibles/AC-5 : graphUnauthorizedIsIdle — un 401 ne pose aucun message de graphe")
    func graphUnauthorizedIsIdle() async {
        #expect(IOSMemoryGraphModel.failure(from: ClientError.api(.unauthorized)) == .idle)
        #expect(await stateAfter(ClientError.api(.unauthorized)) == .idle)
    }

    // MARK: - AC-4, AC-5 : pincer et glisser

    @Test("ios-memoire-graphe/AC-4 : pinchAndDragMoveTheViewportAndKeepNodesHittable")
    func pinchAndDragMoveTheViewportAndKeepNodesHittable() async {
        let reader = GraphReader()
        let model = IOSMemoryGraphModel(client: reader)
        await model.activate()

        // Le zoom reste borné, et le point gardé sous le geste y reste.
        model.magnify(by: 2, at: CGPoint(x: 195, y: 350), size: size)
        model.endMagnify()
        #expect(model.zoom == 2)
        model.magnify(by: 100, at: CGPoint(x: 195, y: 350), size: size)
        model.endMagnify()
        #expect(model.zoom == MemoryGraphStyle.maxZoom)
        model.setZoom(1)
        model.drag(by: CGSize(width: 60, height: 40))
        model.endDrag()
        #expect(model.pan == CGSize(width: 60, height: 40))

        // Après manipulation, un nœud reste touchable sous son point écran.
        let id = MemoryGraphNodeID.memory("m1")
        let point = screenPoint(model, id)
        #expect(
            MemoryGraphHitTest.node(at: point, positions: model.positions, zoom: model.zoom, pan: model.pan, size: size) == id
        )
    }

    @Test("ios-memoire-graphe/AC-5 : pinchDragAndTapAreTheSameOnIPad — pincer, glisser puis toucher à 1024×1366")
    func pinchDragAndTapAreTheSameOnIPad() async {
        let ipad = CGSize(width: 1024, height: 1366)
        let reader = GraphReader()
        let model = IOSMemoryGraphModel(client: reader)
        await model.activate()

        model.magnify(by: 2, at: CGPoint(x: 512, y: 683), size: ipad)
        model.endMagnify()
        #expect(model.zoom == 2)
        model.drag(by: CGSize(width: 80, height: 50))
        model.endDrag()
        #expect(model.pan == CGSize(width: 80, height: 50))

        let id = MemoryGraphNodeID.memory("m1")
        let viewport = MemoryGraphViewport(size: ipad, zoom: model.zoom, pan: model.pan)
        let point = viewport.screen(model.positions[id] ?? CGPoint(x: 0.5, y: 0.5))
        model.click(at: point, size: ipad)
        #expect(model.selection == "m1")
        #expect(model.row("m1")?.text == "titre un")
        #expect(!model.links(of: "m1").isEmpty)
    }

    // MARK: - AC-6 : toucher un souvenir

    @Test("ios-memoire-graphe/AC-6 : touchingAMemoryOpensItsSheet — voisinage mis en évidence et fiche des faits")
    func touchingAMemoryOpensItsSheet() async {
        let reader = GraphReader()
        let model = IOSMemoryGraphModel(client: reader)
        await model.activate()

        let id = MemoryGraphNodeID.memory("m1")
        model.click(at: screenPoint(model, id), size: size)
        #expect(model.selection == "m1")

        // La scène PARTAGÉE marque le disque ET tous les liens du souvenir.
        let scene = MemoryGraphScene.build(
            nodes: model.visible.nodes,
            links: model.visible.links,
            positions: model.positions,
            viewport: MemoryGraphViewport(size: size, zoom: model.zoom, pan: model.pan),
            selection: model.selection,
            hovered: nil
        )
        #expect(scene.shapes.contains { if case let .disc(_, _, _, selected, _) = $0 { return selected } else { return false } })
        let highlighted = scene.shapes.filter { if case let .line(_, _, _, on) = $0 { return on } else { return false } }
        #expect(!highlighted.isEmpty)

        // La fiche porte le texte intégral, les étiquettes et les liens.
        let row = model.row("m1")
        #expect(row?.text == "titre un")
        #expect(row?.tags == ["commun", "seul-a"])
        #expect(!model.links(of: "m1").isEmpty)
        #expect(IOSMemoryDetailView.linkLines(model.links(of: "m1"), from: "m1", labels: model.nodeLabels).count
            == model.links(of: "m1").count)

        // Toucher le vide lève la sélection.
        model.click(at: CGPoint(x: -50, y: -50), size: size)
        #expect(model.selection == nil)
    }

    // MARK: - AC-7 : toucher un nœud-étiquette applique le filtre

    @Test("ios-memoire-graphe/AC-7 : touchingATagAppliesItsFilterAndTheMenuClearsIt")
    func touchingATagAppliesItsFilterAndTheMenuClearsIt() async {
        let reader = GraphReader()
        let model = IOSMemoryGraphModel(client: reader)
        await model.activate()

        let tag = MemoryGraphNodeID.tag(MemoryGraphParity.tag)
        model.click(at: screenPoint(model, tag), size: size)
        #expect(model.tagFilter == MemoryGraphParity.tag)
        #expect(model.isCurrentTag(MemoryGraphParity.tag))
        #expect(!model.isCurrentTag(nil))

        // Le graphe ne montre plus que la FAMILLE de l'étiquette (même règle que
        // `MemoryGraph.visibility(tag:)`).
        let expected = MemoryGraph.visibility(
            rows: MemoryGraphParity.rows,
            links: MemoryGraphParity.facts.links,
            project: nil,
            tag: MemoryGraphParity.tag,
            searchIds: nil
        )
        #expect(model.visible.nodes == expected.nodes)
        #expect(model.visible.links == expected.links)
        #expect(model.visible.nodes.allSatisfy { $0.id.tagName == MemoryGraphParity.tag || $0.tags.contains(MemoryGraphParity.tag) })
        #expect(model.visible.nodes.filter { $0.id.tagName != nil }.count == 1)

        // Le menu propose toutes les étiquettes, et « Toutes » lève le filtre.
        #expect(model.tagNodes.count == 2)
        model.setTagFilter(nil)
        #expect(model.visible.nodes == MemoryGraphParity.facts.nodes)
        #expect(model.isCurrentTag(nil))
        #expect(!model.isCurrentTag(MemoryGraphParity.tag))

        // Un second tap sur le même nœud est idempotent.
        model.setTagFilter(MemoryGraphParity.tag)
        model.click(at: screenPoint(model, tag), size: size)
        #expect(model.tagFilter == MemoryGraphParity.tag)
    }
}
