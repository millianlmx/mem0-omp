import ConsoleClient
import ConsoleCore
import Testing

@testable import OMPConsoleIOS
@testable import ConsoleCore

/// Les preuves Swift des voies de l'écran Pipelines sur iPhone : repli des voies
/// terminales, voies vides masquées, iPad inchangé.
@MainActor
@Suite("ios-pipelines-lanes-interminables — les voies sur iPhone")
struct PipelinesLanesTests {
    private func card(_ id: String, _ column: KanbanColumn) -> KanbanCard {
        KanbanCard(
            id: id, column: column, repo: "depot", title: id, state: "x",
            phase: .impl, models: nil, prUrl: nil, startMs: 0, endMs: nil,
            marks: [], sources: []
        )
    }

    private func cards(_ prefix: String, _ column: KanbanColumn, _ count: Int) -> [KanbanCard] {
        (0..<count).map { card("\(prefix)\($0)", column) }
    }

    /// L'ardoise de l'audit : 68 livrées et 47 arrêtées, plus `extra`.
    private func auditBoard(extra: [KanbanCard] = []) -> KanbanBoard {
        KanbanBoard(
            cards: extra + cards("l", .fusionne, 68) + cards("a", .echec, 47),
            anomalies: []
        )
    }

    private func row(_ rows: [KanbanLaneRow], _ lane: KanbanLane) -> KanbanLaneRow? {
        rows.first { $0.lane == lane }
    }

    @Test("ios-pipelines-lanes-interminables/AC-1 : sur iPhone, Livrées et Arrêtées sont repliées et gardent leur compte")
    func compactFoldsTerminalLanes() throws {
        let rows = KanbanLaneRows.rows(auditBoard().lanes, layout: .condensed, unfolded: [])
        let livrees = try #require(row(rows, .livrees))
        let arretees = try #require(row(rows, .arretees))
        for terminal in [livrees, arretees] {
            #expect(terminal.foldable)
            #expect(terminal.folded)
            #expect(terminal.visibleCards.isEmpty)
        }
        #expect(livrees.content.cards.count == 68)
        #expect(arretees.content.cards.count == 47)
    }

    @Test("ios-pipelines-lanes-interminables/AC-2 : l'en-tête ne déplie que sa voie, et replier la remet en état")
    func headerTogglesOnlyItsLane() throws {
        let lanes = auditBoard().lanes
        let open = KanbanLaneRows.rows(lanes, layout: .condensed, unfolded: [.livrees])
        let livrees = try #require(row(open, .livrees))
        let arretees = try #require(row(open, .arretees))
        #expect(!livrees.folded)
        #expect(livrees.visibleCards.count == 68)
        #expect(arretees.folded)
        #expect(arretees.visibleCards.isEmpty)

        let closed = KanbanLaneRows.rows(lanes, layout: .condensed, unfolded: [])
        #expect(try #require(row(closed, .livrees)).folded)
    }

    @Test("ios-pipelines-lanes-interminables/AC-4 : sur iPhone, les voies non terminales restent dépliées")
    func compactKeepsActiveLanesOpen() throws {
        let extra = [card("p", .enAttente), card("c", .enCours), card("q", .questionEnVol)]
        let lanes = auditBoard(extra: extra).lanes
        for unfolded: Set<KanbanLane> in [[], [.livrees, .arretees]] {
            let rows = KanbanLaneRows.rows(lanes, layout: .condensed, unfolded: unfolded)
            for lane in [KanbanLane.pasCommencees, .enCours, .aVous] {
                let active = try #require(row(rows, lane))
                #expect(!active.foldable)
                #expect(!active.folded)
                #expect(active.visibleCards == active.content.cards)
                #expect(active.visibleCards.count == 1)
            }
        }
    }

    @Test("ios-pipelines-lanes-interminables/AC-6 : sur iPhone, « Pas commencées » n'apparaît que si elle a une carte")
    func compactHidesEmptyNotStartedLane() throws {
        let without = KanbanLaneRows.rows(auditBoard().lanes, layout: .condensed, unfolded: [])
        #expect(row(without, .pasCommencees) == nil)

        let pending = card("p", .enAttente)
        let with = KanbanLaneRows.rows(auditBoard(extra: [pending]).lanes, layout: .condensed, unfolded: [])
        #expect(try #require(row(with, .pasCommencees)).visibleCards == [pending])
    }

    @Test("ios-pipelines-lanes-interminables/AC-7 : sur iPhone, aucune voie vide n'apparaît, ni repliée ni dépliée")
    func compactHidesEveryEmptyLane() {
        let columnOf: [KanbanLane: KanbanColumn] = [
            .pasCommencees: .enAttente, .enCours: .enCours, .aVous: .questionEnVol,
            .livrees: .fusionne, .arretees: .echec,
        ]
        for empty in KanbanLane.allCases {
            let others = KanbanLane.allCases.filter { $0 != empty }.compactMap { columnOf[$0] }
            let board = KanbanBoard(cards: others.enumerated().map { card("c\($0.offset)", $0.element) }, anomalies: [])
            for unfolded: Set<KanbanLane> in [[], Set(KanbanLane.allCases)] {
                let rows = KanbanLaneRows.rows(board.lanes, layout: .condensed, unfolded: unfolded)
                #expect(rows.allSatisfy { $0.lane != empty })
                #expect(rows.count == KanbanLane.allCases.count - 1)
            }
        }
    }

    @Test("ios-pipelines-lanes-interminables/AC-8 : sur iPhone, une ardoise sans carte ne rend aucune voie")
    func compactWithoutCardsHasNoLane() {
        let lanes = KanbanBoard(cards: [], anomalies: []).lanes
        #expect(KanbanLaneRows.rows(lanes, layout: .condensed, unfolded: []).isEmpty)
        #expect(KanbanLaneRows.rows(lanes, layout: .condensed, unfolded: [.livrees]).isEmpty)
    }

    @Test("ios-pipelines-lanes-interminables/AC-9 : sur iPad, les voies sont rendues comme avant")
    func regularKeepsLanesUnchanged() {
        let board = auditBoard()
        #expect(board.lanes.contains { $0.lane == .pasCommencees && $0.cards.isEmpty })
        for unfolded: Set<KanbanLane> in [[], [.livrees]] {
            let rows = KanbanLaneRows.rows(board.lanes, layout: .full, unfolded: unfolded)
            #expect(rows.map(\.content) == board.lanes)
            #expect(rows.allSatisfy { !$0.foldable && !$0.folded && $0.visibleCards == $0.content.cards })
        }
    }

    @Test("ios-pipelines-lanes-interminables/AC-5 : les en-têtes des voies terminales ont des identifiants et des états distincts")
    func laneHeaderIdentifiersAreDistinct() {
        let livrees = PipelinesAccessibility.laneHeader(KanbanLane.livrees.rawValue)
        let arretees = PipelinesAccessibility.laneHeader(KanbanLane.arretees.rawValue)
        #expect(livrees != arretees)
        #expect(livrees != PipelinesAccessibility.lane(KanbanLane.livrees.rawValue))
        #expect(arretees != PipelinesAccessibility.lane(KanbanLane.arretees.rawValue))
        #expect(KanbanText.laneFolded != KanbanText.laneUnfolded)
    }
}
