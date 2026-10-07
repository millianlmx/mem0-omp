// Les preuves Swift du modèle de l'écran Mémoire de l'app iOS (BR-2) : les états
// dérivés des huit `ClientState`, la classification des erreurs, les trois « rien
// trouvé » distincts, le retour au sommaire sans requête, et le geste de
// rafraîchissement qui suit la panne.
//
// Aucune socket n'est ouverte : la doublure `CountingMemoryReader` compte les
// lectures et rend ce que le Mac servirait.

import ConsoleClient
import ConsoleCore
import Testing

@testable import OMPConsoleIOS

/// La doublure de lecture : l'état du client et les DEUX lectures, comptées.
@MainActor
private final class CountingMemoryReader: IOSMemoryReading {
    var state: ClientState = .connected(endpoint: ClientEndpoint.manual(host: "127.0.0.1", port: 8787))
    var page: Result<RemoteMemoryPagePayload, Error>
    var search: Result<RemoteMemorySearchPayload, Error>
    private(set) var pageReads = 0
    private(set) var searchReads = 0

    init(
        page: Result<RemoteMemoryPagePayload, Error> = .success(
            RemoteMemoryPagePayload(scope: "projet", total: 0, rows: [], truncated: false)
        ),
        search: Result<RemoteMemorySearchPayload, Error> = .success(
            RemoteMemorySearchPayload(rows: [], candidates: 0, scored: 0)
        )
    ) {
        self.page = page
        self.search = search
    }

    func memory(scope: String?, limit: Int?) async throws -> RemoteMemoryPagePayload {
        pageReads += 1
        return try page.get()
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        searchReads += 1
        return try search.get()
    }
}

