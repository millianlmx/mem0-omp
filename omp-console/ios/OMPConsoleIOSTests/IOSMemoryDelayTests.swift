// Les preuves Swift des messages d'échec de la Mémoire iOS
// (memoire-ios-expire-a-10-secondes, S-3, S-5, S-6) : « délai dépassé » ≠ « Mac
// injoignable » dans la liste et le graphe, « app Mac trop ancienne » face à une
// coque qui ignore la route de page, « aucun projet » pour un graphe sans portée,
// et les AUTRES sections qui gardent leur libellé d'avant sur un délai dépassé.
//
// Aucune socket : les pannes sont des `ClientError` déjà traduits, injectés par
// les coutures de chaque section (`IOSMemoryReading`, `IOSSessionSource`).

import ConsoleClient
import ConsoleCore
import Testing

@testable import OMPConsoleIOS

/// La doublure de la Mémoire : la page et le graphe rendent ce que le test pose.
@MainActor
private final class FailingMemoryReader: IOSMemoryReading {
    var state: ClientState = .connected(endpoint: ClientEndpoint.manual(host: "127.0.0.1", port: 8787))
    var page: Result<RemoteMemoryPagePayload, Error>
    var graph: Result<RemoteMemoryGraphPayload, Error>

    init(
        page: Result<RemoteMemoryPagePayload, Error> = .success(
            RemoteMemoryPagePayload(scope: "projet", total: 0, offset: 0, rows: [], nextOffset: nil)
        ),
        graph: Result<RemoteMemoryGraphPayload, Error> = .success(IOSMemoryGraphRecipe.graphe.payload)
    ) {
        self.page = page
        self.graph = graph
    }

    func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        try page.get()
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        RemoteMemorySearchPayload(rows: [], candidates: 0, scored: 0)
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        try graph.get()
    }
}

/// La doublure du fil de session (patron `SessionStubSource`) : chaque lecture
/// échoue sur la panne posée.
@MainActor
private final class FailingSessionSource: IOSSessionSource {
    let failure: Error

    init(failure: Error) {
        self.failure = failure
    }

    func read(file: String) async throws -> RemoteSessionPayload {
        throw failure
    }

    func feed(forFile file: String) -> AsyncStream<RemoteSessionFeedItem> {
        AsyncStream { $0.finish() }
    }

    func run(forFile file: String) -> RunChoice? { nil }

    var macHomeDirectory: String? { nil }
}

@MainActor
@Suite("memoire-ios-expire-a-10-secondes — délai dépassé, Mac injoignable, Mac trop ancien")
struct IOSMemoryDelayTests {
    private let connected = ClientState.connected(endpoint: ClientEndpoint.manual(host: "127.0.0.1", port: 8787))

