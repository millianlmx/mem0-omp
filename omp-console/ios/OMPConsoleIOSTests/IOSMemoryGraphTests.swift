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
import UIKit

@testable import OMPConsoleIOS

/// La doublure de lecture du graphe : l'état du client, la charge utile ou la
/// panne, et le compte des lectures. Interne à la cible de test : les preuves
/// d'ios-gestes-et-retours-natifs (IOSGestesNatifsTests) la réutilisent.
@MainActor
final class GraphReader: IOSMemoryReading {
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
        // Un nouveau passage en graphe RELIT (ios-gestes-et-retours-natifs, S-2 :
        // le mode Graphe n'a aucun tirage pour actualiser).
        await model.activate()
        #expect(reader.graphReads == 2)
        // ⌘R « Actualiser » relit aussi.
        await model.refresh()
        #expect(reader.graphReads == 3)
        // Aucune autre lecture : jamais le sommaire ni la recherche.
        #expect(reader.pageReads == 0)
        #expect(reader.searchReads == 0)

        // Hors `.connected`, aucune lecture, ni par ⌘R ni par un passage en graphe ;
        // le graphe déjà lu reste affiché.
        reader.state = .unpaired
        await model.refresh()
        model.hide()
        await model.activate()
        #expect(reader.graphReads == 3)
        #expect(model.shown == true)
        #expect(model.visible.nodes == MemoryGraphParity.facts.nodes)
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
        #expect(!text.contains("mem0-http"))
        #expect(text.contains("Mettez à jour OMP Console sur le Mac"))
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
        #expect(text.contains("app Mac trop ancienne.\nMettez à jour OMP Console sur le Mac, puis réessayez."))
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
        return ClientErrorMapping.translate(status: status, protocolVersion: ConsoleAPI.protocolVersion, body: body)
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

    // MARK: - ios-statistiques-et-graphe-accessibles AC-5..AC-7 : le graphe parcouru par VoiceOver

    /// Les nœuds dont le point écran tombe dans le canevas (bords compris), au zoom
    /// et au déplacement courants.
    private func nodesInFrame(_ model: IOSMemoryGraphModel) -> [MemoryGraphNodeID] {
        model.visible.nodes.map(\.id).filter { id in
            guard model.positions[id] != nil else { return false }
            let point = screenPoint(model, id)
            return point.x >= 0 && point.y >= 0 && point.x <= size.width && point.y <= size.height
        }
    }

    private func target(of id: MemoryGraphNodeID) -> IOSMemoryGraphElement.Target {
        switch id {
        case let .memory(memory): return .memory(memory)
        case let .tag(tag): return .tag(tag)
        }
    }

    private func elementID(of id: MemoryGraphNodeID) -> String {
        switch id {
        case let .memory(memory): return IOSMemoryAccessibility.graphMemory(memory)
        case let .tag(tag): return IOSMemoryAccessibility.graphTagOption(tag)
        }
    }

