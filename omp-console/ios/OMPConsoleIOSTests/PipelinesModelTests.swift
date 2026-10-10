import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS
@testable import ConsoleCore

/// Les preuves Swift de la dérivation de l'écran Pipelines (S-3, S-4, BR-4) : la
/// priorité des états, et les identifiants d'accessibilité uniques.
@MainActor
@Suite("ios-pipelines — l'état de l'écran")
struct PipelinesModelTests {
    private let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: 8787)

    @Test("etats-non-connecte-heterogenes-ios/AC-1 : pas connectée et jamais reçue → le composant d'état de connexion")
    func unavailableWithoutSnapshot() {
        for status in [IOSConnectionStatus.connecting, .disconnected(.unreachable), .disconnected(.unpaired), .disconnected(.refused)] {
            #expect(PipelinesModel.screen(connection: status, board: nil) == .unavailable(status))
        }
    }

    @Test("ios-pipelines/AC-2 : connectée sans instantané → chargement")
    func connectedWithoutSnapshotLoads() {
        #expect(PipelinesModel.screen(connection: .connected, board: nil) == .loading)
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-4 : l'ardoise reçue reste affichée hors connexion")
    func snapshotKeptOffline() {
        let board = KanbanBoard(cards: [], anomalies: [])
        for status in [IOSConnectionStatus.connecting, .disconnected(.unreachable), .disconnected(.refused)] {
            #expect(PipelinesModel.screen(connection: status, board: .board(board)) == .board(.board(board)))
            // Un magasin reçu VIDE est « chargé » : il reste sous le bandeau.
            #expect(PipelinesModel.screen(connection: status, board: .storeEmpty(dir: "")) == .board(.storeEmpty(dir: "")))
        }
        #expect(PipelinesModel.screen(connection: .connected, board: .storeEmpty(dir: "")) == .board(.storeEmpty(dir: "")))
    }

    @Test("ios-pipelines/AC-1 : les identifiants de cartes et de voies sont distincts")
    func accessibilityIdentifiers() {
        #expect(PipelinesAccessibility.card("a") != PipelinesAccessibility.card("b"))
        #expect(PipelinesAccessibility.lane("a") != PipelinesAccessibility.lane("b"))
        #expect(PipelinesAccessibility.screen.hasPrefix("pipelines."))
        #expect(PipelinesSheet.card("x").id != PipelinesSheet.newFeature.id)
    }

    @Test("ios-pipelines/AC-5 : les valeurs de contrat des gestes sont celles du protocole")
    func protocolValues() {
        #expect(PipelinesAnswerKind.selected.rawValue == "selected")
        #expect(PipelinesAnswerKind.custom.rawValue == "custom")
        #expect(PipelinesVerdict.specs.rawValue == "specs")
        #expect(PipelinesVerdict.review.rawValue == "review")
    }

    // MARK: - Livrées : clôtures rattachées, faits de PR, bouton Rafraîchir

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-6 : sur iOS, les 10 clôtures d'une feature de lot ne font aucune carte à part")
    func historyClosuresJoinTheirFeatureOnIOS() throws {
        let slug = "ios-erreurs-serveur-lisibles"
        let worktree = "/tmp/omp-livrees/mem0-omp-d0ef9a5/\(slug)"
        let url = "github.com/o/r/pull/104"
        let history = (0..<10).map { index in
            Self.historyEntry(index: index, cwd: worktree, label: "mem0-omp/\(slug)", endedAt: Self.nowMs - Double(19 - index) * 3_600_000)
        }
        let board = try Self.board(
            history: history,
            features: [Self.doneFeature(slug, worktree: worktree, prUrl: url, endedAt: Self.nowMs - Self.dayMs)],
            prFacts: PullRequestFacts.index([PullRequestFact(url: url, state: .open, closedAtMs: nil)])
        )
        let carrying = board.cards.filter { KanbanCardPresentation.title($0) == slug }
        #expect(carrying.count == 1, "une seule carte porte la feature")
        #expect(!board.cards.contains { $0.id.hasPrefix("history:") }, "aucune carte « — terminée » à côté")
        #expect(carrying.first?.sources.filter { $0.kind == .history }.count == 10)
        #expect(carrying.first.map { ConsoleStatus.of(card: $0).text } == "PR ouverte")
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-7 : sur iOS, une feature réduite à ses clôtures fait UNE carte « Terminée », la plus récente")
    func orphanClosuresMakeOneCardOnIOS() throws {
        let cwd = "/tmp/omp-livrees/orpheline"
        let endings = [Self.nowMs - 3 * Self.dayMs, Self.nowMs - Self.dayMs, Self.nowMs - 2 * Self.dayMs]
        let history = endings.enumerated().map { index, endedAt in
            Self.historyEntry(index: index, cwd: cwd, label: "mem0-omp/orpheline", endedAt: endedAt)
        }
        let board = try Self.board(history: history, features: [], prFacts: [:])
        #expect(board.cards.count == 1)
        let card = try #require(board.cards.first)
        #expect(card.id == "history:\(Self.historyId(1))")
        #expect(ConsoleStatus.of(card: card).text == "Terminée")
        #expect(card.endMs == Self.nowMs - Self.dayMs)
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-4 : sans fait servi par le Mac, la carte iOS porte « PR créée »")
    func unknownPullRequestReadsCreatedOnIOS() throws {
        let board = try Self.board(
            history: [],
            features: [Self.doneFeature("livree", worktree: "", prUrl: "github.com/o/r/pull/7", endedAt: Self.nowMs - 30 * Self.dayMs)],
            prFacts: [:]
        )
        #expect(board.cards.map { ConsoleStatus.of(card: $0).text } == ["PR créée"])
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-5 : « Rafraîchir » n'est actif que connecté et hors relecture")
    func refreshAvailability() {
        let connected = ClientState.connected(endpoint: endpoint)
        #expect(PipelinesModel.canRefresh(connection: connected, refreshing: false))
        #expect(!PipelinesModel.canRefresh(connection: connected, refreshing: true))
        for state in [ClientState.noNetwork, .unpaired, .searching, .connecting(endpoint: endpoint), .macAbsent(endpoint: endpoint), .revoked] {
            #expect(!PipelinesModel.canRefresh(connection: state, refreshing: false))
            #expect(!PipelinesModel.canRefresh(connection: state, refreshing: true))
        }
        #expect(PipelinesAccessibility.refresh.hasPrefix("pipelines."))
        #expect(PipelinesAccessibility.refresh != PipelinesAccessibility.newFeature)
    }

    // MARK: - Fixture : un instantané minimal reçu comme une trame `store`

    private static let nowMs: Double = 1_700_000_000_000
    private static let dayMs: Double = 86_400_000

    private struct StoreFrameUnreadable: Error {}

    private static func historyId(_ index: Int) -> String { String(format: "eeeeeeeeeeeee%03x", index) }

    private static func historyEntry(index: Int, cwd: String, label: String, endedAt: Double) -> [String: Any] {
        [
            "id": historyId(index), "cwd": cwd, "label": label, "phase": "review",
            "finalState": "done", "phaseStartedAt": endedAt - 60_000, "endedAt": endedAt,
        ]
    }

    private static func doneFeature(_ slug: String, worktree: String, prUrl: String, endedAt: Double) -> [String: Any] {
        [
            "slug": slug, "name": slug, "branch": "feat/\(slug)", "worktree": worktree, "deps": [String](),
            "origin": "session", "state": "done", "phase": "release", "waitKind": NSNull(), "prUrl": prUrl,
            "pendingTexts": [String](), "fixes": 0, "reviewRuns": 0, "unreadableRuns": 0, "lastBlockers": 0,
            "addedAt": endedAt - dayMs, "sinceAt": endedAt - dayMs, "updatedAt": endedAt, "endedAt": endedAt,
        ]
    }

    /// L'ardoise iOS d'un instantané minimal : l'instantané arrive comme une
    /// trame `store` lue par le parseur du client, puis passe par la dérivation
    /// de `PipelinesModel.boardState(of:nowMs:)` — vivacité transportée, faits
    /// de PR servis par le Mac.
    private static func board(
        history: [[String: Any]],
        features: [[String: Any]],
        prFacts: [String: PullRequestFact]
    ) throws -> KanbanBoard {
        let lots: [[String: Any]] = features.isEmpty ? [] : [[
            "id": "fffffffffffff001", "repoRoot": "/tmp/omp-livrees/mem0-omp", "status": "running",
            "reviewCap": 1, "slotCap": 4, "recapAt": NSNull(), "owner": ["pid": 1],
            "createdAt": nowMs - 40 * dayMs, "launchedAt": nowMs - 40 * dayMs,
            "features": features, "isStale": false,
        ]]
        func section(_ key: String, _ items: [[String: Any]]) -> [String: Any] {
            ["availability": "present", "discardedEntries": [String](), key: items]
        }
        let object: [String: Any] = [
            "root": "present",
            "running": section("entries", []),
            "history": section("entries", history),
            "lots": section("lots", lots),
            "projects": section("projects", []),
            "inbox": section("boxes", []),
            "audit": section("relays", []),
        ]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
        var parser = ClientStreamParser()
        guard case .store(let snapshot)? = parser.consume(Data("event: store\ndata: \(json)\n\n".utf8)).first else {
            throw StoreFrameUnreadable()
        }
        let state = KanbanBoardState.derive(
            snapshot: snapshot,
            nowMs: nowMs,
            stateDir: "",
            isAlive: .transported(snapshot),
            prFacts: prFacts
        )
        guard let board = state.kanbanBoard else { throw StoreFrameUnreadable() }
        return board
    }

    // MARK: - Erreurs du Mac (ios-erreurs-serveur-lisibles)

    /// Le prédicat « lisible » : ni adresse, ni JSON, ni code HTTP à trois chiffres.
    private func isReadable(_ text: String) -> Bool {
        let forbidden = ["localhost", "://", "{", "\"detail\""]
        guard !forbidden.contains(where: text.contains) else { return false }
        return text.range(of: #"\b\d{3}\b"#, options: .regularExpression) == nil
    }

    /// La réponse du Mac passe par la vraie traduction du client.
    private func macError(status: Int, code: String, message: String) -> ClientError {
        let body = (try? JSONSerialization.data(
            withJSONObject: ["error": ["code": code, "message": message]]
        )) ?? Data()
        return ClientErrorMapping.translate(status: status, protocolVersion: 1, body: body)
    }

    /// Le 503 que rend le Mac quand mem0-http répond 405 : l'adresse et le JSON amont sont
    /// dans le message.
    private func relayed503() -> ClientError {
        let detail = MemoryText.unavailableDetail(
            address: "localhost:8321",
            error: "réponse 405 du service ({\"detail\":\"Method Not Allowed\"})"
        )
        return macError(status: 503, code: "unavailable", message: detail)
    }

    @Test("ios-erreurs-serveur-lisibles/AC-8 : catalogShowsTranslatedFailure — le 503 relayé s'affiche en « service indisponible », sans URL ni JSON")
    func catalogShowsTranslatedFailure() async {
        let error = relayed503()
        let state = await PipelinesModel.catalog { throw error }
        let expected = IOSMacErrorText.message(for: .serviceUnavailable)
        #expect(state == .failed(expected))
        #expect(isReadable(expected))
        #expect(expected.contains("Service indisponible sur le Mac"))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-7 : catalogRetryLoadsModels — après un échec, la même fonction rend les modèles ; une raison du Mac garde la composition du noyau")
    func catalogRetryLoadsModels() async {
        var succeed = false
        let error = relayed503()
        let load: @MainActor () async throws -> RemoteModelsPayload = {
            if !succeed { throw error }
            return RemoteModelsPayload(selectors: ["a/b"], failure: nil)
        }
        #expect(await PipelinesModel.catalog(load) == .failed(IOSMacErrorText.message(for: .serviceUnavailable)))
        // Réessayer relance le même chargement : le Mac répond désormais 200.
        succeed = true
        #expect(await PipelinesModel.catalog(load) == .loaded(["a/b"]))
        let failed = await PipelinesModel.catalog { RemoteModelsPayload(selectors: [], failure: "pas de modèle") }
        #expect(failed == .failed(KanbanText.modelCatalogUnavailable("pas de modèle")))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-5 : catalogUnauthorizedShowsConnectionState — le 401 n'affiche aucun message traduit, mais l'état de connexion")
    func catalogUnauthorizedShowsConnectionState() async {
        let state = await PipelinesModel.catalog { throw ClientError.api(.unauthorized) }
        #expect(state == .failed(ConnectionText.revoked))
    }

    @Test("ios-erreurs-serveur-lisibles/D-3 : catalogBusinessRefusalKeepsMotive — un refus métier garde le motif rédigé par le Mac")
    func catalogBusinessRefusalKeepsMotive() async {
        let state = await PipelinesModel.catalog { throw ClientError.api(.notFound("carte inconnue")) }
        #expect(state == .failed(IOSMacErrorText.message(for: .rejected("carte inconnue"))))
        #expect(IOSMacErrorText.message(for: .rejected("carte inconnue")).contains("carte inconnue"))
        // « route inconnue » seule signifie « app Mac trop ancienne ».
        let outdated = await PipelinesModel.catalog { throw ClientError.api(.notFound(IOSMacFailure.unknownRoute)) }
        #expect(outdated == .failed(IOSMacErrorText.message(for: .macOutdated)))
    }
}
