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

    @Test("ios-pipelines/AC-3 : pas connectée et jamais reçue → état déconnecté explicite")
    func disconnectedWithoutSnapshot() {
        #expect(PipelinesModel.screen(connection: .unpaired, board: nil) == .noSnapshot)
        #expect(PipelinesModel.screen(connection: .macAbsent(endpoint: endpoint), board: nil) == .noSnapshot)
        #expect(PipelinesModel.screen(connection: .revoked, board: nil) == .noSnapshot)
    }

    @Test("ios-pipelines/AC-2 : connectée sans instantané → chargement")
    func connectedWithoutSnapshotLoads() {
        #expect(PipelinesModel.screen(connection: .connected(endpoint: endpoint), board: nil) == .loading)
    }

    @Test("ios-pipelines/AC-3 : un instantané connu prime — l'ardoise reste affichée connexion perdue")
    func snapshotWinsOverConnection() {
        let board = KanbanBoard(cards: [], anomalies: [])
        #expect(PipelinesModel.screen(connection: .macAbsent(endpoint: endpoint), board: .board(board)) == .board(.board(board)))
        #expect(PipelinesModel.screen(connection: .connected(endpoint: endpoint), board: .storeEmpty(dir: "")) == .board(.storeEmpty(dir: "")))
    }

    @Test("ios-pipelines/AC-3 : seul un état NON connecté porte un bandeau")
    func onlyDisconnectedHasBanner() {
        #expect(PipelinesModel.connectionBanner(connection: .connected(endpoint: endpoint)) == nil)
        #expect(PipelinesModel.connectionBanner(connection: .macAbsent(endpoint: endpoint))?.tone == .attention)
    }

    @Test("ios-pipelines/AC-3 : le mot de l'état vide déconnecté n'est pas celui du magasin vide")
    func noSnapshotWordIsNotTheStoreWord() {
        #expect(PipelinesText.noSnapshot != KanbanText.noPipeline)
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
}
