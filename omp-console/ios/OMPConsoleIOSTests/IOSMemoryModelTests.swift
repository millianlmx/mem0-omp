// Les preuves Swift du modèle de l'écran Mémoire de l'app iOS (BR-2) : les états
// dérivés du statut de connexion et de la lecture, la classification des erreurs, les trois « rien
// trouvé » distincts, le retour au sommaire sans requête, et le geste de
// rafraîchissement qui suit la panne.
//
// Aucune socket n'est ouverte : la doublure `CountingMemoryReader` compte les
// lectures et rend ce que le Mac servirait.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

/// La doublure de lecture : l'état du client et les DEUX lectures, comptées.
@MainActor
private final class CountingMemoryReader: IOSMemoryReading {
    var state: ClientState = .connected(endpoint: ClientEndpoint.manual(host: "127.0.0.1", port: 8787))
    var page: Result<RemoteMemoryPagePayload, Error>
    var search: Result<RemoteMemorySearchPayload, Error>
    var graph: Result<RemoteMemoryGraphPayload, Error>
    private(set) var pageReads = 0
    private(set) var searchReads = 0
    private(set) var graphReads = 0

    init(
        page: Result<RemoteMemoryPagePayload, Error> = .success(
            RemoteMemoryPagePayload(scope: "projet", total: 0, offset: 0, rows: [], nextOffset: nil)
        ),
        search: Result<RemoteMemorySearchPayload, Error> = .success(
            RemoteMemorySearchPayload(rows: [], candidates: 0, scored: 0)
        ),
        graph: Result<RemoteMemoryGraphPayload, Error> = .success(
            RemoteMemoryGraphPayload(scope: "projet", nodes: [], links: [], total: 0, truncated: false)
        )
    ) {
        self.page = page
        self.search = search
        self.graph = graph
    }

    func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        pageReads += 1
        return try page.get()
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        searchReads += 1
        return try search.get()
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        graphReads += 1
        return try graph.get()
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
        let empty = IOSMemorySummary(firstPage: RemoteMemoryPagePayload(scope: nil, total: 0, offset: 0, rows: [], nextOffset: nil))
        #expect(Self.connectedScreen(.page(empty), .summary) == .noProject)
        // Même en mode recherche : la portée nulle reste « aucun projet ».
        #expect(Self.connectedScreen(.page(empty), .search("x")) == .noProject)

