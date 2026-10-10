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
}
