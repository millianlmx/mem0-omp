// Les preuves Swift de la liste Mémoire PAR PAGES (memoire-ios-expire-a-10-secondes,
// S-4) : la première page, le défilement continu jusqu'au dernier souvenir, le
// dédoublonnage, l'échec d'une page suivante et son Réessayer, l'annulation d'une
// page en vol par un rechargement, et Réessayer qui relit la première page.
//
// Aucune socket : la doublure `PagingMemoryReader` sert une tranche d'un tableau
// de N lignes, comme la route `GET /v1/memory/page`, et enregistre chaque appel.

import ConsoleClient
import ConsoleCore
import Testing

@testable import OMPConsoleIOS

/// La doublure de pagination : la portée « projet », `total` = nombre de lignes,
/// `nextOffset` = `offset + rows.count` tant qu'il reste des lignes.
@MainActor
private final class PagingMemoryReader: IOSMemoryReading {
    struct Call: Equatable {
        let scope: String?
        let offset: Int
        let limit: Int?
    }

    var state: ClientState = .connected(endpoint: ClientEndpoint.manual(host: "127.0.0.1", port: 8787))
    /// Les lignes servies, dans l'ordre du service ; un test peut en insérer en tête.
    var rows: [RemoteMemoryRow]
    let pageSize = 100
    /// Les pannes à lever, une par appel, avant de servir.
    var failures: [Error] = []
    /// Le prochain appel attend `resume()` avant de servir.
    var holdNext = false
    private(set) var pending: CheckedContinuation<Void, Never>?
    private(set) var calls: [Call] = []

    init(count: Int) {
        rows = (0..<count).map(Self.row)
    }

    static func row(_ index: Int) -> RemoteMemoryRow {
        let id = "m" + String(index)
        return RemoteMemoryRow(id: id, text: id, updatedAt: nil, score: nil, tags: [], agentId: "projet")
    }

    func resume() {
        pending?.resume()
        pending = nil
    }

    func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        calls.append(Call(scope: scope, offset: offset, limit: limit))
        if holdNext {
            holdNext = false
            await withCheckedContinuation { pending = $0 }
        }
        if !failures.isEmpty { throw failures.removeFirst() }
        let start = min(offset, rows.count)
        let end = min(start + (limit ?? pageSize), rows.count)
        let slice = Array(rows[start..<end])
        let next = start + slice.count
        return RemoteMemoryPagePayload(
            scope: "projet",
            total: rows.count,
            offset: start,
            rows: slice,
            nextOffset: next < rows.count ? next : nil
        )
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        RemoteMemorySearchPayload(rows: [], candidates: 0, scored: 0)
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        RemoteMemoryGraphPayload(scope: "projet", nodes: [], links: [], total: 0)
    }
}

@MainActor
@Suite("memoire-ios-expire-a-10-secondes — la liste Mémoire par pages")
struct IOSMemoryPagingTests {
    private func ids(_ model: IOSMemoryModel) -> [String] {
        model.summary?.rows.map(\.id) ?? []
    }

    private func more(_ model: IOSMemoryModel) -> IOSMemoryMore? {
        guard case let .summary(_, _, _, more) = model.state(connection: .connected) else { return nil }
        return more
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-1 : firstPageShowsTheHeadOfTheScope — l'ouverture lit UNE page bornée, le pied annonce la suite")
    func firstPageShowsTheHeadOfTheScope() async {
        let reader = PagingMemoryReader(count: 250)
        let model = IOSMemoryModel(client: reader)

        await model.refresh()

        #expect(reader.calls == [.init(scope: nil, offset: 0, limit: nil)])
        #expect(ids(model) == (0..<100).map { "m" + String($0) })
        #expect(model.state(connection: .connected) == .summary(
            scope: "projet",
            total: 250,
            rows: (0..<100).map(PagingMemoryReader.row),
            more: .available
        ))