        let rows = [row("m1", text: "un"), row("m2", text: "deux")]
        let page = IOSMemorySummary(firstPage: RemoteMemoryPagePayload(scope: "projet", total: 2, offset: 0, rows: rows, nextOffset: nil))
        #expect(Self.connectedScreen(.page(page), .summary)
            == .summary(scope: "projet", total: 2, rows: rows, more: .complete))

        // Une première page d'une portée plus longue : le pied annonce la suite.
        let head = IOSMemorySummary(firstPage: RemoteMemoryPagePayload(scope: "projet", total: 900, offset: 0, rows: rows, nextOffset: 2))
        #expect(Self.connectedScreen(.page(head), .summary)
            == .summary(scope: "projet", total: 900, rows: rows, more: .available))

        let none = IOSMemorySummary(firstPage: RemoteMemoryPagePayload(scope: "projet", total: 0, offset: 0, rows: [], nextOffset: nil))
        #expect(Self.connectedScreen(.page(none), .summary)
            == .summaryEmpty(scope: "projet"))
    }

    /// La surface pure, Mac connecté, sans sommaire déjà servi.
    private static func connectedScreen(_ load: IOSMemoryLoad, _ mode: IOSMemoryMode) -> IOSMemoryScreenState {
        IOSMemoryModel.screen(connection: .connected, load: load, mode: mode, summary: nil)
    }

    // MARK: - AC-8

    @Test("ios-memoire/AC-8 : seul .connected lit, et une panne de transport n'invente jamais de cause mémoire")
    func transportFailuresNeverInventAMemoryCause() {
        for state in allStates where state != connected {
            #expect(!IOSMemoryModel.gesturesEnabled(state))
        }
        #expect(IOSMemoryModel.gesturesEnabled(connected))
        // Connecté, rien de lu : un chargement, jamais un vide muet.
        #expect(Self.connectedScreen(.idle, .summary) == .loading)

        // Les erreurs de TRANSPORT ⇒ « Mac injoignable » (cause du traducteur partagé),
        // jamais une panne mémoire.
        let transportFailures: [ClientError] = [
            .notConnected,
            .transport(.unreachable("connexion refusée")),
            .transport(.closed("coupé")),
        ]
        for failure in transportFailures {
            #expect(IOSMemoryModel.load(from: failure) == .failed(.macUnreachable))
            #expect(Self.connectedScreen(.failed(.macUnreachable), .summary)
                == .failed(.macUnreachable))
        }
    }

    // MARK: - etats-non-connecte-heterogenes-ios

    @Test("etats-non-connecte-heterogenes-ios/AC-1 : non connectée et rien de chargé → le composant d'état de connexion")
    func offlineWithoutDataIsTheConnectionComponent() {
        let statuses: [IOSConnectionStatus] = [.connecting, .disconnected(.unreachable), .disconnected(.unpaired), .disconnected(.refused)]
        for status in statuses {
            // Rien lu, une lecture en vol, une panne : aucune donnée, aucun sommaire.
            for load: IOSMemoryLoad in [.idle, .loading, .failed(.macUnreachable), .failed(.serviceUnavailable)] {
                #expect(IOSMemoryModel.screen(connection: status, load: load, mode: .summary, summary: nil) == .offline(status))
            }
        }
        // Le graphe : rien de reçu ⇒ plein écran ; reçu (même vide) ⇒ gardé.
        for state: IOSMemoryGraphModel.State in [.idle, .loading, .noProject, .serviceOutdated, .macOutdated, .failed(.macUnreachable), .failed(.macTimedOut)] {
            #expect(!IOSMemoryGraphModel.hasData(state))
        }
        #expect(IOSMemoryGraphModel.hasData(.empty))
        #expect(IOSMemoryGraphModel.hasData(.graph(nodes: [], links: [], positions: [:], truncated: false)))
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-4 : hors connexion, la lecture reçue ou le sommaire déjà servi restent affichés")
    func offlineKeepsTheLastData() {
        let rows = [row("m1", text: "un")]
        let page = IOSMemorySummary(firstPage: RemoteMemoryPagePayload(scope: "projet", total: 1, offset: 0, rows: rows, nextOffset: nil))
        let summary = IOSMemoryScreenState.summary(scope: "projet", total: 1, rows: rows, more: .complete)
        let found = [row("m2", text: "deux", score: 0.9)]
        let search = RemoteMemorySearchPayload(rows: found, candidates: 3, scored: 3)
        for status: IOSConnectionStatus in [.connecting, .disconnected(.unreachable), .disconnected(.refused)] {
            // La page reçue reste affichée.
            #expect(IOSMemoryModel.screen(connection: status, load: .page(page), mode: .summary, summary: page) == summary)
            // La recherche reçue reste affichée.
            #expect(IOSMemoryModel.screen(connection: status, load: .search(search), mode: .search("deux"), summary: page)
                == .search(query: "deux", rows: found))
            // Une recherche coupée en vol (ou en panne) rend le sommaire déjà servi.
            for load: IOSMemoryLoad in [.idle, .loading, .failed(.macUnreachable), .failed(.serviceUnavailable)] {
                #expect(IOSMemoryModel.screen(connection: status, load: load, mode: .search("deux"), summary: page) == summary)
            }
        }
        // Connecté, la panne d'une lecture reste dite, même avec un sommaire servi.
        #expect(IOSMemoryModel.screen(connection: .connected, load: .failed(.macUnreachable), mode: .summary, summary: page)
            == .failed(.macUnreachable))
    }

    // MARK: - AC-6

    @Test("ios-memoire/AC-6 : la mémoire injoignable est « service indisponible », sans l'adresse ni le détail amont")
    func memoryUnavailableIsTranslated() {
        // Le détail relayé par le Mac (adresse sondée, dernier message) ne s'affiche plus :
        // le traducteur partagé n'en garde que la cause.
        let detail = MemoryText.unavailableDetail(address: "127.0.0.1:8321", error: "connexion refusée")
        #expect(IOSMemoryModel.load(from: ClientError.api(.unavailable(detail))) == .failed(.serviceUnavailable))
        #expect(Self.connectedScreen(.failed(.serviceUnavailable), .summary)
            == .failed(.serviceUnavailable))
        #expect(Self.connectedScreen(.failed(.serviceUnavailable), .search("x"))
            == .failed(.serviceUnavailable))
        let text = IOSMacErrorText.message(for: .serviceUnavailable)
        #expect(!text.contains("127.0.0.1"))
        #expect(!text.contains(detail))
    }

    // MARK: - AC-5

    @Test("ios-memoire/AC-5 : les trois « rien trouvé » sont distincts, jamais le sommaire")
    func searchEmptiesAreThreeDistinctWords() {
        let mode = IOSMemoryMode.search("terme")
        func screen(candidates: Int, scored: Int, rows: [RemoteMemoryRow]) -> IOSMemoryScreenState {
            Self.connectedScreen(
                .search(RemoteMemorySearchPayload(rows: rows, candidates: candidates, scored: scored)),
                mode
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
        let page = RemoteMemoryPagePayload(scope: "projet", total: 1, offset: 0, rows: rows, nextOffset: nil)
        let reader = CountingMemoryReader(page: .success(page))
        let model = IOSMemoryModel(client: reader)

        await model.refresh()
        #expect(reader.pageReads == 1)
        #expect(model.state(connection: .connected) == .summary(scope: "projet", total: 1, rows: rows, more: .complete))

        model.updateQuery("mémoire du projet")
        await model.submitQuery()
        #expect(reader.searchReads == 1)
        #expect(model.isSearching)

        // (1) Vider le champ (blancs) revient au sommaire DÉJÀ lu.
        model.updateQuery("   ")
        #expect(!model.isSearching)
        #expect(model.summary == IOSMemorySummary(firstPage: page))
        #expect(model.state(connection: .connected) == .summary(scope: "projet", total: 1, rows: rows, more: .complete))
        // AUCUNE lecture ajoutée, ni sommaire ni recherche.
        #expect(reader.pageReads == 1)
        #expect(reader.searchReads == 1)

        // (2) Le bouton « Sommaire » fait de même, sans requête.
        model.updateQuery("autre")
        await model.submitQuery()
        #expect(reader.searchReads == 2)
        model.showSummary()
        #expect(!model.isSearching)
        #expect(model.state(connection: .connected) == .summary(scope: "projet", total: 1, rows: rows, more: .complete))
        #expect(reader.pageReads == 1)
        #expect(reader.searchReads == 2)

        // (3) Une requête blanche validée n'émet RIEN et laisse le sommaire.
        model.updateQuery("  ")
        await model.submitQuery()
        #expect(reader.searchReads == 2)
        #expect(!model.isSearching)
    }

    @Test("ios-finitions-titres-icones/AC-6 : « Sommaire » est disponible après une recherche terminée, et dit pourquoi sinon")
    func summaryIsAvailableAfterACompletedSearch() async {
        let page = RemoteMemoryPagePayload(scope: "projet", total: 1, offset: 0, rows: [row("m1", text: "un")], nextOffset: nil)
        let model = IOSMemoryModel(client: CountingMemoryReader(page: .success(page)))

        await model.refresh()
        #expect(model.summaryUnavailableReason(graphShown: false) == IOSMemoryText.summaryReasonShown)
        #expect(!model.canShowSummary)

        model.updateQuery("mémoire du projet")
        await model.submitQuery()
        #expect(model.summaryUnavailableReason(graphShown: false) == nil)
        #expect(model.canShowSummary)
        #expect(model.summaryUnavailableReason(graphShown: true) == IOSMemoryText.summaryReasonGraph)
    }

    // MARK: - AC-9

    @Test("ios-memoire/AC-9 : un geste émet UNE lecture, et une panne après un succès bascule l'état")
    func gestureRefreshReloadsOnceAndFollowsTheFailure() async {
        let rows = [row("m1", text: "un")]
        let page = RemoteMemoryPagePayload(scope: "projet", total: 1, offset: 0, rows: rows, nextOffset: nil)
        let reader = CountingMemoryReader(page: .success(page))
        let model = IOSMemoryModel(client: reader)

        await model.refresh()
        #expect(reader.pageReads == 1)
        #expect(model.state(connection: .connected) == .summary(scope: "projet", total: 1, rows: rows, more: .complete))

        // La pile mémoire tombe ensuite : le geste relaie la panne avec sa cause.
        let detail = MemoryText.unavailableDetail(address: "127.0.0.1:8321", error: "connexion refusée")
        reader.page = .failure(ClientError.api(.unavailable(detail)))
        await model.refresh()
        #expect(reader.pageReads == 2)
        #expect(model.state(connection: .connected) == .failed(.serviceUnavailable))
        #expect(!model.isLoading)

        // La mémoire revient : le MÊME geste repasse au sommaire.
        reader.page = .success(page)
        await model.refresh()
        #expect(reader.pageReads == 3)
        #expect(model.state(connection: .connected) == .summary(scope: "projet", total: 1, rows: rows, more: .complete))

        // Un client qui ne joint plus le Mac n'émet AUCUNE lecture.
        reader.state = .unpaired
        await model.refresh()
        #expect(reader.pageReads == 3)
    }

    // MARK: - ios-erreurs-serveur-lisibles (S-3)

    @Test("ios-erreurs-serveur-lisibles/AC-8 : memoryShowsTranslatedFailure — la liste affiche le message du traducteur partagé")
    func memoryShowsTranslatedFailure() async {
        let reader = CountingMemoryReader(page: .failure(MacMemoryDouble.relayed503))
        let model = IOSMemoryModel(client: reader)
        await model.refresh()
        #expect(model.state(connection: .connected) == .failed(.serviceUnavailable))
        let text = IOSMacErrorText.message(for: .serviceUnavailable)
        #expect(text.contains("Service indisponible sur le Mac"))
        #expect(MacMemoryDouble.isReadable(text))
        #expect(!model.isLoading)

        // Un échec de transport : « Mac injoignable », sans « Mémoire indisponible » ni adresse.
        reader.page = .failure(ClientError.transport(.unreachable("Could not connect to the server. (127.0.0.1:8787)")))
        await model.refresh()
        #expect(model.state(connection: .connected) == .failed(.macUnreachable))
        let unreachable = IOSMacErrorText.message(for: .macUnreachable)
        #expect(unreachable.contains("Mac injoignable"))
        #expect(!unreachable.contains(MemoryText.unavailableTitle))
        #expect(MacMemoryDouble.isReadable(unreachable))

        // 500 et corps illisible : le message générique, sans code.
        reader.page = .failure(MacMemoryDouble.error(status: 500, body: Data("oops".utf8)))
        await model.refresh()
        #expect(model.state(connection: .connected) == .failed(.generic))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-10 : memoryNeverClaimsOutdated — la liste et la recherche en 503 ne disent jamais « trop ancien »")
    func memoryNeverClaimsOutdated() async {
        for upstream in ["réponse 404 du service", "réponse 405 du service"] {
            let failure = MacMemoryDouble.error(
                status: 503,
                code: "unavailable",
                message: MemoryText.unavailableDetail(address: "localhost:8321", error: upstream)
            )
            let reader = CountingMemoryReader(page: .failure(failure), search: .failure(failure))
            let model = IOSMemoryModel(client: reader)

            await model.refresh()
            #expect(model.state(connection: .connected) == .failed(.serviceUnavailable))

            model.updateQuery("mémoire")
            await model.submitQuery()
            #expect(reader.searchReads == 1)
            #expect(model.state(connection: .connected) == .failed(.serviceUnavailable))
            #expect(model.state(connection: .connected) != .failed(.serviceOutdated))
        }
        let text = IOSMacErrorText.message(for: .serviceUnavailable)
        #expect(text.contains("Service indisponible sur le Mac"))
        #expect(!text.contains("trop ancien"))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-7 : memoryRetryShowsData — Réessayer relance la lecture et les lignes s'affichent")
    func memoryRetryShowsData() async {
        let rows = [row("m1", text: "un")]
        let page = RemoteMemoryPagePayload(scope: "projet", total: 1, offset: 0, rows: rows, nextOffset: nil)
        let reader = CountingMemoryReader(page: .failure(MacMemoryDouble.relayed503))
        let model = IOSMemoryModel(client: reader)
        await model.refresh()
        #expect(model.state(connection: .connected) == .failed(.serviceUnavailable))

        reader.page = .success(page)
        await model.refresh()
        #expect(reader.pageReads == 2)
        #expect(model.state(connection: .connected) == .summary(scope: "projet", total: 1, rows: rows, more: .complete))

        // Réessayer relance aussi la RECHERCHE quand le mode courant en est une.
        let hit = RemoteMemorySearchPayload(rows: rows, candidates: 1, scored: 1)
        reader.search = .failure(MacMemoryDouble.relayed503)
        model.updateQuery("un")
        await model.submitQuery()
        #expect(model.state(connection: .connected) == .failed(.serviceUnavailable))
        reader.search = .success(hit)
        await model.refresh()
        #expect(reader.searchReads == 2)
        #expect(model.state(connection: .connected) == .search(query: "un", rows: rows))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-5 : memoryUnauthorizedFallsBackToClientState — un 401 ne montre aucun message de section")
    func memoryUnauthorizedFallsBackToClientState() async {
        #expect(IOSMemoryModel.load(from: ClientError.api(.unauthorized)) == .idle)
        #expect(IOSMemoryModel.screen(connection: .disconnected(.refused), load: .idle, mode: .summary, summary: nil)
            == .offline(.disconnected(.refused)))

        let reader = CountingMemoryReader(page: .failure(ClientError.api(.unauthorized)))
        let model = IOSMemoryModel(client: reader)
        reader.state = .revoked
        await model.refresh()
        #expect(reader.pageReads == 0)
        #expect(model.state(connection: .disconnected(.refused)) == .offline(.disconnected(.refused)))

        // Le 401 lu pendant la connexion : le client bascule en `.revoked`, la section suit.
        reader.state = .connected(endpoint: endpoint)
        let revoking = RevokingReader(reader)
        let revokingModel = IOSMemoryModel(client: revoking)
        await revokingModel.refresh()
        #expect(revokingModel.load == .idle)
        #expect(revokingModel.state(connection: .disconnected(.refused)) == .offline(.disconnected(.refused)))
    }
}

/// Le lecteur dont la lecture reçoit un 401 : comme `ConsoleClientModel.absorb`, il passe le
/// client en `.revoked` avant de lever l'erreur.
@MainActor
private final class RevokingReader: IOSMemoryReading {
    var state: ClientState
    private let inner: CountingMemoryReader

    init(_ inner: CountingMemoryReader) {
        self.inner = inner
        self.state = inner.state
    }

    func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        state = .revoked
        throw ClientError.api(.unauthorized)
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        state = .revoked
        throw ClientError.api(.unauthorized)
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        state = .revoked
        throw ClientError.api(.unauthorized)
    }
}

/// La doublure du Mac : ce que le client lève pour une réponse d'erreur.
private enum MacMemoryDouble {
    static func error(status: Int, body: Data) -> ClientError {
        ClientErrorMapping.translate(status: status, protocolVersion: 1, body: body)
    }

    static func error(status: Int, code: String, message: String) -> ClientError {
        let body = (try? JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message]])) ?? Data()
        return error(status: status, body: body)
    }

    /// Le 503 que rend le Mac quand mem0-http est injoignable : l'adresse et le JSON amont
    /// sont dans le message.
    static var relayed503: ClientError {
        error(
            status: 503,
            code: "unavailable",
            message: MemoryText.unavailableDetail(
                address: "localhost:8321",
                error: "réponse 405 du service ({\"detail\":\"Method Not Allowed\"})"
            )
        )
    }

    /// Ni adresse, ni JSON, ni code HTTP à trois chiffres.
    static func isReadable(_ text: String) -> Bool {
        let forbidden = ["localhost", "://", "{", "\"detail\""]
        guard !forbidden.contains(where: text.contains) else { return false }
        return text.range(of: #"\b\d{3}\b"#, options: .regularExpression) == nil
    }
}