    @Test("ios-statistiques-et-graphe-accessibles/AC-5 : voiceOverExposesOneElementPerShownNode — un élément par souvenir et par nœud-étiquette affichés, liens annoncés, titres liés à la demande")
    func voiceOverExposesOneElementPerShownNode() async {
        let model = IOSMemoryGraphModel(client: GraphReader())
        #expect(model.accessibilityElements(size: size).isEmpty)
        await model.activate()
        #expect(model.zoom == 1)

        let elements = model.accessibilityElements(size: size)
        let memories = elements.filter { if case .memory = $0.target { return true } else { return false } }
        let tags = elements.filter { if case .tag = $0.target { return true } else { return false } }
        #expect(memories.count == 9)
        #expect(tags.count == 2)
        #expect(!elements.contains { $0.target == .showAll })
        #expect(Set(elements.map(\.id)).count == elements.count)

        // m4 : « titre quatre, 2 liens » (m3 sémantique, m5 manuel), et m5 nommé dans le détail.
        let m4 = elements.first { $0.target == .memory("m4") }
        let count = model.links(of: "m4").count
        #expect(count == 2)
        #expect(m4?.label == IOSMemoryText.graphMemoryLabel(title: "titre quatre", links: count))
        #expect(m4?.label.hasSuffix(ConsoleFormat.count(count, "lien", "liens")) == true)
        #expect(m4?.linked.contains("titre cinq") == true)
        #expect(m4?.linked == ["titre trois", "titre cinq"])
        #expect(m4?.hint == IOSMemoryText.graphMemoryHint)
        #expect(m4?.id == IOSMemoryAccessibility.graphMemory("m4"))

        // m1 : ses étiquettes affichées sont nommées `#étiquette` ; m6 sans texte a un titre de repli.
        let m1 = elements.first { $0.target == .memory("m1") }
        #expect(m1?.linked.contains(MemoryText.tagLabel("commun")) == true)
        #expect(m1?.linked.contains("titre deux") == true)
        let m6 = elements.first { $0.target == .memory("m6") }
        #expect(m6?.label == IOSMemoryText.untitledMemory + ", aucun lien")
        #expect(m6?.linked == [])

        // Le nœud-étiquette « commun » compte ses souvenirs distincts (m1, m2, m3, m7).
        let commun = elements.first { $0.target == .tag("commun") }
        #expect(commun?.label == "#commun, étiquette, 4 souvenirs")
        #expect(commun?.hint == IOSMemoryText.graphTagHint)
        #expect(commun?.id == IOSMemoryAccessibility.graphTagOption("commun"))
        #expect(commun?.linked == [])

        // Chaque cadre de focus fait 44 pt et se centre sur son nœud ; l'ordre est celui de la lecture.
        for element in elements {
            #expect(element.frame.width == IOSMetrics.minimumTarget)
            #expect(element.frame.height == IOSMetrics.minimumTarget)
        }
        let m4Point = screenPoint(model, .memory("m4"))
        #expect(abs((m4?.frame.midX ?? .infinity) - m4Point.x) < 0.001)
        #expect(abs((m4?.frame.midY ?? .infinity) - m4Point.y) < 0.001)
        let rows = elements.map { $0.frame.midY.rounded() }
        #expect(rows == rows.sorted())

        // La sélection se lit sur son élément, et seulement sur lui.
        model.select("m2")
        let selected = model.accessibilityElements(size: size).filter(\.isSelected)
        #expect(selected.map(\.target) == [.memory("m2")])
    }

    @Test("ios-statistiques-et-graphe-accessibles/AC-5 : voiceOverElementsFollowZoomAndPan — un nœud sorti du cadre perd son élément et le retrouve en revenant")
    func voiceOverElementsFollowZoomAndPan() async {
        let model = IOSMemoryGraphModel(client: GraphReader())
        await model.activate()

        model.setZoom(MemoryGraphStyle.maxZoom)
        let zoomed = model.accessibilityElements(size: size)
        #expect(zoomed.count == nodesInFrame(model).count)
        guard let leaving = nodesInFrame(model).first else {
            Issue.record("aucun nœud dans le cadre au zoom maximal")
            return
        }

        // Glisser juste assez pour sortir ce nœud par la droite du canevas.
        let point = screenPoint(model, leaving)
        model.drag(by: CGSize(width: size.width - point.x + 10, height: 0))
        model.endDrag()
        let moved = model.accessibilityElements(size: size)
        #expect(!moved.contains { $0.target == target(of: leaving) })
        #expect(moved.count == nodesInFrame(model).count)
        #expect(Set(moved.map(\.id)) == Set(nodesInFrame(model).map(elementID(of:))))
        #expect(moved.count < model.visible.nodes.count)

        // Recentré, le graphe entier revient dans le cadre, et ses éléments avec lui.
        model.recenter()
        #expect(model.accessibilityElements(size: size).count == 11)
    }

