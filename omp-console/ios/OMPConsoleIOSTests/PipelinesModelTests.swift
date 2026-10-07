import ConsoleClient
import ConsoleCore
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
}
