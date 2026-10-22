// Les preuves Swift des messages d'échec de la Mémoire iOS
// (memoire-ios-expire-a-10-secondes, S-3, S-5, S-6) : « délai dépassé » ≠ « serveur
// injoignable » dans la liste et le graphe, et « aucun projet » pour un graphe sans
// portée.
//
// Aucune socket : les pannes sont des `MemoryReadError`, injectées par la couture
// de la Mémoire (`IOSMemoryReading`).

import ConsoleClient
import ConsoleCore
import Testing

@testable import OMPConsoleIOS

/// La doublure de la Mémoire : la page et le graphe rendent ce que le test pose.
@MainActor
private final class FailingMemoryReader: IOSMemoryReading {
    var isConfigured = true
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

@MainActor
@Suite("memoire-ios-expire-a-10-secondes — délai dépassé, serveur injoignable")
struct IOSMemoryDelayTests {
    @Test("memoire-ios-expire-a-10-secondes/AC-5 : listTimeoutSaysDelayExceeded — un délai dépassé de la liste dit « Délai dépassé » et offre Réessayer")
    func listTimeoutSaysDelayExceeded() async {
        let timedOut = MemoryReadError.timedOut
        #expect(IOSMemoryModel.load(from: timedOut) == .failed(.timedOut))
        #expect(IOSMemoryModel.screen(connection: .connected, load: .failed(.timedOut), mode: .summary, summary: nil) == .failed(.timedOut))
        let text = IOSMemoryErrorText.message(for: .timedOut)
        #expect(IOSMemoryModel.failureMessage(.failed(.timedOut)) == text)
        #expect(text.contains("Délai dépassé"))
        #expect(text != IOSMemoryErrorText.message(for: .unreachable))
        #expect(!text.contains("injoignable"))

        // Bout en bout par le modèle : l'écran est « délai dépassé », et Réessayer
        // (le même `refresh`) relit puis affiche le sommaire.
        let reader = FailingMemoryReader(page: .failure(timedOut))
        let model = IOSMemoryModel(client: reader)
        await model.refresh()
        #expect(model.state(connection: .connected) == .failed(.timedOut))
        #expect(model.canRefresh)
        let rows = [RemoteMemoryRow(id: "m1", text: "un", updatedAt: nil, score: nil, tags: [], agentId: "projet")]
        reader.page = .success(RemoteMemoryPagePayload(scope: "projet", total: 1, offset: 0, rows: rows, nextOffset: nil))
        await model.refresh()
        #expect(model.state(connection: .connected) == .summary(scope: "projet", total: 1, rows: rows, more: .complete))
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-6 : unreachableNeverSaysDelay — un serveur injoignable le dit, jamais « Délai »")
    func unreachableNeverSaysDelay() async {
        let failure = MemoryReadError.unreachable
        #expect(IOSMemoryModel.load(from: failure) == .failed(.unreachable))
        #expect(IOSMemoryGraphModel.failure(from: failure) == .failed(.unreachable))
        #expect(IOSMemoryModel.screen(connection: .connected, load: .failed(.unreachable), mode: .summary, summary: nil) == .failed(.unreachable))
        let text = IOSMemoryErrorText.message(for: .unreachable)
        #expect(IOSMemoryModel.failureMessage(.failed(.unreachable)) == text)
        #expect(text.contains("injoignable"))
        #expect(!text.contains("Délai"))

        let model = IOSMemoryModel(client: FailingMemoryReader(page: .failure(failure)))
        await model.refresh()
        #expect(model.state(connection: .connected) == .failed(.unreachable))
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-5 : graphTimeoutSaysDelayExceeded — un délai dépassé du graphe dit « Délai dépassé », distinct de « serveur injoignable »")
    func graphTimeoutSaysDelayExceeded() async {
        let timedOut = MemoryReadError.timedOut
        #expect(IOSMemoryGraphModel.failure(from: timedOut) == .failed(.timedOut))
        #expect(IOSMemoryGraphModel.failure(from: MemoryReadError.unreachable) == .failed(.unreachable))

        let reader = FailingMemoryReader(graph: .failure(timedOut))
        let graph = IOSMemoryGraphModel(client: reader)
        await graph.activate()
        #expect(graph.state == .failed(.timedOut))

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
}