    @Test("ios-statistiques-et-graphe-accessibles/AC-6 : voiceOverActivatingAMemoryOpensItsSheet — activer un souvenir ouvre sa fiche comme au toucher")
    func voiceOverActivatingAMemoryOpensItsSheet() async {
        let model = IOSMemoryGraphModel(client: GraphReader())
        await model.activate()
        guard let element = model.accessibilityElements(size: size).first(where: { $0.target == .memory("m1") }) else {
            Issue.record("aucun élément pour m1")
            return
        }

        model.activate(element.target)
        #expect(model.selection == "m1")
        // La feuille se monte sur la ligne du souvenir sélectionné (`detailBinding`).
        #expect(model.row("m1") != nil)
        #expect(model.row("m1")?.text == "titre un")
        #expect(model.accessibilityElements(size: size).first { $0.target == .memory("m1") }?.isSelected == true)

        // Le toucher emprunte la même voie : même état final.
        let touched = IOSMemoryGraphModel(client: GraphReader())
        await touched.activate()
        touched.click(at: screenPoint(touched, .memory("m1")), size: size)
        #expect(touched.selection == model.selection)
    }

    @Test("ios-statistiques-et-graphe-accessibles/AC-7 : voiceOverActivatingATagFiltersAndOffersTheWholeGraph — activer une étiquette filtre, réduit les éléments à la famille et offre le retour")
    func voiceOverActivatingATagFiltersAndOffersTheWholeGraph() async {
        let model = IOSMemoryGraphModel(client: GraphReader())
        await model.activate()

        model.activate(.tag("commun"))
        #expect(model.tagFilter == "commun")

        let family = MemoryGraph.tagFamily(
            nodes: MemoryGraphParity.facts.nodes,
            links: MemoryGraphParity.facts.links,
            tag: "commun"
        )
        let filtered = model.accessibilityElements(size: size)
        #expect(filtered.first?.target == .showAll)
        #expect(filtered.first?.label == MemoryText.allTags)
        #expect(filtered.first?.hint == IOSMemoryText.graphShowAllHint)
        #expect(filtered.first?.id == IOSMemoryAccessibility.graphShowAll)
        #expect(filtered.first?.frame == CGRect(origin: .zero, size: size))
        #expect(filtered.filter { $0.target == .showAll }.count == 1)
        let nodeTargets = filtered.dropFirst().map(\.target)
        #expect(nodeTargets.count == family.nodes.count)
        #expect(Set(filtered.dropFirst().map(\.id)) == Set(family.nodes.map { elementID(of: $0.id) }))
        #expect(filtered.first { $0.target == .tag("commun") }?.isSelected == true)

        // Le toucher du même nœud donne le même filtre.
        let touched = IOSMemoryGraphModel(client: GraphReader())
        await touched.activate()
        touched.click(at: screenPoint(touched, .tag("commun")), size: size)
        #expect(touched.tagFilter == model.tagFilter)

        // « Toutes les étiquettes » revient au graphe entier : 9 souvenirs et 2 étiquettes.
        model.activate(.showAll)
        #expect(model.tagFilter == nil)
        let whole = model.accessibilityElements(size: size)
        #expect(!whole.contains { $0.target == .showAll })
        #expect(whole.filter { if case .memory = $0.target { return true } else { return false } }.count == 9)
        #expect(whole.filter { if case .tag = $0.target { return true } else { return false } }.count == 2)
    }

    // MARK: - ios-statistiques-et-graphe-accessibles AC-9 : étiquettes sans chevauchement

    /// Un graphe à peindre : ses nœuds, ses liens et leurs positions normalisées.
    private typealias Drawn = (nodes: [MemoryGraphNode], links: [MemoryGraphLink], positions: [MemoryGraphNodeID: CGPoint])

    /// La fixture PARTAGÉE, telle que le modèle la publie après sa lecture.
    private func parityGraph() async -> Drawn {
        let model = IOSMemoryGraphModel(client: GraphReader())
        await model.activate()
        return (model.visible.nodes, model.visible.links, model.positions)
    }

    /// La fixture DENSE : 60 souvenirs répartis sur 5 portées et 8 étiquettes portées
    /// chacune par 7 ou 8 souvenirs de toutes les portées — les nœuds-étiquettes
    /// se tassent donc au centre — posés par la mise en page partagée.
    private static func denseGraph() -> Drawn {
        let rows = (0..<60).map { index in
            MemoryRow(
                id: "d\(index)",
                text: "souvenir dense numéro \(index)",
                tags: ["etiquette-\(index % 8)"],
                agentId: "projet-\(index % 5)"
            )
        }
        let nodes = MemoryGraph.nodes(rows: rows)
        let links = MemoryGraph.links(rows: rows, edges: [], manual: [])
        let points = MemoryGraphLayout.points(nodes: nodes, links: links)
        var positions: [MemoryGraphNodeID: CGPoint] = [:]
        for (index, node) in nodes.enumerated() where index < points.count {
            positions[node.id] = points[index]
        }
        return (nodes, links, positions)
    }

