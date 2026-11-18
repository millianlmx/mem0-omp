// La Mémoire iOS face à un délai dépassé et à une annulation (lenteurs-et-timeouts-du-chargement-sur-i,
// AC-11 b) : « délai dépassé » est annoncé tel quel, le sommaire déjà lu reste celui du modèle et Réessayer
// le relit ; une lecture annulée par un nouveau geste n'est jamais annoncée.
//
// Aucune socket : la doublure rend ce que le test pose, comme URLSession le ferait à l'expiration.

import ConsoleClient
import Testing

@testable import OMPConsoleIOS

@MainActor
private final class TimingOutMemoryReader: IOSMemoryReading {
    var isConfigured = true
    /// Une issue par lecture de page, dans l'ordre.
    var outcomes: [Result<RemoteMemoryPagePayload, Error>] = []
    /// La prochaine lecture attend (jusqu'à son annulation) avant de rendre son issue.
    var holdsNext = false
    private(set) var isHeld = false

    func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        if holdsNext {
            holdsNext = false
            isHeld = true
            try await Task.sleep(for: .seconds(60))
        }
        return try outcomes.removeFirst().get()
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        RemoteMemorySearchPayload(rows: [], candidates: 0, scored: 0)
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        RemoteMemoryGraphPayload(scope: "projet", nodes: [], links: [], total: 0)
    }
}

@MainActor
@Suite("Mémoire iOS — délai dépassé et annulation")
struct IOSDelaiMemoireTests {
    private let rows = [RemoteMemoryRow(id: "m1", text: "un", updatedAt: nil, score: nil, tags: [], agentId: "projet")]

    private var page: RemoteMemoryPagePayload {
        RemoteMemoryPagePayload(scope: "projet", total: 1, offset: 0, rows: rows, nextOffset: nil)
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-11 : un délai dépassé de la Mémoire est annoncé tel quel, le sommaire lu reste celui du modèle et Réessayer le relit")
    func timeoutIsAnnouncedAndTheSummaryKept() async {
        let reader = TimingOutMemoryReader()
        reader.outcomes = [.success(page), .failure(MemoryReadError.timedOut), .success(page)]
        let model = IOSMemoryModel(client: reader)
        await model.refresh()

        await model.refresh()
        #expect(model.state(connection: .connected) == .failed(.timedOut))
        #expect(IOSMemoryErrorText.message(for: .timedOut) != IOSMemoryErrorText.message(for: .unreachable))
        #expect(model.summary?.rows == rows)
        #expect(model.canRefresh)

        await model.refresh()
        #expect(model.state(connection: .connected) == .summary(scope: "projet", total: 1, rows: rows, more: .complete))
    }

    @Test("lenteurs-et-timeouts-du-chargement-sur-i/AC-11 : une lecture de la Mémoire annulée par un nouveau geste n'est jamais annoncée")
    func cancellationIsNeverAnnounced() async {
        let reader = TimingOutMemoryReader()
        reader.outcomes = [.success(page), .success(page)]
        let model = IOSMemoryModel(client: reader)
        await model.refresh()

        reader.holdsNext = true
        let stale = Task { await model.refresh() }
        while !reader.isHeld { await Task.yield() }
        await model.refresh()
        await stale.value

        #expect(model.state(connection: .connected) == .summary(scope: "projet", total: 1, rows: rows, more: .complete))
    }
}