@MainActor
@Suite("ios-memoire — le modèle de l'écran")
struct IOSMemoryModelTests {
    private let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: 8787)
    private var connected: ClientState { .connected(endpoint: endpoint) }

    private var allStates: [ClientState] {
        [
            .unpaired,
            .searching,
            .connecting(endpoint: endpoint),
            .connected(endpoint: endpoint),
            .noNetwork,
            .macAbsent(endpoint: endpoint),
            .revoked,
            .incompatibleProtocol(local: 3, remote: 2),
        ]
    }

    private func row(_ id: String, text: String, score: Double? = nil, tags: [String] = []) -> RemoteMemoryRow {
        RemoteMemoryRow(id: id, text: text, updatedAt: nil, score: score, tags: tags, agentId: "projet")
    }

    // MARK: - AC-7

    @Test("ios-memoire/AC-7 : une portée nulle est « aucun projet », une portée servie est le sommaire")
    func memoryFollowsTheClientTheScopeAndTheLoad() {
        let empty = RemoteMemoryPagePayload(scope: nil, total: 0, rows: [], truncated: false)
        #expect(IOSMemoryModel.screen(client: connected, load: .page(empty), mode: .summary) == .noProject)
        // Même en mode recherche : la portée nulle reste « aucun projet ».
        #expect(IOSMemoryModel.screen(client: connected, load: .page(empty), mode: .search("x")) == .noProject)

        let rows = [row("m1", text: "un"), row("m2", text: "deux")]
        let page = RemoteMemoryPagePayload(scope: "projet", total: 2, rows: rows, truncated: false)
        #expect(IOSMemoryModel.screen(client: connected, load: .page(page), mode: .summary)
            == .summary(scope: "projet", total: 2, rows: rows, truncated: false))

        let truncated = RemoteMemoryPagePayload(scope: "projet", total: 900, rows: rows, truncated: true)
        #expect(IOSMemoryModel.screen(client: connected, load: .page(truncated), mode: .summary)
            == .summary(scope: "projet", total: 900, rows: rows, truncated: true))

        let none = RemoteMemoryPagePayload(scope: "projet", total: 0, rows: [], truncated: false)
        #expect(IOSMemoryModel.screen(client: connected, load: .page(none), mode: .summary)
            == .summaryEmpty(scope: "projet"))
    }

    // MARK: - AC-8

    @Test("ios-memoire/AC-8 : l'état du client parle quand rien n'est lu, jamais une cause mémoire inventée")
    func theClientStateExplainsWhateverIsNotLoaded() {
        for state in allStates where state != connected {
            #expect(IOSMemoryModel.screen(client: state, load: .idle, mode: .summary) == .clientState(state))
            #expect(!IOSMemoryModel.gesturesEnabled(state))
        }
        #expect(IOSMemoryModel.gesturesEnabled(connected))
        // Connecté, rien de lu : un chargement, jamais un vide muet.
        #expect(IOSMemoryModel.screen(client: connected, load: .idle, mode: .summary) == .loading)

        // Les quatre erreurs de TRANSPORT ⇒ macUnreachable, jamais unavailable.
        let transportFailures: [ClientError] = [
            .notConnected,
            .transport(.unreachable("connexion refusée")),
            .incompatibleProtocol(local: 3, remote: 2),
            .decoding("corps illisible"),
        ]
        for failure in transportFailures {
            #expect(IOSMemoryModel.load(from: failure) == .macUnreachable)
            #expect(IOSMemoryModel.screen(client: connected, load: .macUnreachable, mode: .summary) == .macUnreachable)
        }

        // Une donnée DÉJÀ chargée n'est jamais effacée par une bascule du client.
        let rows = [row("m1", text: "un")]
        let page = RemoteMemoryPagePayload(scope: "projet", total: 1, rows: rows, truncated: false)
        #expect(IOSMemoryModel.screen(client: .unpaired, load: .page(page), mode: .summary)
            == .summary(scope: "projet", total: 1, rows: rows, truncated: false))
    }

    // MARK: - AC-6

    @Test("ios-memoire/AC-6 : la mémoire injoignable porte l'adresse sondée et le dernier message")
    func memoryUnavailableCarriesTheRelayedDetail() {
        // L'adresse relayée par le Mac est reprise TELLE QUELLE : la coque la compose
        // par `MemoryText.unavailableDetail` (le test CLT éprouve la valeur réelle).
        let detail = MemoryText.unavailableDetail(address: "127.0.0.1:8321", error: "connexion refusée")
        #expect(IOSMemoryModel.load(from: ClientError.api(.unavailable(detail))) == .memoryUnavailable(detail))
        #expect(IOSMemoryModel.screen(client: connected, load: .memoryUnavailable(detail), mode: .summary)
            == .unavailable(detail: detail))
        #expect(IOSMemoryModel.screen(client: connected, load: .memoryUnavailable(detail), mode: .search("x"))
            == .unavailable(detail: detail))
        // Un 401 sans message ⇒ le mot de repli, jamais une phrase vide.
        #expect(IOSMemoryModel.screen(client: connected, load: .memoryUnavailable(""), mode: .summary)
            == .unavailable(detail: IOSMemoryText.noData))
        // Le bandeau porte le titre partagé PUIS le détail relayé.
        #expect(IOSMemoryText.unavailable(detail: detail) == MemoryText.unavailableTitle + "\n" + detail)
        #expect(MemoryText.unavailableTitle == "Mémoire indisponible")
    }

    // MARK: - AC-5

    @Test("ios-memoire/AC-5 : les trois « rien trouvé » sont distincts, jamais le sommaire")
    func searchEmptiesAreThreeDistinctWords() {
        let mode = IOSMemoryMode.search("terme")
        func screen(candidates: Int, scored: Int, rows: [RemoteMemoryRow]) -> IOSMemoryScreenState {
            IOSMemoryModel.screen(
                client: connected,
                load: .search(RemoteMemorySearchPayload(rows: rows, candidates: candidates, scored: scored)),
                mode: mode
            )
        }
        // (1) Aucun candidat au-dessus du pool du service.
        #expect(screen(candidates: 0, scored: 0, rows: []) == .searchEmptyNoMatch)
        // (2) Des candidats, mais le service ne sait pas les classer.
        #expect(screen(candidates: 3, scored: 0, rows: []) == .searchEmptyNoScore)
        // (3) Des candidats classés, tous sous le plancher.
        #expect(screen(candidates: 3, scored: 2, rows: []) == .searchEmptyBelowThreshold)
        // Les trois mots sont distincts, et aucun n'est un état de sommaire.
        #expect(MemoryText.noMatch != MemoryText.noSemanticScore)
        #expect(MemoryText.noResultTitle != MemoryText.searchUnsupportedTitle)
        // Une sélection non vide rend les lignes, dans l'ordre reçu.
        let rows = [row("m3", text: "trois", score: 0.9), row("m2", text: "deux", score: 0.7)]
        #expect(screen(candidates: 4, scored: 3, rows: rows) == .search(query: "terme", rows: rows))
    }

    // MARK: - AC-3

    @Test("ios-memoire/AC-3 : vider la requête revient au sommaire déjà lu, sans aucune requête")
    func blankQueryReturnsToTheCachedSummary() async {
        let rows = [row("m1", text: "un")]
        let page = RemoteMemoryPagePayload(scope: "projet", total: 1, rows: rows, truncated: false)
        let reader = CountingMemoryReader(page: .success(page))
        let model = IOSMemoryModel(client: reader)

        await model.refresh()
        #expect(reader.pageReads == 1)
        #expect(model.state == .summary(scope: "projet", total: 1, rows: rows, truncated: false))

        model.updateQuery("mémoire du projet")
        await model.submitQuery()
        #expect(reader.searchReads == 1)
        #expect(model.isSearching)

        // (1) Vider le champ (blancs) revient au sommaire DÉJÀ lu.
        model.updateQuery("   ")
        #expect(!model.isSearching)
        #expect(model.summary == page)
        #expect(model.state == .summary(scope: "projet", total: 1, rows: rows, truncated: false))
        // AUCUNE lecture ajoutée, ni sommaire ni recherche.
        #expect(reader.pageReads == 1)
        #expect(reader.searchReads == 1)

        // (2) Le bouton « Sommaire » fait de même, sans requête.
        model.updateQuery("autre")
        await model.submitQuery()
        #expect(reader.searchReads == 2)
        model.showSummary()
        #expect(!model.isSearching)
        #expect(model.state == .summary(scope: "projet", total: 1, rows: rows, truncated: false))
        #expect(reader.pageReads == 1)
        #expect(reader.searchReads == 2)

        // (3) Une requête blanche validée n'émet RIEN et laisse le sommaire.
        model.updateQuery("  ")
        await model.submitQuery()
        #expect(reader.searchReads == 2)
        #expect(!model.isSearching)
    }

    // MARK: - AC-9

    @Test("ios-memoire/AC-9 : un geste émet UNE lecture, et une panne après un succès bascule l'état")
    func gestureRefreshReloadsOnceAndFollowsTheFailure() async {
        let rows = [row("m1", text: "un")]
        let page = RemoteMemoryPagePayload(scope: "projet", total: 1, rows: rows, truncated: false)
        let reader = CountingMemoryReader(page: .success(page))
        let model = IOSMemoryModel(client: reader)

        await model.refresh()
        #expect(reader.pageReads == 1)
        #expect(model.state == .summary(scope: "projet", total: 1, rows: rows, truncated: false))

        // La pile mémoire tombe ensuite : le geste relaie la panne avec sa cause.
        let detail = MemoryText.unavailableDetail(address: "http://127.0.0.1:8321", error: "connexion refusée")
        reader.page = .failure(ClientError.api(.unavailable(detail)))
        await model.refresh()
        #expect(reader.pageReads == 2)
        #expect(model.state == .unavailable(detail: detail))
        #expect(!model.isLoading)

        // La mémoire revient : le MÊME geste repasse au sommaire.
        reader.page = .success(page)
        await model.refresh()
        #expect(reader.pageReads == 3)
        #expect(model.state == .summary(scope: "projet", total: 1, rows: rows, truncated: false))

        // Un client qui ne joint plus le Mac n'émet AUCUNE lecture.
        reader.state = .unpaired
        await model.refresh()
        #expect(reader.pageReads == 3)
    }
}