    @Test("memoire-ios-expire-a-10-secondes/AC-5 : listTimeoutSaysDelayExceeded — un délai dépassé de la liste dit « Délai dépassé » et offre Réessayer")
    func listTimeoutSaysDelayExceeded() async {
        let timedOut = ClientError.transport(.timedOut("The request timed out."))
        #expect(IOSMemoryModel.load(from: timedOut) == .failed(.macTimedOut))
        #expect(IOSMemoryModel.screen(connection: .connected, load: .failed(.macTimedOut), mode: .summary, summary: nil) == .failed(.macTimedOut))
        let text = IOSMacErrorText.message(for: .macTimedOut)
        #expect(IOSMemoryModel.failureMessage(.failed(.macTimedOut)) == text)
        #expect(text.contains("Délai dépassé"))
        #expect(text != IOSMacErrorText.message(for: .macUnreachable))
        #expect(!text.contains("injoignable"))

        // Bout en bout par le modèle : l'écran est « délai dépassé », et Réessayer
        // (le même `refresh`) relit puis affiche le sommaire.
        let reader = FailingMemoryReader(page: .failure(timedOut))
        let model = IOSMemoryModel(client: reader)
        await model.refresh()
        #expect(model.state(connection: .connected) == .failed(.macTimedOut))
        #expect(model.canRefresh)
        let rows = [RemoteMemoryRow(id: "m1", text: "un", updatedAt: nil, score: nil, tags: [], agentId: "projet")]
        reader.page = .success(RemoteMemoryPagePayload(scope: "projet", total: 1, offset: 0, rows: rows, nextOffset: nil))
        await model.refresh()
        #expect(model.state(connection: .connected) == .summary(scope: "projet", total: 1, rows: rows, more: .complete))
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-6 : unreachableNeverSaysDelay — un Mac injoignable dit « Mac injoignable », jamais « Délai »")
    func unreachableNeverSaysDelay() async {
        let failures: [ClientError] = [
            .transport(.unreachable("Could not connect to the server.")),
            .notConnected,
            .transport(.closed("connexion fermée")),
        ]
        for failure in failures {
            #expect(IOSMemoryModel.load(from: failure) == .failed(.macUnreachable))
            #expect(IOSMemoryGraphModel.failure(from: failure) == .failed(.macUnreachable))
        }
        #expect(IOSMemoryModel.screen(connection: .connected, load: .failed(.macUnreachable), mode: .summary, summary: nil) == .failed(.macUnreachable))
        let text = IOSMacErrorText.message(for: .macUnreachable)
        #expect(IOSMemoryModel.failureMessage(.failed(.macUnreachable)) == text)
        #expect(text.contains("Mac injoignable"))
        #expect(!text.contains("Délai"))

        let model = IOSMemoryModel(client: FailingMemoryReader(page: .failure(failures[0])))
        await model.refresh()
        #expect(model.state(connection: .connected) == .failed(.macUnreachable))
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-9 : listOnOlderMacSaysMacOutdated — une app Mac sans route de page dit « app Mac trop ancienne », sans erreur brute")
    func listOnOlderMacSaysMacOutdated() async {
        let notFound = ClientError.api(.notFound("route inconnue"))
        #expect(IOSMemoryModel.load(from: notFound) == .failed(.macOutdated))
        #expect(IOSMemoryModel.screen(connection: .connected, load: .failed(.macOutdated), mode: .summary, summary: nil) == .failed(.macOutdated))
        let text = IOSMacErrorText.message(for: .macOutdated)
        #expect(IOSMemoryModel.failureMessage(.failed(.macOutdated)) == text)

        let model = IOSMemoryModel(client: FailingMemoryReader(page: .failure(notFound)))
        await model.refresh()
        #expect(model.state(connection: .connected) == .failed(.macOutdated))

        #expect(text.contains("app Mac trop ancienne"))
        for raw in ["://", "{", "404", "route inconnue"] {
            #expect(!text.contains(raw))
        }
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-5 : graphTimeoutSaysDelayExceeded — un délai dépassé du graphe dit « Délai dépassé », distinct de « Mac injoignable »")
    func graphTimeoutSaysDelayExceeded() async {
        let timedOut = ClientError.transport(.timedOut("The request timed out."))
        #expect(IOSMemoryGraphModel.failure(from: timedOut) == .failed(.macTimedOut))
        #expect(IOSMemoryGraphModel.failure(from: ClientError.transport(.unreachable("refus"))) == .failed(.macUnreachable))

        let reader = FailingMemoryReader(graph: .failure(timedOut))
        let graph = IOSMemoryGraphModel(client: reader)
        await graph.activate()
        #expect(graph.state == .failed(.macTimedOut))

        // Réessayer relit et affiche le graphe.
        reader.graph = .success(IOSMemoryGraphRecipe.graphe.payload)
        await graph.refresh()
        guard case .graph = graph.state else {
            Issue.record("le graphe n'est pas affiché après Réessayer : \(graph.state)")
            return
        }
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-3 : graphWithoutProjectSaysNoProject — un graphe sans portée résolue est « aucun projet », jamais un canevas")
    func graphWithoutProjectSaysNoProject() async {
        var payload = IOSMemoryGraphRecipe.graphe.payload
        #expect(payload.scope != nil)
        payload.scope = nil
        let graph = IOSMemoryGraphModel(client: FailingMemoryReader(graph: .success(payload)))
        await graph.activate()
        #expect(graph.state == .noProject)
        #expect(graph.visible.nodes.isEmpty)

        // Une portée servie : un nœud pour chaque souvenir de la charge, aucun de plus.
        let served = IOSMemoryGraphRecipe.graphe.payload
        let scoped = IOSMemoryGraphModel(client: FailingMemoryReader(graph: .success(served)))
        await scoped.activate()
        let memories = scoped.visible.nodes.filter { $0.id.memoryId != nil }
        let wireMemories = served.nodes.filter { MemoryGraphWire.nodeID($0.id)?.memoryId != nil }
        #expect(!memories.isEmpty)
        #expect(memories.count == wireMemories.count)
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-7 : otherSectionsKeepTheirTransportWording — hors Mémoire, un délai dépassé se lit exactement comme avant")
    func otherSectionsKeepTheirTransportWording() async {
        let timedOut = ClientError.transport(.timedOut("r"))
        let unreachable = ClientError.transport(.unreachable("r"))

        #expect(IOSHomeContent.failure(timedOut) == IOSHomeContent.failure(unreachable))
        // Le traducteur partagé (Pipelines, Sessions, Statistiques, Nouvelle feature) :
        // hors de son entrée Mémoire, un délai dépassé est un Mac injoignable.
        #expect(IOSMacFailure.of(timedOut) == .macUnreachable)
        #expect(IOSMacErrorText.message(for: timedOut) == IOSMacErrorText.message(for: unreachable))
        #expect(ProjectText.failure(timedOut, state: connected) == ProjectText.failure(unreachable, state: connected))
        #expect(IOSStatsText.failure(timedOut) == IOSStatsText.failure(unreachable))
        #expect(ConnectionText.pairError(timedOut) == ConnectionText.pairError(unreachable))
        #expect(ConnectionText.pairingFailure(.transport(.timedOut("r")))
            == ConnectionText.pairingFailure(.transport(.unreachable("r"))))

        // Les mots d'avant, inchangés.
        #expect(IOSHomeText.transportFailure == "Le Mac n'a pas répondu.")

        // Le bandeau du fil de session : le même dans les deux cas.
        var banners: [String?] = []
        for failure in [timedOut, unreachable] {
            let thread = IOSSessionThreadModel(
                source: FailingSessionSource(failure: failure),
                file: "s.jsonl",
                title: "t",
                subtitle: nil,
                tracksRun: false
            )
            await thread.read()
            banners.append(thread.errorBanner)
        }
        let unreachableBanner = IOSMacErrorText.message(for: .macUnreachable)
        #expect(banners == [unreachableBanner, unreachableBanner])
    }
}