        // Hors `.connected`, le pied ne lit rien.
        reader.state = .unpaired
        await model.loadMore()
        #expect(reader.calls.count == 1)
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-2 : scrollingToTheEndLoadsEveryRowOnce — le défilement charge chaque souvenir une fois, jusqu'au dernier")
    func scrollingToTheEndLoadsEveryRowOnce() async {
        let reader = PagingMemoryReader(count: 250)
        let model = IOSMemoryModel(client: reader)
        await model.refresh()

        await model.loadMore()
        #expect(more(model) == .available)
        await model.loadMore()

        #expect(reader.calls == [
            .init(scope: nil, offset: 0, limit: nil),
            .init(scope: "projet", offset: 100, limit: nil),
            .init(scope: "projet", offset: 200, limit: nil),
        ])
        let shown = ids(model)
        #expect(shown == reader.rows.map(\.id))
        #expect(Set(shown).count == 250)
        #expect(model.summary?.total == 250)
        #expect(more(model) == .complete)

        // La liste est complète : un pied de plus ne lit rien.
        await model.loadMore()
        #expect(reader.calls.count == 3)

        // En recherche, le pied du sommaire ne lit rien non plus.
        let other = PagingMemoryReader(count: 250)
        let searching = IOSMemoryModel(client: other)
        await searching.refresh()
        searching.updateQuery("mémoire")
        await searching.submitQuery()
        await searching.loadMore()
        #expect(other.calls == [.init(scope: nil, offset: 0, limit: nil)])
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-2 : duplicatedRowsAreShownOnce — une page décalée par un ajout ne montre aucun doublon")
    func duplicatedRowsAreShownOnce() async {
        let reader = PagingMemoryReader(count: 250)
        let model = IOSMemoryModel(client: reader)
        await model.refresh()

        // Trois souvenirs écrits en tête entre deux pages : la suivante recommence
        // trois lignes plus tôt.
        reader.rows.insert(contentsOf: (900..<903).map(PagingMemoryReader.row), at: 0)
        await model.loadMore()
        await model.loadMore()

        let shown = ids(model)
        #expect(Set(shown).count == shown.count)
        #expect(shown == (0..<250).map { "m" + String($0) })
        #expect(model.summary?.total == 253)
        #expect(more(model) == .complete)
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-5 : nextPageFailureOffersRetry — une page suivante en délai dépassé garde les lignes et offre Réessayer (AC-2)")
    func nextPageFailureOffersRetry() async {
        let reader = PagingMemoryReader(count: 150)
        let model = IOSMemoryModel(client: reader)
        await model.refresh()

        reader.failures = [ClientError.transport(.timedOut("The request timed out."))]
        await model.loadMore()
        #expect(more(model) == .failed(message: IOSMacErrorText.message(for: .macTimedOut)))
        #expect(ids(model).count == 100)

        // Réessayer (le bouton du pied) relit la même page.
        await model.loadMore()
        #expect(reader.calls.suffix(2) == [
            .init(scope: "projet", offset: 100, limit: nil),
            .init(scope: "projet", offset: 100, limit: nil),
        ])
        #expect(ids(model) == reader.rows.map(\.id))
        #expect(more(model) == .complete)
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-4 : refreshDropsAPendingPage — un rechargement écarte la page suivante en vol")
    func refreshDropsAPendingPage() async {
        let reader = PagingMemoryReader(count: 250)
        let model = IOSMemoryModel(client: reader)
        await model.refresh()

        reader.holdNext = true
        let late = Task { await model.loadMore() }
        while reader.pending == nil { await Task.yield() }
        #expect(more(model) == .loading)

        // Un second appel concurrent ne lit rien.
        await model.loadMore()
        #expect(reader.calls.count == 2)

        await model.refresh()
        #expect(more(model) == .available)
        reader.resume()
        await late.value

        // La page tardive n'atterrit pas dans le sommaire relu.
        #expect(ids(model) == (0..<100).map { "m" + String($0) })
        #expect(more(model) == .available)
        #expect(reader.calls.count == 3)
    }

    @Test("memoire-ios-expire-a-10-secondes/AC-4 : refreshReadsTheFirstPageAgain — Réessayer trois fois relit la première page, sommaire identique")
    func refreshReadsTheFirstPageAgain() async throws {
        let reader = PagingMemoryReader(count: 250)
        let model = IOSMemoryModel(client: reader)
        let first = IOSMemorySummary(firstPage: try await reader.memoryPage(scope: nil, offset: 0, limit: nil))
        let probe = reader.calls.count

        for _ in 0..<3 {
            await model.refresh()
            #expect(model.summary == first)
        }
        #expect(Array(reader.calls.dropFirst(probe)) == Array(repeating: .init(scope: nil, offset: 0, limit: nil), count: 3))

        // Un rechargement après défilement remplace TOUT le sommaire accumulé.
        await model.loadMore()
        #expect(ids(model).count == 200)
        await model.refresh()
        #expect(model.summary == first)
    }
}