    /// La scène construite COMME LA VUE (`IOSMemoryGraphView.draw`), puis décollée à
    /// la taille de texte par défaut.
    private func decluttered(_ graph: Drawn, canvas: CGSize, zoom: CGFloat) -> (scene: MemoryGraphScene, result: IOSMemoryGraphDecluttered) {
        let scene = MemoryGraphScene.build(
            nodes: graph.nodes,
            links: graph.links,
            positions: graph.positions,
            viewport: MemoryGraphViewport(size: canvas, zoom: zoom, pan: .zero),
            selection: nil,
            hovered: nil
        )
        let result = IOSMemoryGraphLabels.declutter(scene, canvas: canvas) { text, font in
            IOSMemoryGraphLabels.measure(text, font: font, category: .large)
        }
        return (scene, result)
    }

    @Test("ios-statistiques-et-graphe-accessibles/AC-9 : graphLabelsNeverOverlapAtOpeningScale — aucun texte gardé n'en recouvre un autre, iPhone et iPad, zoom 1 et zoom max")
    func graphLabelsNeverOverlapAtOpeningScale() async {
        let graphs: [(name: String, graph: Drawn)] = [("parité", await parityGraph()), ("dense", Self.denseGraph())]
        let canvases = [CGSize(width: 390, height: 700), CGSize(width: 1024, height: 1100)]
        for (name, graph) in graphs {
            for canvas in canvases {
                for zoom in [1, MemoryGraphStyle.maxZoom] {
                    let frames = decluttered(graph, canvas: canvas, zoom: zoom).result.textFrames
                    #expect(!frames.isEmpty, "\(name) \(canvas) ×\(zoom) : aucun texte gardé")
                    for first in frames.indices {
                        for second in frames.indices where second > first {
                            #expect(
                                !frames[first].intersects(frames[second]),
                                "\(name) \(canvas) ×\(zoom) : \(frames[first]) recouvre \(frames[second])"
                            )
                        }
                    }
                }
            }
        }
    }

    @Test("ios-statistiques-et-graphe-accessibles/AC-9 : graphLabelsHideUntilZoom — à l'ouverture, des textes se masquent et chaque étiquette reste une capsule ou une pastille")
    func graphLabelsHideUntilZoom() {
        let graph = Self.denseGraph()
        let canvas = CGSize(width: 390, height: 700)
        let (scene, result) = decluttered(graph, canvas: canvas, zoom: 1)

        // Au moins un texte est masqué : un libellé retiré ou une capsule réduite.
        func texts(_ shapes: [MemoryGraphShape]) -> Int {
            shapes.filter {
                switch $0 {
                case .label, .capsule: return true
                case .line, .disc: return false
                }
            }.count
        }
        #expect(texts(result.shapes) < texts(scene.shapes))

        // Les liens et les disques ne sont jamais retirés.
        #expect(result.shapes.count - texts(result.shapes) == scene.shapes.count - texts(scene.shapes))

        // Chaque nœud-étiquette est SOIT une capsule gardée, SOIT une pastille, à son
        // point écran.
        let viewport = MemoryGraphViewport(size: canvas, zoom: 1, pan: .zero)
        let tagPoints = graph.nodes.compactMap { node -> CGPoint? in
            guard node.id.tagName != nil, let position = graph.positions[node.id] else { return nil }
            return viewport.screen(position)
        }
        let capsules = result.shapes.compactMap { shape -> CGPoint? in
            if case let .capsule(center, _, _) = shape { return center }
            return nil
        }
        #expect(tagPoints.count == 8)
        #expect(capsules.count + result.markers.count == tagPoints.count)
        for point in tagPoints {
            let asCapsule = capsules.contains(point)
            let asMarker = result.markers.contains(point)
            #expect(asCapsule != asMarker, "l'étiquette en \(point) doit être capsule OU pastille")
        }
    }
}
